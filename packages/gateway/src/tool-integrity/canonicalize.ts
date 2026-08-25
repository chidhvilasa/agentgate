// Canonical tool-definition fingerprinting (Milestone 6, ADR-0012).
//
// The entire tool object as returned by the downstream server's
// `tools/list` is fingerprinted — every field present (name, title,
// description, inputSchema, outputSchema, annotations, and any other
// field a server includes, known or unknown) is included. Nothing is
// hand-picked or excluded, because a malicious server could otherwise
// smuggle a meaningful change through a field this project's authors
// didn't think to allowlist. "tool-definition-v1" names this algorithm;
// bump the version string (and the schema_version migration, see
// storage.ts) if the algorithm itself ever changes.
//
// This is a fingerprint, not a signature: it proves a definition is
// byte-for-byte identical (after safe canonicalization) to one seen
// before, using a local SHA-256 digest. It says nothing about who
// authored the definition, whether the server is trustworthy, or
// whether the server's runtime behavior matches its advertised
// definition. See ADR-0012 "Limitations" for the full statement.
import crypto from 'node:crypto';
import { sanitizeJsonValue } from '@agentgate/policy';

export const TOOL_DEFINITION_FINGERPRINT_VERSION = 'tool-definition-v1';

/** Hard, non-configurable safety bounds for canonicalizing one tool definition — independent of output_security's own (configurable, larger) bounds, since this path additionally needs to bound the cost of hashing/canonicalizing, not just of secret-scanning. */
const MAX_DEPTH = 12;
const MAX_TEXT_BYTES = 200_000;
/** Hard cap on a single tool definition's own JSON.stringify()'d size, checked before any further processing — a cheap, early reject for a maliciously huge definition. */
const MAX_DEFINITION_BYTES = 1_000_000;

export interface ToolCanonicalizeResult {
  ok: boolean;
  /** Present only when ok is true. */
  fingerprint?: string;
  /** Present only when ok is true — the exact canonical JSON string that was hashed (secret-redacted, bounded). */
  canonicalJson?: string;
  /** Present only when ok is true — the safe (secret-redacted, bounded) definition, suitable for display/diff/storage. Deep-equal to the parsed canonicalJson. */
  safeDefinition?: unknown;
  /** Present only when ok is false — a safe, bounded, non-leaking reason. */
  error?: string;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Recursively sorts object keys (arrays keep their original order — order is semantically meaningful for arrays, e.g. `required` and JSON Schema `enum`, and is never reordered). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonicalizes and fingerprints one tool definition (the raw object as
 * returned by `tools/list`, e.g. `{ name, description, inputSchema, ... }`).
 *
 * Fails closed (`ok: false`) rather than guessing at a fingerprint for:
 * - a non-object value or one missing a non-empty string `name`;
 * - a value exceeding MAX_DEFINITION_BYTES once serialized;
 * - a value `sanitizeJsonValue()` had to bound/block for depth, size, node
 *   budget, a circular reference, or a prototype-pollution-shaped key.
 *
 * Secret-shaped substrings anywhere in the definition are redacted via the
 * same canonical secret detector used for output security (ADR-0009)
 * *before* the fingerprint is computed. This means a change confined
 * entirely to a redacted secret's characters (with everything else
 * byte-identical) will not by itself change the fingerprint — a narrow,
 * deliberate, documented trade-off (ADR-0012) in exchange for a single,
 * already-audited sanitization pass that guarantees the same safe value is
 * both fingerprinted and ever displayed.
 */
