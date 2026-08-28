// Shared types for Context Guard (Milestone 7, ADR-0013).
//
// "Context" here means: a locally-generated, opaque policy-state label
// attached to one AgentGate upstream stdio connection/process instance. It
// is NOT proof that one tool's result caused a later call, NOT a model-
// conversation identifier, and NOT information-flow tracking. See ADR-0013
// for the full, explicit statement of what this does and does not mean.

/** Lifecycle status for one execution context. */
export type ContextStatus = 'active' | 'expired' | 'reset' | 'closed';

/** Every kind of append-only Context Guard event. */
export type ContextEventType =
  | 'context_created'
  | 'label_added'
  | 'call_evaluated'
  | 'context_reset'
  | 'context_expired'
  | 'context_closed';

/** One immutable, hash-chained row in `context_events`. Never mutated or deleted. */
export interface ContextEvent {
  id: string;
  sequence_number: number;
  previous_event_hash: string | null;
  event_hash: string;
  canonical_payload_version: string;
  created_at: string;
  event_type: ContextEventType;
  context_id: string;
  /** Revision immediately before this transition; null for events that don't change revision (e.g. a call_evaluated that added no new labels). */
  revision_before: number | null;
  /** Revision immediately after this transition. */
  revision_after: number | null;
  /** Labels newly added by this transition (empty array for events that add none). Never raw tool content — only the label NAMES, which are operator-defined, bounded, policy vocabulary. */
  labels_added: string[] | null;
  /** The audit event (already redacted) that caused this transition, if any. */
  source_event_id: string | null;
  tool_name: string | null;
  /** The contextual rule id that matched, for call_evaluated events where a rule fired. */
  rule_id: string | null;
  /** The effective enforcement action taken: 'allow' | 'deny' | 'require_approval', for call_evaluated events. */
  action: string | null;
  /** Who/what performed a reset, e.g. "cli", "control-api". Never a secret. */
  reviewer: string | null;
  /** Safe, bounded, human-readable explanation. Never raw hostile tool content. */
  reason: string | null;
}

/** Current, queryable state for one execution context — a mutable projection over the append-only event log, mirroring the audit_events/audit_lifecycle_records and tool_integrity_events/tool_integrity_state patterns. */
export interface ContextState {
  context_id: string;
  /** The Tool Integrity server identity this context's downstream server belongs to, where known — informational linkage only, not an enforcement dependency. */
  server_identity: string | null;
  /** Monotonically increasing — every transition that changes labels or resets/expires the context increments this. */
  revision: number;
  status: ContextStatus;
  /** Active risk labels — operator-defined policy vocabulary strings only, never raw content. */
  labels: string[];
  created_at: string;
  updated_at: string;
  /** ISO timestamp after which this context is treated as expired, if TTL expiry is configured. Null = no TTL. */
  expires_at: string | null;
  last_event_id: string | null;
}

/** The effective enforcement action from evaluating contextual rules against one attempted call. */
export type ContextGuardAction = 'allow' | 'deny' | 'require_approval';

export interface ContextGuardEvaluation {
  action: ContextGuardAction;
  /** The contextual rule that produced this action, if any (null for 'allow' with no matching rule). */
  ruleId: string | null;
  reason: string | null;
  approvalTtlSeconds: number | null;
}
