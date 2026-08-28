// Context Guard (Milestone 7, ADR-0013) read/reset logic — the single
// implementation shared by the CLI (cli.ts, below) and the Control API
// (api/control.ts), so the two surfaces can never silently drift apart.
// Each `summarize*`/`explainContext`/`performContextReset`/
// `verifyContextChainReport` function operates on an ALREADY-OPEN
// AuditStorage (and, for reset, ApprovalManager) — the caller owns opening
// and closing it. The `runContext*` wrappers at the bottom add the
// config-path open/close boilerplate the CLI needs; the Control API calls
// the core functions directly against its own already-open storage
// connection instead of opening a second one per request.
//
// Security-relevant conventions enforced here:
//   - every read function is strictly read-only against already-stored
//     data — none of them ever connects to a downstream server, discovers
//     tools, or executes anything;
//   - `performContextReset`/`runContextReset` require an EXACT current
//     revision AND a non-empty, bounded operator reason — never a
//     name-pattern or "reset all" shortcut;
//   - every report returned here is ALREADY bounded/redacted — raw tool
//     arguments/results are never read from storage in the first place
//     (context_events/context_state never store them; see state.ts).
import { AuditStorage } from '../storage.js';
import { ApprovalManager } from '../approval.js';
import { loadGatewayConfig } from '../config/registry.js';
import { resetContext } from './state.js';
import type { ContextState, ContextEvent, ContextStatus } from './types.js';

const MAX_STATUS_ROWS = 200;
const MAX_HISTORY_ROWS = 500;
const MAX_REASON_LENGTH = 2000;

function openStorage(configPath: string): AuditStorage {
  const config = loadGatewayConfig(configPath);
  return new AuditStorage(config.db_path);
}

// ─── status ─────────────────────────────────────────────────────────────────

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

/** Read-only, on an already-open storage connection. Most-recently-updated first (storage.listContextStates()'s own deterministic ordering), optionally filtered by lifecycle status, always bounded. */
export function summarizeContexts(storage: AuditStorage, opts: { state?: ContextStatus; limit?: number } = {}): ContextStatusReport {
  let all: ContextState[] = storage.listContextStates();
  if (opts.state) all = all.filter((c) => c.status === opts.state);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, MAX_STATUS_ROWS));
  const bounded = all.slice(0, limit);
  const pendingApprovals = storage.listPendingApprovals();
  const contexts: ContextSummary[] = bounded.map((c) => ({
    context_id: c.context_id,
    status: c.status,
    revision: c.revision,
    labels: c.labels,
    server_identity: c.server_identity,
    created_at: c.created_at,
    updated_at: c.updated_at,
    expires_at: c.expires_at,
    pending_approval_count: pendingApprovals.filter((a) => a.context_id === c.context_id).length,
  }));
  return { contexts, total: all.length, truncated: all.length > bounded.length };
}

/** Read-only. A single context's summary, or null if it does not exist. */
export function summarizeOneContext(storage: AuditStorage, contextId: string): ContextSummary | null {
  const c = storage.getContextState(contextId);
  if (!c) return null;
  const pendingCount = storage.listPendingApprovals().filter((a) => a.context_id === contextId).length;
  return {
    context_id: c.context_id,
    status: c.status,
    revision: c.revision,
    labels: c.labels,
    server_identity: c.server_identity,
    created_at: c.created_at,
    updated_at: c.updated_at,
    expires_at: c.expires_at,
    pending_approval_count: pendingCount,
  };
}

// ─── history ────────────────────────────────────────────────────────────────

export interface ContextHistoryReport {
  /** null when listing across every context (bounded to the most recent N transitions overall). */
  context_id: string | null;
  events: ContextEvent[];
  chain_valid: boolean;
  chain_error?: string;
  truncated: boolean;
}

