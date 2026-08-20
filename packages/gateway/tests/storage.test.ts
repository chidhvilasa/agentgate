import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditStorage } from '../src/storage.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';

const DB_PATH = './test-audit.sqlite';

describe('AuditStorage Lifecycle and Tamper Evidence', () => {
  let storage: AuditStorage;

  beforeEach(() => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
    if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');
    storage = new AuditStorage(DB_PATH);
  });

  afterEach(() => {
    storage.close();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
    if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');
  });

  const createTestEventData = (id: string, status: any = 'RECEIVED') => ({
    id,
    created_at: new Date().toISOString(),
    agent: { session_id: 'test-session', declared_name: 'test', declared_version: '1' },
    tool_call: { tool: 'test.tool', normalized_arguments: { foo: 'bar' } },
    status,
    decision: null,
    execution_succeeded: null,
    execution_error: null,
    duration_ms: null,
    arguments_redacted: false,
    result_redacted: false,
  });

  it('inserts an event and verifies a valid chain', () => {
    storage.upsertAgent({ session_id: 'test-session', identity_json: '{}', connected_at: new Date().toISOString() });
    
    storage.insertEvent(createTestEventData('evt-1'));
    storage.updateEventStatus('evt-1', 'ALLOWED', { execution_succeeded: true, duration_ms: 100 });
    storage.insertEvent(createTestEventData('evt-2'));

    const result = storage.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.count).toBe(3); // 3 lifecycle records total
  });

  it('detects tampering with status in the lifecycle records', () => {
    storage.upsertAgent({ session_id: 'test-session', identity_json: '{}', connected_at: new Date().toISOString() });
    storage.insertEvent(createTestEventData('evt-1', 'DENIED'));

    // Directly mutate the database to simulate tampering
    const db = new Database(DB_PATH);
    db.prepare("UPDATE audit_lifecycle_records SET status = 'ALLOWED'").run();
    db.close();

    const result = storage.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Tampering detected/);
  });

  it('detects deleted middle records', () => {
    storage.upsertAgent({ session_id: 'test-session', identity_json: '{}', connected_at: new Date().toISOString() });
    storage.insertEvent(createTestEventData('evt-1'));
    storage.insertEvent(createTestEventData('evt-2'));
    storage.insertEvent(createTestEventData('evt-3'));

    const db = new Database(DB_PATH);
    db.prepare("DELETE FROM audit_lifecycle_records WHERE sequence_number = 2").run();
    db.close();

    const result = storage.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Sequence gap/);
  });
});
