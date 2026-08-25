// CLI-facing operations for the Tool Integrity Registry (Milestone 6,
// ADR-0012). Each function here is a thin, testable wrapper that opens
// storage, does the work, and returns a plain data report — cli.ts owns
// all console formatting/exit-code decisions, matching the convention
// already used by onboarding/{doctor,configValidate,smokeTest}.ts.
//
// Security-relevant conventions enforced here:
//   - `scan` NEVER calls a tool — it only reaches scanDownstreamServer(),
//     the same discovery-only path the gateway itself uses at startup.
//   - `status`/`diff`/`history` are strictly read-only against already-
//     stored data — they never trigger a new scan or connect downstream.
//   - `trust`/`reject` require an EXACT candidate-id AND fingerprint match
//     (see registry.ts) — there is no name-only or "trust all" path here,
//     by design, matching the milestone's non-negotiable invariants.
import { AuditStorage } from '../storage.js';
import { loadGatewayConfig } from '../config/registry.js';
import type { ToolIntegrityMode } from '../config/registry.js';
import { computeServerIdentity } from './identity.js';
import { scanDownstreamServer } from './scan.js';
import { applyScanToRegistry, acceptCandidate, rejectCandidate } from './registry.js';
import { diffStoredDefinitions } from './diff.js';
import type { ToolIntegrityState, ToolIntegrityEvent } from './types.js';

function openStorageForConfig(configPath: string): { storage: AuditStorage; serverIdentity: string; serverId: string; mode: ToolIntegrityMode } {
  const config = loadGatewayConfig(configPath);
  const server = config.servers[0];
  if (!server) {
    throw new Error('Config has no downstream servers configured.');
  }
  const identity = computeServerIdentity(server);
  const storage = new AuditStorage(config.db_path);
  return { storage, serverIdentity: identity.identity, serverId: identity.serverId, mode: config.tool_integrity.mode };
}

export interface ToolsScanReport {
  ok: boolean;
  serverIdentity: string;
  mode: string;
  manifestOk: boolean;
  error?: string;
  toolCount: number;
  outcomes: Array<{ toolName: string; status: string; changed: boolean }>;
  removedToolNames: string[];
}

/** Runs an on-demand rescan without restarting the gateway. Never calls a tool — only `initialize`+`tools/list`, exactly like the gateway's own startup scan. */
export async function runToolsScan(configPath: string): Promise<ToolsScanReport> {
  const { storage, serverIdentity, serverId, mode } = openStorageForConfig(configPath);
  try {
    const config = loadGatewayConfig(configPath);
    const server = config.servers[0];
    const scanResult = await scanDownstreamServer(server);
    const applyResult = applyScanToRegistry(storage, serverIdentity, serverId, scanResult.manifest, mode);
    return {
      ok: applyResult.ok,
      serverIdentity,
      mode,
      manifestOk: scanResult.manifest.ok,
      error: applyResult.error ?? scanResult.manifest.error,
      toolCount: scanResult.manifest.tools?.length ?? 0,
      outcomes: applyResult.toolOutcomes,
      removedToolNames: applyResult.removedToolNames,
    };
  } finally {
    storage.close();
  }
}

export interface ToolsStatusReport {
  serverIdentity: string;
  mode: string;
  tools: ToolIntegrityState[];
}

export function runToolsStatus(configPath: string): ToolsStatusReport {
  const { storage, serverIdentity, mode } = openStorageForConfig(configPath);
  try {
    return { serverIdentity, mode, tools: storage.listToolIntegrityState(serverIdentity) };
  } finally {
    storage.close();
  }
}

export interface ToolsDiffReport {
  ok: boolean;
  error?: string;
  toolName?: string;
  status?: string;
  trustedFingerprint?: string | null;
  candidateFingerprint?: string | null;
  candidateId?: string | null;
  changes?: ReturnType<typeof diffStoredDefinitions>['changes'];
  truncated?: boolean;
}

/** Read-only: finds the state row whose candidate_id matches, and diffs its trusted vs candidate definition. Never triggers a scan. */
export function runToolsDiff(configPath: string, candidateId: string): ToolsDiffReport {
  const { storage, serverIdentity } = openStorageForConfig(configPath);
  try {
    const all = storage.listToolIntegrityState(serverIdentity);
    const match = all.find((s) => s.candidate_id === candidateId);
    if (!match) {
      return { ok: false, error: `No pending candidate with id "${candidateId}" found.` };
    }
    const candidate = match.candidate_definition_json;
    if (!candidate) {
      return { ok: false, error: `Candidate "${candidateId}" has no stored candidate definition.` };
    }
    // No prior trusted baseline (first-ever observation, pending initial
    // review) diffs against an empty object — every field of the candidate
    // shows as "added", which is the correct, honest representation of
    // "nothing was trusted before this".
    const baseline = match.trusted_definition_json ?? '{}';
    const diff = diffStoredDefinitions(baseline, candidate);
    return {
      ok: diff.ok,
      error: diff.error,
      toolName: match.tool_name,
      status: match.status,
      trustedFingerprint: match.trusted_fingerprint,
      candidateFingerprint: match.candidate_fingerprint,
      candidateId: match.candidate_id,
      changes: diff.changes,
      truncated: diff.truncated,
    };
  } finally {
    storage.close();
  }
}

export interface ToolsReviewReport {
  ok: boolean;
  error?: string;
}

/** Requires an EXACT match of candidate-id AND fingerprint — see registry.ts acceptCandidate() for the stale-approval-race protection this depends on. No name-only shortcut exists by design. */
export function runToolsTrust(configPath: string, candidateId: string, fingerprint: string): ToolsReviewReport {
  const { storage, serverIdentity } = openStorageForConfig(configPath);
  try {
    const match = storage.listToolIntegrityState(serverIdentity).find((s) => s.candidate_id === candidateId);
    if (!match) return { ok: false, error: `No pending candidate with id "${candidateId}" found.` };
    return acceptCandidate(storage, serverIdentity, match.tool_name, candidateId, fingerprint, 'cli');
  } finally {
    storage.close();
  }
}

export function runToolsReject(configPath: string, candidateId: string, fingerprint: string, reason?: string): ToolsReviewReport {
  const { storage, serverIdentity } = openStorageForConfig(configPath);
  try {
    const match = storage.listToolIntegrityState(serverIdentity).find((s) => s.candidate_id === candidateId);
    if (!match) return { ok: false, error: `No pending candidate with id "${candidateId}" found.` };
    return rejectCandidate(storage, serverIdentity, match.tool_name, candidateId, fingerprint, 'cli', reason ?? 'Rejected via CLI.');
  } finally {
    storage.close();
  }
}

export interface ToolsHistoryReport {
  serverIdentity: string;
  events: ToolIntegrityEvent[];
  chainValid: boolean;
  chainError?: string;
}

export function runToolsHistory(configPath: string, toolName?: string): ToolsHistoryReport {
  const { storage, serverIdentity } = openStorageForConfig(configPath);
  try {
    const events = storage.listToolIntegrityEvents({ serverIdentity, toolName });
    const chain = storage.verifyToolIntegrityChain();
    return { serverIdentity, events, chainValid: chain.valid, chainError: chain.error };
  } finally {
    storage.close();
  }
}
