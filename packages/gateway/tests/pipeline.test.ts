import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { runPipeline } from '../src/pipeline.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import type { AgentIdentity } from '@agentgate/protocol';

describe('Gateway Pipeline', () => {
  it('denies requests that violate policy without calling downstream', async () => {
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
      },
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
