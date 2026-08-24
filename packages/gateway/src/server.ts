import { EventEmitter } from 'node:events';
import { AuditStorage } from './storage.js';
import { ApprovalManager } from './approval.js';
import { buildControlApi, LOCAL_AUTH_TOKEN } from './api/control.js';
import { startStdioProxy } from './transport/stdio.js';
import { loadGatewayConfig } from './config/registry.js';
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

  // Start the stdio proxy (blocks until stdin closes)
  await startStdioProxy(ctx);
}
