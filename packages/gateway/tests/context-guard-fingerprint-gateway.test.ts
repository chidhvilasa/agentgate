// Real gateway-path regression test for Context Guard's tool_fingerprint
// approval binding (Milestone 7, ADR-0013 amendment). Spawns the REAL
// compiled gateway binary, connects a REAL MCP client, trusts a tool
// out-of-process (mirroring tool-integrity-gateway-enforcement.test.ts's
// established pattern), then simulates the tool's trusted definition
// drifting WHILE a contextual approval is pending — proving:
//   1. approval creation binds the exact real trusted fingerprint;
//   2. drift/quarantine between creation and consumption is caught at
//      REVALIDATION time, even though a human already clicked "approve";
//   3. the downstream fixture's call counter proves zero execution on the
//      stale-fingerprint path;
//   4. a fresh evaluation after re-trust requires — and gets — a brand
//      new approval, never a reuse of the cancelled one.
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolsTrust, runToolsStatus } from '../src/tool-integrity/cli.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import type { Approval } from '@chidhvilasa/protocol';

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

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

type ToolCallResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('Context Guard tool_fingerprint binding — real gateway-path proof (ADR-0013)', () => {
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
    'a contextual approval bound to a trusted fingerprint is rejected on consumption after the tool drifts/is quarantined mid-flight, with zero downstream contact — and a fresh approval is required after re-trust',
    async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-cg-fp-gw-'));
      const policyPath = path.join(tmpDir, 'policy.yml');
      const configPath = path.join(tmpDir, 'agentgate.yml');
      const dbPath = path.join(tmpDir, 'db.sqlite');
      const counterFile = path.join(tmpDir, 'counter.txt');

      // echo requires approval unconditionally — isolates the fingerprint-
      // binding behavior from any contextual-rule escalation logic (already
      // covered by context-guard-gateway-enforcement.test.ts).
      fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: deny\nrules:\n  - id: approve-echo\n    tools: ["echo"]\n    decision: require_approval\n    approval_ttl_seconds: 20\n');
      fs.writeFileSync(
        configPath,
        `version: 1\n` +
          `gateway_port: 4700\n` +
          `control_port: 4714\n` +
          `policy: ${toYamlPath(policyPath)}\n` +
          `db_path: ${toYamlPath(dbPath)}\n` +
          `tool_integrity:\n  mode: explicit\n` +
          `context_guard:\n  mode: enforce\n` +
          `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["${toYamlPath(FIXTURE_SERVER)}"]\n` +
          `    env:\n      FIXTURE_CALL_COUNT_FILE: "${toYamlPath(counterFile)}"\n`
      );

      client = new Client({ name: 'fingerprint-binding-e2e-agent', version: '1.0.0' }, { capabilities: {} });
      transport = new StdioClientTransport({
        command: 'node',
        args: [CLI_BIN, 'start', configPath],
        env: process.env as Record<string, string>,
        cwd: tmpDir,
      });
      await client.connect(transport);

      // ── 1. Trust "echo" out-of-process, exactly mirroring the Tool
      //      Integrity gateway-path test — establishes a REAL trusted
      //      fingerprint the running gateway will read on the next call. ──
      const statusReport = runToolsStatus(configPath);
      const echoState = statusReport.tools.find((t) => t.tool_name === 'echo')!;
      expect(echoState.status).toBe('pending_review');
      const trustResult = runToolsTrust(configPath, echoState.candidate_id!, echoState.candidate_fingerprint!);
      expect(trustResult.ok).toBe(true);
      const trustedFingerprintV1 = echoState.candidate_fingerprint!;

      // ── 2. Create a contextual pending approval — call echo directly;
      //      the base policy requires approval, so the pending approval
      //      must be bound to the exact fingerprint just trusted. ────────
      const call1Promise = client.callTool({ name: 'echo', arguments: { text: 'hello' } });

      const outOfProcStorage = new AuditStorage(dbPath);
      const outOfProcApprovals = new ApprovalManager(outOfProcStorage);

      async function waitForPendingApproval(): Promise<Approval> {
        return waitFor(() => outOfProcStorage.listPendingApprovals().find((a) => a.scope === 'echo'), 10000, 'pending echo approval');
      }

      try {
        const approval1 = await waitForPendingApproval();
        expect(approval1.tool_fingerprint).toBe(trustedFingerprintV1);

        const serverIdentity = outOfProcStorage.listToolIntegrityState()[0].server_identity;

        // ── 3. Quarantine/drift the tool's definition WHILE the approval
        //      is still pending — a real registry-state mutation on the
        //      SAME database file the live gateway is using, mirroring how
        //      a real rescan would observe a definition change. ──────────
        outOfProcStorage.upsertToolIntegrityState({
          server_identity: serverIdentity,
          server_id: 'fixture',
          tool_name: 'echo',
          status: 'drifted',
          current_fingerprint: 'fp-drifted-mid-flight',
          trusted_fingerprint: trustedFingerprintV1, // trusted_fingerprint unchanged — but status/current diverge, so getTrustedFingerprint() now returns null.
          candidate_fingerprint: 'fp-drifted-mid-flight',
          candidate_id: 'drift-candidate-1',
          trusted_definition_json: '{}',
          candidate_definition_json: '{}',
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          last_scan_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        // ── 4. A human approves anyway (unaware of the drift) — revalidation
        //      at consumption time must still refuse. ─────────────────────
        const approveResult1 = outOfProcApprovals.approve(approval1.id);
        expect(approveResult1.ok).toBe(true);
        const call1Result = (await call1Promise) as ToolCallResult;
        expect(call1Result.isError).toBe(true);

        // ── 5. Zero downstream contact — the fixture's own call counter,
        //      external to AgentGate's own process, proves it. ───────────
        expect(readCounter(counterFile)).toBe(0);

        // ── 6. A newly re-trusted definition requires a FRESH evaluation —
        //      a second call creates a NEW, distinct approval, never a
        //      reuse of the cancelled one. ─────────────────────────────
        outOfProcStorage.upsertToolIntegrityState({
          server_identity: serverIdentity,
          server_id: 'fixture',
          tool_name: 'echo',
          status: 'trusted',
          current_fingerprint: 'fp-drifted-mid-flight',
          trusted_fingerprint: 'fp-drifted-mid-flight', // newly trusted under the drifted fingerprint
          candidate_fingerprint: null,
          candidate_id: null,
          trusted_definition_json: '{}',
          candidate_definition_json: null,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          last_scan_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        const call2Promise = client.callTool({ name: 'echo', arguments: { text: 'hello again' } });
        const approval2 = await waitForPendingApproval();
        expect(approval2.id).not.toBe(approval1.id);
        expect(approval2.tool_fingerprint).toBe('fp-drifted-mid-flight');

        const approveResult2 = outOfProcApprovals.approve(approval2.id);
        expect(approveResult2.ok).toBe(true);
        const call2Result = (await call2Promise) as ToolCallResult;
        expect(call2Result.isError).toBeFalsy();
        expect(call2Result.content[0].text).toBe('hello again');
        expect(readCounter(counterFile)).toBe(1); // exactly one real execution, on the re-trusted path only.
      } finally {
        outOfProcApprovals.destroy();
        outOfProcStorage.close();
      }
    },
    30000
  );
});
