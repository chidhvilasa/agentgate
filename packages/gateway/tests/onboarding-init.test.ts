import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit, buildConfigTemplate, buildPolicyTemplate } from '../src/onboarding/init.js';
import { loadGatewayConfig } from '../src/config/registry.js';
import { loadPolicyFile } from '@agentgate/policy';

describe('agentgate init (Milestone 5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-init-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes both files on a clean directory', () => {
    const result = runInit({ targetDir: tmpDir, force: false });
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.action)).toEqual(['written', 'written']);
    expect(fs.existsSync(path.join(tmpDir, 'agentgate.yml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'agentgate.policy.yml'))).toBe(true);
  });

  it('refuses to overwrite existing files without --force', () => {
    runInit({ targetDir: tmpDir, force: false });
    const before = fs.readFileSync(path.join(tmpDir, 'agentgate.yml'), 'utf-8');
    const second = runInit({ targetDir: tmpDir, force: false });
    expect(second.ok).toBe(false);
    expect(second.files.map((f) => f.action)).toEqual(['skipped-exists', 'skipped-exists']);
    const after = fs.readFileSync(path.join(tmpDir, 'agentgate.yml'), 'utf-8');
    expect(after).toBe(before);
  });

  it('overwrites existing files when --force is passed', () => {
    runInit({ targetDir: tmpDir, force: false });
    fs.writeFileSync(path.join(tmpDir, 'agentgate.yml'), 'corrupted');
    const result = runInit({ targetDir: tmpDir, force: true });
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.action)).toEqual(['written', 'written']);
    const content = fs.readFileSync(path.join(tmpDir, 'agentgate.yml'), 'utf-8');
    expect(content).not.toBe('corrupted');
  });

  it('creates the target directory if it does not exist yet', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    const result = runInit({ targetDir: nested, force: false });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(nested, 'agentgate.yml'))).toBe(true);
  });

  it('works with a target directory path containing spaces and Unicode characters', () => {
    const target = path.join(tmpDir, 'my project 日本語 déjà vu');
    const result = runInit({ targetDir: target, force: false });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(target, 'agentgate.yml'))).toBe(true);
  });

  it('only ever writes the two fixed, non-traversable file names inside targetDir (no attacker-controlled path segment exists in the public API)', () => {
    const result = runInit({ targetDir: tmpDir, force: false });
    const resolvedTmp = path.resolve(tmpDir);
    for (const f of result.files) {
      expect(f.path.startsWith(resolvedTmp + path.sep)).toBe(true);
      expect(f.relativePath).not.toContain('..');
    }
  });

  it('generated config is deterministic across two runs into different directories', () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    runInit({ targetDir: dirA, force: false });
    runInit({ targetDir: dirB, force: false });
    const a = fs.readFileSync(path.join(dirA, 'agentgate.yml'), 'utf-8');
    const b = fs.readFileSync(path.join(dirB, 'agentgate.yml'), 'utf-8');
    expect(a).toBe(b);
  });

  it('the generated policy parses successfully and is deny-by-default with exactly one narrow allow rule', () => {
    const result = runInit({ targetDir: tmpDir, force: false });
    const policyPath = result.files.find((f) => f.relativePath.endsWith('policy.yml'))!.path;
    const policy = loadPolicyFile(policyPath);
    expect(policy.defaults.decision).toBe('deny');
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].decision).toBe('allow');
    expect(policy.rules[0].tools).toEqual(['echo']);
  });

  it('the generated config parses successfully via the production loader', () => {
    const result = runInit({ targetDir: tmpDir, force: false });
    const configPath = result.files.find((f) => f.relativePath.endsWith('agentgate.yml'))!.path;
    const config = loadGatewayConfig(configPath);
    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].transport).toBe('stdio');
  });

  it('no token or secret literal appears in either generated file', () => {
    const configText = buildConfigTemplate();
    const policyText = buildPolicyTemplate();
    for (const text of [configText, policyText]) {
      expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(text).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);
      expect(text.toLowerCase()).not.toContain('auth_token');
      expect(text.toLowerCase()).not.toContain('x-agentgate-token');
    }
  });

  it('generated config never binds anywhere but loopback (no host/bind-address override present)', () => {
    const configText = buildConfigTemplate();
    expect(configText).not.toContain('0.0.0.0');
    expect(configText).not.toMatch(/host:\s*['"]?[^127]/); // no non-loopback host field at all
  });

  it('generates an explicit, high-security tool_integrity AND context_guard mode for new projects (Milestone 8 / ADR-0014) — never silently relies on the backwards-compat monitor default', () => {
    const result = runInit({ targetDir: tmpDir, force: false });
    const configPath = result.files.find((f) => f.relativePath.endsWith('agentgate.yml'))!.path;
    const config = loadGatewayConfig(configPath);
    expect(config.tool_integrity.mode).toBe('explicit');
    expect(config.context_guard.mode).toBe('enforce');
    // An empty rule set is schema-valid and enforces nothing until the operator
    // declares real tools/rules — "enforce" here must not itself break a brand
    // new, otherwise-untouched project.
    expect(config.context_guard.tools).toEqual({});
    expect(config.context_guard.rules).toEqual([]);
  });
});
