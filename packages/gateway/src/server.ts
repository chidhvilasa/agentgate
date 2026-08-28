import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { AuditStorage } from './storage.js';
import { ApprovalManager } from './approval.js';
import { buildControlApi, LOCAL_AUTH_TOKEN } from './api/control.js';
import { startStdioProxy } from './transport/stdio.js';
import { loadGatewayConfig } from './config/registry.js';
import { sanitizeErrorMessage } from '@chidhvilasa/policy';
import type { AuditEvent, Approval } from '@chidhvilasa/protocol';
import type { PipelineContext } from './pipeline.js';
import { computeServerIdentity } from './tool-integrity/identity.js';
import { createContext, closeOrExpireContext } from './context-guard/state.js';
import type { ContextEvent } from './context-guard/types.js';

export { LOCAL_AUTH_TOKEN };

export async function startGateway(configPath: string): Promise<void> {
  console.error('[agentgate] Loading config from', configPath);
  const config = loadGatewayConfig(configPath);

  const storage = new AuditStorage(config.db_path);
  const approvalManager = new ApprovalManager(storage);
  const eventBus = new EventEmitter();

  // Milestone 7 (ADR-0013): one execution context per gateway process/
  // upstream-connection lifetime — the preferred, truthful boundary this
  // architecture can actually support today (see ADR-0013 "exact execution
  // context boundary"). Created unconditionally (even in `disabled` mode,
  // which is cheap and keeps the CLI/API/UI's "no context" case identical
  // to "not yet created" only when the DB itself predates this milestone).
  const contextId = crypto.randomUUID();
  const contextServerIdentity = config.servers[0] ? computeServerIdentity(config.servers[0]).identity : null;
  if (config.context_guard.mode !== 'disabled') {
    createContext(storage, contextId, contextServerIdentity);
  }

  const ctx: PipelineContext = {
    storage,
    approvalManager,
    config,
    contextId,
    // Milestone 7 (ADR-0013): the SAME bus publishes both audit-event
    // transitions AND Context Guard transitions — one mechanism, never a
    // second parallel stream (see api/control.ts's SSE handler, which
    // discriminates by payload shape at the point of sending).
    emitEvent: (event: AuditEvent | ContextEvent) => eventBus.emit('event', event),
  };

  // SSE subscription handler
  const subscribers: Array<(ev: AuditEvent | Approval | ContextEvent) => void> = [];
  eventBus.on('event', (ev) => subscribers.forEach((fn) => fn(ev)));
  approvalManager.on('created', (approval: Approval) => subscribers.forEach((fn) => fn(approval)));
  approvalManager.on('resolved', (approval: Approval) => subscribers.forEach((fn) => fn(approval)));

  // Start local control API
  const controlApp = buildControlApi({
    storage,
    approvalManager,
    version: '0.1.0',
    gatewayPort: config.gateway_port,
    dbPath: config.db_path,
    policyPath: config.policy,
    onEvent: (handler) => subscribers.push(handler),
    // Milestone 6 (ADR-0012): the Tool Integrity Control API routes are
    // scoped to the first configured downstream server, matching
    // startStdioProxy()'s own "first server" scope for Milestone 1-era
    // single-server support.
    toolIntegrity: config.servers[0] ? { server: config.servers[0], mode: config.tool_integrity.mode } : undefined,
    // Milestone 7 (ADR-0013): scoped to this process's single execution
    // context, matching startGateway()'s own single-context model above.
    // `emit` reuses the EXACT SAME publish function passed into
    // PipelineContext.emitEvent above — the reset route is the only
    // Control-API-initiated Context Guard mutation, and it must publish
    // through the identical single bus everything else uses, never a
    // second parallel one.
    contextGuard: { contextId, mode: config.context_guard.mode, emit: ctx.emitEvent },
  });

  await controlApp.listen({ port: config.control_port, host: '127.0.0.1' });
  console.error(`[agentgate] Control API listening on http://127.0.0.1:${config.control_port}`);

  // Import LOCAL_AUTH_TOKEN after it has been set
  const { LOCAL_AUTH_TOKEN: token } = await import('./api/control.js');
  console.error(`[agentgate] Auth token: ${token}`);
  console.error(`[agentgate] Control Center: http://127.0.0.1:${config.control_port}`);

  // Milestone 5: clean shutdown on Ctrl+C / termination. Without this,
  // SIGINT/SIGTERM killed the process with no handler at all — Fastify's
  // listener, any open SSE connections, and the approval-expiry interval
  // were simply abandoned rather than closed. `guard` makes this
  // idempotent (both signals firing, or the same signal twice in quick
  // succession, still shuts down exactly once). better-sqlite3's WAL mode
  // is already crash-safe on its own — this is about closing cleanly, not
  // about a real corruption risk from the previous behavior.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[agentgate] Received ${signal}, shutting down...`);
    void controlApp
      .close()
      .catch((err) => console.error('[agentgate] Error closing Control API:', sanitizeErrorMessage(err, { source: 'internal' }).message))
      .finally(() => {
        approvalManager.destroy();
        try {
          if (config.context_guard.mode !== 'disabled') {
            closeOrExpireContext(storage, contextId, 'closed');
          }
        } catch (err) {
          console.error('[agentgate] Error closing execution context:', sanitizeErrorMessage(err, { source: 'internal' }).message);
        }
        try {
          storage.close();
        } catch (err) {
          console.error('[agentgate] Error closing database:', sanitizeErrorMessage(err, { source: 'internal' }).message);
        }
        console.error('[agentgate] Shutdown complete.');
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the stdio proxy (blocks until stdin closes)
  await startStdioProxy(ctx);
}
