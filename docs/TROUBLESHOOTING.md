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

This means `AuditStorage.verifyChain()` found a sequence gap, a hash mismatch, or missing event data — i.e. the
database was modified outside of AgentGate's own append-only write path, or is corrupted. This is the intended
behavior of a tamper-evident log (see [`docs/THREAT_MODEL.md`](THREAT_MODEL.md#database-replacement-by-a-local-administrator)
for what this guarantee does and does not cover). If you deliberately want a fresh chain, delete the SQLite file
(and its `-wal`/`-shm` companions) and restart the gateway — a new database starts a new chain from record 1.

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
See [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md) for the full field reference.

## `pnpm run lint` fails after adding a new source file

The shared root `eslint.config.mjs` resolves TypeScript project info from an explicit list of `tsconfig.json` /
`tsconfig.eslint.json` files per package (see [`docs/DEVELOPMENT.md`](DEVELOPMENT.md#install--build--lint--test)).
A new file inside an existing package's `src`/`tests` directory is picked up automatically; a genuinely new
top-level package needs its `tsconfig.json` (and, if it has a `tests/` directory outside its build `include`, a
`tsconfig.eslint.json`) added to the `project` array in `eslint.config.mjs`.

## Windows-specific: paths in policy files

Always write `paths`/`${PROJECT_ROOT}` patterns with forward slashes, even on Windows — `normalizePath()` converts
backslashes to forward slashes before matching, so a pattern written with backslashes will never match a
normalized path. See [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#path-semantics).

## Still stuck?

Check [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for how the piece you're debugging fits into the whole pipeline, or
open an issue with your platform, Node version, and the exact command + output — see
[`.github/ISSUE_TEMPLATE/bug_report.yml`](../.github/ISSUE_TEMPLATE/bug_report.yml).
