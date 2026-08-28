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
pnpm run test                    # vitest run, in packages/policy, packages/gateway, and apps/control-center
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

## Using the demos safely

```sh
node examples/secret-exfiltration/demo.mjs        # attack demo, inbound: secret in tool-call arguments
node examples/downstream-secret-result/demo.mjs   # attack demo, outbound: secret in a downstream result AND error message
node examples/policy-drift-replay/demo.mjs        # Safe Replay demo: policy drift detection, no execution (ADR-0010)
node examples/tool-rug-pull/demo.mjs              # Tool Integrity demo: rug-pull detected, quarantined, and blocked (ADR-0012)
node examples/context-poisoning/demo.mjs          # Context Guard demo: cross-tool prompt-injection chain blocked (ADR-0013)
```

All five are safe to run repeatedly and from any working directory: each writes its config, mock/fixture
downstream server, and SQLite database into its own unique `os.tmpdir()` directory (never the repo root), closes
every connection and child process it opens, and removes the temp directory in a `finally` block on both success
and failure. All five use only well-known placeholder credentials (`AKIAIOSFODNN7EXAMPLE`) — never a real one.
The third, fourth, and fifth demos are not attack demos in the "malicious input blocked" sense alone: the third
proves Safe Replay's policy-drift and no-execution behavior against a real historical event; the fourth proves a
downstream server's tool DEFINITION (not a single malicious call) changing after being trusted is detected,
quarantined, and blocked before the downstream server is contacted again; the fifth proves a cross-tool SEQUENCE
of individually-legal-looking calls is blocked/gated from observed gateway history alone, with no LLM involved
anywhere in the script. Each demo's own `*_INJECT_FAILURE` env var (`RUG_PULL_INJECT_FAILURE`,
`CONTEXT_POISONING_INJECT_FAILURE`, etc. — see the script itself and its matching `*-demo-cleanup.test.ts`) proves
that demo's `finally` cleanup runs on a real injected mid-run failure, not merely inspected by eye. Never set any
of these env vars in a normal run — they are zero-effect no-ops unless explicitly set.

## Configuring output security

