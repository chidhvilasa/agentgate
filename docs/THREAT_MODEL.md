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

## Tool-definition poisoning (rug-pull, ADR-0012)

**Threat:** a downstream MCP server advertises a benign tool definition, gets used and trusted by an operator/
agent, and later — without ever restarting or reconnecting in an attacker-visible way — starts advertising a
materially different, riskier definition for the SAME tool name (a changed description implying new/undisclosed
behavior, an added input property like an exfiltration destination, a changed output schema, or flipped
annotations). Because MCP tool metadata is server-supplied and the previous section already establishes it must
be treated as untrusted, an agent (or a human skimming a tool list) can be misled into trusting a tool whose
contract has silently changed. This maps to OWASP MCP Top 10 MCP03 (tool poisoning) and the "client-side tool
risk gating" recommended control. Distinct from the previous section: that section is about a malicious *result*
from an unchanged tool call; this section is about the tool *definition itself* changing.

**Mitigation implemented:** the Tool Integrity Registry (`packages/gateway/src/tool-integrity/*`) fingerprints
the entire tool definition object (not a hand-picked subset) against a stable local server identity, and — in
`explicit`/`tofu` mode — quarantines a new or changed definition in BOTH directions: it is not exposed via
`tools/list` (`filterTrustedTools()`), and a direct `tools/call` for that tool name is blocked BEFORE any policy
evaluation or downstream contact (`checkCallAllowed()`), even if the calling client cached an older tool list or
never called `tools/list` in the current session at all. A human reviews a bounded, safe, field-level diff and
either accepts the EXACT fingerprint (trusting only that specific version) or rejects it; a stale accept/reject
attempt against a since-superseded candidate fails closed rather than silently applying. See ADR-0012 in
`docs/AI_DECISIONS.md` for the full design, and `examples/tool-rug-pull/demo.mjs` for an executable, end-to-end
proof (a real benign tool, a real rug-pull to a riskier definition, a blocked direct call with the downstream
fixture's own call counter proving it was never contacted, and a distinct later benign update trusted
independently).

**Deferred / limitations:**
- **Fingerprints are not signatures.** A fingerprint proves local byte-for-byte equality (after safe
  canonicalization) to a previously observed definition — it says nothing about who authored the definition or
  whether the server is trustworthy.
