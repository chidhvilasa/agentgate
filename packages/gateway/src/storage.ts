import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { AuditEvent, Approval, ApprovalStatus, ReplayEvaluation } from '@agentgate/protocol';
import type { ToolIntegrityEvent, ToolIntegrityState } from './tool-integrity/types.js';
import type { ContextEvent, ContextState } from './context-guard/types.js';

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
  // Milestone 6 (ADR-0012): Tool Integrity Registry. Two tables, mirroring
  // the audit_events/audit_lifecycle_records pattern (ADR-0004) rather than
  // the single-table replay_evaluations pattern (ADR-0010), because a tool
  // DOES have a mutable "current state" worth projecting cheaply (is this
  // tool trusted right now?) that the gateway's enforcement path needs to
  // check on every discovery/call — replaying the full event log on every
  // check would be both slow and unnecessary. `tool_integrity_events` is
  // the append-only, hash-chained source of truth; `tool_integrity_state`
  // is a mutable projection over it, exactly like `audit_events` is over
  // `audit_lifecycle_records`. MUST stay appended at the end of MIGRATIONS
  // — see the ADR-0009 migration above for why.
  `
  CREATE TABLE IF NOT EXISTS tool_integrity_events (
    id TEXT PRIMARY KEY,
    sequence_number INTEGER NOT NULL UNIQUE,
    previous_event_hash TEXT,
    event_hash TEXT NOT NULL,
    canonical_payload_version TEXT NOT NULL DEFAULT '1',
    created_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    server_identity TEXT NOT NULL,
    server_id TEXT NOT NULL,
    tool_name TEXT,
    fingerprint TEXT,
    previous_fingerprint TEXT,
    manifest_fingerprint TEXT,
    state_before TEXT,
    state_after TEXT,
    reviewer TEXT,
    reason TEXT,
    definition_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tool_integrity_events_server ON tool_integrity_events(server_identity);
  CREATE INDEX IF NOT EXISTS idx_tool_integrity_events_tool ON tool_integrity_events(server_identity, tool_name);

  CREATE TABLE IF NOT EXISTS tool_integrity_state (
    server_identity TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    server_id TEXT NOT NULL,
    status TEXT NOT NULL,
    current_fingerprint TEXT,
    trusted_fingerprint TEXT,
    candidate_fingerprint TEXT,
    candidate_id TEXT,
    trusted_definition_json TEXT,
    candidate_definition_json TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_scan_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (server_identity, tool_name)
  );
  `,
  // Milestone 7 (ADR-0013): Context Guard. Same two-table pattern as Tool
  // Integrity above (append-only `context_events` source of truth +
  // `context_state` mutable projection, needed because contextual policy
  // evaluation needs a cheap "what labels does the active context have
  // right now" lookup on every tool call, not a full event-log replay).
  // Also extends `approvals` with nullable binding columns so a contextual
  // `require_approval` can be bound to an EXACT context revision, tool
  // fingerprint, and redacted-argument digest — a pre-Milestone-7 approval
  // row simply has NULL in all of them, meaning "not context-bound", and
  // is treated as such everywhere this project checks for context binding.
  // MUST stay appended at the end of MIGRATIONS — see the ADR-0009
  // migration above for why.
  `
  CREATE TABLE IF NOT EXISTS context_events (
    id TEXT PRIMARY KEY,
    sequence_number INTEGER NOT NULL UNIQUE,
    previous_event_hash TEXT,
    event_hash TEXT NOT NULL,
    canonical_payload_version TEXT NOT NULL DEFAULT '1',
    created_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    context_id TEXT NOT NULL,
    revision_before INTEGER,
    revision_after INTEGER,
    labels_added_json TEXT,
    source_event_id TEXT,
    tool_name TEXT,
    rule_id TEXT,
    action TEXT,
    reviewer TEXT,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_context_events_context ON context_events(context_id);

  CREATE TABLE IF NOT EXISTS context_state (
    context_id TEXT PRIMARY KEY,
    server_identity TEXT,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    last_event_id TEXT
  );

  ALTER TABLE approvals ADD COLUMN context_id TEXT;
  ALTER TABLE approvals ADD COLUMN context_revision INTEGER;
  ALTER TABLE approvals ADD COLUMN tool_fingerprint TEXT;
  ALTER TABLE approvals ADD COLUMN argument_digest TEXT;
  ALTER TABLE approvals ADD COLUMN contextual_rule_id TEXT;
  `,
];

