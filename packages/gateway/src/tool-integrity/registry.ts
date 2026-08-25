// Tool Integrity state-machine orchestration (Milestone 6, ADR-0012).
//
// Pure decision logic over already-canonicalized scan results plus the
// storage layer's current projected state — mirrors how replay.ts's
// decision logic is separate from storage.ts's persistence. This module
// never connects to a downstream server itself (see scan.ts for that).
import crypto from 'node:crypto';
import type { AuditStorage } from '../storage.js';
import type { ToolIntegrityState, ToolIntegrityStatus } from './types.js';
import type { ManifestCanonicalizeResult } from './canonicalize.js';
import type { ToolIntegrityMode } from '../config/registry.js';

/** Deterministic candidate id: the same (server, tool, fingerprint) triple always yields the same id, so re-observing an unchanged candidate never creates a new id, and accept/reject can be verified against it exactly. */
export function computeCandidateId(serverIdentity: string, toolName: string, fingerprint: string): string {
  return crypto.createHash('sha256').update(`${serverIdentity}:${toolName}:${fingerprint}`, 'utf8').digest('hex').slice(0, 16);
}

export interface ApplyScanResult {
  ok: boolean;
  error?: string;
  /** Per-tool outcome, for CLI/API "scan just finished" summaries. */
  toolOutcomes: Array<{ toolName: string; status: ToolIntegrityStatus; changed: boolean }>;
  removedToolNames: string[];
}

/**
 * Applies one completed, successful manifest scan to the registry: for
 * every tool observed, determines and persists the correct state
 * transition and append-only event(s); for every previously-known tool NOT
 * present in this scan, marks it removed. Idempotent for an unchanged
 * scan (rescanning identical definitions produces `tool_observed` events
 * but no state churn).
 */
