// Reusable real downstream MCP stdio server fixture for gateway pipeline
// integration tests. Not a mock/stub of AgentGate itself — this is a real,
// separate MCP server process that runPipeline()/executeDownstream() talk to
// exactly as they would talk to any real downstream tool.
//
// Tool behaviors (selected by tool name so a single fixture serves every
// pipeline test scenario):
//   echo          -> { content: [{ type: 'text', text: args.text }] }
//   leak_secret   -> { content: [{ type: 'text', text: 'leaked: <synthetic AWS key>' }] }
//   leak_error    -> throws an Error whose message contains a synthetic secret
//   error_result  -> { content: [...], isError: true } with a secret embedded
//
// No-execution proof (ADR-0010): if the FIXTURE_CALL_COUNT_FILE env var is
// set, every real tool call handled here increments a plain integer counter
// persisted at that path (created if absent). Safe Replay tests assert this
// file's value is unchanged across a replay evaluation — an executable,
// process-external proof that replay never reaches this server, not just an
// in-process spy/mock assertion.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';

// Synthetic-only, unmistakably fake — never a real credential.
const SYNTHETIC_SECRET = 'AKIAIOSFODNN7EXAMPLE';

const COUNTER_FILE = process.env.FIXTURE_CALL_COUNT_FILE;

function bumpCallCounter() {
  if (!COUNTER_FILE) return;
  let current = 0;
  try {
    current = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8'), 10) || 0;
  } catch {
    current = 0;
  }
  fs.writeFileSync(COUNTER_FILE, String(current + 1));
}

const server = new Server({ name: 'fixture-downstream', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echoes text back', inputSchema: { type: 'object', properties: {} } },
    { name: 'leak_secret', description: 'Returns a result containing a secret', inputSchema: { type: 'object', properties: {} } },
    { name: 'leak_error', description: 'Throws an error containing a secret', inputSchema: { type: 'object', properties: {} } },
    { name: 'error_result', description: 'Returns an isError result containing a secret', inputSchema: { type: 'object', properties: {} } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  bumpCallCounter();
  switch (name) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args?.text ?? 'ok') }] };
    case 'leak_secret':
      return { content: [{ type: 'text', text: `leaked: ${SYNTHETIC_SECRET}` }] };
    case 'leak_error':
      throw new Error(`downstream failed while holding ${SYNTHETIC_SECRET}`);
    case 'error_result':
      return { content: [{ type: 'text', text: `error context: ${SYNTHETIC_SECRET}` }], isError: true };
    default:
      throw new Error(`fixture-downstream-server: unknown tool ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
