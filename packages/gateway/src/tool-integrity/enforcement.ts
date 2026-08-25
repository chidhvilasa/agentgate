// Fail-closed gateway enforcement (Milestone 6, ADR-0012).
//
// Enforced in two places, both required by the security invariants:
//   1. Discovery filtering (filterTrustedTools) — a quarantined/rejected/
//      drifted tool is never exposed to the upstream MCP client as an
//      available tool in the first place.
//   2. Call-dispatch gating (checkCallAllowed) — even if a client cached
//      an old tool list, or calls a tool name directly without ever
//      having seen it in a fresh tools/list response, the call is blocked
//      here, before the request ever reaches policy evaluation or
//      executeDownstream(). This module never imports executeDownstream,
//      runPipeline, or the MCP client transport — it only reads already-
//      stored registry state.
import type { AuditStorage } from '../storage.js';
import type { ToolIntegrityMode } from '../config/registry.js';
import { isFingerprintTrusted } from './registry.js';

export interface CallCheckResult {
  allowed: boolean;
  /** Safe, human-readable reason — never includes raw hostile tool-definition content. */
  reason?: string;
}

/** True only for modes that actually enforce (block); monitor/disabled report/skip but never block. */
export function modeEnforces(mode: ToolIntegrityMode): boolean {
  return mode === 'explicit' || mode === 'tofu';
}

/**
 * Filters a raw discovered tool list down to what is safe to expose
 * upstream. In an enforcing mode, only tools whose CURRENT state is
 * `trusted` (i.e. `isFingerprintTrusted` against the tool's own
 * `trusted_fingerprint`) are included — annotations on the raw tool
 * object are never consulted here, since ADR-0012/the MCP spec both say
 * they are untrusted hints, not something that can reduce enforced risk.
 * In `monitor`/`disabled` mode, every discovered tool is exposed
 * unchanged (matching pre-Milestone-6 behavior) — enforcement is opt-in.
 */
export function filterTrustedTools<T extends { name: string }>(
  storage: AuditStorage,
  serverIdentity: string,
  tools: T[],
  mode: ToolIntegrityMode
): T[] {
  if (!modeEnforces(mode)) return tools;
  return tools.filter((t) => {
    const state = storage.getToolIntegrityState(serverIdentity, t.name);
    return state !== null && state.status === 'trusted' && state.current_fingerprint === state.trusted_fingerprint;
  });
}

/**
 * Gate a direct `tools/call` dispatch, independent of whatever tool list
 * the calling client may have cached. Returns `allowed: false` for any
 * tool name that is not currently `trusted` in an enforcing mode — this
 * includes a tool AgentGate has never even seen (fails closed, not
 * "assume trusted because we have no record"), a quarantined
 * (`pending_review`)/`drifted`/`rejected`/`removed` tool, and a tool
 * whose registry lookup itself fails for any reason.
 */
export function checkCallAllowed(storage: AuditStorage, serverIdentity: string, toolName: string, mode: ToolIntegrityMode): CallCheckResult {
  if (!modeEnforces(mode)) return { allowed: true };

  let state;
  try {
    state = storage.getToolIntegrityState(serverIdentity, toolName);
  } catch {
    return { allowed: false, reason: 'Tool Integrity lookup failed — failing closed.' };
  }

  if (!state) {
    return { allowed: false, reason: `Tool "${toolName}" has not been scanned/reviewed by the Tool Integrity Registry. Run a scan and review it before it can be called.` };
  }
  if (state.status === 'trusted' && isFingerprintTrusted(state, state.trusted_fingerprint ?? '')) {
    return { allowed: true };
  }
  const reasonByStatus: Record<string, string> = {
    pending_review: `Tool "${toolName}" is a new, unreviewed definition — quarantined pending explicit review.`,
    drifted: `Tool "${toolName}"'s definition changed since it was last trusted — quarantined pending review.`,
    rejected: `Tool "${toolName}"'s definition was explicitly rejected and has not been re-reviewed.`,
    removed: `Tool "${toolName}" is no longer advertised by the downstream server.`,
  };
  return { allowed: false, reason: reasonByStatus[state.status] ?? `Tool "${toolName}" is not currently trusted.` };
}
