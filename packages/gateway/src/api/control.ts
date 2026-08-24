import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuditStorage } from '../storage.js';
import type { ApprovalManager } from '../approval.js';
import type { AuditEvent, Approval, ReplayEvaluation } from '@agentgate/protocol';
import cors from '@fastify/cors';
import { loadPolicyFile, sanitizeErrorMessage } from '@agentgate/policy';
import { evaluateHistoricalEvent, ReplayUnsupportedEventError } from '../replay.js';

/** Per-launch local auth token — generated fresh on each start. */
export let LOCAL_AUTH_TOKEN = '';

/** Allowed localhost hostnames. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Maps a stored, hash-chained ReplayEvaluation to the wire response shape (ADR-0010). */
function toReplayResponse(r: ReplayEvaluation) {
  return {
    replay_id: r.id,
    source_event_id: r.source_event_id,
    evaluated_at: r.evaluated_at,
    mode: 'policy_only' as const,
    executed: false as const,
    source_arguments_redacted: r.source_arguments_redacted,
    policy_digest: r.policy_digest,
    original: {
      decision_type: r.original_decision_type,
      matched_rule_id: r.original_rule_id,
      reason_code: r.original_reason_code,
    },
    current: {
      decision_type: r.current_decision_type,
      matched_rule_id: r.current_rule_id,
      reason_code: r.current_reason_code,
      explanation: r.current_explanation,
      transformations: r.current_transformations,
    },
    decision_changed: r.decision_changed,
    matched_rule_changed: r.matched_rule_changed,
    reason_code_changed: r.reason_code_changed,
    comparison: r.decision_changed
      ? `Policy decision changed from ${r.original_decision_type ?? 'unknown'} to ${r.current_decision_type}.`
      : 'Policy decision unchanged.',
    limitations: r.limitations,
  };
}

