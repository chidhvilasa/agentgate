// End-to-end gateway-path enforcement proof (Milestone 6, ADR-0012).
//
// Every other Tool Integrity test exercises the internal functions
// (registry.ts, enforcement.ts, scan.ts) directly. This file is the one
// place that proves the actual, wired-up MCP request handlers in
// transport/stdio.ts enforce quarantine — by spawning the REAL compiled
// gateway binary and talking to it with a REAL MCP client, exactly as a
// real MCP-speaking agent (e.g. Claude Code) would. This is the specific
// executable evidence for the milestone's non-negotiable invariants:
//   - a quarantined tool is not exposed via tools/list;
//   - a direct tools/call by a name the client already knows (as if
//     cached from an earlier session or from documentation) is blocked
//     BEFORE the downstream server is ever contacted;
//   - the block happens even though nothing about the client's own
//     request looks any different from a legitimate call — enforcement is
//     server-side and cannot be bypassed by the client "not asking" first;
//   - once a human explicitly trusts the exact candidate (via the CLI,
//     out of process, against the same database — mirroring the Control
//     API/UI doing the same), the SAME already-connected client can now
//     call the tool successfully, without a gateway restart, because
//     checkCallAllowed() re-reads registry state fresh on every call.
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolsTrust } from '../src/tool-integrity/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../');
const CLI_BIN = path.join(ROOT, 'packages/gateway/dist/cli.js');
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/fixture-downstream-server.mjs');

function toYamlPath(p: string): string {
  return p.split(path.sep).join('/');
}

function readCounter(counterFile: string): number {
  try {
    return parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

describe('Tool Integrity — real gateway-path enforcement (ADR-0012)', () => {
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (client) await client.close().catch(() => {});
    if (transport) await transport.close().catch(() => {});
    client = undefined;
    transport = undefined;
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  });

  it(
    'explicit mode: quarantines on startup (empty tools/list), blocks a direct cached-name call before the downstream server is contacted, then allows the same connection after an out-of-process exact-fingerprint trust',
    async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-ti-gw-enforcement-'));
      const policyPath = path.join(tmpDir, 'policy.yml');
      const configPath = path.join(tmpDir, 'agentgate.yml');
      const dbPath = path.join(tmpDir, 'db.sqlite');
      const counterFile = path.join(tmpDir, 'counter.txt');

      // Deny-all policy — irrelevant to this test, since a blocked Tool
      // Integrity call must never even reach policy evaluation. If the
      // block relied on the policy engine instead of the dedicated
      // enforcement gate, this deny-all policy would produce the same
      // externally-visible "blocked" result, so the counter-file proof
      // below is what actually distinguishes "blocked by Tool Integrity
      // before dispatch" from "blocked by policy after dispatch would
      // still have started" — a policy DENY never calls
      // executeDownstream() either, so the counter would stay 0 in both
      // cases; what only Tool Integrity enforcement additionally
      // guarantees is that this happens even in "monitor"/no-policy-rule
      // configurations, and specifically that the SAME already-established
      // client connection later succeeds once trust is granted, without
      // any policy change.
      fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: allow\nrules: []\n');
      fs.writeFileSync(
        configPath,
        `version: 1\n` +
          `gateway_port: 4700\n` +
          `control_port: 4701\n` +
          `policy: ${toYamlPath(policyPath)}\n` +
          `db_path: ${toYamlPath(dbPath)}\n` +
          `tool_integrity:\n  mode: explicit\n` +
          `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["${toYamlPath(FIXTURE_SERVER)}"]\n` +
          `    env:\n      FIXTURE_CALL_COUNT_FILE: "${toYamlPath(counterFile)}"\n`
      );

      client = new Client({ name: 'agent-with-cached-tool-name', version: '1.0.0' }, { capabilities: {} });
      transport = new StdioClientTransport({
        command: 'node',
        args: [CLI_BIN, 'start', configPath],
        env: process.env as Record<string, string>,
        cwd: tmpDir,
      });
      await client.connect(transport);

      // ── 1. Discovery-side quarantine: nothing is trusted yet, so
      //      tools/list must be empty, even though the downstream server
      //      really does advertise 4 tools. ──────────────────────────────
      const listed = await client.listTools();
      expect(listed.tools).toEqual([]);

      // ── 2. Direct call-dispatch-side quarantine: the client "already
      //      knows" the tool name echo exists (e.g. from prior docs or a
      //      previous session) and calls it directly without ever having
      //      seen it in THIS session's tools/list response. ─────────────
      const blockedResult = (await client.callTool({ name: 'echo', arguments: { text: 'hello' } })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(blockedResult.isError).toBe(true);
      expect(blockedResult.content[0].text).toContain('[AgentGate] Tool Integrity:');
      expect(blockedResult.content[0].text).toMatch(/not been scanned|pending|quarantined|unreviewed/i);

      // ── 3. The downstream server was NEVER contacted for the blocked
      //      call — proven by an external, process-independent artifact
      //      (a plain counter file the fixture server itself increments on
      //      every real tool invocation), not merely an in-process spy. ──
      expect(readCounter(counterFile)).toBe(0);

      // ── 4. Out-of-process review: exactly mirrors what the CLI/Control
      //      API/UI would do — read the current candidate state from the
      //      SAME database file the running gateway is using (populated by
      //      the gateway's own startup scan), and accept its EXACT
      //      fingerprint. This does not touch the live gateway process at
      //      all — no restart, no reconnect. ──────────────────────────────
      const { runToolsStatus } = await import('../src/tool-integrity/cli.js');
      const statusReport = runToolsStatus(configPath);
      const echoState = statusReport.tools.find((t) => t.tool_name === 'echo');
      expect(echoState).toBeDefined();
      expect(echoState!.status).toBe('pending_review');
      expect(echoState!.candidate_id).toBeTruthy();
      expect(echoState!.candidate_fingerprint).toBeTruthy();

      const trustResult = runToolsTrust(configPath, echoState!.candidate_id!, echoState!.candidate_fingerprint!);
      expect(trustResult.ok).toBe(true);

      // ── 5. The SAME already-open client connection (no reconnect) can
      //      now call the same tool successfully — proving enforcement
      //      re-checks registry state fresh on every call rather than
      //      caching a startup-time decision, and proving the earlier
      //      block was a real quarantine gate, not an unrelated failure. ─
      const allowedResult = (await client.callTool({ name: 'echo', arguments: { text: 'hello' } })) as {
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      expect(allowedResult.isError).toBeFalsy();
      expect(allowedResult.content[0].text).toBe('hello');
      expect(readCounter(counterFile)).toBe(1);
    },
    30000
  );
});
