/**
 * Gateway API client — connects to the local AgentGate control API.
 *
 * Auth token is read from the VITE_AGENTGATE_TOKEN env variable
 * (injected at launch time) or from localStorage as a fallback for dev.
 */

import type { ReplayEvaluationResponse, ReplayEvaluationSummary } from '@agentgate/protocol';

const BASE_URL = import.meta.env.VITE_CONTROL_URL ?? 'http://127.0.0.1:4001';
const TOKEN = import.meta.env.VITE_AGENTGATE_TOKEN ?? localStorage.getItem('agentgate_token') ?? '';

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-agentgate-token': TOKEN,
  };
}

/**
 * Thrown by every helper below on a non-2xx response. Carries the HTTP
 * status alongside the existing safe message so a caller can distinguish
 * "this API surface isn't configured" (404 — e.g. Context Guard disabled)
 * from "this request is stale/invalid" (409) from a generic failure,
 * without parsing message text. `message` keeps the exact same shape
 * every existing catch-and-display call site already expects.
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
  if (!res.ok) throw new ApiError(`GET ${path} → ${res.status}`, res.status);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new ApiError(`POST ${path} → ${res.status}`, res.status);
  return res.json();
}

/**
 * Like `post()`, but surfaces the server's own safe, human-readable `error`
 * message (e.g. "Event not found.", a sanitized policy-load failure) instead
 * of a bare status code — used by Safe Replay so the UI can show *why* a
 * replay could not be evaluated rather than only that it failed (ADR-0010).
 * The server never includes raw arguments or secrets in these messages.
 */
