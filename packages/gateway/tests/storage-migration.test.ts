import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { AuditStorage } from '../src/storage.js';

const DB_PATH = './test-migration-audit.sqlite';

function cleanupDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

// Duplicates storage.ts's private canonicalize()/sha256() so this test can
// independently compute a genuine Milestone-1/2 ("v1") lifecycle-record hash
// without depending on AuditStorage internals — this is what a real
// pre-Milestone-3 database's stored hash actually looked like.
function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const sorted = Object.keys(obj)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k]));
  return '{' + sorted.join(',') + '}';
}
function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

describe('Audit storage migration and cross-version hash-chain integrity (ADR-0009)', () => {
  beforeEach(cleanupDbFiles);
  afterEach(cleanupDbFiles);

  it('runs cleanly against a fresh database (new columns present, chain empty)', () => {
    const storage = new AuditStorage(DB_PATH);
    expect(storage.verifyChain()).toEqual({ valid: true, count: 0 });
    storage.close();
  });

  it('migrates a hand-crafted legacy v1 lifecycle record and continues the chain under v2', () => {
    // 1. Stand up a real database with the current schema (this simulates
    //    "the migration already ran"; the columns exist and default to 0).
    let storage = new AuditStorage(DB_PATH);
    storage.close();

    // 2. Manually insert one genuine v1-shaped record — i.e. exactly what a
    //    pre-Milestone-3 AgentGate database would have stored, with a hash
    //    computed from the OLD payload shape (no result_redacted/
    //    result_blocked/result_finding_count/error_redacted fields).
    const db = new Database(DB_PATH);
    const eventId = 'legacy-evt-1';
    const agent = { session_id: 'legacy-session', declared_name: null, declared_version: null };
    const toolCall = { tool: 'legacy.tool', normalized_arguments: { path: '/legacy' } };

    db.prepare(
      `INSERT INTO audit_events (id, created_at, agent_json, tool_call_json, status, decision_json,
        execution_succeeded, execution_error, duration_ms, arguments_redacted, result_redacted,
        result_blocked, result_finding_count, error_redacted)
       VALUES (?, ?, ?, ?, 'SUCCEEDED', NULL, 1, NULL, 42, 0, 0, 0, 0, 0)`
    ).run(eventId, '2026-01-01T00:00:00.000Z', JSON.stringify(agent), JSON.stringify(toolCall));

    const v1Payload = {
      record_id: 'legacy-rec-1',
      event_id: eventId,
      sequence_number: 1,
      previous_record_hash: null,
      created_at: '2026-01-01T00:00:00.000Z',
      status: 'SUCCEEDED',
      decision_type: null,
      execution_succeeded: 1,
      execution_error: null,
      duration_ms: 42,
      agent_session_id: agent.session_id,
      tool: toolCall.tool,
      normalized_arguments: toolCall.normalized_arguments,
    };
    const v1Hash = sha256(canonicalize(v1Payload));

    db.prepare(
      `INSERT INTO audit_lifecycle_records (record_id, event_id, sequence_number, previous_record_hash,
        record_hash, canonical_payload_version, created_at, status, decision_json,
        execution_succeeded, execution_error, duration_ms,
        result_redacted, result_blocked, result_finding_count, error_redacted)
       VALUES (?, ?, 1, NULL, ?, '1', ?, 'SUCCEEDED', NULL, 1, NULL, 42, 0, 0, 0, 0)`
    ).run(v1Payload.record_id, eventId, v1Hash, v1Payload.created_at);
    db.close();

    // 3. Re-open with the current AuditStorage — it must resume the sequence
    //    and hash chain from this legacy record.
    storage = new AuditStorage(DB_PATH);
    const before = storage.verifyChain();
    expect(before).toEqual({ valid: true, count: 1 });

    // 4. Append a brand-new (v2) event through the normal API.
    const inserted = storage.insertEvent({
      id: 'new-evt-2',
      created_at: new Date().toISOString(),
      agent: { session_id: 's2', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'new.tool', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'RECEIVED',
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
    expect(inserted.canonical_payload_version).toBe('2');
    expect(inserted.previous_event_hash).toBe(v1Hash);

    // 5. The chain — one v1 record followed by one v2 record — must still verify.
    const after = storage.verifyChain();
    expect(after).toEqual({ valid: true, count: 2 });

    storage.close();
  });

  it('detects tampering with a new (v2-only) metadata field', () => {
    let storage = new AuditStorage(DB_PATH);
    storage.insertEvent({
      id: 'evt-tamper',
      created_at: new Date().toISOString(),
      agent: { session_id: 's1', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'test.tool', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'SUCCEEDED',
      decision: null,
      execution_succeeded: true,
      execution_error: null,
      duration_ms: 10,
      arguments_redacted: false,
      result_redacted: true,
      result_blocked: false,
      result_finding_count: 2,
      error_redacted: false,
    });
    storage.close();

    // Flip a v2-only field directly in the DB without recomputing the hash.
    const db = new Database(DB_PATH);
    db.prepare(`UPDATE audit_lifecycle_records SET result_finding_count = 999 WHERE event_id = 'evt-tamper'`).run();
    db.close();

    storage = new AuditStorage(DB_PATH);
    const result = storage.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Tampering detected/);
    storage.close();
  });

  it('continues the sequence and chain correctly across a process restart', () => {
    let storage = new AuditStorage(DB_PATH);
    storage.insertEvent({
      id: 'evt-a',
      created_at: new Date().toISOString(),
      agent: { session_id: 's1', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'a.tool', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
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

    // Simulate a restart: a brand-new AuditStorage instance over the same file.
    storage = new AuditStorage(DB_PATH);
    storage.insertEvent({
      id: 'evt-b',
      created_at: new Date().toISOString(),
      agent: { session_id: 's2', declared_name: null, declared_version: null, connection_identity: 'x', verified_identity: false },
      tool_call: { tool: 'b.tool', raw_arguments: {}, normalized_arguments: {}, mcp_era: 'legacy-2025', jsonrpc_id: null },
      status: 'SUCCEEDED',
      decision: null,
      execution_succeeded: true,
      execution_error: null,
      duration_ms: 6,
      arguments_redacted: false,
      result_redacted: false,
      result_blocked: false,
      result_finding_count: 0,
      error_redacted: false,
    });
    const result = storage.verifyChain();
    expect(result).toEqual({ valid: true, count: 2 });
    storage.close();
  });
});
