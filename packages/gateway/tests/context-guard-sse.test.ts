// Context Guard SSE tests (Milestone 7, ADR-0013). No SSE stream test
// existed anywhere in this codebase before this file — `/api/events/
// stream` is a genuinely long-lived connection that app.inject() cannot
// usefully await, so these tests start the REAL Fastify app on an
// ephemeral loopback port and read the stream with Node's native
// fetch()/ReadableStream reader, exactly as a real EventSource-based
// client (the Control Center) would receive bytes. Proves Context Guard
// transitions are published through the SAME `/api/events/stream`
// connection audit_event/approval traffic already uses — never a second,
// parallel stream — and that existing `audit_event` consumers are
// unaffected by the new `context_event` frames appearing alongside them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { buildControlApi, LOCAL_AUTH_TOKEN } from '../src/api/control.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import { createContext, appendContextLabels, closeOrExpireContext } from '../src/context-guard/state.js';
import type { AuditEvent, Approval } from '@chidhvilasa/protocol';
import type { ContextEvent } from '../src/context-guard/types.js';

type Frame = { event: string; data: unknown };

/**
 * Reads SSE frames off a real fetch() stream for up to `timeoutMs`, or
 * until `count` non-heartbeat frames have arrived. Always cancels the
 * reader before returning — never leaks the connection.
 *
 * Tracks exactly ONE in-flight `reader.read()` call at a time: racing a
 * fresh `reader.read()` against a timeout on every loop iteration (without
 * remembering whether the previous read already settled) stacks up
 * multiple concurrent reads on the same ReadableStreamDefaultReader —
 * invalid Streams API usage that hangs indefinitely when nothing else
 * arrives to unblock it. This reuses the same pending-read promise across
 * iterations until it actually resolves.
 */
async function readFrames(url: string, token: string, count: number, timeoutMs = 6000): Promise<Frame[]> {
  const controller = new AbortController();
  const res = await fetch(url + `?token=${token}`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Frame[] = [];
  const deadline = Date.now() + timeoutMs;
  let pendingRead: ReturnType<typeof reader.read> | undefined;
  try {
    while (frames.length < count && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (!pendingRead) pendingRead = reader.read();
      const timedOut = Symbol('timeout');
      const result = await Promise.race([pendingRead, new Promise<typeof timedOut>((resolve) => setTimeout(() => resolve(timedOut), Math.max(50, remaining)))]);
      if (result === timedOut) continue; // pendingRead stays outstanding — reused next iteration, never re-issued.
      pendingRead = undefined; // that read settled — the next iteration may issue a new one.
      const { value, done } = result as { value: Uint8Array | undefined; done: boolean };
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.startsWith(':')) continue; // heartbeat comment
        const eventLine = part.split('\n').find((l) => l.startsWith('event: '));
        const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
        if (eventLine && dataLine) {
          frames.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) });
        }
      }
    }
  } finally {
    // abort() alone is enough to terminate the underlying connection —
    // NOT awaiting reader.cancel() here deliberately: when the last
    // reader.read() never resolved on its own (the common case for a
    // "nothing arrived" test), cancel() can itself hang waiting on that
    // same outstanding read in this fetch implementation. Fire-and-forget
    // it; the aborted connection is already torn down either way.
    controller.abort();
    void reader.cancel().catch(() => {});
  }
  return frames;
}

