// End-to-end gateway-path enforcement proof (Milestone 7, ADR-0013).
//
// Every other Context Guard test exercises the internal functions
// (state.ts, rules.ts, enforcement.ts, storage.ts) directly. This file is
// the one place that proves the actual, wired-up stdio request handler
// (transport/stdio.ts -> pipeline.ts) enforces cross-tool context
// escalation — by spawning the REAL compiled gateway binary and talking to
// it with a REAL MCP client, exactly as a real MCP-speaking agent would.
// Mirrors tool-integrity-gateway-enforcement.test.ts's structure and
// external-proof discipline (persistent, process-independent counter
// files — one per tool here, since this milestone's proof requires
// distinguishing which specific tool was or wasn't dispatched to).
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import type { Approval } from '@chidhvilasa/protocol';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../');
const CLI_BIN = path.join(ROOT, 'packages/gateway/dist/cli.js');
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/context-guard-fixture-server.mjs');

function toYamlPath(p: string): string {
  return p.split(path.sep).join('/');
}

function readCounter(counterDir: string, toolName: string): number {
  try {
    return parseInt(fs.readFileSync(path.join(counterDir, `${toolName}.count`), 'utf8'), 10) || 0;
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

describe('Context Guard — real gateway-path enforcement (ADR-0013)', () => {
  const openClients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  let tmpDir: string | undefined;

  afterEach(async () => {
    for (const { client, transport } of openClients) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    }
    openClients.length = 0;
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  });

  function writeConfig(opts: {
    configPath: string;
    policyPath: string;
    dbPath: string;
    counterDir: string;
    controlPort: number;
    ruleAction: 'deny' | 'require_approval';
    approvalTtlSeconds?: number;
  }): void {
    fs.writeFileSync(opts.policyPath, 'version: 1\ndefaults:\n  decision: allow\nrules: []\n');
    const ruleBlock =
      opts.ruleAction === 'deny'
        ? `  rules:\n    - id: deny-external-after-risk\n      when:\n        context_has_any: [untrusted_content, sensitive_data_accessed]\n        target_has_any: [external_communication]\n      action: deny\n      reason: "External communication blocked: untrusted/sensitive content was accessed earlier in this session."\n`
        : `  rules:\n    - id: approve-external-after-risk\n      when:\n        context_has_any: [untrusted_content, sensitive_data_accessed]\n        target_has_any: [external_communication]\n      action: require_approval\n      reason: "External communication requires approval: untrusted/sensitive content was accessed earlier in this session."\n      approval_ttl_seconds: ${opts.approvalTtlSeconds ?? 20}\n`;
    fs.writeFileSync(
      opts.configPath,
      `version: 1\n` +
        `gateway_port: 4700\n` +
        `control_port: ${opts.controlPort}\n` +
        `policy: ${toYamlPath(opts.policyPath)}\n` +
        `db_path: ${toYamlPath(opts.dbPath)}\n` +
        `tool_integrity:\n  mode: disabled\n` +
        `context_guard:\n  mode: enforce\n  tools:\n    fetch_ticket:\n      adds_on_result: [untrusted_content]\n    read_secret:\n      adds_on_result: [sensitive_data_accessed]\n    send_webhook:\n      effects: [external_communication]\n` +
        ruleBlock +
        `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["${toYamlPath(FIXTURE_SERVER)}"]\n` +
        `    env:\n      FIXTURE_COUNTER_DIR: "${toYamlPath(opts.counterDir)}"\n`
    );
  }

  async function connect(configPath: string, cwd: string): Promise<Client> {
    const client = new Client({ name: 'context-guard-e2e-agent', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_BIN, 'start', configPath],
      env: process.env as Record<string, string>,
      cwd,
    });
    await client.connect(transport);
    openClients.push({ client, transport });
    return client;
  }

  it(
    'zero-contact proof: cross-tool context escalation denies a direct/cached external-communication call, and a fresh independent context does not inherit labels',
    async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-cg-gw-enforcement-'));
      const dbPath = path.join(tmpDir, 'db.sqlite');
      const counterDir = path.join(tmpDir, 'counters');
      fs.mkdirSync(counterDir);
      const policyPath = path.join(tmpDir, 'policy.yml');
      const configPathA = path.join(tmpDir, 'agentgate-a.yml');
      writeConfig({ configPath: configPathA, policyPath, dbPath, counterDir, controlPort: 4711, ruleAction: 'deny' });

      // ── 1. Connect (gateway process #1) ─────────────────────────────────
      const clientA = await connect(configPathA, tmpDir);

      // ── 2. The new context is empty at its initial revision. Read via
      //      the authoritative storage boundary (a separate read-only-in-
      //      intent AuditStorage connection against the SAME db file the
      //      live gateway is using — WAL mode makes this safe) — there is
      //      no CLI/API surface for Context Guard yet in this milestone. ──
      const readStorage = new AuditStorage(dbPath);
      const initialContexts = readStorage.listContextStates();
      expect(initialContexts).toHaveLength(1);
      const contextIdA = initialContexts[0].context_id;
      expect(initialContexts[0].revision).toBe(0);
      expect(initialContexts[0].labels).toEqual([]);
      expect(initialContexts[0].status).toBe('active');

      // ── 3. Call fetch_ticket (untrusted_content source). ────────────────
      const ticketResult = (await clientA.callTool({ name: 'fetch_ticket', arguments: {} })) as ToolCallResult;
      expect(ticketResult.isError).toBeFalsy();
      expect(readCounter(counterDir, 'fetch_ticket')).toBe(1);
      const afterTicket = readStorage.getContextState(contextIdA)!;
      expect(afterTicket.labels).toEqual(['untrusted_content']);
      expect(afterTicket.revision).toBe(1);

      // ── 4. Call read_secret (sensitive_read effect / sensitive_data_accessed on result). ──
      const secretResult = (await clientA.callTool({ name: 'read_secret', arguments: {} })) as ToolCallResult;
      expect(secretResult.isError).toBeFalsy();
      expect(readCounter(counterDir, 'read_secret')).toBe(1);
      const afterSecret = readStorage.getContextState(contextIdA)!;
      expect(afterSecret.labels.slice().sort()).toEqual(['sensitive_data_accessed', 'untrusted_content']);
      expect(afterSecret.revision).toBe(2);

      // ── 5. Attempt send_webhook directly by name (no tools/list was ever
      //      called on this connection — proving enforcement does not
      //      depend on prior discovery). Contextual rule must deny. ───────
      const blocked1 = (await clientA.callTool({ name: 'send_webhook', arguments: { url: 'https://example.invalid/exfil' } })) as ToolCallResult;
      expect(blocked1.isError).toBe(true);
      expect(blocked1.content[0].text).toMatch(/external communication.*blocked|blocked.*external communication/i);
      expect(readCounter(counterDir, 'send_webhook')).toBe(0);

      // ── 6. Repeat the same direct/cached attempt — counter must remain
      //      exactly 0, and the rule must fire identically (not a one-time
      //      block that would silently pass through on retry). ───────────
      const blocked2 = (await clientA.callTool({ name: 'send_webhook', arguments: { url: 'https://example.invalid/exfil-2' } })) as ToolCallResult;
      expect(blocked2.isError).toBe(true);
      expect(readCounter(counterDir, 'send_webhook')).toBe(0);

      // Context labels/revision are unaffected by denied attempts (denied
      // calls never reach the label-append step — ADR-0013 point 8).
      const afterDenied = readStorage.getContextState(contextIdA)!;
      expect(afterDenied.revision).toBe(2);
      expect(afterDenied.labels.slice().sort()).toEqual(['sensitive_data_accessed', 'untrusted_content']);

      // ── 7. Close connection #1 — must finalize context #1 (transport
      //      close -> server.onclose -> closeOrExpireContext, wired this
      //      turn in transport/stdio.ts). ───────────────────────────────
      const entryA = openClients.pop()!;
      await entryA.client.close().catch(() => {});
      await entryA.transport.close().catch(() => {});
      const closedContext = await waitFor(
        () => {
          const s = readStorage.getContextState(contextIdA)!;
          return s.status !== 'active' ? s : undefined;
        },
        10000,
        'context #1 finalized after transport close'
      );
      expect(closedContext.status).toBe('closed');
      readStorage.close();

      // ── 8. A fresh, independent gateway process/connection over the SAME
      //      database must get its OWN new context — not inherit context
      //      #1's labels. ────────────────────────────────────────────────
      const configPathB = path.join(tmpDir, 'agentgate-b.yml');
      writeConfig({ configPath: configPathB, policyPath, dbPath, counterDir, controlPort: 4712, ruleAction: 'deny' });
      const clientB = await connect(configPathB, tmpDir);

      const readStorage2 = new AuditStorage(dbPath);
      const allContexts = readStorage2.listContextStates();
      expect(allContexts).toHaveLength(2);
      const contextB = allContexts.find((c) => c.context_id !== contextIdA)!;
      expect(contextB).toBeDefined();
      expect(contextB.revision).toBe(0);
      expect(contextB.labels).toEqual([]);
      expect(contextB.status).toBe('active');

      // ── 9. On the FRESH context, send_webhook must now be ALLOWED (base
      //      policy allows, and no contextual labels are present) —
      //      concrete proof that context state does not leak across
      //      independent contexts. ──────────────────────────────────────
      const allowed = (await clientB.callTool({ name: 'send_webhook', arguments: { url: 'https://example.invalid/legit' } })) as ToolCallResult;
      expect(allowed.isError).toBeFalsy();
      expect(readCounter(counterDir, 'send_webhook')).toBe(1);

      readStorage2.close();
    },
    30000
  );

  it(
    'contextual REQUIRE_APPROVAL: stale-revision approval cannot execute, a valid approval is single-use, and does not clear context labels',
    async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-cg-gw-approval-'));
      const dbPath = path.join(tmpDir, 'db.sqlite');
      const counterDir = path.join(tmpDir, 'counters');
      fs.mkdirSync(counterDir);
      const policyPath = path.join(tmpDir, 'policy.yml');
      const configPath = path.join(tmpDir, 'agentgate.yml');
      writeConfig({
        configPath,
        policyPath,
        dbPath,
        counterDir,
        controlPort: 4713,
        ruleAction: 'require_approval',
        approvalTtlSeconds: 15,
      });

      const client = await connect(configPath, tmpDir);

      // Out-of-process approval resolution — a SEPARATE AuditStorage/
      // ApprovalManager connection against the SAME db file, exactly
      // mirroring how the Tool Integrity gateway test resolves a
      // candidate out-of-process without touching the live gateway
      // process. WAL mode makes writes from this connection visible to
      // the live gateway's own polling reads.
      const outOfProcStorage = new AuditStorage(dbPath);
      const outOfProcApprovals = new ApprovalManager(outOfProcStorage);

      async function waitForPendingApproval(scope: string): Promise<Approval> {
        return waitFor(
          () => outOfProcStorage.listPendingApprovals().find((a) => a.scope === scope),
          10000,
          `pending approval for ${scope}`
        );
      }

      try {
        // Accumulate one risk label so send_webhook becomes contextually gated.
        const ticketResult = (await client.callTool({ name: 'fetch_ticket', arguments: {} })) as ToolCallResult;
        expect(ticketResult.isError).toBeFalsy();

        // ── Call #1: send_webhook -> creates approval P1 bound to the
        //    CURRENT context revision (1). Do not await the call yet —
        //    the gateway is polling for a human decision. ────────────────
        const call1Promise = client.callTool({ name: 'send_webhook', arguments: { url: 'https://example.invalid/a' } });
        const approvalP1 = await waitForPendingApproval('send_webhook');
        expect(approvalP1.context_revision).toBe(1);

        // ── Advance the context revision WHILE P1 is still pending, via a
        //    second, concurrent call over the SAME connection — proving
        //    concurrent/out-of-order calls do not silently share stale
        //    state, and setting up the stale-approval proof below. ───────
        const secretResult = (await client.callTool({ name: 'read_secret', arguments: {} })) as ToolCallResult;
        expect(secretResult.isError).toBeFalsy();
        const advancedState = await waitFor(
          () => {
            const s = outOfProcStorage.listContextStates()[0];
            return s.revision > 1 ? s : undefined;
          },
          10000,
          'context revision advanced past P1\'s bound revision'
        );
        expect(advancedState.revision).toBe(2);

        // ── Approve P1 anyway (a human clicking "approve" without
        //    re-checking current state) — revalidation at consumption time
        //    must reject it: the context has advanced since P1 was
        //    created. ───────────────────────────────────────────────────
        const approveP1Result = outOfProcApprovals.approve(approvalP1.id);
        expect(approveP1Result.ok).toBe(true); // the approval ITSELF resolves...
        const call1Result = (await call1Promise) as ToolCallResult;
        expect(call1Result.isError).toBe(true); // ...but execution is still refused on revalidation.
        expect(readCounter(counterDir, 'send_webhook')).toBe(0);

        // ── Call #2: a FRESH send_webhook attempt creates a NEW approval
        //    P2, bound to the NOW-current revision (2) — never reuses P1. ─
        const call2Promise = client.callTool({ name: 'send_webhook', arguments: { url: 'https://example.invalid/b' } });
        const approvalP2 = await waitForPendingApproval('send_webhook');
        expect(approvalP2.id).not.toBe(approvalP1.id);
        expect(approvalP2.context_revision).toBe(2);

        const approveP2Result = outOfProcApprovals.approve(approvalP2.id);
        expect(approveP2Result.ok).toBe(true);
        const call2Result = (await call2Promise) as ToolCallResult;
        expect(call2Result.isError).toBeFalsy();
        expect(readCounter(counterDir, 'send_webhook')).toBe(1); // exactly one real execution.

        // Approving/consuming P2 does not clear context labels or
        // whitelist future calls — a THIRD attempt must undergo fresh
        // evaluation (its own new, distinct approval), not silently reuse P2.
        const stateAfterP2 = outOfProcStorage.getContextState(outOfProcStorage.listContextStates()[0].context_id)!;
        expect(stateAfterP2.labels.slice().sort()).toEqual(['sensitive_data_accessed', 'untrusted_content']);

        const call3Promise = client.callTool({ name: 'send_webhook', arguments: { url: 'https://example.invalid/c' } });
        const approvalP3 = await waitForPendingApproval('send_webhook');
        expect(approvalP3.id).not.toBe(approvalP2.id);
        expect(outOfProcStorage.getApproval(approvalP2.id)!.consumed).toBe(true); // P2 stays consumed, unaffected.

        // Deny P3 quickly rather than waiting out its TTL — resolves the
        // pending call and confirms the counter is untouched by a denial.
        outOfProcApprovals.deny(approvalP3.id);
        const call3Result = (await call3Promise) as ToolCallResult;
        expect(call3Result.isError).toBe(true);
        expect(readCounter(counterDir, 'send_webhook')).toBe(1); // still exactly 1.
      } finally {
        outOfProcApprovals.destroy();
        outOfProcStorage.close();
      }
    },
    30000
  );
});
