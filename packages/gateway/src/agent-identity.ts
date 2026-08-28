import { v4 as uuidv4 } from 'uuid';
import type { AgentIdentity } from '@chidhvilasa/protocol';

/**
 * Builds an AgentIdentity from MCP client info.
 *
 * SECURITY: self-reported client name/version MUST NOT be used
 * for authorization decisions. They are stored for display only.
 * verified_identity is always false — we have no cryptographic proof.
 */
export function buildAgentIdentity(opts: {
  declared_name: string | null;
  declared_version: string | null;
  /** Transport-derived identifier: PID for stdio, remote address for HTTP. */
  connection_identity: string;
}): AgentIdentity {
  return {
    session_id: uuidv4(),
    declared_name: opts.declared_name,
    declared_version: opts.declared_version,
    connection_identity: opts.connection_identity,
    verified_identity: false,
  };
}