`output_security` (see [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#output-security-gateway-level) for the
full reference) is a gateway config block, not a policy field:

```yaml
output_security:
  mode: redact   # or "block"
```

Omitting it entirely uses the default (`mode: redact`, 8-level depth, 1MB per-string scan limit). Changing it
requires no rebuild — `loadGatewayConfig()` re-reads and re-validates the YAML on every `agentgate start`.

### Diagnosing an unexpectedly redacted result

If a tool result you expected to see verbatim came back with `[REDACTED]` somewhere in it, the text matched one
of `packages/policy/src/transformation.ts`'s `SECRET_PATTERNS` (the same conservative set used for inbound
arguments — see [Secret detection behavior and limitations](POLICY_REFERENCE.md#secret-detection-behavior-and-limitations)).
Check the event in the Control Center's Event Detail view (or `agentgate_events.result_finding_count` /
`result_redacted` directly in SQLite) — the false positive is almost always a long token-shaped or
password-shaped string that isn't actually a secret. There is no per-tool exception list in this milestone; the
only mitigations are accepting the redaction or, if you control the pattern list, tightening the specific
over-broad pattern (see [Adding tests](#adding-tests) below for how to do that safely).

### Diagnosing a blocked result

A `result_blocked: true` event under `output_security.mode: block` means either a secret was detected, or a
`max_depth`/`max_text_bytes` limit prevented the sanitizer from fully inspecting otherwise-inspectable text/
structured content (truncated content is treated as "not proven safe," not silently passed through, in `block`
mode). Raise `max_depth`/`max_text_bytes` if the result is legitimately large/deeply nested and you trust the
downstream server, or switch to `mode: redact` if occasional false-positive blocking is worse for your workflow
than occasional over-redaction.

### Opaque binary content

Image, audio, and embedded-resource `blob` (base64) content is **never** scanned in either mode — see
[Output security](../README.md#output-security) for why. If your downstream server returns secrets embedded in
binary payloads, output security does not protect against that today; this is a documented limitation, not a bug.

## Database cleanup

Nothing under `packages/gateway/dist/**` or the repo root should ever contain a real `*.sqlite` file from normal
development — `.gitignore` excludes `agentgate.sqlite*` and generic `*.sqlite*` patterns. If you start the gateway
directly against `examples/agentgate.yml` (which uses `./agentgate.sqlite` as `db_path`), delete
`agentgate.sqlite`, `agentgate.sqlite-wal`, and `agentgate.sqlite-shm` from your working directory when you're
done — they are gitignored but will otherwise accumulate on disk.

## Migration and audit verification guidance

Opening an existing database with a newer `AuditStorage` automatically runs any migrations it hasn't seen yet
(`storage.ts`'s `MIGRATIONS` array, resumed from the database's own `schema_version` table) — there is no
separate migration command to run. After starting the gateway once against an older database, confirm the chain
is still intact:

```sh
node packages/gateway/dist/cli.js audit verify <config.yml>
```

A database created before Milestone 3 has `canonical_payload_version: '1'` lifecycle records; new records
written after the upgrade are `'2'` (adds the result/error sanitization fields to the hash). `verifyChain()`
reconstructs each record's hash using *that record's own* stored version, so a chain spanning the upgrade
verifies correctly — see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#audit-lifecycle-data-model). If you're adding a
new hash-chained field yourself, follow the same pattern: bump `canonical_payload_version` for new writes, never
change what an existing version number means, and add the new migration as the **last** entry in `MIGRATIONS`
(inserting one earlier renumbers every migration after it and causes already-upgraded databases to skip it).

## Using Safe Replay locally

`agentgate replay <event-id> [config.yml] [--json]` (ADR-0010) re-evaluates one historical event from the
gateway's own audit database against whatever policy `config.yml` currently points to — it needs a running or
previously-run gateway with at least one recorded event, not a fresh checkout:

```sh
# Find an event id — either from the Control Center's Timeline/Event Detail page, or:
node -e "const {AuditStorage}=require('./packages/gateway/dist/storage.js'); const s=new AuditStorage('./agentgate.sqlite'); console.log(s.listEvents({limit:5}))"

node packages/gateway/dist/cli.js replay <event-id> examples/agentgate.yml --json
```

- Edit the policy file `config.yml` points to, then re-run the same command — no gateway restart is required;
  both the CLI and the Control API load the policy file fresh on every replay.
- `original.decision_type` reflects what was actually recorded for that event at the time; `current.decision_type`
  reflects the policy loaded just now. A `null` in `original` means the source event never had a policy decision
  recorded (e.g. it failed before evaluation) — this is reported explicitly, not treated as an error.
- If `source_arguments_redacted: true` appears in the output, treat any reported change with a `contains_secrets`
  rule involved as potentially just redaction-representation drift, not necessarily a real policy change — see
  [ADR-0010](AI_DECISIONS.md) and [`docs/THREAT_MODEL.md`](THREAT_MODEL.md#safe-replay-adr-0010).
- Every replay call — from the CLI, the Control API, or the Control Center's Safe Replay card — persists a new
  row in the `replay_evaluations` table; running replay repeatedly against the same event is expected and simply
  grows that event's lineage (`GET /api/events/:id/replays` lists it), never overwrites a prior evaluation.
- There is intentionally no execution flag anywhere in this command, the API, or the UI — do not add one. See
  the security invariant in [ADR-0010](AI_DECISIONS.md).

## Using Tool Integrity locally

`agentgate tools <scan|status|diff|trust|reject|history> [--config <path>]` (ADR-0012) operates against the same
database a running (or previously-run) gateway uses — you do not need to stop the gateway first; `scan`/`trust`/
`reject` all take effect on the live gateway's own enforcement immediately (registry state is re-read fresh on
every `tools/list`/`tools/call`), without a restart.

```sh
# Add tool_integrity: { mode: explicit } to your config first (agentgate init already does this for new projects).
node packages/gateway/dist/cli.js tools scan --config agentgate.yml       # rescan now — never calls a tool
node packages/gateway/dist/cli.js tools status --config agentgate.yml --json
node packages/gateway/dist/cli.js tools diff <candidate-id> --config agentgate.yml
node packages/gateway/dist/cli.js tools trust  <candidate-id> --fingerprint <hash> --config agentgate.yml
node packages/gateway/dist/cli.js tools reject <candidate-id> --fingerprint <hash> --config agentgate.yml
node packages/gateway/dist/cli.js tools history --config agentgate.yml
```

- `<candidate-id>` and `--fingerprint <hash>` both come from `tools status`/`tools diff` output — never type these
  by hand from memory; they must be the CURRENT values on record, or `trust`/`reject` fails closed with a
  "stale or unknown candidate" error rather than silently applying to whatever the current candidate happens to
  be.
- `scan`/`status`/`diff`/`history` never call a tool and never mutate trust state — only `trust`/`reject` do.
- Try `node examples/tool-rug-pull/demo.mjs` for a full, real, end-to-end walkthrough (trust → rug-pull →
  rescan → diff → block → reject → distinct benign update trusted).

## Using Context Guard locally

`agentgate context <status|history|explain|reset|verify> [--config <path>]` (ADR-0013) operates against the same
database a running (or previously-run) gateway uses — every subcommand except `reset` is strictly read-only and
never starts a downstream server, discovers tools, or executes anything.

```sh
# agentgate init already generates context_guard: { mode: enforce } for new projects (ADR-0014); add real
# tools: {...} / rules: [...] for it to enforce anything — see docs/POLICY_REFERENCE.md#context-guard.
node packages/gateway/dist/cli.js context status --config agentgate.yml --json
node packages/gateway/dist/cli.js context history <context-id> --config agentgate.yml
node packages/gateway/dist/cli.js context explain <context-id> --config agentgate.yml
node packages/gateway/dist/cli.js context reset   <context-id> --revision <n> --reason "<text>" --config agentgate.yml
node packages/gateway/dist/cli.js context verify  --config agentgate.yml
```

- `<context-id>` and `--revision <n>` both come from `context status`/`context explain` output — never type these
  by hand from memory; `reset` requires the EXACT current revision or fails closed with a stale-revision error.
- Try `node examples/context-poisoning/demo.mjs` for a full, real, end-to-end walkthrough of both the deny and
  require-approval paths, including the CLI evidence gathering (`context status`/`explain`/`history`/`verify`).

### Adding a new policy-owned label or effect safely

1. Add the tool's `effects`/`adds_on_result` to your `context_guard.tools.<name>` config block — never to code.
   There is no built-in taxonomy beyond `BUILTIN_CONTEXT_LABELS`/`BUILTIN_EFFECT_LABELS`
   (`packages/gateway/src/config/registry.ts`); a genuinely new *kind* of label (not just a new tool using an
   existing one) goes in `context_guard.labels` in your own config, never as a code change, unless you are adding
   to the built-in vocabulary itself (rare — most new labels should be operator-config, not code).
2. If you ARE extending the built-in vocabulary in code, add the string to `BUILTIN_CONTEXT_LABELS` (a source
   label — what a *result* may have exposed the agent to) or `BUILTIN_EFFECT_LABELS` (an effect label — what a
   *call itself* does), never both, and update the label-vocabulary table in
   [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#context-guard) in the same change.
3. **Transition timing is not configurable — it is a fixed pipeline invariant.** `adds_on_result` labels are
   appended only when `finalStatus === 'SUCCEEDED' && !resultBlocked` (`pipeline.ts` step 8) — never add a code
   path that appends labels on a DENY/CANCEL/EXPIRE/FAIL/blocked-result outcome; a redacted-but-delivered result
   is the one documented case that still adds labels (content beyond the redacted pattern still reached the
   agent). Add a case to `packages/gateway/tests/context-guard-interactions.test.ts` for any new outcome
   combination you touch.
4. Add a case to `packages/gateway/tests/context-guard-rules.test.ts` for a new `when` operator, and to
   `packages/gateway/tests/docs-context-guard-examples.test.ts` if you change a *published* config example.

### Writing a context migration test

Follow the exact same pattern `context-guard-storage-migration.test.ts` and
`tool-integrity-storage-migration.test.ts` already use: pin an EXACT NAMED migration version from
`MIGRATION_VERSIONS` (`storage.ts`) — e.g. `MIGRATION_VERSIONS.CONTEXT_GUARD` — never assume "the highest recorded
version" identifies any one specific migration, since a later milestone will add more entries to `MIGRATIONS`. If
you add a new hash-chained field to `context_events`, follow the same rule every other chain in this project
follows: bump a `canonical_payload_version`-style version marker for new writes, never change what an existing
version means, and append the new migration as the LAST entry in `MIGRATIONS` (inserting one earlier silently
renumbers every migration after it and causes an already-upgraded database to skip the new one entirely).

### Avoiding raw content in Context Guard state

`context_events`/`context_state` must never gain a column or code path that stores raw tool arguments, raw tool
results, or any prompt-injection text — only label names (bounded, policy vocabulary), rule ids, safe/bounded
`reason` strings, and already-redacted `source_event_id` linkage. If you add a new field, ask whether it could
ever contain untrusted free text; if so, either don't store it, or route it through the same bounded/sanitized
pattern the reviewer/reason fields already use, and add a hostile-content test (`context-guard-cli.test.ts`'s
ANSI-stripping cases, or `ContextGuard.test.tsx`'s hostile-content describe block, whichever surface you touched).

### Preserving exact approval binding

If you touch `context-guard/enforcement.ts`'s `checkApprovalContextValid()` or `pipeline.ts`'s approval-creation
call site, preserve the exact contract: every binding field (`context_id`, `context_revision`, `argument_digest`,
`tool_fingerprint`, `contextual_rule_id`) is read FRESH at consumption time, never reused from creation time, and
a `null` field skips only that specific check rather than short-circuiting the others. Add a case to
`packages/gateway/tests/context-guard-fingerprint-binding.test.ts` (pipeline-level) or
`context-guard-fingerprint-gateway.test.ts` (real gateway) for any new binding/revalidation path.

### Adding a new SSE event without duplicates or unsafe payloads

Context Guard's `context_event` frames reuse the exact same `subscribers` array / `ctx.emitEvent` bus
`audit_event`/`Approval` traffic already used — never create a second, parallel event stream. Publish a NEW event
type from exactly one call site (mirror `pipeline.ts` step 4.5/8's `call_evaluated`/`label_added` emission, or
`transport/stdio.ts`'s `context_closed`/`context_expired` publication, which is guarded against re-publishing on
the idempotent no-op close path), and only after the corresponding storage write has already completed — a
subscriber must never observe an event for a state that isn't yet durably persisted. Never widen a payload beyond
what `context_events` itself stores (see "Avoiding raw content" above) — the SSE payload and the stored row
should be the same safe, bounded shape.

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
- Gateway pipeline/output-security integration tests spawn a **real** fixture downstream MCP server
  (`packages/gateway/tests/fixtures/fixture-downstream-server.mjs`) over real stdio, rather than mocking
  `executeDownstream()` — add a new tool case there if you need another downstream behavior to test against.
- **Adding a synthetic-secret regression test.** Use an unmistakably fake credential (never a real-looking one
  reused from production) and reuse an existing allowlisted literal from
  `packages/policy/tests/transformation.test.ts`/`output-sanitization.test.ts` where possible. If you must add a
  new one, add the exact literal (not a file or directory exclusion) to `.github/workflows/security.yml`'s
  tracked-file secret-scan `ALLOWED` pattern — excluding a whole file would let a real credential slip through
  the same test file undetected. Never weaken `SECRET_PATTERNS` itself, disable a passing secret-detection test,
  or add a blanket suppression to make a new test pass.

## Installability

Verified this milestone with real, automated checks — see `scripts/verify-packed-install.mjs`:

- All three publishable packages (`@agentgate/protocol`, `@agentgate/policy`, `@agentgate/gateway`) are
  `"private": true`, so `npm publish` is blocked outright — no accidental publication is possible, and none has
  happened. There is no published npm package; do not write documentation implying `npm install agentgate` or
  `npx agentgate` work — they do not.
- Each package now has a `"files": ["dist"]` field, so `pnpm pack` produces a tarball containing only compiled
  output (no `src/`, `tests/`, or `tsconfig*.json`).
- Installing the **gateway tarball alone** into an external project fails with a real `npm error 404` for
  `@agentgate/policy`/`@agentgate/protocol` — `pnpm pack` rewrites their `workspace:*` dependency protocol to a
  bare semver that has never been published anywhere. This is a genuine, verified limitation, not a
  hypothetical one.
- Installing **all three tarballs together** in one `npm install a.tgz b.tgz c.tgz` command works — npm
  resolves each workspace sibling from the other tarball given in the same command. `scripts/
  verify-packed-install.mjs` proves this end-to-end (pack, install into a fresh temp consumer, run the
  installed CLI's help/`--version`/`smoke-test`) and runs in both CI jobs.
- The Control Center is **not** bundled into the gateway package at all — it is a separate Vite app
  (`apps/control-center`) with its own `pnpm run build`/`pnpm run dev:control`. An installed
  `@agentgate/gateway` package gives you the CLI and backend only; `agentgate doctor`'s `control_center` check
  reports this explicitly (`SKIP` outside a source checkout, `PASS`/`WARN` based on build status inside one).

## Onboarding CLI

`agentgate init`, `config validate`, `doctor`, `integrate`, and `smoke-test` are documented in detail in the
[README](../README.md#five-minute-quickstart) and [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md). A few
implementation notes for contributors:

- `config validate` and `doctor` both call the exact same `loadGatewayConfig()`/`loadPolicyFile()` production
  loaders `agentgate start` uses (`packages/gateway/src/onboarding/configValidate.ts`) — never add a second,
  parallel validation implementation for either command; extend the shared loaders instead if a new check is
  needed.
- `doctor`'s audit-chain check never opens an existing database via `AuditStorage` unless
  `readSchemaVersionReadOnly()` (`packages/gateway/src/storage.ts`, opened with `better-sqlite3`'s
  `readonly: true`) has already confirmed the schema is fully migrated — `AuditStorage`'s constructor applies
  any pending migration unconditionally on open, which would otherwise make a supposedly read-only diagnostic
  command silently write to the user's database.
- `smoke-test`'s fixture downstream server (`packages/gateway/src/onboarding/smokeFixtureServer.mjs`) is
  deliberately plain JavaScript, not compiled TypeScript, and copied into `dist/onboarding/` by a small postbuild
  step (`packages/gateway/scripts/copy-assets.mjs`, wired into `pnpm run build` as `tsc && node
  scripts/copy-assets.mjs`) — this is what lets `agentgate smoke-test` work identically whether AgentGate is
  running from `src/` (tests, via Vitest) or from an installed package (only `dist/` ships). If you add another
  non-TypeScript runtime asset under `src/`, add it to `ASSETS` in that script too, or it will silently be
  missing from both the compiled output and any packed tarball.
- `integrate`'s default behavior only ever prints or writes a **new** file; its `--apply` opt-in
  (`packages/gateway/src/onboarding/integrate.ts`, `applyIntegration()`) always backs up the target file first,
  writes atomically, and merges rather than replaces — test any change to it against a temp fixture file, never
  against a real client config.
- **Rebuilding after removing/renaming a file under `src/`**: `tsc` does not delete stale output for a source
  file that no longer exists — if you rename or remove a `.ts`/asset file, delete the corresponding stale file
  under `dist/` yourself before your next `pnpm run build`, or it will linger (harmless for correctness, since
  nothing references it, but confusing to find later).

## Release gates

Before any change is considered done:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run lint
pnpm run test
node examples/secret-exfiltration/demo.mjs
node examples/downstream-secret-result/demo.mjs
node examples/policy-drift-replay/demo.mjs
node examples/tool-rug-pull/demo.mjs
node examples/context-poisoning/demo.mjs
node scripts/verify-packed-install.mjs
node packages/gateway/dist/cli.js smoke-test
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
