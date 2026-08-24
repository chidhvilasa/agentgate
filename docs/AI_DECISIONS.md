# AgentGate Decision Ledger

This file is the durable source of truth for architectural and product
decisions across AI-agent sessions. Verify entries against the repository.

## Project State

- Current phase: Milestone 3 — Bidirectional Secret Safety and Error Sanitization — **COMPLETE and publicly
  verified** (implementation, tests, docs, Control Center UI, clean-clone verification, and GitHub CI/Security
  all green on the pushed HEAD). Full detail, including one CI failure found and fixed mid-session, is in the
  2026-08-24 Milestone 3 session log and its follow-up note below — this summary line does not try to record the
  hash of the commit that contains it; check that log for the exact final commit.
- Milestone 2 (Documentation, CI, Graphify verification, visual proof, public launch) is **COMPLETE and publicly
  verified** — reconciled against live GitHub state at the start of the Milestone 3 session (not merely the prior
  report): public repo exists, default branch `main`, CI run `32660796091` PASS, Security run `32660796111` PASS.
- Public repository: https://github.com/chidhvilasa/agentgate (public, default branch `main`).
- Current branch: main.
- Last verified implementation commit as of the start of Milestone 3 documentation/UI work: `49c6267` (core
  output/error sanitization implementation — ADR-0009 — committed locally, not yet pushed at that point).
- Ledger status: Updated during the Milestone 3 session; verify current HEAD with Git — this entry deliberately
  does not try to record its own future commit hash.
- Last updated: 2026-08-24
- Updated by: Claude Code
- Next action: see "Exact next action" at the end of the 2026-08-24 Milestone 3 session log below.

## Active Decisions

### ADR-0001: Initial Architecture and Stack

- Status: ACCEPTED
- Date: 2026-08-21
- Scope: architecture
- Decision: Use TypeScript, Node.js 20+, pnpm workspaces, Fastify, React 18, Vite, SQLite.
- Reason: Best alignment with official MCP SDK (TypeScript), fast execution, local-first capabilities.
- Evidence: Target integration is Claude Code (Node-based).
- Alternatives considered:
  - Python/Go: Rejected due to weaker official MCP SDK alignment compared to TS.
- Consequences:
  - Positive: Shared types across UI, Gateway, and Policy Engine.
  - Negative: Node.js dependency for end users.
