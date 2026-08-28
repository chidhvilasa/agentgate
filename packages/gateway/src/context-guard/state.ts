// Context Guard state machine (Milestone 7, ADR-0013).
//
// Pure decision logic over the storage layer's context_events/context_state
// tables — mirrors how tool-integrity/registry.ts's decision logic is
// separate from storage.ts's persistence. Never connects to a downstream
// server, never imports the MCP SDK, executeDownstream, or runPipeline.
//
// "Revision" is a strictly monotonic counter: every transition that changes
// labels, or that resets/expires/closes the context, increments it by
// exactly 1. A revision is never decremented, and existing labels are never
// removed except by an explicit, audited reset (see resetContext()).
import type { AuditStorage } from '../storage.js';
import type { ContextState, ContextEvent } from './types.js';

export interface CreateContextResult {
  state: ContextState;
  event: ContextEvent;
}

/** Creates a fresh, empty, active execution context. Idempotent-safe: if a context with this id already exists, its current state is returned unchanged rather than silently overwritten (a real caller should never pass a colliding id — context ids are locally generated UUIDs — but this fails safe rather than clobbering history if it ever happens). */
export function createContext(storage: AuditStorage, contextId: string, serverIdentity: string | null): CreateContextResult {
  const existing = storage.getContextState(contextId);
  if (existing) {
    const events = storage.listContextEvents({ contextId, limit: 1 });
    return { state: existing, event: events[events.length - 1] };
  }

  const now = new Date().toISOString();
  const event = storage.insertContextEvent({
    created_at: now,
    event_type: 'context_created',
    context_id: contextId,
    revision_before: null,
    revision_after: 0,
    labels_added: [],
    source_event_id: null,
    tool_name: null,
    rule_id: null,
    action: null,
    reviewer: null,
    reason: 'Execution context created.',
  });
  const state: ContextState = {
    context_id: contextId,
    server_identity: serverIdentity,
    revision: 0,
    status: 'active',
    labels: [],
    created_at: now,
    updated_at: now,
    expires_at: null,
    last_event_id: event.id,
  };
  storage.upsertContextState(state);
  return { state, event };
}

export interface AppendLabelsResult {
  state: ContextState;
  /** Only the labels that were actually NEW (not already present) — empty if nothing changed. */
  added: string[];
  event: ContextEvent | null;
}

/**
 * Adds labels to the active context after an observed tool outcome.
 * Monotonic: the result is always the UNION of existing and new labels,
 * sorted for deterministic storage/display — never a removal. If every
 * label in `newLabels` is already present, this is a no-op (no event
 * emitted, no revision bump) — history stays proportional to REAL change,
 * not to every call that happens to re-observe an already-known label.
 * Fails closed (throws) if the context doesn't exist or isn't active —
 * callers must create the context first and must not call this on a
 * reset/expired/closed context.
 */
export function appendContextLabels(
  storage: AuditStorage,
  contextId: string,
  newLabels: string[],
  opts: { sourceEventId: string | null; toolName: string | null; reason: string }
): AppendLabelsResult {
  const existing = storage.getContextState(contextId);
  if (!existing) throw new Error(`Cannot append labels: context "${contextId}" does not exist.`);
  if (existing.status !== 'active') throw new Error(`Cannot append labels: context "${contextId}" is ${existing.status}, not active.`);

  const added = [...new Set(newLabels)].filter((l) => !existing.labels.includes(l));
  if (added.length === 0) {
    return { state: existing, added: [], event: null };
  }

  const now = new Date().toISOString();
  const revision_before = existing.revision;
  const revision_after = existing.revision + 1;
  const mergedLabels = [...new Set([...existing.labels, ...added])].sort();

  const event = storage.insertContextEvent({
    created_at: now,
    event_type: 'label_added',
    context_id: contextId,
    revision_before,
    revision_after,
    labels_added: added,
    source_event_id: opts.sourceEventId,
    tool_name: opts.toolName,
    rule_id: null,
    action: null,
    reviewer: null,
    reason: opts.reason,
  });

  const state: ContextState = {
    ...existing,
    revision: revision_after,
    labels: mergedLabels,
    updated_at: now,
    last_event_id: event.id,
  };
  storage.upsertContextState(state);
  return { state, added, event };
}

