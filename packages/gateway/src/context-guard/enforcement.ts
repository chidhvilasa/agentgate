// Fail-closed contextual enforcement (Milestone 7, ADR-0013).
//
// Called from pipeline.ts, between base policy evaluation and decision
// routing. Never imports the MCP SDK, executeDownstream, or a downstream
// transport — only reads already-stored context state and evaluates the
// pure rule-matching logic in rules.ts.
import crypto from 'node:crypto';
import type { AuditStorage } from '../storage.js';
import type { ContextGuardConfig, ContextGuardMode } from '../config/registry.js';
import type { Approval } from '@agentgate/protocol';
import { evaluateContextualRules } from './rules.js';
import type { ContextGuardEvaluation } from './types.js';

/** True only for the mode that actually enforces (blocks/escalates); monitor/disabled compute or skip but never change the effective decision. */
export function modeEnforces(mode: ContextGuardMode): boolean {
  return mode === 'enforce';
}

/**
 * Evaluates the attempted call against the active context. Always computes
 * a real answer (even in `monitor` mode, so it can be recorded/displayed) —
 * the CALLER decides whether to actually apply it based on mode, via
 * `modeEnforces()`. Fails closed (`action: 'deny'`) if the context store
 * itself cannot be read, or if `disabled` mode is not in effect and no
 * context exists yet for this id (a context should always have been
 * created before any call is evaluated; a missing one is treated as a
 * storage/lifecycle inconsistency, not "assume no risk").
 */
export function evaluateContextGuard(
  storage: AuditStorage,
  config: ContextGuardConfig,
  contextId: string,
  toolName: string
): ContextGuardEvaluation {
  if (config.mode === 'disabled') {
    return { action: 'allow', ruleId: null, reason: null, approvalTtlSeconds: null };
  }

  let contextLabels: string[];
  try {
    const state = storage.getContextState(contextId);
    if (!state) {
      return { action: 'deny', ruleId: null, reason: 'No execution context is recorded — failing closed.', approvalTtlSeconds: null };
    }
    contextLabels = state.labels;
  } catch {
    return { action: 'deny', ruleId: null, reason: 'Context Guard storage lookup failed — failing closed.', approvalTtlSeconds: null };
  }

  const targetEffects = config.tools[toolName]?.effects ?? [];
  return evaluateContextualRules(config.rules, contextLabels, targetEffects);
}

/** SHA-256 digest of the REDACTED arguments an approval was created for — never the raw arguments. Used to bind an approval to the exact call it was created for, defense-in-depth alongside the existing one-approval-per-event_id design. */
export function computeArgumentDigest(redactedArgs: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(redactedArgs) ?? 'null', 'utf8').digest('hex');
}

export interface ApprovalContextCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Re-validates a context-bound approval's binding at CONSUMPTION time
 * (immediately before downstream execution, after a human has approved) —
 * not just at creation time. The context may have accumulated MORE risk
 * labels (from a concurrent call) in the window between approval creation
 * and a human clicking "approve"; this closes that window by re-checking
 * the exact revision, tool identity, and argument digest right before
 * execution, and failing closed on any mismatch. An approval with no
 * context binding at all (context_id === null — pre-Milestone-7 or
 * non-contextual) always passes this check, unchanged from prior behavior.
 */
export function checkApprovalContextValid(
  approval: Approval,
  storage: AuditStorage,
  expectedToolName: string,
  expectedArgumentDigest: string
): ApprovalContextCheck {
  if (approval.context_id === null) return { ok: true }; // not a contextual approval — unchanged prior behavior.

  let currentState;
  try {
    currentState = storage.getContextState(approval.context_id);
  } catch {
    return { ok: false, reason: 'Context Guard storage lookup failed at approval consumption — failing closed.' };
  }
  if (!currentState) {
    return { ok: false, reason: 'The execution context this approval was bound to no longer exists.' };
  }
  if (currentState.revision !== approval.context_revision) {
    return {
      ok: false,
      reason: `Context has advanced from revision ${approval.context_revision} to ${currentState.revision} since this approval was created — it must be re-evaluated.`,
    };
  }
  if (approval.argument_digest !== null && approval.argument_digest !== expectedArgumentDigest) {
    return { ok: false, reason: 'The call arguments no longer match what this approval was created for.' };
  }
  if (approval.scope !== expectedToolName) {
    return { ok: false, reason: 'The target tool no longer matches what this approval was created for.' };
  }
  return { ok: true };
}
