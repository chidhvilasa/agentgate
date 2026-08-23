import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const CLI_BIN = path.join(ROOT, 'packages/gateway/dist/cli.js');
// The mock downstream server lives outside ROOT (in the OS temp dir), so it
// cannot rely on Node's node_modules resolution walking up from its own
// directory — require the SDK's CJS build by absolute path instead.
const SDK_CJS_DIR = path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/cjs');

// Synthetic-only, unmistakably fake — matches the literal already allowlisted
// in .github/workflows/security.yml's tracked-file secret scan. Never a real
// credential of any kind.
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

async function main() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-output-demo-'));

  const mockDownstreamPath = path.join(tmpDir, 'mock-downstream.js');
  const policyPath = path.join(tmpDir, 'policy.yml');
  const configPath = path.join(tmpDir, 'agentgate-output-demo.yml');
  const dbPath = path.join(tmpDir, 'agentgate.sqlite');

  let client;
  let transport;
  let db;
  let storage;
  let passed = false;

  try {
    // A real (but fixture) downstream MCP server. Both tools it exposes are
    // benign calls from AgentGate's point of view — the attack scenario here
    // is that the DOWNSTREAM SERVER'S RESPONSE, not the inbound tool-call
    // arguments, carries a leaked secret. This is exactly the gap Milestone 1
    // did not close: inbound argument redaction alone would not have caught
    // either of these.
    const FAKE_DOWNSTREAM = `
const { Server } = require(${JSON.stringify(path.join(SDK_CJS_DIR, 'server/index.js'))});
const { StdioServerTransport } = require(${JSON.stringify(path.join(SDK_CJS_DIR, 'server/stdio.js'))});
const { CallToolRequestSchema, ListToolsRequestSchema } = require(${JSON.stringify(path.join(SDK_CJS_DIR, 'types.js'))});
const server = new Server({ name: 'mock-downstream', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'fetch_data', description: 'Fetch some data', inputSchema: { type: 'object', properties: {} } },
    { name: 'flaky_call', description: 'A call that fails with a leaky error', inputSchema: { type: 'object', properties: {} } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'fetch_data') {
    return { content: [{ type: 'text', text: 'Here is your data. debug_key=${SYNTHETIC_SECRET} (should not reach the agent unredacted)' }] };
  }
  if (req.params.name === 'flaky_call') {
    throw new Error('connection failed while using cached credential ${SYNTHETIC_SECRET}');
  }
  return { content: [{ type: 'text', text: 'unhandled' }], isError: true };
});
const transport = new StdioServerTransport();
server.connect(transport);
`;
    fs.writeFileSync(mockDownstreamPath, FAKE_DOWNSTREAM);

    // A permissive policy — both tools are plainly allowed. The point of this
    // demo is that AgentGate protects the agent even when the *policy*
    // correctly allows the call; the danger is entirely in what the
    // downstream server sends back.
    const POLICY = `
version: 1
defaults:
  decision: deny
rules:
  - id: allow-fixture-tools
    tools: ["fetch_data", "flaky_call"]
    decision: allow
`;
    fs.writeFileSync(policyPath, POLICY);

    const CONFIG = `
version: 1
gateway_port: 4339
control_port: 4340
policy: ${toYamlPath(policyPath)}
db_path: ${toYamlPath(dbPath)}
servers:
  - id: mock-server
    name: mock
    transport: stdio
    command: node
    args:
      - ${toYamlPath(mockDownstreamPath)}
output_security:
  mode: redact
`;
    fs.writeFileSync(configPath, CONFIG);

    console.log('═══════════════════════════════════════════════════════');
    console.log('  AgentGate — Attack Demo: Downstream Result Secret Leak  ');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('Starting AgentGate Gateway process...');

    client = new Client({ name: 'claude-code-fixture', version: '1.0.0' }, { capabilities: {} });
    transport = new StdioClientTransport({
      command: 'node',
      args: [CLI_BIN, 'start', configPath],
      env: process.env,
      cwd: tmpDir,
    });

    await client.connect(transport);

    // ── Scenario 1: a benign, policy-allowed call whose downstream RESULT
    //    happens to contain a secret. ──────────────────────────────────────
    console.log('\nScenario 1: policy allows "fetch_data" — the downstream server');
    console.log('leaks a synthetic credential in its RESPONSE, not the request.\n');

    const fetchResult = await client.callTool({ name: 'fetch_data', arguments: {} });
    const returnedText = fetchResult?.content?.[0]?.text ?? '';
    console.log('Gateway Response text:', returnedText);

    const secretAbsentUpstream = !returnedText.includes(SYNTHETIC_SECRET);
    console.log('Step 1 — Secret absent from upstream response:', secretAbsentUpstream ? '✅ PASS' : '❌ FAIL');

    // ── Scenario 2: the downstream server throws, and its exception message
    //    itself contains a secret. ─────────────────────────────────────────
    console.log('\nScenario 2: "flaky_call" fails downstream; its exception message');
    console.log('itself contains a synthetic credential.\n');

    const flakyResult = await client.callTool({ name: 'flaky_call', arguments: {} });
    console.log('Gateway Response (flaky_call):', flakyResult);

    // Verify Audit DB
    console.log('\nVerifying Audit Records in DB...');
    const sqlite = (await import('better-sqlite3')).default;
    db = new sqlite(dbPath);

    let dbChecksPassed = false;
    const events = db.prepare('SELECT * FROM audit_events ORDER BY created_at ASC').all();
    if (events.length === 2) {
      console.log('✅ PASS — 2 audit events found.');

      const fetchEvent = events.find((e) => e.tool_call_json.includes('fetch_data'));
      const flakyEvent = events.find((e) => e.tool_call_json.includes('flaky_call'));

      let resultRedactedOk = false;
      if (fetchEvent && fetchEvent.result_redacted === 1) {
        console.log('✅ PASS — fetch_data event is flagged result_redacted.');
        resultRedactedOk = true;
      } else {
        console.error('❌ FAIL — fetch_data event is not flagged result_redacted:', fetchEvent?.result_redacted);
      }

      let noRawSecretInDbOk = false;
      const wholeDbDump = JSON.stringify(events);
      if (!wholeDbDump.includes(SYNTHETIC_SECRET)) {
        console.log('✅ PASS — The raw synthetic secret is ABSENT from every persisted row (result AND error).');
        noRawSecretInDbOk = true;
      } else {
        console.error('❌ FAIL — The raw synthetic secret was PERSISTED somewhere in the database.');
      }

      let errorRedactedOk = false;
      if (flakyEvent && flakyEvent.error_redacted === 1 && flakyEvent.execution_error && !flakyEvent.execution_error.includes(SYNTHETIC_SECRET)) {
        console.log('✅ PASS — flaky_call event is flagged error_redacted and execution_error has no raw secret.');
        errorRedactedOk = true;
      } else {
        console.error('❌ FAIL — flaky_call error was not properly sanitized:', flakyEvent?.execution_error);
      }

      dbChecksPassed = resultRedactedOk && noRawSecretInDbOk && errorRedactedOk;
    } else {
      console.error(`❌ FAIL — Expected 2 audit events, found ${events.length}`);
    }

    // Verify Hash Chain
    console.log('\nVerifying Tamper-Evident Hash Chain...');
    const { AuditStorage } = await import('../../packages/gateway/dist/storage.js');
    storage = new AuditStorage(dbPath);
    const verifyResult = storage.verifyChain();

    let chainOk = false;
    if (verifyResult.valid) {
      console.log(`✅ PASS — Audit chain verified (${verifyResult.count} records).`);
      chainOk = true;
    } else {
      console.error(`❌ FAIL — Audit chain invalid: ${verifyResult.error}`);
    }

    passed = Boolean(secretAbsentUpstream) && dbChecksPassed && chainOk;

    if (passed) {
      console.log('\n🎉 ALL TESTS PASSED. AgentGate sanitized a downstream result and a downstream error end-to-end.');
    }
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
    for (const target of [mockDownstreamPath, policyPath, configPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
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

  return passed;
}

main()
  .then((passed) => {
    process.exitCode = passed ? 0 : 1;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
