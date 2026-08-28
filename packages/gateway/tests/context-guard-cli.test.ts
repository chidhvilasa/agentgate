// Context Guard CLI tests (Milestone 7, ADR-0013). Mirrors
// tool-integrity-cli.test.ts's structure — most coverage calls the
// exported `run*`/report functions directly (fast, in-process, matching
// the established convention: cli.ts owns console formatting/exit codes,
// context-guard/cli.ts owns the actual logic). A handful of tests spawn
// the REAL compiled `dist/cli.js` binary to prove help text, --json,
// human output, and exit codes work end-to-end through actual argv
// parsing, not just the underlying functions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  runContextStatus,
  runContextHistory,
  runContextExplain,
  runContextReset,
  runContextVerify,
  RESET_MEMORY_WARNING,
} from '../src/context-guard/cli.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import { createContext, appendContextLabels, closeOrExpireContext, recordCallEvaluation } from '../src/context-guard/state.js';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../');
const CLI_BIN = path.join(ROOT, 'packages/gateway/dist/cli.js');

function toYamlPath(p: string): string {
  return p.replace(/\\/g, '/');
}

let tmpDir: string;
let configPath: string;
let dbPath: string;

function writeConfig(): void {
  const policyPath = path.join(tmpDir, 'policy.yml');
  fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: allow\nrules: []\n');
  dbPath = path.join(tmpDir, 'db.sqlite');
  configPath = path.join(tmpDir, 'agentgate.yml');
  fs.writeFileSync(
    configPath,
    `version: 1\n` +
      `gateway_port: 4700\n` +
      `control_port: 4701\n` +
      `policy: ${toYamlPath(policyPath)}\n` +
      `db_path: ${toYamlPath(dbPath)}\n` +
      `context_guard:\n  mode: enforce\n` +
      `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["dummy.mjs"]\n`
  );
}

