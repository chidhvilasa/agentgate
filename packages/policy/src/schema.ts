import { z } from 'zod';

// ─── Decision Types ───────────────────────────────────────────────────────────

export const DecisionSchema = z.enum([
  'allow',
  'deny',
  'require_approval',
  'allow_with_transform',
]);
export type Decision = z.infer<typeof DecisionSchema>;

export const RiskLevelSchema = z.enum(['read', 'write', 'destructive', 'network', 'secret']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

// ─── Transformation Rule ──────────────────────────────────────────────────────

export const TransformationSchema = z.object({
  /** Field path in arguments to redact, e.g. "body", "env.SECRET_KEY" */
  redact_field: z.string(),
  /** Replace field value with this placeholder. */
  replace_with: z.string().default('[REDACTED]'),
});
export type Transformation = z.infer<typeof TransformationSchema>;

// ─── Policy Rule ─────────────────────────────────────────────────────────────

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),

  // Matching criteria — all specified criteria must match (AND logic)
  /** Agent declared_name patterns. Glob-style. */
  agents: z.array(z.string()).optional(),
  /** Tool name patterns. Glob-style. e.g. "filesystem.*", "shell.execute" */
  tools: z.array(z.string()).optional(),
  /** Path patterns for filesystem tools. Glob-style. */
  paths: z.array(z.string()).optional(),
  /** Command patterns for shell tools. Glob-style. */
  commands: z.array(z.string()).optional(),
  /** Host/URL patterns for network tools. Glob-style. */
  hosts: z.array(z.string()).optional(),
  /** Risk classification tags the rule applies to. */
  risk: z.array(RiskLevelSchema).optional(),
  /** If true, rule only matches when secrets are detected in arguments. */
  contains_secrets: z.boolean().optional(),

  // Decision
  decision: DecisionSchema,
  /** Required when decision is require_approval. Seconds until expiry. */
  approval_ttl_seconds: z.number().int().min(10).max(3600).optional(),
  /** Required when decision is allow_with_transform. */
  transformations: z.array(TransformationSchema).optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

// ─── Policy Defaults ──────────────────────────────────────────────────────────

export const PolicyDefaultsSchema = z.object({
  /** Applied when no rule matches. Secure default: deny. */
  decision: DecisionSchema.default('deny'),
});
export type PolicyDefaults = z.infer<typeof PolicyDefaultsSchema>;

// ─── Root Policy Schema ───────────────────────────────────────────────────────

export const PolicySchema = z.object({
  version: z.literal(1),
  defaults: PolicyDefaultsSchema.default({ decision: 'deny' }),
  rules: z.array(PolicyRuleSchema).default([]),
});
export type Policy = z.infer<typeof PolicySchema>;

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validates a parsed policy object.
 * Returns structured errors rather than throwing.
 */
export function validatePolicy(raw: unknown): ValidationResult {
  const result = PolicySchema.safeParse(raw);
  if (result.success) {
    const warnings: string[] = [];
    const policy = result.data;

    // Warn on rules that can never match (e.g. require_approval without TTL)
    for (const rule of policy.rules) {
      if (rule.decision === 'require_approval' && !rule.approval_ttl_seconds) {
        warnings.push(
          `Rule "${rule.id}": decision is require_approval but approval_ttl_seconds is not set. Will use default of 120s.`
        );
      }
      if (rule.decision === 'allow_with_transform' && !rule.transformations?.length) {
        warnings.push(
          `Rule "${rule.id}": decision is allow_with_transform but no transformations defined. This acts as a plain allow.`
        );
      }
    }

    // Warn on duplicate rule IDs
    const ids = policy.rules.map((r) => r.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    for (const dup of [...new Set(duplicates)]) {
      warnings.push(`Duplicate rule id "${dup}" — only the first occurrence will match.`);
    }

    return { valid: true, errors: [], warnings };
  } else {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`
    );
    return { valid: false, errors, warnings: [] };
  }
}
