// Tool Integrity storage migration + tamper-evidence proof (Milestone 6,
// ADR-0012, Phase D). Mirrors storage-migration.test.ts's approach exactly
// (hand-crafted legacy-schema database, direct field tampering without
// recomputing the hash, restart persistence) for the NEW
// tool_integrity_events/tool_integrity_state tables.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { AuditStorage, MIGRATION_VERSIONS } from '../src/storage.js';

const DB_PATH = './test-migration-tool-integrity.sqlite';
const FAIL_DB_PATH = './test-migration-handle-leak.sqlite';

function cleanupDbFiles(dbPath: string = DB_PATH): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// ─── Raw-schema inspection helpers (read-only; never mutate) ──────────────────

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function indexExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  // PRAGMA does not accept bound parameters for the table name — `table`
  // is always one of this file's own hardcoded literals, never external
  // input.
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function schemaVersions(db: Database.Database): number[] {
  return (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>).map(
    (r) => r.version
  );
}

function seedOneEvent(storage: AuditStorage, overrides: Partial<Parameters<AuditStorage['insertToolIntegrityEvent']>[0]> = {}) {
  return storage.insertToolIntegrityEvent({
    created_at: new Date().toISOString(),
    event_type: 'manifest_scanned',
    server_identity: 'srv:abc',
    server_id: 'srv',
    tool_name: null,
    fingerprint: null,
    previous_fingerprint: null,
    manifest_fingerprint: 'mf1',
    state_before: null,
    state_after: null,
    reviewer: null,
    reason: null,
    definition_json: null,
    ...overrides,
  });
}

