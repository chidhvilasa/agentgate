// AgentGate — Policy-Drift Replay Demo (ADR-0010)
//
// Demonstrates Safe Replay end-to-end through two real public boundaries
// (the Control API over HTTP, and the `agentgate replay` CLI command)
// against production-built packages (packages/gateway/dist), and proves —
// with an executable, process-external call counter, not just an assertion
// in prose — that neither replay path ever contacts, executes, or discovers
// the downstream MCP server.
//
// Flow:
//   1. Start a real AgentGate gateway + a real (fixture) downstream MCP
//      server, under policy A (a rule that ALLOWs the `echo` tool).
//   2. Make one real, audited tool call — this is the historical event
//      Safe Replay will later be evaluated against. Its arguments carry a
//      synthetic secret, so the resulting audit record is also redacted —
//      proving replay's redacted-source-argument path end-to-end too.
//   3. Record the downstream fixture's call counter (expected: 1).
//   4. Overwrite the SAME policy file with policy B — the same rule id now
//      DENIES `echo`. This is the "policy drift": nothing about the
//      historical event changes, only what today's policy would decide.
//   5. Replay the historical event via the Control API (HTTP) — assert the
//      decision changed from ALLOW to DENY, `executed: false`, no secret in
//      the response, and the downstream counter is still 1.
//   6. Replay the SAME historical event again via the `agentgate replay`
//      CLI — assert the same drift, `executed: false`, no secret in stdout,
//      and the downstream counter is STILL 1.
//   7. Assert no approval was ever created, the source audit record is
//      unchanged, and both the audit chain and the replay lineage chain
//      verify cleanly via `agentgate audit verify`.
//
// Deterministic, fully offline, synthetic credentials only. Every file this
// script creates lives under one temp directory, removed in a `finally`
// block on both success and failure. Never calls process.exit() directly —
// only ever sets process.exitCode.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const CLI_BIN = path.join(ROOT, 'packages/gateway/dist/cli.js');
// A real, separate MCP server process — the same fixture the gateway's own
// automated no-execution-invariant tests use (packages/gateway/tests/
// replay-no-execution.test.ts) — reused here so the executable counter
// proof is backed by the identical, already-reviewed mechanism rather than
// a second, demo-only implementation.
const FIXTURE_SERVER = path.join(ROOT, 'packages/gateway/tests/fixtures/fixture-downstream-server.mjs');

const GATEWAY_PORT = 4341;
const CONTROL_PORT = 4342;

// Synthetic-only, unmistakably fake — matches the literal already allowlisted
// in .github/workflows/security.yml's tracked-file secret scan. Never a real
// credential of any kind. This value must never be printed to the terminal
// by this script, and every assertion below confirms it never appears in
// any persisted or returned data either.
const SYNTHETIC_SECRET = 'AKIAIOSFODNN7EXAMPLE';

/** Converts a path to forward slashes so it embeds safely in generated YAML. */
function toYamlPath(p) {
  return p.split(path.sep).join('/');
}

/**
 * Asserts `target` resolves inside `tmpDir` before any filesystem mutation.
 * This is the safety gate that keeps cleanup from ever touching a
 * pre-existing user file outside the demo's own scratch directory.
 */
