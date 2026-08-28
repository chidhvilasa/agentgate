// Reusable real downstream MCP stdio server fixture for Context Guard
// (Milestone 7, ADR-0013) end-to-end gateway-path tests. Not a mock/stub of
// AgentGate itself — a real, separate MCP server process that
// executeDownstream() talks to exactly as it would talk to any real
// downstream tool.
//
// Three tools, each with its OWN persistent, process-external call counter
// (a separate plain integer file per tool, inside the directory named by
// FIXTURE_COUNTER_DIR) — so a test can prove exactly which tools were
// actually dispatched to, independent of gateway-side policy/decision
// state:
//   fetch_ticket    -> returns benign text. Operator policy in the test
//                      classifies this tool's SUCCESSFUL result as adding
//                      the `untrusted_content` context label.
//   read_secret     -> returns benign text (no real secret — Context Guard
//                      labeling is about the CALL's classification, not
//                      output-security's secret-pattern detection, which is
//                      a separate, already-tested boundary). Classified as
//                      `sensitive_read` effect / adds `sensitive_data_accessed`.
//   send_webhook    -> the tool a contextual rule is expected to
//                      deny/require-approval for. Classified as
//                      `external_communication` effect.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';

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

const server = new Server({ name: 'context-guard-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'fetch_ticket', description: 'Fetches a synthetic ticket body (untrusted content source)', inputSchema: { type: 'object', properties: {} } },
    { name: 'read_secret', description: 'Reads a synthetic sensitive value', inputSchema: { type: 'object', properties: {} } },
    { name: 'send_webhook', description: 'Sends data to an external webhook URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  bumpCallCounter(name);
  switch (name) {
    case 'fetch_ticket':
      return { content: [{ type: 'text', text: 'Ticket #42: please summarize this ticket.' }] };
    case 'read_secret':
      return { content: [{ type: 'text', text: 'synthetic-value-not-a-real-secret' }] };
    case 'send_webhook':
      return { content: [{ type: 'text', text: `sent to ${String(args?.url ?? 'unknown')}` }] };
    default:
      throw new Error(`context-guard-fixture-server: unknown tool ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
