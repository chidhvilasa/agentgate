// Context Guard Control API tests (Milestone 7, ADR-0013). Mirrors
// tool-integrity-api.test.ts's structure and security-test discipline —
// uses Fastify's app.inject() (no real network listen needed) against a
// real in-memory AuditStorage/ApprovalManager, never a mock of the API
// layer itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { buildControlApi, LOCAL_AUTH_TOKEN } from '../src/api/control.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import { createContext, appendContextLabels, closeOrExpireContext } from '../src/context-guard/state.js';
import type { ContextEvent } from '../src/context-guard/types.js';

describe('Context Guard Control API (ADR-0013)', () => {
  let storage: AuditStorage;
  let approvalManager: ApprovalManager;
  let app: ReturnType<typeof buildControlApi>;
  let emitted: ContextEvent[];

  beforeEach(() => {
    storage = new AuditStorage(':memory:');
    approvalManager = new ApprovalManager(storage);
    emitted = [];
    app = buildControlApi({
      storage,
      approvalManager,
      version: '1.0',
      gatewayPort: 8080,
      dbPath: ':memory:',
      policyPath: path.join(os.tmpdir(), 'nonexistent-policy.yml'),
      onEvent: () => {},
      contextGuard: { contextId: 'active-ctx', mode: 'enforce', emit: (e) => emitted.push(e) },
    });
  });

  afterEach(async () => {
    approvalManager.destroy();
    storage.close();
    await app.close();
  });

  function auth() {
    return { host: 'localhost', 'x-agentgate-token': LOCAL_AUTH_TOKEN };
  }

  describe('auth and transport security', () => {
    it('rejects an unauthenticated list request', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts', headers: { host: 'localhost' } });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a hostile Host header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts', headers: { host: 'evil.com', 'x-agentgate-token': LOCAL_AUTH_TOKEN } });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a hostile Origin header', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts', headers: { ...auth(), origin: 'https://evil.example' } });
      expect(res.statusCode).toBe(403);
    });

    it('sets Referrer-Policy: no-referrer on a successful response', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts', headers: auth() });
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('allows the configured CORS origin for a preflight-style request', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/contexts',
        headers: { ...auth(), origin: 'http://127.0.0.1:5173' },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/contexts (list)', () => {
    it('returns an empty, bounded list when no contexts exist', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts', headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.contexts).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.truncated).toBe(false);
    });

    it('lists a real context with its labels, pending-approval count, and safe metadata', async () => {
      createContext(storage, 'ctx-1', 'srv:abc');
      appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: 'evt-1', toolName: 'fetch_ticket', reason: 'r' });
      const res = await app.inject({ method: 'GET', url: '/api/contexts', headers: auth() });
      const body = res.json();
      expect(body.contexts).toHaveLength(1);
      expect(body.contexts[0].context_id).toBe('ctx-1');
      expect(body.contexts[0].labels).toEqual(['untrusted_content']);
      expect(body.contexts[0].server_identity).toBe('srv:abc');
      expect(body.contexts[0].pending_approval_count).toBe(0);
    });

    it('filters by lifecycle state', async () => {
      createContext(storage, 'ctx-active', null);
      createContext(storage, 'ctx-closed', null);
      closeOrExpireContext(storage, 'ctx-closed', 'closed');
      const res = await app.inject({ method: 'GET', url: '/api/contexts?state=closed', headers: auth() });
      const body = res.json<{ contexts: Array<{ context_id: string }> }>();
      expect(body.contexts.map((c) => c.context_id)).toEqual(['ctx-closed']);
    });

    it('rejects an invalid state filter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts?state=not-a-real-state', headers: auth() });
      expect(res.statusCode).toBe(400);
    });

    it('bounds the list with a limit parameter and reports truncated:true', async () => {
      for (let i = 0; i < 5; i++) createContext(storage, `ctx-${i}`, null);
      const res = await app.inject({ method: 'GET', url: '/api/contexts?limit=2', headers: auth() });
      const body = res.json();
      expect(body.contexts).toHaveLength(2);
      expect(body.total).toBe(5);
      expect(body.truncated).toBe(true);
    });

    it('rejects an invalid limit parameter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts?limit=not-a-number', headers: auth() });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/contexts/:id (detail)', () => {
    it('returns 404 for an unknown context id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts/does-not-exist', headers: auth() });
      expect(res.statusCode).toBe(404);
    });

    it('returns a malformed-looking id safely as a 404, never a 500', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/contexts/${encodeURIComponent('<script>alert(1)</script>')}`, headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(JSON.stringify(res.json())).not.toContain('<script>');
    });

    it('returns full detail for a known context', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'GET', url: '/api/contexts/ctx-1', headers: auth() });
      expect(res.statusCode).toBe(200);
      expect(res.json().context_id).toBe('ctx-1');
    });
  });

  describe('GET /api/contexts/:id/history', () => {
    it('returns 404 for an unknown context', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts/nope/history', headers: auth() });
      expect(res.statusCode).toBe(404);
    });

    it('returns bounded, deterministic, chain-verified history', async () => {
      createContext(storage, 'ctx-1', null);
      appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: 'evt-1', toolName: 'a', reason: 'r' });
      const res = await app.inject({ method: 'GET', url: '/api/contexts/ctx-1/history', headers: auth() });
      const body = res.json<{ chain_valid: boolean; events: Array<{ event_type: string }> }>();
      expect(body.chain_valid).toBe(true);
      expect(body.events.map((e) => e.event_type)).toEqual(['context_created', 'label_added']);
    });

    it('bounds history with a limit parameter', async () => {
      createContext(storage, 'ctx-1', null);
      for (let i = 0; i < 5; i++) {
        appendContextLabels(storage, 'ctx-1', [`custom_label_${i}`], { sourceEventId: null, toolName: 'a', reason: 'r' });
      }
      const res = await app.inject({ method: 'GET', url: '/api/contexts/ctx-1/history?limit=2', headers: auth() });
      const body = res.json();
      expect(body.events).toHaveLength(2);
      expect(body.truncated).toBe(true);
    });

    it('never includes raw argument/result content — hostile-looking strings in a reason are only ever the safe, already-constructed reason text, never a raw payload field', async () => {
      createContext(storage, 'ctx-1', null);
      appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: 'evt-1', toolName: 'fetch_ticket', reason: 'Tool "fetch_ticket" succeeded with a non-blocked result.' });
      const res = await app.inject({ method: 'GET', url: '/api/contexts/ctx-1/history', headers: auth() });
      const raw = JSON.stringify(res.json());
      expect(raw).not.toContain('raw_arguments');
      expect(raw).not.toContain('normalized_arguments');
    });
  });

  describe('GET /api/contexts/:id/explain', () => {
    it('returns 404 for an unknown context', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/contexts/nope/explain', headers: auth() });
      expect(res.statusCode).toBe(404);
    });

    it('explains stored evidence without fabricating a hypothetical decision', async () => {
      createContext(storage, 'ctx-1', null);
      appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: 'evt-1', toolName: 'fetch_ticket', reason: 'r' });
      const res = await app.inject({ method: 'GET', url: '/api/contexts/ctx-1/explain', headers: auth() });
      const body = res.json();
      expect(body.labels).toEqual(['untrusted_content']);
      expect(body.label_origins[0].tool_name).toBe('fetch_ticket');
      expect(body.latest_decision).toBeNull(); // no call_evaluated event was ever recorded — a fact, not fabricated.
    });
  });

  describe('POST /api/contexts/:id/reset', () => {
    it('rejects unauthenticated reset attempts', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: { host: 'localhost' }, payload: { revision: 0, reason: 'x' } });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a malformed body shape', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: ['not', 'an', 'object'] });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown/execution-like extra field in the body', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 0, reason: 'x', force: true } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/force/);
    });

    it('rejects a missing/empty reason', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 0, reason: '' } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an oversized reason', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 0, reason: 'x'.repeat(2001) } });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a non-integer/negative revision', async () => {
      createContext(storage, 'ctx-1', null);
      const res1 = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 1.5, reason: 'x' } });
      expect(res1.statusCode).toBe(400);
      const res2 = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: -1, reason: 'x' } });
      expect(res2.statusCode).toBe(400);
    });

    it('rejects a stale revision (409) — never silently applied against whatever the current revision happens to be', async () => {
      createContext(storage, 'ctx-1', null);
      appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' }); // revision -> 1
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 0, reason: 'x' } });
      expect(res.statusCode).toBe(409);
    });

    it('rejects reset on an already-closed/expired context', async () => {
      createContext(storage, 'ctx-1', null);
      const closed = closeOrExpireContext(storage, 'ctx-1', 'closed')!;
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: closed.revision, reason: 'x' } });
      expect(res.statusCode).toBe(409);
    });

    it('succeeds with an exact revision and reason, appends history, and invalidates pending contextual approvals', async () => {
      createContext(storage, 'ctx-1', null);
      storage.insertEvent({
        id: 'evt-1',
        created_at: new Date().toISOString(),
        agent: { session_id: 'test', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
        tool_call: { tool: 'send_webhook', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
        status: 'PENDING_APPROVAL',
        decision: null,
        execution_succeeded: null,
        execution_error: null,
        duration_ms: null,
        arguments_redacted: false,
        result_redacted: false,
        result_blocked: false,
        result_finding_count: 0,
        error_redacted: false,
      });
      const approval = approvalManager.create({
        event_id: 'evt-1',
        ttl_seconds: 60,
        proposed_action_display: 'send_webhook({})',
        policy_reason: 'requires approval',
        scope: 'send_webhook',
        contextBinding: { context_id: 'ctx-1', context_revision: 0, tool_fingerprint: null, argument_digest: null, contextual_rule_id: 'r1' },
      });
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 0, reason: 'operator-requested reset' } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('reset');
      expect(body.new_revision).toBe(1);
      expect(body.invalidated_approval_count).toBe(1);
      expect(storage.getApproval(approval.id)!.status).toBe('DENIED');

      // History is append-only — never deleted.
      const historyRes = await app.inject({ method: 'GET', url: '/api/contexts/ctx-1/history', headers: auth() });
      const historyBody = historyRes.json<{ events: Array<{ event_type: string }> }>();
      expect(historyBody.events.map((e) => e.event_type)).toEqual(['context_created', 'context_reset']);

      // Publishes through the SSE bus.
      expect(emitted.some((e) => e.event_type === 'context_reset')).toBe(true);
    });

    it('concurrent double reset: exactly one succeeds, the other reports stale/conflict — never both applied', async () => {
      createContext(storage, 'ctx-1', null);
      const [res1, res2] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 0, reason: 'first' } }),
        app.inject({ method: 'POST', url: '/api/contexts/ctx-1/reset', headers: auth(), payload: { revision: 0, reason: 'second' } }),
      ]);
      const codes = [res1.statusCode, res2.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      // Exactly one reset transition was ever recorded, never two.
      const historyRes = await app.inject({ method: 'GET', url: '/api/contexts/ctx-1/history', headers: auth() });
      const historyBody = historyRes.json<{ events: Array<{ event_type: string }> }>();
      expect(historyBody.events.filter((e) => e.event_type === 'context_reset')).toHaveLength(1);
    });

    it('never leaks the auth token or a filesystem path in an error response', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/contexts/does-not-exist/reset', headers: auth(), payload: { revision: 0, reason: 'x' } });
      const raw = JSON.stringify(res.json());
      expect(raw).not.toContain(LOCAL_AUTH_TOKEN);
      expect(raw).not.toMatch(/[/\\][A-Za-z]:[/\\]|\/(home|Users)\//);
    });
  });

  describe('GET /api/context-integrity (verify)', () => {
    it('reports a valid empty chain', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/context-integrity', headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(body.count).toBe(0);
      expect(body.limitation).toMatch(/tamper EVIDENCE, not non-repudiation/);
    });

    it('reports a valid non-empty chain', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'GET', url: '/api/context-integrity', headers: auth() });
      expect(res.json()).toMatchObject({ valid: true, count: 1 });
    });

    it('detects mutation and reports the failure location/reason, exit-code-equivalent (non-2xx not required, but valid:false is authoritative)', async () => {
      createContext(storage, 'ctx-1', null);
      // Corrupt storage directly, exactly mirroring the state/migration tests' tamper style.
      (storage as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare(`UPDATE context_events SET reason = 'TAMPERED' WHERE sequence_number = 1`)
        .run();
      const res = await app.inject({ method: 'GET', url: '/api/context-integrity', headers: auth() });
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.error).toMatch(/Tampering detected/);
    });
  });

  describe('no broad reset / policy / trust mutation route exists', () => {
    it('there is no route to reset/clear all contexts', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/contexts/reset', headers: auth(), payload: {} });
      expect(res.statusCode).toBe(404);
    });

    it('there is no route to remove a label directly', async () => {
      createContext(storage, 'ctx-1', null);
      const res = await app.inject({ method: 'POST', url: '/api/contexts/ctx-1/labels/remove', headers: auth(), payload: {} });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('routes are absent when the server has no contextGuard option', () => {
    it('returns 404 for /api/contexts when contextGuard was not configured', async () => {
      const bareApp = buildControlApi({
        storage,
        approvalManager,
        version: '1.0',
        gatewayPort: 8080,
        dbPath: ':memory:',
        policyPath: path.join(os.tmpdir(), 'nonexistent-policy.yml'),
        onEvent: () => {},
      });
      try {
        const res = await bareApp.inject({ method: 'GET', url: '/api/contexts', headers: auth() });
        expect(res.statusCode).toBe(404);
      } finally {
        await bareApp.close();
      }
    });
  });
});
