/**
 * Secret detection and argument transformation/redaction.
 *
 * IMPORTANT: Redaction of audit records happens independently for EVERY
 * decision type — arguments are always redacted before persistence
 * regardless of whether the call is allowed or denied.
 *
 * For ALLOW_WITH_TRANSFORM decisions, secrets are also redacted from
 * the arguments BEFORE forwarding to the downstream server.
 */

// ─── Secret Patterns ──────────────────────────────────────────────────────────

/**
 * Patterns that indicate a string likely contains a secret.
 * Conservative: prefer false positives over false negatives for security.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Generic API key patterns
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{16,})/i,
  // Bearer tokens
  /bearer\s+([a-zA-Z0-9._\-]{16,})/i,
  // GitHub PATs (classic and fine-grained)
  /gh[pousr]_[a-zA-Z0-9]{36}/,
  /github_pat_[a-zA-Z0-9_]{82}/,
  // OpenAI keys
  /sk-[a-zA-Z0-9]{32,}/,
  // Anthropic keys
  /sk-ant-[a-zA-Z0-9\-_]{80,}/,
  // AWS keys
  /AKIA[0-9A-Z]{16}/,
  /(?:aws[_-]?secret|secret[_-]?access[_-]?key)\s*[:=]\s*['"]?([a-zA-Z0-9/+]{40})/i,
  // Generic password fields
  /(?:password|passwd|secret|token)\s*[:=]\s*['"]?([^\s'"]{8,})/i,
  // Private key headers
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/,
  // Database connection strings with credentials
  /(?:postgres|mysql|mongodb):\/\/[^:]+:[^@]{4,}@/i,
];

/**
 * Returns true if the text likely contains a secret.
 * This is used for policy matching (contains_secrets: true) and
 * for audit record pre-persistence scanning.
 */
export function detectSecrets(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// ─── Redaction ────────────────────────────────────────────────────────────────

const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * Redacts all detected secrets from a string.
 * Used for audit record preparation — NEVER logs raw secrets.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    // Use global flag variant to replace all occurrences
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    result = result.replace(globalPattern, REDACTION_PLACEHOLDER);
  }
  return result;
}

/**
 * Deep-redacts a specific field within a nested arguments object.
 * Used for ALLOW_WITH_TRANSFORM decisions where secrets are stripped
 * before forwarding to the downstream server.
 *
 * @param args - The argument object to transform
 * @param fieldPath - Dot-separated path, e.g. "env.SECRET_KEY" or "body"
 * @param placeholder - Replacement value (default: [REDACTED])
 */
export function redactField(
  args: Record<string, unknown>,
  fieldPath: string,
  placeholder: string = REDACTION_PLACEHOLDER
): Record<string, unknown> {
  const parts = fieldPath.split('.');
  const result = structuredClone(args);

  let current: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || typeof current[part] !== 'object') {
      // Path doesn't exist or is not traversable — nothing to redact
      return result;
    }
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart in current) {
    current[lastPart] = placeholder;
  }

  return result;
}

/**
 * Redacts all string values in an arguments object that contain secrets.
 * Used before persisting any audit event to SQLite.
 *
 * Returns both the redacted object and a flag indicating whether
 * any redaction was performed.
 */
export function redactArgumentsForAudit(
  args: Record<string, unknown>
): { redacted: Record<string, unknown>; wasRedacted: boolean } {
  let wasRedacted = false;

  function redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      const cleaned = redactSecrets(value);
      if (cleaned !== value) {
        wasRedacted = true;
        return cleaned;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = redactValue(v);
      }
      return result;
    }
    return value;
  }

  const redacted = redactValue(args) as Record<string, unknown>;
  return { redacted, wasRedacted };
}
