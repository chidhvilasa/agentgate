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

// ─── Replay ───────────────────────────────────────────────────────────────────

export interface ReplayRequest {
  event_id: string;
  /** Always dry-run by default. Must explicitly set to false to execute. */
  dry_run?: boolean;
}

export interface ReplayResponse {
  event_id: string;
  dry_run: boolean;
  would_decision: string;
  explanation: string;
}

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
