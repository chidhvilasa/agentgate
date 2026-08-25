// Tool Integrity storage migration + tamper-evidence proof (Milestone 6,
// ADR-0012, Phase D). Mirrors storage-migration.test.ts's approach exactly
// (hand-crafted legacy-schema database, direct field tampering without
// recomputing the hash, restart persistence) for the NEW
// tool_integrity_events/tool_integrity_state tables.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { AuditStorage } from '../src/storage.js';

const DB_PATH = './test-migration-tool-integrity.sqlite';

function cleanupDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
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
  beforeEach(cleanupDbFiles);
  afterEach(cleanupDbFiles);

  it('runs cleanly against a fresh database (tables present, chain empty)', () => {
    const storage = new AuditStorage(DB_PATH);
    expect(storage.verifyToolIntegrityChain()).toEqual({ valid: true, count: 0 });
    expect(storage.listToolIntegrityEvents()).toEqual([]);
    expect(storage.listToolIntegrityState()).toEqual([]);
    storage.close();
  });

  it('migrates cleanly from a Milestone-5-era database that predates the tool_integrity tables', () => {
    // 1. Build a database with real pre-Milestone-6 data via the REAL
    //    current AuditStorage (guarantees an authentic, exactly-current
    //    schema for every OTHER table — not a hand-maintained copy that
    //    could silently drift from the real migrations over time).
    let storage = new AuditStorage(DB_PATH);
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

    // 2. Roll the database back to "the moment before the Tool Integrity
    //    migration ran" — schema-version-driven, not a hand-copied old
    //    schema, so it can never silently drift from the real migration
    //    list: drop the two tables this milestone's migration creates, and
    //    remove the schema_version row that recorded that migration having
    //    already run. Every OTHER table (audit_events, etc.) is untouched,
    //    exactly matching a real user's database the moment before
    //    upgrading past this milestone.
    const raw = new Database(DB_PATH);
    const maxVersion = (raw.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v;
    raw.exec('DROP TABLE tool_integrity_events; DROP TABLE tool_integrity_state;');
    raw.prepare('DELETE FROM schema_version WHERE version = ?').run(maxVersion);
    raw.close();

    // 3. Re-open with the CURRENT AuditStorage — the pending migration must
    //    run and recreate the tool_integrity tables, without disturbing the
    //    pre-existing audit data at all.
    storage = new AuditStorage(DB_PATH);
    expect(storage.verifyToolIntegrityChain()).toEqual({ valid: true, count: 0 });
    expect(storage.getEvent('legacy-evt-1')).not.toBeNull();
    expect(storage.getEvent('legacy-evt-1')?.tool_call.tool).toBe('legacy.tool');
    expect(storage.verifyChain()).toEqual({ valid: true, count: 1 }); // pre-existing audit chain unaffected

    // 4. New Tool Integrity activity works normally on the migrated database.
    const inserted = seedOneEvent(storage);
    expect(inserted.sequence_number).toBe(1);
    expect(inserted.previous_event_hash).toBeNull();
    expect(storage.verifyToolIntegrityChain()).toEqual({ valid: true, count: 1 });
    storage.close();
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
