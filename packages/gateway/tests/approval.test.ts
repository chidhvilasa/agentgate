import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalManager } from '../src/approval.js';
import { AuditStorage } from '../src/storage.js';

describe('ApprovalManager', () => {
  let storage: AuditStorage;
  let manager: ApprovalManager;

  beforeEach(() => {
    storage = new AuditStorage(':memory:');
    manager = new ApprovalManager(storage);
  });

  afterEach(() => {
    storage.close();
  });

  it('creates and resolves an approval', () => {
    storage.upsertAgent({ session_id: 'test-session', identity_json: '{}', connected_at: new Date().toISOString() });
    storage.insertEvent({
      id: 'test-event-1',
      created_at: new Date().toISOString(),
      agent: { session_id: 'test-session', declared_name: 'test', declared_version: '1' },
      tool_call: { tool: 'test.tool', normalized_arguments: { foo: 'bar' } },
      status: 'RECEIVED',
      decision: null,
      execution_succeeded: null,
      execution_error: null,
      duration_ms: null,
      arguments_redacted: false,
      result_redacted: false,
    });
    
    const approval = storage.insertApproval({
      event_id: 'test-event-1',
      status: 'PENDING',
      expires_at: new Date(Date.now() + 10000).toISOString(),
      consumed: false,
      proposed_action_display: 'Run tests',
      policy_reason: 'Requires approval',
      scope: 'once',
      resolved_at: null,
      resolved_by: null,
    });

    const pending = manager.listPending();
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(approval.id);

    const result = manager.approve(approval.id);
    expect(result.ok).toBe(true);

    const afterApprove = storage.getApproval(approval.id);
    expect(afterApprove?.status).toBe('APPROVED');
    expect(afterApprove?.consumed).toBe(true);
  });
});
