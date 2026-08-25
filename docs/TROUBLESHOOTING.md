# Troubleshooting

## `pnpm install` fails on `better-sqlite3`

`better-sqlite3` builds a native addon. Make sure you have a supported Node.js version (20+) with prebuilt binaries
available for your platform, and that `.npmrc`'s `onlyBuiltDependencies` is allowed to run (pnpm will otherwise
skip the build script and the addon load will fail at runtime with a "cannot find module" error referencing a
`.node` file). On a fresh clone, `pnpm install --frozen-lockfile` should just work; if it doesn't, check for a
`node-gyp`/Python toolchain requirement printed in the install log — a prebuilt binary is used when available and
this is only needed as a fallback.

## Control Center shows "Gateway offline"

The dev server has no token yet, or the token doesn't match the currently running gateway (a fresh 32-byte random
token is generated **every** gateway start — an old token from a previous run will not work). Copy the token
printed to the gateway's stderr on startup and set it:

```js
localStorage.setItem('agentgate_token', '<token>')
```

then reload the page. If it's still offline, confirm the gateway process is actually running and check its stderr
for a startup error (e.g. a port already in use, or an invalid policy file).

## `EADDRINUSE` on port 4001 (or your configured `control_port`)

Another AgentGate instance (or something else) is already bound to that port. Stop it, or change `control_port` in
your gateway config YAML.

## `agentgate audit verify` reports a broken chain

