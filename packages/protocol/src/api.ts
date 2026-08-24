/**
 * AgentGate Control API Contracts
 *
 * REST and SSE endpoint request/response types for the local control API.
 * The control API binds to loopback only and requires a per-launch auth token.
 */

import type { AuditEvent, Approval, AgentIdentity } from './events.js';

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

// ─── Health ───────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  uptime_seconds: number;
  gateway_port: number;
  control_port: number;
  db_path: string;
  active_agents: number;
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export type AgentConnectionState = 'connected' | 'disconnected' | 'idle';

export interface AgentSummary {
  session_id: string;
  identity: AgentIdentity;
  state: AgentConnectionState;
  connected_at: string;
  last_activity_at: string | null;
  allowed_count: number;
  denied_count: number;
  pending_count: number;
  /** Whether the adapter supports pause. Display only if true. */
  supports_pause: boolean;
  /** Whether the adapter supports terminate. Display only if true. */
  supports_terminate: boolean;
}

// ─── Events ───────────────────────────────────────────────────────────────────

export interface EventsQuery {
  limit?: number;
  offset?: number;
  agent_session_id?: string;
  status?: string;
  tool?: string;
  since?: string; // ISO 8601
}

// ─── Approvals ────────────────────────────────────────────────────────────────

export interface ApproveRequest {
  /** Must include the event_id from the approval to prevent confused deputy. */
  event_id: string;
}

export interface ApproveResponse {
  approval_id: string;
  status: 'APPROVED';
  message: string;
}

export interface DenyResponse {
  approval_id: string;
  status: 'DENIED';
  message: string;
}

// ─── Safe Replay (ADR-0010) ─────────────────────────────────────────────────
//
// Replay is policy re-evaluation only. There is no execution mode and no
// dry_run/execute toggle of any kind — `executed` below is the TypeScript
// literal type `false`, not `boolean`, so a future change that tried to widen
// it would fail to type-check every consumer, not just silently pass through
// an execution request. See ADR-0010 in docs/AI_DECISIONS.md.

/**
 * Empty on the wire today. `contract_version` exists so a future breaking
 * change to the request shape can be introduced without an ambiguous empty
 * body meaning two different things. The server rejects any other field
 * (e.g. `dry_run`, `execute`) rather than silently ignoring it.
 */
export interface ReplayEvaluationRequest {
  contract_version?: 1;
}

export interface ReplayDecisionSummary {
  decision_type: string | null;
  matched_rule_id: string | null;
  reason_code: string | null;
}

export interface ReplayCurrentDecisionSummary extends ReplayDecisionSummary {
  decision_type: string;
  reason_code: string;
  explanation: string;
  transformations: string[];
}

export interface ReplayEvaluationResponse {
  replay_id: string;
  source_event_id: string;
  evaluated_at: string;
  /** Always 'policy_only' — see ADR-0010. There is no other mode. */
  mode: 'policy_only';
  /** Always the literal false. Replay never executes a tool call. */
  executed: false;
  /** True if the source event's arguments were redacted before persistence — see `limitations`. */
  source_arguments_redacted: boolean;
  /** Safe digest of the policy used for this evaluation — never raw policy file bytes. */
  policy_digest: string;
  original: ReplayDecisionSummary;
  current: ReplayCurrentDecisionSummary;
  decision_changed: boolean;
  matched_rule_changed: boolean;
  reason_code_changed: boolean;
  /** Short, safe, human-readable summary — e.g. "Policy decision unchanged." Never implies tool re-execution. */
  comparison: string;
  /** Always populated when relevant (e.g. redacted arguments, missing original decision). Never empty by omission. */
  limitations: string[];
}

/** One row of `GET /api/events/:id/replays` — same shape as a single evaluation response, minus nothing. */
export type ReplayEvaluationSummary = ReplayEvaluationResponse;

// ─── SSE Push Events ─────────────────────────────────────────────────────────

export type SsePushEventType =
  | 'audit_event'
  | 'agent_connected'
  | 'agent_disconnected'
  | 'approval_created'
  | 'approval_resolved'
  | 'approval_expired';

export interface SsePushEvent {
  type: SsePushEventType;
  payload: AuditEvent | AgentSummary | Approval;
  timestamp: string;
}

// ─── Overview Stats ──────────────────────────────────────────────────────────

export interface OverviewStats {
  active_agents: number;
  allowed_24h: number;
  denied_24h: number;
  pending_approvals: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  recent_high_risk: AuditEvent[];
}