/**
 * Records a `call_evaluated` event for history/explain purposes — always
 * emitted for every contextually-evaluated call, regardless of whether the
 * outcome changed anything, so `agentgate context history`/`explain` and
 * the Control Center timeline have a complete record of every decision.
 * Never changes revision or labels by itself.
 */
export function recordCallEvaluation(
  storage: AuditStorage,
  contextId: string,
  opts: { sourceEventId: string | null; toolName: string; ruleId: string | null; action: string; reason: string | null }
): ContextEvent {
  const existing = storage.getContextState(contextId);
  const now = new Date().toISOString();
  const event = storage.insertContextEvent({
    created_at: now,
    event_type: 'call_evaluated',
    context_id: contextId,
    revision_before: existing?.revision ?? null,
    revision_after: existing?.revision ?? null,
    labels_added: [],
    source_event_id: opts.sourceEventId,
    tool_name: opts.toolName,
    rule_id: opts.ruleId,
    action: opts.action,
    reviewer: null,
    reason: opts.reason,
  });
  if (existing) {
    storage.upsertContextState({ ...existing, last_event_id: event.id, updated_at: now });
  }
  return event;
}

export interface ResetContextResult {
  ok: boolean;
  error?: string;
  state?: ContextState;
}

/**
 * Explicitly resets a context: clears its active labels, bumps its
 * revision, and marks it `reset` — but NEVER deletes history (the prior
 * `label_added`/`call_evaluated` events remain in `context_events`
 * forever). Requires an EXACT current revision match (the same
 * stale-revision protection as Tool Integrity's exact-fingerprint
 * accept/reject) so a reset request formed against a now-stale revision
 * cannot silently reset a context that has since accumulated MORE risk
 * than the requester saw. A reset does not, and cannot, erase what an
 * upstream LLM/client may still remember from before the reset — see
 * ADR-0013 and every reset-facing CLI/API/UI surface for this caveat
 * stated explicitly.
 */
export function resetContext(
  storage: AuditStorage,
  contextId: string,
  expectedRevision: number,
  reviewer: string,
  reason: string
): ResetContextResult {
  const existing = storage.getContextState(contextId);
  if (!existing) return { ok: false, error: `No such context "${contextId}".` };
  if (existing.revision !== expectedRevision) {
    return {
      ok: false,
      error: `Stale revision: context "${contextId}" is now at revision ${existing.revision}, not ${expectedRevision}. Re-check current state before resetting.`,
    };
  }
  if (existing.status !== 'active') {
    return { ok: false, error: `Context "${contextId}" is already ${existing.status}.` };
  }

  const now = new Date().toISOString();
  const revision_after = existing.revision + 1;
  const event = storage.insertContextEvent({
    created_at: now,
    event_type: 'context_reset',
    context_id: contextId,
    revision_before: existing.revision,
    revision_after,
    labels_added: [],
    source_event_id: null,
    tool_name: null,
    rule_id: null,
    action: null,
    reviewer,
    reason,
  });
  const state: ContextState = {
    ...existing,
    revision: revision_after,
    status: 'reset',
    labels: [],
    updated_at: now,
    last_event_id: event.id,
  };
  storage.upsertContextState(state);
  return { ok: true, state };
}

/** Marks a context closed (upstream connection ended) or expired (TTL elapsed). Both are terminal, append-only transitions — never a deletion. */
export function closeOrExpireContext(storage: AuditStorage, contextId: string, reason: 'closed' | 'expired'): ContextState | null {
  const existing = storage.getContextState(contextId);
  if (!existing || existing.status !== 'active') return existing;

  const now = new Date().toISOString();
  const revision_after = existing.revision + 1;
  const event = storage.insertContextEvent({
    created_at: now,
    event_type: reason === 'closed' ? 'context_closed' : 'context_expired',
    context_id: contextId,
    revision_before: existing.revision,
    revision_after,
    labels_added: [],
    source_event_id: null,
    tool_name: null,
    rule_id: null,
    action: null,
    reviewer: null,
    reason: reason === 'closed' ? 'Upstream connection ended.' : 'Context TTL elapsed.',
  });
  const state: ContextState = {
    ...existing,
    revision: revision_after,
    status: reason,
    updated_at: now,
    last_event_id: event.id,
  };
  storage.upsertContextState(state);
  return state;
}
