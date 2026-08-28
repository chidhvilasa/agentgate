// Context Guard storage migration + tamper-evidence proof (Milestone 7,
// ADR-0013). Mirrors tool-integrity-storage-migration.test.ts's approach
// exactly (authentic migration-prefix fixture via `migrateThroughVersion`,
// direct field tampering without recomputing the hash, restart
// persistence) for the NEW context_events/context_state tables and the
// approvals binding columns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { AuditStorage, MIGRATION_VERSIONS } from '../src/storage.js';
import { createContext, appendContextLabels, recordCallEvaluation, resetContext } from '../src/context-guard/state.js';

const DB_PATH = './test-migration-context-guard.sqlite';

function cleanupDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function indexExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

describe('Context Guard storage migration and tamper-evidence (ADR-0013)', () => {
  beforeEach(cleanupDbFiles);
  afterEach(cleanupDbFiles);

  it('runs cleanly against a fresh database (context tables present, chain empty)', () => {
    const storage = new AuditStorage(DB_PATH);
    expect(storage.verifyContextChain()).toEqual({ valid: true, count: 0 });
    expect(storage.listContextEvents()).toEqual([]);
    expect(storage.listContextStates()).toEqual([]);
    storage.close();
  });

  it('migrates cleanly from an authentic Tool-Integrity-era database (predates Context Guard) exactly once, preserving prior data', () => {
    // 1. Build an authentic TOOL_INTEGRITY-era database — via the real
    //    production migration prefix, never a hand-copied schema or a
    //    MAX(version)-deletion trick (see the regression this pattern
    //    replaced in tool-integrity-storage-migration.test.ts).
    let storage = new AuditStorage(DB_PATH, { migrateThroughVersion: MIGRATION_VERSIONS.TOOL_INTEGRITY });

    {
      const raw = new Database(DB_PATH, { readonly: true });
      expect(tableExists(raw, 'context_events')).toBe(false);
      expect(tableExists(raw, 'context_state')).toBe(false);
      expect(columnExists(raw, 'approvals', 'context_id')).toBe(false);
      raw.close();
    }

    // 2. Representative prior data: a Tool-Integrity-era event and a
    //    pre-Context-Guard approval (raw INSERT using only the columns the
    //    approvals migration originally created — insertApproval() itself
    //    always writes the full current column list and would fail
    //    against this intentionally-capped fixture).
    storage.insertEvent({
      id: 'legacy-evt-1',
      created_at: '2026-01-01T00:00:00.000Z',
      agent: { session_id: 'legacy', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'legacy.tool', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'SUCCEEDED',
      decision: null,
      execution_succeeded: true,
      execution_error: null,
      duration_ms: 5,
      arguments_redacted: false,
      result_redacted: false,
      result_blocked: false,
      result_finding_count: 0,
      error_redacted: false,
    });
    storage.close();

    const legacyApprovalId = 'legacy-approval-1';
    {
      const rawInsert = new Database(DB_PATH);
      rawInsert
        .prepare(
          `INSERT INTO approvals (
            id, event_id, status, expires_at, consumed, proposed_action_display,
            policy_reason, scope, created_at, resolved_at, resolved_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(legacyApprovalId, 'legacy-evt-1', 'APPROVED', '2026-01-01T00:05:00.000Z', 1, 'legacy.tool({})', 'pre-Context-Guard approval', 'legacy.tool', '2026-01-01T00:00:30.000Z', '2026-01-01T00:01:00.000Z', 'human');
      rawInsert.close();
    }

    // 3. Re-open with the CURRENT AuditStorage — the pending Context Guard
    //    migration must run exactly once and recreate the new tables
    //    without disturbing prior data.
    storage = new AuditStorage(DB_PATH);
    expect(storage.getEvent('legacy-evt-1')).not.toBeNull();
    expect(storage.verifyChain()).toEqual({ valid: true, count: 1 });
    const reloadedApproval = storage.getApproval(legacyApprovalId)!;
    expect(reloadedApproval.status).toBe('APPROVED');
    expect(reloadedApproval.context_id).toBeNull(); // new binding columns default to NULL — "not context-bound", not lost.
    expect(reloadedApproval.context_revision).toBeNull();
    expect(reloadedApproval.tool_fingerprint).toBeNull();
    expect(reloadedApproval.argument_digest).toBeNull();
    expect(reloadedApproval.contextual_rule_id).toBeNull();

    {
      const raw = new Database(DB_PATH, { readonly: true });
      const versions = (raw.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(new Set(versions).size).toBe(versions.length); // exactly once each — Context Guard migration ran exactly once.

      expect(tableExists(raw, 'context_events')).toBe(true);
      expect(tableExists(raw, 'context_state')).toBe(true);
      expect(indexExists(raw, 'idx_context_events_context')).toBe(true);
      expect(columnExists(raw, 'approvals', 'context_id')).toBe(true);
      expect(columnExists(raw, 'approvals', 'context_revision')).toBe(true);
      expect(columnExists(raw, 'approvals', 'tool_fingerprint')).toBe(true);
      expect(columnExists(raw, 'approvals', 'argument_digest')).toBe(true);
      expect(columnExists(raw, 'approvals', 'contextual_rule_id')).toBe(true);
      raw.close();
    }

    // 4. New Context Guard activity works normally on the migrated database.
    const { state } = createContext(storage, 'ctx-1', null);
    expect(state.revision).toBe(0);
    expect(storage.verifyContextChain()).toEqual({ valid: true, count: 1 });
    storage.close();

    // 5. Reopening again is idempotent — no re-migration, no duplicate-column error.
    const reopened = new AuditStorage(DB_PATH);
    expect(reopened.verifyChain()).toEqual({ valid: true, count: 1 });
    expect(reopened.verifyContextChain()).toEqual({ valid: true, count: 1 });
    reopened.close();
  });

  it('restart continuation: the sequence and hash chain continue correctly across a process restart', () => {
    let storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    storage.close();

    storage = new AuditStorage(DB_PATH);
    appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' });
    const result = storage.verifyContextChain();
    expect(result).toEqual({ valid: true, count: 2 }); // context_created + label_added, across two process instances
    // Derived projection reflects the full history, not just this instance's writes.
    expect(storage.getContextState('ctx-1')!.labels).toEqual(['untrusted_content']);
    storage.close();
  });

  it('append-only transition history + derived projection: every state.ts transition type is independently recorded and the projection matches the log', () => {
    const storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: 'evt-a', toolName: 'fetch_ticket', reason: 'r1' });
    recordCallEvaluation(storage, 'ctx-1', { sourceEventId: 'evt-b', toolName: 'send_webhook', ruleId: 'deny-rule', action: 'deny', reason: 'blocked' });
    resetContext(storage, 'ctx-1', 1, 'cli', 'reset');

    const events = storage.listContextEvents({ contextId: 'ctx-1' });
    expect(events.map((e) => e.event_type)).toEqual(['context_created', 'label_added', 'call_evaluated', 'context_reset']);
    expect(storage.verifyContextChain()).toEqual({ valid: true, count: 4 });

    const state = storage.getContextState('ctx-1')!;
    expect(state.status).toBe('reset');
    expect(state.labels).toEqual([]); // reset cleared the projection
    expect(state.revision).toBe(2);
    storage.close();
  });

  it('detects tampering with a field value (hash mismatch)', () => {
    let storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    storage.close();

    const db = new Database(DB_PATH);
    db.prepare(`UPDATE context_events SET reason = 'TAMPERED' WHERE sequence_number = 1`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyContextChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Tampering detected/);
    storage.close();
  });

  it('detects a deleted row (sequence gap)', () => {
    let storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' });
    appendContextLabels(storage, 'ctx-1', ['sensitive_data_accessed'], { sourceEventId: null, toolName: 'b', reason: 'r' });
    storage.close();

    const db = new Database(DB_PATH);
    db.prepare(`DELETE FROM context_events WHERE sequence_number = 2`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyContextChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/sequence gap/);
    storage.close();
  });

  it('detects reordered/renumbered rows (hash chain broken even if sequence numbers look contiguous)', () => {
    let storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'first' });
    appendContextLabels(storage, 'ctx-1', ['sensitive_data_accessed'], { sourceEventId: null, toolName: 'b', reason: 'second' });
    storage.close();

    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN');
    db.prepare(`UPDATE context_events SET sequence_number = 99 WHERE sequence_number = 1`).run();
    db.prepare(`UPDATE context_events SET sequence_number = 1 WHERE sequence_number = 2`).run();
    db.prepare(`UPDATE context_events SET sequence_number = 2 WHERE sequence_number = 99`).run();
    db.exec('COMMIT');
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyContextChain();
    expect(result.valid).toBe(false);
    storage.close();
  });

  it('detects a corrupted/missing previous_event_hash link', () => {
    let storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' });
    storage.close();

    const db = new Database(DB_PATH);
    db.prepare(`UPDATE context_events SET previous_event_hash = 'not-the-real-hash' WHERE sequence_number = 2`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyContextChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/hash chain broken/);
    storage.close();
  });

  it('corrupt/malformed projection (labels_json) fails safely rather than crashing the whole process', () => {
    let storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    storage.close();

    const db = new Database(DB_PATH);
    db.prepare(`UPDATE context_state SET labels_json = 'not valid json{{' WHERE context_id = 'ctx-1'`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    expect(() => storage.getContextState('ctx-1')).toThrow(); // a parse error surfaces as a thrown exception, not a silently wrong/empty read.
    // The append-only log itself is untouched by state_projection corruption.
    expect(storage.verifyContextChain()).toEqual({ valid: true, count: 1 });
    storage.close();
  });

  it('upsertContextState is a true upsert: creating then updating the same context_id never produces a second row', () => {
    const storage = new AuditStorage(DB_PATH);
    createContext(storage, 'ctx-1', null);
    expect(storage.listContextStates()).toHaveLength(1);
    appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' });
    const states = storage.listContextStates();
    expect(states).toHaveLength(1); // still exactly one row — an update, not a second insert.
    expect(states[0].labels).toEqual(['untrusted_content']);
    storage.close();
  });

  it('transaction rollback: a migration failure inside runMigrations() does not leave a partially-applied Context Guard schema', () => {
    // Build a TOOL_INTEGRITY-era database, then pre-empt the Context Guard
    // migration's own ALTER TABLE so the full migration transaction fails
    // partway through — the CREATE TABLE statements earlier in that same
    // migration entry must not have been durably committed either, since
    // `runMigrations()` wraps each migration entry's entire SQL block in
    // one `db.transaction()`.
    const seed = new AuditStorage(DB_PATH, { migrateThroughVersion: MIGRATION_VERSIONS.TOOL_INTEGRITY });
    seed.close();

    const raw = new Database(DB_PATH);
    raw.exec('ALTER TABLE approvals ADD COLUMN context_id TEXT;'); // pre-empt the exact column the Context Guard migration will try to add
    raw.close();

    expect(() => new AuditStorage(DB_PATH)).toThrow(/duplicate column name/);

    // The transaction rolled back — context_events/context_state (created
    // earlier in the SAME migration statement block) must NOT exist,
    // proving the whole migration entry is atomic, not partially applied.
    const check = new Database(DB_PATH, { readonly: true });
    expect(tableExists(check, 'context_events')).toBe(false);
    expect(tableExists(check, 'context_state')).toBe(false);
    // schema_version must not record version 9 as applied, since it never committed.
    const versions = (check.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).not.toContain(9);
    check.close();
  });

  it('constructor closes the database handle on a Context Guard migration failure (no leaked lock)', () => {
    const seed = new AuditStorage(DB_PATH, { migrateThroughVersion: MIGRATION_VERSIONS.TOOL_INTEGRITY });
    seed.close();
    const raw = new Database(DB_PATH);
    raw.exec('ALTER TABLE approvals ADD COLUMN context_id TEXT;');
    raw.close();

    expect(() => new AuditStorage(DB_PATH)).toThrow();
    // Proof: the file is immediately deletable — no leaked handle.
    expect(() => cleanupDbFiles()).not.toThrow();
    expect(fs.existsSync(DB_PATH)).toBe(false);
  });
});
