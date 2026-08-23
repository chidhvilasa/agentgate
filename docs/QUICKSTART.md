# Quickstart

A slightly more detailed walkthrough than the README's five-minute version — including the Control Center.

## 1. Prerequisites

- Node.js 20+ (`node -v`)
- pnpm (see `packageManager` in root `package.json`; `corepack enable` will resolve it automatically)
- Network access the first time you run the example config (it uses `npx -y @modelcontextprotocol/server-filesystem`
  as the downstream MCP server, which `npx` fetches on first use)

## 2. Clone and build

```sh
git clone https://github.com/chidhvilasa/agentgate.git
cd agentgate
pnpm install --frozen-lockfile
pnpm run build
```

## 3. Validate the example policy

```sh
node packages/gateway/dist/cli.js validate policies/agentgate.example.yml
```

Expect: `✅ Policy "policies/agentgate.example.yml" is valid.`

## 4. Start the gateway

```sh
node packages/gateway/dist/cli.js start examples/agentgate.yml
```

You'll see, on stderr:

```text
[agentgate] Loading config from examples/agentgate.yml
[agentgate] Control API listening on http://127.0.0.1:4001
[agentgate] Auth token: <64-character hex string>
[agentgate] Control Center: http://127.0.0.1:4001
[agentgate] Stdio proxy started. Waiting for MCP client...
```

Copy the auth token — you'll need it for the Control Center. The process now blocks, waiting for an MCP client to
speak to it over stdin/stdout.

## 5. Open the Control Center

In a second terminal:

```sh
pnpm run dev:control
```

This starts Vite's dev server (default `http://127.0.0.1:5173`). Open it in a browser. The UI will show
"Gateway offline" until it has a valid token — open the browser devtools console and run:

```js
localStorage.setItem('agentgate_token', '<paste the token from step 4>')
```

then reload. The status dot in the top bar should turn to "Gateway connected."

## 6. Point an MCP client at AgentGate

Configure your MCP client (e.g. Claude Code) to run AgentGate as the MCP server, instead of the downstream server
directly:

```json
{
  "command": "node",
  "args": ["<absolute path to repo>/packages/gateway/dist/cli.js", "start", "<absolute path to repo>/examples/agentgate.yml"]
}
```

Tool calls the client makes will now be evaluated against `policies/agentgate.example.yml` before (or instead of)
reaching the real filesystem server, and will appear live in the Control Center's Timeline.

## 7. See it block an attack

```sh
node examples/secret-exfiltration/demo.mjs
```

This runs an independent, self-contained simulation (its own temp gateway + temp downstream server + temp
database — it does not touch the one you started in step 4) of a prompt-injected agent trying to exfiltrate an AWS
key, and verifies the block, the redaction, and the audit hash chain.

## 8. Verify the audit chain of your own run

```sh
node packages/gateway/dist/cli.js audit verify examples/agentgate.yml
```

## Next steps

- [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md) — write your own policy rules.
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces fit together.
- [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) — what AgentGate does and does not protect against.
- [`docs/TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — if something above didn't work.