describe('Context Guard SSE (ADR-0013)', () => {
  let storage: AuditStorage;
  let approvalManager: ApprovalManager;
  let app: ReturnType<typeof buildControlApi>;
  let baseUrl: string;
  let contextId: string;
  // The SAME subscriber list buildControlApi()'s SSE route registers
  // itself into via onEvent() below — publishing through it here is
  // exactly what pipeline.ts's ctx.emitEvent()/server.ts's eventBus does
  // in real operation (single bus, never a second parallel one).
  let publish: (ev: AuditEvent | Approval | ContextEvent) => void;

  beforeEach(async () => {
    storage = new AuditStorage(':memory:');
    approvalManager = new ApprovalManager(storage);
    const { state } = createContext(storage, 'sse-test-ctx', null);
    contextId = state.context_id;
    const subscribers: Array<(ev: AuditEvent | Approval | ContextEvent) => void> = [];
    publish = (ev) => subscribers.forEach((fn) => fn(ev));
    app = buildControlApi({
      storage,
      approvalManager,
      version: '1.0',
      gatewayPort: 8080,
      dbPath: ':memory:',
      policyPath: path.join(os.tmpdir(), 'nonexistent-policy.yml'),
      onEvent: (handler) => subscribers.push(handler),
      contextGuard: { contextId, mode: 'enforce', emit: publish },
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `${address}/api/events/stream`;
  });

  afterEach(async () => {
    approvalManager.destroy();
    storage.close();
    await app.close();
  });

  it('publishes a Context Guard transition as a distinct "context_event" SSE frame on the SAME stream, with a bounded/redacted payload', async () => {
    const framesPromise = readFrames(baseUrl, LOCAL_AUTH_TOKEN, 1);
    await new Promise((r) => setTimeout(r, 200)); // let the connection establish before triggering
    const result = appendContextLabels(storage, contextId, ['untrusted_content'], { sourceEventId: 'evt-1', toolName: 'fetch_ticket', reason: 'r' });
    publish(result.event!);

    const frames = await framesPromise;
    const contextFrame = frames.find((f) => f.event === 'context_event');
    expect(contextFrame).toBeDefined();
    const payload = contextFrame!.data as ContextEvent;
    expect(payload.event_type).toBe('label_added');
    expect(payload.labels_added).toEqual(['untrusted_content']);
    // Bounded/redacted: only safe fields, never raw content.
    expect(JSON.stringify(payload)).not.toContain('raw_arguments');
  });

  it('publishes a plain AuditEvent as "audit_event" — existing Timeline/SSE consumers (which only ever subscribe to audit_event) are unaffected by context_event frames appearing on the same stream', async () => {
    const framesPromise = readFrames(baseUrl, LOCAL_AUTH_TOKEN, 1);
    await new Promise((r) => setTimeout(r, 200));
    const fakeAuditEvent: AuditEvent = {
      id: 'evt-1',
      created_at: new Date().toISOString(),
      agent: { session_id: 's', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'echo', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'RECEIVED',
      decision: null,
      execution_succeeded: null,
      execution_error: null,
      duration_ms: null,
      arguments_redacted: false,
      result_redacted: false,
      result_blocked: false,
      result_finding_count: 0,
      error_redacted: false,
    };
    publish(fakeAuditEvent);

    const frames = await framesPromise;
    const auditFrame = frames.find((f) => f.event === 'audit_event');
    expect(auditFrame).toBeDefined();
    expect((auditFrame!.data as AuditEvent).id).toBe('evt-1');
    expect(frames.some((f) => f.event === 'context_event')).toBe(false);
  });

  it('publishes context transitions in deterministic order, matching the order they actually happened', async () => {
    const framesPromise = readFrames(baseUrl, LOCAL_AUTH_TOKEN, 2);
    await new Promise((r) => setTimeout(r, 200));

    const r1 = appendContextLabels(storage, contextId, ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'first' });
    publish(r1.event!);
    const closed = closeOrExpireContext(storage, contextId, 'closed')!;
    void closed;
    const latest = storage.listContextEvents({ contextId, limit: 1 })[0];
    publish(latest);

    const frames = await framesPromise;
    const contextFrames = frames.filter((f) => f.event === 'context_event').map((f) => (f.data as ContextEvent).event_type);
    expect(contextFrames).toEqual(['label_added', 'context_closed']);
  });

  // A prior "fresh connection does not replay prior transitions" test
  // attempt (proving a NEGATIVE — nothing arrives — by exhausting a full
  // read-timeout) was removed here as unreliable in this environment. The
  // test below (Milestone 8 / ADR-0014 Phase 2) proves the same property
  // deterministically instead, without waiting out any negative timeout:
  // it publishes events BEFORE a fresh connection's handler is registered
  // in `subscribers` (server.ts) — those `publish()` calls can only reach
  // handlers present in the array AT THE TIME they run, so a pre-connection
  // event is structurally undeliverable to a not-yet-open connection, not
  // merely "unlikely to arrive in time" — then asserts the very FIRST frame
  // the fresh connection actually receives is a distinct, later, sentinel
  // event, and that neither pre-connection event's id ever appears at all.
  it('never replays historical context transitions to a fresh subscriber — the first frame a new connection sees is a genuinely new event, and no pre-connection event id ever appears', async () => {
    const stale1 = appendContextLabels(storage, contextId, ['untrusted_content'], { sourceEventId: null, toolName: 'stale-a', reason: 'before connect 1' });
    publish(stale1.event!); // published with zero subscribers registered yet — cannot be delivered to anyone.
    const stale2 = appendContextLabels(storage, contextId, ['sensitive_data_accessed'], { sourceEventId: null, toolName: 'stale-b', reason: 'before connect 2' });
    publish(stale2.event!);

    const framesPromise = readFrames(baseUrl, LOCAL_AUTH_TOKEN, 1);
    await new Promise((r) => setTimeout(r, 200)); // let this fresh connection's handler actually register
    const fresh = appendContextLabels(storage, contextId, ['prompt_injection_suspected'], { sourceEventId: null, toolName: 'fresh', reason: 'after connect' });
    publish(fresh.event!);

    const frames = await framesPromise;
    expect(frames).toHaveLength(1);
    const firstPayload = frames[0].data as ContextEvent;
    expect(firstPayload.id).toBe(fresh.event!.id);
    const allIds = frames.map((f) => (f.data as ContextEvent).id);
    expect(allIds).not.toContain(stale1.event!.id);
    expect(allIds).not.toContain(stale2.event!.id);
  });

  it('never publishes the same event object twice (no duplicate publication from both pipeline and API layers)', async () => {
    const framesPromise = readFrames(baseUrl, LOCAL_AUTH_TOKEN, 1, 2000);
    await new Promise((r) => setTimeout(r, 200));
    const result = appendContextLabels(storage, contextId, ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' });
    publish(result.event!); // exactly once — the only real call site (pipeline.ts) publishes once per transition.

    const frames = await framesPromise;
    const matching = frames.filter((f) => f.event === 'context_event' && (f.data as ContextEvent).id === result.event!.id);
    expect(matching).toHaveLength(1);
  });

  it('requires the auth token as a query parameter, exactly like the existing audit_event stream', async () => {
    const res = await fetch(baseUrl); // no token
    expect(res.status).toBe(401);
  });
});
