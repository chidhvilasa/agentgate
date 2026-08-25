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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
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
    throw new Error(message);
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
};

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

/** Opens an SSE connection to the event stream. */
export function openEventStream(
  onEvent: (data: unknown) => void,
  onError?: () => void
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
  es.onerror = () => onError?.();
  return es;
}
