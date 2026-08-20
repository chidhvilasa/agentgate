import { describe, it, expect } from 'vitest';
import { detectSecrets, redactSecrets, redactField, redactArgumentsForAudit } from '../src/transformation.js';

describe('detectSecrets', () => {
  it('detects OpenAI API keys', () => {
    expect(detectSecrets('Authorization: sk-abc123xyz456abc123xyz456abc123xyz456abc')).toBe(true);
  });

  it('detects bearer tokens', () => {
    expect(detectSecrets('Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc')).toBe(true);
  });

  it('detects AWS access keys', () => {
    expect(detectSecrets('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('detects GitHub PATs', () => {
    expect(detectSecrets('token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890')).toBe(true);
  });

  it('does not flag benign strings', () => {
    expect(detectSecrets('Hello, world! Reading README.md')).toBe(false);
    expect(detectSecrets('npm install react')).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('replaces secret patterns with REDACTED', () => {
    const input = 'key=sk-abc123xyz456abc123xyz456abc123xyz456abc end';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk-abc123xyz');
    expect(result).toContain('[REDACTED]');
  });
});

describe('redactField', () => {
  it('redacts a top-level field', () => {
    const args = { password: 'secret123', username: 'alice' };
    const result = redactField(args, 'password');
    expect(result.password).toBe('[REDACTED]');
    expect(result.username).toBe('alice');
  });

  it('redacts a nested field', () => {
    const args = { config: { api_key: 'sk-secret', timeout: 30 }, name: 'test' };
    const result = redactField(args, 'config.api_key');
    expect((result.config as Record<string, unknown>).api_key).toBe('[REDACTED]');
    expect((result.config as Record<string, unknown>).timeout).toBe(30);
    expect(result.name).toBe('test');
  });

  it('does not modify args if field does not exist', () => {
    const args = { foo: 'bar' };
    const result = redactField(args, 'nonexistent.field');
    expect(result).toEqual({ foo: 'bar' });
  });
});

describe('redactArgumentsForAudit', () => {
  it('marks wasRedacted when a secret is found', () => {
    const args = {
      url: 'https://api.openai.com',
      headers: { Authorization: 'Bearer sk-test1234567890abcdefghijklmnopqrstuvwxyz' },
    };
    const { redacted, wasRedacted } = redactArgumentsForAudit(args);
    expect(wasRedacted).toBe(true);
    const headers = redacted.headers as Record<string, unknown>;
    expect(headers.Authorization).toContain('[REDACTED]');
  });

  it('leaves clean args untouched', () => {
    const args = { path: '/home/user/project/src', mode: 'read' };
    const { redacted, wasRedacted } = redactArgumentsForAudit(args);
    expect(wasRedacted).toBe(false);
    expect(redacted).toEqual(args);
  });
});
