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
    sequence_number INTEGER NOT NULL UNIQUE,
    previous_event_hash TEXT,
    event_hash TEXT NOT NULL,
    canonical_payload_version TEXT NOT NULL DEFAULT '1',
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

/**
 * Produces a stable, canonical JSON string for hashing.
 * Keys are sorted to ensure determinism regardless of insertion order.
 * This hashes the REDACTED representation — secrets must never be hashed.
 */
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

    // Resume sequence and hash chain from last stored event
    const last = this.db
      .prepare('SELECT sequence_number, event_hash FROM audit_events ORDER BY sequence_number DESC LIMIT 1')
      .get() as { sequence_number: number; event_hash: string } | undefined;

    this.nextSeq = last ? last.sequence_number + 1 : 1;
    this.lastHash = last?.event_hash ?? null;
  }

  private runMigrations(): void {
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
   * Inserts a new audit event into the tamper-evident chain.
   *
   * IMPORTANT: `event.tool_call.normalized_arguments` MUST already be
   * redacted before calling this method. Never pass raw arguments containing
   * secrets to this function.
   */
  insertEvent(eventData: Omit<AuditEvent, 'sequence_number' | 'previous_event_hash' | 'event_hash' | 'canonical_payload_version'>): AuditEvent {
    const sequence_number = this.nextSeq++;
    const previous_event_hash = this.lastHash;

    // Build the canonical payload for hashing (redacted args are already in eventData)
    const canonicalPayload = {
      id: eventData.id,
      sequence_number,
      previous_event_hash,
      created_at: eventData.created_at,
      agent_session_id: eventData.agent.session_id,
      tool: eventData.tool_call.tool,
      normalized_arguments: eventData.tool_call.normalized_arguments,
      status: eventData.status,
      decision_type: eventData.decision?.type ?? null,
    };

    const event_hash = sha256(canonicalize(canonicalPayload));
    this.lastHash = event_hash;

    const event: AuditEvent = {
      ...eventData,
      sequence_number,
      previous_event_hash,
      event_hash,
      canonical_payload_version: '1',
    };

    this.db.prepare(`
      INSERT INTO audit_events (
        id, sequence_number, previous_event_hash, event_hash,
        canonical_payload_version, created_at, agent_json, tool_call_json,
        status, decision_json, execution_succeeded, execution_error,
        duration_ms, arguments_redacted, result_redacted
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      event.id, sequence_number, previous_event_hash, event_hash,
      '1', event.created_at,
      JSON.stringify(event.agent), JSON.stringify(event.tool_call),
      event.status, event.decision ? JSON.stringify(event.decision) : null,
      event.execution_succeeded === null ? null : event.execution_succeeded ? 1 : 0,
      event.execution_error, event.duration_ms,
      event.arguments_redacted ? 1 : 0, event.result_redacted ? 1 : 0
    );

    return event;
  }

  /** Updates a stored event's status and terminal fields. */
  updateEventStatus(
    id: string,
    status: AuditEvent['status'],
    updates: Partial<Pick<AuditEvent, 'execution_succeeded' | 'execution_error' | 'duration_ms' | 'decision'>>
  ): void {
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
  }

  listEvents(opts: { limit?: number; offset?: number; status?: string; tool?: string } = {}): AuditEvent[] {
    const { limit = 50, offset = 0, status, tool } = opts;
    let query = 'SELECT * FROM audit_events';
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (status) { conditions.push('status = ?'); params.push(status); }
    if (tool) { conditions.push('tool_call_json LIKE ?'); params.push(`%"tool":"${tool}"%`); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY sequence_number DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(this.rowToEvent);
  }

  getEvent(id: string): AuditEvent | null {
    const row = this.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToEvent(row) : null;
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

  private rowToEvent(row: Record<string, unknown>): AuditEvent {
    return {
      id: row.id as string,
      sequence_number: row.sequence_number as number,
      previous_event_hash: row.previous_event_hash as string | null,
      event_hash: row.event_hash as string,
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