- **A stable/unchanged fingerprint does not prove runtime behavior matches the definition.** A compromised
  downstream server can still return a poisoned *result* through an entirely unchanged tool *definition* — the
  [Malicious downstream MCP server](#malicious-downstream-mcp-server) mitigations above remain the relevant
  defense for that, and Tool Integrity does not replace or weaken them.
- **Local server identity is not remote attestation.** It is derived from the configured local server id plus a
  redacted fingerprint of the local launch configuration (command/args/env) — it proves the local launch
  configuration hasn't changed, not which physical/cloud process is actually running.
- **Annotations are untrusted, server-supplied hints** and are never consulted by enforcement to reduce risk — a
  server cannot self-declare its way past quarantine.
- **The registry's hash chain is local tamper evidence, not tamper-proof**, identical in kind to the audit chain
  limitation in [Database replacement by a local administrator](#database-replacement-by-a-local-administrator)
  below — a privileged local administrator with direct database file access could still tamper with or replace
  it.
- **Scan-to-call TOCTOU is not fully eliminated.** Between one scan and the next call, a downstream server could
  in principle change its definition again; enforcement checks against the last-scanned fingerprint until the
  next scan/rescan observes the change. A rescan is available on demand (CLI/Control API/Control Center) and
  narrows this window, but does not eliminate it.
- **No dependency on, or support for, `notifications/tools/list_changed`.** AgentGate's documented MCP
  compatibility boundary (ADR-0005) remains legacy-2025 stdio only; detection relies on a mandatory scan at
  gateway startup plus on-demand rescans, not on receiving a notification the spec itself says cannot be relied
  upon.
- **`monitor` mode (the default when `tool_integrity` is omitted) provides no blocking protection** — drift is
  recorded but discovery and calls are never blocked. This is a stated backwards-compatibility tradeoff (ADR-0012),
  not a claim of protection; see [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#tool-integrity) for the
  one-line migration to `explicit`.
- This is **not** full MCP supply-chain security, remote attestation, cryptographic signing of tool definitions,
  sandboxing of downstream servers, verification of runtime behavior, or a claim of zero false positives (a
  security-irrelevant change, e.g. a typo fix in a description, still produces drift requiring review in an
  enforcing mode).

## Context Guard: cross-tool escalation defense (ADR-0013)

**Threat: indirect prompt injection through a stable, trusted tool's own output.** A tool the operator already
trusts (a ticket reader, a web-page fetcher, a file reader) is not compromised or drifted at all — its *result*
simply contains attacker-controlled text that a later, individually-legal call obeys. This is distinct from
[Indirect prompt injection](#indirect-prompt-injection) above, which is about AgentGate not detecting injected
*intent*; this section is about the specific cross-tool *sequence* pattern OWASP's MCP guidance calls "confused
deputy" / cross-tool escalation, and how AgentGate's own gateway-observed history can still catch the pattern
even without ever inspecting the injected text itself.

**Threat: confused deputy — sensitive-read + untrusted-content + external-communication sequence.** An agent
reads untrusted content (tool A), is steered by it to read sensitive data (tool B), then exfiltrates it via a
third, unrelated-looking call (tool C) — each individually policy-legal.

**Mitigation implemented:** operator config classifies a tool's *result* as adding conservative risk labels to
the current execution context (`context_guard.tools.<name>.adds_on_result`) and a tool's *call* as declaring
effect labels (`.effects`) checked against the context's accumulated labels before the call is allowed
(`context_guard.rules`, first-match, strictest-wins merge with base policy — see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#context-guard-adr-0013) for the exact evaluation order). This is
enforced in the real gateway request path, not a UI warning — proven end-to-end by
`packages/gateway/tests/context-guard-gateway-enforcement.test.ts` (a real compiled gateway, a real MCP client)
and `examples/context-poisoning/demo.mjs` (a realistic synthetic ticket body containing an indirect-prompt-
injection instruction, with the downstream fixture's own external-send call counter proving zero contact for the
denied attempt).

**Threat: direct/cached-name bypass.** An agent (or a client caching an old tool list) attempts the risky call by
name directly, without ever calling `tools/list` again, hoping contextual enforcement only applies to calls
discovered through the "normal" path. **Mitigation implemented:** Context Guard evaluation happens at the
`tools/call` dispatch point itself (`transport/stdio.ts` → `pipeline.ts`), identically regardless of whether the
tool name came from a fresh `tools/list` or a client's own cache — there is no discovery-time-only enforcement
path to bypass. Verified by the same gateway-enforcement test above, which calls `send_webhook` directly by name
without ever listing tools on that connection.

**Threat: approval replay, argument substitution, and context-revision race.** A human approves a contextually-
gated call, but between the approval's creation and its consumption: (a) the context has since accumulated more
risk (a concurrent call advanced the revision), (b) the call's arguments were changed after approval was granted,
or (c) the downstream tool's trusted definition drifted or was quarantined. **Mitigation implemented:**
`checkApprovalContextValid()` re-reads context/argument/tool-fingerprint state *fresh* immediately before
downstream execution — not merely at approval-creation time — and fails closed on any mismatch, even though the
approval record itself already shows `APPROVED`. Proven by
`packages/gateway/tests/context-guard-fingerprint-binding.test.ts` (fingerprint drift/quarantine cases) and the
`context-guard-gateway-enforcement.test.ts`/`examples/context-poisoning/demo.mjs` stale-revision cases (a
concurrent call advances the context while an approval is pending; approving it anyway still fails on
revalidation, with the downstream call counter staying exactly 0). A `null` bound field (nothing was bound at
approval-creation time — e.g. no trusted Tool Integrity definition existed yet) skips only that specific check; a
binding that was never made cannot be violated, which is a legitimate "not bound" state, not a gap.

**Threat: base-policy change between contextual-rule evaluation and execution.** Not a distinct new risk beyond
what the base policy engine already accepts — policy is re-loaded and re-evaluated on every call, same as
without Context Guard; there is no cached decision that could go stale across a policy edit.

**Threat: context-reset abuse — using reset to "wash away" accumulated risk.** An operator or compromised local
process resets a context specifically to erase labels that would otherwise block a later call. **Mitigation
implemented:** reset requires the *exact* current revision (a stale reset request is rejected outright, so it
cannot be issued blind against "whatever the current state happens to be") and a mandatory, non-empty,
reviewer-attributed reason — both recorded permanently in the append-only history, which is never itself deleted
by a reset. Reset also does not retroactively change any decision already made; it only affects labels going
forward. **Deferred:** any client holding the Control API token can reset any active context — there is no
per-agent or finer-grained authorization for who may reset, the same single-shared-local-token model the rest of
the Control API uses (see [Approval replay and scope confusion](#approval-replay-and-scope-confusion) above).

**Threat: corrupted, deleted, or reordered context history.** An attacker with database access tries to alter
stored context transitions without detection. **Mitigation implemented:** `context_events` is hash-chained
exactly like the audit and Tool Integrity chains; `verifyContextChain()` independently re-walks it, detecting
tampering (hash mismatch), deleted rows (sequence gap), and reordered rows (broken hash link). Same caveat as
every other chain in this document: local tamper *evidence*, not tamper-*proof* — see
[Database replacement](#database-replacement-by-a-local-administrator) below.

**Threat: hostile content through the Context Guard CLI, API, UI, or SSE stream.** A tool name, contextual rule
reason, or reviewer-supplied reset reason is attacker- or operator-influenced text rendered across four different
surfaces. **Mitigation implemented:** only label names (bounded, policy vocabulary), rule ids, safe/bounded
reason strings, and already-redacted `source_event_id` linkage are ever stored in `context_events`/
`context_state` in the first place — raw tool arguments, raw tool results, and any prompt-injection text are
never written by any Context Guard code path, so there is nothing hostile to leak through these surfaces beyond a
tool *name* or a *reason* string. The CLI strips C0 control characters/DEL (`sanitizeForTerminal()`) before
printing either; the Control Center renders all such text through React's own escaping only (never
`dangerouslySetInnerHTML`), with the same control-character stripping applied at the display boundary. Verified
by `apps/control-center/src/pages/ContextGuard.test.tsx`'s hostile-content cases (HTML/script, Markdown/
prompt-injection phrasing, ANSI escapes — all rendered as inert text, zero `<script>` elements created) and
`context-poisoning/demo.mjs`'s own safety-sweep assertions (the synthetic secret and the raw injected-instruction
phrase never appear in any CLI/API output or stored row).

**Threat: concurrent or out-of-order calls interleaving contextual state.** Two calls issued close together on
the same context could, in principle, race: one call's contextual evaluation reading state that a different,
still-finishing call is about to change. **Mitigation implemented:** within one Node.js process, better-sqlite3
is synchronous and every individual state-transition function (`appendContextLabels`, `recordCallEvaluation`,
`resetContext`, `closeOrExpireContext`) contains no `await` between its read of current state and its write, so
JavaScript's single-threaded execution model already prevents same-process code from interleaving and corrupting
one transition; two *different* concurrent calls each independently read current context state fresh at their
own evaluation point, never a cached/shared value. **Deferred / residual:** a genuine cross-request race remains
between one call's contextual evaluation and a *different*, concurrently-finishing call's label-append — the
exact-revision approval-binding mechanism above closes this specifically for human-approval consumption, not for
every possible interleaving; this is a named, explicit limitation, not hidden.

**Threat: gateway restart or reconnect used to evade accumulated context.** An attacker (or a compromised agent)
deliberately triggers a reconnect specifically to shed accumulated risk labels. **This is a real, permanent
limitation, not a bug in this milestone**: a new gateway process launch always creates a brand-new context — there
is no cross-restart persistence, and no reliable client-supplied session identifier exists at the legacy-2025
stdio protocol boundary (ADR-0005) to key persistence on even if it were implemented. A real attack sequence that
spans a restart is genuinely not detected by Context Guard. Persisting context across restarts was considered and
rejected (see ADR-0013's Alternatives) — a restored-but-stale context would reintroduce exactly the kind of
unverifiable persistence this design otherwise avoids.

**Threat: covert or alternate exfiltration channels not modeled by declared tool effects.** An operator declares
`send_webhook` as the only `external_communication`-effect tool, but the downstream server or agent has some
other, undeclared way to move data out (a different tool the operator forgot to classify, a side channel outside
the MCP tool-call interface entirely). **Not mitigated, by design and by necessity:** Context Guard only ever
evaluates what operator config declares — it cannot discover or infer a covert channel the operator never told it
about, and it does not sandbox downstream servers or the agent process in any way (same non-goal as the rest of
this document — see [Non-goals](#non-goals)).

**Threat: operator misclassification or missing labels.** The single most important dependency of this whole
defense: if an operator fails to declare a genuinely sensitive tool's `adds_on_result`/`effects` correctly, or
omits a contextual rule that should exist, Context Guard simply has nothing to act on for that gap — it does not
infer risk from tool names, descriptions, or MCP annotations (see below). This is not a bug to fix in code; it is
the fundamental shape of an operator-declared-policy system, stated plainly rather than implied away.

**Threat: `monitor` mode (the default) providing a false sense of protection.** Identical in kind to Tool
Integrity's own `monitor`-mode caveat (ADR-0012): `context_guard.mode` defaults to `monitor` when the section is
omitted entirely, for backwards compatibility with configs written before this milestone. In `monitor` mode,
contextual rules are still evaluated and every decision is still recorded in history, but the result never
actually blocks or escalates a call — reporting only, never protection. An operator must explicitly set
`mode: enforce` to get real enforcement. See [`docs/POLICY_REFERENCE.md`](POLICY_REFERENCE.md#context-guard) for
the one-line migration.

**Threat: a contextual approval bound to no trusted tool definition (`tool_fingerprint: null`).** A tool that has
never been scanned by Tool Integrity (or Tool Integrity is `disabled`) has no trusted fingerprint to bind an
approval to. **Documented compatibility behavior, not a silent gap:** the binding field is `null` in this case,
and `checkApprovalContextValid()` skips only that specific sub-check — the context-revision and argument-digest
checks still apply in full. This is the same `null`-means-"not bound" pattern already used for a pre-Milestone-7
approval; a binding that was never made cannot be violated. Operators who want the fingerprint check to actually
apply must run Tool Integrity in `explicit`/`tofu` mode (see [Tool-definition poisoning](#tool-definition-
poisoning-rug-pull-adr-0012) above).

**Threat: SSE subscriber/reconnect assumptions.** A Control Center tab that reconnects to the live event stream
might assume it receives every transition that occurred while disconnected. **Actual behavior, stated plainly:**
the underlying event bus (`server.ts`'s `subscribers` array, unchanged pre-existing plumbing this milestone reuses
for `context_event` frames too) never replays history to a fresh subscriber — it only pushes events published
*after* a listener registers. The Control Center's Context Guard page is built to tolerate this: it always treats
an SSE frame as a "refetch current state now" signal, reconciling by re-fetching the authoritative REST state
rather than trying to reconstruct history from a stream that makes no replay guarantee. **Known gap:** this
specific "no historical replay" property has no dedicated low-level automated test in this codebase — a real
attempt at a real-fetch-based SSE test proved unreliable in this environment (removed rather than shipped flaky)
and a lower-level unit test would require either refactoring `server.ts`'s currently-private subscriber wiring or
duplicating it, both rejected as worse than the documented gap; the underlying mechanism itself is unmodified,
pre-existing code that `audit_event`/`Approval` traffic already relied on before this milestone.

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
- **Tool Integrity Registry** (ADR-0012, this milestone): whole-object fingerprinting of downstream tool
  definitions against a stable local server identity; bidirectional quarantine enforcement in the actual gateway
  request path (discovery filtering AND direct-call blocking, not merely a UI warning); exact-fingerprint
  accept/reject with stale-review protection; append-only, hash-chained registry history verified alongside the
  audit chain; bounded, safe, field-level drift diff with hostile-content handling; fail-closed on scan failure,
  malformed/oversized/duplicate definitions, or an unknown tool.
- **Context Guard** (ADR-0013, Milestone 7): operator-owned, conservative risk labels attached to the current
  local execution context based on observed tool results, checked against a later call's own declared effects
  before it is allowed — enforced in the real gateway request path (including a direct/cached-name call, not only
  calls discovered via `tools/list`), monotonic/escalate-only merge with base policy, exact-revision/argument/
  tool-fingerprint approval binding re-validated fresh immediately before execution, append-only hash-chained
  history verified independently of the audit chain, and exact-revision/reviewer-attributed reset that
  invalidates every pending contextual approval bound to the reset context.

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
- Tool Integrity's `monitor` mode (the default when `tool_integrity` is omitted) provides no blocking protection;
  scan-to-call TOCTOU is not fully eliminated; there is no `notifications/tools/list_changed` handling — see
  [Tool-definition poisoning](#tool-definition-poisoning-rug-pull-adr-0012) above.
- Context Guard's `monitor` mode (the default when `context_guard` is omitted) provides no blocking protection;
  context does not persist across a gateway restart/reconnect, so a restart-spanning attack sequence is not
  detected; TTL-based expiry exists in the schema but is not yet actively scheduled; a residual cross-request race
  between one call's contextual evaluation and a different, concurrently-finishing call's label-append is not
  fully eliminated; the SSE "fresh subscriber does not replay prior events" property has no dedicated low-level
  automated test — see [Context Guard](#context-guard-cross-tool-escalation-defense-adr-0013) above.

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
- **Remote attestation, cryptographic signing of tool definitions, sandboxed downstream execution, verification
  of runtime behavior, or supply-chain security of any kind** (ADR-0012). Tool Integrity fingerprints are local
  hashes proving definition equality over time, not a substitute for any of these — see
  [Tool-definition poisoning](#tool-definition-poisoning-rug-pull-adr-0012) above.
- **Model-reasoning inspection, causal proof, or information-flow/taint tracking of any kind** (ADR-0013). Context
  Guard never reads, inspects, or reasons about the upstream LLM's prompts, completions, chain-of-thought, or any
  model-internal state — it only observes the MCP `tools/call` requests and results that actually cross the
  gateway. A label is a policy assertion triggered by an observed gateway event, never a claim that an injection
  actually happened, that the model "read" or "acted on" anything, or that one call causally caused a later one.
  One stdio connection/process is not guaranteed to correspond to exactly one upstream model conversation. A
  context reset is entirely local, gateway-side state and has no effect whatsoever on what the upstream LLM or
  MCP client itself remembers from before the reset. See
  [Context Guard](#context-guard-cross-tool-escalation-defense-adr-0013) above.
