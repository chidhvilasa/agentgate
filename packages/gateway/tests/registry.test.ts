import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGatewayConfig } from '../src/config/registry.js';

describe('loadGatewayConfig — relative path resolution (Milestone 5 regression)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-registry-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(dir: string, extraFields = '') {
    const configPath = path.join(dir, 'agentgate.yml');
    fs.writeFileSync(
      configPath,
      `version: 1\npolicy: ./agentgate.policy.yml\ndb_path: ./agentgate.sqlite\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n${extraFields}`
    );
    return configPath;
  }

  it('resolves relative policy/db_path against the config file\'s own directory, not process.cwd()', () => {
    const configPath = writeConfig(tmpDir);
    const originalCwd = process.cwd();
    // Deliberately run from a DIFFERENT directory than the config file's
    // own — this is exactly the real-world scenario that was broken before
    // this fix: `agentgate start some/other/project/agentgate.yml` run from
    // anywhere other than that project's own directory.
    process.chdir(os.tmpdir());
    try {
      const config = loadGatewayConfig(configPath);
      expect(path.isAbsolute(config.policy)).toBe(true);
      expect(path.isAbsolute(config.db_path)).toBe(true);
      expect(config.policy).toBe(path.join(tmpDir, 'agentgate.policy.yml'));
      expect(config.db_path).toBe(path.join(tmpDir, 'agentgate.sqlite'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('leaves an already-absolute policy/db_path untouched', () => {
    const absPolicy = path.join(tmpDir, 'somewhere', 'policy.yml');
    const absDb = path.join(tmpDir, 'somewhere', 'db.sqlite');
    const configPath = path.join(tmpDir, 'agentgate.yml');
    fs.writeFileSync(
      configPath,
      `version: 1\npolicy: ${absPolicy.split(path.sep).join('/')}\ndb_path: ${absDb.split(path.sep).join('/')}\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n`
    );
    const config = loadGatewayConfig(configPath);
    // Compare resolved (native-separator) forms — the YAML source embeds
    // forward slashes for cross-platform safety, but an already-absolute
    // path (recognized as such by path.isAbsolute() regardless of slash
    // direction on Windows) is intentionally returned unchanged, not
    // re-normalized, so compare via path.resolve() on both sides.
    expect(path.resolve(config.policy)).toBe(path.resolve(absPolicy));
    expect(path.resolve(config.db_path)).toBe(path.resolve(absDb));
  });

  it('never resolves the special ":memory:" db_path sentinel as a file path', () => {
    const configPath = path.join(tmpDir, 'agentgate.yml');
    fs.writeFileSync(
      configPath,
      `version: 1\npolicy: ./agentgate.policy.yml\ndb_path: ":memory:"\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n`
    );
    const config = loadGatewayConfig(configPath);
    expect(config.db_path).toBe(':memory:');
  });

  it('works correctly when the config file path itself is relative', () => {
    writeConfig(tmpDir);
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const config = loadGatewayConfig('agentgate.yml');
      // Compared against fs.realpathSync(tmpDir), not the raw tmpDir string:
      // on macOS, os.tmpdir() returns a path under /var/folders/... that is
      // itself a symlink to /private/var/folders/...; process.chdir()+
      // process.cwd() (which loadGatewayConfig's path.resolve('agentgate.yml')
      // depends on) reports the OS-canonicalized (symlink-resolved) form.
      // AgentGate's own relative-path resolution is correctly resolving
      // against the real current working directory here — it is this test's
      // un-resolved tmpDir reference that needs the same canonicalization to
      // compare correctly, not a change to loadGatewayConfig() itself. A
      // no-op on Linux/Windows, where tmpDir already has no such symlink.
      const realTmpDir = fs.realpathSync(tmpDir);
      expect(config.policy).toBe(path.join(realTmpDir, 'agentgate.policy.yml'));
    } finally {
      process.chdir(originalCwd);
    }
  });
});