/** Read-only. Deterministic oldest-first ordering within the returned (bounded) window — never raw tool arguments/results, which are never stored in context_events in the first place. */
export function summarizeContextHistory(storage: AuditStorage, contextId?: string, opts: { limit?: number } = {}): ContextHistoryReport {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, MAX_HISTORY_ROWS));
  const full = storage.listContextEvents({ contextId });
  const events = storage.listContextEvents({ contextId, limit });
  const chain = storage.verifyContextChain();
  return { context_id: contextId ?? null, events, chain_valid: chain.valid, chain_error: chain.error, truncated: full.length > events.length };
}

// ─── explain ────────────────────────────────────────────────────────────────

export interface LabelOrigin {
  label: string;
  /** Safe, already-redacted originating audit event id — never raw content. Null if not recorded (e.g. a legacy row). */
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
  /** Which safe, redacted events established each currently-active label — facts, from stored history. */
  label_origins?: LabelOrigin[];
  /**
   * The most recent stored `call_evaluated` decision for this context, if
   * any was ever recorded. `null` (not omitted) when the context exists
   * but no contextual decision has ever been evaluated for it — this is a
   * fact, not a fabricated hypothetical: this command never simulates or
   * predicts what a NOT-yet-attempted call would do.
   */
  latest_decision?: LatestDecision | null;
  lifecycle_note: string;
}

const LIFECYCLE_NOTES: Record<ContextStatus, string> = {
  active: 'This context is active — its labels are still being accumulated and evaluated against contextual rules.',
  closed: 'This context is closed (the upstream connection ended). Its history remains queryable but it can no longer accumulate labels or approve calls.',
  expired: 'This context expired (TTL elapsed). Its history remains queryable but it can no longer accumulate labels or approve calls.',
  reset: 'This context was explicitly reset — its active label set was cleared going forward, but its full prior history remains in the append-only log below, never deleted.',
};

/** Read-only. Reports only what is actually stored — never a fabricated hypothetical decision for a call that was never attempted. */
export function explainContext(storage: AuditStorage, contextId: string): ContextExplainReport {
  const state = storage.getContextState(contextId);
  if (!state) {
    return { ok: false, error: `No such context "${contextId}".`, lifecycle_note: '' };
  }
  const events = storage.listContextEvents({ contextId });

  // Facts: the first event that added each currently-active label.
  const originByLabel = new Map<string, LabelOrigin>();
  for (const e of events) {
    if (e.event_type !== 'label_added' || !e.labels_added) continue;
    for (const label of e.labels_added) {
      if (!originByLabel.has(label) && state.labels.includes(label)) {
        originByLabel.set(label, { label, source_event_id: e.source_event_id, tool_name: e.tool_name, reason: e.reason, at: e.created_at });
      }
    }
  }

  const lastDecisionEvent = [...events].reverse().find((e) => e.event_type === 'call_evaluated');
  const latestDecision: LatestDecision | null = lastDecisionEvent
    ? {
        tool_name: lastDecisionEvent.tool_name ?? '(unknown)',
        rule_id: lastDecisionEvent.rule_id,
        action: lastDecisionEvent.action ?? 'allow',
        reason: lastDecisionEvent.reason,
        at: lastDecisionEvent.created_at,
      }
    : null;

  return {
    ok: true,
    context_id: state.context_id,
    status: state.status,
    revision: state.revision,
    labels: state.labels,
    label_origins: state.labels.map((l) => originByLabel.get(l)).filter((o): o is LabelOrigin => o !== undefined),
    latest_decision: latestDecision,
    lifecycle_note: LIFECYCLE_NOTES[state.status],
  };
}

// ─── reset ──────────────────────────────────────────────────────────────────

export interface ContextResetReport {
  ok: boolean;
  error?: string;
  context_id?: string;
  new_revision?: number;
  status?: ContextStatus;
  invalidated_approval_count?: number;
}

export const RESET_MEMORY_WARNING =
  'Reset begins a new AgentGate enforcement state for this context — it cannot erase, and has no effect whatsoever on, anything the upstream LLM or MCP client itself already remembers from before the reset (its own conversation history, cached tool results, or reasoning already produced).';