export function applyScanToRegistry(
  storage: AuditStorage,
  serverIdentity: string,
  serverId: string,
  manifest: ManifestCanonicalizeResult,
  mode: ToolIntegrityMode
): ApplyScanResult {
  if (!manifest.ok || !manifest.tools) {
    storage.insertToolIntegrityEvent({
      created_at: new Date().toISOString(),
      event_type: 'scan_failed',
      server_identity: serverIdentity,
      server_id: serverId,
      tool_name: null,
      fingerprint: null,
      previous_fingerprint: null,
      manifest_fingerprint: null,
      state_before: null,
      state_after: null,
      reviewer: null,
      reason: manifest.error ?? 'Unknown scan failure.',
      definition_json: null,
    });
    return { ok: false, error: manifest.error, toolOutcomes: [], removedToolNames: [] };
  }

  const now = new Date().toISOString();
  storage.insertToolIntegrityEvent({
    created_at: now,
    event_type: 'manifest_scanned',
    server_identity: serverIdentity,
    server_id: serverId,
    tool_name: null,
    fingerprint: null,
    previous_fingerprint: null,
    manifest_fingerprint: manifest.manifestFingerprint ?? null,
    state_before: null,
    state_after: null,
    reviewer: null,
    reason: `Observed ${manifest.tools.length} tool(s).`,
    definition_json: null,
  });

  const toolOutcomes: ApplyScanResult['toolOutcomes'] = [];
  const observedNames = new Set<string>();

  for (const tool of manifest.tools) {
    observedNames.add(tool.name);
    const fingerprint = tool.fingerprint!;
    const safeDefinitionJson = JSON.stringify(tool.safeDefinition);
    const existing = storage.getToolIntegrityState(serverIdentity, tool.name);

    // Always record the raw observation, regardless of whether anything changed.
    storage.insertToolIntegrityEvent({
      created_at: now,
      event_type: 'tool_observed',
      server_identity: serverIdentity,
      server_id: serverId,
      tool_name: tool.name,
      fingerprint,
      previous_fingerprint: existing?.current_fingerprint ?? null,
      manifest_fingerprint: manifest.manifestFingerprint ?? null,
      state_before: existing?.status ?? null,
      state_after: existing?.status ?? null, // corrected below if a transition happens
      reviewer: null,
      reason: null,
      definition_json: safeDefinitionJson,
    });

    if (!existing) {
      // Never seen before.
      if (mode === 'tofu') {
        storage.insertToolIntegrityEvent({
          created_at: now,
          event_type: 'baseline_accepted',
          server_identity: serverIdentity,
          server_id: serverId,
          tool_name: tool.name,
          fingerprint,
          previous_fingerprint: null,
          manifest_fingerprint: manifest.manifestFingerprint ?? null,
          state_before: null,
          state_after: 'trusted',
          reviewer: 'tofu-auto',
          reason: 'Trust-on-first-use: automatically trusted on first observation.',
          definition_json: safeDefinitionJson,
        });
        storage.upsertToolIntegrityState({
          server_identity: serverIdentity,
          server_id: serverId,
          tool_name: tool.name,
          status: 'trusted',
          current_fingerprint: fingerprint,
          trusted_fingerprint: fingerprint,
          candidate_fingerprint: null,
          candidate_id: null,
          trusted_definition_json: safeDefinitionJson,
          candidate_definition_json: null,
          first_seen_at: now,
          last_seen_at: now,
          last_scan_at: now,
          updated_at: now,
        });
        toolOutcomes.push({ toolName: tool.name, status: 'trusted', changed: true });
      } else {
        const candidateId = computeCandidateId(serverIdentity, tool.name, fingerprint);
        storage.upsertToolIntegrityState({
          server_identity: serverIdentity,
          server_id: serverId,
          tool_name: tool.name,
          status: 'pending_review',
          current_fingerprint: fingerprint,
          trusted_fingerprint: null,
          candidate_fingerprint: fingerprint,
          candidate_id: candidateId,
          trusted_definition_json: null,
          candidate_definition_json: safeDefinitionJson,
          first_seen_at: now,
          last_seen_at: now,
          last_scan_at: now,
          updated_at: now,
        });
        toolOutcomes.push({ toolName: tool.name, status: 'pending_review', changed: true });
      }
      continue;
    }

    // Already known. Three cases: unchanged, drifted (had a trusted
    // baseline that no longer matches), or reappeared (was removed).
    if (existing.status === 'removed') {
      const candidateId = computeCandidateId(serverIdentity, tool.name, fingerprint);
      storage.insertToolIntegrityEvent({
        created_at: now,
        event_type: 'reappeared',
        server_identity: serverIdentity,
        server_id: serverId,
        tool_name: tool.name,
        fingerprint,
        previous_fingerprint: existing.trusted_fingerprint,
        manifest_fingerprint: manifest.manifestFingerprint ?? null,
        state_before: 'removed',
        state_after: 'pending_review',
        reviewer: null,
        reason: 'Tool reappeared after being removed — requires review even if the fingerprint matches a prior trusted baseline (deliberately conservative; see ADR-0012).',
        definition_json: safeDefinitionJson,
      });
      storage.upsertToolIntegrityState({
        ...existing,
        status: 'pending_review',
        current_fingerprint: fingerprint,
        candidate_fingerprint: fingerprint,
        candidate_id: candidateId,
        candidate_definition_json: safeDefinitionJson,
        last_seen_at: now,
        last_scan_at: now,
        updated_at: now,
      });
      toolOutcomes.push({ toolName: tool.name, status: 'pending_review', changed: true });
      continue;
    }

    // A REJECTED tool is compared against the fingerprint that was
    // actually rejected (candidate_fingerprint), NOT trusted_fingerprint —
    // a tool can easily have both a real prior trusted baseline (e.g. v1,
    // trusted) AND a later rejected candidate (e.g. v2, rejected); if this
    // compared against trusted_fingerprint instead, re-scanning the SAME
    // already-rejected v2 definition unchanged would incorrectly look like
    // fresh drift every single time (v2 != v1 is always true), silently
    // re-opening a review cycle for a definition a human already looked at
    // and rejected. Comparing against candidate_fingerprint instead means
    // "unchanged since rejection" correctly stays rejected, and only a
    // GENUINELY new fingerprint (neither the trusted baseline nor the
    // rejected one) opens a fresh review cycle. This case is handled
    // separately from the generic branch below specifically because of
    // this distinction.
    if (existing.status === 'rejected') {
      if (existing.candidate_fingerprint === fingerprint) {
        storage.upsertToolIntegrityState({
          ...existing,
          current_fingerprint: fingerprint,
          last_seen_at: now,
          last_scan_at: now,
          updated_at: now,
        });
        toolOutcomes.push({ toolName: tool.name, status: 'rejected', changed: false });
        continue;
      }
      const candidateId = computeCandidateId(serverIdentity, tool.name, fingerprint);
      storage.insertToolIntegrityEvent({
        created_at: now,
        event_type: 'drift_detected',
        server_identity: serverIdentity,
        server_id: serverId,
        tool_name: tool.name,
        fingerprint,
        previous_fingerprint: existing.candidate_fingerprint,
        manifest_fingerprint: manifest.manifestFingerprint ?? null,
        state_before: 'rejected',
        state_after: 'drifted',
        reviewer: null,
        reason: 'Tool definition changed to a new fingerprint after a prior rejection — opening a fresh review cycle.',
        definition_json: safeDefinitionJson,
      });
      storage.upsertToolIntegrityState({
        ...existing,
        status: 'drifted',
        current_fingerprint: fingerprint,
        candidate_fingerprint: fingerprint,
        candidate_id: candidateId,
        candidate_definition_json: safeDefinitionJson,
        last_seen_at: now,
        last_scan_at: now,
        updated_at: now,
      });
      toolOutcomes.push({ toolName: tool.name, status: 'drifted', changed: true });
      continue;
    }

    const referenceFingerprint = existing.trusted_fingerprint ?? existing.candidate_fingerprint;
    if (referenceFingerprint === fingerprint) {
      // Unchanged since last known fingerprint — keep current status,
      // just refresh timestamps.
      storage.upsertToolIntegrityState({
        ...existing,
        current_fingerprint: fingerprint,
        last_seen_at: now,
        last_scan_at: now,
        updated_at: now,
      });
      toolOutcomes.push({ toolName: tool.name, status: existing.status, changed: false });
      continue;
    }

    // Fingerprint differs from the current trusted baseline (or, if never
    // trusted, the previously-seen pending/drifted candidate) — this is
    // drift.
    const candidateId = computeCandidateId(serverIdentity, tool.name, fingerprint);
    const nextStatus: ToolIntegrityStatus = 'drifted';
    storage.insertToolIntegrityEvent({
      created_at: now,
      event_type: 'drift_detected',
      server_identity: serverIdentity,
      server_id: serverId,
      tool_name: tool.name,
      fingerprint,
      previous_fingerprint: referenceFingerprint,
      manifest_fingerprint: manifest.manifestFingerprint ?? null,
      state_before: existing.status,
      state_after: nextStatus,
      reviewer: null,
      reason: null,
      definition_json: safeDefinitionJson,
    });
    storage.upsertToolIntegrityState({
      ...existing,
      status: nextStatus,
      current_fingerprint: fingerprint,
      candidate_fingerprint: fingerprint,
      candidate_id: candidateId,
      candidate_definition_json: safeDefinitionJson,
      last_seen_at: now,
      last_scan_at: now,
      updated_at: now,
    });
    toolOutcomes.push({ toolName: tool.name, status: nextStatus, changed: true });
  }

  // Anything previously known for this server but absent from this scan is removed.
  const removedToolNames: string[] = [];
  for (const existing of storage.listToolIntegrityState(serverIdentity)) {
    if (observedNames.has(existing.tool_name) || existing.status === 'removed') continue;
    storage.insertToolIntegrityEvent({
      created_at: now,
      event_type: 'removed',
      server_identity: serverIdentity,
      server_id: serverId,
      tool_name: existing.tool_name,
      fingerprint: null,
      previous_fingerprint: existing.trusted_fingerprint ?? existing.candidate_fingerprint,
      manifest_fingerprint: manifest.manifestFingerprint ?? null,
      state_before: existing.status,
      state_after: 'removed',
      reviewer: null,
      reason: 'Tool no longer present in the server\'s advertised manifest.',
      definition_json: null,
    });
    storage.upsertToolIntegrityState({
      ...existing,
      status: 'removed',
      current_fingerprint: null,
      last_scan_at: now,
      updated_at: now,
    });
    removedToolNames.push(existing.tool_name);
  }

  return { ok: true, toolOutcomes, removedToolNames };
}

