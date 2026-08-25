import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildAgentIdentity } from '../agent-identity.js';
import { runPipeline } from '../pipeline.js';
import type { PipelineContext } from '../pipeline.js';
import { computeServerIdentity } from '../tool-integrity/identity.js';
import { scanDownstreamServer } from '../tool-integrity/scan.js';
import { applyScanToRegistry } from '../tool-integrity/registry.js';
import { filterTrustedTools, checkCallAllowed } from '../tool-integrity/enforcement.js';

/**
 * Starts the AgentGate stdio proxy.
 *
 * Claude Code communicates with AgentGate over stdio.
 * AgentGate intercepts tool calls, evaluates policy, and forwards to
 * downstream servers when permitted.
 *
 * Protocol: Legacy 2025-era is supported via the official SDK.
 * Modern stateless protocol support is deferred to a future milestone.
 *
 * Milestone 6 (ADR-0012): tool discovery now also feeds the Tool
 * Integrity Registry. There is no `notifications/tools/list_changed`
 * handling in this milestone (AgentGate's SDK/protocol boundary does not
 * depend on it) — instead, a scan runs unconditionally at every gateway
 * startup, which is a safe, mandatory lifecycle point independent of
 * whether any notification is ever sent. See `agentgate tools scan` for
 * an explicit, on-demand rescan without restarting the gateway.
 */
export async function startStdioProxy(ctx: PipelineContext): Promise<void> {
  // We proxy to a downstream server — discover its tools first.
  // For Milestone 1: discover tools from the first configured server.
  const firstServer = ctx.config.servers[0];
  if (!firstServer || firstServer.transport !== 'stdio') {
    throw new Error('At least one stdio downstream server must be configured for Milestone 1.');
  }

  const toolIntegrityMode = ctx.config.tool_integrity.mode;
  const serverIdentityInfo = computeServerIdentity(firstServer);

  // ── Discover tools from downstream (paginated) ─────────────────────────────
  // This single scan is the source of truth for BOTH what is exposed
  // upstream and what feeds the Tool Integrity Registry — using two
  // separate discovery connections here would risk the two disagreeing if
  // the downstream server's advertised tools changed between them.
  let rawDownstreamTools: unknown[] = [];
  const scanResult = await scanDownstreamServer(firstServer);
  if (scanResult.manifest.ok) {
    rawDownstreamTools = scanResult.rawTools;
  } else {
    console.error('[agentgate] Warning: could not discover downstream tools:', scanResult.manifest.error ?? 'unknown error');
  }

  if (toolIntegrityMode !== 'disabled') {
    // applyScanToRegistry() itself records a scan_failed event when given
    // a not-ok manifest, so a discovery failure is visible in Tool
    // Integrity history, not silently dropped as only a console warning.
    applyScanToRegistry(ctx.storage, serverIdentityInfo.identity, serverIdentityInfo.serverId, scanResult.manifest, toolIntegrityMode);
  }

  // The raw tool objects from the startup scan (not yet filtered) — kept so
  // the ListToolsRequestSchema handler below can re-filter by CURRENT Tool
  // Integrity state on every request, not just once at startup. This
  // matters because a rescan/review can happen out-of-band (CLI, Control
  // API, Control Center) at any point after the gateway has already
  // started — without re-filtering per request, a tool trusted five
  // minutes ago would stay invisible to tools/list until the gateway was
  // restarted, even though checkCallAllowed() below already re-reads live
  // state on every call. Re-filtering here is a cheap set of DB lookups
  // against already-known tool objects — it never re-contacts the
  // downstream server (that only happens via an explicit rescan).
  const validRawTools = (rawDownstreamTools as Array<{ name: string }>).filter(
    (t) => typeof t === 'object' && t !== null && typeof t.name === 'string'
  );

  // ── Build the proxy MCP server ─────────────────────────────────────────────
  const server = new Server(
    { name: 'agentgate', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // Expose only tools that are CURRENTLY trusted (in an enforcing mode) —
  // annotations on the raw tool objects are never consulted for this
  // decision, only the Tool Integrity Registry's own recorded state, read
  // fresh on every tools/list request (see comment on validRawTools above).
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: filterTrustedTools(ctx.storage, serverIdentityInfo.identity, validRawTools, toolIntegrityMode),
  }));

  // Intercept tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request, _extra) => {
    const toolName = request.params.name;
    const rawArgs = (request.params.arguments ?? {});

    // Milestone 6 (ADR-0012): quarantine enforcement happens here, BEFORE
    // policy evaluation or any downstream execution — this blocks a
    // direct call by name even if the calling client cached an older
    // tools/list response that included this tool, or never called
    // tools/list at all. Never reaches runPipeline()/executeDownstream()
    // for a blocked call.
    const callCheck = checkCallAllowed(ctx.storage, serverIdentityInfo.identity, toolName, toolIntegrityMode);
    if (!callCheck.allowed) {
      return {
        content: [{ type: 'text', text: `[AgentGate] Tool Integrity: ${callCheck.reason ?? 'This tool is not currently trusted.'}` }],
        isError: true,
      };
    }

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
