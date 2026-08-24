import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { AuditEvent, Approval, ApprovalStatus, ReplayEvaluation } from '@agentgate/protocol';

// ─── Schema Migrations ────────────────────────────────────────────────────────

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    agent_json TEXT NOT NULL,
    tool_call_json TEXT NOT NULL,
    status TEXT NOT NULL,
    decision_json TEXT,
    execution_succeeded INTEGER,
    execution_error TEXT,
    duration_ms INTEGER,
    arguments_redacted INTEGER NOT NULL DEFAULT 0,
    result_redacted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_events_created_at ON audit_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_status ON audit_events(status);
  `,
  `
  CREATE TABLE IF NOT EXISTS audit_lifecycle_records (
    record_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES audit_events(id),
    sequence_number INTEGER NOT NULL UNIQUE,
    previous_record_hash TEXT,
    record_hash TEXT NOT NULL,
    canonical_payload_version TEXT NOT NULL DEFAULT '1',
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    decision_json TEXT,
    execution_succeeded INTEGER,
    execution_error TEXT,
    duration_ms INTEGER
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES audit_events(id),
    status TEXT NOT NULL DEFAULT 'PENDING',
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    proposed_action_display TEXT NOT NULL,
    policy_reason TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  `,
  `
  CREATE TABLE IF NOT EXISTS agents (
    session_id TEXT PRIMARY KEY,
    identity_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'connected',
    connected_at TEXT NOT NULL,
    last_activity_at TEXT,
    allowed_count INTEGER NOT NULL DEFAULT 0,
    denied_count INTEGER NOT NULL DEFAULT 0,
    pending_count INTEGER NOT NULL DEFAULT 0,
    supports_pause INTEGER NOT NULL DEFAULT 0,
    supports_terminate INTEGER NOT NULL DEFAULT 0
  );
  `,
  // ADR-0009: bidirectional result/error secret safety. This migration MUST
  // stay appended at the end of MIGRATIONS, never inserted earlier — a
  // database that already applied migrations 0-4 has schema_version = 5
  // stored, and the migration runner (see runMigrations()) resumes from
  // `existing.version`, i.e. array index `currentVersion`. Inserting a new
  // migration before this point would silently renumber every migration
  // after it and cause already-upgraded databases to skip this one entirely.
  // Existing rows get these columns via ALTER TABLE with safe defaults
  // (0/false) — they genuinely never had output sanitization applied, since
  // it did not exist yet, so 0/false is an accurate historical record.
  `
  ALTER TABLE audit_events ADD COLUMN result_blocked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE audit_events ADD COLUMN result_finding_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE audit_events ADD COLUMN error_redacted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE audit_lifecycle_records ADD COLUMN result_redacted INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE audit_lifecycle_records ADD COLUMN result_blocked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE audit_lifecycle_records ADD COLUMN result_finding_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE audit_lifecycle_records ADD COLUMN error_redacted INTEGER NOT NULL DEFAULT 0;
  `,
  // ADR-0010: Safe Replay lineage. A separate, single-table append-only
  // chain (own sequence_number/hash chain, independent of the audit chain)
  // — replay evaluations have no mutable "current state" to project, unlike
  // a live tool call's lifecycle, so the two-table audit_events/
  // audit_lifecycle_records pattern is not reused here. MUST stay appended
  // at the end of MIGRATIONS — see the ADR-0009 migration above for why.
  `
  CREATE TABLE IF NOT EXISTS replay_evaluations (
    id TEXT PRIMARY KEY,
    source_event_id TEXT NOT NULL REFERENCES audit_events(id),
    sequence_number INTEGER NOT NULL UNIQUE,
    previous_replay_hash TEXT,
    replay_hash TEXT NOT NULL,
    canonical_payload_version TEXT NOT NULL DEFAULT '1',
    evaluated_at TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    original_decision_type TEXT,
    original_rule_id TEXT,
    original_reason_code TEXT,
    current_decision_type TEXT NOT NULL,
    current_rule_id TEXT,
    current_reason_code TEXT NOT NULL,
    current_explanation TEXT NOT NULL,
    current_transformations_json TEXT NOT NULL,
    decision_changed INTEGER NOT NULL,
    matched_rule_changed INTEGER NOT NULL,
    reason_code_changed INTEGER NOT NULL,
    source_arguments_redacted INTEGER NOT NULL,
    limitations_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_replay_source_event ON replay_evaluations(source_event_id);
  `,
];

// ─── Canonical Payload for Hashing ────────────────────────────────────────────

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

/**
 * The schema version a fresh database ends up at after `AuditStorage`
 * applies every migration — i.e. `MIGRATIONS.length`. Exported so read-only
 * tooling (`agentgate doctor`, Milestone 5) can tell whether an *existing*
 * database is already fully migrated without opening it via `AuditStorage`
 * itself, which would apply any pending migration as a side effect —
 * exactly the "doctor never mutates the database" guarantee requires.
 */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Reads the current `schema_version` of an existing database file, opened
 * strictly read-only (`better-sqlite3`'s `readonly` mode — an OS-level
 * open flag, not just an application convention). Returns `0` for a file
 * that exists but has no `schema_version` table yet (e.g. an empty file).
 * Never creates the file, never writes to it, never runs a migration.
 * Throws if `dbPath` does not exist or is not a valid SQLite file.
 */
export function readSchemaVersionReadOnly(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
      .get();
    if (!tableExists) return 0;
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
      | { version: number }
      | undefined;
    return row?.version ?? 0;
  } finally {
    db.close();
  }
}

// ─── Storage Class ────────────────────────────────────────────────────────────

export class AuditStorage {
  private db: Database.Database;
  private nextSeq: number;
  private lastHash: string | null;
  private nextReplaySeq: number;
  private lastReplayHash: string | null;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();

    // Resume sequence and hash chain from last stored record
    const last = this.db
      .prepare('SELECT sequence_number, record_hash FROM audit_lifecycle_records ORDER BY sequence_number DESC LIMIT 1')
      .get() as { sequence_number: number; record_hash: string } | undefined;

    this.nextSeq = last ? last.sequence_number + 1 : 1;
    this.lastHash = last?.record_hash ?? null;

    // Resume the independent replay-evaluation chain (ADR-0010)
    const lastReplay = this.db
      .prepare('SELECT sequence_number, replay_hash FROM replay_evaluations ORDER BY sequence_number DESC LIMIT 1')
      .get() as { sequence_number: number; replay_hash: string } | undefined;

    this.nextReplaySeq = lastReplay ? lastReplay.sequence_number + 1 : 1;
    this.lastReplayHash = lastReplay?.replay_hash ?? null;
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const existing = this.db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | undefined;
    const currentVersion = existing?.version ?? 0;

    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]);
        this.db
          .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
          .run(i + 1, new Date().toISOString());
      })();
    }
  }

  /**
   * Builds the canonical hash-input payload for a lifecycle record, dispatched
   * by canonical_payload_version. See ADR-0009: v2 adds the result/error
   * sanitization fields to the hash input. A record's OWN stored version is
   * always used to reconstruct its payload (both when writing a new record
   * and when re-verifying an old one in verifyChain()), so a chain that began
   * under v1 and continues under v2 after an upgrade still verifies
   * correctly — each record proves only its own, contemporaneous shape.
   */
  private buildCanonicalPayload(
    version: '1' | '2',
    base: {
      record_id: string;
      event_id: string;
      sequence_number: number;
      previous_record_hash: string | null;
      created_at: string;
      status: string;
      decision_type: string | null;
      execution_succeeded: number | null;
      execution_error: string | null;
      duration_ms: number | null;
      agent_session_id: string;
      tool: string;
      normalized_arguments: unknown;
    },
    v2Fields: { result_redacted: number; result_blocked: number; result_finding_count: number; error_redacted: number }
  ): Record<string, unknown> {
    if (version === '1') return base;
    return { ...base, ...v2Fields };
  }

  private appendLifecycleRecord(
    eventId: string,
    eventData: AuditEvent
  ): { sequence_number: number; previous_event_hash: string | null; event_hash: string } {
    const sequence_number = this.nextSeq++;
    const previous_record_hash = this.lastHash;
    const record_id = uuidv4();
    const created_at = new Date().toISOString();

    const status = eventData.status;
    const decision_json = eventData.decision ? JSON.stringify(eventData.decision) : null;
    const execution_succeeded = eventData.execution_succeeded === null ? null : eventData.execution_succeeded ? 1 : 0;
    const execution_error = eventData.execution_error ?? null;
    const duration_ms = eventData.duration_ms ?? null;
    const result_redacted = eventData.result_redacted ? 1 : 0;
    const result_blocked = eventData.result_blocked ? 1 : 0;
    const result_finding_count = eventData.result_finding_count ?? 0;
    const error_redacted = eventData.error_redacted ? 1 : 0;

    // All NEW records are written under canonical_payload_version '2' —
    // only records already persisted before this milestone remain '1'.
    const canonical_payload_version = '2' as const;

    const canonicalPayload = this.buildCanonicalPayload(
      canonical_payload_version,
      {
        record_id,
        event_id: eventId,
        sequence_number,
        previous_record_hash,
        created_at,
        status,
        decision_type: eventData.decision?.type ?? null,
        execution_succeeded,
        execution_error,
        duration_ms,
        agent_session_id: eventData.agent.session_id,
        tool: eventData.tool_call.tool,
        normalized_arguments: eventData.tool_call.normalized_arguments,
      },
      { result_redacted, result_blocked, result_finding_count, error_redacted }
    );

    const record_hash = sha256(canonicalize(canonicalPayload));
    this.lastHash = record_hash;

    this.db.prepare(`
      INSERT INTO audit_lifecycle_records (
        record_id, event_id, sequence_number, previous_record_hash, record_hash,
        canonical_payload_version, created_at, status, decision_json,
        execution_succeeded, execution_error, duration_ms,
        result_redacted, result_blocked, result_finding_count, error_redacted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record_id, eventId, sequence_number, previous_record_hash, record_hash,
      canonical_payload_version, created_at, status, decision_json,
      execution_succeeded, execution_error, duration_ms,
      result_redacted, result_blocked, result_finding_count, error_redacted
    );

    return { sequence_number, previous_event_hash: previous_record_hash, event_hash: record_hash };
  }

  insertEvent(eventData: Omit<AuditEvent, 'sequence_number' | 'previous_event_hash' | 'event_hash' | 'canonical_payload_version'>): AuditEvent {
    // Insert into mutable projection table
    this.db.prepare(`
      INSERT INTO audit_events (
        id, created_at, agent_json, tool_call_json,
        status, decision_json, execution_succeeded, execution_error,
        duration_ms, arguments_redacted, result_redacted,
        result_blocked, result_finding_count, error_redacted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventData.id, eventData.created_at, JSON.stringify(eventData.agent), JSON.stringify(eventData.tool_call),
      eventData.status, eventData.decision ? JSON.stringify(eventData.decision) : null,
      eventData.execution_succeeded === null ? null : eventData.execution_succeeded ? 1 : 0,
      eventData.execution_error, eventData.duration_ms,
      eventData.arguments_redacted ? 1 : 0, eventData.result_redacted ? 1 : 0,
      eventData.result_blocked ? 1 : 0, eventData.result_finding_count ?? 0, eventData.error_redacted ? 1 : 0
    );

    // canonical_payload_version is a placeholder here — appendLifecycleRecord()
    // below always writes the record under the current version ('2') and this
    // is overwritten from its actual result before the caller ever sees it.
    const event: AuditEvent = { ...eventData, sequence_number: 0, previous_event_hash: null, event_hash: '', canonical_payload_version: '2' };

    // Append lifecycle record using transaction
    this.db.transaction(() => {
      const hashes = this.appendLifecycleRecord(event.id, event);
      event.sequence_number = hashes.sequence_number;
      event.previous_event_hash = hashes.previous_event_hash;
      event.event_hash = hashes.event_hash;
    })();

    return event;
  }

  updateEventStatus(
    id: string,
    status: AuditEvent['status'],
    updates: Partial<
      Pick<
        AuditEvent,
        | 'execution_succeeded'
        | 'execution_error'
        | 'duration_ms'
        | 'decision'
        | 'result_redacted'
        | 'result_blocked'
        | 'result_finding_count'
        | 'error_redacted'
      >
    >
  ): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE audit_events SET
          status = ?,
          execution_succeeded = COALESCE(?, execution_succeeded),
          execution_error = COALESCE(?, execution_error),
          duration_ms = COALESCE(?, duration_ms),
          decision_json = COALESCE(?, decision_json),
          result_redacted = COALESCE(?, result_redacted),
          result_blocked = COALESCE(?, result_blocked),
          result_finding_count = COALESCE(?, result_finding_count),
          error_redacted = COALESCE(?, error_redacted)
        WHERE id = ?
      `).run(
        status,
        updates.execution_succeeded === undefined ? null : updates.execution_succeeded ? 1 : 0,
        updates.execution_error ?? null,
        updates.duration_ms ?? null,
        updates.decision ? JSON.stringify(updates.decision) : null,
        updates.result_redacted === undefined ? null : updates.result_redacted ? 1 : 0,
        updates.result_blocked === undefined ? null : updates.result_blocked ? 1 : 0,
        updates.result_finding_count === undefined ? null : updates.result_finding_count,
        updates.error_redacted === undefined ? null : updates.error_redacted ? 1 : 0,
        id
      );

      const updatedEventRow = this.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as Record<string, unknown>;
      if (updatedEventRow) {
        // Fetch the event using the internal row mapping logic, but stub out the hashes/version since we
        // are only using it to generate the lifecycle payload — appendLifecycleRecord() always writes
        // its own fresh canonical_payload_version ('2') regardless of what is passed here.
        const updatedEvent = this.rowToEvent(updatedEventRow, 0, null, '', '2');
        this.appendLifecycleRecord(id, updatedEvent);
      }
    })();
  }

  listEvents(opts: { limit?: number; offset?: number; status?: string; tool?: string } = {}): AuditEvent[] {
    const { limit = 50, offset = 0, status, tool } = opts;
    let query = 'SELECT e.*, l.sequence_number, l.previous_record_hash, l.record_hash, l.canonical_payload_version FROM audit_events e LEFT JOIN (SELECT event_id, MAX(sequence_number) as max_seq FROM audit_lifecycle_records GROUP BY event_id) latest ON e.id = latest.event_id LEFT JOIN audit_lifecycle_records l ON e.id = l.event_id AND latest.max_seq = l.sequence_number';
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (status) { conditions.push('e.status = ?'); params.push(status); }
    if (tool) { conditions.push('e.tool_call_json LIKE ?'); params.push(`%"tool":"${tool}"%`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY e.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(
      r, r.sequence_number as number, r.previous_record_hash as string, r.record_hash as string,
      (r.canonical_payload_version as '1' | '2' | null) ?? '1'
    ));
  }

  getEvent(id: string): AuditEvent | null {
    const query = 'SELECT e.*, l.sequence_number, l.previous_record_hash, l.record_hash, l.canonical_payload_version FROM audit_events e LEFT JOIN (SELECT event_id, MAX(sequence_number) as max_seq FROM audit_lifecycle_records GROUP BY event_id) latest ON e.id = latest.event_id LEFT JOIN audit_lifecycle_records l ON e.id = l.event_id AND latest.max_seq = l.sequence_number WHERE e.id = ?';
    const row = this.db.prepare(query).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEvent(
      row, row.sequence_number as number, row.previous_record_hash as string, row.record_hash as string,
      (row.canonical_payload_version as '1' | '2' | null) ?? '1'
    ) : null;
  }

  verifyChain(): { valid: boolean; error?: string; count: number } {
    const records = this.db.prepare('SELECT * FROM audit_lifecycle_records ORDER BY sequence_number ASC').all() as Record<string, unknown>[];
    if (records.length === 0) return { valid: true, count: 0 };
    
    let expectedHash: string | null = null;
    let expectedSeq = 1;

    for (const row of records) {
      if (row.sequence_number !== expectedSeq) {
        return { valid: false, error: `Sequence gap at expected seq ${expectedSeq}, found ${row.sequence_number}`, count: expectedSeq - 1 };
      }
      if (row.previous_record_hash !== expectedHash) {
        return { valid: false, error: `Hash chain broken at seq ${expectedSeq}. Expected prev: ${expectedHash}, got: ${row.previous_record_hash}`, count: expectedSeq - 1 };
      }

      const eventRow = this.db.prepare('SELECT agent_json, tool_call_json FROM audit_events WHERE id = ?').get(row.event_id) as { agent_json: string; tool_call_json: string } | undefined;
      if (!eventRow) {
         return { valid: false, error: `Missing event data for record seq ${expectedSeq}`, count: expectedSeq - 1 };
      }

      const agent = JSON.parse(eventRow.agent_json);
      const toolCall = JSON.parse(eventRow.tool_call_json);

      const version = (row.canonical_payload_version as '1' | '2' | undefined) ?? '1';
      const canonicalPayload = this.buildCanonicalPayload(
        version,
        {
          record_id: row.record_id as string,
          event_id: row.event_id as string,
          // row.sequence_number is narrowed to `number` here by the earlier
          // `if (row.sequence_number !== expectedSeq) return ...` guard —
          // an explicit cast would be flagged as unnecessary.
          sequence_number: row.sequence_number,
          previous_record_hash: row.previous_record_hash as string | null,
          created_at: row.created_at as string,
          status: row.status as string,
          decision_type: row.decision_json ? (JSON.parse(row.decision_json as string) as { type: string }).type : null,
          execution_succeeded: row.execution_succeeded as number | null,
          execution_error: row.execution_error as string | null,
          duration_ms: row.duration_ms as number | null,
          agent_session_id: agent.session_id,
          tool: toolCall.tool,
          normalized_arguments: toolCall.normalized_arguments,
        },
        {
          result_redacted: (row.result_redacted as number | undefined) ?? 0,
          result_blocked: (row.result_blocked as number | undefined) ?? 0,
          result_finding_count: (row.result_finding_count as number | undefined) ?? 0,
          error_redacted: (row.error_redacted as number | undefined) ?? 0,
        }
      );

      const computedHash = sha256(canonicalize(canonicalPayload));
      if (computedHash !== row.record_hash) {
        return { valid: false, error: `Tampering detected at seq ${expectedSeq}. Computed hash does not match stored record_hash.`, count: expectedSeq - 1 };
      }

      expectedHash = row.record_hash;
      expectedSeq++;
    }

    return { valid: true, count: records.length };
  }

  // ─── Safe Replay Lineage (ADR-0010) ────────────────────────────────────────
  //
  // A separate, single-table append-only chain — replay evaluations have no
  // mutable "current state" to project, unlike a live tool call's lifecycle,
  // so the audit chain's two-table pattern is not reused here. Never writes
  // to audit_events/audit_lifecycle_records; never mutates a source event.

  /**
   * Appends one immutable replay evaluation. `data` must already be the
   * result of a pure policy re-evaluation (see replay.ts) — this method only
   * persists and hash-chains it; it performs no evaluation itself.
   */
  insertReplayEvaluation(
    data: Omit<ReplayEvaluation, 'id' | 'sequence_number' | 'previous_replay_hash' | 'replay_hash' | 'canonical_payload_version'>
  ): ReplayEvaluation {
    const id = uuidv4();
    const sequence_number = this.nextReplaySeq++;
    const previous_replay_hash = this.lastReplayHash;
    const canonical_payload_version = '1' as const;

    const canonicalPayload = {
      id,
      source_event_id: data.source_event_id,
      sequence_number,
      previous_replay_hash,
      evaluated_at: data.evaluated_at,
      policy_digest: data.policy_digest,
      original_decision_type: data.original_decision_type,
      original_rule_id: data.original_rule_id,
      original_reason_code: data.original_reason_code,
      current_decision_type: data.current_decision_type,
      current_rule_id: data.current_rule_id,
      current_reason_code: data.current_reason_code,
      current_explanation: data.current_explanation,
      current_transformations: data.current_transformations,
      decision_changed: data.decision_changed,
      matched_rule_changed: data.matched_rule_changed,
      reason_code_changed: data.reason_code_changed,
      source_arguments_redacted: data.source_arguments_redacted,
      limitations: data.limitations,
    };

    const replay_hash = sha256(canonicalize(canonicalPayload));
    this.lastReplayHash = replay_hash;

    this.db
      .prepare(
        `INSERT INTO replay_evaluations (
          id, source_event_id, sequence_number, previous_replay_hash, replay_hash,
          canonical_payload_version, evaluated_at, policy_digest,
          original_decision_type, original_rule_id, original_reason_code,
          current_decision_type, current_rule_id, current_reason_code,
          current_explanation, current_transformations_json,
          decision_changed, matched_rule_changed, reason_code_changed,
          source_arguments_redacted, limitations_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.source_event_id,
        sequence_number,
        previous_replay_hash,
        replay_hash,
        canonical_payload_version,
        data.evaluated_at,
        data.policy_digest,
        data.original_decision_type,
        data.original_rule_id,
        data.original_reason_code,
        data.current_decision_type,
        data.current_rule_id,
        data.current_reason_code,
        data.current_explanation,
        JSON.stringify(data.current_transformations),
        data.decision_changed ? 1 : 0,
        data.matched_rule_changed ? 1 : 0,
        data.reason_code_changed ? 1 : 0,
        data.source_arguments_redacted ? 1 : 0,
        JSON.stringify(data.limitations)
      );

    return {
      ...data,
      id,
      sequence_number,
      previous_replay_hash,
      replay_hash,
      canonical_payload_version,
    };
  }

  getReplayEvaluation(id: string): ReplayEvaluation | null {
    const row = this.db.prepare('SELECT * FROM replay_evaluations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToReplayEvaluation(row) : null;
  }

  listReplayEvaluationsForEvent(sourceEventId: string): ReplayEvaluation[] {
    const rows = this.db
      .prepare('SELECT * FROM replay_evaluations WHERE source_event_id = ? ORDER BY sequence_number ASC')
      .all(sourceEventId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToReplayEvaluation(r));
  }

  /**
   * Independently re-walks the replay chain, exactly mirroring verifyChain()'s
   * approach for the audit chain — recomputes each record's hash from its own
   * stored data and the stored previous_replay_hash, failing on the first
   * mismatch or sequence gap. Called by `agentgate audit verify`.
   */
  verifyReplayChain(): { valid: boolean; error?: string; count: number } {
    const records = this.db
      .prepare('SELECT * FROM replay_evaluations ORDER BY sequence_number ASC')
      .all() as Record<string, unknown>[];
    if (records.length === 0) return { valid: true, count: 0 };

    let expectedHash: string | null = null;
    let expectedSeq = 1;

    for (const row of records) {
      if (row.sequence_number !== expectedSeq) {
        return { valid: false, error: `Replay sequence gap at expected seq ${expectedSeq}, found ${row.sequence_number}`, count: expectedSeq - 1 };
      }
      if (row.previous_replay_hash !== expectedHash) {
        return { valid: false, error: `Replay hash chain broken at seq ${expectedSeq}. Expected prev: ${expectedHash}, got: ${row.previous_replay_hash}`, count: expectedSeq - 1 };
      }

      const canonicalPayload = {
        id: row.id,
        source_event_id: row.source_event_id,
        sequence_number: row.sequence_number,
        previous_replay_hash: row.previous_replay_hash,
        evaluated_at: row.evaluated_at,
        policy_digest: row.policy_digest,
        original_decision_type: row.original_decision_type,
        original_rule_id: row.original_rule_id,
        original_reason_code: row.original_reason_code,
        current_decision_type: row.current_decision_type,
        current_rule_id: row.current_rule_id,
        current_reason_code: row.current_reason_code,
        current_explanation: row.current_explanation,
        current_transformations: JSON.parse(row.current_transformations_json as string),
        decision_changed: row.decision_changed === 1,
        matched_rule_changed: row.matched_rule_changed === 1,
        reason_code_changed: row.reason_code_changed === 1,
        source_arguments_redacted: row.source_arguments_redacted === 1,
        limitations: JSON.parse(row.limitations_json as string),
      };

      const computedHash = sha256(canonicalize(canonicalPayload));
      if (computedHash !== row.replay_hash) {
        return { valid: false, error: `Tampering detected in replay chain at seq ${expectedSeq}. Computed hash does not match stored replay_hash.`, count: expectedSeq - 1 };
      }

      expectedHash = row.replay_hash;
      expectedSeq++;
    }

    return { valid: true, count: records.length };
  }

  private rowToReplayEvaluation(row: Record<string, unknown>): ReplayEvaluation {
    return {
      id: row.id as string,
      source_event_id: row.source_event_id as string,
      sequence_number: row.sequence_number as number,
      previous_replay_hash: row.previous_replay_hash as string | null,
      replay_hash: row.replay_hash as string,
      canonical_payload_version: (row.canonical_payload_version as '1' | undefined) ?? '1',
      evaluated_at: row.evaluated_at as string,
      policy_digest: row.policy_digest as string,
      original_decision_type: row.original_decision_type as string | null,
      original_rule_id: row.original_rule_id as string | null,
      original_reason_code: row.original_reason_code as string | null,
      current_decision_type: row.current_decision_type as string,
      current_rule_id: row.current_rule_id as string | null,
      current_reason_code: row.current_reason_code as string,
      current_explanation: row.current_explanation as string,
      current_transformations: JSON.parse(row.current_transformations_json as string) as string[],
      decision_changed: row.decision_changed === 1,
      matched_rule_changed: row.matched_rule_changed === 1,
      reason_code_changed: row.reason_code_changed === 1,
      source_arguments_redacted: row.source_arguments_redacted === 1,
      limitations: JSON.parse(row.limitations_json as string) as string[],
    };
  }

  // ─── Approvals ──────────────────────────────────────────────────────────────

  insertApproval(approval: Omit<Approval, 'id' | 'created_at'>): Approval {
    const id = uuidv4();
    const created_at = new Date().toISOString();
    const full: Approval = { ...approval, id, created_at };
    this.db.prepare(`
      INSERT INTO approvals (id, event_id, status, expires_at, consumed, proposed_action_display, policy_reason, scope, created_at, resolved_at, resolved_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      full.id, full.event_id, full.status, full.expires_at,
      full.consumed ? 1 : 0, full.proposed_action_display, full.policy_reason,
      full.scope, full.created_at, full.resolved_at, full.resolved_by
    );
    return full;
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToApproval(row) : null;
  }

  getApprovalByEventId(eventId: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE event_id = ?').get(eventId) as Record<string, unknown> | undefined;
    return row ? this.rowToApproval(row) : null;
  }

  listPendingApprovals(): Approval[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE status = 'PENDING' ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToApproval(row));
  }

  resolveApproval(id: string, status: ApprovalStatus): void {
    const resolved_at = new Date().toISOString();
    this.db.prepare(`
      UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = 'human', consumed = 1 WHERE id = ?
    `).run(status, resolved_at, id);
  }

  expireStaleApprovals(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE approvals SET status = 'EXPIRED', resolved_at = ? WHERE status = 'PENDING' AND expires_at < ?
    `).run(now, now);
    return result.changes;
  }

  // ─── Agents ─────────────────────────────────────────────────────────────────

  upsertAgent(agent: { session_id: string; identity_json: string; connected_at: string }): void {
    this.db.prepare(`
      INSERT INTO agents (session_id, identity_json, state, connected_at)
      VALUES (?, ?, 'connected', ?)
      ON CONFLICT(session_id) DO UPDATE SET state = 'connected', last_activity_at = ?
    `).run(agent.session_id, agent.identity_json, agent.connected_at, new Date().toISOString());
  }

  disconnectAgent(session_id: string): void {
    this.db.prepare(`UPDATE agents SET state = 'disconnected', last_activity_at = ? WHERE session_id = ?`)
      .run(new Date().toISOString(), session_id);
  }

  // ─── Row Mappers ─────────────────────────────────────────────────────────────

  private rowToEvent(
    row: Record<string, unknown>,
    seq: number,
    prev: string | null,
    hash: string,
    canonicalPayloadVersion: '1' | '2' = '1'
  ): AuditEvent {
    return {
      id: row.id as string,
      sequence_number: seq,
      previous_event_hash: prev,
      event_hash: hash,
      canonical_payload_version: canonicalPayloadVersion,
      created_at: row.created_at as string,
      agent: JSON.parse(row.agent_json as string),
      tool_call: JSON.parse(row.tool_call_json as string),
      status: row.status as AuditEvent['status'],
      decision: row.decision_json ? JSON.parse(row.decision_json as string) : null,
      execution_succeeded: row.execution_succeeded === null ? null : row.execution_succeeded === 1,
      execution_error: row.execution_error as string | null,
      duration_ms: row.duration_ms as number | null,
      arguments_redacted: row.arguments_redacted === 1,
      result_redacted: row.result_redacted === 1,
      result_blocked: row.result_blocked === 1,
      result_finding_count: (row.result_finding_count as number | null) ?? 0,
      error_redacted: row.error_redacted === 1,
    };
  }

  private rowToApproval(row: Record<string, unknown>): Approval {
    return {
      id: row.id as string,
      event_id: row.event_id as string,
      status: row.status as ApprovalStatus,
      expires_at: row.expires_at as string,
      consumed: row.consumed === 1,
      proposed_action_display: row.proposed_action_display as string,
      policy_reason: row.policy_reason as string,
      scope: row.scope as string,
      created_at: row.created_at as string,
      resolved_at: row.resolved_at as string | null,
      resolved_by: row.resolved_by as 'human' | null,
    };
  }

  close(): void {
    this.db.close();
  }
}
