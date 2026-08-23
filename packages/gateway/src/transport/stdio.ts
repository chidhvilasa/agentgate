import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sanitizeErrorMessage } from '@agentgate/policy';
import { buildAgentIdentity } from '../agent-identity.js';
import { runPipeline } from '../pipeline.js';
import type { PipelineContext } from '../pipeline.js';

/**
 * Starts the AgentGate stdio proxy.
 *
 * Claude Code communicates with AgentGate over stdio.
 * AgentGate intercepts tool calls, evaluates policy, and forwards to
 * downstream servers when permitted.
 *
 * Protocol: Legacy 2025-era is supported via the official SDK.
 * Modern stateless protocol support is deferred to a future milestone.
 */
export async function startStdioProxy(ctx: PipelineContext): Promise<void> {
  // We proxy to a downstream server — discover its tools first.
  // For Milestone 1: discover tools from the first configured server.
  const firstServer = ctx.config.servers[0];
  if (!firstServer || firstServer.transport !== 'stdio') {
    throw new Error('At least one stdio downstream server must be configured for Milestone 1.');
  }

  // ── Discover tools from downstream ────────────────────────────────────────
  let downstreamTools: Array<{ name: string; description?: string; inputSchema: unknown }> = [];
  try {
    const discoveryClient = new Client({ name: 'agentgate-discovery', version: '0.1.0' });
    const discoveryTransport = new StdioClientTransport({
      command: firstServer.command,
      args: firstServer.args ?? [],
      env: { ...process.env, ...firstServer.env } as Record<string, string>,
    });
    await discoveryClient.connect(discoveryTransport);
    const { tools } = await discoveryClient.listTools();
    downstreamTools = tools;
    await discoveryClient.close();
  } catch (err) {
    // ADR-0009: never log a raw downstream-adjacent error before sanitization.
    const sanitized = sanitizeErrorMessage(err, { source: 'downstream' });
    console.error('[agentgate] Warning: could not discover downstream tools:', sanitized.message);
  }

  // ── Build the proxy MCP server ─────────────────────────────────────────────
  const server = new Server(
    { name: 'agentgate', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // Expose the same tools upstream as the downstream server advertises
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: downstreamTools,
  }));

  // Intercept tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
    const toolName = request.params.name;
    const rawArgs = (request.params.arguments ?? {});

    // Determine MCP era from protocol version negotiated
    const mcpEra = 'legacy-2025' as const;

    // Build agent identity from declared metadata (untrusted)
    const agent = buildAgentIdentity({
      declared_name: null, // Will be populated from initialize in future
      declared_version: null,
      connection_identity: `pid:${process.ppid}`,
    });

    ctx.storage.upsertAgent({
      session_id: agent.session_id,
      identity_json: JSON.stringify(agent),
      connected_at: new Date().toISOString(),
    });

    const { event, result } = await runPipeline({
      ctx,
      agent,
      toolName,
      rawArgs,
      mcpEra,
      jsonrpcId: null,
    });

    if (event.status === 'DENIED' || event.status === 'EXPIRED' || event.status === 'CANCELLED' || event.status === 'FAILED') {
      // FAILED means policy allowed the call but downstream execution itself
      // threw — surface the (already-sanitized, per ADR-0009) execution
      // error rather than the stale ALLOW decision's explanation, which is
      // misleading for an execution failure. Every other terminal status
      // here is a genuine policy outcome, so decision.explanation applies.
      const reason =
        event.status === 'FAILED' && event.execution_error
          ? event.execution_error
          : (event.decision?.explanation ?? 'Request was blocked by AgentGate policy.');
      return {
        content: [{ type: 'text', text: `[AgentGate] ${reason}` }],
        isError: true,
      };
    }

    // Return the downstream result
    if (result && typeof result === 'object' && 'content' in (result)) {
      return result;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });

  // ── Start accepting stdio from Claude Code ────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agentgate] Stdio proxy started. Waiting for MCP client...');
}
