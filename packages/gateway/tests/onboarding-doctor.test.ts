import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../src/onboarding/doctor.js';
import { AuditStorage } from '../src/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('agentgate doctor (Milestone 5) — read-only, no-execution', () => {
  let tmpDir: string;
  let configPath: string;
  let policyPath: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-doctor-test-'));
    configPath = path.join(tmpDir, 'agentgate.yml');
    policyPath = path.join(tmpDir, 'policy.yml');
    dbPath = path.join(tmpDir, 'agentgate.sqlite');
    fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: deny\nrules:\n  - id: allow-echo\n    tools: ["echo"]\n    decision: allow\n');
    fs.writeFileSync(
      configPath,
      `version: 1\ngateway_port: 4310\ncontrol_port: 4311\npolicy: ${policyPath.split(path.sep).join('/')}\ndb_path: ${dbPath.split(path.sep).join('/')}\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: ["--version"]\n`
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports FAIL for config_exists and SKIPs dependent checks when the config is missing', async () => {
    const report = await runDoctor({ configPath: path.join(tmpDir, 'nope.yml') });
    expect(report.ok).toBe(false);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.config_exists.status).toBe('FAIL');
    expect(byId.audit_chain.status).toBe('SKIP');
  });

  it('reports PASS across the board for a fresh, valid, no-database project', async () => {
    const report = await runDoctor({ configPath });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.config_exists.status).toBe('PASS');
    expect(byId.policy_valid.status).toBe('PASS');
    expect(byId.db_writable.status).toBe('PASS');
    expect(byId.audit_chain.status).toBe('SKIP'); // no db yet
    expect(byId.node_version.status).toBe('PASS');
    expect(byId.loopback_binding.status).toBe('PASS');
    expect(byId.ports_available.status).toBe('PASS');
  });

  it('verifies a real audit chain when a valid database exists, without corrupting it', async () => {
    const storage = new AuditStorage(dbPath);
    storage.insertEvent({
      id: 'evt-1',
      created_at: new Date().toISOString(),
      agent: { session_id: 's', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'echo', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'SUCCEEDED',
      decision: { type: 'ALLOW', reason_code: 'POLICY_ALLOW', explanation: 'ok', matched_rule_id: 'allow-echo' },
      execution_succeeded: true,
      execution_error: null,
      duration_ms: 1,
      arguments_redacted: false,
      result_redacted: false,
      result_blocked: false,
      result_finding_count: 0,
      error_redacted: false,
    } as never);
    storage.close();

    const beforeStat = fs.statSync(dbPath);
    const report = await runDoctor({ configPath });
    const afterStat = fs.statSync(dbPath);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));

    expect(byId.audit_chain.status).toBe('PASS');
    expect(byId.audit_chain.message).toContain('1 records');
    // mtime should be unchanged — doctor must not have written to the file.
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('detects and reports a tampered chain as FAIL rather than silently passing', async () => {
    const storage = new AuditStorage(dbPath);
    storage.insertEvent({
      id: 'evt-1',
      created_at: new Date().toISOString(),
      agent: { session_id: 's', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'echo', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'SUCCEEDED',
      decision: { type: 'ALLOW', reason_code: 'POLICY_ALLOW', explanation: 'ok', matched_rule_id: 'allow-echo' },
      execution_succeeded: true,
      execution_error: null,
      duration_ms: 1,
      arguments_redacted: false,
      result_redacted: false,
      result_blocked: false,
      result_finding_count: 0,
      error_redacted: false,
    } as never);
    storage.close();

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.prepare(`UPDATE audit_lifecycle_records SET status = 'DENIED'`).run();
    db.close();

    const report = await runDoctor({ configPath });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.audit_chain.status).toBe('FAIL');
    expect(report.ok).toBe(false);
  });

  it('warns when the configured downstream command is unresolvable, without executing anything', async () => {
    fs.writeFileSync(
      configPath,
      `version: 1\ngateway_port: 4312\ncontrol_port: 4313\npolicy: ${policyPath.split(path.sep).join('/')}\ndb_path: ${dbPath.split(path.sep).join('/')}\nservers:\n  - id: s\n    transport: stdio\n    command: this-command-definitely-does-not-exist-anywhere\n    args: []\n`
    );
    const report = await runDoctor({ configPath });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.downstream_commands.status).toBe('WARN');
  });

  it('never imports node:child_process at all (structural no-execution guardrail)', () => {
    // Mirrors packages/gateway/tests/replay-no-execution.test.ts's approach
    // for the same reason: a runtime spy on an ESM named export cannot be
    // installed (Vitest: "Module namespace is not configurable in ESM"),
    // so the permanent guardrail here is structural — inspect the actual
    // `import` statements in doctor.ts's source, not just today's runtime
    // behavior. Comment prose is free to mention child_process; only real
    // import lines are checked.
    const source = fs.readFileSync(path.join(__dirname, '../src/onboarding/doctor.ts'), 'utf-8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');
    expect(importLines).not.toContain('child_process');
    expect(importLines).not.toContain('StdioClientTransport');
  });

  it('does not create any new file on disk as a side effect of running (beyond its own db-writable probe file, which it also removes)', async () => {
    const before = fs.readdirSync(tmpDir).sort();
    await runDoctor({ configPath });
    const after = fs.readdirSync(tmpDir).sort();
    expect(after).toEqual(before);
  });

  it('never prints a value resembling a secret or auth token anywhere in its output', async () => {
    const report = await runDoctor({ configPath });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(serialized.toLowerCase()).not.toContain('x-agentgate-token');
  });

  it('validates a supplied --client-config fixture without executing or modifying it', async () => {
    const clientConfigPath = path.join(tmpDir, 'client.json');
    fs.writeFileSync(clientConfigPath, JSON.stringify({ mcpServers: { agentgate: { command: 'node', args: [] } } }));
    const before = fs.readFileSync(clientConfigPath, 'utf-8');
    const report = await runDoctor({ configPath, clientConfigPath });
    const after = fs.readFileSync(clientConfigPath, 'utf-8');
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.client_integration.status).toBe('PASS');
    expect(after).toBe(before);
  });

  it('reports FAIL for a malformed --client-config fixture', async () => {
    const clientConfigPath = path.join(tmpDir, 'client.json');
    fs.writeFileSync(clientConfigPath, '{ not json');
    const report = await runDoctor({ configPath, clientConfigPath });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.client_integration.status).toBe('FAIL');
  });
});
