import { describe, it, expect } from 'vitest';
import { evaluateHistoricalEvent, ReplayUnsupportedEventError } from '../src/replay.js';
import type { Policy } from '@chidhvilasa/policy';
import type { AuditEvent, AgentIdentity, ToolCall, PolicyDecision } from '@chidhvilasa/protocol';

const AGENT: AgentIdentity = {
  session_id: 's1',
  declared_name: 'test-agent',
  declared_version: '1.0',
  connection_identity: 'x',
  verified_identity: false,
};

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    tool: 'read_file',
    raw_arguments: { path: '/project/README.md' },
    normalized_arguments: { path: '/project/README.md' },
    mcp_era: 'legacy-2025',
    jsonrpc_id: null,
    ...overrides,
  };
}

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    type: 'ALLOW',
    reason_code: 'POLICY_ALLOW',
    explanation: 'Allowed by rule "x".',
    matched_rule_id: 'x',
    ...overrides,
  };
}

function sourceEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'evt-1',
    sequence_number: 1,
    previous_event_hash: null,
    event_hash: 'deadbeef',
    canonical_payload_version: '2',
    created_at: '2026-01-01T00:00:00.000Z',
    agent: AGENT,
    tool_call: toolCall(),
    status: 'SUCCEEDED',
    decision: decision(),
    execution_succeeded: true,
    execution_error: null,
    duration_ms: 10,
    arguments_redacted: false,
    result_redacted: false,
    result_blocked: false,
    result_finding_count: 0,
    error_redacted: false,
    ...overrides,
  };
}

function policy(rules: Policy['rules'], defaultDecision: 'allow' | 'deny' = 'deny'): Policy {
  return { version: 1, defaults: { decision: defaultDecision }, rules };
}

