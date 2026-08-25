import { describe, it, expect } from 'vitest';
import { canonicalizeToolDefinition, canonicalizeManifest, TOOL_DEFINITION_FINGERPRINT_VERSION } from '../src/tool-integrity/canonicalize.js';

const BASE_TOOL = {
  name: 'read_file',
  description: 'Reads a file from disk.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

describe('canonicalizeToolDefinition — golden fixtures (Milestone 6)', () => {
  it('is a named, versioned algorithm', () => {
    expect(TOOL_DEFINITION_FINGERPRINT_VERSION).toBe('tool-definition-v1');
  });

  it('object-key reorder does not change the fingerprint', () => {
    const a = canonicalizeToolDefinition({
      name: 'x',
      description: 'd',
      inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
    });
    const b = canonicalizeToolDefinition({
      inputSchema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' },
      description: 'd',
      name: 'x',
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('array reorder DOES change the fingerprint (order is semantically relevant, e.g. "required")', () => {
    const a = canonicalizeToolDefinition({ ...BASE_TOOL, inputSchema: { type: 'object', required: ['a', 'b'] } });
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, inputSchema: { type: 'object', required: ['b', 'a'] } });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('detects a description change', () => {
    const a = canonicalizeToolDefinition(BASE_TOOL);
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, description: 'Reads a file from disk, or deletes your entire home directory.' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('detects a title change', () => {
    const a = canonicalizeToolDefinition({ ...BASE_TOOL, title: 'Read File' });
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, title: 'Read Any File' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('detects an input schema change', () => {
    const a = canonicalizeToolDefinition(BASE_TOOL);
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, inputSchema: { type: 'object', properties: { path: { type: 'string' }, follow_symlinks: { type: 'boolean' } } } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('detects an output schema change (including its addition)', () => {
    const a = canonicalizeToolDefinition(BASE_TOOL);
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, outputSchema: { type: 'object', properties: { content: { type: 'string' } } } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('detects an annotations change', () => {
    const a = canonicalizeToolDefinition({ ...BASE_TOOL, annotations: { readOnlyHint: true, destructiveHint: false } });
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, annotations: { readOnlyHint: false, destructiveHint: true } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('detects a security-relevant _meta field change', () => {
    const a = canonicalizeToolDefinition({ ...BASE_TOOL, _meta: { 'vendor.risk': 'low' } });
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, _meta: { 'vendor.risk': 'high' } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('detects field removal (e.g. inputSchema.required silently dropped)', () => {
    const a = canonicalizeToolDefinition({ ...BASE_TOOL, inputSchema: { type: 'object', required: ['path'] } });
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, inputSchema: { type: 'object' } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const a = canonicalizeToolDefinition(BASE_TOOL);
    const b = canonicalizeToolDefinition(JSON.parse(JSON.stringify(BASE_TOOL)));
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('Unicode content is handled deterministically', () => {
    const a = canonicalizeToolDefinition({ ...BASE_TOOL, description: 'Café ☕ — 読み込み' });
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, description: 'Café ☕ — 読み込み' });
    expect(a.ok).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('CRLF vs LF line endings in description produce different fingerprints (no silent normalization that could mask a change)', () => {
    const a = canonicalizeToolDefinition({ ...BASE_TOOL, description: 'line1\nline2' });
    const b = canonicalizeToolDefinition({ ...BASE_TOOL, description: 'line1\r\nline2' });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('fails closed on a non-object value', () => {
    expect(canonicalizeToolDefinition('not an object').ok).toBe(false);
    expect(canonicalizeToolDefinition(null).ok).toBe(false);
    expect(canonicalizeToolDefinition([1, 2, 3]).ok).toBe(false);
  });

  it('fails closed on a missing or empty name', () => {
    expect(canonicalizeToolDefinition({ description: 'no name' }).ok).toBe(false);
    expect(canonicalizeToolDefinition({ name: '', description: 'empty name' }).ok).toBe(false);
  });

  it('fails closed on an oversized definition', () => {
    const huge = { ...BASE_TOOL, description: 'x'.repeat(2_000_000) };
    const result = canonicalizeToolDefinition(huge);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/size/i);
  });

  it('fails closed on excessive nesting depth', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50; i++) deep = { nested: deep };
    const result = canonicalizeToolDefinition({ ...BASE_TOOL, inputSchema: { type: 'object', properties: { deep } } });
    expect(result.ok).toBe(false);
  });

  it('fails closed on a prototype-pollution-shaped key', () => {
    const hostile = JSON.parse('{"name":"x","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const result = canonicalizeToolDefinition(hostile);
    expect(result.ok).toBe(false);
  });

  it('redacts a secret-shaped string in the description before fingerprinting/display, and never exposes it raw', () => {
    const withSecret = { ...BASE_TOOL, description: 'Uses key AKIAIOSFODNN7EXAMPLE for auth.' };
    const result = canonicalizeToolDefinition(withSecret);
    expect(result.ok).toBe(true);
    expect(result.canonicalJson).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(JSON.stringify(result.safeDefinition)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('never renders raw HTML/script tags unescaped in the stored canonical JSON (it is a JSON string, not HTML — safe by construction)', () => {
    const result = canonicalizeToolDefinition({ ...BASE_TOOL, description: '<script>alert(1)</script>' });
    expect(result.ok).toBe(true);
    // The literal characters are preserved (this is a JSON *string* value,
    // never interpreted as markup) — the safety guarantee is that nothing
    // downstream ever renders this as HTML, verified in the UI layer.
    expect(result.canonicalJson).toContain('<script>');
  });
});

describe('canonicalizeManifest — golden fixtures (Milestone 6)', () => {
  it('tool-list reorder does not change the manifest fingerprint', () => {
    const a = canonicalizeManifest([{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b', inputSchema: { type: 'object' } }]);
    const b = canonicalizeManifest([{ name: 'b', inputSchema: { type: 'object' } }, { name: 'a', inputSchema: { type: 'object' } }]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.manifestFingerprint).toBe(b.manifestFingerprint);
  });

  it('adding a tool changes the manifest fingerprint', () => {
    const a = canonicalizeManifest([{ name: 'a', inputSchema: { type: 'object' } }]);
    const b = canonicalizeManifest([{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b', inputSchema: { type: 'object' } }]);
    expect(a.manifestFingerprint).not.toBe(b.manifestFingerprint);
  });

  it('detects an exact-case duplicate tool name and fails closed', () => {
    const result = canonicalizeManifest([{ name: 'a', inputSchema: { type: 'object' } }, { name: 'a', inputSchema: { type: 'object' } }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/duplicate/i);
  });

  it('detects a case-confusable duplicate tool name and fails closed (MCP tool names are case-sensitive, so "Foo"/"foo" together is a red flag, not silently accepted)', () => {
    const result = canonicalizeManifest([{ name: 'Foo', inputSchema: { type: 'object' } }, { name: 'foo', inputSchema: { type: 'object' } }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/confusable/i);
  });

  it('fails closed if any single tool in the manifest fails to canonicalize', () => {
    const result = canonicalizeManifest([{ name: 'ok', inputSchema: { type: 'object' } }, { name: '' }]);
    expect(result.ok).toBe(false);
  });

  it('fails closed on a non-array manifest', () => {
    expect(canonicalizeManifest('not an array' as unknown as unknown[]).ok).toBe(false);
  });

  it('an empty manifest canonicalizes successfully with a stable fingerprint', () => {
    const a = canonicalizeManifest([]);
    const b = canonicalizeManifest([]);
    expect(a.ok).toBe(true);
    expect(a.manifestFingerprint).toBe(b.manifestFingerprint);
  });
});