/**
 * Stable, named identities for the `schema_version` each migration above
 * produces once applied (1-based, matching the `version` column — i.e.
 * `MIGRATIONS[i]` applies as version `i + 1`). Exists so any caller that
 * needs "the database as it looked right before milestone X" — chiefly
 * migration/tamper-evidence test fixtures — can pin an exact, named
 * version instead of an assumption like "the highest schema_version row is
 * the migration under test", which silently becomes false every time a
 * later migration is appended (see the regression this replaced in
 * tool-integrity-storage-migration.test.ts). Add a new named constant here
 * whenever a new migration is appended; never renumber or remove an
 * existing one — MIGRATIONS itself is append-only for the same reason (see
 * the ADR-0009 comment on the migration above).
 */
export const MIGRATION_VERSIONS = {
  /** schema_version + audit_events + audit_lifecycle_records + approvals + agents tables. */
  BASE: 5,
  /** ADR-0009: bidirectional result/error secret safety columns. */
  OUTPUT_SECURITY: 6,
  /** ADR-0010: Safe Replay lineage table. */
  SAFE_REPLAY: 7,
  /** ADR-0012 (Milestone 6): Tool Integrity Registry tables. */
  TOOL_INTEGRITY: 8,
  /** ADR-0013 (Milestone 7): Context Guard tables + approvals binding columns. */
  CONTEXT_GUARD: 9,
} as const;

