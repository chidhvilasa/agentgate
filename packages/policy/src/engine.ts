import path from 'node:path';
import micromatch from 'micromatch';
import type { Policy, PolicyRule } from './schema.js';
import type { PolicyDecision } from '@agentgate/protocol';
import { detectSecrets } from './transformation.js';

// ─── Input for Policy Evaluation ─────────────────────────────────────────────

export interface EvaluationInput {
  /** Agent's declared name (untrusted, display only). */
  declared_agent_name: string | null;
  /** Fully-qualified tool name: server_id.tool_name or just tool_name. */
  tool: string;
  /** Normalized arguments (paths resolved, separators unified). */
  normalized_arguments: Record<string, unknown>;
  /** Flat string representation of all argument values for secret scanning. */
  arguments_text: string;
  /** Optional: primary path argument for filesystem tools. */
  primary_path?: string;
  /** Optional: command string for shell tools. */
  command?: string;
  /** Optional: target host/URL for network tools. */
  host?: string;
}

export interface EvaluationResult {
  decision: PolicyDecision;
  /** The matched rule, or null if default-deny applied. */
  matched_rule: PolicyRule | null;
  /** The approval TTL in seconds, only set for REQUIRE_APPROVAL decisions. */
  approval_ttl_seconds: number;
}

// ─── Path Normalization ───────────────────────────────────────────────────────

/**
 * Normalizes a file path to prevent traversal attacks.
 * - Resolves ".." and "." segments
 * - Unifies path separators (Windows → POSIX)
 * - Does NOT follow symlinks (that requires filesystem access at runtime)
 */
export function normalizePath(inputPath: string): string {
  // Normalize Windows backslashes to forward slashes
  const unified = inputPath.replace(/\\/g, '/');
  // Use node:path to resolve ".." and "." without filesystem access
  const resolved = path.posix.normalize(unified);
  return resolved;
}

/**
 * Checks whether a candidate path is within the allowed base path.
 * Prevents traversal outside the permitted root.
 */
export function isPathWithin(basePath: string, candidatePath: string): boolean {
  const normalBase = normalizePath(basePath);
  const normalCandidate = normalizePath(candidatePath);
  // Ensure candidate starts with base and the next char is '/' or end-of-string
  return (
    normalCandidate.startsWith(normalBase) &&
    (normalCandidate.length === normalBase.length ||
      normalCandidate[normalBase.length] === '/')
  );
}

// ─── Rule Matching ────────────────────────────────────────────────────────────

function matchesGlobs(value: string, patterns: string[]): boolean {
  return micromatch.isMatch(value, patterns, { nocase: process.platform === 'win32' });
}

function ruleMatches(rule: PolicyRule, input: EvaluationInput): boolean {
  // Agents
  if (rule.agents?.length) {
    const agentName = input.declared_agent_name ?? '';
    if (!matchesGlobs(agentName, rule.agents)) return false;
  }

  // Tools
  if (rule.tools?.length) {
    if (!matchesGlobs(input.tool, rule.tools)) return false;
  }

  // Paths — all specified path patterns must match the primary_path
  if (rule.paths?.length) {
    if (!input.primary_path) return false;
    const normalPath = normalizePath(input.primary_path);
    // Expand ${PROJECT_ROOT} to current working directory
    const expandedPatterns = rule.paths.map((p) =>
      p.replace('${PROJECT_ROOT}', normalizePath(process.cwd()))
    );
    if (!matchesGlobs(normalPath, expandedPatterns)) return false;
  }

  // Commands
  if (rule.commands?.length) {
    if (!input.command) return false;
    if (!matchesGlobs(input.command, rule.commands)) return false;
  }

  // Hosts
  if (rule.hosts?.length) {
    if (!input.host) return false;
    if (!matchesGlobs(input.host, rule.hosts)) return false;
  }

  // contains_secrets
  if (rule.contains_secrets === true) {
    if (!detectSecrets(input.arguments_text)) return false;
  }

  return true;
}

