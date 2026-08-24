import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIntegration, applyIntegration, SUPPORTED_CLIENTS } from '../src/onboarding/integrate.js';

describe('agentgate integrate (Milestone 5)', () => {
  const cliPath = '/repo/packages/gateway/dist/cli.js';
  const configPath = '/repo/agentgate.yml';

  it('supports exactly the documented three clients', () => {
    expect(SUPPORTED_CLIENTS).toEqual(['claude-code', 'antigravity', 'generic']);
  });

  it.each(SUPPORTED_CLIENTS)('produces valid JSON with an mcpServers.agentgate entry for %s', (client) => {
    const result = buildIntegration({ client, configPath, cliPath });
    const parsed = JSON.parse(result.fileContent) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(parsed.mcpServers.agentgate.command).toBe('node');
    expect(parsed.mcpServers.agentgate.args).toContain('start');
    expect(parsed.mcpServers.agentgate.args).toContain(cliPath);
    expect(parsed.mcpServers.agentgate.args).toContain(configPath);
  });

  it('claude-code and antigravity are marked verified with a real cited source URL', () => {
    for (const client of ['claude-code', 'antigravity'] as const) {
      const result = buildIntegration({ client, configPath, cliPath });
      expect(result.verified).toBe(true);
      expect(result.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it('generic is explicitly marked NOT verified, with no source URL', () => {
    const result = buildIntegration({ client: 'generic', configPath, cliPath });
    expect(result.verified).toBe(false);
    expect(result.sourceUrl).toBeNull();
    expect(result.targetFileHint.toUpperCase()).toContain('GENERIC');
  });

  it('never embeds anything resembling an auth token or secret in the generated snippet', () => {
    for (const client of SUPPORTED_CLIENTS) {
      const result = buildIntegration({ client, configPath, cliPath });
      expect(result.fileContent.toLowerCase()).not.toContain('token');
      expect(result.fileContent).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });

  it('respects a custom server name', () => {
    const result = buildIntegration({ client: 'claude-code', configPath, cliPath, serverName: 'my-agentgate' });
    const parsed = JSON.parse(result.fileContent) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(['my-agentgate']);
  });

  it('handles a config/cli path containing spaces and Unicode characters', () => {
    const result = buildIntegration({
      client: 'claude-code',
      configPath: '/repo/my project 日本語/agentgate.yml',
      cliPath,
    });
    const parsed = JSON.parse(result.fileContent) as { mcpServers: { agentgate: { args: string[] } } };
    expect(parsed.mcpServers.agentgate.args).toContain('/repo/my project 日本語/agentgate.yml');
  });
});

describe('applyIntegration (Milestone 5) — explicit opt-in file mutation', () => {
  let tmpDir: string;
  let targetPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-apply-integration-'));
    targetPath = path.join(tmpDir, '.mcp.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new file when none exists', () => {
    const result = applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'node', args: [] }, dryRun: false });
    expect(result.wrote).toBe(true);
    expect(result.backupPath).toBeNull();
    expect(JSON.parse(fs.readFileSync(targetPath, 'utf-8'))).toEqual({ mcpServers: { agentgate: { command: 'node', args: [] } } });
  });

  it('preserves unrelated top-level keys and unrelated mcpServers entries', () => {
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } }, unrelatedTopLevelKey: 'keep-me' }, null, 2)
    );
    applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'node', args: [] }, dryRun: false });
    const after = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    expect(after.unrelatedTopLevelKey).toBe('keep-me');
    expect(after.mcpServers.other).toEqual({ command: 'x', args: [] });
    expect(after.mcpServers.agentgate).toEqual({ command: 'node', args: [] });
  });

  it('creates a timestamped backup of the original file before writing', () => {
    fs.writeFileSync(targetPath, JSON.stringify({ mcpServers: {} }));
    const result = applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'node', args: [] }, dryRun: false });
    expect(result.backupPath).not.toBeNull();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(fs.readFileSync(result.backupPath!, 'utf-8')).toBe(JSON.stringify({ mcpServers: {} }));
  });

  it('dry-run computes the result but writes nothing and creates no backup', () => {
    fs.writeFileSync(targetPath, JSON.stringify({ mcpServers: {} }));
    const before = fs.readFileSync(targetPath, 'utf-8');
    const result = applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'node', args: [] }, dryRun: true });
    expect(result.wrote).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe(before);
    const after = result.after as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers.agentgate).toBeDefined();
    // No stray backup or temp file left behind either.
    expect(fs.readdirSync(tmpDir)).toEqual(['.mcp.json']);
  });

  it('reports overwroteExisting: true when replacing an entry with the same server name', () => {
    fs.writeFileSync(targetPath, JSON.stringify({ mcpServers: { agentgate: { command: 'old', args: [] } } }));
    const result = applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'new', args: [] }, dryRun: false });
    expect(result.overwroteExisting).toBe(true);
  });

  it('refuses to modify a target file that is not valid JSON, rather than clobbering it', () => {
    fs.writeFileSync(targetPath, 'not json at all {{{');
    expect(() => applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'node', args: [] }, dryRun: false })).toThrow();
    // The file must be untouched after the refusal.
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('not json at all {{{');
  });

  it('refuses to modify a target file whose top level is not a JSON object', () => {
    fs.writeFileSync(targetPath, JSON.stringify(['not', 'an', 'object']));
    expect(() => applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'node', args: [] }, dryRun: false })).toThrow();
  });

  it('writes atomically — no leftover .tmp- file after a successful write', () => {
    applyIntegration({ targetPath, serverName: 'agentgate', entry: { command: 'node', args: [] }, dryRun: false });
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});