async function postForResult<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `POST ${path} → ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export const api = {
  health: () => get<{ status: string; uptime_seconds: number; active_agents: number }>('/api/health'),
  events: (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return get<unknown[]>(`/api/events${qs}`);
  },
  event: (id: string) => get<unknown>(`/api/events/${id}`),
  approvals: () => get<unknown[]>('/api/approvals'),
  approve: (id: string, eventId: string) => post(`/api/approvals/${id}/approve`, { event_id: eventId }),
  deny: (id: string) => post(`/api/approvals/${id}/deny`),
  /**
   * Safe Replay (ADR-0010): re-evaluates a historical event's stored,
   * already-redacted request against the *current* policy. Never executes
   * the tool, never contacts a downstream server, never creates or resolves
   * an approval. There is no execution-mode parameter — this function takes
   * no arguments beyond the event id, by design.
   */
  replay: (eventId: string) => postForResult<ReplayEvaluationResponse>(`/api/events/${eventId}/replay`),
  replays: (eventId: string) => get<ReplayEvaluationSummary[]>(`/api/events/${eventId}/replays`),

  // ── Tool Integrity Registry (ADR-0012) ──────────────────────────────────
  // Rug-pull / tool-definition-poisoning defense. Every mutation call
  // requires BOTH the exact candidate id AND its exact fingerprint — there
  // is no "trust all" call in this client, by design.
  toolIntegritySummary: () => get<ToolIntegritySummary>('/api/tool-integrity/summary'),
  toolIntegrityTools: () => get<{ server_identity: string; mode: string; tools: ToolIntegrityToolSummary[] }>('/api/tool-integrity/tools'),
  toolIntegrityHistory: (toolName?: string) =>
    get<{ server_identity: string; chain_valid: boolean; chain_error?: string; events: ToolIntegrityEventWire[] }>(
      `/api/tool-integrity/history${toolName ? `?tool=${encodeURIComponent(toolName)}` : ''}`
    ),
  toolIntegrityDiff: (candidateId: string) => get<ToolIntegrityDiffResponse>(`/api/tool-integrity/tools/${encodeURIComponent(candidateId)}/diff`),
  toolIntegrityRescan: () =>
    postForResult<{ server_identity: string; tool_outcomes: Array<{ toolName: string; status: string; changed: boolean }>; removed_tool_names: string[] }>(
      '/api/tool-integrity/rescan'
    ),
  toolIntegrityAccept: (candidateId: string, fingerprint: string) =>
    postForResult<{ ok: true; tool_name: string; status: string }>(`/api/tool-integrity/tools/${encodeURIComponent(candidateId)}/accept`, { fingerprint }),
  toolIntegrityReject: (candidateId: string, fingerprint: string, reason?: string) =>
    postForResult<{ ok: true; tool_name: string; status: string }>(`/api/tool-integrity/tools/${encodeURIComponent(candidateId)}/reject`, {
      fingerprint,
      ...(reason ? { reason } : {}),
    }),

  // ── Context Guard (ADR-0013) ────────────────────────────────────────────
  // Cross-tool session-risk escalation defense. Every route here is
  // read-only except contextReset — see its own doc comment below. All
  // routes 404 when context_guard is not configured on the gateway; the
  // page must treat that as "unavailable," never as a generic error.
  contexts: (params?: { state?: ContextStatus; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.state) qs.set('state', params.state);
    if (params?.limit) qs.set('limit', String(params.limit));
    const s = qs.toString();
    return get<ContextStatusReport>(`/api/contexts${s ? `?${s}` : ''}`);
  },
  context: (contextId: string) => get<ContextSummary>(`/api/contexts/${encodeURIComponent(contextId)}`),
  contextHistory: (contextId: string, limit?: number) =>
    get<ContextHistoryReport>(`/api/contexts/${encodeURIComponent(contextId)}/history${limit ? `?limit=${limit}` : ''}`),
  contextExplain: (contextId: string) => get<ContextExplainReport>(`/api/contexts/${encodeURIComponent(contextId)}/explain`),
  /**
   * The ONLY mutating Context Guard call in this client. Requires the EXACT
   * current revision (server rejects a stale one with 409) and a non-empty
   * reason — there is no reset-all, remove-label, mark-safe, or force call
   * anywhere in this client, by design (ADR-0013).
   */
  contextReset: (contextId: string, revision: number, reason: string) =>
    postForResult<ContextResetReport>(`/api/contexts/${encodeURIComponent(contextId)}/reset`, { revision, reason }),
  contextIntegrity: () => get<ContextVerifyReport>('/api/context-integrity'),
};

// ── Context Guard wire types (ADR-0013) — mirror packages/gateway/src/
// context-guard/{types,cli}.ts's actual, validated response shapes exactly.
// Never widened to `unknown`/`Record<string, unknown>` here: Context Guard
// state is bounded, policy-owned data (label names, rule ids, safe reason
// strings) precisely because the gateway never stores anything else in it.

export type ContextStatus = 'active' | 'expired' | 'reset' | 'closed';

export interface ContextSummary {
  context_id: string;
  status: ContextStatus;
  revision: number;
  labels: string[];
  server_identity: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  pending_approval_count: number;
}

export interface ContextStatusReport {
  contexts: ContextSummary[];
  total: number;
  /** True if more contexts exist than were returned — never an unbounded dump. */
  truncated: boolean;
}

export type ContextEventType =
  | 'context_created'
  | 'label_added'
  | 'call_evaluated'
  | 'context_reset'
  | 'context_expired'
  | 'context_closed';

/** One append-only Context Guard transition. Never carries raw tool arguments/results — only label names, rule ids, and safe bounded reason strings (see ADR-0013 point 11). */
export interface ContextEventWire {
  id: string;
  sequence_number: number;
  previous_event_hash: string | null;
  event_hash: string;
  canonical_payload_version: string;
  created_at: string;
  event_type: ContextEventType;
  context_id: string;
  revision_before: number | null;
  revision_after: number | null;
  labels_added: string[] | null;
  source_event_id: string | null;
  tool_name: string | null;
  rule_id: string | null;
  action: string | null;
  reviewer: string | null;
  reason: string | null;
}

export interface ContextHistoryReport {
  /** null only when listing across every context — this client never calls the (id-less) form; kept for shape fidelity with the shared report type. */
  context_id: string | null;
  events: ContextEventWire[];
  chain_valid: boolean;
  chain_error?: string;
  truncated: boolean;
}

export interface LabelOrigin {
  label: string;
  source_event_id: string | null;
  tool_name: string | null;
  reason: string | null;
  at: string;
}

export interface LatestDecision {
  tool_name: string;
  rule_id: string | null;
  action: string;
  reason: string | null;
  at: string;
}

export interface ContextExplainReport {
  ok: boolean;
  error?: string;
  context_id?: string;
  status?: ContextStatus;
  revision?: number;
  labels?: string[];
  label_origins?: LabelOrigin[];
  /** null (never omitted, never fabricated) when no contextual decision was ever recorded for this context. */
  latest_decision?: LatestDecision | null;
  lifecycle_note: string;
}

export interface ContextResetReport {
  ok: boolean;
  error?: string;
  context_id?: string;
  new_revision?: number;
  status?: ContextStatus;
  invalidated_approval_count?: number;
}

export interface ContextVerifyReport {
  valid: boolean;
  count: number;
  error?: string;
  limitation: string;
}

export interface ToolIntegritySummary {
  server_identity: string;
  server_id: string;
  mode: 'explicit' | 'tofu' | 'monitor' | 'disabled';
  enforcing: boolean;
  last_scan_at: string | null;
  counts: Record<string, number>;
  total: number;
}

export interface ToolIntegrityToolSummary {
  tool_name: string;
  status: 'pending_review' | 'trusted' | 'drifted' | 'rejected' | 'removed';
  current_fingerprint: string | null;
  trusted_fingerprint: string | null;
  candidate_fingerprint: string | null;
  candidate_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_scan_at: string;
  updated_at: string;
}

export interface ToolIntegrityEventWire {
  id: string;
  sequence_number: number;
  created_at: string;
  event_type: string;
  server_identity: string;
  tool_name: string | null;
  fingerprint: string | null;
  state_before: string | null;
  state_after: string | null;
  reviewer: string | null;
  reason: string | null;
}

export interface ToolIntegrityDiffChange {
  path: string;
  kind: 'field_added' | 'field_removed' | 'value_changed' | 'type_changed' | 'array_length_changed';
  before?: string;
  after?: string;
}

export interface ToolIntegrityDiffResponse {
  tool_name: string;
  status: string;
  trusted_fingerprint: string | null;
  candidate_fingerprint: string | null;
  candidate_id: string | null;
  changes: ToolIntegrityDiffChange[];
  truncated: boolean;
}

/**
 * Opens an SSE connection to the event stream.
 *
 * The gateway multiplexes `audit_event` and (Milestone 7, ADR-0013)
 * `context_event` frames on this SAME stream — see api/control.ts's single
 * SSE handler. `onContextEvent` is optional and additive: existing callers
 * that only pass `onEvent`/`onError` (e.g. Timeline) are unaffected and
 * simply never receive `context_event` frames, exactly as before this
 * milestone. There is no historical replay on a fresh connection — a
 * subscriber only ever receives events published AFTER it connects (see
 * server.ts's subscriber-list publish path); callers that need existing
 * state must fetch it once via the REST API before/alongside opening this
 * stream, and must tolerate a duplicate/out-of-order frame arriving after
 * that fetch (reconciled by event id / revision, never by blind append).
 */
export function openEventStream(
  onEvent: (data: unknown) => void,
  onError?: () => void,
  onContextEvent?: (data: ContextEventWire) => void
): EventSource {
  const url = `${BASE_URL}/api/events/stream?token=${encodeURIComponent(TOKEN)}`;
  const es = new EventSource(url);
  es.addEventListener('audit_event', (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      // Ignore malformed SSE payloads — the stream will emit the next event.
    }
  });
  if (onContextEvent) {
    es.addEventListener('context_event', (e) => {
      try {
        onContextEvent(JSON.parse(e.data) as ContextEventWire);
      } catch {
        // Ignore malformed SSE payloads — the stream will emit the next event.
      }
    });
  }
  es.onerror = () => onError?.();
  return es;
}
