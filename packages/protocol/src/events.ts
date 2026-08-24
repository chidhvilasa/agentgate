/**
 * AgentGate Shared Protocol Contracts
 *
 * These types define the event lifecycle, policy decisions, agent identity,
 * and REST/SSE API contracts shared across the gateway, policy engine,
 * and control center.
 */

// ─── Protocol Version ────────────────────────────────────────────────────────

/** MCP protocol era preserved in every audit event. */
export type McpEra = 'modern-2026-07-28' | 'legacy-2025';

// ─── Agent Identity ───────────────────────────────────────────────────────────

/**
 * Identity information for an agent session.
 *
 * SECURITY NOTE: self-reported client metadata MUST NOT be used for
 * authorization decisions. It is stored for display only.
 * verified_identity is always false in Milestone 1.
 */
export interface AgentIdentity {
  /** Stable session ID assigned by the gateway (not trusting client claims). */
  session_id: string;
  /** Self-reported: name the MCP client declared during initialize. */
  declared_name: string | null;
  /** Self-reported: version string the MCP client declared. */
  declared_version: string | null;
  /** Transport-derived: process ID for stdio connections, remote addr for HTTP. */
  connection_identity: string;
  /** Always false in Milestone 1 — no cryptographic verification exists. */
  verified_identity: false;
}

// ─── Policy Decisions ─────────────────────────────────────────────────────────

export type PolicyDecisionType =
  | 'ALLOW'
  | 'DENY'
  | 'REQUIRE_APPROVAL'
  | 'ALLOW_WITH_TRANSFORM';

export type ReasonCode =
  | 'POLICY_ALLOW'
  | 'POLICY_DENY'
  | 'POLICY_REQUIRE_APPROVAL'
  | 'POLICY_ALLOW_WITH_TRANSFORM'
  | 'DEFAULT_DENY'           // No rule matched; secure default applied
  | 'SECRET_DETECTED'        // Secret pattern found in arguments
  | 'PATH_TRAVERSAL'         // Path normalization blocked the request
  | 'APPROVAL_EXPIRED'       // Approval TTL elapsed
  | 'APPROVAL_USED'          // Approval already consumed (single-use)
  | 'APPROVAL_DENIED'        // Human explicitly denied
  | 'MALFORMED_REQUEST'      // Could not parse/normalize the tool call
  | 'MALFORMED_POLICY';      // Policy file is invalid; deny-safe fallback

export interface PolicyDecision {
  type: PolicyDecisionType;
  reason_code: ReasonCode;
  /** Human-readable explanation of the decision. */
  explanation: string;
  /** ID of the matched rule, or null when default-deny applied. */
  matched_rule_id: string | null;
  /** For ALLOW_WITH_TRANSFORM: what was changed. */
  transformations_applied?: string[];
}

// ─── Tool Call ────────────────────────────────────────────────────────────────

export interface ToolCall {
  /** Namespaced tool name: server_id.tool_name */
  tool: string;
  /** Raw arguments as received from the agent, before any normalization. */
  raw_arguments: Record<string, unknown>;
  /** Arguments after normalization (paths resolved, etc.). */
  normalized_arguments: Record<string, unknown>;
  /** Protocol era this call arrived on. */
  mcp_era: McpEra;
  /** Original JSON-RPC request id from the MCP client. */
  jsonrpc_id: string | number | null;
}

// ─── Audit Event Lifecycle ────────────────────────────────────────────────────

export type AuditEventStatus =
  | 'RECEIVED'
  | 'NORMALIZED'
  | 'EVALUATED'
  | 'ALLOWED'
  | 'DENIED'
  | 'PENDING_APPROVAL'
  | 'ALLOWED_WITH_TRANSFORM'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

/**
 * A single tamper-evident audit event.
 *
 * TAMPER-EVIDENCE NOTE: The hash chain provides detection of local
 * tampering but does NOT prevent a local administrator from rewriting
 * both the database and the chain. This is "tamper-evident," not
 * "tamper-proof." External anchoring (e.g., append-only log) would
 * be needed for stronger guarantees.
 */
