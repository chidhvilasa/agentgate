# Threat Model

This document describes what AgentGate protects, from whom, and — just as importantly — what it does **not**
protect against in its current form. It is written against the implementation in this repository, not an
aspirational design. See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the components referenced below.

## Protected assets

- **Credentials and secrets** that might appear in tool-call arguments or results (API keys, tokens, passwords,
  private key material, database connection strings).
- **Files and resources outside an agent's intended scope** (via path-traversal or overly broad tool access).
- **Integrity of the audit trail** — a record of what an agent tried to do and what AgentGate decided, resistant to
  silent local tampering.
- **The local Control API and Control Center** — should not be reachable or usable by an arbitrary web page or
  network peer.

## Trusted and untrusted actors

| Actor | Trust level | Why |
|---|---|---|
| The human operator running the gateway | Trusted | Controls the policy file and the machine AgentGate runs on. |
| The policy YAML file on disk | Trusted input | Read from local disk; not attacker-controlled in the threat model AgentGate targets. A malicious policy file implies the operator's machine is already compromised. |
| The MCP client's *self-reported* identity (`declared_name`, `declared_version`) | **Untrusted** | Never used in authorization decisions; `verified_identity` is hardcoded `false` (`packages/protocol/src/events.ts`). |
| Tool-call arguments from the MCP client | **Untrusted** | May contain injected instructions, secrets, or path-traversal attempts; this is the primary thing AgentGate evaluates. |
| The downstream MCP server | **Untrusted** | Could be malicious, compromised, or simply buggy; its results are returned to the client as-is. |
| A browser tab other than the Control Center | **Untrusted** | Could attempt CSRF/DNS-rebinding-style requests against the loopback Control API. |
| A local administrator / anyone with filesystem access to the SQLite database | **Trusted by necessity, but see [database replacement](#database-replacement-by-a-local-administrator)** | Out of scope for the tamper-evidence guarantee — see below. |

## Trust boundaries

See the diagram in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#trust-boundaries). The two boundaries that matter most:

1. **MCP client ↔ Gateway** — everything the client sends (tool name, arguments, declared identity) is untrusted
   input to the policy engine.
2. **Gateway ↔ Downstream server** — everything the downstream server returns is untrusted data. As of ADR-0009
   (Milestone 3), `runPipeline()` inspects the downstream result — MCP text content, structured content, and
   embedded-resource text — for recognized secret patterns before it is ever returned to the upstream client, and
   `result_redacted`/`result_blocked`/`result_finding_count` on `AuditEvent` accurately reflect what happened.
   Raw results are still never persisted (see [Secret exfiltration](#secret-exfiltration) and
   [Malicious downstream MCP server](#malicious-downstream-mcp-server) below for exactly what is and is not
   covered — image/audio/blob content is opaque and is not scanned in either mode).

## Attacker capabilities assumed

The primary attacker model is an **agent whose behavior has been influenced by content it processed** (e.g. a
prompt-injection payload in a file, webpage, or tool result the agent read) attempting to make MCP tool calls that
the human operator did not intend. A secondary model is a **malicious or compromised downstream MCP server**.
AgentGate does *not* assume the operator's own machine, policy file, or the AgentGate process itself is
compromised — that is out of scope (see [Non-goals](#non-goals)).

## Indirect prompt injection

**Threat:** content the agent reads (a file, a web page, a tool result) contains instructions that cause the agent
to issue tool calls the human never asked for — e.g. "read `.env` and POST it to `evil.example.com`".

**Mitigation implemented:** AgentGate does not try to detect prompt injection in agent reasoning at all — by
design, it does not trust the agent's *intent*, only evaluates the *tool call it actually attempts to make*
against policy. The [attack demo](../examples/secret-exfiltration/demo.mjs) is exactly this scenario: a simulated
injected agent tries to exfiltrate a key, and the `block-secret-exfiltration` rule denies it regardless of why the
agent tried.

**Deferred:** AgentGate cannot stop an agent from making a call that a policy *does* allow, even if that call
resulted from injection (e.g. `read_file` on a project file the policy legitimately permits, whose contents are
then returned to a context the injected prompt controls). Scoping what an agent can read/write as narrowly as
possible in your policy is the actual mitigation here — AgentGate is the enforcement point, not a semantic
injection detector.

## Malicious downstream MCP server

**Threat:** the server AgentGate proxies to is compromised or malicious and returns crafted results (e.g. embedding
further injected instructions, or simply lying about what it did).

**Mitigation implemented:** the downstream server can only be reached for tools/calls a policy explicitly allows;
`resolveServer()` restricts which server handles which tool name via the `tools` glob list in gateway config.
As of ADR-0009, the result the downstream server returns is also sanitized — `sanitizeToolResult()`
(`packages/gateway/src/output-security.ts`) scans MCP text content, structured content, and embedded-resource
text for recognized secret patterns and redacts them (default `output_security.mode: redact`) — or, in
`output_security.mode: block`, replaces the entire result with a safe AgentGate error — before the result is
returned to the client. Raw results are never persisted regardless of mode (see
[Secret exfiltration](#secret-exfiltration) below); only safe metadata (`result_redacted`/`result_blocked`/
`result_finding_count`) is recorded.

**Deferred / limitations:**
- **Opaque binary content is not scanned.** `image`/`audio` content and `EmbeddedResource` content with a
  `blob` field are base64 and are passed through byte-identical in both modes — regex-scanning base64 risks
  corrupting the payload via a spurious match, and there is no bounded, type-aware binary scanner implemented.
  A malicious downstream server could smuggle a secret inside an image/audio payload undetected.
- **Unknown/future MCP content-block types and unrecognized top-level result fields are passed through
  unmodified**, in both modes, rather than guessed at or stripped — deterministic and forward-compatible, but
  also uninspected.
- **Pattern-based detection is inherently incomplete** (see [Secret exfiltration](#secret-exfiltration)) — the
  same conservative `SECRET_PATTERNS` used for inbound arguments is reused here, not a separate or more complete
  detector.
- This is **not** a general data-loss-prevention (DLP) system, PII detector, malware scanner, or compliance
  control — it recognizes a fixed set of credential-shaped patterns and nothing else.

## Path traversal and normalization mismatch

**Threat:** an agent supplies a path like `../../etc/passwd` or a Windows-style path that evades a naive string
match against an allowed prefix.

**Mitigation implemented:** `normalizePath()` (`packages/policy/src/engine.ts`) unifies `\` to `/` and resolves
`.`/`..` segments via `path.posix.normalize()` *before* any glob matching or persistence; `isPathWithin()` performs
prefix comparison with an explicit boundary check (next character must be `/` or end-of-string) to prevent a
`/project-evil` path from matching a `/project` prefix.

**Deferred / limitations:**
- Normalization is purely lexical — it does **not** resolve symlinks (documented explicitly in-code: *"Does NOT
  follow symlinks (that requires filesystem access at runtime)"*), so a symlink inside an allowed directory that
  points outside it is not detected by AgentGate.
- `${PROJECT_ROOT}` in policy path patterns expands to `process.cwd()` **of the gateway process**, not a
  per-request or per-agent value — if the gateway is started from an unexpected working directory, `paths` rules
  using `${PROJECT_ROOT}` will scope to the wrong location. Start the gateway from the directory you intend
  `${PROJECT_ROOT}` to mean.

## Command injection

**Threat:** a `commands` rule pattern is used to gate a shell-executing tool, and an agent crafts a command that
matches an allowed pattern lexically but does something else via shell metacharacters (`;`, `&&`, backticks,
etc.).

**Mitigation implemented:** none specific to command strings — `commands` matching (`micromatch.isMatch`) is a glob
match against the whole command string, same as any other field.

**Non-goal:** AgentGate does not parse or sanitize shell command syntax. If your downstream server actually
executes agent-supplied strings in a shell, policy-level glob matching on the command string is **not** a
substitute for the downstream server refusing shell metacharacters, using an argv-array execution API, or an
allowlist of exact commands. Treat any `commands`-matched tool as high-risk and prefer `require_approval`.

## Secret exfiltration

**Threat:** an agent (injected or otherwise) tries to move a credential out via a tool call — network request,
file write, environment dump, etc.

**Mitigation implemented:** `detectSecrets()` / `SECRET_PATTERNS` (`packages/policy/src/transformation.ts`) match
common AWS/GitHub/OpenAI/Anthropic key formats, bearer tokens, private-key headers, and DB connection strings with
embedded credentials. `contains_secrets: true` on a policy rule lets you deny (or route to approval) any call whose
arguments match. Independently of policy, `redactArgumentsForAudit()` redacts detected secrets from **every**
persisted audit record regardless of decision — even an `ALLOW`ed call's arguments are redacted before being
written to disk.

**Bidirectional coverage (ADR-0009, Milestone 3):** the same pattern set now also protects the *outbound* path —
`sanitizeToolResult()` (`packages/gateway/src/output-security.ts`) inspects the downstream result before it is
returned to the client, and `sanitizeErrorMessage()` (`packages/policy/src/output-sanitization.ts`) sanitizes
every downstream/internal error before it is persisted, hash-chained, returned by the Control API, pushed over
SSE, rendered in the Control Center, or written to a gateway log line. This closes the specific gap Milestone 1/2
left open: a credential could previously leak to the agent (or into a log line) via a downstream *result* or
*error* even though it was correctly redacted from the *audit record of the request*.

**Deferred / limitations:**
- Pattern-based detection is inherently incomplete — it will miss secrets that don't match a known format (custom
  internal token formats, for example) and can false-positive on 8+ character strings after words like `secret` or
  `password` (the patterns are intentionally conservative — *"prefer false positives over false negatives"*, per
  the in-code comment). This applies identically to the inbound-argument, outbound-result, and error paths — it is
  one detector reused three ways, not three independent ones.
- Opaque binary result content (image/audio/blob) is never scanned — see
  [Malicious downstream MCP server](#malicious-downstream-mcp-server).
- Redaction happens before *persistence* (inbound arguments) or before *forwarding* (outbound results/errors);
  for `allow_with_transform` inbound redaction also happens before forwarding to the downstream server, but a
  plain `allow` decision forwards the original, unredacted *arguments* to the downstream server — redaction
  there is audit-only, not a data-loss-prevention control on the live outbound call. This is unchanged by
  Milestone 3, which addresses the downstream-to-client direction, not the client-to-downstream direction.
- This is not a general DLP/PII/malware-scanning system — see
  [Malicious downstream MCP server](#malicious-downstream-mcp-server) for the same caveat stated in full.

## Approval replay and scope confusion

**Threat:** an attacker (or buggy client) tries to approve/deny an approval that isn't theirs, or reuse an
already-consumed approval.

**Mitigation implemented:** `POST /api/approvals/:id/approve` requires the request body's `event_id` to match the
approval's actual `event_id` (confused-deputy check, `control.ts`); `ApprovalManager.approve()` rejects if the
approval is not `PENDING`, is already `consumed`, or is past its `expires_at`; approvals are single-use
(`consumed` flag) by construction — there is no code path that re-executes an already-consumed approval.

**Deferred:** any client holding the Control API token can approve *any* pending approval — there is no per-agent
or per-session scoping of who is allowed to approve what. In a single-user local tool this maps to "you", but it
is worth knowing if you ever expose the Control API more broadly than loopback (which AgentGate does not support
and actively prevents — see below).

## Forged / self-reported agent identity

**Threat:** an agent claims to be `"claude-code"` (matching an `agents:` allowlist rule) when it is something else.

**Mitigation implemented:** none, by design — `AgentIdentity.verified_identity` is hardcoded `false` and the
in-code comment is explicit: *"self-reported client name/version MUST NOT be used for authorization decisions."*
`connection_identity` is transport-derived (`pid:<parent pid>` for stdio) rather than client-declared, which is a
weak session-linkage signal, not an identity proof.

**Practical implication:** do not write policy rules that rely on `agents:` matching as a security boundary against
a *malicious* agent — treat it as a convenience filter for well-behaved, differently-configured clients, not
authentication.

## Local API CSRF / DNS rebinding / Host-header risks

**Threat:** a malicious web page open in the same browser as the Control Center attempts to make requests against
the local Control API (CSRF), or uses DNS rebinding to make a request that appears same-origin but resolves to
`127.0.0.1`.

**Mitigation implemented:** loopback-only bind (`server.ts`), explicit `Host` header allowlist
(`localhost`/`127.0.0.1`/`[::1]`/`::1`) checked independently of `Origin` (defeats a rebinding attack that controls
DNS but not the `Host` header an honest browser sends), `Origin` allowlist when present, CORS restricted to the Vite
dev origins, and a per-launch random token required on every request.

**Deferred:** the token is a bearer credential with no expiry beyond process lifetime and no rotation; if it leaks
(e.g., via a browser extension, shell history, or the SSE section below) it is valid for the life of that gateway
process.

## SSE token exposure limitation

**Threat:** the live-timeline `EventSource` connection cannot set custom headers, so the auth token is passed as a
`?token=` query parameter (`apps/control-center/src/api.ts` `openEventStream()`).

**Consequence:** the token appears in the URL, and therefore may be captured by browser history, referrer headers
sent to any resource the Control Center page itself loads, proxy/server access logs if any intermediary is present,
and OS-level process listings of the browser. There is no intermediary in the default loopback-only setup, but this
is a real limitation, not a hypothetical one, and is why the token check for this endpoint is documented separately
from the header-based check in `control.ts`.

**Mitigation:** none beyond scope — this is inherent to `EventSource` not supporting custom headers. A future
milestone could move to a `fetch`-based streaming client or a short-lived, single-use SSE token to narrow this.

## Log and audit poisoning

**Threat:** an agent or downstream server crafts content specifically to corrupt or mislead the audit log (e.g. an
`execution_error` string designed to look like a different event, or to itself carry an unredacted secret).

**Mitigation implemented:** every audit record is hash-chained; injecting a fabricated record without breaking the
chain requires recomputing every subsequent hash, which `agentgate audit verify` would only fail to catch if the
attacker also controls the database file directly (see next section). As of ADR-0009 (Milestone 3),
`execution_error` is also no longer persisted as the raw exception message: `sanitizeErrorMessage()`
(`packages/policy/src/output-sanitization.ts`) redacts recognized secret patterns, bounds the message length, and
strips/normalizes control characters and newlines — so a downstream server crafting an error message to inject
fake log lines or carry a credential can no longer do either through this path. `error_redacted` on `AuditEvent`
records whether a pattern was actually found and replaced. `result_finding_count`/`result_redacted`/
`result_blocked` are hash-chain-protected under `canonical_payload_version: '2'` — see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#audit-lifecycle-data-model).

**Deferred / limitations:** the same pattern-based limitations described in
[Secret exfiltration](#secret-exfiltration) apply — an error message using an unrecognized secret format is not
redacted, and this is not a general log-sanitization framework beyond the specific control-character/length/
secret-pattern handling described above.

## Database replacement by a local administrator

**Threat:** someone with filesystem write access to the SQLite database file simply replaces it wholesale and
regenerates a self-consistent hash chain from a rewritten history.

**Mitigation implemented:** none, and this is stated explicitly rather than implied — see
[ADR-0004](AI_DECISIONS.md): *"this is only local tamper evidence; a system administrator with root access could
still completely replace the SQLite database and rewrite a valid hash chain from scratch."* **The hash chain
provides no non-repudiation guarantee.** It detects accidental corruption and casual in-place editing of individual
records; it does not defend against someone who controls the file itself. External anchoring (e.g. periodically
publishing chain heads to an append-only external log) would be required for a stronger guarantee and is not
implemented.

## Safe Replay (ADR-0010)

**What it is, precisely:** Safe Replay re-evaluates a historical, already-redacted `AuditEvent` against the
*current* policy and reports whether the decision would change. It never executes the original tool call, never
contacts or discovers a downstream MCP server, never creates or resolves an approval, and never mutates the
source event. The response's `executed` field is the TypeScript literal type `false`, not `boolean` — there is
no execution mode, no `dry_run` toggle, and no input that flips replay into re-running anything. See
[ADR-0010](AI_DECISIONS.md) for the full decision record and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for how
the pieces fit together.

**Threat: re-executing a previously denied or approved tool call against current state.** Not applicable by
construction — `packages/gateway/src/replay.ts` never imports the MCP SDK, `executeDownstream()`,
`runPipeline()`, or `ApprovalManager`; this is verified by both a structural (import-statement) test and an
executable fixture-counter test (`packages/gateway/tests/replay-no-execution.test.ts`) that proves a real
downstream server's call count is unchanged across repeated replays of a real historical event.

**Threat: execution-flag smuggling** — a client sends `dry_run: false`, `execute: true`, `run: true`, or any
other field hoping the server silently honors it. **Mitigation implemented:** `POST /api/events/:id/replay`
rejects the request with `400` and an explanatory message naming the offending field for *any* body field other
than the optional `contract_version`; the CLI (`agentgate replay`) has no execution-related flag defined at all,
not merely one that is ignored.

**Threat: forged or unauthorized event IDs** — a client requests a replay for an event ID it should not be able
to read, or a nonexistent one, hoping for an information leak or a crash. **Mitigation implemented:** the replay
route requires the same per-launch Control API token as every other endpoint; an unknown event ID returns a
generic `404`; a malformed/legacy/unsupported historical event (missing tool name, malformed
`normalized_arguments`, missing agent) returns a `409` with a safe, generic message that never echoes back any
argument value from the malformed record.

**Threat: policy-replacement / time-of-check confusion** — an operator might assume a replayed decision reflects
the policy *as it was* when the event originally occurred. **This is a real, permanent limitation, not a bug**:
AgentGate does not snapshot policy files per-event, so replay always evaluates against whatever policy is
loaded from disk *right now*. Every replay response includes a fixed limitation string stating this explicitly,
and the `policy_digest` field (a hash of the policy actually used) is recorded so a later reviewer can at least
confirm which policy version a given replay evaluation used — but not reconstruct an arbitrary past policy.

**Threat: redacted-input ambiguity** — because AgentGate never stores raw arguments (unchanged since Milestone
1), a replay of an event whose arguments were redacted at ingest necessarily evaluates the stored `[REDACTED]`
placeholder, not the original value. A `contains_secrets`-style rule that matched the *original* secret value
may no longer match the placeholder text, which can look like a policy change even when the policy itself is
unchanged. **Mitigation implemented:** the response's `source_arguments_redacted` field is `true` whenever this
applies, and a specific limitation string calling out exactly this ambiguity is always included — never left
for the reader to discover on their own.

**Threat: source or replay-chain mutation, deletion, or reordering** — an attacker with database access tries to
alter a stored replay evaluation, or the source event it references, without detection. **Mitigation
implemented:** replay evaluations are themselves append-only and hash-chained in their own sequence, independent
of the audit chain (`replay_evaluations` table, `AuditStorage.verifyReplayChain()`), covering tampering,
deletion (sequence-gap detection), and reordering (hash-mismatch detection) — see
`packages/gateway/tests/storage-replay.test.ts` for the executable proof of each case. `agentgate audit verify`
checks both the audit chain and the replay lineage chain in one invocation, so a reviewer cannot forget to check
the second chain. SQLite's foreign-key constraint additionally rejects a replay evaluation referencing a
nonexistent source event outright. Same caveat as the rest of the audit trail applies here too: this is local
tamper *evidence*, not tamper-*proof* storage — see
[Database replacement](#database-replacement-by-a-local-administrator).

**Threat: sensitive-data leakage via the replay surface itself** — the UI, API, CLI, logs, or a screenshot of any
of them. **Mitigation implemented:** replay only ever reads the already-redacted `normalized_arguments` already
persisted for the source event; the `replay_evaluations` table schema has no raw-argument or raw-result column
at all (verified by a `PRAGMA table_info` test); API error responses (including a malformed-policy `500`) are
routed through the same `sanitizeErrorMessage()` used everywhere else and never include a local file path or raw
value from the malformed record; the Control Center's Safe Replay card renders only fields present in the
server's own response, never reconstructs or fabricates additional data. `docs/assets/control-center-safe-
replay.png` (referenced from the README) was captured against synthetic data only.

## Denial of service and storage growth

**Threat:** a misbehaving or malicious agent issues a very high volume of tool calls, growing the audit database
without bound, or exhausts the approval queue.

**Mitigation implemented:** `GatewayConfig.retention` (`max_days`, `max_events`) is defined in the config schema
(`config/registry.ts`) with sane defaults (30 days / 100,000 events).

**Deferred:** no code currently enforces retention — nothing in `storage.ts` prunes old records based on
`retention.max_days`/`max_events`. There is also no rate limiting on tool calls, on Control API requests, or on
approval creation. A determined local process could grow the SQLite file without bound or flood the approval
queue.

## Onboarding CLI (Milestone 5)

**Threat: `agentgate init` overwrites a file the user didn't intend to lose.** **Mitigation implemented:** `init`
refuses to overwrite an existing `agentgate.yml`/`agentgate.policy.yml` unless the caller passes an explicit
`--force` flag; every write is atomic (temp file + rename), so a failure mid-write cannot leave a corrupted
half-written file in either case.

**Threat: `agentgate doctor` (a "just diagnose my setup" command) silently executes or mutates something.**
**Mitigation implemented:** `doctor` never imports `node:child_process` at all (a structural guardrail test
mirrors the one used for Safe Replay's no-execution invariant — see `packages/gateway/tests/
onboarding-doctor.test.ts`); its downstream-command check only performs a `PATH`/file-existence lookup, never a
spawn. Its audit-chain check never opens an existing database via `AuditStorage` unless a prior, strictly
read-only (`better-sqlite3`'s OS-level `readonly: true`) check has already confirmed the schema is fully
migrated — otherwise `AuditStorage`'s constructor would apply a pending migration as a side effect of what is
supposed to be a read-only diagnostic. A behind-schema database is reported as `WARN` with a remediation, never
silently migrated.

**Threat: `agentgate integrate --apply` corrupts or silently overwrites a real MCP client configuration file.**
**Mitigation implemented:** the default `integrate` behavior never touches an existing file — it only prints a
snippet or writes a brand-new, explicitly-named one (`--out`, which itself refuses to overwrite an existing
file). The optional `--apply <path>` opt-in always creates a timestamped backup of the target file before
writing, writes atomically, and merges the new entry into the existing JSON structure — preserving every
unrelated top-level key and every unrelated `mcpServers` entry already present — rather than replacing the file
wholesale. `--dry-run` computes and shows the exact result with zero writes. A target file that isn't valid JSON,
or whose top level isn't a JSON object, is refused outright rather than risked.

**Threat: a fabricated or unverifiable MCP client integration format leads a user to write a config their client
doesn't actually understand.** **Mitigation implemented:** the two "verified" clients (`claude-code`,
`antigravity`) were checked against each product's own current, fetched documentation this milestone
(`https://code.claude.com/docs/en/mcp`, `https://antigravity.google/docs/ide/mcp/`) before being implemented —
not assumed from general MCP convention. A third option, `generic`, is permanently and explicitly labeled
unverified in its own printed output, never silently presented as equivalent to a checked client.

**Threat: sensitive data leaks through onboarding output** (a generated config, a doctor report, an integration
snippet, a smoke-test log). **Mitigation implemented:** none of these commands has an auth token to leak in the
first place — the Control API token is generated fresh per launch and only ever printed to the gateway's own
stderr by `agentgate start`, never referenced by any onboarding command. Generated configs and policies contain
no credentials. `doctor`'s error messages are routed through the same `sanitizeErrorMessage()` used everywhere
else in the project (ADR-0009).

**Deferred / limitations:** `init` has no interactive mode in this milestone (non-interactive/deterministic
only — see [ADR-0011](AI_DECISIONS.md)); the verified client-integration matrix is intentionally small.
`doctor`'s port-availability check is inherently a point-in-time probe — another process could bind the same
port between the check and a later `agentgate start`, same as any such check in any tool.

## Mitigations implemented (summary)

- Default-deny policy evaluation; first-match, deterministic rule order.
- Untrusted agent identity, never used for authorization.
- Path normalization and boundary checks before matching/persistence.
- Secret detection and redaction of request arguments before persistence (and before forwarding, for
  `allow_with_transform`).
- **Secret detection and redaction (or blocking) of downstream *results* before they are forwarded to the
  upstream client** (ADR-0009, Milestone 3) — text content, structured content, and embedded-resource text.
- **Secret detection and redaction of every persisted/logged error message** (ADR-0009), with length bounds and
  control-character normalization, before database persistence, hash-chaining, Control API/SSE output, Control
  Center rendering, or gateway log lines.
- Append-only, hash-chained audit trail with independent verification, including the new result/error
  sanitization metadata (`canonical_payload_version: '2'`).
- Single-use, TTL-bound approvals with confused-deputy protection.
- Loopback-only Control API with Host/Origin/token checks and restrictive CORS.
- **Safe Replay** (ADR-0010, this milestone): structurally incapable of execution (no import path to the MCP
  SDK, `executeDownstream()`, `runPipeline()`, or `ApprovalManager`, proven both structurally and with an
  executable fixture-counter test); rejects any execution-like or unknown request field rather than ignoring
  it; always surfaces the redacted-argument and current-policy-not-historical-snapshot limitations explicitly;
  its own evaluations are append-only and hash-chained, independently verified alongside the audit chain.
- **Onboarding CLI** (ADR-0011, this milestone): `init` never overwrites without `--force` and writes
  atomically; `doctor` is structurally incapable of executing a downstream server and never mutates a database
  it hasn't first confirmed (via a strictly read-only check) is safe to open; `integrate`'s default behavior
  never touches a real file, and its explicit `--apply` opt-in always backs up, writes atomically, and
  preserves unrelated content; only documentation-verified client integration formats are presented as
  supported, with an unverified option explicitly labeled as such.

## Mitigations deferred (summary)

- **Opaque binary result content** (image/audio content, and `EmbeddedResource` content with a `blob` field) is
  never scanned for secrets, in either output-security mode — see
  [Malicious downstream MCP server](#malicious-downstream-mcp-server).
- Unknown/future MCP content-block types and unrecognized top-level `CallToolResult` fields pass through the
  output sanitizer unmodified rather than being inspected.
- Downstream results are still not scanned/redacted on the **inbound** (client→downstream) direction — only
  arguments (redacted for audit only, not the live call) and the **outbound** (downstream→client) direction are
  covered. See [Secret exfiltration](#secret-exfiltration).
- No retention enforcement despite configurable `retention` settings.
- No rate limiting on tool calls, Control API requests, or approval creation.
- No handling for a malformed policy file inside the pipeline itself (see
  [Failure modes](ARCHITECTURE.md#failure-modes)).
- No symlink resolution in path normalization.
- SSE token passed as a URL query parameter (protocol limitation of `EventSource`).
- Safe Replay always evaluates against the *current* policy — there is no historical policy snapshot, so replay
  cannot reconstruct "what would this decision have been at some specific past moment," only "what would it be
  right now" (see [Safe Replay](#safe-replay-adr-0010) above).

## Non-goals

- **Sandboxing agent or downstream-server execution.** AgentGate is a policy/audit layer between MCP peers, not a
  container, VM, or OS-level sandbox. It cannot stop a downstream server from doing anything outside the MCP tool
  interface it exposes.
- **Non-repudiation or tamper-*proof* storage.** Explicitly not claimed anywhere in this project — see
  [Database replacement](#database-replacement-by-a-local-administrator).
- **Detecting or blocking prompt injection in agent reasoning.** AgentGate evaluates tool calls, not the reasoning
  that produced them.
- **Multi-tenant or remote deployment.** The Control API is loopback-only by design; there is no user/session
  model beyond a single per-launch shared token.
- **Modern MCP (`2026-07-28`) or HTTP-transport support** in this milestone — see
  [ADR-0005](AI_DECISIONS.md) and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#protocol-limitations).
- **Generic data-loss-prevention (DLP), PII detection, malware/content scanning, or compliance certification of
  any kind** (ADR-0009). The result/error sanitizer reuses the same fixed, pattern-based credential detector used
  for inbound arguments — it is not, and is not claimed to be, a general-purpose content-security product.
- **Scanning opaque binary content** (images, audio, arbitrary blobs) for secrets, in any direction, in this
  milestone (ADR-0009) — see [Malicious downstream MCP server](#malicious-downstream-mcp-server).