export function buildControlApi(opts: {
  storage: AuditStorage;
  approvalManager: ApprovalManager;
  version: string;
  gatewayPort: number;
  dbPath: string;
  /** Path to the policy file to load fresh on every Safe Replay evaluation (ADR-0010). */
  policyPath: string;
  onEvent: (handler: (event: AuditEvent | Approval) => void) => void;
}) {
  LOCAL_AUTH_TOKEN = randomBytes(32).toString('hex');

  // ADR-0010: in-flight de-duplication for Safe Replay, keyed by source event
  // id — a rapid double-click/double-submit coalesces into the single
  // in-flight evaluation rather than creating two near-simultaneous replay
  // records. This is deliberately narrow (not general rate limiting).
  const inFlightReplays = new Map<string, Promise<ReplayEvaluation>>();

  const app = Fastify({ logger: false });

  app.register(cors, {
    origin: ['http://127.0.0.1:5173', 'http://localhost:5173'], // Vite dev server
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'x-agentgate-token'],
  });

  // ── Security Middleware ────────────────────────────────────────────────────

  // 1. Loopback-only binding is enforced in server.ts listen() call.
  // 2. Host/Origin header validation.
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers['host'] ?? '').split(':')[0];
    if (!LOOPBACK_HOSTS.has(host)) {
      reply.code(403).send({ error: 'Forbidden: invalid Host header.' });
      return;
    }

    const origin = request.headers['origin'];
    if (origin) {
      try {
        const originHost = new URL(origin).hostname;
        if (!LOOPBACK_HOSTS.has(originHost)) {
          reply.code(403).send({ error: 'Forbidden: invalid Origin header.' });
          return;
        }
      } catch {
        reply.code(403).send({ error: 'Forbidden: malformed Origin header.' });
        return;
      }
    }
    
    reply.header('Referrer-Policy', 'no-referrer');

    // 3. Auth token check (skip for SSE stream — token passed as query param).
    const path = request.url.split('?')[0];
    if (path === '/api/events/stream') {
      const token = (request.query as Record<string, string>)['token'];
      if (token !== LOCAL_AUTH_TOKEN) {
        reply.code(401).send({ error: 'Unauthorized.' });
        return;
      }
      return;
    }

    const token = request.headers['x-agentgate-token'];
    if (token !== LOCAL_AUTH_TOKEN) {
      reply.code(401).send({ error: 'Unauthorized.' });
    }
  });

  // ── Health ─────────────────────────────────────────────────────────────────

  app.get('/api/health', async () => ({
    status: 'ok',
    version: opts.version,
    uptime_seconds: Math.floor(process.uptime()),
    gateway_port: opts.gatewayPort,
    db_path: opts.dbPath,
  }));

  // ── Events ─────────────────────────────────────────────────────────────────

  app.get('/api/events', async (request) => {
    const q = request.query as Record<string, string>;
    return opts.storage.listEvents({
      limit: q.limit ? parseInt(q.limit) : 50,
      offset: q.offset ? parseInt(q.offset) : 0,
      status: q.status,
      tool: q.tool,
    });
  });

  app.get<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
    const event = opts.storage.getEvent(request.params.id);
    if (!event) reply.code(404).send({ error: 'Event not found.' });
    return event;
  });

  // ── SSE Live Stream ────────────────────────────────────────────────────────

  app.get('/api/events/stream', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (type: string, data: unknown) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const handler = (payload: AuditEvent | Approval) => {
      send('audit_event', payload);
    };

    opts.onEvent(handler);

    // Heartbeat
    const heartbeat = setInterval(() => {
      reply.raw.write(': heartbeat\n\n');
    }, 15_000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
    });

    // Keep the connection alive
    await new Promise<void>((resolve) => request.raw.on('close', resolve));
  });

  // ── Approvals ──────────────────────────────────────────────────────────────

  app.get('/api/approvals', async () => opts.approvalManager.listPending());

  app.post<{ Params: { id: string }; Body: { event_id: string } }>(
    '/api/approvals/:id/approve',
    async (request, reply) => {
      // Confused-deputy prevention: verify event_id matches the approval.
      const approval = opts.storage.getApproval(request.params.id);
      if (!approval) return reply.code(404).send({ error: 'Approval not found.' });
      if (request.body.event_id !== approval.event_id) {
        return reply.code(400).send({ error: 'event_id does not match this approval.' });
      }

      const result = opts.approvalManager.approve(request.params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      return { approval_id: request.params.id, status: 'APPROVED' };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/api/approvals/:id/deny',
    async (request, reply) => {
      const result = opts.approvalManager.deny(request.params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      return { approval_id: request.params.id, status: 'DENIED' };
    }
  );

  // ── Safe Replay (ADR-0010) ──────────────────────────────────────────────
  // Policy re-evaluation only. Never contacts a downstream server, never
  // creates an approval, never mutates the source event.

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/events/:id/replay',
    async (request, reply) => {
      const eventId = request.params.id;
      const body = request.body;

      // Reject any execution-like or unknown field rather than silently
      // ignoring it — "dry_run: false", "execute: true", etc. must never be
      // quietly accepted (ADR-0010).
      if (body !== undefined && body !== null) {
        if (typeof body !== 'object' || Array.isArray(body)) {
          return reply.code(400).send({ error: 'Replay request body must be a JSON object or empty.' });
        }
        const bodyRecord = body as Record<string, unknown>;
        const unexpected = Object.keys(bodyRecord).filter((k) => k !== 'contract_version');
        if (unexpected.length > 0) {
          return reply.code(400).send({
            error: `Replay request body contains unsupported field(s): ${unexpected.join(', ')}. Safe Replay is policy re-evaluation only and accepts no execution-related fields.`,
          });
        }
        if (bodyRecord.contract_version !== undefined && bodyRecord.contract_version !== 1) {
          return reply.code(400).send({ error: 'Unsupported contract_version.' });
        }
      }

      const sourceEvent = opts.storage.getEvent(eventId);
      if (!sourceEvent) return reply.code(404).send({ error: 'Event not found.' });

      // Coalesce a rapid double-submit for the same event into one in-flight
      // evaluation instead of creating two near-simultaneous replay records.
      let pending = inFlightReplays.get(eventId);
      if (!pending) {
        pending = (async () => {
          const currentPolicy = loadPolicyFile(opts.policyPath);
          const comparison = evaluateHistoricalEvent({ sourceEvent, currentPolicy });
          return opts.storage.insertReplayEvaluation({
            source_event_id: eventId,
            evaluated_at: comparison.evaluated_at,
            policy_digest: comparison.policy_digest,
            original_decision_type: comparison.original.decision_type,
            original_rule_id: comparison.original.matched_rule_id,
            original_reason_code: comparison.original.reason_code,
            current_decision_type: comparison.current.decision_type,
            current_rule_id: comparison.current.matched_rule_id,
            current_reason_code: comparison.current.reason_code,
            current_explanation: comparison.current.explanation,
            current_transformations: comparison.current.transformations,
            decision_changed: comparison.decision_changed,
            matched_rule_changed: comparison.matched_rule_changed,
            reason_code_changed: comparison.reason_code_changed,
            source_arguments_redacted: comparison.source_arguments_redacted,
            limitations: comparison.limitations,
          });
        })();
        inFlightReplays.set(eventId, pending);
        void pending.finally(() => inFlightReplays.delete(eventId));
      }

      try {
        const stored = await pending;
        return toReplayResponse(stored);
      } catch (err) {
        if (err instanceof ReplayUnsupportedEventError) {
          return reply.code(409).send({ error: err.message });
        }
        // Covers a missing/malformed current policy file (fail closed, never
        // a silent default) and any other unexpected internal error.
        const sanitized = sanitizeErrorMessage(err, { source: 'internal' });
        return reply.code(500).send({ error: sanitized.message });
      }
    }
  );

  app.get<{ Params: { id: string } }>('/api/events/:id/replays', async (request, reply) => {
    const sourceEvent = opts.storage.getEvent(request.params.id);
    if (!sourceEvent) return reply.code(404).send({ error: 'Event not found.' });
    return opts.storage.listReplayEvaluationsForEvent(request.params.id).map(toReplayResponse);
  });

  app.get<{ Params: { replayId: string } }>('/api/replays/:replayId', async (request, reply) => {
    const row = opts.storage.getReplayEvaluation(request.params.replayId);
    if (!row) return reply.code(404).send({ error: 'Replay evaluation not found.' });
    return toReplayResponse(row);
  });

  return app;
}
