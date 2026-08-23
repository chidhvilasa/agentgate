import { describe, it, expect } from 'vitest';
import { sanitizeJsonValue, sanitizeErrorMessage } from '../src/output-sanitization.js';

// All credentials below are unmistakably synthetic (see security.yml's tracked-file
// secret-scan allowlist for the exact literals reused/added here). None of these
// strings resolve to a real credential of any kind.
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GITHUB_PAT = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890';
const OPENAI_KEY = 'sk-abc123xyz456abc123xyz456abc123xyz456abc';
const ANTHROPIC_KEY = 'sk-ant-FAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0';
const BEARER = 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc';

const OPTS = { maxDepth: 8, maxTextBytes: 1_000_000 };

describe('sanitizeJsonValue — text', () => {
  it('leaves plain benign text unchanged', () => {
    const r = sanitizeJsonValue('Hello, world! Reading README.md', OPTS);
    expect(r.value).toBe('Hello, world! Reading README.md');
    expect(r.changed).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.findings).toHaveLength(0);
  });

  it('redacts a synthetic AWS-style key', () => {
    const r = sanitizeJsonValue(`key=${AWS_KEY} end`, OPTS);
    expect(r.value).not.toContain(AWS_KEY);
    expect(r.value).toContain('[REDACTED]');
    expect(r.changed).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it('redacts a synthetic OpenAI-style key', () => {
    const r = sanitizeJsonValue(`Authorization: ${OPENAI_KEY}`, OPTS);
    expect(r.value).not.toContain(OPENAI_KEY);
    expect(r.changed).toBe(true);
  });

  it('redacts a synthetic Anthropic-style key', () => {
    const r = sanitizeJsonValue(`ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`, OPTS);
    expect(r.value).not.toContain(ANTHROPIC_KEY);
    expect(r.changed).toBe(true);
  });

  it('redacts a synthetic GitHub-style token', () => {
    const r = sanitizeJsonValue(`token ${GITHUB_PAT}`, OPTS);
    expect(r.value).not.toContain(GITHUB_PAT);
    expect(r.changed).toBe(true);
  });

  it('redacts a bearer token', () => {
    const r = sanitizeJsonValue(BEARER, OPTS);
    expect(r.value).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc');
    expect(r.changed).toBe(true);
  });

  it('redacts a password/token assignment', () => {
    const r = sanitizeJsonValue('password=hunter2ButActuallyLonger123', OPTS);
    expect(r.value).toContain('[REDACTED]');
    expect(r.changed).toBe(true);
  });

  it('redacts multiple distinct secrets in one string', () => {
    const r = sanitizeJsonValue(`${AWS_KEY} and also ${BEARER}`, OPTS);
    expect(r.value).not.toContain(AWS_KEY);
    expect(r.value).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc');
  });

  it('does not flag common false-positive-prone benign strings', () => {
    expect(sanitizeJsonValue('npm install react', OPTS).changed).toBe(false);
    expect(sanitizeJsonValue('the quick brown fox', OPTS).changed).toBe(false);
  });

  it('findings never contain the raw matched secret', () => {
    const r = sanitizeJsonValue(`key=${AWS_KEY}`, OPTS);
    const serializedFindings = JSON.stringify(r.findings);
    expect(serializedFindings).not.toContain(AWS_KEY);
    expect(r.findings[0]).toMatchObject({ category: 'secret_pattern', action: 'redacted' });
    expect(typeof r.findings[0].location).toBe('string');
  });
});

describe('sanitizeJsonValue — structured data', () => {
  it('deep-scans nested arrays and objects', () => {
    const input = { a: [{ b: { c: `leak=${AWS_KEY}` } }] };
    const r = sanitizeJsonValue(input, OPTS);
    expect(JSON.stringify(r.value)).not.toContain(AWS_KEY);
    expect(r.changed).toBe(true);
  });

  it('preserves numbers, booleans, and null untouched', () => {
    const input = { n: 42, b: true, z: null, s: 'clean' };
    const r = sanitizeJsonValue(input, OPTS);
    expect(r.value).toEqual(input);
    expect(r.changed).toBe(false);
  });

  it('preserves keys unless a redaction rule requires otherwise', () => {
    const input = { weird_key_name: 'clean value', another: { nested: 1 } };
    const r = sanitizeJsonValue(input, OPTS);
    expect(Object.keys(r.value as object)).toEqual(['weird_key_name', 'another']);
  });

  it('does not mutate the input object', () => {
    const input = { secret: `token=${AWS_KEY}`, clean: 'unchanged' };
    const snapshot = JSON.parse(JSON.stringify(input));
    sanitizeJsonValue(input, OPTS);
    expect(input).toEqual(snapshot);
  });

  it('handles arrays of arrays deterministically', () => {
    const input = [[1, 2], [`x=${AWS_KEY}`, 'clean']];
    const r1 = sanitizeJsonValue(input, OPTS);
    const r2 = sanitizeJsonValue(input, OPTS);
    expect(r1.value).toEqual(r2.value);
  });

  it('enforces maximum depth and marks the truncated subtree not_inspected', () => {
    let deep: unknown = `leak=${AWS_KEY}`;
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const r = sanitizeJsonValue(deep, { maxDepth: 3, maxTextBytes: 1_000_000 });
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.category === 'depth_limit')).toBe(true);
  });

  it('enforces maximum text size and does not scan oversized strings', () => {
    const huge = 'a'.repeat(2000) + AWS_KEY;
    const r = sanitizeJsonValue(huge, { maxDepth: 8, maxTextBytes: 100 });
    expect(r.value).toBe(huge); // unchanged — too large to safely scan
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.category === 'size_limit')).toBe(true);
  });

  it('detects and safely breaks a circular reference', () => {
    const obj: Record<string, unknown> = { name: 'root' };
    obj.self = obj;
    const r = sanitizeJsonValue(obj, OPTS);
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.category === 'circular_reference')).toBe(true);
    // Must not throw / hang, and must produce a JSON-serializable result.
    expect(() => JSON.stringify(r.value)).not.toThrow();
  });

  it('handles a __proto__-named key without polluting Object.prototype', () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "clean": "ok"}') as Record<string, unknown>;
    const r = sanitizeJsonValue(malicious, OPTS);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((r.value as Record<string, unknown>).clean).toBe('ok');
  });

  it('handles a constructor-named key safely', () => {
    const input = { constructor: { evil: true }, clean: 'ok' };
    const r = sanitizeJsonValue(input, OPTS);
    expect((r.value as Record<string, unknown>).clean).toBe('ok');
    // The result must still be a plain, usable object.
    expect(typeof r.value).toBe('object');
  });
});