export function canonicalizeToolDefinition(rawTool: unknown): ToolCanonicalizeResult {
  if (typeof rawTool !== 'object' || rawTool === null || Array.isArray(rawTool)) {
    return { ok: false, error: 'Tool definition is not a JSON object.' };
  }
  const name = (rawTool as Record<string, unknown>).name;
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, error: 'Tool definition has no non-empty string "name".' };
  }

  let roughSize: number;
  try {
    roughSize = byteLength(JSON.stringify(rawTool));
  } catch {
    return { ok: false, error: 'Tool definition is not JSON-serializable.' };
  }
  if (roughSize > MAX_DEFINITION_BYTES) {
    return { ok: false, error: `Tool definition exceeds the maximum allowed size (${MAX_DEFINITION_BYTES} bytes).` };
  }

  const sanitized = sanitizeJsonValue(rawTool, { maxDepth: MAX_DEPTH, maxTextBytes: MAX_TEXT_BYTES });
  // `sanitizeJsonValue()` marks `blocked: true` both for a genuine safety
  // failure (depth/size/node-budget/circular-reference/unsafe-key/unknown-
  // content) AND for a successful, intentional secret redaction
  // (`secret_pattern`) — the latter is expected, safe, normal behavior for
  // a tool definition that happens to contain secret-shaped text, not a
  // reason to fail the whole scan closed. Only the genuine safety
  // categories fail canonicalization here.
  const unsafeCategories = sanitized.findings
    .map((f) => f.category)
    .filter((c) => c !== 'secret_pattern');
  if (unsafeCategories.length > 0) {
    const categories = [...new Set(unsafeCategories)].join(', ');
    return { ok: false, error: `Tool definition failed safe canonicalization (${categories}).` };
  }

  const safeDefinition = sortKeysDeep(sanitized.value);
  const canonicalJson = JSON.stringify(safeDefinition);
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${TOOL_DEFINITION_FINGERPRINT_VERSION}\n${canonicalJson}`, 'utf8')
    .digest('hex');

  return { ok: true, fingerprint, canonicalJson, safeDefinition };
}

export interface ManifestCanonicalizeResult {
  ok: boolean;
  manifestFingerprint?: string;
  /** Per-tool results, sorted by tool name (case-sensitive) for a stable manifest fingerprint regardless of the order the server returned them in. */
  tools?: Array<{ name: string } & ToolCanonicalizeResult>;
  error?: string;
}

/**
 * Canonicalizes an entire tool manifest (the full `tools/list` result,
 * across all pages). Detects duplicate tool names (including a
 * case-sensitivity check — MCP tool names are case-sensitive per spec, so
 * "Foo" and "foo" are distinct tools, but a server advertising both is
 * flagged as a confusable-name condition worth surfacing, not silently
 * accepted) and fails closed if any single tool fails to canonicalize.
 */
export function canonicalizeManifest(rawTools: unknown[]): ManifestCanonicalizeResult {
  if (!Array.isArray(rawTools)) {
    return { ok: false, error: 'Tool manifest is not an array.' };
  }

  const seenNames = new Map<string, number>();
  for (const t of rawTools) {
    const n = typeof t === 'object' && t !== null ? (t as Record<string, unknown>).name : undefined;
    if (typeof n === 'string') seenNames.set(n, (seenNames.get(n) ?? 0) + 1);
  }
  const duplicates = [...seenNames.entries()].filter(([, count]) => count > 1).map(([n]) => n);
  if (duplicates.length > 0) {
    return { ok: false, error: `Duplicate tool name(s) in manifest: ${duplicates.join(', ')}.` };
  }
  const lowerNames = new Map<string, string[]>();
  for (const n of seenNames.keys()) {
    const lower = n.toLowerCase();
    lowerNames.set(lower, [...(lowerNames.get(lower) ?? []), n]);
  }
  const confusable = [...lowerNames.values()].filter((names) => names.length > 1);
  if (confusable.length > 0) {
    return { ok: false, error: `Case-confusable duplicate tool name(s): ${confusable.map((g) => g.join('/')).join('; ')}.` };
  }

  const results: Array<{ name: string } & ToolCanonicalizeResult> = [];
  for (const t of rawTools) {
    const n = typeof t === 'object' && t !== null ? (t as Record<string, unknown>).name : undefined;
    const result = canonicalizeToolDefinition(t);
    results.push({ name: typeof n === 'string' ? n : '(unknown)', ...result });
    if (!result.ok) {
      return { ok: false, error: `Tool "${String(n)}" failed to canonicalize: ${result.error}` };
    }
  }

  results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const manifestMaterial = results.map((r) => `${r.name}:${r.fingerprint}`).join('\n');
  const manifestFingerprint = crypto
    .createHash('sha256')
    .update(`${TOOL_DEFINITION_FINGERPRINT_VERSION}\n${manifestMaterial}`, 'utf8')
    .digest('hex');

  return { ok: true, manifestFingerprint, tools: results };
}
