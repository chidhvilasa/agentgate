import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildControlApi, LOCAL_AUTH_TOKEN } from '../src/api/control.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';

const SYNTHETIC_SECRET_STANDIN = 'sk-should-never-leak-through-the-replay-api-abcdefgh';

describe('Safe Replay Control API (ADR-0010)', () => {
  let storage: AuditStorage;
  let approvalManager: ApprovalManager;
  let app: ReturnType<typeof buildControlApi>;
  let tmpDir: string;
  let policyPath: string;

  function seedEvent(id: string, overrides: Record<string, unknown> = {}) {
    return storage.insertEvent({
      id,
      created_at: new Date().toISOString(),
      agent: { session_id: 's1', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: {
        tool: 'read_file',
        raw_arguments: {},
        normalized_arguments: { note: SYNTHETIC_SECRET_STANDIN },
        mcp_era: 'legacy-2025',
        jsonrpc_id: null,
      },
      status: 'SUCCEEDED',
      decision: { type: 'ALLOW', reason_code: 'POLICY_ALLOW', explanation: 'ok', matched_rule_id: 'allow-reads' },
      execution_succeeded: true,
      execution_error: null,
      duration_ms: 5,
      arguments_redacted: false,
      result_redacted: false,
      result_blocked: false,
      result_finding_count: 0,
      error_redacted: false,
      ...overrides,
    } as never);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-replay-api-'));
    policyPath = path.join(tmpDir, 'policy.yml');
    fs.writeFileSync(
      policyPath,
      `
version: 1
defaults:
  decision: deny
rules:
  - id: allow-reads
    tools: ["read_file"]
    decision: allow
`
    );

    storage = new AuditStorage(':memory:');
    approvalManager = new ApprovalManager(storage);
    app = buildControlApi({
      storage,
      approvalManager,
      version: '1.0',
      gatewayPort: 8080,
      dbPath: ':memory:',
      policyPath,
      onEvent: () => {},
    });
  });

  afterEach(async () => {
    approvalManager.destroy();
    storage.close();
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('performs a valid authenticated replay and returns executed: false', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.executed).toBe(false);
    expect(body.mode).toBe('policy_only');
    expect(body.source_event_id).toBe('evt-1');
    expect(body.current.decision_type).toBe('ALLOW');
  });

  it('rejects requests without a valid auth token', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': 'wrong-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with a hostile Host header', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'evil.com', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 for a missing event', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/does-not-exist/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 for a non-replayable (malformed) historical event', async () => {
    // Directly insert an event with no tool name — a shape real pipeline.ts
    // code would never produce, but replay must still fail closed on it
    // rather than crash or guess.
    seedEvent('evt-broken', { tool_call: { tool: '', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-broken/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(response.statusCode).toBe(409);
  });

  it('fails closed (500, sanitized) when the current policy file is malformed', async () => {
    seedEvent('evt-1');
    fs.writeFileSync(policyPath, 'not: [valid, policy, shape');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(response.statusCode).toBe(500);
    // No local path leakage beyond what's necessary — checked both as a raw
    // substring and as its JSON-escaped form (JSON.stringify doubles
    // backslashes in a Windows path, which would otherwise mask a real leak
    // in this specific assertion on Windows but not on POSIX).
    expect(response.body).not.toContain(policyPath);
    expect(response.body).not.toContain(JSON.stringify(policyPath).slice(1, -1));
    expect(response.json().error).toBe(
      'Could not load the current policy file — it is missing or invalid. Check the gateway logs for details.'
    );
  });

  it('rejects dry_run: false rather than silently ignoring it', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN, 'content-type': 'application/json' },
      payload: { dry_run: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('dry_run');
  });

  it('rejects execute: true rather than silently ignoring it', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN, 'content-type': 'application/json' },
      payload: { execute: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('execute');
  });

  it('rejects run: true rather than silently ignoring it', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN, 'content-type': 'application/json' },
      payload: { run: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an entirely unknown field', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN, 'content-type': 'application/json' },
      payload: { some_unexpected_field: 'x' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts an explicit, valid contract_version', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN, 'content-type': 'application/json' },
      payload: { contract_version: 1 },
    });
    expect(response.statusCode).toBe(200);
  });

  it('never leaks a raw secret-shaped value from the source event through the response', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(response.body).not.toContain(SYNTHETIC_SECRET_STANDIN);
  });

  it('persists the replay evaluation with source lineage', async () => {
    seedEvent('evt-1');
    const response = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    const body = response.json();
    const stored = storage.getReplayEvaluation(body.replay_id);
    expect(stored).not.toBeNull();
    expect(stored?.source_event_id).toBe('evt-1');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/events/evt-1/replays',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);
  });

  it('GET /api/replays/:id fetches a previously stored evaluation', async () => {
    seedEvent('evt-1');
    const postResponse = await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    const { replay_id } = postResponse.json();

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/replays/${replay_id}`,
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().replay_id).toBe(replay_id);
  });

  it('returns 404 for an unknown replay evaluation id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/replays/does-not-exist',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    expect(response.statusCode).toBe(404);
  });

  it('does not mutate the source event when replaying', async () => {
    seedEvent('evt-1');
    const before = storage.getEvent('evt-1');
    await app.inject({
      method: 'POST',
      url: '/api/events/evt-1/replay',
      headers: { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN },
    });
    const after = storage.getEvent('evt-1');
    expect(after).toEqual(before);
  });
});