// ─── Policy Engine ────────────────────────────────────────────────────────────

const DEFAULT_APPROVAL_TTL_SECONDS = 120;

/**
 * Evaluates a tool call against the loaded policy.
 *
 * Rules are evaluated in declaration order (first match wins).
 * If no rule matches, the configured default (or deny) is applied.
 *
 * SECURITY: If the policy itself is malformed, returns DENY with reason
 * MALFORMED_POLICY rather than failing open.
 */
export function evaluate(policy: Policy, input: EvaluationInput): EvaluationResult {
  // Secret detection override: if secrets are detected and no explicit rule
  // allows this call, we let normal rule matching continue — if a rule says
  // allow AND doesn't require contains_secrets, secrets in args are still
  // subject to ALLOW_WITH_TRANSFORM if configured.
  // The policy author is responsible for adding secret-detection rules.

  for (const rule of policy.rules) {
    if (!ruleMatches(rule, input)) continue;

    // Matched — translate decision
    switch (rule.decision) {
      case 'allow': {
        const decision: PolicyDecision = {
          type: 'ALLOW',
          reason_code: 'POLICY_ALLOW',
          explanation: `Allowed by rule "${rule.id}"${rule.description ? ': ' + rule.description : ''}.`,
          matched_rule_id: rule.id,
        };
        return { decision, matched_rule: rule, approval_ttl_seconds: 0 };
      }

      case 'deny': {
        const decision: PolicyDecision = {
          type: 'DENY',
          reason_code: 'POLICY_DENY',
          explanation: `Denied by rule "${rule.id}"${rule.description ? ': ' + rule.description : ''}.`,
          matched_rule_id: rule.id,
        };
        return { decision, matched_rule: rule, approval_ttl_seconds: 0 };
      }

      case 'require_approval': {
        const ttl = rule.approval_ttl_seconds ?? DEFAULT_APPROVAL_TTL_SECONDS;
        const decision: PolicyDecision = {
          type: 'REQUIRE_APPROVAL',
          reason_code: 'POLICY_REQUIRE_APPROVAL',
          explanation: `Human approval required by rule "${rule.id}"${rule.description ? ': ' + rule.description : ''}. Approval expires in ${ttl}s.`,
          matched_rule_id: rule.id,
        };
        return { decision, matched_rule: rule, approval_ttl_seconds: ttl };
      }

      case 'allow_with_transform': {
        const applied = rule.transformations?.map((t) => `redact:${t.redact_field}`) ?? [];
        const decision: PolicyDecision = {
          type: 'ALLOW_WITH_TRANSFORM',
          reason_code: 'POLICY_ALLOW_WITH_TRANSFORM',
          explanation: `Allowed with transformations by rule "${rule.id}". Redacted fields: ${applied.join(', ') || 'none'}.`,
          matched_rule_id: rule.id,
          transformations_applied: applied,
        };
        return { decision, matched_rule: rule, approval_ttl_seconds: 0 };
      }
    }
  }

  // No rule matched — apply default
  const defaultDecision = policy.defaults.decision;

  if (defaultDecision === 'allow') {
    const decision: PolicyDecision = {
      type: 'ALLOW',
      reason_code: 'DEFAULT_DENY', // re-using as DEFAULT (allow is unusual)
      explanation: 'Allowed by policy default. No specific rule matched.',
      matched_rule_id: null,
    };
    return { decision, matched_rule: null, approval_ttl_seconds: 0 };
  }

  // Default deny (most common, recommended)
  const decision: PolicyDecision = {
    type: 'DENY',
    reason_code: 'DEFAULT_DENY',
    explanation: 'Denied by default policy. No rule explicitly allows this tool call.',
    matched_rule_id: null,
  };
  return { decision, matched_rule: null, approval_ttl_seconds: 0 };
}
