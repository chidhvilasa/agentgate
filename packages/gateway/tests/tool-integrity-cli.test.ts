import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runToolsScan,
  runToolsStatus,
  runToolsDiff,
  runToolsTrust,
  runToolsReject,
  runToolsHistory,
} from '../src/tool-integrity/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/fixture-downstream-server.mjs');

/** Windows-safe YAML path: forward slashes only, avoids backslash-escape ambiguity in YAML. */
function toYamlPath(p: string): string {
  return p.replace(/\\/g, '/');
}

let tmpDir: string;
let configPath: string;
let dbPath: string;

function writeConfig(mode: string): void {
  const policyPath = path.join(tmpDir, 'policy.yml');
  fs.writeFileSync(policyPath, 'version: 1\ndefault_effect: deny\nrules: []\n');
  dbPath = path.join(tmpDir, 'db.sqlite');
  configPath = path.join(tmpDir, 'agentgate.yml');
  fs.writeFileSync(
    configPath,
    `version: 1\n` +
      `gateway_port: 4500\n` +
      `control_port: 4501\n` +
      `policy: ${toYamlPath(policyPath)}\n` +
      `db_path: ${toYamlPath(dbPath)}\n` +
      `tool_integrity:\n  mode: ${mode}\n` +
      `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["${toYamlPath(FIXTURE_SERVER)}"]\n`
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-tools-cli-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Tool Integrity CLI operations (ADR-0012, Phase 7)', () => {
  it('scan (explicit mode) discovers all fixture tools as pending_review candidates and never calls a tool', async () => {
    writeConfig('explicit');
    const report = await runToolsScan(configPath);
    expect(report.ok).toBe(true);
    expect(report.manifestOk).toBe(true);
    expect(report.toolCount).toBe(4);
    expect(report.outcomes.every((o) => o.status === 'pending_review')).toBe(true);
    expect(report.outcomes.map((o) => o.toolName).sort()).toEqual(['echo', 'error_result', 'leak_error', 'leak_secret']);
  }, 20000);

  it('scan (tofu mode) auto-trusts on first observation', async () => {
    writeConfig('tofu');
    const report = await runToolsScan(configPath);
    expect(report.ok).toBe(true);
    expect(report.outcomes.every((o) => o.status === 'trusted')).toBe(true);
  }, 20000);

  it('status is read-only and reflects the scanned state without triggering a new scan', async () => {
    writeConfig('explicit');
    await runToolsScan(configPath);
    const status = runToolsStatus(configPath);
    expect(status.tools).toHaveLength(4);
    expect(status.tools.every((t) => t.status === 'pending_review')).toBe(true);
    expect(status.tools.every((t) => t.candidate_id !== null)).toBe(true);
  }, 20000);

  it('diff shows the candidate as all field_added when there is no prior trusted baseline', async () => {
    writeConfig('explicit');
    await runToolsScan(configPath);
    const status = runToolsStatus(configPath);
    const echo = status.tools.find((t) => t.tool_name === 'echo')!;
    const diff = runToolsDiff(configPath, echo.candidate_id!);
    expect(diff.ok).toBe(true);
    expect(diff.toolName).toBe('echo');
    expect(diff.changes!.length).toBeGreaterThan(0);
    expect(diff.changes!.every((c) => c.kind === 'field_added')).toBe(true);
  }, 20000);

  it('diff fails closed for an unknown candidate id', async () => {
    writeConfig('explicit');
    await runToolsScan(configPath);
    const diff = runToolsDiff(configPath, 'deadbeefdeadbeef');
    expect(diff.ok).toBe(false);
    expect(diff.error).toMatch(/no pending candidate/i);
  }, 20000);

  it('trust requires the EXACT fingerprint — a wrong/stale fingerprint is rejected, not silently accepted', async () => {
    writeConfig('explicit');
    await runToolsScan(configPath);
    const status = runToolsStatus(configPath);
    const echo = status.tools.find((t) => t.tool_name === 'echo')!;

    const staleResult = runToolsTrust(configPath, echo.candidate_id!, 'not-the-real-fingerprint');
    expect(staleResult.ok).toBe(false);
    expect(staleResult.error).toMatch(/stale|unknown/i);

    // Confirm it is still pending after the failed attempt.
    const stillPending = runToolsStatus(configPath).tools.find((t) => t.tool_name === 'echo')!;
    expect(stillPending.status).toBe('pending_review');
  }, 20000);

  it('trust with the exact candidate id + fingerprint transitions the tool to trusted', async () => {
    writeConfig('explicit');
    await runToolsScan(configPath);
    const status = runToolsStatus(configPath);
    const echo = status.tools.find((t) => t.tool_name === 'echo')!;

    const result = runToolsTrust(configPath, echo.candidate_id!, echo.candidate_fingerprint!);
    expect(result.ok).toBe(true);

    const after = runToolsStatus(configPath).tools.find((t) => t.tool_name === 'echo')!;
    expect(after.status).toBe('trusted');
    expect(after.trusted_fingerprint).toBe(echo.candidate_fingerprint);
    expect(after.candidate_id).toBeNull();
  }, 20000);

  it('reject with the exact candidate id + fingerprint marks the tool rejected, and a later rescan with the SAME fingerprint does not silently re-trust it', async () => {
    writeConfig('explicit');
    await runToolsScan(configPath);
    const status = runToolsStatus(configPath);
    const echo = status.tools.find((t) => t.tool_name === 'echo')!;

    const result = runToolsReject(configPath, echo.candidate_id!, echo.candidate_fingerprint!, 'Looked suspicious.');
    expect(result.ok).toBe(true);

    const after = runToolsStatus(configPath).tools.find((t) => t.tool_name === 'echo')!;
    expect(after.status).toBe('rejected');
    expect(after.trusted_fingerprint).toBeNull();

    // Rescan (same fixture, same fingerprint) — must stay rejected, not silently trust.
    await runToolsScan(configPath);
    const afterRescan = runToolsStatus(configPath).tools.find((t) => t.tool_name === 'echo')!;
    expect(afterRescan.status).toBe('rejected');
  }, 20000);

  it('history returns the append-only event log with a valid hash chain', async () => {
    writeConfig('explicit');
    await runToolsScan(configPath);
    const status = runToolsStatus(configPath);
    const echo = status.tools.find((t) => t.tool_name === 'echo')!;
    runToolsTrust(configPath, echo.candidate_id!, echo.candidate_fingerprint!);

    const history = runToolsHistory(configPath);
    expect(history.chainValid).toBe(true);
    expect(history.events.length).toBeGreaterThan(0);
    expect(history.events.some((e) => e.event_type === 'accepted' && e.tool_name === 'echo')).toBe(true);

    const scoped = runToolsHistory(configPath, 'echo');
    expect(scoped.events.every((e) => e.tool_name === null || e.tool_name === 'echo')).toBe(true);
  }, 20000);
});