This command checks **two** independent chains and prints a result for each: the audit chain
(`AuditStorage.verifyChain()`) and, since ADR-0010, the Safe Replay lineage chain (`verifyReplayChain()`). Either
line reporting a sequence gap, a hash mismatch, or missing data means that specific database table was modified
outside of AgentGate's own append-only write path, or is corrupted — the two chains are stored and verified
completely independently, so one can be valid while the other is broken. This is the intended behavior of a
tamper-evident log (see [`docs/THREAT_MODEL.md`](THREAT_MODEL.md#database-replacement-by-a-local-administrator)
for what this guarantee does and does not cover). If you deliberately want a fresh chain, delete the SQLite file
(and its `-wal`/`-shm` companions) and restart the gateway — a new database starts a new chain from record 1.

## `agentgate replay` (or the Control Center's Safe Replay card) says the decision changed, but I didn't touch the policy

Two common, non-bug causes:

1. **The source event's arguments were redacted.** Check the response's `source_arguments_redacted` field (CLI
   `--json`, the API response, or the Control Center card's redaction warning). AgentGate never stores raw
   arguments, so replay evaluates the stored `[REDACTED]` placeholder, not the original value — a
   `contains_secrets`-style rule that matched the original secret may no longer match the placeholder text. This
   is a representational limitation of replay, not a real policy change; it is always surfaced in the response's
   `limitations` array.
2. **You (or something else) edited the policy file more recently than you remember.** Replay always evaluates
   against whatever the current policy file on disk says *right now*, never a historical snapshot — check the
   response's `policy_digest` and compare it against `computePolicyDigest()` of the policy version you expected.
   There is no per-event policy snapshot in this milestone; see [ADR-0010](AI_DECISIONS.md).

## `agentgate replay <event-id>` fails with "No event found" or "unsupported historical event"

- **"No event found"**: the event id doesn't exist in the database `config.yml` points to — double check
  `db_path` in that config file matches the database you actually ran the original call against (find the id via
  the Control Center's Timeline, or `GET /api/events`).
- **"unsupported historical event"**: the stored event is missing a tool name, has malformed
  `normalized_arguments`, or is missing agent identity — this happens for events created before Safe Replay
  existed only if they somehow have a corrupted/legacy shape; a normally-created event (from `runPipeline()`)
  always has everything replay needs. Replay deliberately fails closed here rather than guessing — see
  [ADR-0010](AI_DECISIONS.md).

## A tool call fails with `[AgentGate] Tool Integrity: ...`

Your `tool_integrity.mode` is `explicit` or `tofu` and the tool is not currently trusted. The specific reason is
in the message:

- **"has not been scanned/reviewed"**: run `agentgate tools scan --config agentgate.yml`, then
  `agentgate tools status --config agentgate.yml` to see it, then `agentgate tools trust <id> --fingerprint
  <hash> --config agentgate.yml` (using the EXACT id/fingerprint from `status`) to accept it.
- **"is a new, unreviewed definition — quarantined pending explicit review"** / **"...definition changed since
  it was last trusted"**: the tool is `pending_review` or `drifted` — review it with
  `agentgate tools diff <id> --config agentgate.yml`, then `trust` or `reject`.
- **"was explicitly rejected and has not been re-reviewed"**: someone rejected this exact fingerprint. If the
  server's definition has genuinely changed again since, rescan (`agentgate tools scan`) — a NEW fingerprint
  opens a fresh review cycle; the SAME rejected fingerprint stays rejected.
- **"is no longer advertised by the downstream server"**: it was `removed` in the last scan. If it reappears in
  a later scan, it goes back to `pending_review` for a fresh look, even if its fingerprint matches an old
  trusted baseline (deliberate, conservative — a server disappearing and reappearing is itself worth a second
  look).

If this is unexpected and you don't want this defense right now, either add `tool_integrity: { mode: monitor }`
(reporting only, matches AgentGate's own default for a config omitting this section) or `mode: disabled` to your
config — see [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#tool-integrity).

## `agentgate tools trust`/`reject` fails with "Stale or unknown candidate"

The `--fingerprint` (and/or the candidate id) you passed no longer matches the CURRENT candidate on record for
that tool — either it drifted again since you last checked, or you copy-pasted an old value. Re-run
`agentgate tools status --config agentgate.yml --json` (or `tools diff <id>`) to get the CURRENT exact
id/fingerprint, then retry. This is deliberate fail-closed behavior (ADR-0012), not a bug — accepting a stale
fingerprint could otherwise silently trust a definition different from the one you actually reviewed.

## A downstream result comes back with `[REDACTED]` in it unexpectedly

The result matched one of `SECRET_PATTERNS` (`packages/policy/src/transformation.ts`) — the same conservative,
pattern-based detector used for inbound arguments now also scans downstream results (ADR-0009). Check the
event's `result_finding_count` (Control Center Event Detail, or the `audit_events` table directly) — a nonzero
count with `result_redacted: true` confirms this is output security, not a bug. This is usually a false positive
on a long token-shaped or password-shaped string; see
[`docs/DEVELOPMENT.md`](DEVELOPMENT.md#diagnosing-an-unexpectedly-redacted-result) for what to do about it. There
is no per-tool exception list in this milestone.

## A downstream result comes back entirely blocked

Only happens under `output_security.mode: block`. Either a secret was detected, or a `max_depth`/`max_text_bytes`
limit prevented full inspection of otherwise-inspectable content (treated as unsafe in `block` mode, not silently
allowed through). See [`docs/DEVELOPMENT.md`](DEVELOPMENT.md#diagnosing-a-blocked-result). Switching to
`mode: redact` (the default) trades this hard stop for in-place redaction.

## An image/audio result seems to leak something and wasn't redacted

Expected, and documented — `image`/`audio` content and embedded-resource `blob` data are base64 binary and are
**never** scanned in either `output_security` mode, in this milestone. See
[Output security](../README.md#output-security) and
[`docs/THREAT_MODEL.md`](THREAT_MODEL.md#malicious-downstream-mcp-server). This is a known, accepted limitation,
not a misconfiguration.

## The example gateway config can't reach the downstream server

`examples/agentgate.yml` launches `npx -y @modelcontextprotocol/server-filesystem /tmp` as its downstream MCP
server. This requires network access the first time (to fetch the package) and a writable `/tmp`
(Windows: adjust the `args` in your own copy of the config to a real local directory — `/tmp` is POSIX-specific).

## Policy validation fails with a schema error

Run `node packages/gateway/dist/cli.js validate <your-policy.yml>` and read the reported error path/message — it
comes directly from Zod's schema validation (`packages/policy/src/schema.ts`) and names the exact field and
constraint that failed. Common causes: `version` is not `1`, a `decision` value is misspelled (must be exactly
`allow`, `deny`, `require_approval`, or `allow_with_transform`), or `approval_ttl_seconds` is outside 10–3600.
See [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md) for the full field reference. For a broader first-run
problem, `agentgate config validate <config.yml>` checks the full gateway config (not just a bare policy file),
and `agentgate doctor <config.yml>` diagnoses everything else — see the next section.

## Diagnosing setup with `agentgate doctor`

`agentgate doctor [config.yml] [--json]` is read-only — it never executes a downstream server, never opens a
network connection, and never modifies your configuration or database. Each check reports a stable id and one
of `PASS`/`WARN`/`FAIL`/`SKIP`:

| Check id | Meaning when not PASS |
|---|---|
| `node_version` | `FAIL`: your Node.js is below 20 — install a newer version. |
| `config_exists` / `policy_valid` | `FAIL`: the config or its referenced policy is missing or invalid — the message names the exact problem; run `agentgate config validate` for the full detail. |
| `db_writable` | `FAIL`: the database's parent directory isn't writable — fix its permissions or change `db_path`. |
| `audit_chain` | `WARN`: the database exists but hasn't been migrated to the latest schema yet — run `agentgate start` once (it migrates automatically), then re-run doctor. `FAIL`: the chain failed verification — see [`agentgate audit verify` reports a broken chain](#agentgate-audit-verify-reports-a-broken-chain) above. `SKIP`: no database exists yet — expected before the first `agentgate start`. |
| `downstream_commands` | `WARN`: a configured server's `command` still uses the `agentgate init`-generated placeholder, or doesn't resolve on `PATH` — doctor only checks resolution, it never executes the command. |
| `ports_available` | `WARN`: `gateway_port` or `control_port` is already in use — often just an AgentGate instance you already have running; see [`EADDRINUSE`](#eaddrinuse-on-port-4001-or-your-configured-control_port) below. |
| `control_center` | `WARN`: Control Center isn't built yet (`pnpm run build` or `pnpm run dev:control`). `SKIP`: not running from a source checkout — the Control Center isn't bundled with an installed gateway package (see [`docs/DEVELOPMENT.md`](DEVELOPMENT.md#installability)). |
| `stale_artifacts` | `WARN`: an orphaned `.sqlite-wal`/`.sqlite-shm` file exists with no matching database — safe to delete manually. |
| `client_integration` | Only runs when you pass `--client-config <path>`; `FAIL` means that file isn't valid JSON or has no `mcpServers` object. |

Add `--json` for machine-readable output suitable for scripting.

## `pnpm run lint` fails after adding a new source file

The shared root `eslint.config.mjs` resolves TypeScript project info from an explicit list of `tsconfig.json` /
`tsconfig.eslint.json` files per package (see [`docs/DEVELOPMENT.md`](DEVELOPMENT.md#install--build--lint--test)).
A new file inside an existing package's `src`/`tests` directory is picked up automatically; a genuinely new
top-level package needs its `tsconfig.json` (and, if it has a `tests/` directory outside its build `include`, a
`tsconfig.eslint.json`) added to the `project` array in `eslint.config.mjs`.

## `agentgate init` says files already exist

`init` never overwrites an existing `agentgate.yml`/`agentgate.policy.yml` unless you pass `--force`. Either
choose a different (or new) target directory, or re-run with `--force` if you genuinely want to regenerate them
— this discards any edits already made to those two files.

## `agentgate integrate ... --apply` and backup files

`--apply <path>` always creates a `<path>.backup-<ISO-timestamp>` copy of the target file before writing, and
never deletes it for you. If you don't need it anymore, delete it manually. Run with `--dry-run` first if you
want to preview the exact resulting file before anything is written.

## Windows-specific: paths in policy files

Always write `paths`/`${PROJECT_ROOT}` patterns with forward slashes, even on Windows — `normalizePath()` converts
backslashes to forward slashes before matching, so a pattern written with backslashes will never match a
normalized path. See [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#path-semantics).

## Still stuck?

Check [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for how the piece you're debugging fits into the whole pipeline, or
open an issue with your platform, Node version, and the exact command + output — see
[`.github/ISSUE_TEMPLATE/bug_report.yml`](../.github/ISSUE_TEMPLATE/bug_report.yml).
