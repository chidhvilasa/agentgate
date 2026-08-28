// Downstream tool discovery/scan (Milestone 6, ADR-0012).
//
// Connects to a configured downstream stdio server, lists its tools
// (paginated — the SDK's Client.listTools() returns one page at a time,
// it does not auto-paginate), and canonicalizes the result. This is the
// ONLY module in Tool Integrity that ever spawns/connects to a downstream
// server — registry.ts, canonicalize.ts, identity.ts, and diff.ts never
// do, by construction (see the structural no-execution test).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sanitizeErrorMessage } from '@chidhvilasa/policy';
import { canonicalizeManifest, type ManifestCanonicalizeResult } from './canonicalize.js';
import type { DownstreamServer } from '../config/registry.js';

/** Hard cap on pagination — a malicious/misbehaving server claiming endless pages fails closed rather than looping forever. */
const MAX_PAGES = 200;

export interface ScanResult {
  manifest: ManifestCanonicalizeResult;
  /** The exact raw tool objects as returned by the server (unredacted) — this, not the canonicalized/redacted manifest, is what the gateway actually exposes to the upstream MCP client via tools/list, so a tool's real description/schema is never altered for legitimate use. Only present when the scan itself succeeded at the transport level (even if canonicalization subsequently failed for one or more tools). */
  rawTools: unknown[];
  /** Number of tools/list pages fetched. */
  pageCount: number;
}

/**
 * Connects to `server`, lists every tool across all pages, and
 * canonicalizes the resulting manifest. Never calls any tool — only
 * `initialize` and `tools/list` are ever sent. Fails closed (returns a
 * `manifest.ok === false` result, never throws past this function under
 * normal operation) for a connection failure, malformed response, or
 * pagination that exceeds MAX_PAGES.
 */
export async function scanDownstreamServer(server: DownstreamServer): Promise<ScanResult> {
  if (server.transport !== 'stdio') {
    return { manifest: { ok: false, error: 'Tool Integrity scanning currently supports stdio downstream servers only.' }, rawTools: [], pageCount: 0 };
  }

  const client = new Client({ name: 'agentgate-tool-integrity-scan', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...process.env, ...server.env } as Record<string, string>,
  });

  try {
    await client.connect(transport);

    const allTools: unknown[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      pageCount++;
      if (pageCount > MAX_PAGES) {
        return { manifest: { ok: false, error: `Tool discovery exceeded the maximum allowed page count (${MAX_PAGES}) — refusing to continue paginating.` }, rawTools: [], pageCount };
      }
      const page = await client.listTools(cursor ? { cursor } : undefined);
      if (!Array.isArray(page.tools)) {
        return { manifest: { ok: false, error: 'Downstream server returned a malformed tools/list response (tools is not an array).' }, rawTools: [], pageCount };
      }
      allTools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    return { manifest: canonicalizeManifest(allTools), rawTools: allTools, pageCount };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err, { source: 'downstream' });
    return { manifest: { ok: false, error: `Could not discover downstream tools: ${sanitized.message}` }, rawTools: [], pageCount: 0 };
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
