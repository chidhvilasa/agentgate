import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { AuditEvent, Approval, ApprovalStatus } from '@agentgate/protocol';

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
];

// ─── Canonical Payload for Hashing ────────────────────────────────────────────

function canonicalize(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const sorted = Object.keys(obj as object)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k]));
  return '{' + sorted.join(',') + '}';
}

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

// ─── Storage Class ────────────────────────────────────────────────────────────

export class AuditStorage {
  private db: Database.Database;
  private nextSeq: number;
  private lastHash: string | null;

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

  private appendLifecycleRecord(
    eventId: string,
    eventData: AuditEvent,
    updates?: Partial<Pick<AuditEvent, 'execution_succeeded' | 'execution_error' | 'duration_ms' | 'decision'>>
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

    const canonicalPayload = {
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
    };

    const record_hash = sha256(canonicalize(canonicalPayload));
    this.lastHash = record_hash;

    this.db.prepare(`
      INSERT INTO audit_lifecycle_records (
        record_id, event_id, sequence_number, previous_record_hash, record_hash,
        canonical_payload_version, created_at, status, decision_json,
        execution_succeeded, execution_error, duration_ms
      ) VALUES (?, ?, ?, ?, ?, '1', ?, ?, ?, ?, ?, ?)
    `).run(
      record_id, eventId, sequence_number, previous_record_hash, record_hash,
      created_at, status, decision_json, execution_succeeded, execution_error, duration_ms
    );

    return { sequence_number, previous_event_hash: previous_record_hash, event_hash: record_hash };
  }

  insertEvent(eventData: Omit<AuditEvent, 'sequence_number' | 'previous_event_hash' | 'event_hash' | 'canonical_payload_version'>): AuditEvent {
    // Insert into mutable projection table
    this.db.prepare(`
      INSERT INTO audit_events (
        id, created_at, agent_json, tool_call_json,
        status, decision_json, execution_succeeded, execution_error,
        duration_ms, arguments_redacted, result_redacted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventData.id, eventData.created_at, JSON.stringify(eventData.agent), JSON.stringify(eventData.tool_call),
      eventData.status, eventData.decision ? JSON.stringify(eventData.decision) : null,
      eventData.execution_succeeded === null ? null : eventData.execution_succeeded ? 1 : 0,
      eventData.execution_error, eventData.duration_ms,
      eventData.arguments_redacted ? 1 : 0, eventData.result_redacted ? 1 : 0
    );

    const event: AuditEvent = { ...eventData, sequence_number: 0, previous_event_hash: null, event_hash: '', canonical_payload_version: '1' };

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
    updates: Partial<Pick<AuditEvent, 'execution_succeeded' | 'execution_error' | 'duration_ms' | 'decision'>>
  ): void {
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE audit_events SET
          status = ?,
          execution_succeeded = COALESCE(?, execution_succeeded),
          execution_error = COALESCE(?, execution_error),
          duration_ms = COALESCE(?, duration_ms),
          decision_json = COALESCE(?, decision_json)
        WHERE id = ?
      `).run(
        status,
        updates.execution_succeeded === undefined ? null : updates.execution_succeeded ? 1 : 0,
        updates.execution_error ?? null,
        updates.duration_ms ?? null,
        updates.decision ? JSON.stringify(updates.decision) : null,
        id
      );

      const updatedEventRow = this.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as Record<string, unknown>;
      if (updatedEventRow) {
        // Fetch the event using the internal row mapping logic, but stub out the hashes since we are only using it to generate the lifecycle payload
        const updatedEvent = this.rowToEvent(updatedEventRow, 0, null, '');
        this.appendLifecycleRecord(id, updatedEvent, updates);
      }
    })();
  }

  listEvents(opts: { limit?: number; offset?: number; status?: string; tool?: string } = {}): AuditEvent[] {
    const { limit = 50, offset = 0, status, tool } = opts;
    let query = 'SELECT e.*, l.sequence_number, l.previous_record_hash, l.record_hash FROM audit_events e LEFT JOIN (SELECT event_id, MAX(sequence_number) as max_seq FROM audit_lifecycle_records GROUP BY event_id) latest ON e.id = latest.event_id LEFT JOIN audit_lifecycle_records l ON e.id = l.event_id AND latest.max_seq = l.sequence_number';
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (status) { conditions.push('e.status = ?'); params.push(status); }
    if (tool) { conditions.push('e.tool_call_json LIKE ?'); params.push(`%"tool":"${tool}"%`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY e.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToEvent(r, r.sequence_number as number, r.previous_record_hash as string, r.record_hash as string));
  }

  getEvent(id: string): AuditEvent | null {
    const query = 'SELECT e.*, l.sequence_number, l.previous_record_hash, l.record_hash FROM audit_events e LEFT JOIN (SELECT event_id, MAX(sequence_number) as max_seq FROM audit_lifecycle_records GROUP BY event_id) latest ON e.id = latest.event_id LEFT JOIN audit_lifecycle_records l ON e.id = l.event_id AND latest.max_seq = l.sequence_number WHERE e.id = ?';
    const row = this.db.prepare(query).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEvent(row, row.sequence_number as number, row.previous_record_hash as string, row.record_hash as string) : null;
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

      const eventRow = this.db.prepare('SELECT agent_json, tool_call_json FROM audit_events WHERE id = ?').get(row.event_id as string) as { agent_json: string; tool_call_json: string } | undefined;
      if (!eventRow) {
         return { valid: false, error: `Missing event data for record seq ${expectedSeq}`, count: expectedSeq - 1 };
      }

      const agent = JSON.parse(eventRow.agent_json);
      const toolCall = JSON.parse(eventRow.tool_call_json);

      const canonicalPayload = {
        record_id: row.record_id,
        event_id: row.event_id,
        sequence_number: row.sequence_number,
        previous_record_hash: row.previous_record_hash,
        created_at: row.created_at,
        status: row.status,
        decision_type: row.decision_json ? JSON.parse(row.decision_json as string).type : null,
        execution_succeeded: row.execution_succeeded,
        execution_error: row.execution_error,
        duration_ms: row.duration_ms,
        agent_session_id: agent.session_id,
        tool: toolCall.tool,
        normalized_arguments: toolCall.normalized_arguments,
      };

      const computedHash = sha256(canonicalize(canonicalPayload));
      if (computedHash !== row.record_hash) {
        return { valid: false, error: `Tampering detected at seq ${expectedSeq}. Computed hash does not match stored record_hash.`, count: expectedSeq - 1 };
      }

      expectedHash = row.record_hash as string;
      expectedSeq++;
    }

    return { valid: true, count: records.length };
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
    return rows.map(this.rowToApproval);
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

  private rowToEvent(row: Record<string, unknown>, seq: number, prev: string | null, hash: string): AuditEvent {
    return {
      id: row.id as string,
      sequence_number: seq,
      previous_event_hash: prev,
      event_hash: hash,
      canonical_payload_version: '1',
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
