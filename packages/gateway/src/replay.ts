/**
 * Safe Replay — policy re-evaluation of a historical event, never tool
 * re-execution. See ADR-0010 in docs/AI_DECISIONS.md.
 *
 * STRUCTURAL GUARANTEE: this module imports nothing capable of reaching a
 * downstream server. It never imports executeDownstream(), runPipeline(),
 * the MCP SDK's Client/StdioClientTransport, or ApprovalManager. It depends
 * on exactly the pure evaluate() function from @chidhvilasa/policy (the same
 * function the live pipeline calls — one rule matcher, not a second copy)
 * plus the pipeline's own pure argument-extraction helpers. There is no flag,
 * option, or code path here that reaches a downstream connection.
 */
import { evaluate, normalizePath, computePolicyDigest, type EvaluationInput, type Policy } from '@chidhvilasa/policy';
import type { AuditEvent } from '@chidhvilasa/protocol';
import { extractPrimaryPath, extractCommand, extractHost } from './pipeline.js';

/** Thrown when a source event cannot be safely replayed — never guessed at. */
export class ReplayUnsupportedEventError extends Error {
  constructor(reason: string) {
    super(`Cannot replay this event: ${reason}`);
    this.name = 'ReplayUnsupportedEventError';
  }
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

export interface ReplayComparison {
  evaluated_at: string;
  policy_digest: string;
  source_arguments_redacted: boolean;
  original: ReplayDecisionSummary;
  current: ReplayCurrentDecisionSummary;
  decision_changed: boolean;
  matched_rule_changed: boolean;
  reason_code_changed: boolean;
  comparison: string;
  limitations: string[];
}

const MAX_LIMITATION_LENGTH = 400;

function boundedLimitation(text: string): string {
  return text.length > MAX_LIMITATION_LENGTH ? text.slice(0, MAX_LIMITATION_LENGTH) + '…' : text;
}

/**
 * Validates that a source AuditEvent has enough structure to safely
 * re-evaluate. Rejects legacy/malformed shapes explicitly rather than
 * guessing — callers (API/CLI) turn this into a 409 / non-zero exit.
 */
function assertReplayable(sourceEvent: AuditEvent): void {
  if (!sourceEvent.tool_call || typeof sourceEvent.tool_call.tool !== 'string' || !sourceEvent.tool_call.tool) {
    throw new ReplayUnsupportedEventError('source event has no recognizable tool_call.tool field.');
  }
  if (!sourceEvent.tool_call.normalized_arguments || typeof sourceEvent.tool_call.normalized_arguments !== 'object') {
    throw new ReplayUnsupportedEventError('source event has no recognizable tool_call.normalized_arguments.');
  }
  if (!sourceEvent.agent) {
    throw new ReplayUnsupportedEventError('source event has no recognizable agent identity.');
  }
}

/**
 * Reconstructs the same EvaluationInput shape runPipeline() builds, but from
 * a stored (already redacted) historical event rather than a live call.
 */
function buildEvaluationInput(sourceEvent: AuditEvent): EvaluationInput {
  const normalizedArgs = sourceEvent.tool_call.normalized_arguments;
  const rawPath = extractPrimaryPath(normalizedArgs);
  return {
    declared_agent_name: sourceEvent.agent.declared_name,
    tool: sourceEvent.tool_call.tool,
    normalized_arguments: normalizedArgs,
    arguments_text: JSON.stringify(normalizedArgs),
    primary_path: rawPath ? normalizePath(rawPath) : undefined,
    command: extractCommand(normalizedArgs),
    host: extractHost(normalizedArgs),
  };
}

/**
 * Re-evaluates a historical event's stored (redacted, normalized) tool call
 * against the current policy. Never executes anything, never mutates
 * `sourceEvent`, never touches storage — pure input in, pure result out.
 */
export function evaluateHistoricalEvent(opts: {
  sourceEvent: AuditEvent;
  currentPolicy: Policy;
}): ReplayComparison {
  const { sourceEvent, currentPolicy } = opts;
  assertReplayable(sourceEvent);

  const input = buildEvaluationInput(sourceEvent);
  const { decision } = evaluate(currentPolicy, input);
  const policyDigest = computePolicyDigest(currentPolicy);

  const original: ReplayDecisionSummary = {
    decision_type: sourceEvent.decision?.type ?? null,
    matched_rule_id: sourceEvent.decision?.matched_rule_id ?? null,
    reason_code: sourceEvent.decision?.reason_code ?? null,
  };

  const current: ReplayCurrentDecisionSummary = {
    decision_type: decision.type,
    matched_rule_id: decision.matched_rule_id,
    reason_code: decision.reason_code,
    explanation: decision.explanation,
    transformations: decision.transformations_applied ?? [],
  };

  const decisionChanged = original.decision_type !== current.decision_type;
  const matchedRuleChanged = original.matched_rule_id !== current.matched_rule_id;
  const reasonCodeChanged = original.reason_code !== current.reason_code;

  const limitations: string[] = [
    'Safe Replay evaluates the stored, already-normalized tool call against the current policy. It never executes the tool and never reproduces the original downstream result.',
  ];

  if (sourceEvent.arguments_redacted) {
    limitations.push(
      boundedLimitation(
        'The original arguments were redacted before persistence. A contains_secrets rule that matched the ' +
          'original text will generally not match the stored [REDACTED] placeholder, so decision_changed may ' +
          'be true purely because of this representational gap, not because the policy actually changed.'
      )
    );
  }
  if (original.decision_type === null) {
    limitations.push(
      'No original policy decision was recorded for this event (unsupported or incomplete historical event); the comparison below is against a missing baseline.'
    );
  }
  limitations.push(
    'This evaluates against the current policy file, not a historical snapshot of the policy as it existed when the original event occurred.'
  );

  let comparison: string;
  if (!decisionChanged) {
    comparison = 'Policy decision unchanged.';
  } else {
    comparison = `Policy decision changed from ${original.decision_type ?? 'unknown'} to ${current.decision_type}.`;
  }

  return {
    evaluated_at: new Date().toISOString(),
    policy_digest: policyDigest,
    source_arguments_redacted: sourceEvent.arguments_redacted,
    original,
    current,
    decision_changed: decisionChanged,
    matched_rule_changed: matchedRuleChanged,
    reason_code_changed: reasonCodeChanged,
    comparison,
    limitations,
  };
}
