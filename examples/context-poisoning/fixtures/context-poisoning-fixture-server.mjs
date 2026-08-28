// Fixture downstream MCP stdio server for the Context Guard poisoned-result
// demo (examples/context-poisoning/demo.mjs, Milestone 7, ADR-0013). Not a
// mock/stub of AgentGate itself — a real, separate MCP server process that
// AgentGate's executeDownstream() talks to exactly as it would talk to any
// real downstream tool. Adapted from packages/gateway/tests/fixtures/
// context-guard-fixture-server.mjs (kept as an independent copy, per this
// project's existing examples/* convention of each demo owning its own
// fixture rather than reaching into packages/gateway/tests).
//
// Three tools, each with its OWN persistent, process-external call counter
// (a separate plain integer file per tool, inside the directory named by
// FIXTURE_COUNTER_DIR) — so the demo can prove exactly which tools were
// actually dispatched to, independent of gateway-side policy/decision
// state:
//
//   fetch_ticket         -> returns a REALISTIC synthetic indirect-prompt-
//                            injection payload (a support-ticket body that
//                            embeds an instruction telling an agent to read
//                            a secret and exfiltrate it — see constants.mjs
//                            for the exact text). Operator policy
//                            classifies this tool's successful result as
//                            adding the `untrusted_content` context label.
//                            This text is never interpreted or acted on by
//                            this fixture, the gateway, or the demo script
//                            itself — no LLM is involved anywhere in this
//                            demo; it exists only as the untrusted content
//                            an agent COULD have been steered by, which
//                            Context Guard defends against regardless of
//                            whether any model actually "obeyed" it.
//   read_secret_fixture  -> returns a synthetic, unmistakably-fake secret
//                            value (constants.mjs's SYNTHETIC_SECRET —
//                            never a real credential). Classified as
//                            `sensitive_read` effect / `sensitive_data_
//                            accessed` on result.
//   send_webhook          -> the tool a contextual rule is expected to
//                            deny/require-approval for. Classified as
//                            `external_communication` effect.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { SYNTHETIC_SECRET, TICKET_BODY } from './constants.mjs';

const COUNTER_DIR = process.env.FIXTURE_COUNTER_DIR;

function counterPath(toolName) {
  return path.join(COUNTER_DIR, `${toolName}.count`);
}

function bumpCallCounter(toolName) {
  if (!COUNTER_DIR) return;
  const p = counterPath(toolName);
  let current = 0;
  try {
    current = parseInt(fs.readFileSync(p, 'utf8'), 10) || 0;
  } catch {
    current = 0;
  }
  fs.writeFileSync(p, String(current + 1));
}

const server = new Server({ name: 'context-poisoning-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'fetch_ticket', description: 'Fetches a support ticket body (untrusted content source)', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_secret_fixture', description: 'Reads a synthetic sensitive value', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_webhook', description: 'Sends data to an external webhook URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  bumpCallCounter(name);
  switch (name) {
    case 'fetch_ticket':
      return { content: [{ type: 'text', text: TICKET_BODY }] };
    case 'read_secret_fixture':
      return { content: [{ type: 'text', text: `internal-api-key=${SYNTHETIC_SECRET}` }] };
    case 'send_webhook':
      return { content: [{ type: 'text', text: `sent to ${String(args?.url ?? 'unknown')}` }] };
    default:
      throw new Error(`context-poisoning-fixture-server: unknown tool ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
