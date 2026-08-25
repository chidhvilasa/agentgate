// Shared types for the Tool Integrity Registry (Milestone 6, ADR-0012).

/** The state machine for one (server_identity, tool_name) pair. See ADR-0012 for the full transition table. */
export type ToolIntegrityStatus = 'pending_review' | 'trusted' | 'drifted' | 'rejected' | 'removed';

/** Every kind of append-only Tool Integrity event. */
export type ToolIntegrityEventType =
  | 'server_registered'
  | 'manifest_scanned'
  | 'scan_failed'
  | 'tool_observed'
  | 'baseline_accepted'
  | 'drift_detected'
  | 'accepted'
  | 'rejected'
  | 'removed'
  | 'reappeared';

/** One immutable, hash-chained row in `tool_integrity_events`. Never mutated or deleted. */
export interface ToolIntegrityEvent {
  id: string;
  sequence_number: number;
  previous_event_hash: string | null;
  event_hash: string;
  canonical_payload_version: string;
  created_at: string;
  event_type: ToolIntegrityEventType;
  server_identity: string;
  server_id: string;
  /** null for server-level events (server_registered, manifest_scanned, scan_failed). */
  tool_name: string | null;
  fingerprint: string | null;
  previous_fingerprint: string | null;
  manifest_fingerprint: string | null;
  state_before: ToolIntegrityStatus | null;
  state_after: ToolIntegrityStatus | null;
  /** Who/what performed a review action, e.g. "cli", "control-api", "tofu-auto". Never a secret or raw path. */
  reviewer: string | null;
  /** Safe, bounded, human-readable explanation. Never contains raw hostile content unescaped beyond what canonicalize.ts already redacted. */
  reason: string | null;
  /** The safe (secret-redacted, bounded) canonical tool definition — only populated for tool_observed/drift_detected/baseline_accepted events, needed later for diff display. */
  definition_json: string | null;
}

/** Current, queryable status for one (server_identity, tool_name) pair — a mutable projection over the append-only event log, exactly mirroring the audit_events/audit_lifecycle_records pattern (ADR-0004). */
export interface ToolIntegrityState {
  server_identity: string;
  server_id: string;
  tool_name: string;
  status: ToolIntegrityStatus;
  /** The fingerprint most recently observed on a scan, regardless of trust status. */
  current_fingerprint: string | null;
  /** The fingerprint that is actually trusted right now (what enforcement checks against). Null if never trusted. */
  trusted_fingerprint: string | null;
  /** The fingerprint of a pending/drifted candidate awaiting review. Null when status is trusted/rejected/removed (rejected keeps it in event history, not here). */
  candidate_fingerprint: string | null;
  /** Stable id for the current candidate observation — required, together with candidate_fingerprint, to accept/reject (prevents stale approval of a since-superseded candidate). Deterministic: sha256(`${server_identity}:${tool_name}:${fingerprint}`).slice(0,16). */
  candidate_id: string | null;
  trusted_definition_json: string | null;
  candidate_definition_json: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_scan_at: string;
  updated_at: string;
}
