#!/usr/bin/env node
// Built-in smoke-test downstream fixture (Milestone 5). A real, separate
// MCP stdio server process — not a mock or stub inside the gateway
// process — spawned exclusively by `agentgate smoke-test`. Deliberately
// plain JavaScript (not TypeScript): it must run identically whether
// AgentGate is being tested from a source checkout (before any build) or
// from an installed/packed package, with no compile step in between —
// exactly like packages/gateway/tests/fixtures/fixture-downstream-server.mjs
// does for the test suite. This file is copied into dist/onboarding/ by
// `scripts/copy-assets.mjs` as part of `pnpm run build`, so it ships with
// the compiled package too.
//
// Exposes exactly one harmless tool: `echo`.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'agentgate-smoke-test-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'echo', description: 'Echoes text back', inputSchema: { type: 'object', properties: {} } }],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== 'echo') {
    throw new Error(`agentgate-smoke-test-fixture: unknown tool "${name}"`);
  }
  const text = args?.text;
  return { content: [{ type: 'text', text: typeof text === 'string' ? text : 'ok' }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