describe('Tool Integrity storage migration and tamper-evidence (ADR-0012)', () => {
  beforeEach(() => cleanupDbFiles(DB_PATH));
  afterEach(() => cleanupDbFiles(DB_PATH));

  it('runs cleanly against a fresh database (tables present, chain empty)', () => {
    const storage = new AuditStorage(DB_PATH);
    expect(storage.verifyToolIntegrityChain()).toEqual({ valid: true, count: 0 });
    expect(storage.listToolIntegrityEvents()).toEqual([]);
    expect(storage.listToolIntegrityState()).toEqual([]);
    storage.close();
  });

  it('migrates cleanly from a pre-Tool-Integrity, pre-Context-Guard database (an authentic SAFE_REPLAY-era fixture)', () => {
    // 1. Build an authentic pre-Tool-Integrity, pre-Context-Guard database
    //    by applying the REAL production migrations only through
    //    MIGRATION_VERSIONS.SAFE_REPLAY (the last migration before Tool
    //    Integrity) — via AuditStorage's own `migrateThroughVersion` option,
    //    which runs the exact same migration SQL production runs, just
    //    capped. This replaces the previous approach (build the LATEST
    //    schema, then delete the `schema_version` row for
    //    `MAX(version)`), which silently broke the moment Milestone 7
    //    appended the Context Guard migration after Tool Integrity's —
    //    `MAX(version)` stopped meaning "the Tool Integrity migration" and
    //    started meaning "the Context Guard migration", so this test used
    //    to roll back the WRONG migration and then replay the Context
    //    Guard one a second time (`duplicate column name: context_id`).
    //    Pinning an exact named version instead means this test stays
    //    correct no matter how many further migrations get appended later.
    let storage = new AuditStorage(DB_PATH, { migrateThroughVersion: MIGRATION_VERSIONS.SAFE_REPLAY });

    // Confirm the fixture truly lacks both later migrations' schema before
    // proceeding — a real assertion, not an assumption.
    {
      const raw = new Database(DB_PATH, { readonly: true });
      expect(tableExists(raw, 'tool_integrity_events')).toBe(false);
      expect(tableExists(raw, 'tool_integrity_state')).toBe(false);
      expect(tableExists(raw, 'context_events')).toBe(false);
      expect(tableExists(raw, 'context_state')).toBe(false);
      expect(columnExists(raw, 'approvals', 'context_id')).toBe(false);
      expect(schemaVersions(raw)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      raw.close();
    }

    // 2. Insert representative pre-migration data. audit_events already has
    //    its final shape by this version, so the legacy event goes through
    //    the REAL insertEvent() unchanged — authentic legacy data, not a
    //    hand-maintained copy. The legacy approval, however, predates the
    //    Context Guard binding columns entirely (they don't exist in the
    //    table yet at this capped version) — insertApproval() itself always
    //    writes the FULL current column list, so it can't be used against
    //    this intentionally-capped fixture. A raw INSERT naming only the
    //    original `approvals` migration's own columns is the authentic
    //    shape of a real pre-Milestone-7 approval row, not a copy of any
    //    OTHER table's schema.
    storage.insertEvent({
      id: 'legacy-evt-1',
      created_at: '2026-01-01T00:00:00.000Z',
      agent: { session_id: 'legacy', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'legacy.tool', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'SUCCEEDED',
      decision: null,
      execution_succeeded: true,
      execution_error: null,
      duration_ms: 10,
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
        .run(
          legacyApprovalId,
          'legacy-evt-1',
          'APPROVED',
          '2026-01-01T00:05:00.000Z',
          1,
          'legacy.tool({})',
          'legacy approval, predates the Context Guard binding columns',
          'legacy.tool',
          '2026-01-01T00:00:30.000Z',
          '2026-01-01T00:01:00.000Z',
          'human'
        );
      rawInsert.close();
    }

    // 3. Re-open with the CURRENT AuditStorage (full migration) — the
    //    pending Tool Integrity AND Context Guard migrations must both run,
    //    exactly once each, without disturbing the pre-existing data.
    storage = new AuditStorage(DB_PATH);
    expect(storage.verifyToolIntegrityChain()).toEqual({ valid: true, count: 0 });
    expect(storage.getEvent('legacy-evt-1')).not.toBeNull();
    expect(storage.getEvent('legacy-evt-1')?.tool_call.tool).toBe('legacy.tool');
    expect(storage.verifyChain()).toEqual({ valid: true, count: 1 }); // pre-existing audit chain unaffected

    const reloadedApproval = storage.getApproval(legacyApprovalId);
    expect(reloadedApproval).not.toBeNull();
    expect(reloadedApproval?.status).toBe('APPROVED');
    // A pre-Context-Guard approval's new binding columns default to NULL —
    // "not context-bound", never lost/corrupted/coerced to some other value.
    expect(reloadedApproval?.context_id).toBeNull();
    expect(reloadedApproval?.context_revision).toBeNull();
    expect(reloadedApproval?.tool_fingerprint).toBeNull();
    expect(reloadedApproval?.argument_digest).toBeNull();
    expect(reloadedApproval?.contextual_rule_id).toBeNull();

    // Each migration version recorded exactly once, all the way through
    // CONTEXT_GUARD — and the expected Tool Integrity / Context Guard
    // schema genuinely exists now.
    {
      const raw = new Database(DB_PATH, { readonly: true });
      const versions = schemaVersions(raw);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(new Set(versions).size).toBe(versions.length); // no duplicate version rows

      expect(tableExists(raw, 'tool_integrity_events')).toBe(true);
      expect(tableExists(raw, 'tool_integrity_state')).toBe(true);
      expect(indexExists(raw, 'idx_tool_integrity_events_server')).toBe(true);
      expect(indexExists(raw, 'idx_tool_integrity_events_tool')).toBe(true);

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

    // 4. New Tool Integrity activity works normally on the migrated database.
    const inserted = seedOneEvent(storage);
    expect(inserted.sequence_number).toBe(1);
    expect(inserted.previous_event_hash).toBeNull();
    expect(storage.verifyToolIntegrityChain()).toEqual({ valid: true, count: 1 });
    storage.close();

    // 5. Reopening the migrated database again is idempotent — no
    //    migration re-runs, no duplicate-column error, prior data intact.
    const reopened = new AuditStorage(DB_PATH);
    expect(reopened.verifyChain()).toEqual({ valid: true, count: 1 });
    expect(reopened.verifyToolIntegrityChain()).toEqual({ valid: true, count: 1 });
    {
      const raw = new Database(DB_PATH, { readonly: true });
      expect(schemaVersions(raw)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]); // unchanged — nothing re-applied
      raw.close();
    }
    reopened.close();
  });

  it('continues the sequence and chain correctly across a process restart', () => {
    let storage = new AuditStorage(DB_PATH);
    seedOneEvent(storage, { server_identity: 'srv:a' });
    storage.close();

    storage = new AuditStorage(DB_PATH);
    seedOneEvent(storage, { server_identity: 'srv:b' });
    const result = storage.verifyToolIntegrityChain();
    expect(result).toEqual({ valid: true, count: 2 });
    storage.close();
  });

  it('detects tampering with a field value (hash mismatch)', () => {
    let storage = new AuditStorage(DB_PATH);
    seedOneEvent(storage, { reason: 'original reason' });
    storage.close();

    const db = new Database(DB_PATH);
    db.prepare(`UPDATE tool_integrity_events SET reason = 'TAMPERED' WHERE sequence_number = 1`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyToolIntegrityChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Tampering detected/);
    storage.close();
  });

  it('detects a deleted row (sequence gap)', () => {
    let storage = new AuditStorage(DB_PATH);
    seedOneEvent(storage);
    seedOneEvent(storage);
    seedOneEvent(storage);
    storage.close();

    const db = new Database(DB_PATH);
    db.prepare(`DELETE FROM tool_integrity_events WHERE sequence_number = 2`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyToolIntegrityChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/sequence gap/);
    storage.close();
  });

  it('detects reordered/renumbered rows (hash chain broken even if sequence numbers look contiguous)', () => {
    let storage = new AuditStorage(DB_PATH);
    seedOneEvent(storage, { reason: 'first' });
    seedOneEvent(storage, { reason: 'second' });
    storage.close();

    // Swap the two rows' sequence_number values directly — the sequence
    // column stays contiguous (1, 2), but each row's own stored hash was
    // computed including its ORIGINAL sequence_number, so swapping breaks
    // both the hash-chain link (previous_event_hash no longer points at the
    // real predecessor) and the per-row hash recomputation.
    const db = new Database(DB_PATH);
    db.pragma('foreign_keys = OFF');
    db.exec('BEGIN');
    db.prepare(`UPDATE tool_integrity_events SET sequence_number = 99 WHERE sequence_number = 1`).run();
    db.prepare(`UPDATE tool_integrity_events SET sequence_number = 1 WHERE sequence_number = 2`).run();
    db.prepare(`UPDATE tool_integrity_events SET sequence_number = 2 WHERE sequence_number = 99`).run();
    db.exec('COMMIT');
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyToolIntegrityChain();
    expect(result.valid).toBe(false);
    storage.close();
  });

  it('detects a corrupted/missing previous_event_hash link', () => {
    let storage = new AuditStorage(DB_PATH);
    seedOneEvent(storage);
    seedOneEvent(storage);
    storage.close();

    const db = new Database(DB_PATH);
    db.prepare(`UPDATE tool_integrity_events SET previous_event_hash = 'not-the-real-hash' WHERE sequence_number = 2`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyToolIntegrityChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/hash chain broken/);
    storage.close();
  });

  it('upsertToolIntegrityState is a true upsert (insert then update on the same primary key)', () => {
    const storage = new AuditStorage(DB_PATH);
    const base = {
      server_identity: 'srv:a',
      tool_name: 'echo',
      server_id: 'srv',
      status: 'pending_review' as const,
      current_fingerprint: 'fp1',
      trusted_fingerprint: null,
      candidate_fingerprint: 'fp1',
      candidate_id: 'cand1',
      trusted_definition_json: null,
      candidate_definition_json: '{}',
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-01-01T00:00:00.000Z',
      last_scan_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    storage.upsertToolIntegrityState(base);
    expect(storage.listToolIntegrityState()).toHaveLength(1);
    storage.upsertToolIntegrityState({ ...base, status: 'trusted', trusted_fingerprint: 'fp1', candidate_fingerprint: null, candidate_id: null });
    const rows = storage.listToolIntegrityState();
    expect(rows).toHaveLength(1); // still exactly one row — an update, not a second insert.
    expect(rows[0].status).toBe('trusted');
    storage.close();
  });
});

describe('AuditStorage constructor — SQLite handle cleanup on migration failure', () => {
  beforeEach(() => cleanupDbFiles(FAIL_DB_PATH));
  afterEach(() => cleanupDbFiles(FAIL_DB_PATH));

  it('closes the SQLite handle and leaves the file deletable/reopenable immediately after a migration failure', () => {
    // 1. Build an authentic TOOL_INTEGRITY-era database, then deterministically
    //    force the NEXT migration (Context Guard) to fail: pre-empt its own
    //    `ALTER TABLE approvals ADD COLUMN context_id` by adding that exact
    //    column directly, without recording the Context Guard version in
    //    schema_version. This reproduces "the next migration's DDL is
    //    already structurally present but schema_version doesn't know it"
    //    — the same failure shape the regression above fixes — so a
    //    normal, full re-open genuinely fails migration AFTER the
    //    constructor's better-sqlite3 handle has already opened (not
    //    before, and not via file corruption).
    const seed = new AuditStorage(FAIL_DB_PATH, { migrateThroughVersion: MIGRATION_VERSIONS.TOOL_INTEGRITY });
    seed.close();

    const raw = new Database(FAIL_DB_PATH);
    raw.exec('ALTER TABLE approvals ADD COLUMN context_id TEXT;');
    raw.close();

    // 2. Re-open normally (full/default migration) — must throw, not hang
    //    or silently succeed.
    expect(() => new AuditStorage(FAIL_DB_PATH)).toThrow(/duplicate column name/);

    // 3. The actual proof: the failed constructor must not have leaked the
    //    SQLite handle. On Windows, an open handle makes even DELETING the
    //    file throw EBUSY; deleting (and then reopening at the same path)
    //    must succeed IMMEDIATELY — no retry loop or sleep papering over a
    //    leak, on either OS.
    expect(() => cleanupDbFiles(FAIL_DB_PATH)).not.toThrow();
    expect(fs.existsSync(FAIL_DB_PATH)).toBe(false);

    const fresh = new AuditStorage(FAIL_DB_PATH);
    expect(fresh.verifyChain()).toEqual({ valid: true, count: 0 });
    fresh.close();
  });

  it('a successful construction leaves the handle open and usable (no accidental close)', () => {
    const storage = new AuditStorage(FAIL_DB_PATH);
    // If the constructor's try/catch ever closed the handle unconditionally
    // (rather than only on failure), every method call below would throw
    // "The database connection is not open".
    expect(storage.verifyChain()).toEqual({ valid: true, count: 0 });
    seedOneEvent(storage);
    expect(storage.verifyToolIntegrityChain()).toEqual({ valid: true, count: 1 });
    storage.close();
  });
});
