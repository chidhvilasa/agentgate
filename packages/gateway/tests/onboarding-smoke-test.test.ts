import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSmokeTest } from '../src/onboarding/smokeTest.js';

describe('agentgate smoke-test (Milestone 5) — local, offline, self-cleaning', () => {
  it('passes end-to-end: allow, deny, redaction, and chain verification all succeed', async () => {
    const report = await runSmokeTest();
    expect(report.ok).toBe(true);
    const byId = Object.fromEntries(report.steps.map((s) => [s.id, s]));
    expect(byId.allowed_call.ok).toBe(true);
    expect(byId.denied_call.ok).toBe(true);
    expect(byId.secret_redaction.ok).toBe(true);
    expect(byId.audit_chain.ok).toBe(true);
    expect(byId.no_secret_in_storage.ok).toBe(true);
  });

  it('cleans up its temp directory on success — nothing new left in the OS temp dir', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));
    await runSmokeTest();
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('agentgate-smoke-test-') && !before.has(f));
    expect(after).toEqual([]);
  });

  it('is deterministic in outcome across repeated runs (same steps, same ok result)', async () => {
    const first = await runSmokeTest();
    const second = await runSmokeTest();
    expect(first.ok).toBe(second.ok);
    expect(first.steps.map((s) => s.id)).toEqual(second.steps.map((s) => s.id));
    expect(first.steps.map((s) => s.ok)).toEqual(second.steps.map((s) => s.ok));
  });

  it('never leaves a real synthetic-secret literal in its own report output', async () => {
    const report = await runSmokeTest();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('still cleans up its temp directory when an injected internal failure throws mid-run', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()));
    let capturedTmpDir: string | null = null;
    const realWriteFileSync = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
      // Let the first write (the policy file, inside the fresh tmpDir) through
      // so we can capture which directory this run is using, then force a
      // real, unhandled exception on it — simulating e.g. a disk error mid-run
      // — and confirm the try/finally cleanup still fires despite the throw.
      const filePath = String(file);
      if (filePath.endsWith('policy.yml')) {
        capturedTmpDir = path.dirname(filePath);
        throw new Error('injected failure: simulated disk error writing policy.yml');
      }
      return realWriteFileSync(file, ...(rest as Parameters<typeof realWriteFileSync>).slice(0));
    });

    await expect(runSmokeTest()).rejects.toThrow('injected failure');
    spy.mockRestore();

    expect(capturedTmpDir).not.toBeNull();
    expect(fs.existsSync(capturedTmpDir!)).toBe(false);
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('agentgate-smoke-test-') && !before.has(f));
    expect(after).toEqual([]);
  });
});
