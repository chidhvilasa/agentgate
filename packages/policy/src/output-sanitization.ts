/**
 * Bidirectional output sanitization: deep JSON-value scanning/redaction and
 * canonical error-message sanitization.
 *
 * This module is protocol-agnostic — it knows nothing about MCP content
 * shapes (that lives in @chidhvilasa/gateway's output-security.ts, which calls
 * into sanitizeJsonValue() per MCP content block). It reuses the exact same
 * SECRET_PATTERNS-backed detectSecrets()/redactSecrets() already used for
 * inbound argument redaction (see ADR-0009) — there is deliberately no
 * second, divergent secret-pattern list.
 *
 * IMPORTANT: this is the same conservative, pattern-based detector used for
 * inbound arguments. It is not a general DLP or PII engine, does not scan
 * binary/opaque content, and can both miss unrecognized secret formats and
 * occasionally redact benign text that happens to match a pattern.
 */

import { detectSecrets, redactSecrets } from './transformation.js';

// ─── Shared Types ─────────────────────────────────────────────────────────────

export type SanitizationCategory =
  | 'secret_pattern'
  | 'opaque_binary'
  | 'unknown_content'
  | 'depth_limit'
  | 'size_limit'
  | 'node_budget'
  | 'circular_reference'
  | 'unsafe_key';

export type SanitizationAction = 'redacted' | 'blocked' | 'not_inspected';

/**
 * A single sanitization finding. NEVER contains the matched secret value or
 * any raw snippet of inspected content — only a safe structural location
 * (e.g. "content[0].text", "structuredContent.output.token") and a category/
 * action that reveal nothing about the actual secret.
 */
export interface SanitizationFinding {
  location: string;
  category: SanitizationCategory;
  action: SanitizationAction;
}

export interface SanitizationResult<T> {
  value: T;
  /** True if any leaf was redacted (secret found and replaced). */
  changed: boolean;
  /**
   * True if this value (or a nested part of it) could not be fully proven
   * safe — i.e. a secret was found, or inspection was truncated by a depth/
   * size/budget limit. The caller decides what "blocked" means for a whole
   * result; this per-value flag just reports whether *this* value contains
   * any finding a strict mode should treat as unsafe.
   */
  blocked: boolean;
  findings: SanitizationFinding[];
}

export interface SanitizeValueOptions {
  /** Maximum object/array nesting depth to actually inspect. */
  maxDepth: number;
  /** Maximum UTF-8 byte length of a single string leaf to actually scan. */
  maxTextBytes: number;
}

// ─── Internal Safety Helpers ──────────────────────────────────────────────────

/** Keys that must never be used as a plain assignment target (prototype pollution). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Total node-visit budget per sanitizeJsonValue() call, independent of the
 * caller-configured depth/size limits — a defense-in-depth cap against a
 * very wide (not deep) structure causing excessive work.
 */
const DEFAULT_MAX_NODES = 10_000;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Safely assigns a value onto a plain result object without ever touching
 * the prototype chain, even if `key` is "__proto__"/"constructor"/
 * "prototype". Object.defineProperty always creates a genuine own property
 * and never triggers Object.prototype's __proto__ accessor.
 */
function safeSet(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// ─── Deep JSON Value Sanitizer ────────────────────────────────────────────────

interface TraversalState {
  nodesVisited: number;
  visiting: WeakSet<object>;
  findings: SanitizationFinding[];
}

function sanitizeNode(
  value: unknown,
  location: string,
  depth: number,
  opts: SanitizeValueOptions,
  state: TraversalState
): { value: unknown; changed: boolean; blocked: boolean } {
  // Node budget: once exhausted, every remaining node is passed through
  // unmodified and marked not_inspected rather than throwing or hanging.
  if (state.nodesVisited >= DEFAULT_MAX_NODES) {
    state.findings.push({ location, category: 'node_budget', action: 'not_inspected' });
    return { value, changed: false, blocked: true };
  }
  state.nodesVisited++;

  if (value === null || value === undefined) {
    return { value, changed: false, blocked: false };
  }

  const t = typeof value;

  if (t === 'string') {
    const str = value as string;
    if (byteLength(str) > opts.maxTextBytes) {
      state.findings.push({ location, category: 'size_limit', action: 'not_inspected' });
      return { value: str, changed: false, blocked: true };
    }
    if (detectSecrets(str)) {
      const redacted = redactSecrets(str);
      state.findings.push({ location, category: 'secret_pattern', action: 'redacted' });
      return { value: redacted, changed: true, blocked: true };
    }
    return { value: str, changed: false, blocked: false };
  }

  if (t === 'number' || t === 'boolean') {
    return { value, changed: false, blocked: false };
  }

  if (t !== 'object') {
    // function, symbol, bigint — not JSON-representable; pass through
    // unmodified and flag as not inspected rather than guessing.
    state.findings.push({ location, category: 'unknown_content', action: 'not_inspected' });
    return { value, changed: false, blocked: true };
  }

  // From here, value is a non-null object or array.
  const obj = value;

  if (state.visiting.has(obj)) {
    state.findings.push({ location, category: 'circular_reference', action: 'not_inspected' });
    return { value: '[AgentGate: circular reference removed]', changed: true, blocked: true };
  }

  if (depth > opts.maxDepth) {
    state.findings.push({ location, category: 'depth_limit', action: 'not_inspected' });
    return { value, changed: false, blocked: true };
  }

  state.visiting.add(obj);
  try {
    if (Array.isArray(value)) {
      let changed = false;
      let blocked = false;
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const r = sanitizeNode(value[i], `${location}[${i}]`, depth + 1, opts, state);
        out.push(r.value);
        changed = changed || r.changed;
        blocked = blocked || r.blocked;
      }
      return { value: out, changed, blocked };
    }

    // Plain object — iterate own enumerable string keys only (never the
    // prototype chain), and write results back via a prototype-pollution-safe
    // setter regardless of key name.
    let changed = false;
    let blocked = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        state.findings.push({ location: `${location}.${key}`, category: 'unsafe_key', action: 'not_inspected' });
        blocked = true;
        // Still preserve the value (safely) — we do not silently drop data,
        // we just never let it reach the object's actual prototype.
        safeSet(out, key, (value as Record<string, unknown>)[key]);
        continue;
      }
      const r = sanitizeNode(
        (value as Record<string, unknown>)[key],
        `${location}.${key}`,
        depth + 1,
        opts,
        state
      );
      safeSet(out, key, r.value);
      changed = changed || r.changed;
      blocked = blocked || r.blocked;
    }
    return { value: out, changed, blocked };
  } finally {
    state.visiting.delete(obj);
  }
}

