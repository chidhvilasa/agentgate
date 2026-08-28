// Contextual policy rule evaluation (Milestone 7, ADR-0013).
//
// Pure, deterministic, side-effect-free — no I/O, no MCP SDK, no storage
// access. Given the ACTIVE context's current labels and the ATTEMPTED
// call's declared effect labels, evaluates `context_guard.rules` in
// order and returns the first match, exactly mirroring the base policy
// engine's deterministic first-match semantics (see @agentgate/policy).
//
// Contextual rules only ever ESCALATE. There is no "allow" action in the
// rule schema — the caller (pipeline.ts) always takes the STRICTER of the
// base policy decision and whatever this returns, never the other way.
import type { ContextGuardRule, ContextGuardWhen } from '../config/registry.js';
import type { ContextGuardEvaluation } from './types.js';

function hasAll(labels: string[], required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  return required.every((l) => labels.includes(l));
}

function hasAny(labels: string[], required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  return required.some((l) => labels.includes(l));
}

function lacksAll(labels: string[], forbidden: string[] | undefined): boolean {
  if (!forbidden || forbidden.length === 0) return true;
  return forbidden.every((l) => !labels.includes(l));
}

function lacksAny(labels: string[], forbidden: string[] | undefined): boolean {
  if (!forbidden || forbidden.length === 0) return true;
  return forbidden.some((l) => !labels.includes(l));
}

/** Evaluates one rule's `when` clause against the active context labels and the attempted call's target effect labels. */
export function whenMatches(when: ContextGuardWhen, contextLabels: string[], targetEffects: string[]): boolean {
  return (
    hasAll(contextLabels, when.context_has_all) &&
    hasAny(contextLabels, when.context_has_any) &&
    lacksAll(contextLabels, when.context_lacks_all) &&
    lacksAny(contextLabels, when.context_lacks_any) &&
    hasAny(targetEffects, when.target_has_any) &&
    hasAll(targetEffects, when.target_has_all)
  );
}

/**
 * Evaluates `rules` in declared order and returns the first match —
 * deterministic first-match semantics, exactly like the base policy
 * engine. Returns `{ action: 'allow', ruleId: null, ... }` if no rule
 * matches (the caller then simply defers entirely to the base policy
 * decision — Context Guard never "allows" anything, it only optionally
 * escalates).
 */
export function evaluateContextualRules(
  rules: ContextGuardRule[],
  contextLabels: string[],
  targetEffects: string[]
): ContextGuardEvaluation {
  for (const rule of rules) {
    if (whenMatches(rule.when, contextLabels, targetEffects)) {
      return {
        action: rule.action,
        ruleId: rule.id,
        reason: rule.reason,
        approvalTtlSeconds: rule.approval_ttl_seconds ?? null,
      };
    }
  }
  return { action: 'allow', ruleId: null, reason: null, approvalTtlSeconds: null };
}

/** Strictness ordering used to combine the base policy decision with a Context Guard evaluation — always takes the stricter of the two, never lets Context Guard silently loosen a base-policy DENY, and never lets a base-policy ALLOW silently loosen a Context Guard escalation. */
const ACTION_STRICTNESS: Record<string, number> = {
  ALLOW: 0,
  ALLOW_WITH_TRANSFORM: 0,
  allow: 0,
  REQUIRE_APPROVAL: 1,
  require_approval: 1,
  DENY: 2,
  deny: 2,
};

/** True if `a` is at least as strict as `b` (used to decide whether Context Guard's evaluation should override the base policy decision). */
export function isAtLeastAsStrict(a: string, b: string): boolean {
  return (ACTION_STRICTNESS[a] ?? 0) >= (ACTION_STRICTNESS[b] ?? 0);
}