/** The only mutating Context Guard operation. Requires the EXACT full context id, EXACT current revision, and a non-empty, bounded operator reason. Appends a reset transition (never deletes history) and actively invalidates every pending contextual approval bound to this context. `reviewer` identifies the caller ("cli", "control-api"), matching Tool Integrity's own accept/reject convention. */
export function performContextReset(
  storage: AuditStorage,
  approvalManager: ApprovalManager,
  contextId: string,
  revision: number,
  reason: string,
  reviewer: string
): ContextResetReport {
  if (!contextId || contextId.trim().length === 0) {
    return { ok: false, error: 'A context id is required.' };
  }
  if (!Number.isInteger(revision) || revision < 0) {
    return { ok: false, error: 'An exact, non-negative integer revision is required.' };
  }
  const trimmedReason = (reason ?? '').trim();
  if (trimmedReason.length === 0) {
    return { ok: false, error: 'A non-empty reason is required.' };
  }
  if (trimmedReason.length > MAX_REASON_LENGTH) {
    return { ok: false, error: `reason is too long (max ${MAX_REASON_LENGTH} characters).` };
  }

  const result = resetContext(storage, contextId, revision, reviewer, trimmedReason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Invalidate every pending contextual approval bound to this context —
  // resetContext() itself only transitions context_state/context_events;
  // approvals are a separate store this function must also handle so a
  // pending approval cannot silently outlive the reset it was bound to.
  const pending = storage.listPendingApprovals().filter((a) => a.context_id === contextId);
  for (const approval of pending) {
    approvalManager.deny(approval.id);
  }

  return {
    ok: true,
    context_id: contextId,
    new_revision: result.state!.revision,
    status: result.state!.status,
    invalidated_approval_count: pending.length,
  };
}

// ─── verify ─────────────────────────────────────────────────────────────────

export interface ContextVerifyReport {
  valid: boolean;
  count: number;
  error?: string;
  /** Truthful, stated limitation — never claimed away. */
  limitation: string;
}

const TAMPER_EVIDENCE_LIMITATION =
  'This verifies local append-only hash-chain integrity — it is tamper EVIDENCE, not non-repudiation, and does not protect against whole-database replacement by a privileged local administrator with direct file access.';

/** Read-only. Delegates entirely to the authoritative storage verifier (verifyContextChain()) — never a second, duplicate implementation of the chain-hashing logic. */
export function verifyContextChainReport(storage: AuditStorage): ContextVerifyReport {
  const result = storage.verifyContextChain();
  return { ...result, limitation: TAMPER_EVIDENCE_LIMITATION };
}

// ─── CLI wrappers (config-path open/close boilerplate) ─────────────────────

export function runContextStatus(configPath: string, opts: { state?: ContextStatus; limit?: number } = {}): ContextStatusReport {
  const storage = openStorage(configPath);
  try {
    return summarizeContexts(storage, opts);
  } finally {
    storage.close();
  }
}

export function runContextHistory(configPath: string, contextId?: string, opts: { limit?: number } = {}): ContextHistoryReport {
  const storage = openStorage(configPath);
  try {
    return summarizeContextHistory(storage, contextId, opts);
  } finally {
    storage.close();
  }
}

export function runContextExplain(configPath: string, contextId: string): ContextExplainReport {
  const storage = openStorage(configPath);
  try {
    return explainContext(storage, contextId);
  } finally {
    storage.close();
  }
}

export function runContextReset(configPath: string, contextId: string, revision: number, reason: string): ContextResetReport {
  const storage = openStorage(configPath);
  const approvalManager = new ApprovalManager(storage);
  try {
    return performContextReset(storage, approvalManager, contextId, revision, reason, 'cli');
  } finally {
    approvalManager.destroy();
    storage.close();
  }
}

export function runContextVerify(configPath: string): ContextVerifyReport {
  const storage = openStorage(configPath);
  try {
    return verifyContextChainReport(storage);
  } finally {
    storage.close();
  }
}
