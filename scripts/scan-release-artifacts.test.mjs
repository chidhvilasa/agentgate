// Tests for the release-artifact secret/local-path scanner (Milestone 8 /
// ADR-0014, Phase 7/9). Uses real temp fixture files — never mocks fs — so
// the test exercises the exact same code path the release workflow does.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanReleaseArtifacts } from './scan-release-artifacts.mjs';

describe('scanReleaseArtifacts (ADR-0014)', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes on a directory with only clean generated artifacts', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-scan-test-'));
    fs.writeFileSync(path.join(tmpDir, 'release-manifest.json'), JSON.stringify({ commit: 'abc123', packages: [{ name: '@agentgate/gateway', version: '0.1.0-beta.1' }] }));
    fs.writeFileSync(path.join(tmpDir, 'checksums.sha256'), 'deadbeef  some-file.tgz\n');
    const { ok, findings } = scanReleaseArtifacts(tmpDir);
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });

  it('flags a real-shaped AWS access key literal', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-scan-test-'));
    fs.writeFileSync(path.join(tmpDir, 'leak.json'), JSON.stringify({ key: 'AKIAABCDEFGHIJKLMNOP' }));
    const { ok, findings } = scanReleaseArtifacts(tmpDir);
    expect(ok).toBe(false);
    expect(findings.some((f) => f.type === 'credential-shaped-string')).toBe(true);
  });

  it('does NOT flag the documented, allowed placeholder AWS key literal', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-scan-test-'));
    fs.writeFileSync(path.join(tmpDir, 'example.json'), JSON.stringify({ key: 'AKIAIOSFODNN7EXAMPLE' }));
    const { ok, findings } = scanReleaseArtifacts(tmpDir);
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });

  it('flags a Windows-shaped local user path', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-scan-test-'));
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), 'C:\\Users\\alice\\project\\dist\\index.js');
    const { ok, findings } = scanReleaseArtifacts(tmpDir);
    expect(ok).toBe(false);
    expect(findings.some((f) => f.type === 'local-filesystem-path')).toBe(true);
  });

  it('flags a Unix-shaped local user/home path', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-scan-test-'));
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '/home/bob/repo/dist/index.js');
    const { ok, findings } = scanReleaseArtifacts(tmpDir);
    expect(ok).toBe(false);
    expect(findings.some((f) => f.type === 'local-filesystem-path')).toBe(true);
  });

  it('flags a GitHub personal access token literal', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-scan-test-'));
    fs.writeFileSync(path.join(tmpDir, 'oops.json'), 'ghp_' + 'a'.repeat(36));
    const { ok, findings } = scanReleaseArtifacts(tmpDir);
    expect(ok).toBe(false);
    expect(findings.some((f) => f.type === 'credential-shaped-string')).toBe(true);
  });

  it('a missing directory is treated as trivially clean (nothing to scan), never an error', () => {
    const { ok, findings } = scanReleaseArtifacts(path.join(os.tmpdir(), 'agentgate-definitely-does-not-exist-' + Date.now()));
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
  });

  it('recurses into subdirectories', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-scan-test-'));
    fs.mkdirSync(path.join(tmpDir, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'nested', 'deeper', 'leak.txt'), 'AKIAABCDEFGHIJKLMNOP');
    const { ok } = scanReleaseArtifacts(tmpDir);
    expect(ok).toBe(false);
  });
});