export interface AuditEvent {
  // ── Identity
  id: string;                      // UUID v4
  sequence_number: number;         // Strictly monotonic per-gateway integer
  previous_event_hash: string | null; // SHA-256 of previous canonical payload; null for first event
  event_hash: string;              // SHA-256 of this event's canonical redacted payload
  /**
   * Schema version for this record's hash canonical form. '1' is the
   * Milestone 1/2 payload shape; '2' (ADR-0009, Milestone 3) adds
   * result_redacted/result_blocked/result_finding_count/error_redacted to
   * the hashed payload. verifyChain() dispatches on each record's own
   * stored version, so a chain spanning the v1->v2 boundary still verifies.
   */
  canonical_payload_version: '1' | '2';
  created_at: string;              // ISO 8601 UTC

  // ── Agent
  agent: AgentIdentity;

  // ── Tool Call
  tool_call: ToolCall;

  // ── Decision
  status: AuditEventStatus;
  decision: PolicyDecision | null; // null while RECEIVED/NORMALIZED

  // ── Execution Result (populated only after EXECUTING)
  execution_succeeded: boolean | null;
  /**
   * Sanitized error message (see ADR-0009's sanitizeErrorMessage()) or null.
   * Never the raw downstream/internal error string — see error_redacted.
   */
  execution_error: string | null;
  /** Duration in milliseconds from RECEIVED to final terminal state. */
  duration_ms: number | null;

  // ── Redaction markers
  /** True if any argument values were redacted before persistence. */
  arguments_redacted: boolean;
  /**
   * True if a recognized secret was redacted from the downstream result
   * before it was forwarded to the upstream client (ADR-0009). Raw results
   * are never persisted at all (before or after this milestone), so this
   * does NOT mean "redacted before persistence" — it means "redacted before
   * being returned to the agent that made the call."
   */
  result_redacted: boolean;
  /**
   * True if the entire downstream result was replaced with a safe
   * AgentGate error instead of being forwarded, because output_security.mode
   * is "block" and a secret was detected (or inspection was truncated by a
   * depth/size limit). Mutually exclusive with result_redacted.
   */
  result_blocked: boolean;
  /** Safe count of output-sanitization findings (redacted/blocked/not_inspected). Never the findings' matched content. */
  result_finding_count: number;
  /** True if execution_error's stored value differs from the raw error message because a secret pattern was found and redacted. */
  error_redacted: boolean;
}

// ─── Approval ─────────────────────────────────────────────────────────────────

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export interface Approval {
  id: string;
  event_id: string;
  status: ApprovalStatus;
  /** ISO 8601 UTC timestamp when this approval expires. */
  expires_at: string;
  /** Single-use: true once the approval has been consumed by execution. */
  consumed: boolean;
  /** Normalized, redacted representation of the proposed action for display. */
  proposed_action_display: string;
  /** Reason why approval is required (from policy). */
  policy_reason: string;
  /** Scope of the approval (which tool/resource). */
  scope: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: 'human' | null;
}

// ─── Safe Replay Lineage (ADR-0010) ─────────────────────────────────────────
//
// A replay evaluation is immutable lineage ABOUT a source AuditEvent — never
// a mutation OF it. Replay never executes a tool; see ADR-0010 in
// docs/AI_DECISIONS.md and packages/gateway/src/replay.ts.

/**
 * A single, append-only, hash-chained record of one policy re-evaluation of
 * a historical event against the current policy. Its own sequence/hash chain
 * is independent of the audit event chain (own sequence_number starting at
 * 1) — see AuditStorage.verifyReplayChain(). Never contains raw arguments,
 * raw results, or raw secrets — only decision types, rule IDs, reason codes,
 * a policy digest, and bounded limitation strings.
 */
export interface ReplayEvaluation {
  id: string;
  source_event_id: string;
  sequence_number: number;
  previous_replay_hash: string | null;
  replay_hash: string;
  canonical_payload_version: '1';
  evaluated_at: string;
  /** Safe digest of the policy used for this evaluation — never raw policy file bytes. */
  policy_digest: string;
  original_decision_type: string | null;
  original_rule_id: string | null;
  original_reason_code: string | null;
  current_decision_type: string;
  current_rule_id: string | null;
  current_reason_code: string;
  current_explanation: string;
  current_transformations: string[];
  decision_changed: boolean;
  matched_rule_changed: boolean;
  reason_code_changed: boolean;
  /** True if the source event's arguments were redacted before persistence. */
  source_arguments_redacted: boolean;
  /** Always populated when relevant (e.g. redacted arguments, missing original decision). */
  limitations: string[];
}
