import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import type { AuditStorage } from '../storage.js';
import type { ApprovalManager } from '../approval.js';
import type { AuditEvent, Approval, ReplayEvaluation } from '@agentgate/protocol';
import cors from '@fastify/cors';
import { loadPolicyFile, sanitizeErrorMessage } from '@agentgate/policy';
import { evaluateHistoricalEvent, ReplayUnsupportedEventError } from '../replay.js';
import type { DownstreamServer, ToolIntegrityMode } from '../config/registry.js';
import { computeServerIdentity } from '../tool-integrity/identity.js';
import { scanDownstreamServer } from '../tool-integrity/scan.js';
import { applyScanToRegistry, acceptCandidate, rejectCandidate } from '../tool-integrity/registry.js';
import { diffStoredDefinitions } from '../tool-integrity/diff.js';
import type { ToolIntegrityState } from '../tool-integrity/types.js';

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

/** Safe, bounded projection of ToolIntegrityState for the wire — never includes raw definition JSON in list responses (only the dedicated diff endpoint returns field-level content, and even that only a bounded diff, never the full raw definition). */
function toToolStateSummary(s: ToolIntegrityState) {
  return {
    tool_name: s.tool_name,
    status: s.status,
    current_fingerprint: s.current_fingerprint,
    trusted_fingerprint: s.trusted_fingerprint,
    candidate_fingerprint: s.candidate_fingerprint,
    candidate_id: s.candidate_id,
    first_seen_at: s.first_seen_at,
    last_seen_at: s.last_seen_at,
    last_scan_at: s.last_scan_at,
    updated_at: s.updated_at,
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
  /** Tool Integrity Registry (ADR-0012) — the downstream server config and configured mode, used for on-demand rescans. Optional only so existing tests that don't exercise Tool Integrity need not construct one; server.ts always supplies it in real operation. */
  toolIntegrity?: {
    server: DownstreamServer;
    mode: ToolIntegrityMode;
  };
}) {
  LOCAL_AUTH_TOKEN = randomBytes(32).toString('hex');

  // ADR-0010: in-flight de-duplication for Safe Replay, keyed by source event
  // id — a rapid double-click/double-submit coalesces into the single
  // in-flight evaluation rather than creating two near-simultaneous replay
  // records. This is deliberately narrow (not general rate limiting).
  const inFlightReplays = new Map<string, Promise<ReplayEvaluation>>();

  const app = Fastify({ logger: false });

  // Fastify's built-in JSON body parser rejects a genuinely empty body sent
  // with `Content-Type: application/json` (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which is exactly what a real browser fetch() with no body payload but a
  // default JSON Content-Type header sends — the frontend's post() helper
  // always sets this header. Several routes (deny, and now Safe Replay
  // below) document an empty body as valid; this override treats an empty
  // body as `{}` instead of a 400, without weakening JSON parsing for a
  // non-empty, malformed body (which still throws normally).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      const parseError = err as Error & { statusCode?: number };
      parseError.statusCode = 400; // malformed client input, not a server fault
      done(parseError, undefined);
    }
  });

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
          let currentPolicy;
          try {
            currentPolicy = loadPolicyFile(opts.policyPath);
          } catch (err) {
            // loadPolicyFile()'s own error message embeds the raw local file
            // path by design (useful for local CLI/log debugging, where it
            // never leaves the machine). This is the one call site where that
            // message would otherwise cross an HTTP response boundary to
            // anyone holding the Control API token — log the real error
            // locally (stderr, never sent over the network) and raise a
            // generic, path-free error for the response instead.
            console.error('[agentgate] Replay could not load the current policy:', err);
            throw new Error('Could not load the current policy file — it is missing or invalid. Check the gateway logs for details.');
          }
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
        // `.finally()` returns a NEW promise that also rejects if `pending`
        // does — the caller below already awaits/catches `pending` itself,
        // but this derived cleanup chain needs its own rejection handling
        // too, or Node reports it as a separate unhandled rejection. Using
        // .then(onFulfilled, onRejected) with a no-op onRejected (rather
        // than a further .catch()) means the resulting promise never
        // itself rejects, so nothing further needs to be caught.
        const cleanup = () => inFlightReplays.delete(eventId);
        void pending.then(cleanup, cleanup);
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

  // ── Tool Integrity Registry (ADR-0012) ──────────────────────────────────
  // Rug-pull / tool-definition-poisoning defense. See docs/AI_DECISIONS.md
  // (ADR-0012) and docs/THREAT_MODEL.md for the full model. Every mutation
  // route below requires BOTH the exact candidate id AND its exact
  // fingerprint — never a name-only shortcut, and there is no "accept all"
  // endpoint. Rescan never calls a tool (see scan.ts).

  if (opts.toolIntegrity) {
    const ti = opts.toolIntegrity;
    const serverIdentityInfo = computeServerIdentity(ti.server);
    const serverIdentity = serverIdentityInfo.identity;

    app.get('/api/tool-integrity/summary', async () => {
      const tools = opts.storage.listToolIntegrityState(serverIdentity);
      const counts: Record<string, number> = { pending_review: 0, trusted: 0, drifted: 0, rejected: 0, removed: 0 };
      let lastScanAt: string | null = null;
      for (const t of tools) {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
        if (!lastScanAt || t.last_scan_at > lastScanAt) lastScanAt = t.last_scan_at;
      }
      return {
        server_identity: serverIdentity,
        server_id: serverIdentityInfo.serverId,
        mode: ti.mode,
        enforcing: ti.mode === 'explicit' || ti.mode === 'tofu',
        last_scan_at: lastScanAt,
        counts,
        total: tools.length,
      };
    });

    app.get('/api/tool-integrity/tools', async () => ({
      server_identity: serverIdentity,
      mode: ti.mode,
      tools: opts.storage.listToolIntegrityState(serverIdentity).map(toToolStateSummary),
    }));

    app.get('/api/tool-integrity/history', async (request) => {
      const q = request.query as Record<string, string>;
      const events = opts.storage.listToolIntegrityEvents({ serverIdentity, toolName: q.tool });
      const chain = opts.storage.verifyToolIntegrityChain();
      return { server_identity: serverIdentity, chain_valid: chain.valid, chain_error: chain.error, events };
    });

    app.get<{ Params: { candidateId: string } }>('/api/tool-integrity/tools/:candidateId/diff', async (request, reply) => {
      const match = opts.storage.listToolIntegrityState(serverIdentity).find((s) => s.candidate_id === request.params.candidateId);
      if (!match) return reply.code(404).send({ error: 'No pending candidate with that id was found.' });
      if (!match.candidate_definition_json) return reply.code(409).send({ error: 'Candidate has no stored candidate definition.' });
      const diff = diffStoredDefinitions(match.trusted_definition_json ?? '{}', match.candidate_definition_json);
      if (!diff.ok) return reply.code(500).send({ error: diff.error ?? 'Could not compute diff.' });
      return {
        tool_name: match.tool_name,
        status: match.status,
        trusted_fingerprint: match.trusted_fingerprint,
        candidate_fingerprint: match.candidate_fingerprint,
        candidate_id: match.candidate_id,
        changes: diff.changes,
        truncated: diff.truncated,
      };
    });

    // Rescan — the mandatory "safe lifecycle point" for on-demand
    // re-verification without restarting the gateway (see ADR-0012 on
    // rescan timing; there is no notifications/tools/list_changed
    // dependency). Never calls a tool.
    app.post('/api/tool-integrity/rescan', async (_request, reply) => {
      try {
        const scanResult = await scanDownstreamServer(ti.server);
        const applyResult = applyScanToRegistry(opts.storage, serverIdentity, serverIdentityInfo.serverId, scanResult.manifest, ti.mode);
        if (!applyResult.ok) {
          return reply.code(502).send({ error: applyResult.error ?? 'Scan failed.' });
        }
        return {
          server_identity: serverIdentity,
          tool_outcomes: applyResult.toolOutcomes,
          removed_tool_names: applyResult.removedToolNames,
        };
      } catch (err) {
        const sanitized = sanitizeErrorMessage(err, { source: 'internal' });
        return reply.code(500).send({ error: sanitized.message });
      }
    });

    /** Strictly validates a review request body: exactly `{ fingerprint: string, reason?: string }`, rejecting any unknown or execution-like field rather than silently ignoring it (mirrors the Safe Replay body-validation pattern above). */
    function parseReviewBody(body: unknown): { ok: true; fingerprint: string; reason?: string } | { ok: false; error: string } {
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { ok: false, error: 'Request body must be a JSON object.' };
      }
      const rec = body as Record<string, unknown>;
      const allowed = new Set(['fingerprint', 'reason']);
      const unexpected = Object.keys(rec).filter((k) => !allowed.has(k));
      if (unexpected.length > 0) {
        return { ok: false, error: `Request body contains unsupported field(s): ${unexpected.join(', ')}.` };
      }
      if (typeof rec.fingerprint !== 'string' || rec.fingerprint.length === 0) {
        return { ok: false, error: 'Request body must include a non-empty string "fingerprint".' };
      }
      if (rec.reason !== undefined && typeof rec.reason !== 'string') {
        return { ok: false, error: '"reason" must be a string if present.' };
      }
      // Bound reason length defensively — this is operator-authored text, not
      // hostile server content, but an API caller could still send something
      // huge; keep review reasons small and readable.
      if (typeof rec.reason === 'string' && rec.reason.length > 2000) {
        return { ok: false, error: '"reason" is too long (max 2000 characters).' };
      }
      return { ok: true, fingerprint: rec.fingerprint, reason: rec.reason };
    }

    app.post<{ Params: { candidateId: string }; Body: unknown }>(
      '/api/tool-integrity/tools/:candidateId/accept',
      async (request, reply) => {
        const parsed = parseReviewBody(request.body);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        const candidateId = request.params.candidateId;
        const match = opts.storage.listToolIntegrityState(serverIdentity).find((s) => s.candidate_id === candidateId);
        if (!match) return reply.code(404).send({ error: 'No pending candidate with that id was found.' });
        const result = acceptCandidate(opts.storage, serverIdentity, match.tool_name, candidateId, parsed.fingerprint, 'control-api');
        if (!result.ok) return reply.code(409).send({ error: result.error });
        return { ok: true, tool_name: match.tool_name, status: 'trusted' };
      }
    );

    app.post<{ Params: { candidateId: string }; Body: unknown }>(
      '/api/tool-integrity/tools/:candidateId/reject',
      async (request, reply) => {
        const parsed = parseReviewBody(request.body);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
        const candidateId = request.params.candidateId;
        const match = opts.storage.listToolIntegrityState(serverIdentity).find((s) => s.candidate_id === candidateId);
        if (!match) return reply.code(404).send({ error: 'No pending candidate with that id was found.' });
        const result = rejectCandidate(opts.storage, serverIdentity, match.tool_name, candidateId, parsed.fingerprint, 'control-api', parsed.reason ?? null);
        if (!result.ok) return reply.code(409).send({ error: result.error });
        return { ok: true, tool_name: match.tool_name, status: 'rejected' };
      }
    );
  }

  return app;
}