export interface ReviewResult {
  ok: boolean;
  error?: string;
}

/**
 * Accepts a candidate — requires an EXACT match on both candidate_id and
 * fingerprint against the tool's current stored candidate. A stale
 * candidate_id/fingerprint (superseded by a later scan) is rejected, not
 * silently accepted against whatever the current candidate happens to be
 * — this is what prevents approving fingerprint A from ever silently
 * approving a later fingerprint B.
 */
export function acceptCandidate(
  storage: AuditStorage,
  serverIdentity: string,
  toolName: string,
  candidateId: string,
  fingerprint: string,
  reviewer: string
): ReviewResult {
  const existing = storage.getToolIntegrityState(serverIdentity, toolName);
  if (!existing) return { ok: false, error: 'No such server/tool.' };
  if (existing.candidate_id !== candidateId || existing.candidate_fingerprint !== fingerprint) {
    return { ok: false, error: 'Stale or unknown candidate — it no longer matches the current pending candidate for this tool. Re-run a scan/status check and review the current candidate.' };
  }
  const now = new Date().toISOString();
  storage.insertToolIntegrityEvent({
    created_at: now,
    event_type: 'accepted',
    server_identity: serverIdentity,
    server_id: existing.server_id,
    tool_name: toolName,
    fingerprint,
    previous_fingerprint: existing.trusted_fingerprint,
    manifest_fingerprint: null,
    state_before: existing.status,
    state_after: 'trusted',
    reviewer,
    reason: null,
    definition_json: existing.candidate_definition_json,
  });
  storage.upsertToolIntegrityState({
    ...existing,
    status: 'trusted',
    trusted_fingerprint: fingerprint,
    trusted_definition_json: existing.candidate_definition_json,
    candidate_fingerprint: null,
    candidate_id: null,
    candidate_definition_json: null,
    updated_at: now,
  });
  return { ok: true };
}