// Self-check: CONTEXT_GUARD must always equal the highest applied version.
// If a future migration is appended without adding/updating a named
// constant above, this throws immediately at import time instead of
// letting a version-pinned fixture silently target the wrong migration.
if (MIGRATION_VERSIONS.CONTEXT_GUARD !== MIGRATIONS.length) {
  throw new Error(
    `MIGRATION_VERSIONS is out of sync with MIGRATIONS (expected CONTEXT_GUARD === ${MIGRATIONS.length}, got ${MIGRATION_VERSIONS.CONTEXT_GUARD}). Add a new named constant for the newly appended migration and update this check.`
  );
}

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
  private nextToolIntegritySeq: number;
  private lastToolIntegrityHash: string | null;
  private nextContextSeq: number;
  private lastContextHash: string | null;

  /**
   * @param opts.migrateThroughVersion Test/internal-only: caps migration at
   *   an exact `MIGRATION_VERSIONS` value instead of the latest
   *   (`MIGRATIONS.length`). Lets a test build an authentic "database as of
   *   milestone X" fixture by running the REAL production migration SQL up
   *   to that point — never by hand-copying a historical schema or deleting
   *   `schema_version` rows out of a fully-migrated database. Production
   *   code must never pass this; omitting it (the default) always migrates
   *   to latest.
   */
  constructor(dbPath: string, opts?: { migrateThroughVersion?: number }) {
    this.db = new Database(dbPath);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.runMigrations(opts?.migrateThroughVersion ?? MIGRATIONS.length);

      // Resume sequence and hash chain from last stored record
      const last = this.db
        .prepare('SELECT sequence_number, record_hash FROM audit_lifecycle_records ORDER BY sequence_number DESC LIMIT 1')
        .get() as { sequence_number: number; record_hash: string } | undefined;

      this.nextSeq = last ? last.sequence_number + 1 : 1;
      this.lastHash = last?.record_hash ?? null;

      // Resume the independent replay-evaluation chain (ADR-0010). Guarded
      // by tableExists(): a database intentionally capped below
      // MIGRATION_VERSIONS.SAFE_REPLAY via `migrateThroughVersion` (test
      // fixtures only — see above) won't have this table yet; every
      // production database always does by the time this runs.
      const lastReplay = this.tableExists('replay_evaluations')
        ? (this.db
            .prepare('SELECT sequence_number, replay_hash FROM replay_evaluations ORDER BY sequence_number DESC LIMIT 1')
            .get() as { sequence_number: number; replay_hash: string } | undefined)
        : undefined;

      this.nextReplaySeq = lastReplay ? lastReplay.sequence_number + 1 : 1;
      this.lastReplayHash = lastReplay?.replay_hash ?? null;

      // Resume the independent Tool Integrity chain (ADR-0012) — guarded, see above.
      const lastToolIntegrity = this.tableExists('tool_integrity_events')
        ? (this.db
            .prepare('SELECT sequence_number, event_hash FROM tool_integrity_events ORDER BY sequence_number DESC LIMIT 1')
            .get() as { sequence_number: number; event_hash: string } | undefined)
        : undefined;

      this.nextToolIntegritySeq = lastToolIntegrity ? lastToolIntegrity.sequence_number + 1 : 1;
      this.lastToolIntegrityHash = lastToolIntegrity?.event_hash ?? null;

      // Resume the independent Context Guard chain (ADR-0013) — guarded, see above.
      const lastContext = this.tableExists('context_events')
        ? (this.db
            .prepare('SELECT sequence_number, event_hash FROM context_events ORDER BY sequence_number DESC LIMIT 1')
            .get() as { sequence_number: number; event_hash: string } | undefined)
        : undefined;

      this.nextContextSeq = lastContext ? lastContext.sequence_number + 1 : 1;
      this.lastContextHash = lastContext?.event_hash ?? null;
    } catch (err) {
      // Never leak an open SQLite handle if construction fails partway
      // through (e.g. a migration error) — better-sqlite3 holds the
      // OS-level file lock open until .close() is called, which on Windows
      // blocks even deleting the file until the handle is released. Close
      // before rethrowing the ORIGINAL error unchanged (no detail added or
      // removed) so callers see exactly what failed.
      try {
        this.db.close();
      } catch {
        // Already closed or unclosable — the original error is what matters.
      }
      throw err;
    }
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  }

  private runMigrations(throughVersion: number): void {
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
    const target = Math.min(throughVersion, MIGRATIONS.length);

    for (let i = currentVersion; i < target; i++) {
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
      INSERT INTO approvals (
        id, event_id, status, expires_at, consumed, proposed_action_display, policy_reason, scope,
        created_at, resolved_at, resolved_by, context_id, context_revision, tool_fingerprint,
        argument_digest, contextual_rule_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      full.id, full.event_id, full.status, full.expires_at,
      full.consumed ? 1 : 0, full.proposed_action_display, full.policy_reason,
      full.scope, full.created_at, full.resolved_at, full.resolved_by,
      full.context_id, full.context_revision, full.tool_fingerprint,
      full.argument_digest, full.contextual_rule_id
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

  // ─── Tool Integrity Registry (Milestone 6, ADR-0012) ───────────────────────

  /**
   * Appends one immutable, hash-chained Tool Integrity event. This method
   * only persists and hash-chains what it is given — all state-machine
   * decision logic (what event to emit, whether a transition is valid)
   * lives in `tool-integrity/registry.ts`, exactly mirroring how
   * `insertReplayEvaluation()` only persists what `replay.ts` already
   * decided.
   */
  insertToolIntegrityEvent(
    data: Omit<ToolIntegrityEvent, 'id' | 'sequence_number' | 'previous_event_hash' | 'event_hash' | 'canonical_payload_version'>
  ): ToolIntegrityEvent {
    const id = uuidv4();
    const sequence_number = this.nextToolIntegritySeq++;
    const previous_event_hash = this.lastToolIntegrityHash;
    const canonical_payload_version = '1' as const;

    const canonicalPayload = {
      id,
      sequence_number,
      previous_event_hash,
      created_at: data.created_at,
      event_type: data.event_type,
      server_identity: data.server_identity,
      server_id: data.server_id,
      tool_name: data.tool_name,
      fingerprint: data.fingerprint,
      previous_fingerprint: data.previous_fingerprint,
      manifest_fingerprint: data.manifest_fingerprint,
      state_before: data.state_before,
      state_after: data.state_after,
      reviewer: data.reviewer,
      reason: data.reason,
      definition_json: data.definition_json,
    };

    const event_hash = sha256(canonicalize(canonicalPayload));
    this.lastToolIntegrityHash = event_hash;

    this.db
      .prepare(
        `INSERT INTO tool_integrity_events (
          id, sequence_number, previous_event_hash, event_hash, canonical_payload_version,
          created_at, event_type, server_identity, server_id, tool_name,
          fingerprint, previous_fingerprint, manifest_fingerprint,
          state_before, state_after, reviewer, reason, definition_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        sequence_number,
        previous_event_hash,
        event_hash,
        canonical_payload_version,
        data.created_at,
        data.event_type,
        data.server_identity,
        data.server_id,
        data.tool_name,
        data.fingerprint,
        data.previous_fingerprint,
        data.manifest_fingerprint,
        data.state_before,
        data.state_after,
        data.reviewer,
        data.reason,
        data.definition_json
      );

    return { ...data, id, sequence_number, previous_event_hash, event_hash, canonical_payload_version };
  }

  /** Lists all Tool Integrity events, optionally scoped to one server and/or tool, oldest first. */
  listToolIntegrityEvents(filter: { serverIdentity?: string; toolName?: string } = {}): ToolIntegrityEvent[] {
    let sql = 'SELECT * FROM tool_integrity_events';
    const params: string[] = [];
    const clauses: string[] = [];
    if (filter.serverIdentity) {
      clauses.push('server_identity = ?');
      params.push(filter.serverIdentity);
    }
    if (filter.toolName) {
      clauses.push('tool_name = ?');
      params.push(filter.toolName);
    }
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY sequence_number ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToToolIntegrityEvent(r));
  }

  /** Reads the current projected state for one (server, tool) pair, or null if never observed. */
  getToolIntegrityState(serverIdentity: string, toolName: string): ToolIntegrityState | null {
    const row = this.db
      .prepare('SELECT * FROM tool_integrity_state WHERE server_identity = ? AND tool_name = ?')
      .get(serverIdentity, toolName) as Record<string, unknown> | undefined;
    return row ? this.rowToToolIntegrityState(row) : null;
  }

  /** Lists every tool's current state, optionally scoped to one server. */
  listToolIntegrityState(serverIdentity?: string): ToolIntegrityState[] {
    const rows = serverIdentity
      ? (this.db.prepare('SELECT * FROM tool_integrity_state WHERE server_identity = ? ORDER BY tool_name ASC').all(serverIdentity) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM tool_integrity_state ORDER BY server_identity ASC, tool_name ASC').all() as Record<string, unknown>[]);
    return rows.map((r) => this.rowToToolIntegrityState(r));
  }

  /**
   * Writes (creates or overwrites) the current projected state for one
   * (server, tool) pair. This is a mutable projection, exactly like
   * `audit_events` is over `audit_lifecycle_records` — the append-only
   * source of truth is `tool_integrity_events`; this table only exists so
   * enforcement checks are a cheap primary-key lookup instead of a full
   * event-log replay on every discovery/call.
   */
  upsertToolIntegrityState(state: ToolIntegrityState): void {
    this.db
      .prepare(
        `INSERT INTO tool_integrity_state (
          server_identity, tool_name, server_id, status, current_fingerprint,
          trusted_fingerprint, candidate_fingerprint, candidate_id,
          trusted_definition_json, candidate_definition_json,
          first_seen_at, last_seen_at, last_scan_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_identity, tool_name) DO UPDATE SET
          server_id = excluded.server_id,
          status = excluded.status,
          current_fingerprint = excluded.current_fingerprint,
          trusted_fingerprint = excluded.trusted_fingerprint,
          candidate_fingerprint = excluded.candidate_fingerprint,
          candidate_id = excluded.candidate_id,
          trusted_definition_json = excluded.trusted_definition_json,
          candidate_definition_json = excluded.candidate_definition_json,
          last_seen_at = excluded.last_seen_at,
          last_scan_at = excluded.last_scan_at,
          updated_at = excluded.updated_at`
      )
      .run(
        state.server_identity,
        state.tool_name,
        state.server_id,
        state.status,
        state.current_fingerprint,
        state.trusted_fingerprint,
        state.candidate_fingerprint,
        state.candidate_id,
        state.trusted_definition_json,
        state.candidate_definition_json,
        state.first_seen_at,
        state.last_seen_at,
        state.last_scan_at,
        state.updated_at
      );
  }

  /**
   * Independently re-walks the Tool Integrity event chain, exactly
   * mirroring verifyChain()/verifyReplayChain()'s approach — recomputes
   * each event's hash from its own stored data and the stored
   * previous_event_hash, failing on the first mismatch or sequence gap.
   */
  verifyToolIntegrityChain(): { valid: boolean; error?: string; count: number } {
    const rows = this.db.prepare('SELECT * FROM tool_integrity_events ORDER BY sequence_number ASC').all() as Record<string, unknown>[];
    if (rows.length === 0) return { valid: true, count: 0 };

    let expectedHash: string | null = null;
    let expectedSeq = 1;

    for (const row of rows) {
      if (row.sequence_number !== expectedSeq) {
        return { valid: false, error: `Tool Integrity sequence gap at expected seq ${expectedSeq}, found ${row.sequence_number}`, count: expectedSeq - 1 };
      }
      if (row.previous_event_hash !== expectedHash) {
        return { valid: false, error: `Tool Integrity hash chain broken at seq ${expectedSeq}. Expected prev: ${expectedHash}, got: ${row.previous_event_hash}`, count: expectedSeq - 1 };
      }

      const canonicalPayload = {
        id: row.id,
        sequence_number: row.sequence_number,
        previous_event_hash: row.previous_event_hash,
        created_at: row.created_at,
        event_type: row.event_type,
        server_identity: row.server_identity,
        server_id: row.server_id,
        tool_name: row.tool_name,
        fingerprint: row.fingerprint,
        previous_fingerprint: row.previous_fingerprint,
        manifest_fingerprint: row.manifest_fingerprint,
        state_before: row.state_before,
        state_after: row.state_after,
        reviewer: row.reviewer,
        reason: row.reason,
        definition_json: row.definition_json,
      };

      const computedHash = sha256(canonicalize(canonicalPayload));
      if (computedHash !== row.event_hash) {
        return { valid: false, error: `Tampering detected in Tool Integrity chain at seq ${expectedSeq}. Computed hash does not match stored event_hash.`, count: expectedSeq - 1 };
      }

      expectedHash = row.event_hash;
      expectedSeq++;
    }

    return { valid: true, count: rows.length };
  }

  private rowToToolIntegrityEvent(row: Record<string, unknown>): ToolIntegrityEvent {
    return {
      id: row.id as string,
      sequence_number: row.sequence_number as number,
      previous_event_hash: row.previous_event_hash as string | null,
      event_hash: row.event_hash as string,
      canonical_payload_version: (row.canonical_payload_version as string | undefined) ?? '1',
      created_at: row.created_at as string,
      event_type: row.event_type as ToolIntegrityEvent['event_type'],
      server_identity: row.server_identity as string,
      server_id: row.server_id as string,
      tool_name: row.tool_name as string | null,
      fingerprint: row.fingerprint as string | null,
      previous_fingerprint: row.previous_fingerprint as string | null,
      manifest_fingerprint: row.manifest_fingerprint as string | null,
      state_before: row.state_before as ToolIntegrityEvent['state_before'],
      state_after: row.state_after as ToolIntegrityEvent['state_after'],
      reviewer: row.reviewer as string | null,
      reason: row.reason as string | null,
      definition_json: row.definition_json as string | null,
    };
  }

  private rowToToolIntegrityState(row: Record<string, unknown>): ToolIntegrityState {
    return {
      server_identity: row.server_identity as string,
      server_id: row.server_id as string,
      tool_name: row.tool_name as string,
      status: row.status as ToolIntegrityState['status'],
      current_fingerprint: row.current_fingerprint as string | null,
      trusted_fingerprint: row.trusted_fingerprint as string | null,
      candidate_fingerprint: row.candidate_fingerprint as string | null,
      candidate_id: row.candidate_id as string | null,
      trusted_definition_json: row.trusted_definition_json as string | null,
      candidate_definition_json: row.candidate_definition_json as string | null,
      first_seen_at: row.first_seen_at as string,
      last_seen_at: row.last_seen_at as string,
      last_scan_at: row.last_scan_at as string,
      updated_at: row.updated_at as string,
    };
  }

  // ─── Context Guard (Milestone 7, ADR-0013) ─────────────────────────────────

  /**
   * Appends one immutable, hash-chained Context Guard event. Mirrors
   * `insertToolIntegrityEvent()`'s exact pattern — this method only
   * persists and hash-chains what it is given; all state-machine decision
   * logic lives in `context-guard/state.ts`.
   */
  insertContextEvent(
    data: Omit<ContextEvent, 'id' | 'sequence_number' | 'previous_event_hash' | 'event_hash' | 'canonical_payload_version'>
  ): ContextEvent {
    const id = uuidv4();
    const sequence_number = this.nextContextSeq++;
    const previous_event_hash = this.lastContextHash;
    const canonical_payload_version = '1' as const;

    const canonicalPayload = {
      id,
      sequence_number,
      previous_event_hash,
      created_at: data.created_at,
      event_type: data.event_type,
      context_id: data.context_id,
      revision_before: data.revision_before,
      revision_after: data.revision_after,
      labels_added: data.labels_added,
      source_event_id: data.source_event_id,
      tool_name: data.tool_name,
      rule_id: data.rule_id,
      action: data.action,
      reviewer: data.reviewer,
      reason: data.reason,
    };

    const event_hash = sha256(canonicalize(canonicalPayload));
    this.lastContextHash = event_hash;

    this.db
      .prepare(
        `INSERT INTO context_events (
          id, sequence_number, previous_event_hash, event_hash, canonical_payload_version,
          created_at, event_type, context_id, revision_before, revision_after,
          labels_added_json, source_event_id, tool_name, rule_id, action, reviewer, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        sequence_number,
        previous_event_hash,
        event_hash,
        canonical_payload_version,
        data.created_at,
        data.event_type,
        data.context_id,
        data.revision_before,
        data.revision_after,
        data.labels_added ? JSON.stringify(data.labels_added) : null,
        data.source_event_id,
        data.tool_name,
        data.rule_id,
        data.action,
        data.reviewer,
        data.reason
      );

    return { ...data, id, sequence_number, previous_event_hash, event_hash, canonical_payload_version };
  }

  /** Lists all Context Guard events, optionally scoped to one context, oldest first, optionally bounded to the most recent N. */
  listContextEvents(filter: { contextId?: string; limit?: number } = {}): ContextEvent[] {
    let sql = 'SELECT * FROM context_events';
    const params: (string | number)[] = [];
    if (filter.contextId) {
      sql += ' WHERE context_id = ?';
      params.push(filter.contextId);
    }
    sql += ' ORDER BY sequence_number ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    const mapped = rows.map((r) => this.rowToContextEvent(r));
    return filter.limit ? mapped.slice(-filter.limit) : mapped;
  }

  /** Reads the current projected state for one context, or null if it has never been created. */
  getContextState(contextId: string): ContextState | null {
    const row = this.db.prepare('SELECT * FROM context_state WHERE context_id = ?').get(contextId) as Record<string, unknown> | undefined;
    return row ? this.rowToContextState(row) : null;
  }

  /** Lists every known context's current state, most recently updated first. */
  listContextStates(): ContextState[] {
    const rows = this.db.prepare('SELECT * FROM context_state ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToContextState(r));
  }

  /**
   * Writes (creates or overwrites) the current projected state for one
   * context — a mutable projection, exactly like `tool_integrity_state`.
   * The append-only source of truth is `context_events`.
   */
  upsertContextState(state: ContextState): void {
    this.db
      .prepare(
        `INSERT INTO context_state (
          context_id, server_identity, revision, status, labels_json,
          created_at, updated_at, expires_at, last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(context_id) DO UPDATE SET
          server_identity = excluded.server_identity,
          revision = excluded.revision,
          status = excluded.status,
          labels_json = excluded.labels_json,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at,
          last_event_id = excluded.last_event_id`
      )
      .run(
        state.context_id,
        state.server_identity,
        state.revision,
        state.status,
        JSON.stringify(state.labels),
        state.created_at,
        state.updated_at,
        state.expires_at,
        state.last_event_id
      );
  }

  /**
   * Independently re-walks the Context Guard event chain, exactly
   * mirroring verifyToolIntegrityChain()'s approach.
   */
  verifyContextChain(): { valid: boolean; error?: string; count: number } {
    const rows = this.db.prepare('SELECT * FROM context_events ORDER BY sequence_number ASC').all() as Record<string, unknown>[];
    if (rows.length === 0) return { valid: true, count: 0 };

    let expectedHash: string | null = null;
    let expectedSeq = 1;

    for (const row of rows) {
      if (row.sequence_number !== expectedSeq) {
        return { valid: false, error: `Context Guard sequence gap at expected seq ${expectedSeq}, found ${row.sequence_number}`, count: expectedSeq - 1 };
      }
      if (row.previous_event_hash !== expectedHash) {
        return { valid: false, error: `Context Guard hash chain broken at seq ${expectedSeq}. Expected prev: ${expectedHash}, got: ${row.previous_event_hash}`, count: expectedSeq - 1 };
      }

      const canonicalPayload = {
        id: row.id,
        sequence_number: row.sequence_number,
        previous_event_hash: row.previous_event_hash,
        created_at: row.created_at,
        event_type: row.event_type,
        context_id: row.context_id,
        revision_before: row.revision_before,
        revision_after: row.revision_after,
        labels_added: row.labels_added_json ? JSON.parse(row.labels_added_json as string) : null,
        source_event_id: row.source_event_id,
        tool_name: row.tool_name,
        rule_id: row.rule_id,
        action: row.action,
        reviewer: row.reviewer,
        reason: row.reason,
      };

      const computedHash = sha256(canonicalize(canonicalPayload));
      if (computedHash !== row.event_hash) {
        return { valid: false, error: `Tampering detected in Context Guard chain at seq ${expectedSeq}. Computed hash does not match stored event_hash.`, count: expectedSeq - 1 };
      }

      expectedHash = row.event_hash;
      expectedSeq++;
    }

    return { valid: true, count: rows.length };
  }

  private rowToContextEvent(row: Record<string, unknown>): ContextEvent {
    return {
      id: row.id as string,
      sequence_number: row.sequence_number as number,
      previous_event_hash: row.previous_event_hash as string | null,
      event_hash: row.event_hash as string,
      canonical_payload_version: (row.canonical_payload_version as string | undefined) ?? '1',
      created_at: row.created_at as string,
      event_type: row.event_type as ContextEvent['event_type'],
      context_id: row.context_id as string,
      revision_before: row.revision_before as number | null,
      revision_after: row.revision_after as number | null,
      labels_added: row.labels_added_json ? (JSON.parse(row.labels_added_json as string) as string[]) : null,
      source_event_id: row.source_event_id as string | null,
      tool_name: row.tool_name as string | null,
      rule_id: row.rule_id as string | null,
      action: row.action as string | null,
      reviewer: row.reviewer as string | null,
      reason: row.reason as string | null,
    };
  }

  private rowToContextState(row: Record<string, unknown>): ContextState {
    return {
      context_id: row.context_id as string,
      server_identity: row.server_identity as string | null,
      revision: row.revision as number,
      status: row.status as ContextState['status'],
      labels: JSON.parse(row.labels_json as string) as string[],
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      expires_at: row.expires_at as string | null,
      last_event_id: row.last_event_id as string | null,
    };
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
      context_id: (row.context_id as string | null) ?? null,
      context_revision: (row.context_revision as number | null) ?? null,
      tool_fingerprint: (row.tool_fingerprint as string | null) ?? null,
      argument_digest: (row.argument_digest as string | null) ?? null,
      contextual_rule_id: (row.contextual_rule_id as string | null) ?? null,
    };
  }

  close(): void {
    this.db.close();
  }
}
