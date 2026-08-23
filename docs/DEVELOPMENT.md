# Development Guide

## Supported Node version

Node.js **20+** (`.nvmrc` pins `20`; CI and local development both use Node 20 and 22 — see
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). Uses native ESM (`"type": "module"` in every package)
and `better-sqlite3` native bindings, so a Node version with prebuilt binaries for your platform is recommended
(20 and 22 both have them for Windows/macOS/Linux).

## pnpm setup

This repo pins its package manager in root `package.json` (`packageManager` field). With
[Corepack](https://nodejs.org/api/corepack.html) (bundled with Node 20+):

```sh
corepack enable
```

pnpm will then resolve to the pinned version automatically on `pnpm install`. If you manage pnpm another way,
install the version in `packageManager` directly (`npm install -g pnpm@<version>`).

`.npmrc` sets `onlyBuiltDependencies` for `better-sqlite3` and `esbuild` (their native build scripts must be
allowed to run); `pnpm-workspace.yaml` mirrors this under `allowBuilds`.

## Workspace layout

```text
agentgate/
├── packages/
│   ├── protocol/   @agentgate/protocol — shared types (events, decisions, Control API contracts)
│   ├── policy/     @agentgate/policy   — policy schema, evaluation engine, secret detection/redaction
│   └── gateway/    @agentgate/gateway  — MCP stdio proxy, pipeline, audit storage, Control API, CLI
├── apps/
│   └── control-center/  @agentgate/control-center — React/Vite local UI
├── policies/       example policy YAML
├── examples/       example gateway config + the secret-exfiltration attack demo
└── docs/           this documentation
```

`packages/gateway` depends on `@agentgate/policy` and `@agentgate/protocol` (workspace:* — always the local
version); `apps/control-center` depends on `@agentgate/protocol` for shared types.

## Install / build / lint / test

```sh
pnpm install --frozen-lockfile   # exact versions from pnpm-lock.yaml — use this, not `pnpm install`, in CI/scripts
pnpm run build                   # tsc (protocol, policy, gateway) + tsc -b && vite build (control-center)
pnpm run lint                    # eslint . — one root flat config, type-aware, covers every package + examples/
pnpm run test                    # vitest run, in packages/policy and packages/gateway
```

`pnpm run lint` is a real gate — it exits non-zero on any lint error. It is deliberately **not** run recursively
per-package (`pnpm -r run lint`); the individual packages have no `lint` script of their own, by design — see
[`eslint.config.mjs`](../eslint.config.mjs) for the single shared configuration and its rationale for which
type-aware rules are on vs. off.

## Running the gateway and Control Center

```sh
# Terminal 1 — gateway (proxies to the official MCP filesystem server; requires network for npx to fetch it once)
node packages/gateway/dist/cli.js start examples/agentgate.yml

# Terminal 2 — Control Center in dev mode (hot reload)
pnpm run dev:control
```

The gateway prints the Control Center URL and a fresh auth token to stderr on every start. In dev mode, set the
token the UI should use via `localStorage.setItem('agentgate_token', '<token>')` in the browser console, or via a
`VITE_AGENTGATE_TOKEN` env var passed to `pnpm run dev:control` (see `apps/control-center/src/api.ts`).

To point an MCP client (e.g. Claude Code) at AgentGate instead of a downstream server directly, configure it to run
`node <repo>/packages/gateway/dist/cli.js start <repo>/examples/agentgate.yml` as its MCP server command.

## Using the attack demo safely

```sh
node examples/secret-exfiltration/demo.mjs
```

This is safe to run repeatedly and from any working directory: it writes its config, mock downstream server, and
SQLite database into a unique `os.tmpdir()` directory (never the repo root), closes every connection and child
process it opens, and removes the temp directory in a `finally` block on both success and failure. It uses a
well-known placeholder AWS key (`AKIAIOSFODNN7EXAMPLE`) — never a real credential.

## Database cleanup

Nothing under `packages/gateway/dist/**` or the repo root should ever contain a real `*.sqlite` file from normal
development — `.gitignore` excludes `agentgate.sqlite*` and generic `*.sqlite*` patterns. If you start the gateway
directly against `examples/agentgate.yml` (which uses `./agentgate.sqlite` as `db_path`), delete
`agentgate.sqlite`, `agentgate.sqlite-wal`, and `agentgate.sqlite-shm` from your working directory when you're
done — they are gitignored but will otherwise accumulate on disk.

## Adding a policy rule

1. Add the rule to `policies/agentgate.example.yml` (or your own policy file).
2. Validate it: `node packages/gateway/dist/cli.js validate <policy.yml>`.
3. If it needs a new **match field** (not just a new value for an existing one), add it to `PolicyRuleSchema` in
   `packages/policy/src/schema.ts` and to `ruleMatches()` in `packages/policy/src/engine.ts` — see
   [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md) for the existing fields and their exact matching semantics.
4. Add a case to `packages/policy/tests/engine.test.ts` covering both the match and the non-match.

## Adding tests

- `packages/policy/tests/*.test.ts` and `packages/gateway/tests/*.test.ts` use [Vitest](https://vitest.dev/)
  (`vitest run` / `vitest` for watch mode, both defined per-package).
- Gateway tests exercise the real `AuditStorage` against a throwaway SQLite file, the real `runPipeline()`, and the
  real Control API (Fastify `inject()`) — prefer testing through these real objects over mocking them.
- New source files should be covered by lint (the shared `eslint.config.mjs` already includes every package's
  `src` and `tests` directories via explicit `tsconfig.eslint.json`/`tsconfig.json` project references — see that
  file if a new package needs to be added to the workspace).

## Release gates

Before any change is considered done:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run lint
pnpm run test
node examples/secret-exfiltration/demo.mjs
git diff --check
```

All must pass genuinely — do not report a check as passing without having run it in this session. Durable
architectural decisions (new ADRs, superseding an existing one) belong in
[`docs/AI_DECISIONS.md`](AI_DECISIONS.md) — see [`CONTRIBUTING.md`](../CONTRIBUTING.md) for what counts as
"durable."

## Graphify (optional local tooling)

[Graphify](https://github.com/safishamsi/graphify) was verified against this codebase in Milestone 2 — see
[`docs/GRAPHIFY_VERIFICATION.md`](GRAPHIFY_VERIFICATION.md) for the full results. It is **not** required to build,
test, or contribute to AgentGate; it is a knowledge-graph tool some contributors may find useful for orienting in
the codebase before a change:

```sh
graphify update . --no-cluster        # rebuild the code graph (AST-only, no API key needed)
graphify cluster-only . --no-label    # regenerate GRAPH_REPORT.md and graph.html
graphify query "<question>"           # ask a question about the codebase
graphify path "<A>" "<B>" --undirected  # trace a relationship between two symbols
```

Its output (`graphify-out/`) is gitignored and regenerated on demand — it is never required to be present or
up to date to build or test AgentGate.