describe('sanitizeErrorMessage', () => {
  it('sanitizes a downstream error containing a synthetic secret', () => {
    const r = sanitizeErrorMessage(new Error(`upstream said: ${AWS_KEY}`), { source: 'downstream' });
    expect(r.message).not.toContain(AWS_KEY);
    expect(r.redacted).toBe(true);
    expect(r.category).toBe('downstream');
  });

  it('handles a string thrown directly', () => {
    const r = sanitizeErrorMessage('plain string error', { source: 'internal' });
    expect(r.message).toBe('plain string error');
    expect(r.redacted).toBe(false);
  });

  it('handles an ordinary Error object', () => {
    const r = sanitizeErrorMessage(new Error('ECONNREFUSED'), { source: 'downstream' });
    expect(r.message).toBe('ECONNREFUSED');
  });

  it('handles a malicious object with a throwing message getter', () => {
    const evil = {
      get message(): string {
        throw new Error('gotcha');
      },
    };
    const r = sanitizeErrorMessage(evil, { source: 'downstream' });
    expect(r.message).toBe('Downstream tool execution failed; details were sanitized.');
  });

  it('truncates an overly long error message', () => {
    const long = 'x'.repeat(5000);
    const r = sanitizeErrorMessage(new Error(long), { source: 'downstream', maxLength: 100 });
    expect(r.message.length).toBeLessThan(200);
    expect(r.message).toContain('…[truncated]');
  });

  it('strips newlines and control characters (log-injection defense)', () => {
    const r = sanitizeErrorMessage(new Error('line one\nFAKE LOG LINE: admin logged in\r\nline two'), {
      source: 'downstream',
    });
    expect(r.message).not.toContain('\n');
    expect(r.message).not.toContain('\r');
  });

  it('falls back to a safe message for null/undefined', () => {
    expect(sanitizeErrorMessage(null, { source: 'internal' }).message).toBe(
      'Downstream tool execution failed; details were sanitized.'
    );
    expect(sanitizeErrorMessage(undefined, { source: 'internal' }).message).toBe(
      'Downstream tool execution failed; details were sanitized.'
    );
  });

  it('never returns the raw secret even when redaction occurs', () => {
    const r = sanitizeErrorMessage(new Error(`secret leaked: ${GITHUB_PAT}`), { source: 'downstream' });
    expect(r.message).not.toContain(GITHUB_PAT);
  });
});
