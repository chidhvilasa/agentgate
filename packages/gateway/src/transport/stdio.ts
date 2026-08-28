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
import { closeOrExpireContext } from '../context-guard/state.js';
import { sanitizeErrorMessage } from '@agentgate/policy';

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

  // ── Milestone 7 (ADR-0013): finalize the execution context on transport
  //    close/error, not only on a process-level SIGINT/SIGTERM (server.ts
  //    already handles that case). The MCP SDK's `Protocol` base class
  //    (which `Server` extends) invokes `onclose`/`onerror` whenever the
  //    underlying transport itself closes or errors — e.g. the upstream
  //    client exiting or dropping the connection without ever signaling
  //    this process — which is a distinct event from this process being
  //    asked to shut down. `closeOrExpireContext()` is itself idempotent
  //    (a no-op once the context is no longer `active`), so this can never
  //    race destructively with server.ts's own shutdown-signal handler —
  //    whichever fires first performs the real transition, the other is a
  //    safe no-op. Registered BEFORE connect() so a close/error during the
  //    connection handshake itself is still caught.
  const finalizeContextOnTransportEnd = (label: string) => (err?: unknown) => {
    if (err !== undefined) {
      console.error(`[agentgate] Stdio transport error: ${sanitizeErrorMessage(err, { source: 'internal' }).message}`);
    }
    try {
      if (ctx.config.context_guard.mode !== 'disabled') {
        // Checked BEFORE closing so the SSE emit below fires only on an
        // ACTUAL fresh transition, never on the idempotent no-op path
        // (closeOrExpireContext() itself doesn't return which case
        // occurred, only the resulting state either way) — avoids
        // publishing a duplicate/stale event if this ever runs twice.
        const wasActive = ctx.storage.getContextState(ctx.contextId)?.status === 'active';
        const closedState = closeOrExpireContext(ctx.storage, ctx.contextId, 'closed');
        if (wasActive && closedState) {
          const latestEvent = ctx.storage.listContextEvents({ contextId: ctx.contextId, limit: 1 })[0];
          if (latestEvent) ctx.emitEvent(latestEvent);
        }
      }
    } catch (closeErr) {
      console.error(
        `[agentgate] Error closing execution context on ${label}:`,
        sanitizeErrorMessage(closeErr, { source: 'internal' }).message
      );
    }
  };
  server.onclose = finalizeContextOnTransportEnd('transport close');
  server.onerror = finalizeContextOnTransportEnd('transport error');

  // The installed SDK's `StdioServerTransport` (verified by reading
  // `@modelcontextprotocol/sdk/dist/esm/server/stdio.js` directly) only
  // ever attaches `'data'`/`'error'` listeners to `process.stdin` — it
  // never listens for `'end'`, so it never calls its own `close()` (and
  // therefore never fires `server.onclose` above) when the upstream client
  // closes its side of the pipe gracefully (`stdin.end()`, the FIRST thing
  // the official client SDK's own `close()` does, well before it escalates
  // to SIGTERM/SIGKILL after a 2s grace period). Without this listener, a
  // graceful disconnect would leave the context `active` for up to that
  // escalation window — or indefinitely, since a process-level SIGTERM is
  // not reliably delivered as a catchable signal to a Windows child process
  // at all. `process.stdin`'s `'end'` event is an OS-level pipe-close
  // notification, not a signal — it fires reliably cross-platform. This
  // does not duplicate the pipeline or the transport; it only closes the
  // one gap the SDK's own transport leaves open.
  process.stdin.on('end', finalizeContextOnTransportEnd('stdin end'));

  // ── Start accepting stdio from Claude Code ────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[agentgate] Stdio proxy started. Waiting for MCP client...');
}
