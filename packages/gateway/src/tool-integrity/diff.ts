// Safe, bounded, field-level drift explanation (Milestone 6, ADR-0012).
//
// Compares two already-canonicalized (secret-redacted, bounded, key-sorted)
// tool definitions — e.g. `trusted_definition_json` vs `candidate_definition_json`
// from ToolIntegrityState — and produces a deterministic list of structured
// "change" records describing WHAT changed, not whether it is dangerous.
// Classification (added/removed/changed) is intentionally separate from
// risk judgment: this module never assigns a severity or blocks anything —
// enforcement.ts alone decides what may be called, purely from stored
// status/fingerprint, never from a diff's shape.
//
// This module is pure and side-effect-free: no I/O, no MCP SDK, no
// execution. It never renders raw HTML/Markdown and never interprets a
// definition's *content* as executable in any way (a description or schema
// value is always treated as inert display text).
import type { ToolIntegrityStatus } from './types.js';

/** Hard bounds — independent of canonicalize.ts's own bounds, since a diff walks TWO already-bounded trees together and must still bound its own output size. */
const MAX_CHANGES = 200;
const MAX_PATH_DEPTH = 12;
const MAX_VALUE_PREVIEW_CHARS = 300;
const MAX_PATH_SEGMENTS_DISPLAYED = 40;

export type DriftChangeKind =
  | 'field_added'
  | 'field_removed'
  | 'value_changed'
  | 'type_changed'
  | 'array_length_changed';

export interface DriftChange {
  /** Dot/bracket JSON-path to the changed field, e.g. "inputSchema.properties.path.type". Bounded in depth and length — see truncated. */
  path: string;
  kind: DriftChangeKind;
  /** Safe, bounded, truncated string preview — never the raw unbounded value. Absent for field_removed's "after" or field_added's "before". */
  before?: string;
  after?: string;
}

export interface ToolDriftResult {
  ok: boolean;
  /** True if the two definitions are identical after canonicalization (should not normally be called in that case, but is safe and returns an empty change list). */
  identical?: boolean;
  changes?: DriftChange[];
  /** True if MAX_CHANGES was reached and the list was truncated — the full fingerprints (available separately) remain the authoritative signal even when this is true. */
  truncated?: boolean;
  error?: string;
}

function safePreview(value: unknown): string {
  let s: string;
  if (value === undefined) return '(undefined)';
  if (typeof value === 'string') {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = '(unserializable)';
    }
  }
  if (s.length > MAX_VALUE_PREVIEW_CHARS) {
    return s.slice(0, MAX_VALUE_PREVIEW_CHARS) + '…(truncated)';
  }
  return s;
}

function formatPath(segments: Array<string | number>): string {
  const shown = segments.length > MAX_PATH_SEGMENTS_DISPLAYED
    ? segments.slice(0, MAX_PATH_SEGMENTS_DISPLAYED)
    : segments;
  let out = '';
  for (const seg of shown) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      out += out.length === 0 ? seg : `.${seg}`;
    }
  }
  if (shown.length < segments.length) out += '…(path truncated)';
  return out || '(root)';
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Walks two already-canonicalized values in lockstep, collecting bounded,
 * ordered DriftChange records. Object keys are visited in sorted order
 * (both inputs are already key-sorted by canonicalize.ts, but this walk
 * re-sorts defensively rather than trusting that invariant, so the output
 * is deterministic even if ever called on non-canonicalized input).
 * Depth-bounded (MAX_PATH_DEPTH) and change-count-bounded (MAX_CHANGES) —
 * a value beyond the depth bound is reported as a single value_changed
 * at the bound rather than walked further, never silently dropped.
 */
function walk(before: unknown, after: unknown, segments: Array<string | number>, depth: number, changes: DriftChange[]): void {
  if (changes.length >= MAX_CHANGES) return;

  if (depth > MAX_PATH_DEPTH) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ path: formatPath(segments), kind: 'value_changed', before: safePreview(before), after: safePreview(after) });
    }
    return;
  }

  const beforeType = typeOf(before);
  const afterType = typeOf(after);

  if (beforeType !== afterType) {
    changes.push({ path: formatPath(segments), kind: 'type_changed', before: safePreview(before), after: safePreview(after) });
    return;
  }

  if (beforeType === 'array') {
    const b = before as unknown[];
    const a = after as unknown[];
    if (b.length !== a.length) {
      changes.push({ path: formatPath(segments), kind: 'array_length_changed', before: String(b.length), after: String(a.length) });
    }
    const len = Math.min(b.length, a.length);
    for (let i = 0; i < len && changes.length < MAX_CHANGES; i++) {
      walk(b[i], a[i], [...segments, i], depth + 1, changes);
    }
    return;
  }

  if (beforeType === 'object') {
    const b = before as Record<string, unknown>;
    const a = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    for (const key of keys) {
      if (changes.length >= MAX_CHANGES) return;
      const inBefore = Object.prototype.hasOwnProperty.call(b, key);
      const inAfter = Object.prototype.hasOwnProperty.call(a, key);
      const path = [...segments, key];
      if (inBefore && !inAfter) {
        changes.push({ path: formatPath(path), kind: 'field_removed', before: safePreview(b[key]) });
      } else if (!inBefore && inAfter) {
        changes.push({ path: formatPath(path), kind: 'field_added', after: safePreview(a[key]) });
      } else {
        walk(b[key], a[key], path, depth + 1, changes);
      }
    }
    return;
  }

  // Primitive (string/number/boolean/null/undefined)
  if (before !== after) {
    changes.push({ path: formatPath(segments), kind: 'value_changed', before: safePreview(before), after: safePreview(after) });
  }
}

/**
 * Compares two safe (already-canonicalized) tool definitions and returns a
 * bounded, deterministic, field-level diff. `before`/`after` should each be
 * the parsed `safeDefinition` (or `trusted_definition_json`/
 * `candidate_definition_json`) from canonicalize.ts/the registry — NOT raw
 * downstream tool objects, which must be canonicalized first. Fails closed
 * (ok:false) only for a structurally invalid input (not an object); an
 * empty/identical diff is a normal, successful `ok:true` result.
 */
export function diffToolDefinitions(before: unknown, after: unknown): ToolDriftResult {
  if (typeof before !== 'object' || before === null || typeof after !== 'object' || after === null) {
    return { ok: false, error: 'Both definitions must be objects to diff.' };
  }
  const changes: DriftChange[] = [];
  walk(before, after, [], 0, changes);
  return {
    ok: true,
    identical: changes.length === 0,
    changes,
    truncated: changes.length >= MAX_CHANGES,
  };
}

/** Convenience wrapper for JSON-string-stored definitions (as persisted in ToolIntegrityState). Fails closed on malformed JSON rather than throwing. */
export function diffStoredDefinitions(beforeJson: string | null, afterJson: string | null): ToolDriftResult {
  if (beforeJson === null || afterJson === null) {
    return { ok: false, error: 'Missing stored definition for diff.' };
  }
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(beforeJson);
    after = JSON.parse(afterJson);
  } catch {
    return { ok: false, error: 'Stored definition is not valid JSON.' };
  }
  return diffToolDefinitions(before, after);
}

/** A short, safe, human-readable summary line for a status transition — used by CLI/API/UI surfaces that need one line, not the full change list. Never includes raw hostile content beyond what's already redacted upstream. */
export function summarizeStatusTransition(before: ToolIntegrityStatus | null, after: ToolIntegrityStatus): string {
  if (before === null) return `First observed — new candidate (${after}).`;
  if (before === after) return `Status unchanged (${after}).`;
  return `Status changed: ${before} → ${after}.`;
}
