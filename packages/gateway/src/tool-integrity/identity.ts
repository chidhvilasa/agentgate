// Stable local server identity (Milestone 6, ADR-0012).
//
// `serverInfo.name` (the name a downstream MCP server self-reports during
// initialize) is untrusted, server-controlled input, and the MCP spec does
// not guarantee it is globally unique — it must never be the sole identity
// a trust decision is keyed on. Local server identity here is instead
// derived entirely from LOCAL configuration facts the operator controls:
// the server's configured `id` (from agentgate.yml) plus a versioned,
// redacted fingerprint of its security-relevant launch configuration
// (command, args, env var names+values — hashed, never stored raw).
import crypto from 'node:crypto';
import type { DownstreamServer } from '../config/registry.js';

export const SERVER_IDENTITY_VERSION = 'server-identity-v1';

export interface ServerIdentity {
  /** The operator-chosen server id from config (e.g. "downstream"). Not secret, safe to display. */
  serverId: string;
  /** Full stable identity: `${serverId}:${launchFingerprint short hex}`. Safe to display and use as a storage key. */
  identity: string;
  /** The full launch-configuration fingerprint (redacted — see buildLaunchFingerprint). */
  launchFingerprint: string;
}

function normalizePathLike(value: string): string {
  // Harmless-difference normalization only: unify path separators. This
  // does NOT resolve symlinks, relative segments, or realpath — a
  // deliberately narrow, documented normalization, not full path
  // canonicalization (see ADR-0012 "Limitations").
  return value.split('\\').join('/');
}

/**
 * Redacted, deterministic fingerprint of a downstream server's security-
 * relevant launch configuration. Raw environment variable VALUES are never
 * stored or returned — each `KEY=VALUE` pair is hashed individually before
 * being folded into the overall digest, so the fingerprint still changes
 * whenever any env value changes (detecting the security-relevant change)
 * without ever persisting or exposing the secret itself. SHA-256 is a
 * one-way function — hashing a raw value here is safe even though the
 * *plaintext* value is never written to disk or returned by any API.
 */
export function buildLaunchFingerprint(server: DownstreamServer): string {
  const envEntries = server.transport === 'stdio' && server.env ? Object.entries(server.env) : [];
  const envHashes = envEntries
    .map(([k, v]) => `${k}=${crypto.createHash('sha256').update(`${k}=${v}`, 'utf8').digest('hex')}`)
    .sort(); // sort by the resulting "KEY=hash" string — deterministic regardless of object insertion order

  const material =
    server.transport === 'stdio'
      ? {
          version: SERVER_IDENTITY_VERSION,
          transport: 'stdio' as const,
          command: normalizePathLike(server.command),
          args: server.args.map(normalizePathLike),
          envKeyHashes: envHashes,
        }
      : {
          version: SERVER_IDENTITY_VERSION,
          transport: 'http' as const,
          url: server.url,
        };

  const canonical = JSON.stringify(material, Object.keys(material).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Computes the full local identity for a configured downstream server. */
export function computeServerIdentity(server: DownstreamServer): ServerIdentity {
  const launchFingerprint = buildLaunchFingerprint(server);
  return {
    serverId: server.id,
    identity: `${server.id}:${launchFingerprint.slice(0, 16)}`,
    launchFingerprint,
  };
}
