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

## The Context Guard page/CLI says "not configured" (404)

Your gateway config has no `context_guard` section, or it's present but the Control API route returned 404 —
Context Guard routes are gated behind the same optional-config pattern as Tool Integrity: absent config means the
route simply doesn't exist (404), not an error. Add a `context_guard:` block to your `agentgate.yml` — see
[`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#context-guard) for the exact schema — and restart the gateway.
An omitted `context_guard` section is NOT the same as `mode: disabled`: it defaults to `mode: monitor` internally
(context tracking happens, but nothing blocks), it's specifically the Control API/CLI/UI surfaces that 404 when
the config key is missing entirely, as a UI-availability signal, not an enforcement signal.

## A tool call is denied or requires approval because of Context Guard

Look at the block/pending message and, if you have Context Guard `enforce`d, run
`agentgate context explain <context-id> --config agentgate.yml` — it reports the currently active labels, what
established each one, and the latest stored contextual decision (never a fabricated one). Common, non-bug causes:

- **Labels you didn't expect are active.** Some earlier call in this same session added them — `context explain`
  names the exact tool and (where available) the linked audit event. Remember labels only ever accumulate within
  one context; they never clear themselves.
- **A contextual rule you forgot about is matching.** Check `context_guard.rules` in your config against the
  `rule_id` reported in the block message / `context explain` output.
- **You expected `monitor` mode (reporting only) but the call was actually blocked.** Check `context_guard.mode`
  — only `enforce` mode actually blocks or gates calls; `monitor` records what *would* have happened but never
  interferes. If you don't want blocking behavior yet, set `mode: monitor` (or omit the section entirely, which
  defaults to `monitor`).

If this is unexpected and you don't want this defense right now, set `context_guard: { mode: monitor }`
(reporting only — the same default as an omitted section) or `mode: disabled` — see
[`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#context-guard).

## Missing labels — a tool's risky result never seems to add a context label

Check that the tool name in `context_guard.tools.<name>.adds_on_result` EXACTLY matches the tool name as called
(the same name-matching AgentGate uses everywhere else — no fuzzy matching). Also confirm the call actually
`SUCCEEDED` with a non-blocked result: a denied, cancelled, expired, failed, or fully output-security-blocked
call never adds labels, by design (ADR-0013) — nothing the label would describe actually reached the agent in
those cases. A redacted-but-still-delivered result DOES still add its configured labels. If every label in
`adds_on_result` was already active before the call, this is correctly a no-op (no new history event) — check
`context history <context-id>` to confirm whether the label was already present from an earlier call.

## `agentgate context reset` fails with a stale-revision error (409)

The `--revision` you passed no longer matches the context's CURRENT revision — either it accumulated more risk
(a new label was added) since you last checked, or you copy-pasted an old value. Re-run
`agentgate context status --config agentgate.yml --json` (or `context explain <id>`) to get the CURRENT exact
revision, review the context's current state again, then retry. This is deliberate fail-closed behavior
(ADR-0013), not a bug — accepting a stale revision could otherwise silently reset a context whose risk state you
never actually reviewed.

## A contextual (require_approval) approval fails even after a human approved it

This is expected, documented behavior, not a bug: `checkApprovalContextValid()` re-validates the approval's exact
binding (context revision, redacted-argument digest, and — where a trusted Tool Integrity definition exists —
tool fingerprint) *fresh*, immediately before execution, even though the approval record itself already shows
`APPROVED`. If the context accumulated more risk, the arguments changed, or the tool's trusted definition drifted
or was quarantined in the window between approval creation and the human's decision, execution is refused and a
FRESH approval (bound to current state) is required — see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#context-guard-adr-0013) for the exact mechanism. There is no way to
force an approval through this revalidation.

## A contextual approval's tool-fingerprint binding is `null` — is that a bug?

No — a `null` `tool_fingerprint` on a contextual approval means no trusted Tool Integrity definition existed for
that tool at the moment the approval was created (the tool was never scanned, is still `pending_review`, or Tool
Integrity is `disabled`). This is a legitimate "not bound" state, identical in kind to a pre-Milestone-7
approval's `null` context-binding fields — a binding that was never made cannot be violated, so
`checkApprovalContextValid()` simply skips that one sub-check while still enforcing the context-revision and
argument-digest checks. If you want the fingerprint check to actually apply, run Tool Integrity in `explicit`/
`tofu` mode and trust the tool first.

## `agentgate context verify` reports a broken chain, or a context "integrity failure" shows in the Control Center

Same tamper-*evidence*-not-tamper-*proof* model as `agentgate audit verify` (see
[`agentgate audit verify` reports a broken chain](#agentgate-audit-verify-reports-a-broken-chain) above) — a
sequence gap, hash mismatch, or missing data in `context_events` means that table was modified outside
AgentGate's own append-only write path, or is corrupted. The context chain and the audit chain are stored and
verified completely independently; one can be broken while the other is valid. There is no way to "repair" a
broken chain — if you deliberately want a fresh one, delete the SQLite file (and its `-wal`/`-shm` companions)
and restart the gateway.

## A context stays `active` after the client seems to have disconnected

Three independent mechanisms close a context: the MCP SDK's own `server.onclose`/`onerror` (transport close/
error), a direct `process.stdin.on('end', ...)` listener (added specifically because the installed SDK's
`StdioServerTransport` never listens for `'end'` itself, so a graceful `stdin.end()` disconnect would otherwise
leave the context active until a slower escalation), and the gateway process's own SIGINT/SIGTERM handler. All
three call the same idempotent `closeOrExpireContext()`, so whichever fires first performs the real transition.
If a context still shows `active` well after you believe the client disconnected, the client's own transport
likely never actually closed at the OS/pipe level (e.g. it crashed in a way that left the pipe open, or is still
technically connected) — check whether the gateway's OS process itself is still running. There is no manual
"force close" command; `context reset` is the only mutating command, and resetting an otherwise-still-active
context does not close it — it transitions it to `reset`, which similarly stops it from accumulating further
labels.

## No context continuity across a gateway restart or reconnect

Expected, documented behavior, not a bug (ADR-0013): every new gateway process launch creates a brand-new,
empty-label context. Context Guard cannot detect an attack sequence that spans a restart — this is a stated,
permanent limitation, not a missing feature to file a bug against. See
[`docs/THREAT_MODEL.md`](THREAT_MODEL.md#context-guard-cross-tool-escalation-defense-adr-0013).

## `agentgate context <subcommand>` uses the wrong database or config

Every `agentgate context` subcommand defaults to `./agentgate.yml` and reads `db_path` from whatever config
`--config <path>` actually points to — same resolution rule as every other AgentGate CLI command. If you have
multiple projects/databases, always pass `--config <path>` explicitly rather than relying on your current working
directory matching the config you mean.

## Context Guard live updates in the Control Center seem to stop working after a reconnect

The Context Guard page's live indicator shows connection state, and it always treats an incoming `context_event`
SSE frame as a "refetch current state now" signal rather than trying to reconstruct history from the stream
itself — a reconnected subscriber does NOT receive events that were published while it was disconnected (this is
the same pre-existing, unmodified event-bus behavior `audit_event`/`Approval` traffic already had before this
milestone — there is no historical replay to a fresh subscriber). If the page looks stale after a reconnect,
reload it — the initial REST fetch on load is always the authoritative source of current state, independent of
whatever the SSE stream did or didn't deliver in the meantime.

## Does resetting a Context Guard context clear what the agent/model remembers?

**No — never.** `agentgate context reset` (or the Control Center's reset control) is entirely local, gateway-side
state. It clears AgentGate's own accumulated risk labels going forward and has **no effect whatsoever** on
anything the upstream LLM or MCP client itself remembers — its own conversation history, cached tool results, or
reasoning it has already produced. If you need the agent to actually "forget" something, that has to happen in
the agent/client itself (e.g. starting a new conversation) — resetting AgentGate's context is a completely
separate, local operation from that. See [ADR-0013](AI_DECISIONS.md) and
[`docs/THREAT_MODEL.md`](THREAT_MODEL.md#context-guard-cross-tool-escalation-defense-adr-0013).

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