function seedOneContext(): string {
  const storage = new AuditStorage(dbPath);
  const { state } = createContext(storage, 'seeded-context-id-000001', 'srv:abc');
  appendContextLabels(storage, state.context_id, ['untrusted_content'], { sourceEventId: 'evt-1', toolName: 'fetch_ticket', reason: 'r' });
  storage.close();
  return state.context_id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-context-cli-'));
  writeConfig();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Context Guard CLI operations (ADR-0013)', () => {
  describe('status', () => {
    it('is read-only and returns an empty bounded report against a fresh database', () => {
      const storage = new AuditStorage(dbPath);
      storage.close();
      const report = runContextStatus(configPath);
      expect(report.contexts).toEqual([]);
      expect(report.total).toBe(0);
      expect(report.truncated).toBe(false);
    });

    it('lists a seeded context with labels and safe metadata', () => {
      const contextId = seedOneContext();
      const report = runContextStatus(configPath);
      expect(report.contexts).toHaveLength(1);
      expect(report.contexts[0].context_id).toBe(contextId);
      expect(report.contexts[0].labels).toEqual(['untrusted_content']);
      expect(report.contexts[0].server_identity).toBe('srv:abc');
    });

    it('filters by lifecycle state', () => {
      const storage = new AuditStorage(dbPath);
      createContext(storage, 'ctx-active', null);
      createContext(storage, 'ctx-closed', null);
      closeOrExpireContext(storage, 'ctx-closed', 'closed');
      storage.close();
      const report = runContextStatus(configPath, { state: 'closed' });
      expect(report.contexts.map((c) => c.context_id)).toEqual(['ctx-closed']);
    });

    it('bounds output and reports truncated:true when more contexts exist than the limit', () => {
      const storage = new AuditStorage(dbPath);
      for (let i = 0; i < 5; i++) createContext(storage, `ctx-${i}`, null);
      storage.close();
      const report = runContextStatus(configPath, { limit: 2 });
      expect(report.contexts).toHaveLength(2);
      expect(report.total).toBe(5);
      expect(report.truncated).toBe(true);
    });

    it('never starts a downstream server, discovers tools, or launches a process — purely a storage read', () => {
      // The configured downstream command ("dummy.mjs") does not exist —
      // if status ever tried to connect, this would throw/hang. It must
      // not, since it's read-only.
      expect(() => runContextStatus(configPath)).not.toThrow();
    });
  });

  describe('history', () => {
    it('returns deterministic, oldest-first, chain-verified transitions', () => {
      seedOneContext();
      const report = runContextHistory(configPath);
      expect(report.chain_valid).toBe(true);
      expect(report.events.map((e) => e.event_type)).toEqual(['context_created', 'label_added']);
    });

    it('scopes to one context id when given', () => {
      const storage = new AuditStorage(dbPath);
      createContext(storage, 'ctx-a', null);
      createContext(storage, 'ctx-b', null);
      storage.close();
      const report = runContextHistory(configPath, 'ctx-a');
      expect(report.events.every((e) => e.context_id === 'ctx-a')).toBe(true);
    });

    it('bounds history and marks it truncated', () => {
      const storage = new AuditStorage(dbPath);
      const { state } = createContext(storage, 'ctx-1', null);
      for (let i = 0; i < 5; i++) {
        appendContextLabels(storage, state.context_id, [`custom_label_${i}`], { sourceEventId: null, toolName: 'a', reason: 'r' });
      }
      storage.close();
      const report = runContextHistory(configPath, 'ctx-1', { limit: 2 });
      expect(report.events).toHaveLength(2);
      expect(report.truncated).toBe(true);
    });

    it('never includes raw arguments/results — context_events never stores them in the first place', () => {
      seedOneContext();
      const report = runContextHistory(configPath);
      const raw = JSON.stringify(report);
      expect(raw).not.toContain('raw_arguments');
    });
  });

  describe('explain', () => {
    it('returns ok:false for an unknown context id', () => {
      const storage = new AuditStorage(dbPath);
      storage.close();
      const report = runContextExplain(configPath, 'no-such-context');
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/No such context/);
    });

    it('explains current labels and which stored event established them (WITH evidence)', () => {
      const contextId = seedOneContext();
      const report = runContextExplain(configPath, contextId);
      expect(report.ok).toBe(true);
      expect(report.labels).toEqual(['untrusted_content']);
      expect(report.label_origins).toHaveLength(1);
      expect(report.label_origins![0].tool_name).toBe('fetch_ticket');
      expect(report.label_origins![0].source_event_id).toBe('evt-1');
    });

    it('reports latest_decision: null (not a fabricated hypothetical) when no call has ever been evaluated (WITHOUT evidence)', () => {
      const contextId = seedOneContext();
      const report = runContextExplain(configPath, contextId);
      expect(report.latest_decision).toBeNull();
    });

    it('reports the actual stored latest_decision when one was recorded', () => {
      const storage = new AuditStorage(dbPath);
      const { state } = createContext(storage, 'ctx-1', null);
      recordCallEvaluation(storage, state.context_id, { sourceEventId: 'evt-2', toolName: 'send_webhook', ruleId: 'deny-rule', action: 'deny', reason: 'blocked' });
      storage.close();
      const report = runContextExplain(configPath, 'ctx-1');
      expect(report.latest_decision).toEqual({ tool_name: 'send_webhook', rule_id: 'deny-rule', action: 'deny', reason: 'blocked', at: expect.any(String) });
    });
  });

  describe('reset', () => {
    it('requires a non-empty context id', () => {
      const report = runContextReset(configPath, '', 0, 'reason');
      expect(report.ok).toBe(false);
    });

    it('requires an exact non-negative integer revision', () => {
      const contextId = seedOneContext();
      const bad1 = runContextReset(configPath, contextId, 1.5, 'reason');
      expect(bad1.ok).toBe(false);
      const bad2 = runContextReset(configPath, contextId, -1, 'reason');
      expect(bad2.ok).toBe(false);
    });

    it('rejects a missing/empty reason', () => {
      const contextId = seedOneContext();
      const report = runContextReset(configPath, contextId, 1, '   ');
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/reason/);
    });

    it('rejects an oversized reason', () => {
      const contextId = seedOneContext();
      const report = runContextReset(configPath, contextId, 1, 'x'.repeat(2001));
      expect(report.ok).toBe(false);
    });

    it('rejects a stale revision', () => {
      const contextId = seedOneContext(); // revision is 1 after the seeded label
      const report = runContextReset(configPath, contextId, 0, 'stale attempt');
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/Stale revision/);
    });

    it('rejects reset on an already-closed context', () => {
      const storage = new AuditStorage(dbPath);
      createContext(storage, 'ctx-1', null);
      const closed = closeOrExpireContext(storage, 'ctx-1', 'closed')!;
      storage.close();
      const report = runContextReset(configPath, 'ctx-1', closed.revision, 'attempt after close');
      expect(report.ok).toBe(false);
      expect(report.error).toMatch(/already closed/);
    });

    it('succeeds with the exact revision and reason, appends history, and invalidates pending approvals', () => {
      const storage = new AuditStorage(dbPath);
      const { state } = createContext(storage, 'ctx-1', null);
      storage.insertEvent({
        id: 'evt-1',
        created_at: new Date().toISOString(),
        agent: { session_id: 'test', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
        tool_call: { tool: 'send_webhook', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
        status: 'PENDING_APPROVAL',
        decision: null,
        execution_succeeded: null,
        execution_error: null,
        duration_ms: null,
        arguments_redacted: false,
        result_redacted: false,
        result_blocked: false,
        result_finding_count: 0,
        error_redacted: false,
      });
      const approvalManager = new ApprovalManager(storage);
      const approval = approvalManager.create({
        event_id: 'evt-1',
        ttl_seconds: 60,
        proposed_action_display: 'send_webhook({})',
        policy_reason: 'requires approval',
        scope: 'send_webhook',
        contextBinding: { context_id: state.context_id, context_revision: 0, tool_fingerprint: null, argument_digest: null, contextual_rule_id: 'r1' },
      });
      approvalManager.destroy();
      storage.close();

      const report = runContextReset(configPath, 'ctx-1', 0, 'operator-requested CLI reset');
      expect(report.ok).toBe(true);
      expect(report.status).toBe('reset');
      expect(report.new_revision).toBe(1);
      expect(report.invalidated_approval_count).toBe(1);

      const verify = new AuditStorage(dbPath);
      expect(verify.getApproval(approval.id)!.status).toBe('DENIED');
      const history = runContextHistory(configPath, 'ctx-1');
      expect(history.events.map((e) => e.event_type)).toEqual(['context_created', 'context_reset']);
      verify.close();
    });

    it('never deletes prior history — a reset context still shows its full append-only log', () => {
      const contextId = seedOneContext(); // context_created + label_added, revision 1
      runContextReset(configPath, contextId, 1, 'reset after labels');
      const history = runContextHistory(configPath, contextId);
      expect(history.events.map((e) => e.event_type)).toEqual(['context_created', 'label_added', 'context_reset']);
    });

    it('RESET_MEMORY_WARNING states the actual, honest limitation', () => {
      expect(RESET_MEMORY_WARNING).toMatch(/cannot erase/);
      expect(RESET_MEMORY_WARNING).toMatch(/upstream LLM|MCP client/);
    });
  });

  describe('verify', () => {
    it('reports a valid empty chain', () => {
      const storage = new AuditStorage(dbPath);
      storage.close();
      const report = runContextVerify(configPath);
      expect(report.valid).toBe(true);
      expect(report.count).toBe(0);
      expect(report.limitation).toMatch(/tamper EVIDENCE, not non-repudiation/);
    });

    it('detects tampering (hash mismatch) and reports the failure', () => {
      seedOneContext();
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE context_events SET reason = 'TAMPERED' WHERE sequence_number = 1`).run();
      raw.close();
      const report = runContextVerify(configPath);
      expect(report.valid).toBe(false);
      expect(report.error).toMatch(/Tampering detected/);
    });

    it('detects a deleted row (sequence gap)', () => {
      // Three events (seq 1,2,3) so deleting the MIDDLE one leaves a real,
      // detectable gap — deleting the LAST row would leave no later row to
      // notice the missing predecessor, so this needs at least three.
      const storage = new AuditStorage(dbPath);
      const { state } = createContext(storage, 'ctx-1', null); // seq 1
      appendContextLabels(storage, state.context_id, ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' }); // seq 2
      appendContextLabels(storage, state.context_id, ['sensitive_data_accessed'], { sourceEventId: null, toolName: 'b', reason: 'r' }); // seq 3
      storage.close();
      const raw = new Database(dbPath);
      raw.prepare(`DELETE FROM context_events WHERE sequence_number = 2`).run();
      raw.close();
      const report = runContextVerify(configPath);
      expect(report.valid).toBe(false);
      expect(report.error).toMatch(/sequence gap/);
    });
  });

  describe('missing/corrupt database', () => {
    it('a missing config file throws (surfaced by cli.ts as a fatal error, exit 1)', () => {
      expect(() => runContextStatus(path.join(tmpDir, 'nonexistent.yml'))).toThrow();
    });
  });

  describe('config path resolution from a different working directory', () => {
    it('resolves db_path relative to the CONFIG file location, not process.cwd()', () => {
      seedOneContext();
      const originalCwd = process.cwd();
      process.chdir(os.tmpdir());
      try {
        const report = runContextStatus(configPath);
        expect(report.contexts).toHaveLength(1);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('real compiled binary — help/read-only smoke (packaged-artifact coverage)', () => {
    it('agentgate context --help exits 0 and states the conservative-observation wording', () => {
      const out = execFileSync('node', [CLI_BIN, 'context', '--help'], { encoding: 'utf-8' });
      expect(out).toMatch(/conservative/i);
      expect(out).toMatch(/never proof|never.*that a model/i);
    });

    it('agentgate context status --json against a real seeded database exits 0 with valid JSON', () => {
      seedOneContext();
      const out = execFileSync('node', [CLI_BIN, 'context', 'status', '--config', configPath, '--json'], { encoding: 'utf-8' });
      const parsed = JSON.parse(out) as { contexts: unknown[] };
      expect(Array.isArray(parsed.contexts)).toBe(true);
      expect(parsed.contexts).toHaveLength(1);
    });

    it('agentgate context verify against a valid chain exits 0; a bogus config path exits 1', () => {
      seedOneContext();
      // Exit 0 case — execFileSync would throw on non-zero exit.
      expect(() => execFileSync('node', [CLI_BIN, 'context', 'verify', '--config', configPath], { encoding: 'utf-8' })).not.toThrow();

      let threw = false;
      try {
        execFileSync('node', [CLI_BIN, 'context', 'status', '--config', path.join(tmpDir, 'no-such.yml')], { encoding: 'utf-8', stdio: 'pipe' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it('agentgate context reset with a stale revision exits non-zero', () => {
      const contextId = seedOneContext();
      let threw = false;
      try {
        execFileSync('node', [CLI_BIN, 'context', 'reset', contextId, '--revision', '0', '--reason', 'stale', '--config', configPath], { encoding: 'utf-8', stdio: 'pipe' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it('read-only commands never start a downstream server — the configured "dummy.mjs" command does not exist, and status/history/verify complete without trying to launch it', () => {
      seedOneContext();
      expect(() => execFileSync('node', [CLI_BIN, 'context', 'status', '--config', configPath], { encoding: 'utf-8', timeout: 10000 })).not.toThrow();
      expect(() => execFileSync('node', [CLI_BIN, 'context', 'history', '--config', configPath], { encoding: 'utf-8', timeout: 10000 })).not.toThrow();
      expect(() => execFileSync('node', [CLI_BIN, 'context', 'verify', '--config', configPath], { encoding: 'utf-8', timeout: 10000 })).not.toThrow();
    });
  });
});
