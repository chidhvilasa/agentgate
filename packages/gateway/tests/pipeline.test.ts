import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { runPipeline } from '../src/pipeline.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import { createContext } from '../src/context-guard/state.js';
import crypto from 'node:crypto';
import type { AgentIdentity } from '@agentgate/protocol';

describe('Gateway Pipeline', () => {
  // Deliberately omits `context_guard` (and is cast through `any` rather
  // than the real `GatewayConfig` type) to reproduce the exact legacy/
  // hand-built config shape a caller bypassing loadGatewayConfig() could
  // pass — this is the regression proof that runPipeline() falls back to
  // the canonical Context Guard default (see defaultContextGuardConfig()
  // in config/registry.ts) instead of throwing on `ctx.config.context_guard`
  // being undefined, and that the fallback still enforces a base-policy
  // deny without ever reaching downstream.
  it('denies requests that violate policy without calling downstream (missing/legacy context_guard config)', async () => {
    const storage = new AuditStorage(':memory:');
    const approvalManager = new ApprovalManager(storage);

    fs.writeFileSync('test.policy.yml', `
version: 1
rules:
  - id: 'block-all'
    decision: 'deny'
    conditions:
      tool.name: '*'
    `);

    // A real Context Guard execution context, created exactly the way
    // server.ts creates one for a real upstream connection (ADR-0013) —
    // runPipeline() requires one to already exist, same as production.
    // (Only `context_guard` on `config` is the deliberately-omitted field
    // under test here — a missing contextId has no principled default and
    // is a separate, real lifecycle precondition.)
    const contextId = crypto.randomUUID();
    createContext(storage, contextId, null);

    const ctx = {
      storage,
      approvalManager,
      config: {
        version: 1,
        gateway_port: 0,
        control_port: 0,
        policy: 'test.policy.yml',
        db_path: '',
        servers: []
        // context_guard intentionally absent — see comment above.
      },
      contextId,
      emitEvent: vi.fn()
    } as any;

    const agent: AgentIdentity = {
      session_id: 'test-session',
      declared_name: null,
      declared_version: null,
      connection_identity: 'test',
      verified_identity: false
    };

    const { event, result } = await runPipeline({
      ctx,
      agent,
      toolName: 'test.tool',
      rawArgs: {},
      mcpEra: 'legacy-2025',
      jsonrpcId: '1'
    });

    expect(event.status).toBe('DENIED');
    expect(result).toBeNull(); // Downstream wasn't called
  });
});