/**
 * Deep-sanitizes an arbitrary JSON-like value (string/number/boolean/null/
 * array/plain object). Never mutates the input. Deterministic: identical
 * input and options always produce identical output.
 *
 * Guarantees:
 * - no raw matched secret is ever placed in a finding;
 * - findings' `location` values are safe structural paths only;
 * - depth/size/node-count are bounded (see options and DEFAULT_MAX_NODES);
 * - circular references are detected and broken, never hung/crashed on;
 * - prototype-pollution-shaped keys (__proto__/constructor/prototype) are
 *   assigned via Object.defineProperty, never a plain bracket assignment,
 *   so they cannot silently repoint the result's actual prototype.
 */
export function sanitizeJsonValue(
  value: unknown,
  opts: SanitizeValueOptions,
  location = '$'
): SanitizationResult<unknown> {
  const state: TraversalState = { nodesVisited: 0, visiting: new WeakSet(), findings: [] };
  const result = sanitizeNode(value, location, 0, opts, state);
  return { value: result.value, changed: result.changed, blocked: result.blocked, findings: state.findings };
}

// ─── Error Message Sanitization ───────────────────────────────────────────────

export type ErrorSource = 'downstream' | 'internal';

export interface SanitizedError {
  /** Redacted, length-bounded, single-line-safe message. Safe to persist/log/render. */
  message: string;
  /** Whether the message actually contained a recognized secret pattern. */
  redacted: boolean;
  /** Where the error originated — informational only, never affects redaction. */
  category: ErrorSource;
}

const DEFAULT_MAX_ERROR_LENGTH = 2000;
const SAFE_FALLBACK_MESSAGE = 'Downstream tool execution failed; details were sanitized.';

/** Replaces control characters (including newlines) so a single log line stays single-line. */
function normalizeControlCharacters(s: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching control chars to strip them
  return s.replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
}

/**
 * Safely extracts a human-readable message from an arbitrary thrown value
 * without ever calling JSON.stringify on it or touching its stack trace.
 * Reading `.message` is wrapped in try/catch because a hostile object can
 * define a `message` getter that throws, loops, or is arbitrarily expensive.
 */
function extractRawMessage(err: unknown): string {
  try {
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.message;
    if (err && typeof err === 'object' && 'message' in err) {
      const m = err.message;
      if (typeof m === 'string') return m;
      return String(m);
    }
    if (err === null || err === undefined) return SAFE_FALLBACK_MESSAGE;
    return String(err);
  } catch {
    return SAFE_FALLBACK_MESSAGE;
  }
}

/**
 * Canonical error-message sanitizer. Apply this to EVERY downstream/internal
 * error before it is persisted, hash-chained, returned by the Control API,
 * pushed over SSE, rendered in the Control Center, or written to a gateway
 * log line (see ADR-0009). Never logs or stores the raw message first.
 */
export function sanitizeErrorMessage(
  err: unknown,
  opts: { source: ErrorSource; maxLength?: number } = { source: 'internal' }
): SanitizedError {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_ERROR_LENGTH;
  let raw: string;
  try {
    raw = normalizeControlCharacters(extractRawMessage(err));
  } catch {
    return { message: SAFE_FALLBACK_MESSAGE, redacted: false, category: opts.source };
  }

  if (!raw) raw = SAFE_FALLBACK_MESSAGE;

  const wasTooLong = byteLength(raw) > maxLength;
  const bounded = wasTooLong ? raw.slice(0, maxLength) + '…[truncated]' : raw;

  let redacted = false;
  let message = bounded;
  try {
    if (detectSecrets(bounded)) {
      message = redactSecrets(bounded);
      redacted = true;
    }
  } catch {
    return { message: SAFE_FALLBACK_MESSAGE, redacted: false, category: opts.source };
  }

  return { message, redacted, category: opts.source };
}
