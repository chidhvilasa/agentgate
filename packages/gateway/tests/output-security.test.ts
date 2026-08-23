import { describe, it, expect } from 'vitest';
import { sanitizeToolResult } from '../src/output-security.js';
import type { OutputSecurityConfig } from '../src/config/registry.js';

// Synthetic-only credential, reused from the allowlisted policy test fixtures.
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

const REDACT_CONFIG: OutputSecurityConfig = {
  mode: 'redact',
  opaque_content: 'allow_uninspected',
  max_depth: 8,
  max_text_bytes: 1_000_000,
};

const BLOCK_CONFIG: OutputSecurityConfig = { ...REDACT_CONFIG, mode: 'block' };

describe('sanitizeToolResult — text content', () => {
  it('forwards a clean text result unchanged', () => {
    const result = { content: [{ type: 'text', text: 'Hello, world!' }] };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    expect(r.result).toEqual(result);
    expect(r.redacted).toBe(false);
    expect(r.blocked).toBe(false);
  });

  it('redacts a secret in text content', () => {
    const result = { content: [{ type: 'text', text: `key=${AWS_KEY}` }] };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    const content = (r.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).not.toContain(AWS_KEY);
    expect(r.redacted).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.findingCount).toBeGreaterThan(0);
  });

  it('preserves content ordering across multiple blocks', () => {
    const result = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: `key=${AWS_KEY}` },
        { type: 'text', text: 'third' },
      ],
    };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    const content = (r.result as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe('first');
    expect(content[2].text).toBe('third');
  });
});

describe('sanitizeToolResult — structured content', () => {
  it('deep-scans structuredContent and redacts nested secrets', () => {
    const result = { content: [], structuredContent: { output: { token: `Bearer ${AWS_KEY}` }, count: 3 } };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    const sc = (r.result as { structuredContent: { output: { token: string }; count: number } }).structuredContent;
    expect(sc.token ?? sc.output.token).not.toContain(AWS_KEY);
    expect(sc.count).toBe(3);
    expect(r.redacted).toBe(true);
  });
});

describe('sanitizeToolResult — isError results', () => {
  it('sanitizes text content even when isError is true', () => {
    const result = { content: [{ type: 'text', text: `failed: ${AWS_KEY}` }], isError: true };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    const content = (r.result as { content: Array<{ text: string }>; isError: boolean }).content;
    expect(content[0].text).not.toContain(AWS_KEY);
    expect((r.result as { isError: boolean }).isError).toBe(true);
  });
});

describe('sanitizeToolResult — opaque binary content', () => {
  it('passes image content through completely untouched (byte-identical)', () => {
    const base64Data = Buffer.from('not-really-an-image').toString('base64');
    const result = { content: [{ type: 'image', data: base64Data, mimeType: 'image/png' }] };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    const content = (r.result as { content: Array<{ data: string }> }).content;
    expect(content[0].data).toBe(base64Data);
    expect(r.redacted).toBe(false);
  });

  it('passes audio content through untouched and never blocks purely for being opaque', () => {
    const base64Data = Buffer.from('not-really-audio').toString('base64');
    const result = { content: [{ type: 'audio', data: base64Data, mimeType: 'audio/wav' }] };
    const r = sanitizeToolResult(result, BLOCK_CONFIG);
    const content = (r.result as { content: Array<{ data: string }> }).content;
    expect(content[0].data).toBe(base64Data);
    expect(r.blocked).toBe(false);
  });

  it('passes an embedded resource blob through untouched', () => {
    const blob = Buffer.from('binary-ish').toString('base64');
    const result = { content: [{ type: 'resource', resource: { uri: 'file:///x.bin', blob } }] };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    const content = (r.result as { content: Array<{ resource: { blob: string } }> }).content;
    expect(content[0].resource.blob).toBe(blob);
  });

  it('scans embedded resource text content', () => {
    const result = { content: [{ type: 'resource', resource: { uri: 'file:///x.txt', text: `secret=${AWS_KEY}` } }] };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    const content = (r.result as { content: Array<{ resource: { text: string } }> }).content;
    expect(content[0].resource.text).not.toContain(AWS_KEY);
    expect(r.redacted).toBe(true);
  });
});

describe('sanitizeToolResult — unknown/extension fields', () => {
  it('passes an unrecognized content-block type through unmodified', () => {
    const result = { content: [{ type: 'tool_use', name: 'x', id: '1', input: {} }] };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    expect(r.result).toEqual(result);
  });

  it('passes top-level _meta through unmodified', () => {
    const result = { content: [{ type: 'text', text: 'ok' }], _meta: { progressToken: 'abc123' } };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    expect((r.result as { _meta: unknown })._meta).toEqual({ progressToken: 'abc123' });
  });

  it('passes an unrecognized top-level field through unmodified', () => {
    const result = { content: [], someFutureField: { anything: true } };
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    expect((r.result as { someFutureField: unknown }).someFutureField).toEqual({ anything: true });
  });

  it('passes a structurally unrecognized result through unmodified', () => {
    const result = 'not an object at all';
    const r = sanitizeToolResult(result, REDACT_CONFIG);
    expect(r.result).toBe(result);
    expect(r.blocked).toBe(false);
  });
});

describe('sanitizeToolResult — block mode', () => {
  it('replaces the whole result with a protocol-valid error when a secret is detected', () => {
    const result = { content: [{ type: 'text', text: `leak=${AWS_KEY}` }] };
    const r = sanitizeToolResult(result, BLOCK_CONFIG);
    expect(r.blocked).toBe(true);
    expect(r.redacted).toBe(false);
    const out = r.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(out.isError).toBe(true);
    expect(Array.isArray(out.content)).toBe(true);
    expect(out.content[0].type).toBe('text');
    expect(out.content[0].text).not.toContain(AWS_KEY);
  });

  it('does not block a clean result', () => {
    const result = { content: [{ type: 'text', text: 'all clean here' }] };
    const r = sanitizeToolResult(result, BLOCK_CONFIG);
    expect(r.blocked).toBe(false);
    expect(r.result).toEqual(result);
  });
});

describe('sanitizeToolResult — input immutability', () => {
  it('never mutates the original result object', () => {
    const result = { content: [{ type: 'text', text: `key=${AWS_KEY}` }] };
    const snapshot = JSON.parse(JSON.stringify(result));
    sanitizeToolResult(result, REDACT_CONFIG);
    expect(result).toEqual(snapshot);
  });
});