function assertInsideTempDir(tmpDir, target) {
  const resolvedTmpDir = path.resolve(tmpDir);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedTmpDir && !resolvedTarget.startsWith(resolvedTmpDir + path.sep)) {
    throw new Error(
      `Refusing to remove path outside the demo's temp directory: ${resolvedTarget} (expected under ${resolvedTmpDir})`
    );
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

function readCounter(counterFile) {
  try {
    return parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

function check(label, condition) {
  console.log(`${condition ? '✅ PASS' : '❌ FAIL'} — ${label}`);
  return Boolean(condition);
}

const POLICY_A = `
version: 1
defaults:
  decision: deny
rules:
  - id: echo-rule
    tools: ["echo"]
    decision: allow
`;

// Same rule id, same tool — only its effect changed. This is the drift: not
// a different rule matching, but the same rule now deciding differently.
const POLICY_B = `
version: 1
defaults:
  decision: deny
rules:
  - id: echo-rule
    tools: ["echo"]
    decision: deny
`;

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-policy-drift-'));

  const policyPath = path.join(tmpDir, 'policy.yml');
  const configPath = path.join(tmpDir, 'agentgate-policy-drift.yml');
  const dbPath = path.join(tmpDir, 'agentgate.sqlite');
  const counterFile = path.join(tmpDir, 'call-count.txt');

  let client;
  let transport;
  let db;
  let storage;
  const results = [];

  try {
    fs.writeFileSync(policyPath, POLICY_A);

    const CONFIG = `
version: 1
gateway_port: ${GATEWAY_PORT}
control_port: ${CONTROL_PORT}
policy: ${toYamlPath(policyPath)}
db_path: ${toYamlPath(dbPath)}
servers:
  - id: fixture
    name: fixture
    transport: stdio
    command: node
    args:
      - ${toYamlPath(FIXTURE_SERVER)}
`;
    fs.writeFileSync(configPath, CONFIG);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  AgentGate — Safe Replay Demo: Policy-Drift Analysis       ');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('Starting AgentGate Gateway process under policy A (echo: ALLOW)...');

    client = new Client({ name: 'policy-drift-demo', version: '1.0.0' }, { capabilities: {} });
    transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_BIN, 'start', configPath],
      env: { ...process.env, FIXTURE_CALL_COUNT_FILE: counterFile },
      cwd: tmpDir,
      stderr: 'pipe',
    });

    let stderrBuffer = '';
    transport.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
    });

    await client.connect(transport);

    // The gateway prints its per-launch auth token to stderr on startup,
    // before it starts serving the stdio proxy — by the time the MCP
    // handshake above has completed, it has already been printed. A short,
    // bounded poll (not an indefinite wait) covers the small delay in the
    // piped stream actually flushing that chunk to us.
    let token = null;
    for (let i = 0; i < 40 && !token; i++) {
      const match = stderrBuffer.match(/Auth token: (\S+)/);
      if (match) {
        token = match[1];
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!token) throw new Error('Could not read the gateway auth token from stderr within the startup window.');

    const controlBase = `http://127.0.0.1:${CONTROL_PORT}`;
    const authHeaders = { 'content-type': 'application/json', 'x-agentgate-token': token };

    console.log('\nStep 1 — Making one real, audited tool call under policy A...');
    const callResult = await client.callTool({
      name: 'echo',
      arguments: { text: `hello world (arguments contain a synthetic secret placeholder)` , note: SYNTHETIC_SECRET },
    });
    const wasAllowed = !callResult?.isError;
    results.push(check('The historical call was ALLOWED under policy A', wasAllowed));

    const counterAfterRealCall = readCounter(counterFile);
    results.push(check(`Downstream fixture call counter is 1 after the one real execution (got ${counterAfterRealCall})`, counterAfterRealCall === 1));

    // Find the event id for the call we just made.
    const eventsRes = await fetch(`${controlBase}/api/events?tool=echo&limit=1`, { headers: authHeaders });
    const events = await eventsRes.json();
    const sourceEvent = events[0];
    results.push(check('Located the historical audit event for the echo call', Boolean(sourceEvent?.id)));
    const eventId = sourceEvent.id;

    results.push(check('The historical event is flagged arguments_redacted (secret was in the request)', sourceEvent.arguments_redacted === true));
    results.push(check('Original recorded decision was ALLOW', sourceEvent.decision?.type === 'ALLOW'));

    const sourceEventBeforeReplay = await (await fetch(`${controlBase}/api/events/${eventId}`, { headers: authHeaders })).json();

    console.log('\nStep 2 — Policy drift: rewriting the SAME rule to now DENY the echo tool...');
    fs.writeFileSync(policyPath, POLICY_B);

    console.log('\nStep 3 — Replaying the historical event via the Control API (HTTP)...');
    const apiReplayRes = await fetch(`${controlBase}/api/events/${eventId}/replay`, {
      method: 'POST',
      headers: authHeaders,
    });
    const apiReplay = await apiReplayRes.json();
    const apiReplayText = JSON.stringify(apiReplay);

    results.push(check('API replay HTTP status is 200', apiReplayRes.status === 200));
    results.push(check('API replay response has executed: false', apiReplay.executed === false));
    results.push(check('API replay response has mode: policy_only', apiReplay.mode === 'policy_only'));
    results.push(check('API replay reports original decision ALLOW', apiReplay.original?.decision_type === 'ALLOW'));
    results.push(check('API replay reports current decision DENY (the drift)', apiReplay.current?.decision_type === 'DENY'));
    results.push(check('API replay reports decision_changed: true', apiReplay.decision_changed === true));
    results.push(check('API replay reports matched_rule_changed: false (same rule, different effect)', apiReplay.matched_rule_changed === false));
    results.push(check('API replay response does not contain the raw synthetic secret', !apiReplayText.includes(SYNTHETIC_SECRET)));

    const counterAfterApiReplay = readCounter(counterFile);
    results.push(check(`Downstream fixture call counter is STILL 1 after the API replay (got ${counterAfterApiReplay})`, counterAfterApiReplay === 1));

    const approvalsAfterApiReplay = await (await fetch(`${controlBase}/api/approvals`, { headers: authHeaders })).json();
    results.push(check('No approval exists after the API replay', Array.isArray(approvalsAfterApiReplay) && approvalsAfterApiReplay.length === 0));

    console.log('\nStep 4 — Replaying the SAME historical event again via the `agentgate replay` CLI...');
    let cliStdout = '';
    let cliOk = true;
    try {
      cliStdout = execFileSync(process.execPath, [CLI_BIN, 'replay', eventId, configPath, '--json'], {
        cwd: tmpDir,
        encoding: 'utf8',
      });
    } catch (err) {
      cliOk = false;
      cliStdout = String(err.stdout ?? err.message ?? '');
    }
    let cliReplay = {};
    try {
      cliReplay = JSON.parse(cliStdout);
    } catch {
      // handled by the assertions below
    }

    results.push(check('CLI replay command exited successfully', cliOk));
    results.push(check('CLI replay response has executed: false', cliReplay.executed === false));
    results.push(check('CLI replay reports current decision DENY (same drift, independent path)', cliReplay.current?.decision_type === 'DENY'));
    results.push(check('CLI replay stdout does not contain the raw synthetic secret', !cliStdout.includes(SYNTHETIC_SECRET)));

    const counterAfterCliReplay = readCounter(counterFile);
    results.push(check(`Downstream fixture call counter is STILL 1 after the CLI replay (got ${counterAfterCliReplay})`, counterAfterCliReplay === 1));

    console.log('\nStep 5 — Verifying the source audit record was never mutated by either replay...');
    const sourceEventAfterReplay = await (await fetch(`${controlBase}/api/events/${eventId}`, { headers: authHeaders })).json();
    results.push(
      check(
        'The source event is byte-identical before and after both replays',
        JSON.stringify(sourceEventBeforeReplay) === JSON.stringify(sourceEventAfterReplay)
      )
    );

    console.log('\nStep 6 — Verifying the tamper-evident audit chain AND replay lineage chain...');
    let verifyOut = '';
    let verifyOk = true;
    try {
      verifyOut = execFileSync(process.execPath, [CLI_BIN, 'audit', 'verify', configPath], { cwd: tmpDir, encoding: 'utf8' });
    } catch (err) {
      verifyOk = false;
      verifyOut = String(err.stdout ?? err.message ?? '');
    }
    results.push(check('`agentgate audit verify` exited successfully (both chains valid)', verifyOk));
    results.push(check('Audit chain verification message present', verifyOut.includes('Audit chain verified')));
    results.push(check('Replay lineage verification message present', verifyOut.includes('Replay lineage verified')));
    results.push(check('`agentgate audit verify` output does not contain the raw synthetic secret', !verifyOut.includes(SYNTHETIC_SECRET)));

    // Independently confirm via direct storage inspection too (not just the
    // CLI's own report of itself).
    const { AuditStorage } = await import('../../packages/gateway/dist/storage.js');
    storage = new AuditStorage(dbPath);
    const replayEvaluations = storage.listReplayEvaluationsForEvent(eventId);
    results.push(check('Exactly two replay evaluations were persisted (one per replay path)', replayEvaluations.length === 2));
    const replayVerify = storage.verifyReplayChain();
    results.push(check('storage.verifyReplayChain() independently reports valid', replayVerify.valid === true));

    const allPassed = results.every(Boolean);
    console.log('');
    if (allPassed) {
      console.log('🎉 ALL TESTS PASSED. Safe Replay correctly detected the policy drift end-to-end,');
      console.log('   through both the Control API and the CLI, without ever executing the tool,');
      console.log('   contacting the downstream server, or creating an approval.');
    } else {
      console.error('❌ One or more assertions failed — see PASS/FAIL lines above.');
    }

    process.exitCode = allPassed ? 0 : 1;
  } finally {
    // ── Close every open resource, success or failure ─────────────────────
    if (storage) {
      try {
        storage.close();
      } catch (err) {
        console.warn(`[cleanup] Error closing audit storage: ${err.message}`);
      }
    }
    if (db) {
      try {
        db.close();
      } catch (err) {
        console.warn(`[cleanup] Error closing sqlite connection: ${err.message}`);
      }
    }
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.warn(`[cleanup] Error closing MCP client: ${err.message}`);
      }
    }
    if (transport) {
      try {
        // client.close() already closes the underlying transport (and
        // terminates the spawned gateway process); this is a no-op safety
        // net for the case where connect() failed before a client existed.
        await transport.close();
      } catch (err) {
        console.warn(`[cleanup] Error closing transport: ${err.message}`);
      }
    }

    // ── Remove generated fixtures — never anything outside tmpDir ─────────
    for (const target of [policyPath, configPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, counterFile]) {
      safeRemoveFile(tmpDir, target);
    }
    try {
      // tmpDir itself must resolve inside the OS temp directory before we
      // recursively remove it.
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