- Affected files:
  - `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- Supersedes: NONE
- Superseded by: NONE

### ADR-0002: Target MCP Spec and Integration

- Status: SUPERSEDED
- Date: 2026-08-20
- Scope: product
- Decision: Target MCP 2026-07-28 (stateless) with legacy 2025 compatibility via official SDK. Prioritize stdio transport for Claude Code integration.
- Reason: Claude Code uses stdio; modern stateless protocol is future-proof while legacy support is required for older servers.
- Evidence: User prompt requirements.
- Alternatives considered:
  - HTTP-only: Rejected as it wouldn't validate the main Claude Code workflow.
- Consequences:
  - Positive: Validates primary use case immediately.
  - Negative: Requires careful stdio proxying implementation.
- Affected files:
  - `packages/gateway/src/transport/stdio.ts`
- Supersedes: NONE
- Superseded by: ADR-0005

### ADR-0003: Policy and Identity Model

- Status: ACCEPTED
- Date: 2026-08-21
- Scope: security
- Decision: Treat agent identity as untrusted (`declared_identity`, `connection_identity`, `verified_identity: false`). Policy decisions are ALLOW, DENY, REQUIRE_APPROVAL, ALLOW_WITH_TRANSFORM.
- Reason: Self-reported metadata is insecure. Clear separation of redaction vs evaluation.
- Evidence: MCP security guidelines.
- Alternatives considered:
  - Trusting client identity: Rejected as insecure.
- Consequences:
  - Positive: robust security model.
  - Negative: N/A.
- Affected files:
  - `packages/protocol/src/events.ts`
- Supersedes: NONE
- Superseded by: NONE

### ADR-0004: Audit Tamper-Evidence and Append-Only Storage

- Status: ACCEPTED
- Date: 2026-08-21
- Scope: security
- Decision: Use a two-table design (`audit_events` and `audit_lifecycle_records`) with cryptographic hash chaining for tamper-evidence.
- Reason: Fulfills the requirement that the system is truly append-only and that audit records cannot be silently modified.
- Evidence: Security requirements and successful E2E attack demo validation.
- Alternatives considered:
  - Update-in-place SQLite records: Rejected as it violates immutability and append-only constraints.
- Consequences:
  - Positive: Provides local tamper evidence and lifecycle tracking.
  - Negative: More complex querying and verification logic. Note that this is only *local* tamper evidence; a system administrator with root access could still completely replace the SQLite database and rewrite a valid hash chain from scratch.
- Affected files:
  - `packages/gateway/src/storage.ts`
- Supersedes: NONE
- Superseded by: NONE

### ADR-0005: Legacy-Only MCP Support

- Status: ACCEPTED
- Date: 2026-08-21
- Scope: product
- Decision: Target MCP legacy 2025 compatibility natively. Support for modern 2026-07-28 stateless protocol is deferred.
- Reason: Claude Code uses stdio with legacy protocol natively, simplifying proxying for now.
- Evidence: User prompt requirements and implementation complexity.
- Alternatives considered:
  - Full modern support: Deferred until protocol ecosystem stabilizes.
- Consequences:
  - Positive: Validates primary use case immediately.
  - Negative: Needs refactoring to support modern stateless clients later.
- Affected files:
  - `packages/gateway/src/transport/stdio.ts`
- Supersedes: ADR-0002
- Superseded by: NONE

### ADR-0006: Public Repository Launch and Default Branch Rename to `main`

- Status: ACCEPTED
- Date: 2026-08-24
- Scope: product / repository
- Decision: Publish this repository publicly as `chidhvilasa/agentgate` on GitHub, renaming the local default
  branch from `master` to `main` immediately before the first push (not before, to avoid an unnecessary rename if
  a publication gate had failed).
- Reason: User-authorized Milestone 2 objective; `main` is the conventional default branch name expected by GitHub
  Actions triggers already written into `.github/workflows/*.yml` (`push: branches: [main]`).
- Evidence: Explicit user authorization in the Milestone 2 task prompt, conditional on every publication gate
  passing first.
- Alternatives considered:
  - Keep `master`: rejected — user explicitly authorized the rename and workflows already target `main`.
- Consequences:
  - Positive: matches GitHub's current default convention and the workflows already written against it.
  - Negative: none identified; no external clone of this repository existed before this rename (first publication).
- Affected files: local branch ref only; `.github/workflows/*.yml` already assumed `main`.
- Supersedes: NONE
- Superseded by: NONE

### ADR-0007: CI Platform Matrix and Security Scanning Workflow

- Status: ACCEPTED
- Date: 2026-08-24
- Scope: engineering / security
- Decision: `ci.yml` runs the full build/lint/test/demo/hygiene suite on Ubuntu across Node 20 and 22, plus a single
  Windows job (Node 22) as a native-module (`better-sqlite3`) smoke test, rather than a full cross-product matrix.
  `security.yml` runs `pnpm audit --audit-level=high`, a deterministic dependency-free `git grep` secret scan over
  tracked files (allowlisting specific named synthetic test literals, not whole files or directories), and CodeQL
  for JavaScript/TypeScript — on pull requests, pushes to `main`, and a weekly schedule.
- Reason: AgentGate is a local developer tool, not a multi-arch service; a 3-job matrix (2×Ubuntu + 1×Windows)
  catches the real cross-platform risk (native SQLite bindings) without the cost of a full 2×2 matrix. The secret
  scan intentionally allowlists exact known-synthetic values (not file paths) so a real credential accidentally
  added to a test file would still fail the scan.
- Evidence: Both action versions/pins verified against the GitHub API at authoring time (`pnpm/setup` commit
  `84cb39b2...` confirmed to be the exact commit tagged `v2.0.2`; `actions/checkout@v7` and
  `github/codeql-action@v4` confirmed as current major-version tags). The secret-scan allowlist gap (missing the
  `sk-...`/`ghp_...`-shaped literals in `packages/policy/tests`, which would have failed the job on its own test
  fixtures) was caught and fixed in this session before the first push — see session log.
- Alternatives considered:
  - Full Node×OS matrix: rejected as unnecessary cost for a local-first tool.
  - Third-party secret-scanning service/action: rejected in favor of a small, auditable, dependency-free script
    with no external API key requirement.
- Consequences:
  - Positive: fast, cheap CI; native-module Windows compatibility is actually exercised, not assumed.
  - Negative: Windows only runs on Node 22, not 20 — acceptable since the Ubuntu jobs cover both Node majors.
- Affected files: `.github/workflows/ci.yml`, `.github/workflows/security.yml`.
- Supersedes: NONE
- Superseded by: NONE

### ADR-0008: Graphify as Optional Local Developer Tooling

- Status: ACCEPTED
- Date: 2026-08-24
- Scope: engineering
- Decision: Adopt [Graphify](https://github.com/safishamsi/graphify) as an optional, local-only developer
  productivity tool for codebase navigation. It is never a runtime or build dependency of AgentGate. Its generated
  output (`graphify-out/`) is gitignored and regenerated on demand; the pre-existing local Claude Code skill
  integration (`.claude/`, root `CLAUDE.md`) remains untracked, per this session's explicit instructions, rather
  than being adopted into the repository.
- Reason: Genuinely verified functional against this codebase in Milestone 2 (graph build, four targeted queries,
  a `path` trace, and an incremental `update` after real source changes all produced accurate, source-verified
  results) — see `docs/GRAPHIFY_VERIFICATION.md` for the full evidence. Adopting it as documented-but-optional
  tooling (in `docs/DEVELOPMENT.md`) gives contributors a faster way to orient in the codebase without adding any
  dependency, secret, or CI requirement.
- Evidence: `docs/GRAPHIFY_VERIFICATION.md`.
- Alternatives considered:
  - Committing `graphify-out/` for reproducibility: rejected — it is fully regenerable in seconds with no API key,
    and committing a generated graph risks drifting from source between regenerations.
  - Adopting the `.claude/`/root `CLAUDE.md` skill installation into the repo: rejected — it is this developer's
    personal local tool installation, not an AgentGate project artifact; a future ADR could revisit this if the
    project wants to ship first-class Graphify onboarding.
- Consequences:
  - Positive: zero cost/risk to the build; documented as an explicit optional workflow in `docs/DEVELOPMENT.md`.
  - Negative: not exercised in CI, so a regression in Graphify itself would not be caught automatically — acceptable
    for optional tooling.
- Affected files: `.gitignore` (`graphify-out/` entry), `docs/GRAPHIFY_VERIFICATION.md`, `docs/DEVELOPMENT.md`.
- Supersedes: NONE
- Superseded by: NONE

### ADR-0009: Bidirectional Result and Error Secret Safety

- Status: ACCEPTED
- Date: 2026-08-24
- Scope: security
- Decision:
  1. **Raw downstream results remain non-persistent** — this was already true before Milestone 3 (`executeDownstream()`'s
     `result` was never written to storage; only `execution_succeeded`/`execution_error` were) and is unchanged.
     Milestone 3 closes a different, real gap: the raw result was previously forwarded to the upstream MCP client
     completely unsanitized. Output sanitization now happens once, in `runPipeline()`, immediately after
     `executeDownstream()` succeeds and before the result crosses back to the upstream client — the single
     boundary point required by the milestone brief.
  2. **Default output-security mode is `redact`**: recognized secret patterns in inspectable output are replaced
     with `[REDACTED]` before the result is returned upstream; the result is still delivered. A `block` mode is
     also supported: if a detected secret is present in inspectable content, or if configured depth/size limits
     prevented full inspection of otherwise-inspectable (text/structured) content, the entire result is replaced
     with a protocol-valid AgentGate error result that reveals no secret. There is no `off` mode — every result
     passes through the sanitizer; `redact` is the safe default and is not expected to break normal tool use,
     since only recognized secret-shaped substrings are ever changed.
  3. **Content variants**: MCP `text` content, `EmbeddedResource` content with a `text` field, `resource_link`
     string metadata (`uri`/`name`/`description`/`title`), and `structuredContent` (deep, string-leaves-only) are
     all inspected and eligible for redaction. `image`/`audio` content and `EmbeddedResource` content with a `blob`
     field are **opaque binary** (base64) and are never regex-scanned or mutated in either mode — running a secret
     regex over base64 risks corrupting the payload via a spurious match, and there is no bounded, type-aware
     binary scanner implemented in this milestone. Opaque content is always passed through byte-for-byte and
     always marked `not_inspected` in audit metadata; it never causes a `block` on its own, in either mode — the
     product accepts this as a documented, narrow gap rather than either corrupting binary data or blocking every
     result that happens to include an image or audio clip.
  4. **Unknown/unrecognized content-block `type` values and any top-level `CallToolResult` field beyond
     `content`/`structuredContent`/`isError`/`_meta`** are passed through completely unmodified, in both modes,
     with a `not_inspected` finding — this is future-protocol-evolution-safe and avoids AgentGate silently
     stripping fields it doesn't understand. `_meta` (top-level and per-content-block) is **never** inspected or
     modified in either mode — it is protocol/session bookkeeping (progress tokens, task correlation per the
     installed SDK's `types.ts`), not free-form textual content, and mutating it risks breaking client-side
     request correlation. This is a deliberate scope boundary, not an oversight.
  5. **Every downstream exception message is sanitized by one canonical function
     (`sanitizeErrorMessage()` in `packages/policy/src/output-sanitization.ts`) before it is ever persisted, put on
     the hash chain, returned by the Control API, pushed over SSE, rendered in the Control Center, or written to a
     gateway log line.** It redacts recognized secret patterns (reusing `detectSecrets`/`redactSecrets` — no
     second, divergent pattern list), bounds length, strips/normalizes control characters and newlines so a
     malicious message cannot forge additional log lines, and never serializes a full error object or its stack
     trace. Reading a hostile error object's `message` (a getter could throw, loop, or be arbitrarily expensive)
     is itself wrapped in `try/catch` with a safe fallback: `"Downstream tool execution failed; details were
     sanitized."` — inspection failing safely is itself part of the contract, not a bug path.
  6. **Audit metadata** gains three new fields on `AuditEvent` (`result_blocked`, `result_finding_count`,
     `error_redacted`) alongside the pre-existing `result_redacted` (whose doc-comment previously claimed
     "redacted before persistence" — corrected, since it now truthfully means "redacted before the result was
     forwarded upstream," matching what actually happens). None of these fields, and no new audit field added by
     this ADR, ever stores a raw secret, a raw result, or a finding's matched text — only booleans/counts and safe
     structural location strings (e.g. `content[0].text`, `structuredContent.output.token`).
  7. **The new fields are hash-chain protected.** Adding them to the existing `canonical_payload_version: '1'`
     hash input would silently change what "version 1" means and make every already-verified pre-Milestone-3
     lifecycle record fail re-verification — unacceptable. Instead, new lifecycle records are written under
     `canonical_payload_version: '2'`, whose canonical payload is the v1 payload plus the four result/error
     fields; `verifyChain()` dispatches on each individual record's *own* stored `canonical_payload_version` when
     recomputing its hash, so a chain that started before this migration and continues after it verifies
     correctly across the v1→v2 boundary. `AuditStorage.rowToEvent()` previously hardcoded
     `canonical_payload_version: '1'` on every returned `AuditEvent` regardless of the record's actual stored
     version — also corrected as part of this change.
  8. **False positives**: this reuses the same conservative, pattern-based `SECRET_PATTERNS` already used for
     inbound argument redaction — it is not a general DLP system, does not detect PII, and can both miss secrets
     that don't match a known format and occasionally redact benign text that happens to match a pattern (e.g. a
     long non-secret string following the word "token"). This is an accepted, pre-existing, documented trade-off
     ("prefer false positives over false negatives"), not a new claim.
- Reason: closes the specific, real gap identified at the start of this milestone — outbound results were
  forwarded with zero inspection, and persisted error messages were never redacted despite `AuditEvent`'s own
  doc-comment claiming otherwise. Chosen design follows the milestone brief's recommended principle: minimize
  persistence (already true), sanitize textual/structured output crossing the upstream boundary, sanitize every
  persisted error, fail safely (not silently) when strict mode cannot prove a result is clean.
- Evidence: `packages/policy/src/output-sanitization.ts`, `packages/gateway/src/output-security.ts`,
  `packages/gateway/src/pipeline.ts`, `packages/gateway/src/storage.ts`, associated test suites, and
  `examples/downstream-secret-result/demo.mjs`.
- Alternatives considered:
  - Audit-only redaction while still forwarding raw results to the upstream client: rejected — this is exactly
    the status quo the milestone was chartered to fix; it protects the audit log but not the actual agent/user
    receiving the result, which is the more immediate exposure.
  - Always redact with no `block` option: rejected — some deployments will want a hard stop rather than a
    silently-modified result; `block` is offered as an explicit, non-default choice.
  - Deny the entire result whenever *any* secret pattern is detected, unconditionally (no `redact` option):
    rejected as the default — overly disruptive for a pattern-matcher with known false positives; offered only as
    the opt-in `block` mode.
  - A fully generic DLP/PII engine: rejected — far beyond this milestone's evidence base and this project's
    stated non-goals; would invite exactly the "generic DLP" over-claim the milestone brief explicitly forbids.
  - A configurable `opaque_content` handling mode with multiple real behaviors (e.g. a bounded binary scanner):
    rejected for this milestone — no such scanner is implemented, so offering a config knob with only one real
    behavior behind it would be misleading complexity. The schema still names the field
    (`output_security.opaque_content`) but only one literal value (`allow_uninspected`) validates, self-documenting
    the fixed behavior via Zod rather than silently hardcoding it with no visible config surface at all.
- Consequences:
  - Positive: closes the most important documented data-boundary gap from Milestone 2; the canonical
    error-sanitization function also fixes a previously-inaccurate doc-comment (`execution_error` claimed to be
    "redacted" and was not).
  - Negative: `redact` mode can alter tool-result text a downstream server legitimately returned, if that text
    happens to match a conservative secret pattern — an accepted trade-off, consistent with the existing inbound
    behavior. Opaque binary content (images/audio/blobs) still passes through completely uninspected in both
    modes — a documented, narrow gap, not a silent one.
- Affected files: `packages/policy/src/output-sanitization.ts` (new), `packages/policy/src/index.ts`,
  `packages/gateway/src/output-security.ts` (new), `packages/gateway/src/pipeline.ts`,
  `packages/gateway/src/storage.ts`, `packages/gateway/src/transport/stdio.ts`, `packages/gateway/src/cli.ts`,
  `packages/gateway/src/config/registry.ts`, `packages/protocol/src/events.ts`,
  `apps/control-center/src/pages/EventDetail.tsx`, `examples/downstream-secret-result/demo.mjs` (new),
  `examples/agentgate.yml`, associated test files.
- Supersedes: NONE
- Superseded by: NONE

### ADR-0010: Safe Replay Is Policy Re-evaluation, Never Tool Re-execution

- Status: ACCEPTED
- Date: 2026-08-24
- Scope: product / security
- Decision:
  1. **Replay means policy re-evaluation only, permanently, for this feature.** There is no execution mode, no
     `dry_run` boolean, and no input of any kind that flips replay into re-running the original tool call. The
     response contract's `executed` field is the TypeScript literal type `false` — not a `boolean` the server
     happens to always set to `false` today, but a type the compiler itself will not let a future change quietly
     widen without every consumer's type-checking breaking first.
  2. **Replay is structurally, not just behaviorally, incapable of execution.** The replay service
     (`packages/gateway/src/replay.ts`) never imports `executeDownstream()`, never imports `runPipeline()`, never
     imports `StdioClientTransport`/`Client` from the MCP SDK, and never imports `ApprovalManager`. It depends on
     exactly two things: the pure `evaluate()` function from `@agentgate/policy` (the same function
     `runPipeline()` itself calls — one rule matcher, not a second copy) and a handful of tiny, already-existing
     pure argument-extraction helpers exported from `pipeline.ts` for reuse. A future refactor cannot
     accidentally make replay executable by flipping a flag, because there is no flag and no code path to a
     downstream connection to flip it into.
  3. **Replay uses only the stored, already-redacted `normalized_arguments`** — the same representation
     `pipeline.ts` itself persists, never a reconstructed or re-fetched original. This is a hard architectural
     constraint, not a policy choice: AgentGate never stores raw arguments in the first place (unchanged since
     Milestone 1), so there is nothing else replay could use. `source_arguments_redacted` in the response is
     `true` whenever the source event's `arguments_redacted` flag was `true`, and a specific limitation string is
     always included in that case: a `contains_secrets: true` rule that matched the *original* arguments will
     generally **not** match the stored `[REDACTED]` placeholder text, so a policy that hasn't changed at all can
     still show `decision_changed: true` on replay purely because of this representational gap — this is called
     out explicitly, not left for the user to discover.
  4. **Replay uses the current policy file, not a reconstructed historical one.** AgentGate does not snapshot
     policy files per-event; adding that is out of scope for this milestone and would be its own ADR if pursued.
     Replay's entire value proposition — "would this decision be different today" — depends on evaluating against
     the *current* policy; this is documented as the defining behavior, not hidden as a limitation.
  5. **The source `AuditEvent`/lifecycle rows are never written to during replay.** Replay only ever calls
     `AuditStorage.getEvent()` (a read) against the audit tables and `AuditStorage.insertReplayEvaluation()`
     (a write) against a **new, separate, append-only** `replay_evaluations` table — it never calls
     `insertEvent()`/`updateEventStatus()`/`appendLifecycleRecord()`. A replay evaluation is immutable lineage
     *about* a source event, never a mutation *of* it.
  6. **Replay evaluations are themselves append-only and hash-chained**, in their own sequence independent of the
     audit chain (own `sequence_number`/`previous_replay_hash`/`replay_hash` columns, own
     `canonical_payload_version`), verified by a new `AuditStorage.verifyReplayChain()` that `agentgate audit
     verify` and the CLI's `replay` command both call. No raw arguments, raw results, or raw secrets are ever
     included in a replay evaluation's hashed or stored fields — only decision types, rule IDs, reason codes, a
     policy digest, and bounded limitation strings.
  7. **`REQUIRE_APPROVAL` and `ALLOW_WITH_TRANSFORM` are reported hypothetically, never enacted.** Replaying an
     event whose current hypothetical decision is `REQUIRE_APPROVAL` reports that fact in the comparison; it does
     not create a real `Approval` row, does not notify the Control Center's approval queue, and does not consume
     any TTL. Replaying into a hypothetical `ALLOW_WITH_TRANSFORM` reports which transformations *would* apply;
     nothing is sent to any downstream server, because nothing is sent to any downstream server, full stop.
  8. **A missing or malformed current policy file fails closed.** `evaluateHistoricalEvent()` reuses
     `loadPolicyFile()`, which already throws a structured error on a missing/invalid policy; the replay API
     endpoint and CLI both surface this as an explicit failure (409/non-zero exit), never as a silent
     default-allow or a stale cached policy.
  9. **A source event with no recorded original decision, or a legacy/malformed `tool_call` shape, is rejected**
     with an explicit "unsupported historical event" error (API: 409; CLI: non-zero exit) rather than guessed at.
  10. **No claim of deterministic reproduction is made anywhere** — in code comments, API responses, CLI output,
      the Control Center UI, or documentation. The product wording is: *"Safe Replay compares a historical event
      with the current policy. It never executes the tool."* Nothing stronger.
- Reason: closes a real, previously-stubbed product gap (`ReplayRequest`/`ReplayResponse` existed in
  `packages/protocol/src/api.ts` with a `dry_run?: boolean` field and a comment reading *"Must explicitly set to
  false to execute"* — misleading and unimplemented, and a disabled Control Center button read *"coming in
  Milestone 2"*) while explicitly not reintroducing the risk that stub implied. Policy-drift analysis, incident
  review, and rule-change validation are genuinely useful without ever touching a downstream server, given that
  AgentGate already has everything replay needs (the pure policy engine, the stored redacted representation) on
  hand.
- Evidence: `packages/gateway/src/replay.ts`, `packages/gateway/src/storage.ts` (`replay_evaluations` table,
  `insertReplayEvaluation`/`verifyReplayChain`), `packages/gateway/src/api/control.ts`
  (`POST /api/events/:id/replay`), `packages/gateway/src/cli.ts` (`agentgate replay`), associated test suites
  (including dependency-injection-based no-execution-invariant tests against a fixture downstream server's call
  counter), `examples/policy-drift-replay/demo.mjs`.
- Alternatives considered:
  - Actual tool re-execution from stored arguments: rejected — arguments are redacted/incomplete by design, and
    execution has real side effects on a real system; replaying an event is not something a user should be able
    to trigger by accident while reviewing history.
  - Persist raw arguments to make replay faithful: rejected — directly violates the project's data-minimization
    model (ADR redaction guarantees exist specifically so raw secrets never reach disk); "more faithful replay"
    is not worth reintroducing the exact exposure the rest of the system exists to prevent.
  - Accept `dry_run: false` with a human approval step to actually execute: deferred entirely, not part of Safe
    Replay — a genuinely different feature (live re-execution with fresh human authorization) that would need its
    own threat model, its own ADR, and is explicitly out of this milestone's authorized scope.
  - Do not persist replay evaluations at all (compute and return, never store): considered, but rejected in favor
    of immutable, verifiable evidence — a security/incident-review tool is more useful, not less, when its own
    findings are themselves tamper-evident and auditable. The storage model is kept deliberately minimal (one
    small table, no raw data) to keep this affordable.
  - Extend the existing two-table `audit_events`/`audit_lifecycle_records` design to also carry replay rows:
    rejected — replay evaluations have no mutable "current state" projection to maintain (unlike a live tool
    call's RECEIVED→...→terminal lifecycle); a single append-only table with its own hash chain is simpler and
    does not risk conflating "what an agent did" with "what evaluating history against today's policy would
    conclude."
- Consequences:
  - Positive: a real, immediately useful feature (policy-drift analysis, incident review, rule-change validation)
    with a genuinely zero-execution-risk architecture, backed by structural (not just behavioral) guarantees.
  - Negative: replay results can show `decision_changed: true` for reasons unrelated to an actual policy change
    (redacted-argument representational drift) — mitigated by always surfacing this in `limitations`, never
    silently. No historical-policy-snapshot support means replay always compares against "policy as of right
    now," which is the intended behavior but is a real limit on precisely reconstructing "what would this event's
    decision have been at some specific past moment."
- Affected files: `packages/protocol/src/api.ts`, `packages/protocol/src/events.ts`,
  `packages/gateway/src/replay.ts` (new), `packages/gateway/src/pipeline.ts`, `packages/gateway/src/storage.ts`,
  `packages/gateway/src/api/control.ts`, `packages/gateway/src/cli.ts`, `packages/policy/src/*` (policy digest
  helper), `apps/control-center/src/pages/EventDetail.tsx`, `apps/control-center/src/api.ts`,
  `packages/gateway/tests/fixtures/fixture-downstream-server.mjs`, `examples/policy-drift-replay/demo.mjs` (new),
  associated test files.
- Supersedes: NONE
- Superseded by: NONE

## Superseded Decisions



## Session Log

### 2026-08-21 — Antigravity - Milestone 1 Hardening and Truthful Verification

- Prompt objective: Perform Security Hardening and Verification for Milestone 1. Ensure all claims are supported by executable evidence.
- Decisions added or changed: Added ADR-0004 (Audit Tamper-Evidence), updated ADR-0002 to legacy-only.
- Implementation completed: Fixed MCP protocol proxying, implemented append-only hash chains in `storage.ts`, ran real E2E stdio attack demo, added gateway security tests (pipeline, approval, API), restricted Control API CORS and origin checks.
- Files materially changed: `packages/gateway/src/storage.ts`, `packages/gateway/src/api/control.ts`, `examples/secret-exfiltration/demo.mjs`, `packages/gateway/tests/*`.
- Verification performed: E2E attack demo successfully spawns gateway, issues malicious tool call, blocks it, and verifies the hash chain. All workspace tests passing.
- Verification result: PASS
- Known limitations: Control Center UI is view-only for policies; no replay yet.
- Unresolved questions: None.
- Exact next action: Proceed to Milestone 2 (Documentation, CI, and GitHub push).

### 2026-08-21 — Claude Code - Final Pre-Milestone 2 Cleanup

- Prompt objective: Fix the decision ledger's self-referential commit field, narrow the `*token*` gitignore rule, make the attack demo self-cleaning, and turn `pnpm run lint` into a real, passing verification gate.
- Decisions added or changed: None (no ADRs added or superseded). This session is hygiene/verification only.
- Implementation completed:
  - Replaced the ambiguous "Last verified commit [Dirty Working Tree]" ledger field with a separate "Last verified implementation commit" + "Ledger status" pair that does not attempt to record its own future commit hash.
  - Replaced the broad `*token*` `.gitignore` rule with `.agentgate-token`, `*.runtime-token`, and `.agentgate/auth-token`; verified with `git check-ignore -v` that runtime-token paths are ignored and that `token-validator.ts`-style source filenames are not.
  - Rewrote `examples/secret-exfiltration/demo.mjs` to write its config/mock-server/SQLite fixtures into a unique `fs.mkdtemp(os.tmpdir())` directory (passed explicitly to the gateway CLI and SQLite connections), wrapped the run in `try/finally`, closed the MCP client, transport, and both SQLite connections, replaced every `process.exit()` with `process.exitCode`, and added a same-directory assertion (`assertInsideTempDir`) before any cleanup deletion. Also removed a stray `mock-downstream.js` / `agentgate-demo.yml` / `agentgate.sqlite*` set left in the repo root by the pre-fix version of this script, and fixed a bug where the mock downstream server's `require('@modelcontextprotocol/sdk/...')` could not resolve from the new temp directory (now requires the SDK's CJS build by absolute path).
  - Added a single root `eslint.config.mjs` (flat config, `typescript-eslint` type-aware for `packages/*` and `apps/control-center` via explicit `project` tsconfigs, including new `tsconfig.eslint.json` files for `gateway`/`policy` so `tests/` — which sits outside their build `include` — is actually linted; plain-JS handling for `examples/**` and this config file itself) and pointed the root `lint` script at `eslint .` directly (the previous `pnpm -r run lint` failed silently since no package defined a `lint` script). Kept `no-floating-promises`, `no-misused-promises`, and `await-thenable` as errors (real bug class for a gateway); turned off the `no-unsafe-*`/`no-base-to-string`/`restrict-template-expressions` family, which fired near-uniformly on this codebase's SQLite-row/JSON boundaries and on JSX children of plain `string` fields (verified as false positives, not filed as suppressed security findings) rather than surfacing real defects.
  - Fixed every lint error the new config surfaced instead of disabling rules to reach green: removed ~13 dead imports/vars, an unbound `this.rowToApproval` method reference passed to `.map`, two `no-fallthrough` gaps in `cli.ts`'s switch (added explicit `break`s), three empty `catch {}` blocks (now commented as intentional), two unnecessary regex escapes, four unhandled/floating promises, two async-handlers-in-onClick misuses, and a real bug in `transport/stdio.ts` where discovery `listTools()` was called without first calling `client.connect()` (silently failing every run and leaving `downstreamTools` empty).
- Files materially changed: `docs/AI_DECISIONS.md`, `.gitignore`, `examples/secret-exfiltration/demo.mjs`, `eslint.config.mjs` (new), `package.json`, `packages/gateway/tsconfig.eslint.json` (new), `packages/policy/tsconfig.eslint.json` (new), `packages/gateway/src/{approval,cli,pipeline,storage,transport/stdio}.ts`, `packages/policy/src/{engine,transformation}.ts`, `apps/control-center/src/{App,api,main}.tsx`, `apps/control-center/src/pages/{Agents,Approvals}.tsx`.
- Verification performed (all commands run for real from repo root, in this order): `pnpm install --frozen-lockfile` → up to date; `pnpm run build` → all 4 buildable packages succeed; `pnpm run lint` → `eslint .` exits 0 (0 errors, 2 pre-existing `no-explicit-any` warnings in test files, left as warnings by design); `pnpm run test` → 32/32 tests pass across `packages/policy` and `packages/gateway`; `node examples/secret-exfiltration/demo.mjs` → attack DENIED, redaction confirmed, hash chain verified (2 records), exits 0, temp directory removed, repo root left with no generated files; `git diff --check` → exits 0 (only pre-existing LF/CRLF advisories, no real whitespace errors); `git status --short` → no untracked demo artifacts; `git grep` for AWS/OpenAI/Anthropic/GitHub key patterns and PEM headers across tracked files → only the well-known `AKIAIOSFODNN7EXAMPLE` placeholder and synthetic test values, no real secrets; `git ls-files` for `*.sqlite`/`*.log`/`token`/`.env` → none tracked.
- Verification result: PASS
- Known limitations: The `no-unsafe-*` typescript-eslint rule family is intentionally off repo-wide (see rationale above) — it is not a substitute for the runtime redaction/policy checks in `packages/policy`, which remain the actual security boundary for untrusted tool-call arguments. Audit tamper-evidence remains local-only, per ADR-0004 (no non-repudiation or tamper-proof claim is made).
- Unresolved questions: None.
- Exact next action: Milestone 2 — README, ARCHITECTURE.md, THREAT_MODEL.md, CI workflows, Control Center screenshot, push to GitHub public repo.

### 2026-08-24 — Claude Code — Milestone 2: Documentation, CI, Graphify Verification, Visual Proof, Public Launch

- Prompt objective: complete the remaining Milestone 2 work (a prior partial pass, evidenced by the untracked
  `README.md`/`docs/*.md`/`.github/` files already present at session start, had produced most of the public
  documentation and CI workflows but had not committed, screenshotted, verified, or published anything), then
  publish `chidhvilasa/agentgate` to public GitHub once every gate in the task prompt passed.
- Starting state audited: HEAD `5070a2b` on `master`; working tree had the previously-drafted Milestone 2 docs,
  `.github/` (workflows + issue/PR templates), and CI-driven `package.json`/`pnpm-workspace.yaml`/`pnpm-lock.yaml`
  edits all present but uncommitted; `.claude/` and root `CLAUDE.md` present and untracked as expected;
  `docs/assets/` existed but was empty (screenshots not yet captured).
- Baseline re-verified before new work: `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run lint` (0
  errors, 2 pre-existing warnings), `pnpm run test` (32/32), `node examples/secret-exfiltration/demo.mjs` (attack
  denied, redaction confirmed, chain verified, self-cleaned), `git diff --check` (0 real errors) — all passed
  before touching anything.
- Graphify verification: executable resolved via `PATH` and directly; `graphify update .` re-run twice in this
  session — once after the Milestone 2 docs/CI/community files were added (511/721 → **698 nodes / 831 edges / 48
  communities**), and again after the Control Center bug fixes and remaining ledger/doc edits below (→ **702
  nodes / 835 edges / 47 communities**). A follow-up `graphify query "How does the Timeline page color a denied
  event badge?"` after the second update correctly surfaced `Timeline.tsx`'s `statusClass()` node at its new,
  post-fix line number — the incremental update reflects real code changes, not a stale graph.
  `docs/GRAPHIFY_VERIFICATION.md` updated with the concrete before/after counts (it previously deferred them to
  this entry).
- Real Control Center visual proof (Phase 7): ran the actual gateway + Control Center against a temporary fixture
  (real MCP stdio client, real policy file, real SQLite db) issuing one ALLOW (`read_file`), one DENY
  (`network.request` with a synthetic AWS-shaped key), and one left-pending `REQUIRE_APPROVAL` (`write_file`) call
  through the real pipeline, then drove a headless Chromium browser (Playwright, installed as a temporary root
  devDependency for this single run and fully removed afterward — `git diff` on `package.json`/`pnpm-lock.yaml`
  confirmed byte-for-byte reversion) against the real Vite dev server to capture screenshots. **Found and fixed
  two genuine, user-facing Control Center bugs in the process** (not something a screenshot alone would have
  caught without visually reviewing the output):
  1. `Overview.tsx`'s high-risk-event row `onClick` set `window.location.hash`, which is a no-op under the app's
     `BrowserRouter` — clicking a row silently did nothing. Fixed to use `useNavigate()`, matching the pattern
     already correct in `Timeline.tsx`. Verified the fix by scripting the actual click and asserting
     `page.url()` changed to `/events/:id`.
  2. The decision-badge color logic in `Overview.tsx`, `Timeline.tsx`, and `EventDetail.tsx` checked
     `status.includes('deny')`, which never matches the real audit status literal `'DENIED'` (`'denied'` does not
     contain the substring `'deny'` — no `y` follows `n` in "denied") — **every denied event, including the
     canonical blocked-secret-exfiltration case, rendered with a neutral gray badge instead of red.**
     `Timeline.tsx`/`EventDetail.tsx` additionally had no `'succeeded'` case, so a successfully-executed ALLOW
     call fell through to the same red class used for `FAILED`/`CANCELLED`/`EXPIRED`. Fixed all three files
     consistently; added a `.badge.neutral` CSS rule for the remaining fallback case, which previously had no
     color styling of its own. Re-captured all screenshots after the fix and visually confirmed correct
     green/red/orange coloring.
  - Final captured assets (synthetic data only, no real tokens/paths/secrets): `docs/assets/control-center-
    {overview,timeline,approvals,event-detail}.png`. Zero browser console errors and zero failed/4xx+ network
    requests observed across all four page loads.
- CI/security workflow verification: `pnpm/setup` commit pin (`84cb39b2...`) confirmed via the GitHub API to be
  the exact commit tagged `pnpm/setup@v2.0.2`; `actions/checkout@v7` and `github/codeql-action@v4` confirmed as
  current, existing major-version tags. **Found and fixed a real gap in `security.yml`'s secret scan**: its
  allowlist covered only the two AWS-shaped placeholder keys, not the `sk-...`/`ghp_...`-shaped synthetic literals
  in `packages/policy/tests/transformation.test.ts` used to exercise `detectSecrets()` — the scan, as originally
  written, would have failed CI on its own test fixtures on the very first push. Reproduced the exact job logic
  locally, confirmed the failure, added the four specific literals to the allowlist by exact value (not by file
  exclusion), and reconfirmed the scan passes locally.
- Documentation spot-verified against source (not merely re-read): every `POLICY_REFERENCE.md` match-field name
  diffed against `packages/policy/src/schema.ts` (exact match); every CLI command in `README.md`/`QUICKSTART.md`
  (`validate`, `start`, `audit verify`) actually run from a real terminal, including a full `agentgate start`
  against `examples/agentgate.yml` (real `npx`-fetched `@modelcontextprotocol/server-filesystem` downstream,
  Control API + token + stdio proxy all came up correctly); `dev:control` script existence confirmed in root
  `package.json`; grepped all public docs for `non-repudiation`/`tamper-proof`/`blockchain`/`production-ready`/
  `enterprise-grade` and confirmed every hit is a correctly-framed negation, not a claim; grepped for the modern
  MCP era string and confirmed every live (non-superseded-ADR) mention is correctly qualified as not-implemented/
  deferred. One absolute-path privacy issue found and fixed: `docs/GRAPHIFY_VERIFICATION.md` originally recorded
  the real local Windows path `C:\Users\<realname>\.local\bin\graphify.EXE`; generalized to `%USERPROFILE%\...`.
- Clean-clone verification (Phase 9): `git clone` of local HEAD (candidate commit `8341098`, after this session's
  four commits below) into an isolated temp directory. `pnpm install --frozen-lockfile`, `pnpm run build`,
  `pnpm run lint`, `pnpm run test`, `node examples/secret-exfiltration/demo.mjs` (attack denied, chain verified),
  `node packages/gateway/dist/cli.js validate policies/agentgate.example.yml`, a full `agentgate start` +
  `agentgate audit verify` round trip against a freshly generated database — all passed with zero generated
  artifacts left in `git status --short` afterward. `.claude/`, `CLAUDE.md`, and `graphify-out/` all confirmed
  absent from the clone (never tracked). Every local file link in `README.md` resolved to an actually-present
  file. Temp clone directory removed afterward.
- Commits created on `master` (pre-rename) in this session, in order: `1db7bcc` (core public docs), `c707ed7` (CI
  + security workflows), `bb713f1` (visuals + community files + Control Center bug fixes), `8341098` (package/repo
  hygiene + this ledger update). `.claude/` and root `CLAUDE.md` were staged by an incautious `git add -A` and
  explicitly `git restore --staged` before that commit — confirmed still untracked afterward.
- Files materially changed beyond the prior partial pass: `apps/control-center/src/pages/{Overview,Timeline,
  EventDetail}.tsx`, `apps/control-center/src/index.css`, `.github/workflows/security.yml`,
  `docs/GRAPHIFY_VERIFICATION.md`, `docs/AI_DECISIONS.md`, `CHANGELOG.md`, plus the four new `docs/assets/*.png`.
- Verification result: PASS (all of the above; see the "GRAPHIFY", "DOCUMENTATION", "CONTROL CENTER VISUAL
  VERIFICATION", and "CLEAN-CLONE VERIFICATION" sections of this session's final report for the itemized
  pass/fail per required gate).
- Known limitations (unchanged from Milestone 1, restated for continuity): audit tamper-evidence is local-only
  (ADR-0004); downstream results and `execution_error` are not secret-scanned; no retention/rate-limiting
  enforcement; SSE token is a URL query parameter; only legacy-2025 stdio MCP is supported (ADR-0005). See
  `docs/THREAT_MODEL.md` for the full, current list — nothing above changes that document's conclusions.
- Unresolved questions: none blocking; GitHub Actions CI/security workflow results for the actual pushed commit
  are recorded in this session's final report rather than here, per the instruction not to have the ledger race
  its own future state — check the Actions tab / `gh run list` against current `HEAD` for the latest status.
- Exact next action: monitor the first scheduled (weekly) `security.yml` run and any future PRs' CI results;
  consider implementing the deferred replay endpoint, result-scanning for secrets, and retention enforcement
  documented as gaps in `docs/THREAT_MODEL.md`, each as its own reviewed change with a fresh ADR only if it
  changes a durable decision recorded above.

### 2026-08-24 — Claude Code — Milestone 3: Bidirectional Secret Safety and Error Sanitization

- Prompt objective: continue an in-progress Milestone 3 session from a clean implementation checkpoint
  (`49c6267`, core sanitization already committed locally, unpushed) and complete documentation, Control Center
  representation, Graphify refresh, verification, and public push/CI observation.
- Starting state verified (not trusted from the prior report): HEAD `49c6267` on `main`, only `.claude/`/
  `CLAUDE.md` untracked, `origin` exactly `https://github.com/chidhvilasa/agentgate.git`, GitHub auth as
  `chidhvilasa`, remote HEAD still `b48163a` (i.e. `49c6267` genuinely not yet pushed).
- Checkpoint gates re-verified for real: `pnpm install --frozen-lockfile`, `pnpm run build`, `pnpm run lint` (0
  errors, 2 pre-existing warnings), `pnpm run test` → 52 (policy) + 34 (gateway) = **86 tests**, matching the
  reported checkpoint exactly; both `examples/secret-exfiltration/demo.mjs` and
  `examples/downstream-secret-result/demo.mjs` passed, self-cleaned, no residue; `git diff --check` clean.
- Documentation truth pass (commit `af2438a`): corrected every stale "downstream results/errors are not
  scanned" statement across `docs/THREAT_MODEL.md` (trust boundaries, malicious-downstream-server, secret-
  exfiltration, log-and-audit-poisoning, mitigations-implemented/deferred, non-goals), `docs/ARCHITECTURE.md`
  (component table, system diagram, sequence diagram split into result/error flows, audit lifecycle data model
  with v1/v2 canonical-payload-version rationale, new "Output security configuration" section, extension
  points), new "Output security (gateway-level)" section in `docs/POLICY_REFERENCE.md` (exact schema, explicitly
  distinguished from `allow_with_transform`), new Milestone 3 claim/evidence table in `docs/VERIFICATION.md` (one
  row per test file/case or command), new sections in `docs/DEVELOPMENT.md`/`docs/TROUBLESHOOTING.md`
  (configuring output security, diagnosing redacted/blocked results, migration/audit-verify guidance, adding a
  synthetic-secret regression without weakening scanning), a concise "Output security" section in `README.md`,
  and a Milestone 3 `CHANGELOG.md` entry. Added both attack demos to `.github/workflows/ci.yml` (previously only
  the inbound one ran in CI) and updated `CONTRIBUTING.md`/`.github/pull_request_template.md`'s gate commands to
  match. A commit-message authoring mistake (unescaped backticks in a `git commit -m` string were interpreted by
  the shell as command substitution, silently blanking two inline-code spans) was caught by reading back the
  actual recorded message and fixed via `git commit --amend` before this commit was ever pushed.
- Control Center (commit `2ba1696`): added a "Result Security" card to `EventDetail.tsx`, rendered only for
  `SUCCEEDED`/`FAILED` events (the only statuses output security runs for, so DENIED/EXPIRED/etc. events never
  show a fabricated scan result) — clean/neutral state phrased as "No supported secret pattern detected" (never
  "fully safe," per explicit requirement), redacted state, blocked state, a plain finding count, an
  "Error sanitized" row when `execution_error` is present, and a static (non-fabricated) note that opaque binary
  content is never scanned — chosen over inventing a new per-event schema field, since the current schema has no
  field distinguishing "contains opaque content" from other finding categories. Added a minimal component-
  testing harness for `apps/control-center` (previously absent): `vitest` + `@testing-library/react` + `jsdom`,
  with test files isolated into their own `tsconfig.test.json` rather than folded into `tsconfig.app.json` —
  importing `vitest` pulls in `@types/node`'s ambient globals, and once those leaked into the same TypeScript
  program as `App.tsx`, `setInterval`'s resolved overload changed and produced two false
  `no-misused-promises` errors on unrelated, unchanged production code; isolating test files into their own
  program (matching gateway/policy's existing `tests/` + `tsconfig.eslint.json` pattern) fixed this cleanly. 8
  new tests in `EventDetail.test.tsx` cover every card state, the neutral zero-finding wording, card suppression
  for non-terminal statuses, preserved DENIED badge styling, and that `tool_call.raw_arguments` (as opposed to
  the already-redacted `normalized_arguments`) is never rendered. Also removed
  `apps/control-center/README.md`, a leftover Vite template placeholder missed during Milestone 2's cleanup.
- Real browser verification (commit `ada1565`): ran the real gateway + real Control Center against a temporary
  fixture (real `fixture-downstream-server.mjs`, real policy, real SQLite db) issuing a clean call, a call whose
  downstream *result* leaks a synthetic AWS-shaped key, a call whose downstream server *throws* with a secret in
  the message, and an `isError` result that also leaks a secret — all through the real pipeline. A headless
  Chromium session (Playwright, added as a temporary root devDependency for this one run and fully removed
  afterward — `git diff` on `package.json`/`pnpm-lock.yaml` confirmed byte-for-byte reversion) confirmed: real
  Overview data ("Gateway connected"), the redacted event's Event Detail correctly showed "Result Security" /
  "REDACTED", and the synthetic secret `AKIAIOSFODNN7EXAMPLE` was confirmed absent from the rendered DOM. Zero
  console errors, zero failed/4xx+ network requests. Captured
  `docs/assets/control-center-result-security.png` and embedded it in README's Output security section.
- Graphify: `graphify update .` rebuilt the graph to 813 nodes / 987 edges / 54 communities (up from 702/835/47
  at the end of Milestone 2). Three targeted queries returned source-verified, useful results (one — "how does
  EventDetail display result metadata" — correctly found the structural `contains`/`imports` edges but, as
  expected from a pure-AST graph, did not surface the new conditional-JSX card body itself). The requested
  `sanitizeToolResult() -> EventDetail.tsx` path query returned **no path** — confirmed as an honest, accurate
  negative: Control Center and the gateway/policy packages have no static import/call edge between them
  anywhere in this codebase (verified independently via `grep`), since they communicate only over HTTP/SSE at
  runtime. A connectable path (`sanitizeToolResult() -> pipeline.ts -> storage.ts`) was recorded instead.
  `docs/GRAPHIFY_VERIFICATION.md` updated with a dated Milestone 3 section; `graphify-out/` remains gitignored
  and was not committed.
- Verification result: PASS for every item above. See this session's final report for the itemized pass/fail per
  required completion gate, including final local verification, clean-clone verification, and the push/CI
  outcome performed after this ledger entry was drafted.
- Known limitations (see `docs/THREAT_MODEL.md` for the authoritative, current list): opaque binary result
  content (image/audio/blob) is never scanned in either output-security mode; unknown/future MCP content-block
  types and unrecognized top-level result fields pass through uninspected; the reused pattern-based secret
  detector can miss unrecognized formats and occasionally over-redact; audit tamper-evidence remains local-only
  (ADR-0004); retention enforcement, rate limiting, a working replay endpoint, and modern/HTTP-transport MCP
  support remain deferred (ADR-0005); Graphify cannot trace a relationship with no static source-level edge
  (confirmed again this session, not new).
- Unresolved questions: none blocking.
- Exact next action (superseded by the follow-up note immediately below — kept for chronology): run the
  complete final local gate on the final committed candidate, perform clean-clone verification, push `main` to
  `origin` (non-force), and observe GitHub Actions CI/security results for the pushed HEAD.

#### Follow-up (same session, after push and CI observation)

- Final local gate (94 tests: 52 policy + 8 control-center + 34 gateway), clean-clone verification (isolated temp
  clone, full install/build/lint/test/both-demos/`agentgate audit verify`, zero residue), and the tracked-file
  secret scan (matching `security.yml` exactly) all passed before the first push of this session's work
  (commit `934f495`).
- **First push (`934f495`) revealed a real CI failure**, correctly caught by cross-platform/cross-Node-version
  testing: `build-test (ubuntu, node 20)` failed at the `Test` step with
  `TypeError: webidl.util.markAsUncloneable is not a function` inside `jsdom@30.0.1`'s bundled `undici`, while
  `node 22` and `windows` passed. Root cause confirmed by inspecting `jsdom@30.0.1`'s own `package.json`:
  `engines.node: "^22.22.2 || ^24.15.0 || >=26.0.0"` — it does not support Node 20 at all, which is this
  project's documented minimum/tested version. Fixed by pinning to `jsdom@29.1.1` (`engines.node: "^20.19.0 ||
  ^22.13.0 || >=24.0.0"`, covers Node 20) — commit `6ef2dff`. This was a real, in-scope infrastructure defect,
  not a security issue; no test was weakened or skipped to reach green.
- Full local gate (build/lint/94 tests/both demos/`git diff --check`) re-verified passing after the fix, then
  pushed. **GitHub Actions on the final pushed HEAD (`6ef2dff`)**: CI run `32692744299` — all 3 jobs
  (ubuntu/node20, ubuntu/node22, windows/node22) **PASS**. Security run `32692744229` — all 3 jobs (dependency
  audit, tracked-file secret scan, CodeQL) **PASS**. Repository metadata confirmed intact post-push (`main`
  default branch, Apache-2.0 license detected, description unchanged).
- Exact next action: none blocking. Future work, each as its own reviewed change with a fresh ADR only if it
  changes a durable decision: a bounded, type-aware binary scanner for `output_security.opaque_content` (a
  second value beyond `allow_uninspected`); the deferred replay endpoint; retention enforcement; rate limiting;
  modern/HTTP-transport MCP support (ADR-0005).

### 2026-08-24 — Safe Replay Completion, Phase 1 (prove the completed backend)

- Prompt objective: continue from checkpoint `d0dcc62` (backend-only Safe Replay: service, storage/hash-chain,
  Control API route, CLI, protocol types — implements ADR-0010) and, per Phase 1 of the governing "Safe Replay
  Completion, Verification, and Publication" prompt, prove the already-implemented backend with comprehensive,
  evidence-driven tests before touching the UI, demo, or docs.
- Continuity check performed at session start: re-read `docs/AI_DECISIONS.md` in full (ADR-0001–0010 plus the
  full Session Log), re-read the four new Safe Replay implementation files (`replay.ts`, the `storage.ts`
  replay-lineage additions, the `control.ts` replay route, `cli.ts`'s `replay` command) and confirmed
  `d0dcc62` was the actual local HEAD with a clean working tree before starting.
- Decisions added or changed: none — ADR-0010 fully covers this phase's scope; no new or superseded ADR was
  needed. No architectural change was made to the backend; both fixes below are defect repairs surfaced by real
  testing, not redesigns, consistent with the prompt's explicit "do not redesign the completed backend" instruction.
- Implementation completed:
  - Instrumented `packages/gateway/tests/fixtures/fixture-downstream-server.mjs` with a `FIXTURE_CALL_COUNT_FILE`
    env-var-driven persistent call counter (bumped on every real `CallToolRequestSchema` handling), giving the
    no-execution proof genuine external, process-level evidence rather than only in-process mocks.
  - Added four new test files under `packages/gateway/tests/`: `replay.test.ts` (19 tests — every decision
    transition, matched-rule-only drift, reason-code-only drift, redacted-argument and missing-original-decision
    limitations, malformed-event rejection, determinism, non-mutation, no secret leakage in error messages),
    `replay-no-execution.test.ts` (5 tests — a structural import-statement guardrail against `replay.ts` ever
    importing the MCP SDK/`ApprovalManager`/`executeDownstream`/`runPipeline`, plus the fixture-counter proof:
    one real execution bumps the counter to 1, five subsequent replays leave it at 1, `ApprovalManager.create/
    approve/deny` are never called during a replay whose hypothetical decision is `REQUIRE_APPROVAL`, and the
    source event/audit chain are unchanged after repeated replays), `storage-replay.test.ts` (12 tests — schema
    creation, chaining, multi-evaluation lineage, SQLite foreign-key rejection of an orphaned `source_event_id`,
    tampering detection on decision and policy-digest fields, deletion-gap detection, reordering detection,
    restart continuation, and a schema-level check that no raw-argument/result column exists), and
    `replay-api.test.ts` (16 tests — auth, hostile Host, missing/malformed/non-replayable event IDs, malformed
    current policy failing closed without path leakage, rejection of `dry_run:false`/`execute:true`/`run:true`/
    unknown fields, acceptance of a valid `contract_version`, no secret leakage, persisted lineage fetchable via
    both list and single-record GET routes, non-mutation of the source event).
  - Found and fixed two real, previously-latent defects in `packages/gateway/src/api/control.ts`, both surfaced
    only by exercising real HTTP requests (manual curl smoke-testing, then the new Vitest `.inject()` suite),
    not by code inspection: (1) Fastify's default JSON body parser rejected a genuinely empty body sent with
    `Content-Type: application/json` (`FST_ERR_CTP_EMPTY_JSON_BODY`) — exactly the shape a browser `fetch()` via
    the Control Center's existing `post()` helper sends, and confirmed (via a second curl reproduction) to
    *already* affect the pre-existing `/api/approvals/:id/deny` endpoint before this session touched it. Fixed
    with a custom `addContentTypeParser` that treats an empty body as `{}` and still returns 400 (not 500) on
    genuinely malformed non-empty JSON. (2) The in-flight replay de-duplication cleanup's
    `pending.finally(...)` produced a second, separately-unhandled promise rejection distinct from the one the
    request handler itself already caught, detected via Vitest's unhandled-rejection reporting while running the
    new API tests; fixed with a `.then(onFulfilled, onRejected)` cleanup whose resulting promise never itself
    rejects.
- Files materially changed: `packages/gateway/src/api/control.ts` (two bug fixes only — no route/contract
  change), `packages/gateway/tests/fixtures/fixture-downstream-server.mjs` (counter instrumentation),
  `packages/gateway/tests/replay.test.ts` (new), `packages/gateway/tests/replay-no-execution.test.ts` (new),
  `packages/gateway/tests/storage-replay.test.ts` (new), `packages/gateway/tests/replay-api.test.ts` (new).
- Commands actually executed and their actual results: `pnpm run build` (clean), `pnpm run lint` (0 errors),
  `pnpm run test` — **146 tests passing** (94 pre-existing baseline + 52 new Safe Replay tests), zero
  regressions; `node examples/secret-exfiltration/demo.mjs` (pass); `node examples/downstream-secret-result/
  demo.mjs` (pass); `git diff --check` (clean, no whitespace errors); a manual tracked-file secret scan matching
  `security.yml`'s pattern set run against the staged Phase 1 diff (`No credential-shaped strings found outside
  known placeholders.`). Committed as `b2ffa72 test(replay): prove replay never executes downstream tools`.
- Verification result: PASS for every Phase 1 item — decision-transition coverage, redacted-argument/missing-
  decision edge cases, malformed-event rejection, the executable fixture-counter no-execution proof, the
  structural import guardrail, storage tamper/reordering/deletion/restart cases, and API auth/validation/
  execution-flag-rejection/leakage/persistence behavior are all now covered by passing, evidence-based tests
  rather than asserted in prose.
- Known limitations / follow-up risk: Phase 1 covers the backend only — the Control Center UI still shows the
  old disabled "Dry-run Replay (coming in Milestone 2)" stub (Phase 2), no deterministic policy-drift demo yet
  exists (Phase 3), and documentation/threat-model/screenshot/Graphify updates (Phases 4–6) have not started.
  The two `control.ts` fixes are believed complete for the cases exercised, but have not yet been re-verified
  under real browser/network conditions (planned for Phase 5).
- Unresolved questions: none blocking.
- Exact next action: Phase 2 — replace the disabled Replay stub in `apps/control-center/src/pages/
  EventDetail.tsx` with a real Safe Replay card wired to a new typed `api.replay()` client method, with
  component tests covering success/changed/unchanged/redacted-source-warning/safe-error/double-submit-
  prevention/no-execution-control/no-raw-secret-rendering.

### 2026-08-24 — Safe Replay Completion, Phase 2 (Control Center UI)

- Prompt objective: replace the disabled "Dry-run Replay (coming in Milestone 2)" stub in
  `apps/control-center/src/pages/EventDetail.tsx` with a real, accessible Safe Replay card, backed by a typed
  API client method, per Phase 2 of the governing prompt and ADR-0010.
- Continuity check: re-read ADR-0010 and the Phase 1 session-log entry above before starting; confirmed local
  HEAD was `909fe83` (Phase 1 tests + ledger entry) with a clean tree before making any change.
- Decisions added or changed: none — no new or superseded ADR needed; this phase implements ADR-0010's existing
  UI requirements rather than making a new durable architectural decision.
- Implementation completed:
  - `apps/control-center/src/api.ts`: added a typed `api.replay(eventId)` method using the
    `ReplayEvaluationResponse` type already exported from `@agentgate/protocol` (no new type had to be
    invented — the protocol package already defined the exact wire shape), plus `api.replays(eventId)` for the
    list endpoint. Added a dedicated `postForResult()` helper, separate from the pre-existing generic `post()`
    (left untouched so approve/deny behavior is unaffected), that parses and surfaces the server's own safe
    `error` message on a non-2xx response instead of only a bare status code.
  - `apps/control-center/src/pages/EventDetail.tsx`: replaced the disabled button with a `SafeReplayCard`
    component. Prominent "NO TOOL EXECUTION" badge; explanatory text that the saved, already-redacted request
    is compared against the *current* policy and nothing is sent downstream; renders original vs current
    decision/matched-rule/reason, a CHANGED/UNCHANGED badge with the server's `comparison` sentence, the
    redacted-source-arguments warning when applicable, the full `limitations` list, and the evaluated-at
    timestamp plus replay ID. Idle/loading/success/error(with retry) states are all handled explicitly.
    Double-submission is prevented with a `useRef` guard checked synchronously inside the click handler (not
    only React state, which batches asynchronously and would not reliably block two clicks in the same tick).
    There is no execute/run/approve control anywhere in the card — `api.replay()` has no parameter that could
    request one.
  - `apps/control-center/src/pages/EventDetail.test.tsx`: added 8 new tests (initial no-execution state with no
    execution control present anywhere on the page; successful unchanged-decision replay; successful
    changed-decision replay; redacted-source warning shown/not-shown; safe error message with a working retry
    that succeeds on the second attempt; double-submit prevention — three rapid clicks issue exactly one
    request; confirmation the card never renders anything beyond what the mocked response actually contained).
  - One real lint finding fixed during this phase: an `@typescript-eslint/no-unnecessary-type-assertion` error
    on the `postForResult()` error-message extraction — TypeScript's `in`-operator narrowing (since TS 4.9)
    already types `data.error` as `unknown` once `'error' in data` is checked, making the `(data as { error:
    unknown })` cast redundant; removed it.
- Files materially changed: `apps/control-center/src/api.ts`, `apps/control-center/src/pages/EventDetail.tsx`,
  `apps/control-center/src/pages/EventDetail.test.tsx`.
- Commands actually executed and their actual results: `pnpm run build` (clean), `pnpm run lint` (0 errors, the
  2 pre-existing unrelated `no-explicit-any` warnings in gateway test files still present and untouched),
  `pnpm run test` — **154 tests passing** (52 policy + 16 control-center [8 pre-existing + 8 new] + 86 gateway),
  zero regressions; `node examples/secret-exfiltration/demo.mjs` (pass); `node examples/downstream-secret-
  result/demo.mjs` (pass); `git diff --check` (clean). Committed as `96f4833 feat(control-center): replace
  disabled Replay stub with real Safe Replay card`.
- Verification result: PASS for every Phase 2 item — a real, working Safe Replay card exists with no execution
  control, covered by passing component tests for every required state (success/changed/unchanged/redacted-
  source-warning/safe-error-with-retry/double-submit-prevention/no-raw-value-fabrication).
- Known limitations / follow-up risk: this phase has not yet been exercised in a real browser against a real
  running gateway (planned for Phase 5) — only jsdom-based component tests so far. No deterministic
  policy-drift demo exists yet (Phase 3). Accessibility was addressed via semantic HTML (native `<button>`
  elements, `role="alert"` on the error message, `aria-live="polite"` on the result region, `aria-busy` on the
  loading button) but has not been verified with a screen reader or automated a11y tooling — only by component
  test queries using accessible roles/names, which passed.
- Unresolved questions: none blocking.
- Exact next action: Phase 3 — build `examples/policy-drift-replay/demo.mjs`, a deterministic, offline,
  CI-safe demo proving a real historical audited request replayed under a changed policy shows the correct
  decision drift, with the downstream fixture's call counter confirmed unchanged throughout.

### 2026-08-24 — Safe Replay Completion, Phase 3 (deterministic policy-drift demo)

- Prompt objective: build `examples/policy-drift-replay/demo.mjs` — a deterministic, offline, CI-safe demo
  proving Safe Replay's decision-drift behavior against a real historical audited event, through both the
  Control API and the CLI, with an executable downstream call-counter proof.
- Continuity check: re-read ADR-0010 and the Phase 1/Phase 2 session-log entries above before starting;
  confirmed local HEAD was `9472cbc` (Phase 2 UI + ledger entry) with a clean tree before making any change.
- Decisions added or changed: none — no new or superseded ADR needed.
- Implementation completed: `examples/policy-drift-replay/demo.mjs`, modeled directly on the existing
  `secret-exfiltration`/`downstream-secret-result` demo pattern (mkdtemp'd temp dir, `assertInsideTempDir`/
  `safeRemoveFile` safety gates, `try/finally` cleanup, `process.exitCode` never `process.exit()`), against
  `packages/gateway/dist` (production-built). Reuses the existing
  `packages/gateway/tests/fixtures/fixture-downstream-server.mjs` fixture directly (rather than writing a
  second, demo-only mock downstream server) for its `FIXTURE_CALL_COUNT_FILE` call-counter proof — this file
  lives inside the repo tree, so no CJS-absolute-path module-resolution workaround was needed the way the two
  older demos need for their temp-directory-generated mock servers. Flow: start a real gateway + the fixture
  downstream under policy A (a rule `echo-rule` that ALLOWs `echo`); make one real, audited `echo` call whose
  arguments carry the synthetic AWS-shaped placeholder (exercising inbound argument redaction on the historical
  record at the same time, for free); record the downstream counter (1); overwrite the *same* policy file so
  the *same* rule id now DENIES `echo` (isolating a pure decision-type drift from a matched-rule-id drift);
  replay the historical event via `POST /api/events/:id/replay` (captured the per-launch auth token by piping
  the gateway child process's stderr and parsing the "Auth token:" line it already prints on startup) and
  assert `executed:false`, `mode:'policy_only'`, ALLOW→DENY, `decision_changed:true`,
  `matched_rule_changed:false`, no secret in the response, and the downstream counter still 1; replay the same
  event again via `agentgate replay <id> <config> --json` (a separate CLI subprocess) and assert the same
  drift independently, no secret in stdout, counter still 1; assert no approval exists; assert the source audit
  event is byte-identical (JSON-stringified comparison) before and after both replays; verify both the audit
  chain and the replay lineage chain via `agentgate audit verify` (message content + exit code) and
  independently via a direct `storage.verifyReplayChain()` call; confirm exactly two replay evaluations were
  persisted (one per replay path).
  - Also updated `.github/workflows/ci.yml` (both the Ubuntu build-test matrix job and the Windows job),
    `CONTRIBUTING.md`'s pre-PR local gate command list, and `.github/pull_request_template.md`'s required-
    commands checklist to run this third demo alongside the two pre-existing ones, matching the pattern
    established when the second demo was added in Milestone 3.
- Files materially changed: `examples/policy-drift-replay/demo.mjs` (new), `.github/workflows/ci.yml`,
  `CONTRIBUTING.md`, `.github/pull_request_template.md`.
- Commands actually executed and their actual results: `node examples/policy-drift-replay/demo.mjs` — all 24
  in-demo assertions PASS, exit code 0, `git status --short` clean after the run (no residue); re-ran a second
  time with the same result (determinism check). `pnpm run lint` (0 errors, same 2 pre-existing unrelated
  warnings). `pnpm run test` — 154 tests, unchanged (this phase added a demo, not tests), zero regressions. All
  three demos (`secret-exfiltration`, `downstream-secret-result`, `policy-drift-replay`) run back-to-back —
  all exit 0. `git diff --check` (clean). The exact CI tracked-file secret-scan pattern from `security.yml` run
  manually against the staged new file: `No credential-shaped strings found outside known placeholders.`
  Committed as `a5fc13a feat(examples): add deterministic policy-drift Safe Replay demo` and
  `93093e6 ci: run the policy-drift Safe Replay demo in CI and contributor gates`.
- Verification result: PASS for every Phase 3 item — a real historical event, replayed under a genuinely
  changed policy, through both the API and the CLI, with the executable counter proof, the no-approval
  assertion, the source-immutability assertion, and both chain-verification checks, all passing.
- Known limitations / follow-up risk: this demo has not yet been run inside GitHub Actions itself (only
  locally) — that happens as part of Phase 8's push/CI-observation step, where a genuine platform difference
  (e.g. Windows stdio/process timing) could still surface. Documentation (Phase 4), browser verification/
  screenshot (Phase 5), and Graphify re-indexing (Phase 6) have not started.
- Unresolved questions: none blocking.
- Exact next action: Phase 4 — update README.md, docs/ARCHITECTURE.md, docs/THREAT_MODEL.md,
  docs/POLICY_REFERENCE.md (if relevant), docs/VERIFICATION.md, docs/DEVELOPMENT.md, docs/TROUBLESHOOTING.md,
  and CHANGELOG.md to document Safe Replay truthfully and remove stale "coming in Milestone 2"/"replay is
  unsupported" claims.

### 2026-08-24 — Safe Replay Completion, Phase 4 (documentation)

- Prompt objective: update every relevant doc to describe Safe Replay truthfully — what it is, what it is not,
  its API/CLI/UI/demo usage, its limitations — and remove every stale "coming in Milestone 2"/unimplemented-
  replay claim, per Phase 4 of the governing prompt.
- Continuity check: re-read ADR-0010 and the Phase 1–3 session-log entries above before starting; confirmed
  local HEAD was `1c27793` (Phase 3 demo + CI wiring + ledger entry) with a clean tree before making any change.
- Decisions added or changed: none — no new or superseded ADR needed; this phase documents ADR-0010, it does not
  extend or reinterpret it.
- Implementation completed (documentation only, no functional code changed):
  - `README.md`: new "Safe Replay" section (what it is/is not, example CLI JSON output, a screenshot reference
    to `docs/assets/control-center-safe-replay.png` — not yet captured; that happens in Phase 5 — and a demo
    pointer), a new Core features bullet, an updated CLI command table, an updated Control Center feature list,
    and a corrected total test count (154 — the prior "86 tests" figure was already stale before this milestone,
    since it never counted `apps/control-center`'s tests at all).
  - `docs/THREAT_MODEL.md`: replaced the old "Unsafe replay" (deferred/unimplemented) section with a full "Safe
    Replay (ADR-0010)" section covering exactly the six threats the governing prompt named: replay endpoint
    abuse, execution-flag smuggling, forged/unauthorized event IDs, policy-replacement/time-of-check confusion,
    redacted-input ambiguity, source/replay-chain mutation/deletion/reordering, and sensitive-data leakage via
    the UI/API/CLI/logs/errors — each paired with its actual implemented mitigation and a pointer to the test
    file that proves it, not a promise of a future one. Updated the "Mitigations implemented/deferred" summaries
    and removed the stale "No replay endpoint implemented yet" line.
  - `docs/ARCHITECTURE.md`: new Safe Replay service row in the Components table; a new node in the system
    diagram with explicit dashed "no import path" edges to the downstream server and the approval manager
    (visualizing the structural isolation, not just describing it in prose); a new "Safe Replay (ADR-0010)"
    section with a sequence diagram (Control Center/CLI → Control API → `replay.ts` → Policy Engine → Audit
    Storage) and the `replay_evaluations` table's ER diagram; two new Failure modes bullets (malformed policy at
    replay time fails closed, unlike the live pipeline path; unsupported historical events are rejected, not
    guessed at).
  - `docs/POLICY_REFERENCE.md`: corrected the CLI section, which previously and now-inaccurately implied
    `validate` was the only implemented policy-inspection command.
  - `docs/VERIFICATION.md`: new "Milestone 4 Verification — Safe Replay and Policy-Drift Analysis" section, in
    the same per-claim/evidence-table format as the existing Milestone 1 and Milestone 3 sections, naming an
    exact test file/case or reproducible command for every claim.
  - `docs/DEVELOPMENT.md`: renamed "Using the attack demos safely" to "Using the demos safely" (the new demo
    proves policy-drift detection, not a blocked attack); a new "Using Safe Replay locally" walkthrough (finding
    an event id via a verified-working `node -e` one-liner, editing policy without a gateway restart, what
    `source_arguments_redacted` means for interpreting results, replay-lineage growth semantics — replaying the
    same event repeatedly is expected, not an error); updated release-gate commands to include the third demo;
    corrected the `pnpm run test` description (previously said only `packages/policy` and `packages/gateway`,
    omitting `apps/control-center`, already stale before this milestone).
  - `docs/TROUBLESHOOTING.md`: updated the `agentgate audit verify` entry to describe the two independent chains
    it now checks (audit + replay lineage, either can fail independently of the other); two new entries
    ("decision changed but I didn't touch the policy" — covering both the redacted-argument and current-vs-
    historical-policy causes — and "No event found / unsupported historical event").
  - `CHANGELOG.md`: new Milestone 4 `[Unreleased]` section (Added/Fixed/Changed/Known limitations), placed
    ahead of the existing Milestone 3 entry, documenting everything shipped across Phases 1–3. The Milestone 3
    entry's own historical "a working replay endpoint... remain deferred" limitations line was deliberately left
    unedited — changelog entries are dated, point-in-time statements, not living documents, matching how ADR
    history is preserved rather than silently rewritten.
- Files materially changed: `README.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`,
  `docs/POLICY_REFERENCE.md`, `docs/VERIFICATION.md`, `docs/DEVELOPMENT.md`, `docs/TROUBLESHOOTING.md`,
  `CHANGELOG.md`. No source/test files changed in this phase.
- Commands actually executed and their actual results: verified the `node -e` one-liner documented in
  `docs/DEVELOPMENT.md`'s new Safe Replay section actually runs against the real compiled `dist/storage.js`
  before committing it to docs (`node -e "const {AuditStorage}=require('./packages/gateway/dist/storage.js'); ..."`
  → correctly printed `[]` against a fresh in-memory database). `pnpm run build` (clean), `pnpm run lint` (0
  errors, same 2 pre-existing unrelated warnings), `pnpm run test` (154 tests, unchanged — doc-only phase, zero
  regressions), all three demos re-run back-to-back (all exit 0), `git diff --check` (clean). The exact CI
  tracked-file secret-scan pattern from `security.yml` run manually against the staged diff:
  `No credential-shaped strings found outside known placeholders.` Committed as `ea5bb68 docs: document Safe
  Replay across README, architecture, threat model, and dev docs`.
- Verification result: PASS for every Phase 4 item — every required doc updated with truthful content, every
  named stale claim removed (confirmed by a targeted grep sweep across README/docs/CHANGELOG for "coming in
  Milestone 2"/"replay is unsupported"/"Dry-run Replay" turning up only historical ledger references and the
  CHANGELOG's own description of what was *removed*, never a live stale claim).
- Known limitations / follow-up risk: the README's Safe Replay section and the Control Center feature list both
  reference `docs/assets/control-center-safe-replay.png`, which does not exist on disk yet — it is captured in
  Phase 5 (browser verification). Until that commit, the image reference in the rendered README is a broken
  link; this is a known, temporary, single-phase gap, not an oversight, and is called out explicitly here so it
  is not mistaken for a completed step. Graphify re-indexing (Phase 6) and full/clean-clone verification gates
  (Phase 7) have not started.
- Unresolved questions: none blocking.
- Exact next action: Phase 5 — real browser verification against a running gateway + Control Center (historical
  event + a changed current policy), capturing `docs/assets/control-center-safe-replay.png` to resolve the
  broken image reference introduced in this phase.

### 2026-08-24 — Safe Replay Completion, Phase 5 (browser verification and screenshot)

- Prompt objective: verify Safe Replay end-to-end in a real browser against a real gateway and real Control
  Center, and capture `docs/assets/control-center-safe-replay.png` to resolve the broken image reference from
  Phase 4, per Phase 5 of the governing prompt.
- Continuity check: re-read ADR-0010 and the Phase 1–4 session-log entries above before starting; confirmed
  local HEAD was `22189c2` (Phase 4 docs + ledger entry) with a clean tree before making any change.
- Decisions added or changed: none — no new or superseded ADR needed.
- Implementation completed: added `playwright` as a temporary root devDependency (`pnpm add -D -w playwright`;
  `npx playwright install chromium`), wrote `.tmp-capture-safe-replay.mjs` in the repo root (deleted before this
  phase's commit, never staged), mirroring the established temp-script pattern from the Milestone 3 browser
  verification. The script: starts a real gateway (`packages/gateway/dist/cli.js`, production-built) and the
  real fixture downstream server under a policy that allows `echo`; makes one real, audited `echo` call over a
  real MCP client connection; rewrites the same policy rule to deny `echo` (the drift); starts a real Vite dev
  server for `apps/control-center`; launches headless Chromium (Playwright), injects the auth token into
  `localStorage` via `context.addInitScript()`, navigates to the real Event Detail page for the historical
  event, clicks "Run Safe Replay," and asserts the rendered result is `CHANGED`.
  - **Two real environment issues found and fixed while building this script** (both specific to this Windows
    machine, not code defects): (1) Vite's default `--host` value (`localhost`) resolved to IPv6 `::1` only,
    so a plain `fetch('http://127.0.0.1:5173/')` readiness check timed out even though the server was actually
    up — fixed by passing `--host 127.0.0.1` explicitly to Vite, consistent with the loopback-only pattern used
    throughout this project. (2) `.main-content`'s CSS is a fixed-height flex column with `overflow-y: auto`;
    when the Event Detail page's total card content exceeds that fixed height, the flex layout shrinks
    individual `.card` elements (clipped by each card's own `overflow: hidden`) instead of truly scrolling —
    a genuine, pre-existing layout quirk of the Control Center's CSS, unrelated to Safe Replay's own
    functionality (confirmed separately: 0 console errors, 0 failed/4xx+ requests, correct `CHANGED` result, and
    the downstream counter check all passed before this was even discovered). Diagnosed via direct
    `getBoundingClientRect()`/computed-style/parent-chain inspection in the page (not guessed at), then
    neutralized *only for the screenshot capture* with a temporary injected style
    (`.main-content { height: auto !important; overflow: visible !important; }`) so the captured image shows the
    card's true, complete content — this is a screenshot-capture workaround, not a change to any shipped file,
    and the underlying layout quirk is not otherwise in scope for this milestone (recorded here as a real,
    known, pre-existing UI limitation, not silently worked around and forgotten).
  - Verified in the browser: Event Detail loads; the Safe Replay card renders and works end to end; the
    `CHANGED` result and ALLOW→DENY decision trace render correctly; the "No tool execution occurred" banner is
    prominent; zero browser console errors; zero failed/4xx+ network requests; the downstream fixture's call
    counter is unchanged (still `1`) after the browser-triggered replay — the same executable no-execution
    evidence used in the automated tests and the CLI/API demo, now also proven through the real UI.
  - Captured `docs/assets/control-center-safe-replay.png` — inspected visually before committing; contains only
    synthetic data (no auth token, local username, file path, secret, or unrelated window content).
  - Cleanup: deleted `.tmp-capture-safe-replay.mjs`; `pnpm remove -w playwright`; confirmed `git diff --stat`
    on `package.json`/`pnpm-lock.yaml` showed no output at all (byte-for-byte reversion) before committing.
- Files materially changed: `docs/assets/control-center-safe-replay.png` (new, binary). No source, test, or
  config file changed in this phase — `package.json`/`pnpm-lock.yaml` were touched transiently during the
  verification run and confirmed fully reverted before commit.
- Commands actually executed and their actual results: `pnpm run build` (clean, post-Playwright-removal),
  `pnpm run lint` (0 errors, same 2 pre-existing unrelated warnings), `pnpm run test` (154 tests, unchanged, zero
  regressions), all three demos re-run back-to-back (all exit 0), `git diff --check` (clean). Committed as
  `e3800cc docs: add Safe Replay screenshot from real browser verification`.
- Verification result: PASS for every Phase 5 item — Event Detail loads, the Safe Replay card works end to end
  in a real browser, the changed-decision trace renders correctly, the no-execution message is prominent, no
  console/network errors, the fixture counter is confirmed unchanged after a browser-triggered replay, and a
  sanitized screenshot is captured and committed.
- Known limitations / follow-up risk: the `.main-content` fixed-height-flex-column layout quirk discovered above
  is real and pre-existing (not introduced by Safe Replay) — it can clip a card's visible content when total
  page content is tall enough relative to the viewport, though the DOM content itself remains fully correct and
  accessible (confirmed by re-querying the full page text via component tests and the raw DOM inspection above);
  this was not otherwise in this milestone's authorized scope to fix and is recorded here as a follow-up
  candidate, not silently absorbed into this phase's work. Redacted-source-argument and safe-error UI states
  were not separately re-verified in the browser (only the changed-decision success state was) — those are
  already covered by the Phase 2 component tests, which do exercise real rendering logic, just not a real
  browser DOM. Graphify re-indexing (Phase 6) and full/clean-clone verification gates (Phase 7) have not
  started.
- Unresolved questions: none blocking.
- Exact next action: Phase 6 — re-index with Graphify (`graphify update .`), run the specified path/query
  checks proving the replay execution-path separation and the Control Center → API path, and update
  `docs/GRAPHIFY_VERIFICATION.md` with a new dated section.

### 2026-08-24 — Safe Replay Completion, Phase 6 (Graphify re-index and verification)

- Prompt objective: re-index with Graphify after all implementation/docs/UI changes, run queries covering the
  replay API→service→policy-engine→replay-storage path and the Control Center→API path (including at least one
  path query aimed at proving no-execution separation from the downstream transport/execution path), verify
  every finding against source before acting on it, and update `docs/GRAPHIFY_VERIFICATION.md` accordingly, per
  Phase 6 of the governing prompt.
- Continuity check: re-read ADR-0010 and the Phase 1–5 session-log entries above before starting; confirmed
  local HEAD was `b274103` (Phase 5 screenshot + ledger entry) with a clean tree before making any change.
- Decisions added or changed: none — no new or superseded ADR needed.
- Implementation completed: `graphify update .` rebuilt the graph to 903 nodes / 1135 edges / 54 communities
  (up from 813/987/54 at the end of Milestone 3). One orientation query ("how does the Safe Replay API route
  reach the policy engine") returned a correctly scoped, directly useful result set. Four `path` queries were
  run, every result checked against real source before being trusted:
  1. `control.ts` → `evaluateHistoricalEvent()`: 1 hop, accurate (the route directly calls this function).
  2. `EventDetail.tsx` → `control.ts`: no path (directed or undirected) — consistent with the pre-existing
     Milestone 3 finding that Control Center and the gateway communicate only over HTTP, never a static edge.
  3. `replay.ts` → `executeDownstream()` and `replay.ts` → `ApprovalManager`: **both reported a misleading
     2-hop "path"** (via `replay.ts --imports_from--> pipeline.ts --contains--> executeDownstream()`, and
     similarly for `ApprovalManager`). Verified against source (`grep -n "^import"
     packages/gateway/src/replay.ts`) that `replay.ts`'s only relative import is `extractPrimaryPath,
     extractCommand, extractHost` from `./pipeline.js` — never either symbol. Root cause: Graphify's
     `imports_from`/`contains` edges are file-level, not per-named-export, so any file that imports *anything*
     from a file that also *contains* an unrelated symbol produces a technically-connected but semantically
     misleading path. **No code or claim was changed based on this graph result** — it was checked against
     source first and found to be a graph-granularity limitation, not evidence against the no-execution
     invariant, which continues to rest on the dedicated `replay-no-execution.test.ts` structural test.
  4. `replay.ts` → `evaluate()` (undirected): **no path found**, despite `replay.ts` genuinely importing
     `evaluate` from `@agentgate/policy`. Sanity-checked against `pipeline.ts`, which imports `evaluate` the
     identical way and also shows no path — confirming a general limitation (cross-workspace-package imports,
     resolved by package name rather than relative path, are not resolved into graph edges at all), not a
     `replay.ts`-specific gap or a regression.
  - `docs/GRAPHIFY_VERIFICATION.md` updated with a new "Milestone 4 incremental update" section documenting all
    of the above (exact commands, exact outputs, exact verification steps, and an explicit "net assessment"
    stating that Graphify's path queries alone cannot prove or disprove the no-execution invariant — that proof
    remains the dedicated test suite), and the "Conclusion" section's running node/edge counts and limitations
    list updated to include both newly-confirmed limitations.
  - `graphify-out/` remains gitignored and was not staged or committed; confirmed via `git status --short`
    before and after this phase.
- Files materially changed: `docs/GRAPHIFY_VERIFICATION.md`. No source, test, or other doc file changed in this
  phase.
- Commands actually executed and their actual results: `graphify update .` (903 nodes / 1135 edges / 54
  communities); `graphify query "how does the Safe Replay API route reach the policy engine"`; four `graphify
  path` invocations (listed above); `grep -n "^import" packages/gateway/src/replay.ts` and
  `packages/gateway/src/pipeline.ts` (used to verify/refute the path-query results against real source, not
  assumed). Committed as `51c603f docs: record Milestone 4 Graphify re-index and query verification`.
- Verification result: PASS for the Phase 6 requirement to run the specified queries and verify findings against
  source before changing code/docs — every finding was checked, two were found to be graph limitations (not
  code defects) and documented as such, and no code or unverified claim was changed as a result of a graph
  query alone.
- Known limitations / follow-up risk: none new beyond what is now documented in
  `docs/GRAPHIFY_VERIFICATION.md` itself (file-level edge granularity; no cross-workspace-package import
  resolution; no static frontend/backend edge). Full/clean-clone verification gates (Phase 7) and final
  commits/push/CI observation (Phase 8) have not started.
- Unresolved questions: none blocking.
- Exact next action: Phase 7 — full local verification gates (frozen install, build, lint, complete test suite,
  all three demos, audit/replay chain verification CLI, exact CI secret scan, `git diff --check`), then
  clean-clone verification in a fresh temp directory at the final candidate commit.

### 2026-08-24 — Safe Replay Completion, Phase 7 (full verification gates + clean-clone)

- Prompt objective: run the complete local verification gate against the working tree at its current HEAD, then
  repeat the equivalent gate against an isolated clean clone at the exact same commit, per Phase 7 of the
  governing prompt. Do not substitute a dirty-tree pass for clean-clone verification.
- Continuity check: re-read ADR-0010 and the Phase 1–6 session-log entries above before starting; confirmed
  local HEAD was `9780db6` (Phase 6 Graphify verification + ledger entry) with `git status --short` showing only
  the intentionally-untracked `.claude/` and `CLAUDE.md` before making any change.
- Decisions added or changed: none.
- Implementation completed / commands actually executed and their actual results (working tree, at `9780db6`):
  - `pnpm install --frozen-lockfile` → `Already up to date`.
  - `pnpm run build` → all four buildable packages (`protocol`, `policy`, `control-center`, `gateway`) built
    clean.
  - `pnpm run lint` → 0 errors, 2 pre-existing unrelated `no-explicit-any` warnings (unchanged since Phase 1).
  - `pnpm run test` → **154 tests passing** (52 `packages/policy` + 16 `apps/control-center` + 86
    `packages/gateway`), 0 failures.
  - `node examples/secret-exfiltration/demo.mjs` → exit 0, all assertions PASS.
  - `node examples/downstream-secret-result/demo.mjs` → exit 0, all assertions PASS.
  - `node examples/policy-drift-replay/demo.mjs` → exit 0, all assertions PASS (this demo itself invokes
    `agentgate audit verify` as one of its steps, covering the audit/replay chain verification CLI gate with
    real assertions on both chains' exit code and message content, not merely "ran without crashing").
  - The exact CI tracked-file secret-scan pattern from `security.yml` run manually against the full tracked
    tree → `No credential-shaped strings found outside known placeholders.`
  - `git diff --check` → clean, exit 0.
  - `git status --short` → only `.claude/` and `CLAUDE.md` untracked, nothing else.
- **Clean-clone verification**: `git clone` of the local repository (not a working-directory copy) into an
  isolated temp directory at commit `9780db6`, confirmed via `git log -1`/`git status --short` inside the
  clone before running anything. Full gate repeated inside the clone:
  - `pnpm install --frozen-lockfile` → succeeded (448 packages resolved fresh into the clone's own
    `node_modules`, none reused from the main working tree's install).
  - `pnpm run build` → clean, same output as the working-tree build.
  - `pnpm run lint` → same 0 errors / 2 pre-existing warnings, now reported against clone-local paths.
  - `pnpm run test` → **154 tests passing**, identical count and composition to the working-tree run.
  - All three demos → exit 0 each, inside the clone.
  - **No dependency on local artifacts, verified directly, not assumed**: `ls .claude CLAUDE.md graphify-out`
    inside the clone reported "No such file or directory" for all three — they were never committed, so a fresh
    clone genuinely does not have them, and every gate above still passed without them. This is direct evidence
    (not an inference) that nothing in this milestone's shipped code, tests, or demos depends on this session's
    local `.claude/`/`CLAUDE.md`/Graphify output, or on any pre-existing database/runtime token/dev-only
    environment variable — the clone had none of those and everything still worked.
  - `git diff --check` inside the clone → clean.
  - Clone directory removed after verification; confirmed the main working tree (`C:\Users\chidh\Downloads\
    agentgate`) was untouched throughout (`git status --short` before and after this phase identical: only
    `.claude/`/`CLAUDE.md` untracked).
- Files materially changed: none — this phase is verification-only, no commit was made from it.
- Verification result: **PASS on every Phase 7 item**, both in the working tree and, independently, in an
  isolated clean clone at the exact same commit. This satisfies the explicit instruction not to substitute a
  dirty-tree pass for clean-clone verification — both were actually run, separately, with their own commands and
  their own observed output recorded above.
- Known limitations / follow-up risk: none new. Final commits/push/CI observation (Phase 8) have not started;
  the working tree's current HEAD (`9780db6`) is the publication candidate commit unless further work is added
  before Phase 8's push.
- Unresolved questions: none blocking.
- Exact next action: Phase 8 — push `main` to `origin` (no force), observe GitHub Actions CI/security workflows
  to completion for the pushed HEAD, and produce the final required report.

### 2026-08-24 — Safe Replay Completion, Phase 8 (commits, push, CI)

- Prompt objective: push `main` to `origin` (no force), observe GitHub Actions CI/security workflows to
  completion, fix any real failures via normal follow-up commits and re-verify, per Phase 8 of the governing
  prompt.
- Continuity check: re-read ADR-0010 and the Phase 1–7 session-log entries above before starting; confirmed
  local HEAD was `f303972` with `git status --short` showing only the intentionally-untracked `.claude/`/
  `CLAUDE.md`; `git fetch origin` confirmed `origin/main` (`e1c97a8`) was an ancestor of local HEAD (safe
  fast-forward, no divergence to reconcile) before pushing.
- Decisions added or changed: none.
- Implementation completed:
  - **First push**: `git push origin main` → `e1c97a8..f303972`. GitHub Actions triggered both `CI` (run
    `32743526041`) and `Security` (run `32743525991`).
  - **Security run `32743525991`: all 3 jobs PASS** (CodeQL, tracked-file secret scan, dependency audit).
  - **CI run `32743526041` revealed a real, previously-undetected cross-platform defect**: `build-test
    (windows, node 22)` passed, but both `build-test (ubuntu, node 20)` and `build-test (ubuntu, node 22)`
    failed at the `Test` step — `tests/replay-api.test.ts > ... fails closed (500, sanitized) when the current
    policy file is malformed`, asserting `AssertionError: expected '{"error":"Policy file \"/tmp/agentgat…'
    not to contain '/tmp/agentgate-replay-api-hTSQOD/poli…'`. **Root cause, confirmed with a standalone
    reproduction script comparing `loadPolicyFile()`'s raw error message against the exact `policyPath`
    variable before writing any fix** (not guessed at): `loadPolicyFile()` embeds the raw absolute policy file
    path verbatim in its error message by design (useful for local CLI/log debugging); this message was being
    passed straight through to the Control API's `500` response body for a malformed current policy, on every
    platform. The existing test's `expect(response.body).not.toContain(policyPath)` assertion had a
    Windows-only blind spot that had let this slip through 7 phases of local `pnpm run test` runs on this
    Windows machine: `JSON.stringify()` doubles each backslash in a Windows path when the error is JSON-encoded
    into the HTTP response body, so the naive substring check never matched the escaped form and the test
    passed *by accident*; on Linux, forward slashes need no such escaping, so the identical check correctly
    caught the real leak and failed — cross-platform CI catching exactly the kind of defect it exists to catch.
  - **Fix** (`packages/gateway/src/api/control.ts`): the replay route's `loadPolicyFile()` call is now wrapped
    in its own `try/catch`. On failure, the real error (including the path) is logged locally via
    `console.error` (stderr, never sent over the network — the operator's own machine, running their own local
    tool) for genuine local debugging value, and a generic, path-free error (`'Could not load the current
    policy file — it is missing or invalid. Check the gateway logs for details.'`) is thrown for the HTTP
    response instead. This is the *only* call site changed — the CLI's own `agentgate replay` error output,
    which already legitimately shows local paths in the operator's own terminal on their own machine, is
    unaffected and unchanged; loadPolicyFile()'s underlying error format itself is unchanged, since it is
    correctly useful everywhere else it is used (CLI, startup logs).
  - Strengthened the test (`packages/gateway/tests/replay-api.test.ts`) to check both the raw path and its
    JSON-escaped form (so this specific platform blind spot cannot recur silently), and to assert the exact
    generic message.
  - Full local gate re-run before the second push: `pnpm run build` (clean), `pnpm run lint` (0 errors, same 2
    pre-existing unrelated warnings), `pnpm run test` (154 tests, all passing, including the corrected
    assertion), all three demos re-run (all exit 0), `git diff --check` (clean).
  - **Second push**: `git push origin main` → `f303972..7418e60`. GitHub Actions triggered both `CI` (run
    `32744072456`) and `Security` (run `32744072250`) for the fix commit.
  - **Security run `32744072250`: all 3 jobs PASS** (CodeQL, tracked-file secret scan, dependency audit).
  - **CI run `32744072456`: all 3 jobs PASS** (`build-test (ubuntu, node 20)`, `build-test (ubuntu, node 22)`,
    `build-test (windows, node 22)`) — every step, including the new policy-drift Safe Replay demo step, green
    on all three platform/Node combinations.
- Files materially changed: `packages/gateway/src/api/control.ts`, `packages/gateway/tests/replay-api.test.ts`.
- Commands actually executed and their actual results: as itemized above (`gh run view`/`gh run watch` used to
  observe both runs to actual completion, not assumed). Committed as `7418e60 fix(replay): never leak the local
  policy file path in the API's malformed-policy error`.
- Verification result: PASS — the final pushed remote `HEAD` (`7418e60`) has both `CI` and `Security` GitHub
  Actions workflows green, confirmed by directly observing the completed run status for that exact commit, not
  inferred from the local pass alone. This is the first time in this milestone's work that Ubuntu CI ran this
  specific code path (all of Phases 1–7's local verification happened only on this Windows machine) — exactly
  the scenario cross-platform CI exists to catch, and it did.
- Known limitations / follow-up risk: none new. This defect is a useful reminder that this session's local
  verification, while extensive, was single-platform (Windows) throughout Phases 1–7; the final authoritative
  cross-platform check is always the pushed CI run, not the local one, which is exactly why this phase's
  push-then-observe-then-fix-then-repush cycle exists and was followed exactly as specified rather than treating
  the local Windows pass as sufficient on its own.
- Unresolved questions: none blocking.
- Exact next action: none — produce the final required report for this milestone.
