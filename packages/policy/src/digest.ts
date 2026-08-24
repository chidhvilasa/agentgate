/**
 * Safe policy digest for Safe Replay (ADR-0010).
 *
 * A replay evaluation records which policy it was evaluated against, but
 * never the raw policy file bytes — policy YAML is operator-authored config,
 * not expected to contain secrets, but hashing the parsed, canonicalized
 * structure (rather than including any raw content in a response/stored
 * record) keeps the guarantee structural rather than assumed.
 */
import crypto from 'node:crypto';
import type { Policy } from './schema.js';

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const sorted = Object.keys(obj)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k]));
  return '{' + sorted.join(',') + '}';
}

/**
 * Returns a short, safe, deterministic identifier for a parsed policy —
 * the first 16 hex characters of the SHA-256 digest of its canonicalized
 * (key-sorted) structure. Two policies with identical rules always produce
 * the same digest regardless of key order; any rule change changes it.
 */
export function computePolicyDigest(policy: Policy): string {
  const hash = crypto.createHash('sha256').update(canonicalize(policy), 'utf8').digest('hex');
  return hash.slice(0, 16);
}