describe('evaluateHistoricalEvent — decision transitions', () => {
  it('reports unchanged when original ALLOW matches current ALLOW', () => {
    const event = sourceEvent({ decision: decision({ type: 'ALLOW', matched_rule_id: 'allow-reads' }) });
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.current.decision_type).toBe('ALLOW');
    expect(r.decision_changed).toBe(false);
    expect(r.matched_rule_changed).toBe(false);
    expect(r.comparison).toBe('Policy decision unchanged.');
  });

  it('reports changed when original ALLOW becomes current DENY', () => {
    const event = sourceEvent({ decision: decision({ type: 'ALLOW', matched_rule_id: 'allow-reads' }) });
    const currentPolicy = policy([{ id: 'deny-reads', tools: ['read_file'], decision: 'deny' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.current.decision_type).toBe('DENY');
    expect(r.decision_changed).toBe(true);
    expect(r.comparison).toContain('changed from ALLOW to DENY');
  });

  it('reports changed when original DENY becomes current ALLOW', () => {
    const event = sourceEvent({
      status: 'DENIED',
      decision: decision({ type: 'DENY', reason_code: 'POLICY_DENY', matched_rule_id: 'deny-reads' }),
    });
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.current.decision_type).toBe('ALLOW');
    expect(r.decision_changed).toBe(true);
  });

  it('represents a transition to REQUIRE_APPROVAL hypothetically', () => {
    const event = sourceEvent({ decision: decision({ type: 'ALLOW', matched_rule_id: 'allow-reads' }) });
    const currentPolicy = policy([
      { id: 'approve-reads', tools: ['read_file'], decision: 'require_approval', approval_ttl_seconds: 60 },
    ]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.current.decision_type).toBe('REQUIRE_APPROVAL');
    expect(r.decision_changed).toBe(true);
  });

  it('represents a transition from REQUIRE_APPROVAL hypothetically', () => {
    const event = sourceEvent({
      status: 'PENDING_APPROVAL',
      decision: decision({ type: 'REQUIRE_APPROVAL', reason_code: 'POLICY_REQUIRE_APPROVAL', matched_rule_id: 'approve-reads' }),
    });
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.current.decision_type).toBe('ALLOW');
    expect(r.decision_changed).toBe(true);
  });

  it('represents an ALLOW_WITH_TRANSFORM comparison, including which fields would be transformed', () => {
    const event = sourceEvent({ decision: decision({ type: 'ALLOW', matched_rule_id: 'allow-reads' }) });
    const currentPolicy = policy([
      {
        id: 'transform-reads',
        tools: ['read_file'],
        decision: 'allow_with_transform',
        transformations: [{ redact_field: 'path', replace_with: '[REDACTED]' }],
      },
    ]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.current.decision_type).toBe('ALLOW_WITH_TRANSFORM');
    expect(r.current.transformations).toEqual(['redact:path']);
    expect(r.decision_changed).toBe(true);
  });

  it('detects a matched-rule-only drift when the decision type is unchanged', () => {
    const event = sourceEvent({ decision: decision({ type: 'ALLOW', matched_rule_id: 'old-allow-rule' }) });
    const currentPolicy = policy([{ id: 'new-allow-rule', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.decision_changed).toBe(false);
    expect(r.matched_rule_changed).toBe(true);
    expect(r.current.matched_rule_id).toBe('new-allow-rule');
  });

  it('detects a reason-code change independent of decision/rule drift', () => {
    // Original recorded a DEFAULT_DENY (no rule matched); current has an
    // explicit deny rule — same DENY decision type, different reason code.
    const event = sourceEvent({
      status: 'DENIED',
      decision: decision({ type: 'DENY', reason_code: 'DEFAULT_DENY', matched_rule_id: null }),
    });
    const currentPolicy = policy([{ id: 'deny-reads', tools: ['read_file'], decision: 'deny' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.current.decision_type).toBe('DENY');
    expect(r.decision_changed).toBe(false);
    expect(r.reason_code_changed).toBe(true);
    expect(r.matched_rule_changed).toBe(true);
  });
});

describe('evaluateHistoricalEvent — limitations and edge cases', () => {
  it('warns explicitly when source arguments were redacted', () => {
    const event = sourceEvent({ arguments_redacted: true });
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.source_arguments_redacted).toBe(true);
    expect(r.limitations.some((l) => l.includes('redacted'))).toBe(true);
  });

  it('does not claim a redaction limitation when arguments were not redacted', () => {
    const event = sourceEvent({ arguments_redacted: false });
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.limitations.some((l) => l.toLowerCase().includes('redact'))).toBe(false);
  });

  it('warns explicitly when the source event has no recorded original decision', () => {
    const event = sourceEvent({ status: 'RECEIVED', decision: null });
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.original.decision_type).toBeNull();
    expect(r.limitations.some((l) => l.includes('No original policy decision'))).toBe(true);
  });

  it('rejects a source event with no recognizable tool_call.tool', () => {
    const event = sourceEvent({ tool_call: toolCall({ tool: '' }) });
    const currentPolicy = policy([]);
    expect(() => evaluateHistoricalEvent({ sourceEvent: event, currentPolicy })).toThrow(ReplayUnsupportedEventError);
  });

  it('rejects a source event with malformed normalized_arguments', () => {
    const event = sourceEvent({
      tool_call: { ...toolCall(), normalized_arguments: null as unknown as Record<string, unknown> },
    });
    const currentPolicy = policy([]);
    expect(() => evaluateHistoricalEvent({ sourceEvent: event, currentPolicy })).toThrow(ReplayUnsupportedEventError);
  });

  it('rejects a source event with no recognizable agent', () => {
    const event = sourceEvent({ agent: undefined as unknown as AgentIdentity });
    const currentPolicy = policy([]);
    expect(() => evaluateHistoricalEvent({ sourceEvent: event, currentPolicy })).toThrow(ReplayUnsupportedEventError);
  });

  it('is deterministic: identical source event and policy produce identical decision comparisons', () => {
    const event = sourceEvent();
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r1 = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    const r2 = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r1.current).toEqual(r2.current);
    expect(r1.decision_changed).toBe(r2.decision_changed);
    expect(r1.policy_digest).toBe(r2.policy_digest);
  });

  it('never mutates the source event object', () => {
    const event = sourceEvent();
    const snapshot = JSON.parse(JSON.stringify(event));
    const currentPolicy = policy([{ id: 'deny-reads', tools: ['read_file'], decision: 'deny' }]);
    evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(event).toEqual(snapshot);
  });

  it('error messages for an unsupported event never include raw argument values', () => {
    const event = sourceEvent({
      tool_call: toolCall({ tool: '', normalized_arguments: { secret: 'sk-should-not-appear-in-error-abcdefgh' } }),
    });
    const currentPolicy = policy([]);
    try {
      evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
      expect.unreachable('expected evaluateHistoricalEvent to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayUnsupportedEventError);
      expect((err as Error).message).not.toContain('sk-should-not-appear-in-error-abcdefgh');
    }
  });

  it('always includes the fixed "never executes" limitation regardless of other conditions', () => {
    const event = sourceEvent();
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.limitations.some((l) => l.includes('never executes the tool'))).toBe(true);
  });

  it('always notes the evaluation is against the current policy, not a historical snapshot', () => {
    const event = sourceEvent();
    const currentPolicy = policy([{ id: 'allow-reads', tools: ['read_file'], decision: 'allow' }]);
    const r = evaluateHistoricalEvent({ sourceEvent: event, currentPolicy });
    expect(r.limitations.some((l) => l.toLowerCase().includes('historical snapshot'))).toBe(true);
  });
});