/** Rejects a candidate — same exact-match requirement as acceptCandidate(). Never trusts on the next reconnect unless a genuinely new fingerprint later appears. */
export function rejectCandidate(
  storage: AuditStorage,
  serverIdentity: string,
  toolName: string,
  candidateId: string,
  fingerprint: string,
  reviewer: string,
  reason: string | null
): ReviewResult {
  const existing = storage.getToolIntegrityState(serverIdentity, toolName);
  if (!existing) return { ok: false, error: 'No such server/tool.' };
  if (existing.candidate_id !== candidateId || existing.candidate_fingerprint !== fingerprint) {
    return { ok: false, error: 'Stale or unknown candidate — it no longer matches the current pending candidate for this tool. Re-run a scan/status check and review the current candidate.' };
  }
  const now = new Date().toISOString();
  storage.insertToolIntegrityEvent({
    created_at: now,
    event_type: 'rejected',
    server_identity: serverIdentity,
    server_id: existing.server_id,
    tool_name: toolName,
    fingerprint,
    previous_fingerprint: existing.trusted_fingerprint,
    manifest_fingerprint: null,
    state_before: existing.status,
    state_after: 'rejected',
    reviewer,
    reason,
    definition_json: existing.candidate_definition_json,
  });
  storage.upsertToolIntegrityState({
    ...existing,
    status: 'rejected',
    // trusted_fingerprint is deliberately left untouched — rejecting a
    // candidate never rewrites or deletes a previous trusted baseline.
    // candidate_fingerprint/candidate_id are kept so history/diff can
    // still show what was rejected, but `status` is what enforcement
    // actually checks.
    updated_at: now,
  });
  return { ok: true };
}

/** True only if this exact fingerprint is currently the trusted one for this tool. Used by the gateway enforcement path — never trusts based on tool name alone. */
export function isFingerprintTrusted(state: ToolIntegrityState | null, fingerprint: string): boolean {
  if (!state) return false;
  return state.status === 'trusted' && state.trusted_fingerprint === fingerprint;
}
