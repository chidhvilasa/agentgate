import { EventEmitter } from 'node:events';
import { AuditStorage } from './storage.js';
import { ApprovalManager } from './approval.js';
import { buildControlApi, LOCAL_AUTH_TOKEN } from './api/control.js';
import { startStdioProxy } from './transport/stdio.js';
import { loadGatewayConfig } from './config/registry.js';
import { sanitizeErrorMessage } from '@agentgate/policy';
import type { AuditEvent, Approval } from '@agentgate/protocol';
import type { PipelineContext } from './pipeline.js';

export { LOCAL_AUTH_TOKEN };

export async function startGateway(configPath: string): Promise<void> {
  console.error('[agentgate] Loading config from', configPath);
  const config = loadGatewayConfig(configPath);

  const storage = new AuditStorage(config.db_path);
  const approvalManager = new ApprovalManager(storage);
  const eventBus = new EventEmitter();

  const ctx: PipelineContext = {
    storage,
    approvalManager,
    config,
    emitEvent: (event: AuditEvent) => eventBus.emit('event', event),
  };

  // SSE subscription handler
  const subscribers: Array<(ev: AuditEvent | Approval) => void> = [];
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
