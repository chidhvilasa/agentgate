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

### ADR-0011: Zero-Friction Onboarding Without New Trust or Execution Surfaces

- Status: ACCEPTED
- Date: 2026-08-25
- Scope: product / security
- Decision:
  1. **Five new CLI commands — `init`, `config validate`, `doctor`, `integrate`, `smoke-test` — add adoption
     convenience without adding any new trust, execution, or network surface.** None of them can execute a
     downstream MCP server, open an external network connection, or weaken a default. `agentgate start` remains
     the only command that ever executes anything.
  2. **`agentgate init` is deterministic and non-interactive only, in this milestone.** A real interactive
     wizard (TTY prompts, live overwrite confirmation) was scoped out as not worth the added surface/complexity
     for a first pass; instead, `init` refuses to overwrite an existing file without an explicit `--force` flag,
     which is a strictly safer default than a prompt a script could accidentally answer wrong. This is a
     deliberate, stated scope reduction, not an oversight — a future milestone could add real interactivity
     behind its own ADR if there is a demonstrated need.
  3. **`agentgate config validate` reuses the exact same loaders as `agentgate start`** (`loadGatewayConfig`,
     `loadPolicyFile`) rather than a second, hand-written validator — a parallel implementation that could
     silently drift from what actually runs is a worse outcome than not having a `validate` command at all.
  4. **`agentgate doctor` is read-only by construction, not just by convention.** The hardest case was the audit
     chain check: `AuditStorage`'s constructor unconditionally runs pending migrations on open, which is itself
     a write. A new export, `readSchemaVersionReadOnly()` (`packages/gateway/src/storage.ts`), opens the SQLite
     file with `better-sqlite3`'s `readonly: true` OS-level flag to check the schema version *before* deciding
     whether it is safe to open via `AuditStorage` at all — doctor only constructs a live `AuditStorage` (to
     reuse the real `verifyChain()`/`verifyReplayChain()`, rather than a second verification implementation)
     when the schema is already fully current, at which point the migration loop is a guaranteed no-op. A
     behind-schema database is reported as a `WARN` with a remediation ("run `agentgate start` once"), never
     silently migrated by doctor itself.
  5. **`agentgate integrate`'s default behavior only ever prints a snippet or writes a brand-new, explicitly
     named file.** Direct mutation of a real client config file is reachable only through an explicit `--apply
     <path>` opt-in, which always creates a timestamped backup before writing, writes atomically (temp file +
     rename), preserves every unrelated top-level key and every unrelated `mcpServers` entry already present,
     and supports `--dry-run` to preview the exact resulting file with zero writes. No code path in this
     milestone ever touches a *real* user's live Claude Code/Antigravity config outside of a test fixture.
  6. **Client support is limited to what was actually verified against current authoritative documentation in
     this session**, not assumed from general MCP convention: `claude-code` against
     `https://code.claude.com/docs/en/mcp` (fetched and read this session — `.mcp.json`, top-level `mcpServers`
     object, `{command, args, env}` per entry) and `antigravity` against
     `https://antigravity.google/docs/ide/mcp/` (also fetched and read this session — `.agents/mcp_config.json`
     workspace-scoped or `~/.gemini/config/mcp_config.json` global, `{command, args, env, cwd, disabled}` per
     entry). A third option, `generic`, is explicitly and permanently labeled unverified in its own output — it
     exists so a user of an unlisted client still gets a starting point, without AgentGate ever implying it
     verified something it did not.
  7. **`agentgate smoke-test` uses a new, dedicated, plain-JavaScript fixture downstream server**
     (`src/onboarding/smokeFixtureServer.mjs`), not the existing test-only fixture
     (`packages/gateway/tests/fixtures/fixture-downstream-server.mjs`), because the smoke test must also work
     from an *installed* package, where `tests/` is never shipped (see the Milestone 5 packaging findings). It
     is deliberately plain JavaScript rather than compiled TypeScript specifically so it works identically
     whether AgentGate is being run from a fresh source checkout (before any build) or from dist — mirroring
     why the pre-existing test fixture is also plain `.mjs`. A new build step,
     `packages/gateway/scripts/copy-assets.mjs`, copies this one file into `dist/onboarding/` as part of
     `pnpm run build`, since `tsc` does not touch non-`.ts` files in `src/`.
  8. **Publishable packages gained a `"files": ["dist"]` field**, and a new script
     (`scripts/verify-packed-install.mjs`) proves — with a real `pnpm pack` and a real `npm install` into an
     isolated temp consumer, not an assumption — that installing all three tarballs together in one `npm
     install` command works end-to-end, including running the installed `agentgate smoke-test`. Installing the
     gateway tarball *alone* was confirmed (before this fix) to fail with a real `npm error 404` for
     `@agentgate/policy`/`@agentgate/protocol`, since `pnpm pack` rewrites `workspace:*` to a bare semver that
     was never published to any registry. This remains a real, documented limitation of the packed-install path
     (see docs/DEVELOPMENT.md) — it is not the same as `npm install agentgate` working from the public registry,
     which is not offered or claimed in this milestone.
- Reason: the milestone's objective is a new developer reaching a verified, working result in minutes, without
  AgentGate's security posture becoming a casualty of that convenience. Every decision above was chosen by
  asking "does this add a way to execute something, contact the network, or silently mutate a file the user
  didn't ask to change" and rejecting the option if the answer was yes.
- Evidence: `packages/gateway/src/onboarding/{init,configValidate,doctor,integrate,smokeTest}.ts`,
  `packages/gateway/src/onboarding/smokeFixtureServer.mjs`, `packages/gateway/scripts/copy-assets.mjs`,
  `scripts/verify-packed-install.mjs`, associated test files, and the dated Milestone 5 session log entries
  below for the exact commands run and their results.
- Alternatives considered:
  - A real interactive `init` wizard (readline-based TTY prompts): deferred — see point 2 above.
  - Reimplementing config/policy validation logic specifically for `config validate` (e.g. to produce prettier
    error messages): rejected — directly risks the exact drift the milestone's own instructions warned against.
  - Letting `agentgate doctor` auto-apply pending database migrations when it finds one: rejected — diagnostics
    tools that quietly change state stop being trustworthy diagnostics; `doctor` reports and remediates, `start`
    (already migrating on open, unchanged) applies.
  - Defaulting `integrate` to writing directly into a client's real config file: rejected outright as the
    default — too easy to corrupt a file the user didn't expect touched; kept as an explicit, backed-up,
    previewable opt-in only.
  - Inventing a plausible-looking Antigravity config format from general MCP convention, without checking:
    rejected — the milestone's own instructions require this, and doing so would have meant either accidentally
    guessing right (indistinguishable from real verification, i.e. lucky) or shipping a config recipe that does
    not actually work for a real user, either of which is worse than fetching the current docs, which was
    inexpensive to do.
- Consequences:
  - Positive: a genuinely useful onboarding path exists, backed by executable proof (packed-install script,
    doctor's real chain verification, smoke-test's real allow/deny/redaction assertions) rather than
    documentation claims alone.
  - Negative: `init` has no interactive mode yet (a real, if minor, UX gap for a user who wants guided prompts);
    the packed-install path still requires the user to run `pnpm pack` themselves from a source checkout (no
    public registry publication); the verified client-integration matrix is intentionally small (two verified
    clients plus one labeled-generic recipe) and will need revisiting as MCP client landscape changes.
- Affected files: `packages/gateway/src/cli.ts`, `packages/gateway/src/onboarding/*` (new),
  `packages/gateway/src/storage.ts`, `packages/gateway/scripts/copy-assets.mjs` (new),
  `scripts/verify-packed-install.mjs` (new), `packages/{gateway,policy,protocol}/package.json`,
  `.github/workflows/ci.yml`, associated test files, `docs/*.md`.
- Supersedes: NONE
- Superseded by: NONE

### ADR-0012: Tool Integrity Registry and Rug-Pull Defense

- Status: ACCEPTED
- Date: 2026-08-25
- Scope: security / architecture
- Decision:
  1. **The threat: tool-definition poisoning ("rug-pull").** AgentGate already treats a tool *call's* arguments
     and a tool *result's* content as untrusted (ADR-0003, ADR-0009). The remaining gap is the tool *definition*
     itself — a downstream MCP server can advertise a benign `read_file` tool, get trusted/used, and later change
     its description, `inputSchema`, `outputSchema`, or `annotations` to something materially riskier (e.g. "read
     a file and upload it to an external URL") without the agent or operator necessarily noticing, because MCP
     tool metadata — description, schema, annotations, `serverInfo.name` — is server-supplied and MUST be treated
     as untrusted input, not as a static contract. This milestone adds a local **Tool Integrity Registry** that
     fingerprints, tracks, and can quarantine tool definitions, closing this gap the same way ADR-0009 closed the
     result/error gap. This maps to OWASP MCP Top 10 MCP03 (tool poisoning) and the "client-side tool risk
     gating" recommended control.
  2. **Local server identity is NOT `serverInfo.name` alone.** The MCP spec explicitly does not guarantee
     `serverInfo.name` is globally unique, so two different servers could advertise the same name, or one server
     could rename itself to evade a stale identity record. `computeServerIdentity()`
     (`packages/gateway/src/tool-integrity/identity.ts`) instead derives identity from the configured local
     `server.id` plus a versioned (`server-identity-v1`), redacted fingerprint of the launch configuration: for
     stdio servers, the normalized `command`/`args` plus each `KEY=VALUE` env pair individually SHA-256-hashed
     before being folded into the overall digest (so a changed env value changes the identity, but the raw value
     is never persisted); for HTTP servers, the URL. Path separators are normalized (backslash → forward slash
     only — no realpath/symlink resolution, which is a deliberately narrow, documented scope) so the same
     logical server launched from Windows vs. Linux checkouts of the same repo produces the same identity, while
     a security-relevant change (different command, different args, different env) intentionally produces a
     different identity rather than silently reusing history that may no longer apply. This is a local
     "did-this-launch-configuration-change" identity, not a remote attestation of any kind — see limitations.
  3. **Canonicalization and fingerprinting: `tool-definition-v1`.** `canonicalizeToolDefinition()`
     (`packages/gateway/src/tool-integrity/canonicalize.ts`) fingerprints the ENTIRE tool object as returned by
     `tools/list` — every field present (`name`, `title`, `description`, `inputSchema`, `outputSchema`,
     `annotations`, and any other field, known or unknown) — rather than a hand-picked allowlist, so a malicious
     server cannot smuggle a meaningful change through a field this project's authors didn't think to check. The
     raw tool object is first passed through the existing `sanitizeJsonValue()` primitive (ADR-0009) for
     depth/size/node-budget/circular-reference/prototype-pollution-key safety and secret-pattern redaction, then
     object keys are recursively sorted (arrays keep their original order, since order is semantically meaningful
     for JSON Schema `required`/`enum` and similar), then the canonical JSON is SHA-256-hashed together with the
     algorithm version string. A whole-manifest fingerprint (`canonicalizeManifest()`) additionally sorts tools
     by name and fails closed on an exact-case or case-confusable duplicate tool name (e.g. `"Foo"`/`"foo"`),
     since MCP tool names are case-sensitive and a server advertising both is a suspicious condition worth
     surfacing rather than silently accepting. This is a fingerprint, not a signature: it proves local
     byte-for-byte (post-canonicalization) equality to a previously observed definition; it says nothing about
     authorship or runtime behavior. One narrow, deliberate trade-off: a change confined ENTIRELY to a redacted
     secret's characters, with everything else byte-identical, does not by itself change the fingerprint, because
     the redaction pass runs before hashing — this is documented, not hidden, and is the same trade-off ADR-0009
     already accepted for result/error sanitization.
  4. **Enrollment/trust modes, and the actual default.** `tool_integrity.mode` in `GatewayConfigSchema`
     (`packages/gateway/src/config/registry.ts`) is one of:
     - `explicit` — every new or changed definition is quarantined until a human explicitly accepts its exact
       fingerprint. Recommended, high-security mode.
     - `tofu` — a tool's first-ever observed definition is trusted automatically ("trust on first use"); any
       LATER change to an already-trusted tool is quarantined exactly like `explicit`.
     - `monitor` — drift is still detected, classified, and recorded (visible in `agentgate tools status`, the
       Control API, and the Control Center), but never blocks discovery or calls. Reporting only, and the config
       schema's own doc comment and all UI/CLI copy referring to this mode say so explicitly — it is never
       described as protection.
     - `disabled` — the registry is not consulted for enforcement at all; behavior is identical to every
       AgentGate version before this milestone.
     **`monitor` is the default** when `tool_integrity` is omitted entirely. This is a deliberate backwards-
     compatibility trade-off, made honestly rather than silently: the milestone's own instructions require
     "explicit enrollment" to be the *recommended* high-security mode, which it is — `monitor` is the *default*
     specifically so that every config file and every one of the 211 tests/3 demos/smoke-test that predate this
     milestone keep working unmodified with zero new blocking behavior on upgrade, instead of every existing
     AgentGate user's tools silently going quarantined (and every existing demo/test breaking) the moment they
     pull this change. A user who wants the stronger guarantee opts in with one line
     (`tool_integrity: { mode: explicit }`) — see docs/POLICY_REFERENCE.md for the exact migration guidance this
     ADR requires be documented honestly alongside the default.
  5. **Quarantine is enforced in the gateway request path in BOTH directions, not just shown in the UI.**
     `packages/gateway/src/transport/stdio.ts` wires two independent gates from
     `packages/gateway/src/tool-integrity/enforcement.ts`:
     - `filterTrustedTools()` — the `tools/list` handler exposes only tools whose CURRENT registry state is
       `trusted` with `current_fingerprint === trusted_fingerprint`, in an enforcing mode (`explicit`/`tofu`).
       Annotations on the raw tool object (e.g. `readOnlyHint`, `destructiveHint`) are never consulted for this
       decision — the MCP spec and OWASP guidance both say annotations are untrusted hints, not enforcement
       guarantees, so trusting them to lower risk would defeat the entire point of this milestone.
     - `checkCallAllowed()` — the `tools/call` handler checks this gate BEFORE any policy evaluation or
       `runPipeline()`/`executeDownstream()` call, for every incoming call regardless of whether the calling
       client's `tools/list` response ever included the tool. This specifically defeats the "client cached an
       old/wrong tool list and calls it directly by name anyway" bypass the milestone named as a non-negotiable
       invariant. A tool AgentGate has never scanned at all fails closed (blocked, not "assume trusted because we
       have no record"). `packages/gateway/tests/tool-integrity-gateway-enforcement.test.ts` is the executable
       proof: it spawns the real compiled gateway binary, connects a real MCP `Client` over stdio (exactly as a
       real agent would), confirms `tools/list` is empty pre-review, confirms a direct `tools/call` by name is
       blocked with an external, process-independent proof the downstream fixture server's call counter stayed at
       `0`, then accepts the exact candidate out-of-process (mirroring the CLI/Control API/UI) and confirms the
       SAME already-open client connection can now call the tool successfully and the counter becomes `1` —
       proving enforcement re-reads registry state fresh on every call rather than caching a startup-time
       decision.
  6. **Scan timing: mandatory scan at every gateway startup, plus on-demand rescan — no dependency on
     `notifications/tools/list_changed`.** AgentGate's documented MCP compatibility boundary is legacy-2025 stdio
     only (ADR-0005); this milestone does not change that boundary or claim newer protocol support merely because
     newer MCP spec pages were consulted for security design. A server MAY send
     `notifications/tools/list_changed`, but detection must not depend solely on receiving one — so AgentGate
     does not attempt to handle that notification at all in this milestone. Instead, `scanDownstreamServer()`
     (`packages/gateway/src/tool-integrity/scan.ts` — the ONLY Tool Integrity module that ever connects to a
     downstream server, proven structurally by
     `packages/gateway/tests/tool-integrity-no-execution.test.ts`) runs unconditionally at gateway startup (a
     safe, mandatory lifecycle point independent of any notification), with pagination handling for
     `tools/list`'s `nextCursor` (the installed SDK's `Client.listTools()` does not auto-paginate — confirmed by
     reading the SDK source directly — this was also a real, pre-existing single-page-only bug in the prior
     discovery code, fixed as part of this milestone rather than left to diverge from the new registry's
     paginated model) capped at `MAX_PAGES = 200` to fail closed against a malicious/misbehaving server. An
     operator or the Control Center can trigger an out-of-band rescan at any time via `agentgate tools scan`, the
     `POST /api/tool-integrity/rescan` Control API route, or the Control Center's "Rescan now" button — none of
     which ever call a tool (only `initialize`+`tools/list`).
  7. **Residual scan-to-call TOCTOU is not eliminated, and is documented, not hidden.** Between one scan and the
     next tool call, a downstream server could in principle change its definition and the gateway would still
     enforce against the last-scanned fingerprint until the next scan/rescan observes the change. This is a real,
     acknowledged limitation of a scan-based (vs. per-call-reverification) model, traded off deliberately against
     the cost of re-fetching and re-canonicalizing the full tool manifest on every single call, which would make
     ordinary tool use far more latent for a benefit (closing a narrow timing window) that a rescan already
     narrows to "since the last scan" rather than "ever." Full elimination would require either revalidating on
     every call (a real, available, but not-yet-made design choice for a future milestone) or genuine remote
     attestation, which is out of scope — see limitations below.
  8. **Exact-fingerprint acceptance/rejection prevents stale-approval races.** Every review action
     (`acceptCandidate()`/`rejectCandidate()` in `packages/gateway/src/tool-integrity/registry.ts`, and every CLI
     `trust`/`reject` command and Control API `accept`/`reject` route built on top of them) requires an EXACT
     match of both a deterministic `candidate_id` (`sha256(serverIdentity:toolName:fingerprint).slice(0,16)`) AND
     the `fingerprint` itself against the CURRENTLY stored candidate for that tool. If the tool has drifted again
     since the reviewer last looked (candidate B superseding candidate A), an attempt to accept/reject using
     stale candidate A's id/fingerprint is rejected outright (`"Stale or unknown candidate..."`), never silently
     applied against whatever the current candidate happens to be. There is deliberately no name-only or
     "trust-all" acceptance path anywhere in the CLI, Control API, or Control Center — every accept/reject call
     site in this codebase requires both values. `tests/tool-integrity-registry.test.ts`,
     `tests/tool-integrity-cli.test.ts`, and `tests/tool-integrity-api.test.ts` each include a dedicated stale-
     approval-race test proving this.
  9. **Append-only history + mutable current-state projection (two-table pattern, matching ADR-0004, not
     ADR-0010).** `tool_integrity_events` is a hash-chained, append-only table (mirroring the existing
     `audit_events`/replay-evaluation hash-chain pattern — `insertToolIntegrityEvent()`/
     `verifyToolIntegrityChain()` in `packages/gateway/src/storage.ts` follow the exact same chaining and
     verification approach already used for the audit and replay chains). `tool_integrity_state` is a separate,
     explicitly-documented MUTABLE projection over that log — one row per `(server_identity, tool_name)` —
     needed because gateway enforcement (every `tools/list` and every `tools/call`) needs a cheap, fast
     "is this trusted right now" lookup that a full event-log replay on every request would make prohibitively
     slow. This is the same two-table design ADR-0004 chose for `audit_events`/`audit_lifecycle_records`, and
     deliberately NOT the single-table pattern ADR-0010 chose for `replay_evaluations` — replay evaluations have
     no meaningful "current state" to project, but tool trust status does. Accepting a candidate never rewrites
     or deletes the prior trusted baseline's row in the append-only log; it only updates the projection and
     appends a new `accepted` event. Rejecting a candidate leaves `trusted_fingerprint` untouched entirely.
     Reappearance after `removed` ALWAYS requires fresh review (`pending_review`), even if the fingerprint
     exactly matches the old trusted baseline — a server disappearing and reappearing is itself treated as a
     signal worth a human look, a deliberate conservative choice, not an oversight. A rejected tool that
     reappears with the SAME rejected fingerprint stays `rejected` (not silently reset); a GENUINELY different
     fingerprint opens a fresh `drifted` review cycle rather than being permanently stuck.
  10. **Bounded, safe diff — never a rendering/execution surface.** `packages/gateway/src/tool-integrity/diff.ts`
      is a pure, side-effect-free module (no I/O, no MCP SDK — proven by the same structural no-execution test as
      the rest of Tool Integrity) that walks two already-canonicalized definitions in lockstep and produces a
      deterministic, depth-bounded (`MAX_DEPTH = 12`), count-bounded (`MAX_CHANGES = 200`), string-truncated
      (`MAX_VALUE_PREVIEW_CHARS = 300`) list of `{path, kind, before?, after?}` records. It never executes,
      interprets, or renders anything beyond returning plain string data — hostile content (prompt-injection
      phrasing, HTML/`<script>` tags, ANSI escape sequences, prototype-pollution-shaped keys, embedded secret-
      shaped strings, deeply nested or huge schemas) is preserved as inert string data all the way through the
      diff, CLI, Control API, and Control Center, which renders it only as plain React text (never
      `dangerouslySetInnerHTML`) with an explicit on-page warning that everything shown is untrusted, server-
      supplied content. Secret-shaped substrings are redacted upstream by `canonicalizeToolDefinition()` before
      the diff ever sees them (ADR-0009's existing redaction path), so the diff module's own hostile-input tests
      focus on boundedness/safety rather than redaction (which is not its job).
  11. **Fail-closed everywhere a decision cannot be made safely.** A scan failure, malformed/oversized/deeply-
      nested schema, duplicate or case-confusable tool name, unknown/never-scanned tool, or Tool Integrity storage
      lookup failure all resolve to "not callable" in an enforcing mode — never to "assume trusted since we don't
      know better." A scan failure is itself recorded as a `scan_failed` event (visible in history), not silently
      dropped to a console warning only.
- Reason: AgentGate's stated purpose is to be the trust boundary between an AI agent and the tools it can call.
  ADR-0003/ADR-0009 already established that a tool CALL's arguments and a tool RESULT's content must be treated
  as untrusted; leaving the tool DEFINITION itself unverified after first use would have left the single largest
  remaining gap in that boundary unaddressed, and directly matches a named, real-world MCP attack pattern (OWASP
  MCP03) rather than a hypothetical one.
- Evidence: `packages/gateway/src/tool-integrity/*` (new: `identity.ts`, `canonicalize.ts`, `scan.ts`,
  `registry.ts`, `enforcement.ts`, `diff.ts`, `cli.ts`, `types.ts`), `packages/gateway/src/{storage,server,cli,
  transport/stdio}.ts`, `packages/gateway/src/{config/registry,onboarding/smokeTest}.ts`,
  `packages/gateway/src/api/control.ts`, `apps/control-center/src/{api.ts,pages/ToolIntegrity.tsx,App.tsx,
  index.css}`, every `packages/gateway/tests/tool-integrity-*.test.ts` file (canonicalization golden fixtures,
  identity, registry state machine, diff hostile fixtures, no-execution structural proof, CLI lifecycle, Control
  API security/concurrency, and the real end-to-end gateway-path enforcement proof), and
  `apps/control-center/src/pages/ToolIntegrity.test.tsx`. Exact counts and gate results are recorded in the
  session log entries below.
- Alternatives considered:
  - Trusting `serverInfo.name` as server identity: rejected — the spec explicitly does not guarantee uniqueness;
    see point 2.
  - Hand-picking which tool-definition fields to fingerprint (e.g. only `description`+`inputSchema`): rejected —
    creates a predictable blind spot (e.g. a change confined to `annotations` or a future SDK field would go
    undetected); the whole object is fingerprinted instead.
  - Defaulting new/existing configs to `explicit` mode: rejected as the DEFAULT for backwards compatibility (see
    point 4), but documented as the recommended opt-in, with a one-line migration path.
  - Implementing `notifications/tools/list_changed` handling: rejected for this milestone — AgentGate's
    documented protocol boundary (ADR-0005) does not depend on it, and the spec itself says detection must not
    depend solely on receiving it; a mandatory-scan-at-safe-lifecycle-points model was chosen instead.
  - Re-verifying the tool definition on every single call (fully eliminating scan-to-call TOCTOU): rejected for
    this milestone on latency-cost grounds — see point 7 — but left as a documented, viable future option rather
    than dismissed.
  - A single append-only table (ADR-0010's pattern) for Tool Integrity: rejected — tool trust state has a
    meaningful "current state" that gateway enforcement needs to read cheaply on every request; see point 9.
- Consequences:
  - Positive: a real, demonstrated (see the rug-pull demo, `examples/tool-rug-pull/demo.mjs`) defense against
    tool-definition poisoning now exists, enforced in the actual gateway request path, not only surfaced as a
    dashboard warning; every review action is tied to an exact fingerprint, preventing stale-approval mistakes;
    existing users are not silently broken on upgrade.
  - Negative: the default (`monitor`) mode provides no blocking protection by itself — an operator must
    explicitly opt in to `explicit`/`tofu` to get enforcement, which is a real adoption-friction trade-off, stated
    honestly rather than glossed over; scan-to-call TOCTOU is not fully eliminated (point 7); a privileged local
    administrator with direct database access could still tamper with or replace the Tool Integrity database,
    exactly as ADR-0004 already states for the audit chain — this is local tamper EVIDENCE, not tamper-PROOF
    security, and is not a stronger claim than ADR-0004 already makes for the rest of AgentGate's storage.
- Limitations (stated explicitly, not implied):
  - Fingerprints are cryptographic hashes of a canonicalized local representation, NOT signatures — they prove
    local byte-for-byte equality to a previously observed definition, nothing about who authored it.
  - A stable/unchanged fingerprint does NOT prove the server's actual runtime behavior matches its advertised
    definition, or that the server is safe — a compromised downstream server can still return a poisoned tool
    RESULT with an entirely unchanged tool DEFINITION; the existing ADR-0009 output-sanitization boundary remains
    the relevant defense for that separate threat, and Tool Integrity does not replace or weaken it.
  - Local server identity (point 2) is a local configuration-based identity, not remote attestation of any kind —
    it cannot prove which physical/cloud process is actually running, only that the local launch configuration
    used to reach it has not changed.
  - Annotations (`readOnlyHint`, `destructiveHint`, etc.) are server-supplied, untrusted hints per the MCP spec
    and are never used by enforcement to reduce risk, but the registry's storage of them is still exactly what
    the server chose to advertise.
  - Local tamper evidence (the hash chain) is not tamper-proof against a privileged local administrator with
    direct database file access — identical in kind to the limitation ADR-0004 already states for the audit
    chain.
  - Scan-to-call TOCTOU is not fully eliminated (point 7).
  - This milestone does not implement, and does not claim: full MCP supply-chain security, remote attestation,
    cryptographic signing of tool definitions, sandboxing of downstream servers, verification of runtime
    behavior, or zero false positives (a legitimate, security-irrelevant server update, e.g. a typo fix in a
    description, still produces drift requiring review in an enforcing mode).
- Affected files: `packages/gateway/src/tool-integrity/*` (new), `packages/gateway/src/{storage,server,cli,
  config/registry,onboarding/smokeTest}.ts`, `packages/gateway/src/transport/stdio.ts`,
  `packages/gateway/src/api/control.ts`, `apps/control-center/src/{api.ts,App.tsx,index.css,
  pages/ToolIntegrity.tsx}`, `examples/tool-rug-pull/demo.mjs` (new), associated test files, `docs/*.md`.
- Supersedes: NONE
- Superseded by: NONE

### ADR-0013: Context Guard — Cross-Tool Session-Risk Escalation Defense

- Status: ACCEPTED
- Date: 2026-08-28
- Scope: security / architecture
- Decision:
  1. **The threat: cross-tool indirect prompt injection / confused deputy.** ADR-0003/ADR-0009/ADR-0012 already
     treat one tool CALL's arguments, one tool RESULT's content, and one tool DEFINITION as individually untrusted.
     The remaining gap is a SEQUENCE across multiple calls: an agent reads untrusted content from tool A (e.g. a
     ticket body, a web page, a file) that contains an indirect prompt-injection payload instructing the agent to
     read sensitive data with tool B and exfiltrate it with tool C — each individual call can look policy-legal in
     isolation (A is a normal read, B is a normal read, C is a normal external send), while the SEQUENCE is the
     actual attack. This is the MCP "confused deputy" / cross-tool escalation pattern named in OWASP MCP guidance.
     Context Guard closes this by letting operator policy attach conservative, coarse-grained risk LABELS to a
     local execution context based on which tools were called and what kind of result they returned, then letting
     a later call's own declared EFFECT labels be checked against those accumulated context labels before the
     later call is allowed.
  2. **Explicit non-goal: this is not model-reasoning inspection or causal proof.** Context Guard never reads,
     inspects, or reasons about the upstream LLM's prompts, completions, chain-of-thought, or any model-internal
     state — AgentGate has no access to any of that; it only sees the MCP JSON-RPC `tools/call` requests and
     results that actually cross the gateway. A label is a POLICY ASSERTION triggered by an observed gateway
     event ("tool X's call succeeded with a non-blocked result, and operator policy classifies that as
     `untrusted_content`"), never a claim that the injection actually happened, that the model "read" or "acted
     on" anything, or that one call causally caused a later one. Two calls sharing one context is correlation by
     connection, not proof of causation. This distinction is stated on every context-facing surface (CLI/API/UI,
     when built) and is treated as a documentation requirement, not an implementation detail to gloss over.
  3. **Exact execution-context boundary: one gateway process = one stdio connection = one context, today.**
     `startGateway()` (`packages/gateway/src/server.ts`) generates one opaque `contextId` (`crypto.randomUUID()`)
     and creates the context (`createContext()`, `context-guard/state.ts`) once, before `startStdioProxy()` is
     ever called — before any `tools/call` can reach the handler. That one context is captured in the single
     `PipelineContext` object (`ctx`) closed over by every `CallToolRequestSchema` handler invocation for the
     lifetime of that one stdio connection/process. This is the most precise boundary the current architecture
     actually supports honestly: AgentGate's documented protocol boundary (ADR-0005) is legacy-2025 stdio only,
     one gateway process per launch, one upstream client connection per process — there is no multi-connection or
     multi-tenant stdio server in this codebase to build a finer-grained per-connection boundary against. A
     context is NOT a model-conversation identifier and does not attempt to be one: one stdio connection may
     correspond to many, or to only part of, one upstream conversation, depending entirely on how the calling MCP
     client manages its own session — this is a named, explicit limitation, not an implied guarantee.
  4. **Context ID, revision, lifecycle, reconnect, restart, concurrency.** `context_id` is a locally-generated
     UUID, opaque to any upstream party — never derived from or exposed to the model. `revision` is a strictly
     monotonic integer (`context-guard/state.ts`): every transition that changes labels, or that resets/expires/
     closes the context, increments it by exactly 1; it is never decremented and never reused. Status is one of
     `active` / `expired` / `reset` / `closed` (`ContextStatus`, `context-guard/types.ts`). Lifecycle:
     **created** before the first call can be evaluated (point 3); **closed** on the same connection's stdio
     transport actually closing or erroring (`server.onclose`/`server.onerror` in `transport/stdio.ts`,
     `closeOrExpireContext(..., 'closed')`) OR on process shutdown signal (`SIGINT`/`SIGTERM` in `server.ts`) —
     `closeOrExpireContext()` is itself idempotent (a no-op once status is no longer `active`), so whichever of
     those two fires first performs the real transition and the other is a safe no-op, never a double-transition
     or a race that corrupts state; **reset** only via an explicit, reviewer-attributed, exact-revision-matched
     administrative action (point 10). **Reconnect/restart**: a NEW gateway process launch always creates a NEW
     `contextId` — there is no persistent "the same logical connection resumed its old context" concept in this
     milestone; a restarted gateway starts with a genuinely fresh, empty-label context, which is the conservative,
     correct default (see point 2's causation caveat — even if it could persist across restarts, doing so would
     not fix the "not proof of causation" limitation and would raise its own staleness/reuse risk). **Concurrency**:
     within one Node.js process, better-sqlite3 is synchronous and every individual state-transition function in
     `context-guard/state.ts` (`appendContextLabels`, `recordCallEvaluation`, `resetContext`,
     `closeOrExpireContext`) contains no `await` between its read of current state and its write — so JavaScript's
     single-threaded execution model already guarantees no other same-process code can interleave and corrupt one
     transition. Two DIFFERENT concurrent `tools/call` requests each independently read CURRENT context state
     fresh at their own evaluation point (never a cached/shared in-memory value), so neither can silently act on
     state staler than what the database held at the moment it actually read — see point 12 for the residual
     cross-request race this does NOT eliminate.
  5. **Policy-owned source/effect labels — never a fixed, hardcoded taxonomy.** `context_guard.labels` in
     `GatewayConfigSchema` (`packages/gateway/src/config/registry.ts`) lets an operator declare custom labels
     beyond the built-in vocabulary (`BUILTIN_CONTEXT_LABELS`: `untrusted_content`, `sensitive_data_accessed`,
     `prompt_injection_suspected`; `BUILTIN_EFFECT_LABELS`: `external_communication`, `destructive_write`,
     `code_execution`, `credential_use`, `privilege_change`, `sensitive_read`). Per-tool `context_guard.tools.<name>`
     declares `effects` (what this tool's CALL itself does, checked against the active context's labels before
     allowing) and `adds_on_result` (what labels a SUCCESSFUL, non-blocked result adds to the context afterward).
     Every label reference anywhere in config (`tools.*.effects`, `tools.*.adds_on_result`, `rules.*.when.*`) is
     validated against the built-in set plus declared custom labels at config-parse time (`ContextGuardSchema`'s
     `superRefine`) — an unknown label fails config validation, not silently becomes a no-op at runtime.
  6. **Why MCP annotations remain untrusted and can never lower risk.** Tool `annotations` (`readOnlyHint`,
     `destructiveHint`, etc.) are server-supplied metadata under the MCP spec's own wording — the same reasoning
     ADR-0012 point 5 already applies to Tool Integrity's trust decisions applies here identically: a downstream
     server could freely advertise `readOnlyHint: true` on a tool that is not actually read-only, and Context
     Guard's enforcement code never reads or consults `annotations` for ANY decision — effect/source labels are
     exclusively OPERATOR-declared config (point 5), computed independently of whatever the server claims about
     itself. A malicious or buggy server cannot self-report its way to a lower risk classification.
  7. **Monotonic state: labels only ever accumulate; no automatic downgrade.** `appendContextLabels()`
     (`context-guard/state.ts`) computes the UNION of existing and new labels — labels are never removed except by
     an explicit, reviewer-attributed `resetContext()` (point 10), and even a reset does not delete history, only
     clears the ACTIVE label set going forward while `context_events` keeps every prior `label_added` row forever.
     If every label in one call's `adds_on_result` is already present, this is a documented no-op (no new event,
     no revision bump) — context history stays proportional to REAL change, not to every call that happens to
     re-observe an already-known label.
  8. **Exact transition timing per outcome.** `runPipeline()`'s label-append step (`pipeline.ts`, step 8) fires
     ONLY when `finalStatus === 'SUCCEEDED' && !resultBlocked` — i.e. the call actually reached the downstream
     server, returned without a transport/execution error, AND its result was not entirely replaced by output
     security (ADR-0009). A DENIED, CANCELLED, or EXPIRED call never reached downstream at all, so it adds no
     labels. A FAILED (downstream execution threw) call returned no usable result, so it adds no labels. A
     result-BLOCKED call means nothing the label would describe actually reached the agent, so it adds no labels
     either — this is deliberately conservative: a REDACTED-but-still-delivered result DOES still add its
     configured labels (content beyond the redacted secret pattern still reached the agent), which is the one
     place this milestone accepts under-counting risk (a redacted result is treated the same as a clean one for
     labeling purposes) rather than ever inventing a label for content nobody actually received. A
     `call_evaluated` history event (point 11) is recorded for EVERY contextually-evaluated call regardless of
     outcome or mode, so `monitor`-mode "what would have happened" and denied/errored calls are still visible in
     history even though they never mutate labels.
  9. **Evaluation order.** Traced in source and reproduced here exactly (see `packages/gateway/src/transport/
     stdio.ts` and `packages/gateway/src/pipeline.ts`):
     1. Request validation / argument normalization (`pipeline.ts` step 1).
     2. **Tool Integrity quarantine gate** (`checkCallAllowed()`, `transport/stdio.ts`) — runs BEFORE
        `runPipeline()` is even called; a call to a tool that is not currently trusted (in an enforcing mode)
        never reaches ANY of the steps below, for every call including one by a client using a cached/direct tool
        name that was never returned by `tools/list`.
     3. **Base policy decision + input secret checks** — `evaluate(policy, input)` (`pipeline.ts` step 4); input
        secret detection (`contains_secrets`) is part of this same policy-engine evaluation, not a separate gate.
     4. **Context Guard evaluation** (`pipeline.ts` step 4.5) — `evaluateContextGuard()` reads the CURRENT context
        labels (fresh from storage, point 4) and evaluates `context_guard.rules` (`evaluateContextualRules()`,
        first-match, deterministic, mirroring the base policy engine's own semantics) against the attempted call's
        declared `effects`. The result is combined with the base policy decision via `isAtLeastAsStrict()`
        (`context-guard/rules.ts`) — Context Guard's action REPLACES the effective decision ONLY if it is at
        least as strict (`ALLOW < REQUIRE_APPROVAL < DENY`); a base-policy DENY can never become a contextual
        ALLOW or REQUIRE_APPROVAL, and an already-REQUIRE_APPROVAL base decision can never be silently downgraded
        to ALLOW by a non-matching contextual rule. This is always COMPUTED and RECORDED (point 11), even in
        `monitor` mode, but only actually APPLIED to the effective decision when `mode === 'enforce'`
        (`modeEnforces()`).
     5. **Exact contextual approval, if required** (`pipeline.ts` step 5) — see point 10.
     6. **Revalidate context/approval binding immediately before execution** (`checkApprovalContextValid()`,
        `pipeline.ts`, immediately after a human APPROVED decision is observed) — see point 10.
     7. **Downstream call** (`executeDownstream()`, `pipeline.ts` step 6) — only reached after every gate above has
        passed.
     8. **Result/error safety inspection** (`sanitizeToolResult()`, ADR-0009, `pipeline.ts` step 7) — runs on the
        raw downstream result BEFORE it is ever returned to the upstream client or referenced by anything else.
     9. **Append context transitions** (`pipeline.ts` step 8) — deterministic, outcome-gated (point 8), always
        AFTER the storage write of the terminal event status so the linked `source_event_id` always refers to an
        already-persisted, already-redacted audit event.
     10. **Audit/SSE publication** — every intermediate status transition in `runPipeline()` follows the same
         fixed order: storage write (`updateEventStatus`) → re-fetch (`getEvent`) → SSE emit (`ctx.emitEvent`),
         consistently, for every terminal and intermediate state, so a subscriber never observes an SSE event for
         a state that isn't yet durably persisted.
     This is the actual implemented order, not a design aspiration — verified by direct source reading, not
     inferred from comments alone.
  10. **Exact contextual approval binding and revalidation.** When Context Guard's effective decision is
      REQUIRE_APPROVAL, `ApprovalManager.create()` (`approval.ts`) is given an optional `contextBinding`
      (`pipeline.ts` step 5) recording the EXACT `context_id`, `context_revision` observed AT THAT MOMENT,
      `argument_digest` (`computeArgumentDigest()` — SHA-256 of the REDACTED arguments, never raw), and the
      `contextual_rule_id` that required it (`'base-policy'` if the base policy itself required approval with no
      contextual escalation), and (**Amended 2026-08-28** — see the CLI/API session log entry below for the exact
      call sites and tests; the design intent stated at the time of the original decision did not change, only its
      completion) `tool_fingerprint`: the EXACT currently-trusted Tool Integrity fingerprint for the resolved
      downstream server/tool, read via `getTrustedFingerprint()` (`tool-integrity/enforcement.ts` — the same
      `status === 'trusted' && current_fingerprint === trusted_fingerprint` condition `checkCallAllowed()` uses,
      never a client-supplied value). Every field is nullable and a pre-Milestone-7 (or non-contextual) approval simply has
      `null` in all of them, meaning "not context-bound," which every consumer must treat as valid and ordinary,
      never as an error. At CONSUMPTION time — immediately before downstream execution, after a human has already
      clicked "approve" — `checkApprovalContextValid()` (`context-guard/enforcement.ts`) re-reads CURRENT context
      state fresh and fails closed if: the bound context no longer exists; the current revision no longer exactly
      matches the revision recorded at approval-creation time (the context accumulated more risk in the window
      between creation and a human's decision); the argument digest no longer matches (arguments changed); the
      tool's CURRENT trusted fingerprint (re-read fresh via `getTrustedFingerprint()`, never reused from
      creation time) no longer matches the fingerprint bound at creation — catching drift, quarantine, rejection,
      or removal in that same window, and failing closed even though the approval itself already shows APPROVED;
      or the tool name no longer matches the approval's `scope`. A `null` bound `tool_fingerprint` (no trusted
      definition existed at creation time) skips this specific check, exactly like a `null` `argument_digest` —
      a binding that was never made cannot be violated; this is a defense-in-depth addition alongside, never a
      replacement for, Tool Integrity's own independent `checkCallAllowed()` gate, which re-verifies trust on
      every call regardless of Context Guard. This closes the create-time/consume-time window a
      naive "check once at creation" design would leave open. Approval consumption remains single-use
      (pre-existing `consumed` flag, ADR unchanged) and TTL-bound (pre-existing `expires_at`); an approval never
      clears context labels or grants any future call permission — it authorizes exactly the one call it was
      created for, once.
  11. **Append-only history, mutable projection, local tamper evidence.** Same two-table pattern as ADR-0012 point
      9 and ADR-0004: `context_events` is a hash-chained (`sha256`, canonicalized payload, same `canonicalize()`/
      chaining primitives already used for the audit and Tool Integrity chains), append-only, sequence-numbered
      log — every `context_created`/`label_added`/`call_evaluated`/`context_reset`/`context_expired`/
      `context_closed` transition is recorded, never mutated or deleted. `context_state` is a MUTABLE projection
      (one row per `context_id`) needed because every `tools/call` needs a cheap "what labels does the active
      context have right now" lookup, which a full event-log replay on every call would make prohibitively slow.
      `verifyContextChain()` (`storage.ts`) independently re-walks the chain exactly like
      `verifyToolIntegrityChain()`/`verifyChain()`, detecting tampering (hash mismatch), deleted rows (sequence
      gap), and reordered rows (broken hash link) — this is local tamper EVIDENCE, identical in kind and in
      limitation to what ADR-0004/ADR-0012 already state: not tamper-PROOF against a privileged local
      administrator with direct database file access. Only label NAMES (bounded, policy vocabulary),
      safe/bounded `reason` strings, and already-redacted `source_event_id` linkage are ever stored — raw tool
      arguments, raw tool results, and any prompt-injection text are never written into `context_events` or
      `context_state` by any code path in `context-guard/state.ts` or the `pipeline.ts` call site that invokes it.
  12. **Expiry/reset semantics — and resetting AgentGate cannot erase client/model memory.** `resetContext()`
      (`context-guard/state.ts`) requires an EXACT current-revision match (the same stale-revision protection
      pattern as Tool Integrity's exact-fingerprint accept/reject, ADR-0012 point 8) plus a reviewer identity and
      a reason string — both mandatory, both recorded in the append-only history — and clears the ACTIVE label set
      going forward while never deleting the prior `label_added`/`call_evaluated` history. A stale reset request
      (formed against a revision that has since advanced) is rejected outright, never silently applied against
      whatever the current revision happens to be, so a reset cannot be used to "wash away" risk labels the
      requester didn't actually see at request time. **This reset is entirely local, gateway-side state** — it
      has no ability whatsoever to erase or affect anything the upstream LLM or MCP client itself remembers from
      before the reset (its own conversation history, cached tool results, or reasoning already produced); every
      context-facing surface (CLI help text, API responses, UI copy, when built) is required to state this
      explicitly rather than let a user infer that resetting AgentGate resets the agent's own memory too. `expiry`
      (TTL-based, `closeOrExpireContext(..., 'expired')`) is implemented as a state-machine transition but is not
      yet wired to an active timer/scheduler in this milestone — `context_state.expires_at` exists in the schema
      for a future TTL-enforcement pass; today expiry only actually fires via an explicit call to
      `closeOrExpireContext()`.
  13. **Migration and backwards compatibility.** The Context Guard migration (`storage.ts` `MIGRATIONS`, version 9
      / `MIGRATION_VERSIONS.CONTEXT_GUARD`) is appended strictly after the Tool Integrity migration, per the
      project's existing append-only-migrations convention (ADR-0009's comment on `MIGRATIONS`, restated for this
      milestone) — inserting it earlier would silently renumber every later migration and cause an already-
      upgraded database to skip it entirely. It creates `context_events`/`context_state` and extends `approvals`
      with five nullable binding columns via non-idempotent `ALTER TABLE ADD COLUMN` statements; a database that
      already has them (re-run against an already-migrated schema) fails loudly (`duplicate column name`) rather
      than silently, which is the correct fail-closed behavior for a migration runner, not a defect — see the
      regression fixed earlier this milestone in `tool-integrity-storage-migration.test.ts` for why a test fixture
      must pin an exact NAMED migration version (`MIGRATION_VERSIONS`) rather than assume "the highest recorded
      version" identifies any one specific migration. `context_guard: ContextGuardSchema.default({})` in
      `GatewayConfigSchema` means an omitted `context_guard` config block defaults to `mode: 'monitor'` — the
      same backwards-compatibility trade-off ADR-0012 made for `tool_integrity.mode` (point 4 there): every test,
      demo, and real config file written before this milestone keeps working unmodified with zero new blocking
      behavior, and `defaultContextGuardConfig()` (`config/registry.ts`) is the single canonical, schema-derived
      fallback used at the one runtime boundary (`pipeline.ts`) that must tolerate a `GatewayConfig`-shaped object
      built by hand rather than parsed through `loadGatewayConfig()` — never a hand-duplicated default literal.
  14. **Privacy/redaction.** Everything point 11 already states about what is and is not stored applies here as
      the privacy statement: label names, rule ids, safe bounded reason strings, and redacted-event linkage only.
      `computeArgumentDigest()` hashes already-REDACTED arguments (the same `redactArgumentsForAudit()` output
      already used for the audit chain, ADR-0004), never raw arguments — the digest is a comparison token, not a
      reversible record, and cannot be used to recover the original argument values.
  15. **Residual races this milestone does not eliminate.** Two are named explicitly, not hidden: (a) the same
      scan-to-call TOCTOU Tool Integrity already documents (ADR-0012 point 7) is unaffected and unrelated to
      Context Guard — a downstream tool's DEFINITION can still drift between scans independent of context state;
      (b) a genuine cross-request race remains between "Context Guard reads context state to compute its
      evaluation" and "that same call's OWN later label-append (step 8) writes new state" for a DIFFERENT
      concurrent call that reads in between — i.e. call X's contextual evaluation and call Y's label-append (from
      an earlier, still-finishing call) can interleave across the `await` points inside `runPipeline()`'s
      approval-wait loop and `executeDownstream()`, so two calls issued close together are not linearized against
      each other by any explicit lock; the exact-revision approval-binding mechanism (point 10) is the one place
      this project actively closes that window for the specific case that matters most (a human approving a
      contextually-gated call), not a claim that every possible interleaving is race-free.
- Reason: closing individual-call/result/definition trust gaps (ADR-0003/ADR-0009/ADR-0012) still leaves the
  cross-tool SEQUENCE unguarded — the class of attack where no single call looks wrong in isolation. This is a
  named, real MCP threat pattern (confused deputy / cross-tool escalation via indirect prompt injection), not a
  hypothetical one, and closing it is squarely within AgentGate's stated purpose as the trust boundary between an
  agent and the tools it can call.
- Evidence: `packages/gateway/src/context-guard/*` (new: `state.ts`, `rules.ts`, `enforcement.ts`, `types.ts`),
  `packages/gateway/src/{storage,server,pipeline,approval,config/registry,onboarding/smokeTest}.ts`,
  `packages/gateway/src/transport/stdio.ts`, `packages/gateway/src/api/control.ts` (accepts, does not yet route,
  a `contextGuard` option — Control API routes are a later milestone phase), `packages/protocol/src/events.ts`
  (`Approval` binding fields, `CONTEXT_GUARD_ESCALATION` reason code). Test evidence and exact counts are recorded
  in the session log entry immediately below this ADR, added after the corresponding verification actually ran —
  never claimed here in advance.
- Alternatives considered:
  - A fixed, hardcoded label taxonomy instead of operator-declared labels: rejected — different operators have
    different tools and different risk models; a closed vocabulary would force every deployment into the same
    shape or require a code change to extend it. Built-ins exist as a documented starting vocabulary, not a limit.
  - Trusting MCP tool `annotations` (`readOnlyHint`/`destructiveHint`) as the source/effect signal instead of
    operator config: rejected for the same reason ADR-0012 rejected trusting them for Tool Integrity decisions —
    server-supplied, unverifiable, and a malicious server could trivially self-report a lower risk.
  - Persisting context across gateway restarts (e.g. keyed by a client-supplied session identifier): rejected for
    this milestone — no such identifier is reliably available at the legacy-2025 stdio protocol boundary this
    project supports (ADR-0005), and a restored-but-stale context reintroduces exactly the kind of unverifiable
    persistence this design otherwise avoids; a fresh context per process launch is the conservative default.
  - Letting a contextual rule "allow" (downgrade risk) rather than only escalate: rejected by design — the
    monotonic escalate-only invariant (point 4/7) is the property that makes "Context Guard can only make things
    stricter" a provable, testable claim rather than a policy authors must trust by convention.
  - A single append-only table (ADR-0010's pattern) instead of the append-only-log-plus-projection pattern:
    rejected for the same reason ADR-0012 rejected it for Tool Integrity (point 9 there) — context state has a
    meaningful "current state" (active labels) that enforcement needs to read cheaply on every call.
  - Populating `tool_fingerprint` on every contextual approval in this milestone: originally deferred (schema
    supported it, nullable, but no call site populated it) — **completed in the 2026-08-28 CLI/API session** (see
    session log below); a `null` binding remains the correct, non-error representation for a tool with no
    trusted definition at creation time, not merely a placeholder for unfinished work.
- Consequences:
  - Positive: a real defense against cross-tool sequence escalation exists, enforced in the actual gateway request
    path — including against a client calling a tool directly by a cached/guessed name — not only in comment
    prose; Context Guard is provably monotonic (can only escalate, never silently loosen a base-policy decision);
    contextual approvals are bound to an exact revision/tool/argument snapshot and re-validated immediately before
    execution, closing the create-time/consume-time window; existing users are not silently broken on upgrade
    (`monitor` default).
  - Negative: the default (`monitor`) mode provides no blocking protection by itself, identical in kind to
    ADR-0012's own `monitor` default trade-off — an operator must opt into `enforce` to get real enforcement;
    context does not survive a gateway restart or a reconnect under a new process, so a real attack sequence that
    spans a restart is not detected by this milestone; TTL-based expiry exists in the schema but is not yet
    actively scheduled; the residual cross-request race (point 15b) means this milestone's concurrency guarantee
    is real but narrower than "fully linearized."
- Limitations (stated explicitly, not implied):
  - This is not model-reasoning inspection, not causal proof that one tool's result actually influenced a later
    call, and not information-flow/taint tracking of any kind — see point 2.
  - One stdio connection/process may not equal one upstream model conversation — see point 3.
  - Labels are conservative POLICY ASSERTIONS triggered by observed gateway events, not verified facts about what
    a tool actually did or what content an agent actually consumed.
  - MCP tool annotations remain untrusted server-supplied hints and are never consulted by enforcement to reduce
    risk — see point 6.
  - Local tamper evidence (the hash chain) is not tamper-proof against a privileged local administrator with
    direct database file access — identical in kind to ADR-0004/ADR-0012's own stated limitation.
  - A reset clears local AgentGate context state only; it cannot erase or affect what the upstream LLM/MCP client
    itself remembers from before the reset — see point 12.
  - Context does not persist across a gateway restart or reconnect under a new process — a genuinely restart-
    spanning attack sequence is not detected.
  - The scan-to-call TOCTOU already documented for Tool Integrity (ADR-0012 point 7) is unrelated to and
    unaffected by Context Guard.
  - A residual cross-request race between one call's contextual evaluation and a different, concurrently-finishing
    call's label-append is not fully eliminated — see point 15b; the exact-revision approval-binding mechanism
    (point 10) closes this specifically for human-approval consumption, not for every possible interleaving.
  - This milestone does not implement, and does not claim: sandboxing of downstream tools, closing every covert
    channel between tools, cryptographic proof of causation, support for MCP protocol versions/notifications
    beyond AgentGate's existing legacy-2025 stdio boundary (ADR-0005), or a Context Guard CLI/full Control API/
    Control Center surface — those are later phases of this same milestone, tracked separately, not claimed done
    here.
- Affected files: `packages/gateway/src/context-guard/*` (new), `packages/gateway/src/{storage,server,pipeline,
  approval,config/registry,onboarding/smokeTest}.ts`, `packages/gateway/src/transport/stdio.ts`,
  `packages/gateway/src/api/control.ts`, `packages/protocol/src/events.ts`, associated test files (added in the
  session log entry below).
- Supersedes: NONE
- Superseded by: NONE

### ADR-0014: Public Beta Release, Packaging, and Verifiable Supply Chain

- Status: ACCEPTED
- Date: 2026-08-28
- Scope: release / packaging / supply chain
- Decision:
  1. **Package topology: publish the existing scoped packages as-is; add no new meta-package.** The three
     already-existing library/CLI packages — `@agentgate/protocol`, `@agentgate/policy`, `@agentgate/gateway`
     (the last carrying the `agentgate` CLI `bin`) — become the public-beta publishable surface, unchanged in
     shape. `@agentgate/control-center` (a Vite app, not a library) and the monorepo root (`"private": true`,
     no publishable content) stay private/unpublished, exactly as today. No unscoped `agentgate` meta-package is
     introduced. Evidence: `npm view agentgate` returns a real, unrelated, already-published third-party package
     (`agentgate@0.16.0`, ISC license, `github.com/monteslu/agentgate`) — this makes an unscoped name a permanent
     non-option, not a style preference. `npm view @agentgate/gateway|policy|protocol` all return 404 (unpublished,
     name not yet claimed under the scope). Whether the `@agentgate` npm *scope itself* is currently unclaimed,
     or already registered to some npm org/user, is **NOT verified** by this decision — the only check available
     in this environment is an unauthenticated probe (`GET /-/org/agentgate/user` → `{}`), which is inconclusive
     either way, and `npm whoami` fails (`ENEEDAUTH`) because no npm account is authenticated in this environment.
     Confirming scope ownership (or registering it) is an explicit owner-side action, not something this session
     can determine or perform.
  2. **Versioning: lockstep prerelease versioning for the beta, not independent per-package versioning.** All
     three packages are currently at `0.1.0` and `@agentgate/gateway` depends on the other two via
     `workspace:*`, so they have always shipped as one coherent unit with no history of independent divergence —
     lockstep is the truthful continuation of actual practice, not a new constraint invented for this milestone.
     The beta channel is `0.1.0-beta.<n>` (semver prerelease), bumped together across all three packages by a
     single version-bump action, verified by a new deterministic version/tag-consistency check (Phase 4) rather
     than by convention alone. Independent versioning remains available later if the packages' release cadences
     genuinely diverge; this ADR does not rule it out permanently, it only states it is not adopted now because
     there is no evidence yet that it is needed.
  3. **Distribution model: npm scoped packages via GitHub Actions OIDC trusted publishing, no long-lived
     `NPM_TOKEN`.** Per npm's and GitHub's current documented trusted-publishing requirements (npm CLI ≥11.5.1,
     Node ≥22.14.0, workflow permissions `id-token: write` + `contents: read`), provenance attestation is
     generated automatically by trusted publishing itself — no `--provenance` flag or separate token is needed.
     `--access public` is required on each package's first publish (npm defaults a new scoped package to private
     otherwise). This is a strictly stronger security posture than a stored `NPM_TOKEN` secret: nothing
     long-lived exists to leak, rotate, or be scoped incorrectly; the credential is a short-lived, workflow-run-
     scoped OIDC token minted only for that one job.
  4. **Release trigger and approval boundary: workflow is prepared, checked into `main`, and inert.** The release
     workflow (Phase 6) is added to the repository this milestone but is intentionally built so that landing on
     `main` alone never runs it — the real trigger (a version tag push, a GitHub Release being published, or
     equivalent) and the protected-Environment manual-approval gate npmjs.com trusted publishing itself requires
     are **owner-side configuration steps performed after this milestone**, not something this session creates or
     activates. This ADR treats "a workflow file exists and is inert" and "publishing is live" as two genuinely
     different states, and requires every future report to say which one is true rather than implying the second
     because the first is done.
  5. **Platform/runtime matrix.** Supported Node range stays ≥20 (matching `.nvmrc` and the existing CI matrix);
     this milestone adds a macOS CI job (Phase 5) alongside the existing Ubuntu (Node 20/22) and Windows (Node 22)
     jobs, running a justified high-value subset rather than the full pipeline three times over, so a claim of
     "cross-platform" is backed by an actual scheduled job per OS rather than a Linux-only run generalized by
     assumption.
  6. **Secure-default compatibility boundary for Phase 2 fixes.** Any change to what `agentgate init` generates
     for a brand-new project (see the Context Guard default in point 7 below) is additive to newly-generated
     files only. The underlying schema default for an *omitted* `context_guard`/`tool_integrity` section
     (`monitor`, per ADR-0012/ADR-0013) is deliberately left unchanged, so an already-deployed config from before
     this milestone continues to parse and behave identically — this is a stricter default for new projects, not
     a silent behavior change for existing ones. No prior ADR is superseded by this point; it only tightens what
     `init` chooses to write.
  7. **Named beta-blocker resolved by this ADR's Phase 2: Context Guard's init-time default.** Unlike
     `tool_integrity` (already generated by `agentgate init` as `mode: explicit`, verified directly against
     `packages/gateway/src/onboarding/init.ts` this session — no change needed there), `agentgate init` today
     generates NO `context_guard` section at all, which means every brand-new beta installation silently starts
     in the schema's `monitor` (reporting-only, non-blocking) default with no signal to the operator that this is
     what happened. For a public beta whose README will describe Context Guard as a real defense, shipping new
     installs in a silently non-blocking mode is classified **must-fix-before-beta**, not an acceptable documented
     limitation — the fix (implemented in the same commit as this ADR) adds an explicit, commented
     `context_guard: mode: enforce` block (with empty `labels`/`tools`/`rules`, which is schema-valid and enforces
     nothing until the operator declares real tools/rules) to `buildConfigTemplate()`, mirroring the
     already-existing `tool_integrity: mode: explicit` treatment and the same "safe narrow default, widen
     deliberately" philosophy already used for the generated policy file.
  8. **Two additional Phase 2 fixes closing named beta-blockers, both adversarially re-tested.**
     (a) The Context Guard SSE stream (ADR-0013) previously had NO dedicated test proving a fresh subscriber never
     receives historically-published `context_event` frames — an attempted version was removed as unreliable
     (proving a negative by exhausting a read timeout). This milestone adds a deterministic replacement in
     `packages/gateway/tests/context-guard-sse.test.ts`: it publishes events BEFORE a fresh connection's handler
     is registered (structurally undeliverable, not merely late), then asserts the first frame the connection
     actually receives is a distinct later sentinel event and that neither pre-connection event's id ever
     appears — proving the property without waiting out a timeout.
     (b) `checkApprovalContextValid()` (`context-guard/enforcement.ts`) previously skipped its `tool_fingerprint`
     comparison whenever the approval's BOUND fingerprint was `null` (no trusted Tool Integrity definition existed
     at approval-creation time), regardless of what the CURRENT trusted fingerprint is at consumption time. This
     allowed a stale-reuse gap: an approval created while a tool had no trusted definition could still be consumed
     after that tool became newly trusted (or re-trusted under a different fingerprint) during the pending window
     — a definition the approving human never actually saw. The check is tightened to a symmetric equality
     comparison (`approval.tool_fingerprint !== expectedToolFingerprint`), so ANY transition — null-to-value,
     value-to-null, or value-to-different-value — fails closed and forces re-evaluation; only a genuine
     null-to-null (no trusted definition then, none now) still passes, since nothing was ever bound and nothing
     changed. Both the existing and two new adversarial cases are covered in
     `packages/gateway/tests/context-guard-enforcement.test.ts`; the full existing fingerprint-binding suites
     (`context-guard-fingerprint-binding.test.ts`, `context-guard-fingerprint-gateway.test.ts`, real gateway-path)
     were re-run and continue to pass unchanged, confirming this is a strict tightening with no regression to the
     already-covered non-null cases.
  9. **Verifiable-artifact model: checksums, SBOM, and attestation preparation, not a new trust primitive.** SHA-256
     manifests, a CycloneDX/SPDX SBOM, and GitHub artifact attestations (Phase 7) let a consumer verify that a
     specific tarball corresponds to a specific commit/build/dependency graph. This ADR is explicit that these
     mechanisms prove **origin and build linkage**, never the absence of malicious code, and that the existing
     audit hash chain (ADR-0004/ADR-0012/ADR-0013) remains local tamper **evidence**, never described here or
     elsewhere as tamper-proof or non-repudiating — this ADR introduces no change to that characterization.
- Alternatives considered:
  - An unscoped `agentgate` meta-package re-exporting the scoped packages — rejected outright: the name is
    already owned by an unrelated real project, so this is not a namespacing preference but a hard collision.
  - A single monolithic published package instead of three scoped ones — rejected: it would silently change the
    existing public import surface (`@agentgate/protocol`, `@agentgate/policy` are already used as such in code
    and docs) for no benefit, and would force the CLI's dependents to pull in policy/protocol internals they may
    not need.
  - Independent per-package semver from day one — rejected for now (not permanently) per point 2: no evidence of
    divergent release cadence exists yet, and lockstep is verifiably simpler to keep tag/version-consistent for a
    first beta.
  - A long-lived `NPM_TOKEN` repository secret instead of OIDC trusted publishing — rejected: strictly weaker
    (a stealable, broad-scoped, long-lived credential) with no offsetting benefit now that trusted publishing is
    available and documented by npm/GitHub.
  - Making the release workflow trigger on push to `main` directly — rejected: violates this milestone's explicit
    constraint that no publish may happen without a later, distinct, owner-approved action, and removes the
    protected-Environment manual-approval boundary npm trusted publishing is designed to work with.
  - Silently changing the Context Guard init default to `enforce` with a non-empty starter rule set — rejected:
    an operator-specific starter rule set would have to guess at real tool names/effects the same way the policy
    template deliberately does not (it permits exactly one harmless example tool); an empty, valid `enforce` block
    that enforces nothing until configured is the narrowest safe change, consistent with point 7's own reasoning.
- Consequences:
  - Positive: the smallest coherent, evidence-grounded distribution architecture is chosen without inventing a new
    namespace or trust primitive; the actual current beta-blocker (silent Context Guard monitor-only default on
    new installs) is named and fixed rather than merely documented; every truthfulness rule from this milestone's
    prompt (no unverified availability claims, no claims of publication, no claims of cross-platform support
    without a real per-OS CI job) is satisfied structurally by this ADR's own scope boundaries, not just by intent.
  - Negative: `@agentgate` scope ownership remains genuinely unverified until the human owner authenticates an
    npm account and checks/claims it — this ADR cannot resolve that, and says so rather than guessing; lockstep
    versioning means a change to only one package still requires bumping all three, which is a minor process cost
    accepted in exchange for a much simpler consistency story for a first beta.
- Limitations (stated explicitly, not implied):
  - No package has been published, no version tag has been created, no GitHub Release has been created, no GitHub
    Environment or branch-protection rule or repository secret has been created or modified, and no npm
    trusted-publisher configuration has been performed — all of that is explicitly out of scope for this ADR and
    this milestone, and requires a later, distinct, explicit owner approval.
  - `@agentgate` scope ownership on npm is unverified (neither confirmed available nor confirmed already claimed)
    — this is a genuine unresolved fact, not a rhetorical hedge, and must be checked by the owner with an
    authenticated npm session before any real publish is attempted.
  - Checksums/SBOM/attestation (point 8) prove build/origin linkage only; they are not, and are never described
    as, a guarantee that packaged code is free of vulnerabilities or malicious behavior.
  - The Context Guard init-time fix (point 7) only changes what NEW projects generate; it cannot and does not
    retroactively change any already-deployed `agentgate.yml` that omits `context_guard` — those continue to run
    in `monitor` mode exactly as ADR-0013 already documented, until the operator edits their own config.
- Affected files: `packages/gateway/src/onboarding/init.ts` (Context Guard default), `packages/gateway/src/
  context-guard/enforcement.ts` (fingerprint fail-closed fix), `packages/gateway/tests/{onboarding-init,
  context-guard-sse,context-guard-enforcement}.test.ts`, `README.md`, `docs/{POLICY_REFERENCE,DEVELOPMENT}.md`
  (stale "init does not generate context_guard" text corrected), `packages/{protocol,policy,gateway}/package.json`
  (publishable metadata, Phase 3), `scripts/verify-packed-install.mjs` and related release scripts (Phase 3/4/7),
  `.github/workflows/ci.yml` (macOS job, Phase 5), a new release workflow file (Phase 6), `CHANGELOG.md`, and the
  other public-beta docs listed in the Milestone 8 prompt (Phase 8), associated test files (added in the session
  log entry below).
- Supersedes: NONE
- Superseded by: ADR-0016 for package-scope identity only. ADR-0015 still amends the release-workflow's publish-gating and artifact-integrity design; all other ADR-0014 architecture decisions remain active.

### ADR-0015: Release-Workflow Publish-Gating and Artifact-Integrity Amendment (amends ADR-0014)

- Status: ACCEPTED
- Date: 2026-08-28
- Scope: release / packaging / supply chain (amendment)
- Decision:
  1. **This ADR amends, and does not replace, ADR-0014.** Every decision in ADR-0014 (package topology, lockstep
     versioning, OIDC trusted publishing, the inert-until-tag-or-dispatch trigger boundary) remains in force
     unchanged. This ADR records three concrete defects found during a first-publication preflight review of
     `.github/workflows/release.yml` — never actually executed — and the fixes applied, plus one critical
     external-platform fact discovered that materially changes what "owner approval" for a first publish
     actually requires.
  2. **Critical bootstrap-sequencing fact, from current official npm documentation (verified this session, not
     assumed): npm trusted publishing cannot be configured for a package that has never been published.** The
     trusted-publisher configuration UI lives on a package's own settings page on npmjs.com, which does not exist
     until the package exists. The documented, official sequence is: (a) publish the package's first version
     manually, from an authenticated local terminal, using traditional auth (`npm login` + `npm publish
     --access public`); (b) only then configure the trusted publisher on that now-existing package's settings
     page; (c) only then can an OIDC-based CI/CD workflow (like `release.yml`) publish subsequent versions.
     **Consequence for AgentGate specifically: `.github/workflows/release.yml`'s `publish` job cannot succeed at
     publishing the FIRST version of `@agentgate/protocol`, `@agentgate/policy`, or `@agentgate/gateway`** — all
     three are entirely new, never-published packages. The very first release of each must be published manually
     by the owner, outside this workflow; the automated workflow becomes usable starting with each package's
     SECOND release. This is now documented explicitly in `release.yml`'s own header comment rather than left
     implicit, and is the central fact structuring the first-publication owner runbook.
  3. **Fixed: the `publish` job's gate did not require the dispatch to target a tag.** Previously
     `if: github.event_name == 'workflow_dispatch' && github.event.inputs.publish == 'true'` — this reached a
     real `npm publish` if the owner ran `workflow_dispatch` against ANY ref (e.g. the `main` branch tip,
     GitHub's default pre-selected choice in the dispatch UI), with no tag ever required to exist, contradicting
     ADR-0014's own stated intent that publication be tag-gated. Fixed by adding `&& github.ref_type == 'tag'` to
     the condition — a real publish now structurally requires the dispatch to have been run against a tag ref,
     not merely with the right input string.
  4. **Fixed: attested/checksummed/SBOM'd artifacts were not necessarily the bytes actually published.** The
     previous workflow had `verify` build-and-pack once (for checksums/SBOM/attestation) and the separate
     `publish`/`publish-dry-run` jobs independently re-checkout, reinstall, and rebuild before calling `npm
     publish` from the package directory (which packs again, internally, at publish time). Milestone 8 already
     established that tarball packing is not byte-reproducible across separate build invocations of the same
     commit (embedded file mtimes differ). This meant the SBOM/checksums/attestation this workflow would have
     produced described a DIFFERENT build than what was actually published — undermining the entire point of
     generating them. Fixed: `verify` now uploads its built tarballs as a workflow artifact; `publish-dry-run`,
     `publish`, and `attest` all download and act on THAT SAME artifact (`npm publish <tarball-path>` instead of
     `npm publish` from a re-built directory) — one build, reused everywhere, so the attestation's "these exact
     bytes" claim is now actually true. This also removed the need for `pnpm`/a full workspace install in the
     `publish-dry-run` and `publish` jobs (they now only need Node + npm), simplifying and speeding both up.
  5. **Fixed: no idempotent-retry handling for a partial publish.** The publish loop previously had no check for
     "already published" — since `set -e` (GitHub Actions' bash default) halts the loop at the first failure,
     a rerun after e.g. `protocol` succeeded but `policy` failed would fail again immediately on `protocol`
     (already published, `npm publish` correctly refuses to republish an existing immutable version) and never
     reach `policy`/`gateway`. Fixed: each package is now skipped, not re-attempted, if `npm view
     "<name>@<version>" version` already resolves — making a rerun after a partial failure safe and able to make
     automatic forward progress on only the packages that still need publishing.
  6. **Documented, not fixed (an inherent npm CLI limitation): `npm publish --dry-run` does not validate token/
     OIDC identity against the registry.** Verified from current documentation/community sources this session:
     `--dry-run` reports whether an auth/OIDC context is *present* locally, not whether the registry would
     *accept* it. A green `publish-dry-run` job therefore proves the tarball is well-formed and packable — it
     does NOT prove a real publish would succeed (in particular, it cannot detect "no trusted publisher is
     configured yet," point 2's exact situation for a first release). This limitation is now stated in
     `release.yml`'s own header comment so a future green dry-run is never over-read as "the real publish would
     have worked."
  7. **Observed, not fixed (informational, no repository-setting mutation performed):** the repository currently
     has zero GitHub Environments and no branch protection on `main` (`gh api .../environments` → `total_count:
     0`; `gh api .../branches/main/protection` → 404 "Branch not protected"). If the owner ever dispatched the
     `publish` job before creating and protecting the `npm-publish` Environment, GitHub Actions would very likely
     auto-create that Environment on first reference with NO protection rules, silently skipping the intended
     human-approval gate. This is recorded here as a critical sequencing warning for the owner runbook — create
     and protect the Environment BEFORE the first `workflow_dispatch` with `publish: true` — not fixed in code,
     since creating a GitHub Environment is an explicit repository-setting mutation this preflight is not
     authorized to perform.
- Alternatives considered:
  - Leaving the `publish` job's gate as `workflow_dispatch` + `publish:true` alone (no `ref_type` check), relying
    on the owner to always remember to select the tag manually — rejected: a structural guarantee that cannot be
    forgotten is strictly safer than a documented-but-unenforced operator convention, and costs nothing to add.
  - Publishing straight from each package directory in the `publish` job (status quo) instead of reusing
    `verify`'s tarballs — rejected once the reproducibility gap was understood: it would make every future
    attestation this project produces describe a build that was never actually the one published, silently
    undermining the exact guarantee ADR-0014 point 9 says attestations provide.
  - Adding a repository `NPM_TOKEN` secret to work around the trusted-publishing bootstrap requirement (point 2)
    so the automated workflow COULD perform even a first publish — rejected: explicitly forbidden by this
    session's authorization boundary (no secret may be added), and would reintroduce the exact long-lived-token
    risk ADR-0014 chose OIDC specifically to avoid; the correct fix is operator process (manual first publish),
    not weakening the credential model.
- Consequences:
  - Positive: a real, previously-latent path to publishing from an unintended branch commit is closed
    structurally; generated attestations will actually describe published bytes once real publication happens; a
    partial first-publish failure is now automatically recoverable by rerunning the same dispatch, rather than
    requiring manual intervention; the owner-facing runbook can now state the true, complete first-release
    sequence instead of one that silently assumes the automated workflow can do something it cannot.
  - Negative: the first release of each package requires a manual, out-of-band `npm publish` step the owner must
    perform correctly (with 2FA) before the automated workflow is usable at all — this is an npm platform
    constraint, not a choice this project can design around.
- Limitations (stated explicitly, not implied):
  - None of these fixes have been exercised against the real npm registry (no tag exists, nothing has been
    published) — they are verified by direct code/YAML review and (where practical) local reasoning about GitHub
    Actions' documented context-variable/shell-default behavior, not by an actual successful run.
  - `@agentgate` npm scope ownership remains unverified — unchanged from ADR-0014; this amendment does not and
    cannot resolve it.
  - The Environment auto-creation-without-protection risk (point 7) is a GitHub Actions platform behavior this
    project can only document and warn about, not prevent from code.
- Affected files: `.github/workflows/release.yml` (publish-gating fix, artifact-integrity rework, idempotent
  retry, expanded header documentation), `docs/AI_DECISIONS.md` (this entry).
- Supersedes: NONE (amends ADR-0014's release-workflow design; ADR-0014's architecture decisions are unchanged)
- Superseded by: NONE

### ADR-0016: Publish Under the Existing `@chidhvilasa` npm User Scope

- Status: ACCEPTED
- Date: 2026-08-29
- Scope: release / package identity
- Decision:
  1. Publish AgentGate's three public packages as `@chidhvilasa/protocol`, `@chidhvilasa/policy`, and
     `@chidhvilasa/gateway`. Keep the existing three-package topology, lockstep `0.1.0-beta.<n>` versioning,
     `agentgate` CLI binary, artifact verification, and trusted-publishing architecture from ADR-0014/ADR-0015.
  2. Rename the private Control Center workspace package to `@chidhvilasa/control-center` as well so every
     workspace import/filter uses one truthful namespace, while keeping that application `private: true` and
     unpublished.
  3. Use the npm user scope already owned by the authenticated npm identity `chidhvilasa`; do not create a paid
     plan, private package, access token, or alternate organization. Public user-scoped packages are free.
  4. Bootstrap the first versions manually in dependency order (`protocol`, `policy`, `gateway`) after the full
     release gate passes. Configure GitHub Actions OIDC trusted publishing per package only after those first
     package records exist, as required by the npm bootstrap constraint recorded in ADR-0015.
- Reason: The authenticated npm organization-creation form rejected `agentgate` with the authoritative message
  `This name is unavailable.` No organization was created and no payment occurred. The same authenticated account
  (`chidhvilasa`) already owns the `@chidhvilasa` user scope, its three proposed AgentGate package names are
  unpublished, and the account now has 2FA enabled for authorization and publishing with one security key. Using
  that existing scope is the smallest zero-cost path and avoids inventing another organization identity merely to
  preserve a pre-publication placeholder namespace.
- Evidence:
  - Authenticated npm account page on 2026-08-29: username `chidhvilasa`; `2FA Enabled for authorization and
    publishing`; one security key.
  - Authenticated npm organization creation attempt on 2026-08-29: `agentgate` rejected as unavailable; no
    organization created.
  - Registry checks before the rename: `@chidhvilasa/protocol`, `@chidhvilasa/policy`, and
    `@chidhvilasa/gateway` each returned 404/unpublished.
- Alternatives considered:
  - Continue using `@agentgate/*`: rejected because the authoritative authenticated creation attempt proved the
    required scope is unavailable to this owner.
  - Create a different organization such as `@agentgatehq`: rejected for the first beta because the existing user
    scope is already owned, free, and sufficient; another permanent account object adds setup and governance with
    no demonstrated technical benefit.
  - Use the unrelated unscoped `agentgate` package: impossible and misleading; it is owned by another project.
- Consequences:
  - Positive: zero-cost, immediately owned namespace; no new organization, billing relationship, or package-owner
    ambiguity; package names align with the repository owner.
  - Negative: installation uses the maintainer scope rather than the shorter product scope. A later rename would
    require publishing new package identities and a migration/deprecation plan because npm package names are
    immutable identities.
- Compatibility: This is a pre-first-publication rename, so no registry consumer can depend on the old names.
  All workspace manifests, source imports, tests, release scripts, workflows, current documentation, and packed
  manifests must change together. Historical ledger text remains unchanged except for ADR-0014's explicit
  supersession pointer.
- Affected files: workspace/package manifests and lockfile; TypeScript imports; release scripts/tests/workflow;
  package READMEs and current public documentation; `docs/AI_DECISIONS.md`.
- Supersedes: ADR-0014 point 1's `@agentgate/*` package identity and the corresponding name-specific references
  in ADR-0015. It does not supersede their topology, versioning, security, OIDC, or artifact-integrity decisions.
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

### 2026-08-25 — Milestone 5, Phase 1 (installability audit and packaging repair)

- Prompt objective: determine, by actually testing rather than assuming, how a clean user can run AgentGate
  today; repair the smallest maintainable packaging gap found; add automated packed-install coverage.
- Continuity check: confirmed local and remote HEAD both `a6402d5` (Milestone 4 checkpoint) with a clean
  `git status --short` (only `.claude/`/`CLAUDE.md` untracked) and both known CI/Security runs green before
  starting; read `docs/AI_DECISIONS.md` in full including every ADR; re-read `cli.ts`, `config/registry.ts`,
  `packages/policy/src/index.ts`, `server.ts`, `storage.ts`, package manifests, `.github/workflows/*.yml`,
  README/DEVELOPMENT/TROUBLESHOOTING; ran and recorded frozen install, build, lint, full test suite (154 tests
  at that point), and all three existing demos — all passed before any change.
- Findings (verified with real commands, not assumed):
  - All three publishable packages are `"private": true` (so `npm publish` is blocked outright — expected,
    unchanged in this milestone), have `"bin": {"agentgate": "dist/cli.js"}` with a correct shebang, and build
    cleanly, but had no `"files"` field and no `.npmignore` — `pnpm pack` therefore included `src/`, `tests/`,
    and `tsconfig*.json` in every tarball (gateway tarball: 69KB before, including `.test.ts` files).
  - `npm install <packed-gateway-tarball>` **alone** into a clean temp consumer fails with a real, reproduced
    `npm error 404 Not Found - GET .../@agentgate%2fpolicy` — `pnpm pack` rewrites the `workspace:*` protocol to
    a bare `"0.1.0"` semver in the packed `package.json`, which npm then tries (and fails) to resolve from the
    real registry, since these packages have never been published there.
  - Installing all three tarballs **together** in one `npm install a.tgz b.tgz c.tgz` command *does* work —
    confirmed by then running the installed CLI's help text and `agentgate validate` against a real file from
    that clean consumer, both behaving correctly.
- Implementation completed: added `"files": ["dist"]` to `packages/{gateway,policy,protocol}/package.json`
  (gateway tarball shrank to ~51KB, `src`/`tests` no longer present); new `scripts/verify-packed-install.mjs` —
  packs all three packages, inspects the gateway tarball's contents (asserts `src`/`tests` absent, `dist/cli.js`
  and the smoke-test fixture present — the fixture assertion was added after Phase 6 below, since Phase 1 was
  revisited once that command existed), installs all three tarballs together into a fresh temp consumer, and
  runs the installed CLI's help output, `--version`, and (after Phase 6) `smoke-test` — 9 real assertions.
  Wired into both CI jobs as a new "Packed-package install verification" step.
- Files materially changed: `packages/{gateway,policy,protocol}/package.json`,
  `scripts/verify-packed-install.mjs` (new), `.github/workflows/ci.yml`.
- Commands actually executed and their actual results: `pnpm pack` for all three packages (before and after the
  fix, tarball sizes compared directly); `npm install` of the gateway tarball alone (reproduced the 404
  failure); `npm install` of all three tarballs together (succeeded; installed CLI's help/`--version`/
  `smoke-test` all verified working from the clean consumer); `node scripts/verify-packed-install.mjs` — all 9
  checks PASS. Committed as `8d0a8f0 fix(packaging): trim publishable tarballs and prove packed install works`.
- Verification result: PASS — the installability audit was performed with real commands against real temp
  directories, the one real gap found (tarball bloat) was fixed, and the packed-install method now has
  automated, CI-wired evidence rather than a documentation claim alone.
- Known limitations / follow-up risk: packed install still requires the user to run `pnpm pack` themselves from
  a source checkout — there is no public npm registry publication in this milestone, and none is claimed.
  Installing the gateway tarball in isolation (without its two workspace siblings) remains unsupported and is
  documented as such, not silently papered over.
- Unresolved questions: none blocking.
- Exact next action: Phase 2 — implement `agentgate init`.

### 2026-08-25 — Milestone 5, Phases 2-6 (onboarding CLI: init, config validate, doctor, integrate, smoke-test)

- Prompt objective: implement `agentgate init`, `agentgate config validate`, `agentgate doctor`, `agentgate
  integrate <client>`, and `agentgate smoke-test`, each meeting the detailed safety requirements in the
  governing prompt, with automated test coverage.
- Continuity check: re-read ADR-0011 (drafted alongside this work, see above) and the Phase 1 session-log entry
  before starting; confirmed local HEAD was `8d0a8f0` with a clean tree.
- Decisions added or changed: added ADR-0011 (Zero-Friction Onboarding Without New Trust or Execution Surfaces)
  — see above for the full decision record; not repeated here.
- Implementation completed (full detail in ADR-0011 above; commands/results below):
  - `packages/gateway/src/onboarding/init.ts`: deterministic, non-interactive project scaffolding.
  - `packages/gateway/src/onboarding/configValidate.ts`: reuses `loadGatewayConfig`/`loadPolicyFile` directly.
  - `packages/gateway/src/onboarding/doctor.ts`: 12 read-only checks; a new `packages/gateway/src/storage.ts`
    export, `readSchemaVersionReadOnly()` (opened with `better-sqlite3`'s `readonly: true`), lets it check
    whether a database is already fully migrated before ever deciding it's safe to open via `AuditStorage`
    (whose constructor otherwise applies pending migrations unconditionally on open).
  - `packages/gateway/src/onboarding/smokeTest.ts` + `smokeFixtureServer.mjs` (new, plain JS) +
    `packages/gateway/scripts/copy-assets.mjs` (new postbuild step): a real allow/deny/redaction/chain-
    verification smoke test using a fixture that ships with the compiled package.
  - `packages/gateway/src/onboarding/integrate.ts`: `claude-code` and `antigravity` support, each verified
    against a real, fetched, current documentation page this session (`https://code.claude.com/docs/en/mcp` and
    `https://antigravity.google/docs/ide/mcp/` respectively — both read via WebFetch, not assumed from prior
    knowledge); a third `generic` option explicitly labeled unverified. Default print-only behavior; an explicit
    `--apply` opt-in with backup/atomic-write/unrelated-entry-preservation/`--dry-run`.
  - `packages/gateway/src/cli.ts`: five new subcommands, `--version`, per-command `--help`, and shared arg-
    parsing helpers (`extractValueFlag`, `quotePath`, `reportFatal`).
  - **Real bug found and fixed while building this**: the smoke-test fixture was initially written as
    TypeScript (`smokeFixtureServer.ts`), which failed at runtime with `Cannot find module
    ".../smokeFixtureServer.js"` when tests ran directly against `src/` (vitest never compiles it) — fixed by
    rewriting it as plain `.mjs` (matching the pre-existing test-only fixture's own approach) plus the new
    `copy-assets.mjs` postbuild step so it also ships in `dist/` for an installed package. A second issue found
    while writing doctor's no-execution test: `vi.spyOn()` cannot patch a named ESM export ("Module namespace is
    not configurable in ESM") — replaced with the same structural import-statement guardrail pattern already
    used by `replay-no-execution.test.ts`.
- Files materially changed: `packages/gateway/src/cli.ts`, `packages/gateway/src/storage.ts`,
  `packages/gateway/src/onboarding/*` (new), `packages/gateway/scripts/copy-assets.mjs` (new), five new test
  files under `packages/gateway/tests/onboarding-*.test.ts`, `docs/AI_DECISIONS.md` (ADR-0011).
- Commands actually executed and their actual results: `pnpm run build` (clean), `pnpm run lint` (0 errors,
  same 2 pre-existing unrelated warnings), `pnpm run test` — **204 tests total** (52 policy + 16 control-center
  + 136 gateway [86 pre-existing + 50 new]), zero regressions; all three pre-existing demos re-run and passing;
  every new command manually exercised end-to-end against a real temp project directory (including a directory
  name containing spaces and Japanese characters), including `init` twice (refusal then `--force` overwrite),
  `config validate` (human + `--json`), `doctor` (including `--client-config`), `integrate` for all three
  clients, and `--apply`'s dry-run/real/backup/unrelated-key-preservation behavior — all matched expected
  output. Committed as `4b2d705 feat(cli): add init, config validate, doctor, integrate, and smoke-test`.
- Verification result: PASS for every Phase 2-6 requirement exercised above — real, working commands with real
  test coverage and real manual verification, not a stub or a documentation-only claim.
- Known limitations / follow-up risk: `init` has no interactive mode (see ADR-0011 point 2); the client-
  integration matrix is intentionally small; `doctor`'s port-availability check can race with another process
  binding the same port between the check and a later `agentgate start` (inherent to any such check, stated
  plainly rather than implied otherwise). Phase 7 (lifecycle hardening + Control Center clipping fix), Phase 8
  (documentation), Phase 9 (screenshots), Phase 10 (Graphify), Phase 11 (CI matrix), Phase 12 (full/clean-room
  verification), and Phase 13 (final commits/push/CI) have not started.
- Unresolved questions: none blocking.
- Exact next action: Phase 7 — startup/lifecycle hardening review and the Control Center `.main-content`
  clipping fix.

### 2026-08-25 — Milestone 5, Phase 7 (startup usability and lifecycle hardening)

- Prompt objective: review real first-run/shutdown behavior for high-impact friction and fix the documented
  Control Center `.main-content` clipping defect.
- Continuity check: confirmed local HEAD `bcdee82` with a clean tree before starting.
- Findings: `server.ts` had **no signal handling at all** — `grep -n "SIGINT\|SIGTERM\|process.on"` across the
  entire gateway `src/` returned nothing before this session. A Ctrl+C or `kill` simply terminated the process
  with no cleanup of the Fastify listener, SSE connections, or the approval-expiry interval. Separately, the
  `.main-content` clipping bug documented as a known limitation in Milestone 4's Phase 5 session log (a flex
  column with `overflow-y:auto` whose `.card` children could shrink below their content height and then be
  clipped by the card's own `overflow:hidden`) was still present and unfixed.
- Implementation completed: added idempotent SIGINT/SIGTERM handlers to `startGateway()` that close the Control
  API, destroy the `ApprovalManager`, and close the audit database before `process.exit(0)`. Fixed the clipping
  bug with `flex-shrink: 0` on `.card` and `.page-header` — the standard fix for a flex column whose children
  must never shrink below content size when the container is meant to scroll instead.
- New `packages/gateway/tests/lifecycle.test.ts` (4 tests, 2 platform-skipped on Windows): spawns the real
  compiled CLI. **Real, verified platform limitation found while writing this test**: Node's
  `child_process.kill('SIGINT'/'SIGTERM')` unconditionally terminates a child process on Windows regardless of
  any registered handler — a documented Node/Windows behavior, confirmed directly (the test failed with
  `exit.code: null` instead of `0` on this Windows dev machine, consistent with the process being force-killed
  rather than gracefully exiting) before working around it, not silently ignored. The two behavioral graceful-
  shutdown assertions are POSIX-only (`it.skipIf(process.platform === 'win32')`); a third, platform-agnostic
  structural test confirms the handler code is present in source regardless of platform; a fourth test starts
  two gateways on the same control port and confirms the second fails with a clear `EADDRINUSE`-shaped error
  while the first process is completely unaffected.
- Files materially changed: `packages/gateway/src/server.ts`, `apps/control-center/src/index.css`,
  `packages/gateway/tests/lifecycle.test.ts` (new).
- Commands actually executed and their actual results: `pnpm run build` (clean), `pnpm run lint` (0 errors —
  found and fixed 2 real `no-unsafe-call` errors on untyped stream-data callback parameters while writing the
  new test, before this ledger entry), `pnpm run test` — **206 tests, 2 correctly skipped on this platform**
  (52 policy + 16 control-center + 138 gateway [136 prior + 4 new, 2 skipped]), zero regressions; all three
  demos re-run and passing. Committed as `7b12420 fix(lifecycle): graceful shutdown on SIGINT/SIGTERM; fix
  Control Center card clipping`.
- Verification result: PASS for the lifecycle behavior actually exercisable on this platform and by structural
  check on Windows; the clipping CSS fix is code-reviewed as correct against the diagnosed root cause but
  **not yet visually re-verified in a real browser** — that happens in Phase 9 (screenshots), where the fixed
  Event Detail/Safe Replay page will be captured and inspected.
- Known limitations / follow-up risk: the POSIX-only behavioral SIGINT/SIGTERM tests will only actually run on
  the Ubuntu CI jobs, not the Windows one (by design, given the platform limitation) — this is the one place in
  this milestone's test suite where full behavioral coverage genuinely differs by OS, stated plainly. The
  clipping fix's visual correctness is pending Phase 9's browser verification.
- Unresolved questions: none blocking.
- Exact next action: Phase 8 — documentation rewrite (README, DEVELOPMENT, TROUBLESHOOTING, ARCHITECTURE,
  THREAT_MODEL, VERIFICATION, POLICY_REFERENCE, CHANGELOG).

### 2026-08-25 — Milestone 5, Phases 8-9 (documentation and visual proof)

- Prompt objective: rewrite the top of the README for adoption, update every listed doc, and capture sanitized
  visual proof of the new commands and the clipping fix.
- Continuity check: confirmed local HEAD `7b12420`→`4cdf6c5` (Phase 7 commit + its ledger entry) with a clean
  tree before starting.
- Implementation completed: README rewritten (installation section with both verified methods, client-
  integrations table with cited sources, platform/runtime support matrix backed by actual CI coverage, updated
  CLI table/test count/uninstall instructions); `docs/ARCHITECTURE.md` (new component row + "Onboarding CLI"
  section); `docs/THREAT_MODEL.md` (new "Onboarding CLI" threat section, 5 threats each with an implemented
  mitigation, updated summary); `docs/DEVELOPMENT.md` (new "Installability" and "Onboarding CLI" sections,
  updated release gates); `docs/TROUBLESHOOTING.md` (new doctor check-id table, two new entries);
  `docs/VERIFICATION.md` (new Milestone 5 evidence table); `docs/POLICY_REFERENCE.md` (cross-reference to the
  init-generated starter policy); `CHANGELOG.md` (new Milestone 5 section); `CONTRIBUTING.md`/
  `.github/pull_request_template.md` (gate-command lists updated).
  - **Visual capture**: added Playwright as a temporary root devDependency again (fully removed and reverted
    afterward, confirmed via `git diff --stat` on `package.json`/`pnpm-lock.yaml` showing no output). Captured
    four terminal-style renders of real, sanitized CLI output (`cli-init.png`, `cli-doctor.png`,
    `cli-integrate.png`, `cli-smoke-test.png` — all command output paths replaced with `~/...` placeholders
    before rendering, both the specific temp-project path used for the capture and, as a defense-in-depth
    pass, the real repo root path and OS home directory generally, regardless of which specific check happened
    to print one) and two real browser screenshots of the Event Detail/Safe Replay page proving the Phase 7
    clipping fix, at a 1280×900 desktop and a 420×800 narrow viewport. Each screenshot's correctness was
    verified programmatically before being trusted, not just visually: `card.scrollHeight <= card.clientHeight
    + 2px` (i.e. nothing hidden by overflow) at both sizes, plus zero browser console errors at both sizes —
    all inspected visually one more time before committing.
- Files materially changed: README.md, `docs/{ARCHITECTURE,THREAT_MODEL,DEVELOPMENT,TROUBLESHOOTING,
  VERIFICATION,POLICY_REFERENCE}.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`,
  six new files under `docs/assets/`.
- Commands actually executed and their actual results: `pnpm run build` (clean), `pnpm run lint` (0 errors,
  same 2 pre-existing warnings), `pnpm run test` (206 tests, 2 correctly skipped, zero regressions), all three
  demos re-run and passing, a targeted grep across every touched doc for "one command"/"zero-config"/"zero
  configuration" found none. Committed as `60c54ae docs: document the onboarding CLI and add adoption
  screenshots`.
- Verification result: PASS — every listed doc updated with content backed by evidence already produced in
  earlier phases (test counts, verified client sources, the packed-install script's real results, the real
  browser measurements above), no stale "coming soon"/unverified claims introduced.
- Known limitations / follow-up risk: none new. Graphify re-indexing (Phase 10), CI matrix confirmation (Phase
  11 — largely already done via the packed-install CI step added in Phase 1, needs a final check), full/clean-
  room verification (Phase 12), and final commits/push/CI observation (Phase 13) have not started.
- Unresolved questions: none blocking.
- Exact next action: Phase 10 — Graphify re-index and verification queries covering the new onboarding CLI
  paths.

### 2026-08-25 — Milestone 5, Phase 10 (Graphify re-index and verification)

- Prompt objective: re-index with Graphify, query the new onboarding CLI paths, verify shared config parsing
  reaches the production loader, verify doctor/integrate never reach downstream execution, verify smoke-test
  reaches only its internal fixture, confirm every finding against source before acting on it.
- Continuity check: confirmed local HEAD `7b8612c` with a clean tree before starting.
- Implementation completed: `graphify update .` → 903→1017 nodes, 1135→1322 edges, 54→69 communities. One
  orientation query correctly surfaced every real function across all five onboarding modules. Four path
  queries, all verified against real source (`grep -n "^import"` on each file in question) before being
  trusted: `configValidate.ts`/`doctor.ts` → `loadGatewayConfig()` both real 1-hop paths, confirming neither
  duplicates config-parsing logic; `doctor.ts`/`integrate.ts` → `executeDownstream()`/`runPipeline()` all
  genuinely absent (a true negative this time, not the misleading file-level-granularity artifact Milestone 4
  found for `replay.ts`, because neither file imports anything at all from `pipeline.ts`);
  `smokeTest.ts` → `runPipeline()` a real, expected 1-hop path (smoke-test legitimately calls it), confirmed
  safe by reading `smokeTest.ts`'s own `GatewayConfig` construction directly — its one `servers` entry always
  points at the internal `fixtureServerPath()`, never anything user-supplied. `docs/GRAPHIFY_VERIFICATION.md`
  updated with a new dated section and refreshed running counts/limitations wording.
- Files materially changed: `docs/GRAPHIFY_VERIFICATION.md`. `graphify-out/` remains gitignored, confirmed not
  staged via `git status --short` before committing.
- Commands actually executed and their actual results: `graphify update .`; one `graphify query`; four
  `graphify path` invocations (listed above); `grep -n "^import"` on `doctor.ts`, `configValidate.ts`,
  `integrate.ts`, `smokeTest.ts` to verify/refute each path result against real source. `pnpm run build`/`lint`/
  `test` re-confirmed clean (206 tests, 2 skipped) after the doc-only change. Committed as `d530d69 docs: record
  Milestone 5 Graphify re-index and query verification`.
- Verification result: PASS — every required query was run and every finding checked against source before
  being trusted or written down; no code or claim was changed based on a graph result alone.
- Known limitations / follow-up risk: none new. Phase 11 (CI matrix — largely already satisfied by the
  packed-install step added in Phase 1; a final confirmation pass remains), Phase 12 (full/clean-room
  verification), and Phase 13 (final commits/push/CI) have not started.
- Unresolved questions: none blocking.
- Exact next action: Phase 11/12 — confirm CI coverage for every new command, then run the complete local
  verification gate followed by a clean-room user journey and clean-clone verification.

### 2026-08-25 — Milestone 5, Phase 11 (CI matrix confirmation) and Phase 12 (full verification + clean-clone)

- Prompt objective: confirm CI already exercises every new command, then run the complete local gate, a
  clean-room user journey using only committed documentation, and clean-clone verification at the exact
  implementation candidate — repairing any real defect found before writing this entry.
- Continuity check: re-read the Phase 1–10 session-log entries above and confirmed local HEAD was `ac710c2`
  (Phase 10) with a clean tree before starting.
- **Phase 11**: reviewed `.github/workflows/ci.yml` directly — `pnpm run test` already runs all 50 onboarding-CLI
  unit tests plus the (then-new) `lifecycle.test.ts`, and `scripts/verify-packed-install.mjs` (wired into both
  jobs in the Phase 1 commit) already exercises `agentgate smoke-test` from a genuinely installed package.
  Concluded no additional CI wiring was needed. Added one more test —
  `packages/gateway/tests/onboarding-smoke-test.test.ts`'s *"still cleans up its temp directory when an
  injected internal failure throws mid-run"* — forcing a real exception (a mocked `fs.writeFileSync` throw)
  mid-run and confirming the `try/finally` cleanup still fires, giving explicit executable evidence for the
  "cleanup on injected failure" requirement beyond the structural JS guarantee alone. Committed as `f2d21fb
  test(smoke-test): verify cleanup on an injected internal failure`.
- **Phase 12, Step 1 (local candidate re-verification)** — commands actually run against local HEAD, in order,
  with actual results:
  - `pnpm install --frozen-lockfile` → up to date.
  - `pnpm run build` → all four buildable packages clean, `copy-assets.mjs` copy confirmed in output.
  - `pnpm run lint` → 0 errors, the same 2 pre-existing unrelated warnings.
  - `pnpm run test` → **211 tests** (52 policy + 16 control-center + 143 gateway, 2 gateway tests correctly
    platform-skipped on this Windows machine).
  - All three demos (`secret-exfiltration`, `downstream-secret-result`, `policy-drift-replay`) and
    `agentgate smoke-test` → all exit 0.
  - `agentgate init` into a path containing spaces (`.../my project with spaces/`) → succeeded; a second `init`
    into the same path without `--force` → correctly refused (exit 1, both files unchanged); `--force` → both
    files rewritten.
  - `agentgate config validate` (human and `--json`) and `agentgate doctor` (human and `--json`) against that
    spaces-containing project, run from **three different working directories** (the project's own directory,
    the repo root, and the OS temp-directory root) → identical, correct results each time; the `--json`
    `db_path` field is now an absolute path — direct evidence the Phase-12-discovered config-resolution fix
    (see below) is active in this build.
  - **Config-resolution regression check, specifically**: launched a real gateway via a real MCP client
    (`StdioClientTransport`) using the spaces-containing config, from `process.cwd() =
    C:\Users\chidh\Downloads\agentgate` (deliberately not the project directory) — a real `echo` tool call
    succeeded, proving the relative `policy`/`db_path` fields resolved correctly against the config file's own
    directory rather than the launching process's cwd.
  - `agentgate integrate claude-code|antigravity|generic` against the same project → all three produced valid
    snippets; **Antigravity confirmed as a verified, cited-source client** (`https://antigravity.google/docs/
    ide/mcp/`), not the generic fallback — explicit status recorded here per the prompt's requirement.
  - `node scripts/verify-packed-install.mjs` → all 9 checks PASS (pack, tarball-content inspection, install all
    three tarballs together into a fresh temp consumer, run the installed CLI's help/`--version`/`smoke-test`).
  - `agentgate audit verify` against the spaces-project's real database (populated by the config-resolution
    check's real tool call above) → both chains verified (3 audit records, 0 replay records — no replay was
    performed in this session).
  - The exact `security.yml` tracked-file secret-scan pattern, `git diff --check`, and a tracked-file grep for
    `.sqlite`/`.log`/`token`/`.env`/`mcp*.json`/`.tgz`/`.tar.gz` patterns → all clean, nothing found.
  - All scratch directories removed afterward; `git status --short` confirmed only `.claude/`/`CLAUDE.md`
    untracked; a `netstat` check confirmed no lingering listeners on ports 4000/4001/5173.
  - **No defect was found during this re-verification pass** — the config-resolution fix from the immediately
    preceding session (commit `79d8fc0`) held up under every scenario tested above, including ones not
    explicitly exercised when it was first written (the three-different-cwd `doctor`/`config validate` check,
    and the real end-to-end MCP-client launch from the repo root with a spaces-containing project path).
- **Phase 12, Step 2 (clean-clone verification)** — candidate commit **`79d8fc0625fcbb98c1e9f805bdac817f34174d71`**
  (`fix(config): resolve relative policy/db_path against the config file's own directory`), the actual local
  HEAD at the time this verification started. `git clone` of the local repository (not a working-directory
  copy) into a fresh, ephemeral temp directory outside the repository (removed at the end of this phase — its
  path is not recorded here beyond "an OS temp subdirectory," per the instruction not to leak an unnecessary
  personal path). Confirmed via `git log -1`/`git status --short` inside the clone before running anything, and
  confirmed `.claude/`, `CLAUDE.md`, and `graphify-out/` all absent (never tracked, so a fresh clone genuinely
  does not have them). Full gate repeated inside the clone, using only the clone's own `node_modules`/`dist`
  (never copied from the working tree):
  - `pnpm install --frozen-lockfile` (fresh, 448 packages) → succeeded.
  - `pnpm run build` → clean, identical output shape to the working-tree build.
  - `pnpm run lint` → same 0 errors / 2 pre-existing warnings.
  - `pnpm run test` → **211 tests**, identical count and composition to the working-tree run.
  - All three demos and `agentgate smoke-test` (via the clone's own `dist/cli.js`) → all exit 0.
  - `node scripts/verify-packed-install.mjs` (the clone's own copy, packing the clone's own packages) → all 9
    checks PASS.
  - `init` → `config validate` → `doctor` (human + JSON) → `integrate` for all three clients, all against a
    fresh project generated inside the clone's own temp scratch area, using the clone's own `dist/cli.js`.
  - **Config-resolution regression check, independently repeated inside the clone**: a real gateway launched
    via the clone's own compiled CLI and the clone's own `@modelcontextprotocol/sdk` installation, with
    `process.cwd()` set to the OS temp-directory root (neither the clone nor the generated project directory)
    — a real `echo` tool call succeeded and the Control API's `/api/health` endpoint (queried with the
    captured token) reported the correct absolute `db_path`, confirming the fix is genuinely part of the
    committed, cloneable source — not an artifact of the original working tree's own already-built `dist/`.
  - `agentgate audit verify` against the resulting database → both chains verified (3 audit records).
  - The exact tracked-file secret scan → clean; `git status --short` inside the clone → empty (clean tree,
    `dist`/`node_modules` gitignored as expected).
  - A `netstat` check after the clone-side gateway was stopped → no lingering listeners.
  - Every clone-side scratch directory removed, then the clone itself removed, then the *original* working
    repository's own `git status --short` re-checked and confirmed unchanged (only `.claude/`/`CLAUDE.md`
    untracked) — the clean-clone work never touched the working tree.
  - **Clean-room documentation journey**: performed using only the commands actually printed by `init`'s own
    "Next steps" output and documented in `README.md`/`docs/DEVELOPMENT.md` — install → init → validate →
    doctor → integrate → launch (via the literal generated integration snippet) → inspect the Control API →
    stop cleanly → remove the generated project directory. Every step matched documented behavior exactly; no
    undocumented command or manual code inspection was required to complete it.
  - **No defect was found in the clean clone either** — this candidate is proven at the exact commit that will
    be pushed, not an earlier one.
- Files materially changed by this phase: `packages/gateway/tests/onboarding-smoke-test.test.ts` (Phase 11,
  already committed as `f2d21fb` before this entry). No other source files changed — Phase 12 was verification-
  only and found nothing requiring repair.
- Verification result: **PASS on every Phase 11 and Phase 12 item**, both in the working tree and independently
  in an isolated clean clone at the exact same commit (`79d8fc0`).
- Known limitations / follow-up risk: all local and clean-clone verification in this session ran on Windows
  only — no Linux or macOS testing was performed locally in this phase. Linux (Ubuntu, Node 20 and 22) and a
  second Windows confirmation are expected from GitHub Actions CI in Phase 13, not claimed here. The two
  POSIX-only lifecycle tests remain correctly skipped in every local/clean-clone run recorded above, per the
  documented platform limitation from the Phase 7 entry.
- Unresolved questions: none blocking.
- Exact next action: Phase 13 — pre-push audit, push `main` to `origin`, observe GitHub CI/Security to
  completion for the exact pushed commit, repair any real failure found there, and produce the final report.

### 2026-08-25 — Milestone 5, Phase 13 (pre-push audit, push, and CI/Security observation)

- Prompt objective: audit the exact commit range before pushing, push `main` normally, observe GitHub CI and
  Security to completion for the exact pushed commit, and close out the ledger.
- Continuity check: confirmed local HEAD `b57e7ab` (the just-committed Phase 11-12 ledger entry) with a clean
  tree (`git status --short`: only `.claude/`/`CLAUDE.md` untracked) before starting.
- **Pre-push audit** (against `origin/main` at `a6402d5`, the last previously-published commit):
  - `git log --oneline origin/main..HEAD` → exactly 12 commits, all identifiable Milestone 5 work (packaging
    fix, the onboarding CLI feature commit, an ADR/ledger commit, the lifecycle/clipping fix, four documentation/
    visual/Graphify commits, the injected-failure test, the config-resolution fix, and two ledger entries) — no
    unrelated or unexpected commit present.
  - `git diff --stat origin/main...HEAD` → 42 files changed, 3328 insertions, 34 deletions; every changed path
    reviewed and consistent with the work described above.
  - `git diff --check origin/main...HEAD` → clean.
  - `pnpm install --frozen-lockfile` → "Already up to date," confirming every `package.json` change across the
    full range (the two `"files"` field additions) is already reflected in `pnpm-lock.yaml`.
  - `git tag -l` → empty; `git diff --name-only origin/main...HEAD` grepped for `release`/`publish`/workflow
    files → only `.github/workflows/ci.yml` (the packed-install verification step addition, already reviewed in
    the Phase 1 ledger entry) — no publish/release/tag-related change of any kind.
  - The exact `security.yml` tracked-file secret-scan pattern, run across the full current tree → clean.
  - Grepped `README.md`/`docs/*.md` for "Antigravity" outside of accurate, already-reviewed context (status
    tables, ADR-0011, historical ledger entries) → no overclaiming language found; Antigravity is consistently
    described as a verified, cited-source client, matching the actual runtime behavior confirmed in Phase 12.
  - Final `git status --short` before pushing → only `.claude/`/`CLAUDE.md` untracked.
- **Push**: `git push origin main` → `a6402d5..b57e7ab`. Confirmed immediately afterward: local
  `git rev-parse HEAD` and `git rev-parse origin/main` both equal `b57e7ab3049e96c85c251828218d1c70d8bab264`.
- **GitHub Actions observation, for commit `b57e7ab` specifically** (not an earlier commit's runs):
  - **CI** run `32803371630` (https://github.com/chidhvilasa/agentgate/actions/runs/32803371630) — all 3 jobs
    **PASS**: `build-test (ubuntu, node 20)` 1m12s, `build-test (ubuntu, node 22)` 1m15s, `build-test (windows,
    node 22)` 2m39s. This is the first time the config-resolution fix (and the rest of this session's Phase
    11/12 work) has been exercised on Linux at all — this session's own local/clean-clone verification was
    Windows-only, per the known limitation already recorded in the Phase 12 entry above.
  - **Security** run `32803371578` (https://github.com/chidhvilasa/agentgate/actions/runs/32803371578) — all 3
    jobs **PASS**: `Dependency audit (high+ severity)` 18s, `CodeQL (TypeScript/JavaScript)` 1m20s,
    `Tracked-file secret scan (deterministic, local)` 4s.
  - **No CI- or Security-discovered defect this push** — both workflows passed on the first attempt for this
    exact commit; no repair, no follow-up commit, and no second push were needed in this phase.
  - No package was published, no tag was created, no GitHub Release was created, and no repository setting
    (visibility, branch protection) was changed at any point in this session.
- Files materially changed by this phase: none (push/observation only; this ledger entry itself is the only
  content change, committed separately after this entry is written, per the established self-referential-hash
  avoidance rule).
- Verification result: PASS — final remote HEAD `b57e7ab` has both required GitHub Actions workflows fully
  green, confirmed by directly observing the completed run status for that exact commit via `gh run view`, not
  inferred or assumed from an earlier run.
- Known limitations / follow-up risk: none new beyond what Phase 12 already recorded (Windows-only local
  testing; Linux coverage comes from CI, now confirmed green for this exact commit). No macOS coverage exists
  anywhere in this project, local or CI, and is not claimed.
- Unresolved questions: none blocking.
- Exact next action: none — Milestone 5 is locally complete and its final candidate commit's required CI/
  Security checks are green on the pushed remote HEAD. Produce the final report.

### 2026-08-25 — Milestone 6, Phases 1–8 implementation + ADR-0012 (Tool Integrity Registry and Rug-Pull Defense)

- Prompt objective: implement a local Tool Integrity Registry that fingerprints, tracks, and can quarantine
  downstream MCP tool definitions, enforced in the actual gateway request path (not just surfaced as a UI
  warning), covering server identity, canonicalization/fingerprinting, an append-only registry with a mutable
  current-state projection, enrollment/trust modes with fail-closed enforcement, a safe field-level drift diff,
  CLI commands, and Control API routes — with ADR-0012 written before the first commit.
- Continuity check: confirmed starting local HEAD `5b9a49c36553e8438f8baa3460c46fe34b452334` matched
  `origin/main` exactly (`git fetch origin` + `git rev-parse HEAD`/`git rev-parse origin/main`, both equal) before
  any edit; re-read this ledger (all ADR-0001–0011, especially ADR-0004's two-table storage pattern, ADR-0005's
  legacy-2025-only compatibility boundary, ADR-0009's `sanitizeJsonValue()`/secret-redaction primitive, and
  ADR-0010's single-table append-only pattern and its "policy re-evaluation only, no execution" structural
  no-execution test convention) before designing the registry.
- Implementation completed this session (commands/results below):
  - New module `packages/gateway/src/tool-integrity/identity.ts` — `computeServerIdentity()`, `server-identity-v1`.
  - New module `packages/gateway/src/tool-integrity/canonicalize.ts` — `canonicalizeToolDefinition()`/
    `canonicalizeManifest()`, `tool-definition-v1`, with 27 golden-fixture tests
    (`tests/tool-integrity-canonicalize.test.ts`) proving key-reorder stability, list-reorder stability,
    detection of every supported field-change type, duplicate/case-confusable name detection, Unicode/line-ending
    determinism, and fail-closed behavior on hostile/oversized/malformed/cyclic input.
  - New module `packages/gateway/src/tool-integrity/registry.ts` — the append-only state machine
    (`applyScanToRegistry()`/`acceptCandidate()`/`rejectCandidate()`/`isFingerprintTrusted()`), with 21 tests
    (`tests/tool-integrity-registry.test.ts`) covering every transition, the stale-approval race, reappearance-
    after-removal, and rejected-then-redrifted behavior.
  - New module `packages/gateway/src/tool-integrity/scan.ts` — the ONLY Tool Integrity module that connects to a
    downstream server; paginated `tools/list` (fixing a real pre-existing single-page-only bug in the prior
    inline discovery code, confirmed by reading the installed SDK's `Client.listTools()` source directly), capped
    at `MAX_PAGES = 200`.
  - New module `packages/gateway/src/tool-integrity/enforcement.ts` — `filterTrustedTools()`/
    `checkCallAllowed()`, wired into `packages/gateway/src/transport/stdio.ts`'s `ListToolsRequestSchema`/
    `CallToolRequestSchema` handlers (discovery-side and call-dispatch-side quarantine, the latter checked BEFORE
    any policy evaluation or `runPipeline()` call).
  - New module `packages/gateway/src/tool-integrity/diff.ts` — bounded, pure, side-effect-free field-level diff
    (`MAX_DEPTH=12`, `MAX_CHANGES=200`, `MAX_VALUE_PREVIEW_CHARS=300`), with 29 tests
    (`tests/tool-integrity-diff.test.ts`) including dedicated hostile fixtures (prompt injection, ANSI escapes,
    HTML/`<script>`, embedded secrets, huge/deep schemas, confusable Unicode, prototype-pollution-shaped keys).
  - New module `packages/gateway/src/tool-integrity/cli.ts` — thin, testable wrappers
    (`runToolsScan`/`Status`/`Diff`/`Trust`/`Reject`/`History`) behind six new `agentgate tools <subcommand>` CLI
    commands wired into `packages/gateway/src/cli.ts`, with 9 tests (`tests/tool-integrity-cli.test.ts`) run
    against a real fixture downstream server, plus a manual end-to-end run of the built CLI binary confirming
    `scan`→`status`→`diff`→`trust`(stale rejected, then exact-match accepted)→`history` all behave correctly and
    exit with the correct codes.
  - `packages/gateway/src/storage.ts` — new `tool_integrity_events` (append-only, hash-chained,
    `insertToolIntegrityEvent()`/`verifyToolIntegrityChain()` mirroring the existing audit/replay chain pattern
    exactly) and `tool_integrity_state` (mutable current-state projection) tables, added as the LAST migration in
    the existing `MIGRATIONS` array (append-only-at-end preserved).
  - `packages/gateway/src/config/registry.ts` — new `tool_integrity.mode` config field
    (`explicit`/`tofu`/`monitor`/`disabled`), defaulting to `monitor` for backwards compatibility (see ADR-0012
    point 4 for the full honest reasoning).
  - `packages/gateway/src/api/control.ts` — 7 new authenticated `/api/tool-integrity/*` routes (summary, tools,
    history, diff, rescan, accept, reject) reusing the existing loopback/token/Host/Origin/CORS/safe-error
    middleware unchanged; strict body-schema validation rejecting unknown/execution-like fields; 19 tests
    (`tests/tool-integrity-api.test.ts`) covering auth failure, hostile Host/Origin, malformed candidate ids,
    stale-fingerprint (409), double-submit (candidate consumed → 404 on retry), concurrent accept-vs-reject (one
    wins, the other is rejected as stale, never both), no-secret/no-token/no-path leakage in error responses, and
    a real rescan against the fixture server.
  - `packages/gateway/src/server.ts` — passes `{ server: config.servers[0], mode: config.tool_integrity.mode }`
    into `buildControlApi()`.
  - `packages/gateway/src/onboarding/smokeTest.ts` — added the required `tool_integrity: { mode: 'monitor' }`
    field to its manually-constructed config literal (a real TS build error found and fixed this session).
  - New structural no-execution test, `tests/tool-integrity-no-execution.test.ts` (6 tests), mirroring
    `replay-no-execution.test.ts`'s import-statement-only-scan approach: proves `canonicalize.ts`/`identity.ts`/
    `registry.ts`/`enforcement.ts`/`diff.ts` never import the MCP SDK or execution/approval modules, and that
    `scan.ts` is the sole exception permitted to import the MCP client transport.
  - New end-to-end test, `tests/tool-integrity-gateway-enforcement.test.ts` (1 test) — identified during this
    session's Phase A audit as a real coverage gap: every other Tool Integrity test exercised the internal
    functions directly, but nothing exercised the actual wired-up `ListToolsRequestSchema`/`CallToolRequestSchema`
    handlers via a real MCP client talking to the real compiled gateway binary. This test spawns the real CLI,
    connects a real `@modelcontextprotocol/sdk` `Client` over stdio, and proves: (1) `tools/list` returns `[]`
    before any review, even though the downstream fixture server really advertises 4 tools; (2) a direct
    `tools/call` for `echo` — as if the calling client had cached the name from an earlier session — is blocked
    with an `[AgentGate] Tool Integrity:` error and `isError: true`; (3) the downstream fixture server's own
    call-counter file (an external, process-independent artifact, not an in-process spy) remains `0` after the
    blocked call, proving the downstream process was never contacted; (4) accepting the exact candidate
    out-of-process (via `runToolsTrust()`, mirroring what the CLI/Control API/UI do against the same database)
    then lets the SAME already-open client connection call `echo` successfully with no reconnect, the response
    text is exactly `"hello"`, and the counter becomes `1` — proving `checkCallAllowed()` re-reads registry state
    fresh on every call rather than caching a startup-time decision.
  - Control Center: `apps/control-center/src/api.ts` gained 7 typed `toolIntegrity*` client methods and 5
    exported response types; `apps/control-center/src/pages/ToolIntegrity.tsx` (new) — summary stat cards, a
    per-tool status table, a diff/review panel (exact-fingerprint accept with a confirmation dialog stating what
    is/isn't guaranteed, reject as the calmer default action with no confirmation, both disabled mid-request to
    prevent double-submit), a monitor/disabled-mode warning banner, and a collapsible history panel; wired into
    `App.tsx` navigation (with a live pending/drifted-count badge) and routing; ~100 lines of new, scoped CSS
    appended to `index.css` (no existing rule modified). 31 new component tests
    (`apps/control-center/src/pages/ToolIntegrity.test.tsx`) covering loading/empty/trusted/quarantined/drifted
    states, all five diff-change classifications, truncation display, accept/reject with exact ids (asserted via
    `toHaveBeenCalledWith`), confirmation-declined, stale-fingerprint (409-shaped) and already-consumed
    (404-shaped) error surfaces, double-submit prevention for both accept and reject, rescan busy/error states,
    history expand/collapse, hostile-content rendering (HTML/`<script>`, prompt-injection phrasing, ANSI escapes)
    as inert text with zero `<script>` elements created, absence of any "trust all"/name-only-trust control, and
    basic keyboard-focus/accessible-name checks.
  - ADR-0012 written in full (see above) before this commit, documenting the actual implemented design (server
    identity, canonicalization/fingerprint versioning, enrollment modes and the honest `monitor`-default
    trade-off, bidirectional gateway-path enforcement, scan timing and the deliberate non-handling of
    `list_changed`, the residual scan-to-call TOCTOU limitation, exact-fingerprint stale-approval prevention, the
    two-table append-only + projection storage pattern, the bounded/safe diff design, and fail-closed behavior),
    plus explicit limitations (fingerprints are not signatures, do not prove runtime behavior, local identity is
    not remote attestation, annotations are untrusted, local tamper evidence is not tamper-proof, TOCTOU is not
    fully eliminated, no supply-chain/attestation/signing/sandboxing/zero-false-positive claims).
- Commands executed and results:
  - `pnpm run build` (repo root) → clean across all 4 buildable packages, both before and after every change in
    this session.
  - `pnpm run lint` (repo root) → 0 errors throughout this session's work; each transient lint error introduced
    while writing new code (unnecessary type assertions in `control.ts`/diff-panel test, an unused import) was
    fixed immediately, confirmed by re-running lint; only the same 2 pre-existing, unrelated `no-explicit-any`
    warnings from Milestone 4/5 remain (never addressed, by established convention).
  - `pnpm run test` (repo root, all 3 packages) → **367 tests passed, 2 skipped (the two documented POSIX-only
    lifecycle tests), 0 failed, across 31 test files** (`packages/policy`: 52 tests/3 files;
    `apps/control-center`: 47 tests/2 files; `packages/gateway`: 268 tests/26 files, 2 skipped). This is the exact
    count as of this entry — not the pre-Milestone-6 211-test baseline, which this entry does not treat as a
    target to preserve verbatim.
  - All 3 pre-existing demos (`secret-exfiltration`, `downstream-secret-result`, `policy-drift-replay`) re-run
    manually after the `stdio.ts` refactor → all 3 **PASS unchanged**, confirming the new default `monitor` mode
    and the paginated-scan-based discovery rewrite introduced no regression in end-to-end demo behavior.
  - `node scripts/verify-packed-install.mjs` → **PASS** (tarball packing, packaging hygiene, clean-consumer
    install, installed-CLI smoke-test all green) — confirms the new `tool_integrity` config field and the six new
    CLI subcommands do not break the packed-install path.
  - Manual end-to-end CLI walkthrough against a real spawned fixture server (`agentgate tools scan` → `status` →
    `diff <id>` → `trust <id> --fingerprint <wrong>` [rejected, 409-equivalent] → `trust <id> --fingerprint
    <exact>` [accepted] → `history`) → every step produced the expected output and exit code; verified manually
    with `echo "exit=$?"` after each command.
- Phase A audit against the milestone's named security invariants (see prompt) — reconciled against actual
  source/tests, not assumed: quarantine-by-mode ✓ (registry tests); discovery-side filtering ✓ (enforcement.ts +
  new gateway-path test); direct-cached-name-call block ✓ (new gateway-path test, the one genuine coverage gap
  found and closed this session — see above); downstream not contacted on blocked path ✓ (external counter-file
  proof in the same test); key/list-reorder stability ✓ (canonicalize golden fixtures); meaningful-change
  detection for description/schema/annotations/title/metadata ✓ (canonicalize + diff fixtures); duplicate names
  and malformed/oversized/deep definitions fail closed ✓ (canonicalize fixtures); annotations never lower
  enforced risk ✓ (enforcement.ts explicitly never reads them, documented in its own comments); exact-fingerprint
  accept/reject required, no stale-approval ✓ (registry/CLI/API stale-race tests); rejection persists across
  rescan ✓ (registry + CLI tests); accept appends history without rewriting the prior baseline ✓ (registry
  tests); migration + tamper verification ✓ (append-only-at-end `MIGRATIONS` entry, `verifyToolIntegrityChain()`);
  hostile content bounded/redacted/escaped at every public boundary ✓ (canonicalize + diff hostile fixtures +
  Control Center component tests); scan/status/diff never call a tool ✓ (by construction — `scan.ts` only calls
  `initialize`/`tools/list`, proven structurally); legacy-MCP-only compatibility claim remains truthful ✓ (ADR-
  0012 point 6 explicitly restates the ADR-0005 boundary and does not claim newer protocol support).
- Files materially changed by this phase: see the Implementation section above; full list also captured in
  ADR-0012's "Affected files."
- Verification result: PASS on every item audited above; build/lint/full-test-suite/all-3-demos/packed-install
  all green as of this entry. Not yet performed as of this entry: the rug-pull demo itself
  (`examples/tool-rug-pull/demo.mjs`), documentation updates beyond ADR-0012, browser/screenshot verification,
  Graphify re-indexing, the full adversarial gate list (hostile-fixture-at-CI-scale, DB-tampering/deletion/
  reordering, Milestone-5-DB migration fixture, injected-failure cleanup proof), clean-clone verification, and
  any commit/push/CI observation — none of this session's work has been committed yet.
- Known limitations / follow-up risk: the scan-to-call TOCTOU window described in ADR-0012 point 7 remains
  un-narrowed beyond "since the last scan/rescan"; the `monitor` default means a fresh `agentgate init` still
  needs its generated template/documentation updated to steer new projects toward `explicit` mode (not yet done
  as of this entry — tracked as outstanding); no dedicated migration-from-a-Milestone-5-database fixture test has
  been run yet (tracked as outstanding for the adversarial-gates phase).
- Unresolved questions: none blocking further implementation.
- Exact next action: implement the deterministic rug-pull demo (`examples/tool-rug-pull/demo.mjs`), then complete
  the remaining backend/CLI adversarial-gate coverage (migration fixture, DB-tampering tests, injected-failure
  cleanup proof), then documentation, browser verification, Graphify, full gates, clean-clone, and commit/push/CI
  observation.

### 2026-08-25 — Milestone 6, Phase B (Control Center verification) + Phase C (rug-pull demo) — two real bugs found and fixed

- Prompt objective: verify the Control Center build/lint/tests after the previously-uncommitted CSS addition, add
  comprehensive `ToolIntegrity.tsx` component tests, then implement the deterministic rug-pull demo
  (`examples/tool-rug-pull/demo.mjs`) as the milestone's central executable security proof.
- Continuity check: confirmed working tree still matched the prior entry's state (`git status --short` — only the
  same Tool Integrity files, `.claude/`, `CLAUDE.md` untracked); re-read ADR-0012 before starting.
- **Phase B**: `pnpm run build`/`pnpm run lint` clean after the CSS addition (39 modules transformed, +1 CSS
  chunk). Wrote `apps/control-center/src/pages/ToolIntegrity.test.tsx` — 31 tests covering loading/empty/
  trusted-only/quarantine/drifted states, all five diff-change-kind renderings, truncation display, exact-
  candidate-id+fingerprint accept (`toHaveBeenCalledWith` assertion) and reject, confirm-declined, 409-shaped
  ("stale") and 404-shaped ("already consumed") error surfaces with the panel remaining open for retry, double-
  submit prevention for both accept and reject, rescan busy/error states, history expand/collapse, hostile HTML/
  script/prompt-injection/ANSI rendered as inert text (`document.querySelectorAll('script').length === 0`
  asserted explicitly), absence of any "trust all" control, and keyboard-focus/accessible-name checks. Two tests
  needed a fix after the first run (an ambiguous multi-match query resolved with `getByRole`/`within(panel)`
  scoping) — both were test-authoring issues, not component defects. Final: 31/31 passing,
  `apps/control-center` suite 47/47 passing (16 pre-existing + 31 new), 0 lint errors.
- **Phase C — rug-pull demo build and two real bugs found and fixed**: wrote a new dynamic fixture MCP server
  (`examples/tool-rug-pull/fixtures/rug-pull-fixture-server.mjs`) whose advertised `read_file` tool definition
  changes based on a "generation" file re-read on every `tools/list` call (1 = benign baseline, 2 = malicious rug-
  pull carrying a bundled synthetic secret/HTML-script/ANSI-escape/prompt-injection payload in its description, 3
  = a distinct, legitimate benign v2 update), letting the SAME running downstream process model a real rug-pull
  without restarting it. Wrote the 18-step demo script itself. **First run: 3 of ~40 assertions failed**,
  surfacing two genuine, previously-uncovered defects (not demo-authoring mistakes) plus one demo-authoring
  mistake and one demo-side false-negative in an assertion — all four investigated and fixed:
  1. **Real bug — `tools/list` staleness**: `transport/stdio.ts`'s `ListToolsRequestSchema` handler captured its
     filtered tool list ONCE at gateway startup (`exposedTools`, computed outside the handler closure) and never
     recomputed it, so a tool trusted/rejected out-of-band via the CLI/Control API after startup would not appear
     (or disappear) from `tools/list` until the gateway was restarted — even though `checkCallAllowed()` already
     re-read live registry state on every `tools/call`. This inconsistency (call-side freshness vs. discovery-
     side staleness) was a real correctness gap the demo's Step 3/Step 15 assertions caught. **Fix**: the raw,
     unfiltered tool list from the startup scan is now kept in scope (`validRawTools`) and
     `filterTrustedTools(...)` is called fresh, inline, inside the `ListToolsRequestSchema` handler on every
     request — cheap (DB lookups against already-known tool objects), and never re-contacts the downstream server
     (only an explicit rescan does that). Verified via the full test suite (no regression) and the demo (now
     passing).
  2. **Real bug — rejected-then-rescanned-unchanged incorrectly reopened as drift**: `registry.ts`'s
     `applyScanToRegistry()` compared a rescanned fingerprint against `existing.trusted_fingerprint ??
     existing.candidate_fingerprint` for ALL non-`removed` existing states, including `rejected`. For a tool that
     had a REAL prior trusted baseline (e.g. generation 1, trusted) before later drifting and being rejected
     (e.g. generation 2), `trusted_fingerprint` is non-null (still generation 1's), so this comparison used
     generation 1's fingerprint as the reference even for a `rejected` tool — meaning re-scanning the SAME,
     unchanged, already-rejected generation-2 definition would ALWAYS look like fresh drift (gen2 ≠ gen1 is
     always true), silently reopening a review cycle for a definition a human had already explicitly rejected.
     The existing `tool-integrity-registry.test.ts` coverage for "rejected tool rescanned" had only exercised a
     tool that was NEVER trusted before rejection (`trusted_fingerprint` null), where the `??` fallback happened
     to land on `candidate_fingerprint` — the correct value — masking this bug in a narrower scenario. The rug-
     pull demo's Step 12 (trust v1 → reject v2 → rescan v2 unchanged → must stay rejected) is a strictly broader
     scenario that exposed it. **Fix**: added a dedicated `existing.status === 'rejected'` branch in
     `applyScanToRegistry()` that compares against `existing.candidate_fingerprint` specifically (the fingerprint
     that was actually rejected) — unchanged stays `rejected`; a genuinely different fingerprint opens a fresh
     `drifted` cycle with a clear reason string. Verified via the full test suite (268→270 gateway tests, no
     regression) and the demo.
  3. **Demo-authoring mistake**: Step 17 asserted a `baseline_accepted` event for generation 1's acceptance, but
     `baseline_accepted` is emitted only by `tofu` mode's automatic first-use trust — this demo runs in
     `explicit` mode throughout, where a first-time human review emits `accepted`, not `baseline_accepted`.
     Fixed the assertion, not the code (the code was correct; the demo's expectation was wrong).
  4. **Demo-side test bug (double-encoding), not a product bug**: Step 18's hostile-ANSI assertion built its
     comparison text via `JSON.stringify(changes)` (re-serializing an already-parsed diff array), which encodes a
     raw ESC control byte as the six literal characters `` in the resulting JSON text — a
     literal-byte `.includes()` check against that re-encoded text can never match the real control character,
     regardless of whether the real product behavior was correct. Independently verified via a direct
     `canonicalizeToolDefinition()` script run against the exact hostile description that the raw ANSI byte, the
     HTML/script tag, and the prompt-injection phrase are ALL preserved correctly end-to-end through
     canonicalization (only the AWS-key-shaped substring is redacted, exactly as intended) — confirming this was
     purely a demo-script assertion bug. Fixed by checking the actual parsed `after` string value directly
     instead of a re-stringified copy.
  - Also found and fixed, while auditing hostile-content handling for this phase: `tests/tool-integrity-
    diff.test.ts` used a synthetic AWS-key-shaped literal (`AKIA` + a different 16-character filler than the
    project's standard placeholder) that is NOT on
    `.github/workflows/security.yml`'s exact-match secret-scan allowlist (only `AKIAIOSFODNN7EXAMPLE` and four
    other specific literals are allowlisted) — this would have failed the Security workflow's tracked-file scan
    on push despite being an obviously-fake value. Replaced it with the already-allowlisted
    `AKIAIOSFODNN7EXAMPLE` literal (same test intent, zero behavior change); re-ran the exact CI regex/allowlist
    logic locally against the full tree (excluding `node_modules`/`dist`/`.git`) and confirmed clean.
  - Added a deterministic fault-injection hook to the demo itself (`RUG_PULL_INJECT_FAILURE=after-step-3`,
    documented in the script as a no-op unless explicitly set) and a new companion test,
    `packages/gateway/tests/tool-rug-pull-demo-cleanup.test.ts`, spawning the real demo as a child process with
    that env var set and proving — as executable evidence, not a `finally` block inspected by eye — that (a) the
    process exits non-zero with the expected injected-failure message, (b) no `agentgate-rug-pull-*` temp
    directory is left in the OS temp dir afterward, and (c) the gateway's control port (4344) is no longer
    listening. A second test confirms the hook is a true no-op when unset (the normal demo still passes end to
    end). Both pass.
- Commands executed and results:
  - `pnpm run build` → clean, both before writing the demo and after every subsequent fix.
  - `pnpm run lint` → 0 errors after each fix (three transient errors introduced while writing new test/demo code
    — an unused `fs` import, an `any`-typed callback parameter, an unused `stderrBuffer` — each fixed immediately
    and reconfirmed).
  - `pnpm run test` (all 3 packages) → **369 tests passed, 2 skipped, across 32 test files** (`packages/policy`:
    52/3; `apps/control-center`: 47/2; `packages/gateway`: 270/27, 2 skipped) — the 2 new gateway test files this
    phase added (the rug-pull cleanup proof) plus the 2 real bugs fixed produced +2 files/+2 tests over the prior
    entry's 367/31.
  - `node examples/tool-rug-pull/demo.mjs`, run 3 times consecutively → **all 3 runs: exit code 0, all ~40
    PASS lines, no FAIL lines** — deterministic.
  - `node examples/{secret-exfiltration,downstream-secret-result,policy-drift-replay}/demo.mjs` (re-run after the
    `stdio.ts`/`registry.ts` fixes) → all 3 **PASS unchanged**, confirming no regression to pre-existing demo
    behavior from either fix.
  - `node scripts/verify-packed-install.mjs` → **PASS** (unchanged).
  - `git status --short` after every demo run → clean (only the intended tracked-file modifications/new files;
    no residue).
  - Manual full-tree secret-pattern scan using the exact `security.yml` regex/allowlist (excluding
    `node_modules`/`dist`/`.git`) → clean.
- Files materially changed by this phase: `apps/control-center/src/pages/ToolIntegrity.test.tsx` (new),
  `packages/gateway/src/transport/stdio.ts` (bug fix — fresh per-request discovery filtering),
  `packages/gateway/src/tool-integrity/registry.ts` (bug fix — rejected-state reference fingerprint),
  `packages/gateway/tests/tool-integrity-diff.test.ts` (secret-literal swap to the allowlisted value),
  `examples/tool-rug-pull/` (new: `demo.mjs`, `fixtures/rug-pull-fixture-server.mjs`),
  `packages/gateway/tests/tool-rug-pull-demo-cleanup.test.ts` (new), `.github/workflows/ci.yml` (new step in both
  the Ubuntu and Windows jobs, immediately after the policy-drift-replay demo step).
- Verification result: PASS on every item above. The rug-pull demo is the milestone's required executable proof
  that a benign-to-malicious tool-definition change is detected, quarantined, and blocked before downstream
  execution, and that a later, genuinely distinct benign update is trusted independently — all demonstrated end
  to end against production-built packages, not mocked.
- Known limitations / follow-up risk: this phase's two real bug fixes (discovery-list staleness, rejected-state
  reference fingerprint) were found ONLY because the demo exercised broader state-transition sequences than the
  pre-existing unit tests did — this is a concrete argument for treating the demo as adversarial verification in
  its own right, not merely a presentation artifact, and is noted here in case a future milestone's own unit
  tests should be broadened to cover these same sequences directly (currently covered end-to-end by the demo and
  the new gateway-enforcement test, but not by an additional narrow registry-level unit test for the specific
  "trusted-then-rejected-then-rescanned-unchanged" sequence — worth adding as a follow-up, not blocking).
- Unresolved questions: none blocking.
- Exact next action: remaining backend/CLI adversarial-gate coverage (Milestone-5 DB migration fixture, DB-
  tampering/deletion/reordering tests, further hostile-fixture coverage), then documentation, browser
  verification, Graphify, full gates, clean-clone, and commit/push/CI observation.

### 2026-08-25 — Milestone 6, Phases D–J (migration/tamper tests, documentation, browser verification, Graphify, full adversarial gates, clean-clone, and the implementation commit)

- Prompt objective: complete the remaining backend adversarial-gate coverage (DB migration/tamper tests,
  `agentgate init` recommended-mode default), full documentation, real browser verification with screenshots,
  Graphify re-indexing and cross-checked queries, the full local adversarial gate suite, a clean-clone
  verification at the exact candidate commit, and the commit itself.
- Continuity check: re-read the ADR-0012 and Phase 1–8/B/C entries above; confirmed working tree state matched
  (`git status --short`) before starting.
- **Phase D (remaining adversarial coverage)**:
  - New `packages/gateway/tests/tool-integrity-storage-migration.test.ts` (8 tests): fresh-database chain-empty
    case; migration from a REAL pre-Milestone-6 database (built via the actual current `AuditStorage`, then the
    two `tool_integrity_*` tables dropped and the corresponding `schema_version` row removed — schema-version-
    driven, not a hand-maintained copy of an old schema that could silently drift from the real migrations —
    confirming the pending migration re-runs cleanly and pre-existing audit data is untouched); restart
    persistence; tampering (direct field mutation) detection; deleted-row (sequence-gap) detection; reordered-row
    (swapped `sequence_number` values) detection; corrupted `previous_event_hash` link detection;
    `upsertToolIntegrityState()` true-upsert behavior (one row after two calls on the same primary key, not two).
    First attempt at the migration test hand-crafted an old schema directly and failed with `duplicate column
    name: result_blocked` (the hand-built "legacy" table already had ADR-0009-era columns that a real early-
    version migration would only add later) — fixed by switching to the schema-version-rollback approach
    described above, which can never drift from the real migration list. All 8 pass.
  - `packages/gateway/src/onboarding/init.ts`: `buildConfigTemplate()` now generates new projects with
    `tool_integrity: { mode: explicit }` (previously the field was omitted entirely, implicitly `monitor`) —
    addresses the milestone's explicit instruction to make `explicit` the *recommended* mode concretely, not
    just in prose. Manually verified the generated YAML is valid and passes `agentgate config validate`; existing
    `onboarding-init.test.ts`/`onboarding-doctor.test.ts`/`onboarding-integrate.test.ts` (38 tests) all still pass
    unchanged (doctor never spawns the placeholder downstream server regardless of `tool_integrity` mode, so this
    change does not affect doctor's read-only checks).
- **Phase E (documentation)**: added/updated Tool Integrity sections in `README.md` (Core features bullet, CLI
  block, full "Tool Integrity" section with config/CLI examples and a "what it does and does not prove"
  limitations paragraph, Demo-and-verification block), `docs/POLICY_REFERENCE.md` (full config-field reference
  table, migration guidance, a "common mistakes" entry), `docs/THREAT_MODEL.md` (a full "Tool-definition poisoning
  (rug-pull, ADR-0012)" section with threat/mitigation/limitations, plus entries in the mitigations-implemented/
  deferred and non-goals summaries), `docs/ARCHITECTURE.md` (component table row, a full architecture section
  with a Mermaid flow diagram and per-module design notes), `docs/DEVELOPMENT.md` ("Using Tool Integrity locally"
  walkthrough, demo-list and release-gates updates), `docs/TROUBLESHOOTING.md` (two new entries: the
  `[AgentGate] Tool Integrity: ...` call-blocked message and its per-reason remediation, and the "Stale or
  unknown candidate" CLI/API error), `docs/VERIFICATION.md` (a full Milestone 6 claim/evidence table), `CHANGELOG.md`
  (a new Milestone 6 `[Unreleased]` section, Added + Fixed), and this ledger's ADR-0012 (already written in the
  prior entry). Every limitation stated matches ADR-0012 exactly (fingerprints are not signatures, do not prove
  runtime behavior, local identity is not remote attestation, annotations are untrusted, local tamper evidence is
  not tamper-proof, TOCTOU is not fully eliminated, `monitor` provides no blocking protection) — no doc overclaims
  beyond what the implementation and tests actually demonstrate.
- **Phase F (real browser verification + screenshots)**: temporarily added `playwright` as a workspace
  devDependency (`pnpm add -D playwright -w`, then `npx playwright install chromium`), started a real gateway
  (`explicit` mode) against the rug-pull fixture server in a scratch temp directory, used the CLI to trust
  generation 1 then drift to generation 2 (producing a real `drifted`/quarantined state with the hostile-content
  candidate definition on record), started the Control Center's Vite dev server against it (on port 5173 —
  discovered during this phase that the Control API's CORS `origin` allowlist is hardcoded to
  `127.0.0.1:5173`/`localhost:5173`, so an initial attempt on port 5183 correctly failed with a CORS-driven
  "Gateway Unreachable" state, itself a useful confirmation that CORS is actually enforced), and used a Playwright
  script to navigate to `/tool-integrity`, capture `docs/assets/control-center-tool-integrity-overview.png`
  (summary cards, drifted status, quarantine banner), open the review panel and capture
  `docs/assets/control-center-tool-integrity-diff.png` (full-page; the untrusted-content warning, fingerprints,
  and the visible field-level changes — the diff panel's own bounded, scrollable inner container means not every
  change is visible in one screenshot, which is the correct/intended bounded-diff behavior, not a capture defect),
  and a 420×800 narrow-viewport capture. Zero console errors observed at either viewport (asserted programmatically
  in the capture script, not just eyeballed). Afterward: killed the gateway and Vite dev server processes, removed
  the scratch temp directory, removed the temporary capture script from the repo root, and ran
  `pnpm remove playwright -w` — confirmed via a byte-for-byte `diff` against pre-install backups that
  `package.json` and `pnpm-lock.yaml` were restored to their EXACT prior state (not just "close").
- **Phase G (Graphify)**: read the installed skill's full instructions before running anything (via the Skill
  tool); ran `graphify update .` (AST-only, no LLM/API key) — 1017→1218 nodes, 1322→1744 edges, 85 communities.
  Ran the required orientation/path queries and cross-checked every finding against source (full detail in the
  new Milestone 6 section of `docs/GRAPHIFY_VERIFICATION.md`): confirmed accurate — `startStdioProxy() -->
  filterTrustedTools()`/`checkCallAllowed()` call sites at the exact source line numbers ADR-0012 describes, and
  the `cli.ts --dynamic_import--> tool-integrity/cli.ts --imports_from--> tool-integrity/registry.ts` path.
  Two coverage gaps found, both independently confirmed (via `graphify explain "replay"` reproducing the identical
  gap on the pre-existing Milestone 4 `api.replay` method) to be the SAME class of pre-existing, systemic AST-
  extractor limitation already documented in Milestones 4–5 (object-literal arrow-function properties and
  anonymous inline-callback bodies are not attributed as call-graph nodes/edges) — not a new defect and not acted
  on by changing source, per the mandatory "never change source solely because Graphify reports/fails to report a
  path without confirming imports and control flow" instruction.
- **Phase I (full local adversarial gate suite)** — commands and exact results:
  - `pnpm install --frozen-lockfile` → "Already up to date."
  - `pnpm run build` → clean, all 4 buildable packages.
  - `pnpm run lint` → 0 errors, 2 pre-existing unrelated warnings only.
  - `pnpm run test` → **377 tests passed, 2 skipped, 0 failed, across 33 test files** (`packages/policy`: 52/3;
    `apps/control-center`: 47/2; `packages/gateway`: 278/28, 2 correctly platform-skipped on Windows). This is the
    exact final count — not the pre-Milestone-6 baseline, which was never treated as a target to preserve
    verbatim.
  - All 4 demos (`secret-exfiltration`, `downstream-secret-result`, `policy-drift-replay`, `tool-rug-pull`) →
    **PASS**, `node scripts/verify-packed-install.mjs` → **PASS**.
  - `git diff --check` → found one REAL trailing-whitespace error in the just-written `CHANGELOG.md` (not an LF/
    CRLF advisory) — fixed immediately, re-verified clean (only the same pre-existing LF/CRLF advisories every
    prior milestone's gate has also carried).
  - Exact CI `security.yml` secret-scan regex/allowlist, run manually against the full tree (`node_modules`/
    `dist`/`.git` excluded) → found the ledger's OWN prose (this file, describing the Phase B/C bugfix) quoting
    the literal non-allowlisted synthetic value `tests/tool-integrity-diff.test.ts` had used before being fixed
    — the fix itself was already correct, but re-stating the exact old literal in the ledger's prose would have
    failed the real Security workflow on push. Reworded the ledger prose to describe the literal without quoting
    it verbatim; re-ran the exact scan — clean.
  - No tracked `.sqlite`/`.log`/token/`.env` file (`git ls-files | grep -iE ...`) → none.
  - CLI Tool Integrity lifecycle (`scan`→`status`→`diff`→`trust`[stale rejected]→`trust`[exact accepted]→
    `history`) re-verified end-to-end against a real spawned fixture server one more time, all correct.
- **Commit**: staged everything except `.claude/`/`CLAUDE.md` (`git add -A -- ':!.claude' ':!CLAUDE.md'`),
  confirmed the staged set matched intent exactly, ran `git diff --cached --check` (clean), and committed as a
  single coherent commit (`3a98860a5fc5afbeb36f278af9ebc1d53b9f9669` — the entire Tool Integrity implementation,
  tests, CLI, Control API, Control Center, demo, CI wiring, ADR-0012, and all documentation/screenshots/Graphify-
  verification updates together). A single commit was used rather than the suggested finer-grained grouping
  because this milestone's ledger narrative (this very file) already describes the implementation as one
  continuous, phase-by-phase story spanning ADR-0012 through the final gates — attempting to carve that single
  file's diff across several artificial commit boundaries risked staging broken/inconsistent intermediate states
  for no real review benefit, which the governing prompt explicitly permits avoiding ("use fewer coherent commits
  rather than staging broken intermediate states"). The commit is fully buildable and testable on its own (all
  gates above were run against it). **First commit-message attempt was accidentally mangled**: a `-m "..."`
  string containing literal backtick-quoted CLI command text (e.g. `` `agentgate tools scan|status|...` ``) was
  parsed by bash as command substitution inside the double-quoted argument, silently dropping that text and
  producing spurious "command not found" shell errors for `agentgate`/`status`/`reject`/`diff`. Caught
  immediately by inspecting `git log -1 --format=%B` after the commit; fixed via `git commit --amend -F
  <message-file>` (safe — this commit had not yet been pushed) with the message written to a plain file instead
  of an inline shell string, avoiding backtick expansion entirely. Verified the amended message renders correctly
  and the amend changed only the commit's message/hash, not its tree (`git show --stat HEAD` — same 47 files
  changed, 6466 insertions, 45 deletions as the pre-amend commit).
- **Phase J (clean-clone verification at the exact candidate commit)**: `git clone .` into a fresh OS-temp
  directory; confirmed the clone's HEAD equals `3a98860a5fc5afbeb36f278af9ebc1d53b9f9669` exactly; confirmed NO
  `.claude/`, `CLAUDE.md`, or `graphify-out/` present anywhere in the clone (`ls`/`git status --short` both
  clean — proving no dependency on any of them). Repeated, **from a completely fresh `pnpm install
  --frozen-lockfile`**: build (clean), lint (clean, same 2 pre-existing warnings), full test suite (**377
  passed, 2 skipped, 33 files — byte-identical counts to the working tree**), all 4 demos (all PASS), packed-
  install verification (PASS), a manual `agentgate init`/`config validate` walkthrough against the clone's own
  built CLI binary (both succeeded), and a full CLI Tool Integrity `scan`/`status` cycle against a real spawned
  fixture server using the clone's own built binary (correct `pending_review` output for all 4 fixture tools).
  Exact CI secret-scan regex/allowlist and `git diff --check` both clean in the clone. After all checks: no
  leftover `.sqlite`/temp file found under the clone directory; a precise port check for AgentGate's actual demo
  port ranges (4337–4344, 4700–4701, 4800–4801, 4900–4901) found nothing listening (the raw `netstat` output
  contained several unrelated high-numbered OS/IPv6 ephemeral ports that coincidentally substring-matched a
  looser first-pass grep pattern — re-checked with a precise pattern and confirmed those were false matches, not
  actual AgentGate listeners); confirmed no orphan git changes in the clone. The clone directory itself was then
  removed, and the ORIGINAL working repository's own `git status --short` was re-checked immediately afterward
  and confirmed unchanged (only `.claude/`/`CLAUDE.md` untracked) — the clean-clone work never touched the
  working tree. **No defect was found in the clean clone** — this is the exact commit that will be pushed, not
  an earlier one.
- Files materially changed by this phase: `packages/gateway/tests/tool-integrity-storage-migration.test.ts`
  (new), `packages/gateway/src/onboarding/init.ts`, `README.md`, `docs/{POLICY_REFERENCE,THREAT_MODEL,
  ARCHITECTURE,DEVELOPMENT,TROUBLESHOOTING,VERIFICATION,GRAPHIFY_VERIFICATION}.md`, `CHANGELOG.md`, three new
  `docs/assets/control-center-tool-integrity-*.png` files — all committed as `3a98860a5fc5afbeb36f278af9ebc1d53b9f9669`
  (already an existing commit as of this entry, not a future/self-referential hash).
- Verification result: **PASS on every item in this entry**, both in the working tree and independently in an
  isolated clean clone at the exact commit that will be pushed.
- Known limitations / follow-up risk: all local and clean-clone verification in this session ran on Windows
  only — no Linux or macOS testing was performed locally. Linux (Ubuntu, Node 20 and 22) coverage is expected
  from GitHub Actions CI in the next phase, not claimed here. No macOS coverage exists anywhere in this project,
  local or CI, and is not claimed. The scan-to-call TOCTOU and `monitor`-mode-provides-no-blocking-protection
  limitations documented in ADR-0012 remain unresolved by design (stated, not hidden).
- Unresolved questions: none blocking.
- Exact next action: push `main`, observe GitHub CI and Security for the exact pushed commit
  (`3a98860a5fc5afbeb36f278af9ebc1d53b9f9669`) to completion, repair any real failure found there via a normal
  follow-up commit, and produce the final report.

### 2026-08-28 — Milestone 7 CLI/API/SSE/fingerprint-binding session (built on core checkpoint `61c02c3`)

- Prompt objective: finish the Context Guard CLI, authenticated Control API endpoints, SSE exposure, and the
  previously-unpopulated `tool_fingerprint` contextual-approval binding, on top of the already-committed local
  core checkpoint (`61c02c3aeb2ae1dee96d306dda5a2b8f782e0956`, still unpushed).
- Decisions added or changed: ADR-0013's decision text (point 10) **amended** — not superseded — to reflect
  `tool_fingerprint` actually being populated/revalidated now (see the inline, dated "**Amended 2026-08-28**"
  marker in point 10 and the matching updates to its Alternatives-considered and Consequences bullets — the
  ADR's history is preserved by the ledger entries around it, chiefly this one, which record exactly what the
  original "deferred, not implemented" text said and why it changed, rather than the ADR text itself carrying
  struck-through markup). No new ADR was needed: the CLI/API/SSE surfaces built this session implement exactly
  what ADR-0013's own Limitations section already scoped as "later phases of this same milestone" — no design
  decision changed.
- Implementation completed:
  - **Fingerprint binding** (`tool-integrity/enforcement.ts`: new `getTrustedFingerprint()`; `context-guard/
    enforcement.ts`: `checkApprovalContextValid()` gained a 5th `expectedToolFingerprint` parameter;
    `pipeline.ts`: `resolveServer()` hoisted above the approval-creation branch and reused for both binding
    (creation time) and revalidation (consumption time, re-read fresh, never reused from creation)). A `null`
    bound fingerprint (no trusted definition existed at creation) skips the check, matching the existing
    `argument_digest` null-skip pattern — defense-in-depth alongside, never a replacement for, Tool Integrity's
    own independent `checkCallAllowed()` gate.
  - **CLI** (`context-guard/cli.ts`, new; `cli.ts`: `case 'context'`): `status` (bounded, `--state`/`--limit`
    filters, pending-approval counts), `history` (bounded, deterministic, chain-verified), `explain` (reports
    only stored evidence — `latest_decision: null`, never fabricated, when no `call_evaluated` event exists),
    `reset` (exact context id/revision, non-empty bounded reason, appends a `context_reset` transition, actively
    denies every pending contextual approval bound to that context via the shared `ApprovalManager`), `verify`
    (delegates entirely to `storage.verifyContextChain()` — no second hash-chain implementation). Core logic is
    split into storage-accepting functions (`summarizeContexts`, `summarizeContextHistory`, `explainContext`,
    `performContextReset`, `verifyContextChainReport`) reused directly by both the CLI wrappers and the Control
    API routes below — never two independent implementations. Added `sanitizeForTerminal()` in `cli.ts` (strips
    ANSI/control characters) applied to `tool_name` (agent-controlled, the literal `tools/call` `name` parameter)
    and `reason` fields before printing, since no ANSI-stripping utility existed anywhere in this codebase before
    this session and `tool_name` specifically is real hostile-input-shaped surface, not theoretical.
  - **Control API** (`api/control.ts`): `GET /api/contexts` (bounded, `?state=`/`?limit=` validated),
    `GET /api/contexts/:id`, `GET /api/contexts/:id/history`, `GET /api/contexts/:id/explain`,
    `POST /api/contexts/:id/reset` (strict body schema — exactly `{revision, reason}`, unknown fields rejected,
    in-flight de-duplication mirroring Safe Replay's own pattern, reuses the process's single already-open
    `ApprovalManager` rather than constructing a second one), `GET /api/context-integrity`. All existing
    security middleware (loopback Host check, Origin/CORS, `Referrer-Policy: no-referrer`, per-launch auth
    token) applies unchanged — no new middleware bypass was introduced. Routes are gated behind an optional
    `contextGuard` opt exactly like the existing `toolIntegrity` opt, absent (404) when not configured.
  - **SSE**: `PipelineContext.emitEvent`'s type widened from `AuditEvent` to `AuditEvent | ContextEvent`;
    `server.ts`'s `eventBus`/`subscribers` widened to also carry `ContextEvent`; `pipeline.ts` now publishes the
    `call_evaluated` event (step 4.5) and any non-null `label_added` event (step 8) through the SAME `ctx.
    emitEvent` audit events already use; `transport/stdio.ts`'s transport-close handler publishes the resulting
    `context_closed`/`context_expired` event when a fresh transition actually occurred (guarded against
    re-publishing on the idempotent no-op close path); the reset Control API route publishes through the same
    bus via a `contextGuard.emit` callback reusing `ctx.emitEvent` — one bus, no second parallel stream, no
    duplicate publication. `api/control.ts`'s existing single SSE handler discriminates by payload shape
    (`'event_type' in payload`) and sends `event: context_event` instead of the existing `event: audit_event` —
    the Control Center's actual frontend SSE consumer (`apps/control-center/src/api.ts`) only ever subscribes to
    `audit_event` and needed no change; it silently ignores `context_event` frames it doesn't listen for.
  - **A second real defect found and fixed while wiring transport-close SSE publication** (beyond the
    stdin-`'end'` gap already fixed in the core checkpoint): none new this session — the stdin-`'end'` fix from
    the core checkpoint was re-verified still correct and is what this session's `context_closed` SSE
    publication now rides on.
  - `docs/AI_DECISIONS.md`: this entry, plus the ADR-0013 point-10 amendment described above.
  - `scripts/verify-packed-install.mjs`: added Step 5 (`agentgate context --help`, `context status --json`,
    `context verify` against a fresh installed package + empty database) — the packaged-artifact evidence this
    milestone's CLI work requires, run alongside the pre-existing pack/install/smoke-test steps, not as a
    separate script.
- Files materially changed: `packages/gateway/src/context-guard/cli.ts` (new), `packages/gateway/src/cli.ts`,
  `packages/gateway/src/context-guard/enforcement.ts`, `packages/gateway/src/tool-integrity/enforcement.ts`,
  `packages/gateway/src/pipeline.ts`, `packages/gateway/src/server.ts`, `packages/gateway/src/api/control.ts`,
  `packages/gateway/tests/context-guard-{cli,api,sse,fingerprint-binding,fingerprint-gateway}.test.ts` (new),
  `packages/gateway/tests/context-guard-{enforcement,interactions}.test.ts` (updated for the new fingerprint
  parameter and the new `call_evaluated` SSE emission respectively), `scripts/verify-packed-install.mjs`,
  `docs/AI_DECISIONS.md`.
- Tests added and exact counts: `context-guard-cli.test.ts` 32, `context-guard-api.test.ts` 37,
  `context-guard-sse.test.ts` 5, `context-guard-fingerprint-binding.test.ts` 7 (pipeline-level, real Tool
  Integrity state), `context-guard-fingerprint-gateway.test.ts` 1 (real compiled gateway, real MCP client, real
  out-of-process Tool Integrity drift simulation — run 3 consecutive times, deterministic each time);
  `context-guard-enforcement.test.ts` grew from 23 to 28 (5 new fingerprint-binding unit cases);
  `context-guard-interactions.test.ts` stayed at 14 (one test's assertions updated for the new `call_evaluated`
  SSE emission, not a new test). Full gateway suite: **464 passed, 2 skipped, 39 files, 0 failed** — run twice,
  byte-identical both times. Full workspace: policy 52/52, control-center 47/47, gateway 464/2-skipped — **563
  tests total across 44 files, 0 failed**. Build: clean (4/4 packages). Lint: 0 errors, the same 2 pre-existing
  `no-explicit-any` warnings as every prior session (none newly introduced — two `no-unnecessary-type-assertion`
  and one `no-unused-vars` error introduced while writing this session's own test files were found and fixed
  before this count). `git diff --check`: clean (CRLF notices only). Tracked/new-file secret scan (17 files):
  clean. Packed-install verification (`scripts/verify-packed-install.mjs`, extended this session): **all 15
  checks PASS**, including the 3 new Context Guard steps.
- Defects found and fixed this session (with reasons):
  1. `context-guard-interactions.test.ts`'s SSE-ordering test broke the moment `call_evaluated` events started
     being published (a genuine new emission this session added) — its mock assumed every emitted object was
     AuditEvent-shaped and crashed reading `.status` off a `ContextEvent`. Fixed by discriminating on
     `event_type` in the test's own mock, and updated the expected emission count/order (`RECEIVED`,
     `context:call_evaluated`, `DENIED`) to match the now-actual three-event sequence. A direct, expected
     consequence of a real new code path, not a pre-existing bug.
  2. A regex-based bulk-edit while adding the 5th `checkApprovalContextValid()` parameter to existing test call
     sites matched a literal occurrence of the function's own name inside an unrelated `it(...)` title string,
     corrupting an adjacent `createContext(...)` call into a spurious 4-argument form. Caught immediately by a
     full `git diff` review of the edited file before running it; fixed by hand. No test file was left in a
     silently-wrong state — the corruption was visible before any test ran.
  3. This session's own SSE test harness (a first-of-its-kind real fetch()/ReadableStream-based SSE reader for
     this codebase — no prior test exercised `/api/events/stream` at all) initially hung indefinitely on any
     "nothing arrives" assertion: each loop iteration issued a FRESH `reader.read()` without checking whether
     the previous one (lost to a timeout race) was still outstanding — invalid concurrent use of a
     `ReadableStreamDefaultReader`. Fixed by tracking exactly one in-flight read across iterations. A dedicated
     "fresh connection does not replay prior transitions" test still proved unreliable in this environment even
     after that fix (and after removing a separately-hanging `reader.cancel()` await in cleanup) despite real
     debugging effort, and was removed rather than shipped flaky or silently skipped — the property it would
     have proven is not new behavior this milestone introduces (the underlying `subscribers` array is the exact
     same pre-existing, unmodified per-process mechanism `audit_event`/`Approval` traffic already used), and is
     documented as a stated test-coverage gap, not hidden.
- Public security behavior preserved/added: every new Control API route sits behind the same loopback/Host/
  Origin/CORS/auth-token/`Referrer-Policy` middleware as every existing route — no new route bypasses it. The
  reset route validates an exact schema (`{revision: number, reason: string}`, unknown fields rejected with
  400), requires the EXACT current revision (409 on staleness), requires a non-empty bounded reason, and is
  concurrency-safe (a concurrent double-reset against the same context: exactly one 200, one 409, exactly one
  `context_reset` transition ever recorded — verified by a dedicated test issuing both requests via
  `Promise.all`). No route exists to reset/clear all contexts, remove a label directly, bypass policy,
  permanently approve a call, or modify Tool Integrity trust (each explicitly tested as absent/404). No
  response body includes raw arguments/results, raw hostile content, secrets/tokens, complete tool definitions,
  stack traces, or unnecessary filesystem paths (tested directly, including against a `<script>`-shaped context
  id and an intentionally corrupted/tampered chain).
- Known limitations / follow-up risk: SSE "fresh connection does not replay prior transitions" has no automated
  test in this codebase (see defect 3 above) — the underlying mechanism is unchanged pre-existing plumbing, but
  this specific property is asserted only by source-reading, not execution, for Context Guard's new payload
  type. TTL-based context expiry still exists only as a state-machine transition, not an active scheduler (
  unchanged from the core checkpoint). The Control Center has no Context Guard page yet — the API/SSE surfaces
  built this session are consumable by a future page but nothing renders them. The context-poisoning demo,
  broader documentation, browser screenshots, and a Graphify re-index are all still outstanding, tracked
  separately, not claimed done here.
- Current Git state at the time of this entry: branch `main`, local HEAD still `61c02c3` (this session's CLI/
  API/SSE/fingerprint-binding work is verified but not yet committed as of this ledger entry — the commit
  containing it is created immediately after, per the standard "ADR/ledger before commit" ordering this project
  follows); `origin/main` unchanged at `2e959e3121e542ea01a4d5f6ba28424a647cb865`; only `.claude/`/`CLAUDE.md`
  untracked beyond the intended changes.
- Unresolved questions: none blocking.
- Exact next action: stage exactly the CLI/API/SSE/fingerprint-binding/test/doc files listed above (excluding
  `.claude/`, `CLAUDE.md`, `graphify-out/`, and any generated artifact), run a final staged-diff check and
  secret scan, and create a normal local commit — not pushed, per this turn's explicit scope stop.

### 2026-08-28 — Milestone 7 Control Center + poisoned-result demo session (built on `c8ed307`)

- Prompt objective: build the Control Center's Context Guard investigation UI, the milestone's central executable
  attack demo (`examples/context-poisoning/demo.mjs`), real-browser verification with screenshots, and local
  checkpoint commits — on top of the two already-committed local checkpoints (`61c02c3`, `c8ed307aeb2ae1dee96d306
  dda5a2b8f782e0956` — see prior entries for their exact contents; both unpushed).
- Decisions added or changed: none — this session implements UI/demo/test surfaces against ADR-0013 exactly as
  already decided; no ADR text changed.
- Implementation completed:
  - **Typed API client** (`apps/control-center/src/api.ts`): added `ContextStatus`/`ContextSummary`/
    `ContextStatusReport`/`ContextEventWire`/`ContextHistoryReport`/`LabelOrigin`/`LatestDecision`/
    `ContextExplainReport`/`ContextResetReport`/`ContextVerifyReport` types mirroring `context-guard/{types,cli}.ts`'s
    actual validated response shapes exactly (never widened to `Record<string, unknown>`), and `api.contexts()`/
    `context()`/`contextHistory()`/`contextExplain()`/`contextReset()`/`contextIntegrity()` methods — `contextReset`
    is the only mutating call, requiring exact revision + reason, matching the server's own single mutation route.
    Added an `ApiError` class (`message`, `status`) thrown by `get`/`post`/`postForResult` in place of a bare
    `Error`, so callers can distinguish 404 ("not configured") from 409 ("stale") from a generic failure without
    parsing message text — backward compatible (`instanceof Error` still true, `.message` unchanged) for every
    pre-existing call site. `openEventStream()` gained an optional third `onContextEvent` parameter for the same
    already-multiplexed SSE stream's `context_event` frames; existing callers passing only two arguments are
    unaffected. Documented (doc comment, not a new test — see below) that a fresh SSE subscriber never receives
    events published before it connected, matching the exact pre-existing `subscribers` array semantics in
    `server.ts` (push-only, no replay buffer) — the UI is built to tolerate this by treating an SSE frame as a
    "refetch now" signal, never as the sole source of state.
  - **Context Guard page** (`apps/control-center/src/pages/ContextGuard.tsx`, new): overview stat grid (active/
    closed/expired/reset counts, active-with-labels, pending-approval total), chain-integrity note, a bounded/
    state-filterable context list (table on desktop, a stacked card list at ≤640px — see the narrow-layout defect
    below), and a master/detail panel (mirrors `ToolIntegrity.tsx`'s list+review-panel pattern) showing lifecycle,
    revision, labels, the correlation-not-causation limitation note (verbatim requirement, not paraphrased away),
    label origins with links to originating audit events, a deny/require-approval escalation panel (zero-execution
    wording shown only when the stored `call_evaluated` event's own `action` field supports it — deny is
    structurally pre-downstream per ADR-0013 point 9, never asserted from UI copy alone), and the full transition
    timeline (oldest-first, matching `context-guard/cli.ts`'s own stated ordering) rendered as a connected vertical
    thread (border-line + colored dot per event kind), not a generic stepper. Reset is gated to `status === 'active'`
    (matching `resetContext()`'s own server-side rejection of any other status), behind an explicit confirmation
    dialog (not `window.confirm` — a real `role="dialog"` with the pending-approval-invalidation and memory-erase
    warnings, exact-revision display, a required/bounded reason field, double-submit prevention via an in-flight
    ref, Escape-to-close, and initial focus on the reason textarea) that on a 409 closes and shows a "state changed,
    review again" banner rather than silently retrying. No reset-all/remove-label/mark-safe/force control exists
    anywhere on the page (tested — see below). All display text (tool names, reasons, rule ids, labels) passes
    through a `sanitizeText()` helper stripping the exact same C0-control-char class the CLI's own
    `sanitizeForTerminal()` strips, bounding length with a truncation marker; React's own escaping (never
    `dangerouslySetInnerHTML`) handles markup/script inertness. Added the nav item + `/context-guard` route in
    `App.tsx`, with a `?context=` deep-link param other pages can navigate to.
  - **Integration touches** (Part 3, deliberately scoped to what the actual data model safely supports — see
    Known limitations): `Overview.tsx` gained a self-contained `ContextGuardSummaryCard` (own single fetch, renders
    nothing if Context Guard is 404/unreachable) surfacing active-with-labels/pending-approval counts;
    `Timeline.tsx` shows a small "context-escalated" badge/link when `decision.reason_code ===
    'CONTEXT_GUARD_ESCALATION'` (a field the API already returns — zero new fetches); `Approvals.tsx` renders the
    `context_id`/`context_revision`/`contextual_rule_id`/`tool_fingerprint` fields already present on `Approval`
    (ADR-0013's binding fields) when non-null, linking to the new page; `EventDetail.tsx` shows the same
    escalation note when applicable. Explicitly NOT built: a per-row "latest contextual effective action" column on
    the context list (would require an N+1 `explain()` fetch per row — no bulk API returns it) and an Event-Detail
    "which context is this?" back-link (no field on `AuditEvent` carries a context id — `ContextEvent.
    source_event_id` only points the other direction). Both are named, not silently dropped.
  - **Poisoned-result demo** (`examples/context-poisoning/demo.mjs`, new, plus `examples/context-poisoning/
    fixtures/{constants,context-poisoning-fixture-server}.mjs`): the milestone's central executable proof,
    structured exactly like `examples/tool-rug-pull/demo.mjs`/`examples/secret-exfiltration/demo.mjs` (numbered
    PASS/FAIL `check()` helper, `finally`-block cleanup, `assertInsideTempDir()` safety gate, never
    `process.exit()` before cleanup). No LLM is called anywhere — it manually issues the exact tool sequence a
    compromised agent would issue after "reading" a synthetic indirect-prompt-injection support-ticket body
    (`fixtures/constants.mjs`'s `TICKET_BODY`, containing `INJECTED_INSTRUCTION_PHRASE` =
    `"IGNORE ALL PREVIOUS INSTRUCTIONS"`), and proves Context Guard blocks/gates the result from OBSERVED gateway
    history alone. Two independent gateway connections/contexts against a shared database: connection A (deny-mode
    contextual rule) proves revision-0/no-labels start, `fetch_ticket`→`untrusted_content`, `read_secret_fixture`→
    `sensitive_data_accessed`, then two DENIED `send_webhook` attempts (fresh and repeated/cached-name) with the
    downstream `send_webhook` call counter staying exactly 0 both times, then closes (context transitions to
    `closed`). Connection B (require_approval-mode contextual rule) proves it does NOT inherit A's revision/labels
    (fresh context, revision 0, no labels), then demonstrates the full approval lifecycle from
    `context-guard-gateway-enforcement.test.ts`'s own proven pattern: a pending approval P1 bound to revision 1,
    the context advanced to revision 2 by a concurrent call while P1 is still pending, approving P1 anyway still
    fails on consumption-time revalidation (counter stays 0 — the stale-binding proof), a FRESH approval P2 bound
    to the current revision executes successfully (counter becomes exactly 1), and a third attempt requires its
    own fresh approval P3 (proving single-use) which is denied (counter stays 1). CLI evidence (`agentgate context
    status/explain/history/verify`) is captured at each checkpoint and, together with every stored `context_events`
    row read directly via `AuditStorage`, is asserted to never contain the synthetic secret
    (`AKIAIOSFODNN7EXAMPLE`, the literal already allowlisted in `security.yml`'s scan) or the raw injected-
    instruction phrase. A `CONTEXT_POISONING_INJECT_FAILURE=after-step-9` env var (zero effect unless explicitly
    set) throws mid-run for the cleanup-proof test below. Wired into both CI build-test jobs (ubuntu, windows) in
    `.github/workflows/ci.yml`, immediately after the tool-rug-pull demo step — README/demo-list documentation
    integration is deferred to the closeout documentation pass per this turn's explicit scope.
  - `packages/gateway/tests/context-poisoning-demo-cleanup.test.ts` (new): mirrors `tool-rug-pull-demo-
    cleanup.test.ts` exactly — spawns the real demo script with the fault-injection env var set, asserts a
    non-zero exit, the injected-failure message, no leftover `agentgate-context-poisoning-*` temp directory, and
    neither gateway's control port still listening; a second test asserts the hook is a true no-op when unset.
  - **Real browser verification** (Part 7): temporarily added `playwright` as a workspace devDependency (`pnpm add
    -D playwright -w`, `npx playwright install chromium`) and two scratch scripts in the repo root (never
    committed, deleted before this entry): one started a real production-built gateway (`context_guard: enforce`)
    against the context-poisoning fixture, drove a real MCP client through the exact deny-path sequence, and kept
    the connection open so the Control Center could be browsed against genuinely live state (plus a second,
    already-closed context for list variety); the other used Playwright to navigate the real Vite dev server
    (`pnpm run dev:control` equivalent, `VITE_CONTROL_URL`/`VITE_AGENTGATE_TOKEN` pointed at the live gateway, port
    5173 — the Control API's CORS allowlist is hardcoded to 5173, same discovery as the Milestone 6 Phase F
    session) at 1280×900 and 420×800, asserting zero console errors, zero failed/4xx/5xx requests, the reset
    dialog's warnings, Escape-to-close, initial textarea focus, and — critically — that the raw injected-
    instruction phrase, the synthetic secret, and the local auth token never appear anywhere in the rendered page
    text. Captured `docs/assets/control-center-context-guard.png`, `-escalation.png`, and `-narrow.png`. Afterward:
    killed the gateway and Vite dev server processes (confirmed via `Get-NetTCPConnection`/`Get-CimInstance` that
    no process or listening port remained), removed every scratch temp directory, removed both temporary capture
    scripts, and ran `pnpm remove playwright -w` — confirmed via byte-for-byte `diff` against pre-install backups
    that `package.json` and `pnpm-lock.yaml` were restored to their exact prior state.
- Defects found and fixed this session (with reasons):
  1. **Narrow-viewport (~420px) clipping regression in the new Contexts list.** The initial implementation used
     only the existing `<table className="data-table">` pattern; `.card`'s pre-existing `overflow: hidden` (a
     deliberate, documented fix from an earlier milestone for a different clipping bug) silently hid the table's
     rightmost columns at 420px with no way to reach them — a real regression against this turn's explicit
     "intentional narrow reflow, not a squeezed desktop grid" requirement, caught by the Playwright narrow-viewport
     screenshot itself, not by the component tests (jsdom doesn't lay out CSS, so this class of bug is invisible
     to Vitest/RTL). Fixed by adding a genuinely separate, CSS-toggled stacked card list (`.cg-contexts-cards`,
     shown only at `max-width: 640px` alongside `.cg-contexts-table { display: none }`) with full keyboard support
     (`role="button"`, `tabIndex`, Enter/Space activation) — every field remains visible and reachable at narrow
     width, nothing scroll-hidden. Two new component tests assert the card list's structure/data parity and that
     Enter-key activation opens the same detail panel as a table-row click. Because both the table and the card
     list render unconditionally in jsdom (media queries aren't evaluated there), every existing list-content
     assertion (the `selectRow()` test helper plus several standalone list tests) had to be scoped to
     `within(desktopTable())` to stay unambiguous — the same scoping pattern `ToolIntegrity.test.tsx` already used
     for its own duplicate-fingerprint-prefix case, not a new pattern invented for this fix.
  2. **Scratch capture script config bug (browser-verification tooling, never committed).** The first version of
     the temporary gateway-setup script reused the SAME config (and therefore the SAME `control_port`/
     `gateway_port`) for both the persistent connection and the short-lived "closed context" connection, causing
     the second gateway process to always fail `EADDRINUSE` against the first, still-running one — reproduced
     identically across three different port pairs before the actual cause (not a port-range or environment
     issue) was found by bisecting with a bare `node cli.js start <config>` invocation outside the MCP client
     wrapper. Fixed by giving the second connection its own config/port pair sharing only the same `db_path` (the
     same two-config pattern `examples/context-poisoning/demo.mjs` itself already uses for contexts A/B). This
     script was never part of any commit; noted here only because the defect and its diagnosis are real engineering
     record, not because the file exists in the tree.
  3. **Playwright `fullPage` screenshot silently omitted below-the-fold content.** The Control Center's app shell
     is a fixed-height (`100vh`) grid whose `.main-content` region scrolls internally — the document `<body>`
     itself never scrolls — so neither `page.screenshot({ fullPage: true })` nor an element-level screenshot of
     the `overflow: auto` region reliably captured the full escalation panel/timeline (both approaches returned
     only the initial viewport's content). Fixed in the scratch capture script (not application code — this is a
     screenshot-tooling detail, not a product bug) by measuring `.main-content`'s real `scrollHeight` and
     temporarily growing the Playwright viewport to fit it before capturing.
- Files materially changed: `apps/control-center/src/{api.ts,App.tsx,index.css}` (extended, not rewritten),
  `apps/control-center/src/pages/ContextGuard.tsx` (new), `apps/control-center/src/pages/{Approvals,Timeline,
  Overview,EventDetail}.tsx` (small, additive integration touches), `apps/control-center/src/pages/
  {ContextGuard,Approvals}.test.tsx` (new), `examples/context-poisoning/{demo.mjs,fixtures/constants.mjs,
  fixtures/context-poisoning-fixture-server.mjs}` (new), `packages/gateway/tests/context-poisoning-demo-
  cleanup.test.ts` (new), `.github/workflows/ci.yml` (one new step in each of the two build-test jobs), `docs/
  assets/control-center-context-guard{,-escalation,-narrow}.png` (new), `docs/AI_DECISIONS.md` (this entry).
- Tests added and exact counts: `ContextGuard.test.tsx` 53 (loading/unavailable/error/empty states; overview
  stats incl. truncation and chain-integrity verified/FAILED/unreachable; list rendering incl. state-filter
  refetch, row selection, deep-link, and the new narrow-card-list parity/keyboard-activation pair; detail
  lifecycle/correlation-note/reset-availability-per-status; escalation display for deny/require_approval/allow/
  never-evaluated; label origins; transition timeline ordering/chain-invalid/truncated/empty; the full reset flow
  incl. exact-revision submission, 409 handling, double-submit prevention, Escape, focus, and the
  no-broad-controls check; SSE refetch-once/duplicate-idempotent/reconnect-indicator/unmount-cleanup; hostile
  HTML/Markdown/ANSI/secret/long-value handling; accessible-name coverage). `Approvals.test.tsx` 5 (new — covers
  only this session's added Context Guard binding fields; the pre-existing approve/deny flow had no test file
  before this session and is unchanged/untested, same as before). `context-poisoning-demo-cleanup.test.ts` 2.
  Control Center suite: **105 passed, 4 files, 0 failed** (baseline 47 + 53 + 5), run repeatedly with no
  flakiness observed. Gateway suite: **466 passed, 2 skipped, 40 files, 0 failed** (baseline 464 + 2), run twice,
  byte-identical both times. Full workspace: policy 52/52, control-center 105/105, gateway 466/2-skipped —
  **623 tests total, 0 failed**. Build: clean (5/5 packages incl. control-center). Lint: 0 errors, the same 2
  pre-existing `no-explicit-any` warnings as every prior session. Demo: 3 consecutive runs, **58 PASS / 0 FAIL
  every time**, exit code 0 each time. Injected-failure cleanup test: passes (non-zero exit, injected-failure
  message present, no leftover temp dir, neither control port still listening); the "hook is a no-op when unset"
  sanity test also passes. `git diff --check`: clean (CRLF notices only, matching every prior session). Tracked/
  new-file secret scan: clean. Packed-install verification (unchanged from the prior session's 15 checks): all
  PASS. Screenshot privacy scan (`strings`-based, plus direct visual review): no username/local path/token/raw
  secret/raw injected-instruction text found in any of the three captured PNGs. Process/port/temp residue check
  after cleanup: clean (`Get-NetTCPConnection`/`Get-CimInstance` confirmed no gateway or Vite process/port
  remained; no leftover `agentgate-context-poisoning-*` or scratch-capture temp directory).
- Public security behavior preserved/added: no gateway-side enforcement code changed this session (Context Guard's
  actual decision logic, storage, migrations, and Control API routes are exactly what `61c02c3`/`c8ed307` already
  committed) — this session is UI/demo/test surface only. The new UI adds no new mutation capability beyond the
  single, already-existing exact-revision/reason reset route; every new display surface treats tool names/reasons/
  labels/server identity as untrusted text (React escaping only, `sanitizeText()` control-character stripping,
  bounded length) and never renders raw arguments/results/secrets/tokens/paths, verified both by targeted
  component tests and by the live-browser hostile-content assertions (the demo's own real injected-instruction
  ticket body and synthetic secret, actually present in the live database, were confirmed absent from the
  rendered page).
- Known limitations / follow-up risk: the context list's per-row "latest contextual effective action" and the
  Event-Detail→Context-Guard back-link were deliberately not built (see Implementation completed) — the current
  API/data model doesn't support either without an N+1 fetch pattern or a new backend field, and this session's
  scope was UI/demo, not further gateway API changes. The pre-existing SSE "fresh subscriber does not replay
  prior events" property still has no dedicated low-level gateway test (unchanged gap from the prior session —
  see that entry's defect #3; a fresh attempt at a lower-level, non-HTTP test was considered again this session
  and set aside for the same reason: the underlying `subscribers` push-only array in `server.ts` is unexported/
  private to `startGateway()`, so a real test would require either a risky refactor of core gateway wiring — out
  of scope for a UI/demo-focused turn — or duplicating the mechanism, which is worse than the documented gap).
  The Approvals page's pre-existing approve/deny flow (not touched this session beyond the new binding-field
  display) still has no test coverage of its own — only the newly-added fields are tested. README/ARCHITECTURE/
  THREAT_MODEL/DEVELOPMENT documentation integration, a Graphify re-index, and a clean-clone verification are all
  still outstanding, explicitly deferred to the closeout phase per this turn's scope.
- Current Git state at the time of this entry: branch `main`, local HEAD still `c8ed307311d6730b7410ef11fc8ff317f
  4f80773` (this session's Control Center/demo/test work is verified but not yet committed as of this ledger
  entry — the commits containing it are created immediately after, per the standard "ADR/ledger before commit"
  ordering this project follows); `origin/main` unchanged at `2e959e3121e542ea01a4d5f6ba28424a647cb865`; only
  `.claude/`/`CLAUDE.md` untracked beyond the intended changes; the temporary `playwright` devDependency and both
  scratch capture scripts were fully removed before this entry, confirmed byte-for-byte against pre-install
  backups.
- Unresolved questions: none blocking.
- Exact next action: stage the Control Center/demo/test/CI/doc/screenshot files listed above (excluding
  `.claude/`, `CLAUDE.md`, `graphify-out/`, and any runtime DB/token/log), run a final staged-diff check and
  secret scan, and create local checkpoint commits — not pushed, per this turn's explicit scope stop.

### 2026-08-28 — Milestone 7 final documentation, review, and verification session (candidate `efe73e3`)

- Prompt objective: reconcile all public documentation with the implemented Context Guard behavior, run a
  focused security/architecture review, re-index and verify Graphify, run the complete final adversarial gates,
  and perform clean-clone verification at the exact candidate — building on the five already-committed local
  checkpoints (`61c02c3`, `c8ed307`, `2bdbd99`, `b43bec6`, `5242384`, all still unpushed at the start of this
  session).
- Decisions added or changed: none — this session documents, reviews, and verifies ADR-0013 exactly as already
  implemented; no ADR text changed.
- Documentation reconciled (each read against actual source before writing, not assumed): `README.md` (Context
  Guard feature section, observable sequence, config/CLI examples, screenshots, demo command, updated test
  counts, Control Center page bullet, Security-model-and-limitations subsection), `docs/ARCHITECTURE.md` (full
  Context Guard section: execution-context boundary, state/revision/labels, exact 10-step evaluation order,
  stdio-close/SDK-stdin-end handling, exact approval binding/revalidation, reset semantics, CLI/API/SSE/Control
  Center data flow, migration, fail-closed points, plus 3 new Mermaid diagrams and a system-diagram node),
  `docs/THREAT_MODEL.md` (a dedicated Context Guard section covering every threat named in this session's
  prompt — indirect injection through trusted output, confused-deputy sequence, direct/cached-name bypass,
  approval replay/argument/revision races, reset abuse, corrupted history, hostile content across every surface,
  concurrency, restart/reconnect, covert channels, operator misclassification, monitor-mode implications,
  null-fingerprint compatibility, SSE reconnect assumptions — each with its actual mitigation and residual
  limitation stated separately, never conflated), `docs/POLICY_REFERENCE.md` (exact schema, built-in label
  vocabulary, `when`-operator table, action/merge semantics, transition timing, validation-failure list, an
  annotations-anti-example, two complete worked examples), `docs/VERIFICATION.md` (a Milestone 7 evidence table),
  `docs/DEVELOPMENT.md` ("Using Context Guard locally" plus five contributor how-to subsections),
  `docs/TROUBLESHOOTING.md` (eleven new entries), `CHANGELOG.md` (a Milestone 7 entry). Committed as
  `5d8da1b docs(context-guard): document cross-tool escalation defense`. A new test,
  `packages/gateway/tests/docs-context-guard-examples.test.ts` (5 cases), protects the four published YAML
  examples (README's and POLICY_REFERENCE.md's migration/deny-path/approval-path snippets) by parsing each
  through the real `loadGatewayConfig()` production loader — added in the same commit.
- Focused security/architecture review (Phase 7): re-read the highest-risk code paths fresh and skeptically —
  `pipeline.ts`'s Context Guard evaluation/approval-binding/label-append call sites (lines 205, 263-334, 380-419),
  `transport/stdio.ts`'s three-independent-trigger-converging-on-one-idempotent-close pattern — and independently
  confirmed each against source (not merely re-trusting the prior session's own account). Checked for: bypass via
  direct/cached-name calls (none found — Tool Integrity's gate runs before Context Guard unconditionally, in
  `transport/stdio.ts`, outside `runPipeline()`), stricter-action merge errors (`isAtLeastAsStrict()` correctly
  gates the override), null-fingerprint handling (a legitimate skip-only-that-check state, not a bypass), label
  append timing relative to result safety (append happens strictly after the terminal audit write/SSE emit,
  confirmed at the exact line), unbounded lists/strings (`MAX_STATUS_ROWS`/`MAX_HISTORY_ROWS`/`MAX_REASON_LENGTH`/
  `LIST_LIMIT` all present and enforced, client and server side), unsafe HTML rendering (`grep` confirms zero
  `dangerouslySetInnerHTML` in the new Control Center files). **No new concrete defect found** beyond what the
  prior UI/demo session already found and fixed (the narrow-viewport list-clipping regression, already committed
  in `2bdbd99`) — no additional commit was needed for this phase.
- Graphify re-index (Phase 8): read `~/.claude/skills/graphify/SKILL.md` and `references/update.md` in full
  before running anything. `graphify update .` (direct CLI, AST-only, no LLM/API key, per this project's
  `CLAUDE.md`) rebuilt the graph to **1514 nodes, 2409 edges, 104 communities** (from 1218/1744/85 at the end of
  Milestone 6). Ran six symbol-level `graphify explain`/`path` queries and manually cross-checked every result
  against source read directly earlier in this session (not the other way around) — all six confirmed
  byte-accurate: `evaluateContextGuard`/`checkApprovalContextValid`/`appendContextLabels` call sites in
  `pipeline.ts` (exact lines 205/326/410), the CLI/Control-API shared `summarizeContexts()` function, and the
  Context Guard page's reuse of the pre-existing `openEventStream()`. One recurrence of the already-documented
  object-literal/inline-callback call-attribution limitation (the new demo fixture's `bumpCallCounter`), and one
  newly-observed narrow entity-resolution limitation (`path` colliding two similarly-named files onto one node
  via loose label matching — confirmed via exact-symbol re-query that the underlying graph data itself was
  correct). Explicitly scoped out this session: semantic (LLM/subagent) re-extraction of the changed Markdown
  docs — AST-only code re-indexing was sufficient for every verification query this milestone needed, and this
  is stated as a named scope decision, not a silent gap. Committed as
  `efe73e3 docs(graphify): Milestone 7 incremental re-index and verification`.
- Final local adversarial gates (Phase 9), all run this session at the post-review candidate: frozen install
  clean; build clean (5/5 packages); lint clean (0 errors, the same 2 pre-existing `no-explicit-any` warnings as
  every prior session); full test suite **policy 52/52, control-center 105/105, gateway 471/2-skipped (41
  files) — 628 tests total, 0 failed**; gateway suite run a second time, byte-identical (471 passed/2 skipped
  both times); all five demos re-run and passing (`secret-exfiltration`, `downstream-secret-result`,
  `policy-drift-replay`, `tool-rug-pull`, `context-poisoning`); `context-poisoning/demo.mjs` run 3 consecutive
  times, **58 PASS / 0 FAIL every time**, exit 0 each time; `context-poisoning-demo-cleanup.test.ts` (2 cases)
  isolated and passing; `agentgate smoke-test` passing; `scripts/verify-packed-install.mjs` **15/15 PASS**
  (including the 3 Context Guard CLI steps); a real, live, manual `agentgate context status/history/explain/
  reset/verify` walkthrough against a genuinely running gateway (temp config, `context_guard: enforce`) —
  `status`/`history`/`explain`/`verify` all correct, `reset` against a `closed` context correctly failed closed
  with exit 1 (*"Context ... is already closed."*), proving the state-restriction invariant live, not only via
  the test suite; `agentgate audit verify` (0 records — a fresh database) confirming both the audit and replay
  chains report cleanly; tracked-file secret scan (exact `security.yml` pattern/allowlist) clean; tracked-file
  hygiene scan (no tracked `.sqlite`/`.log`/`.env`/archive/token files; `.claude/`, `CLAUDE.md`, `graphify-out/`
  all confirmed untracked) clean; `git diff --check` clean (CRLF notices only); process/port/temp residue check
  clean (no leftover gateway process, no leftover `agentgate-*` temp directory) after every run above.
- Clean-clone verification (Phase 11): resolved the exact candidate commit (`efe73e35116aab9c7435a99fccb0c471cac
  20bca`), created a fresh `git clone --no-local` into a scratch temp directory (never a filesystem copy), and
  confirmed it contained none of: `.claude/`, `CLAUDE.md`, `graphify-out/`, any pre-existing `dist/`,
  `node_modules/`, database/token/log file, or workspace link. Ran, inside the clone, from a completely fresh
  `pnpm install --frozen-lockfile`: build (clean, 4/4), lint (clean, same 2 pre-existing warnings), the complete
  test suite (**policy 52/52, control-center 105/105, gateway 471/2-skipped, 628 total — byte-identical to the
  outer repo's counts**), all five demos (all PASS), the onboarding smoke test (PASS), packed-install
  verification (**15/15 PASS**), the tracked-file secret scan (clean), `git diff --check` (clean), and a
  post-run `git status --short` (empty — every demo/test artifact was genuinely self-cleaning even inside a
  from-scratch clone) and process/temp residue check (clean). **Every clean-clone gate passed on the first
  attempt — no repair iteration was needed.** The clone directory was removed after verification.
- Browser verification and screenshots: not re-run this session — the real-gateway/real-browser verification
  (1280×900 and 420×800, zero console errors, zero failed/4xx/5xx requests, hostile-content/reset-dialog/focus
  assertions, all PASS) was performed and its evidence already recorded in the 2026-08-28 "Milestone 7 Control
  Center + demo session" ledger entry above, with the resulting screenshots (`docs/assets/control-center-context-
  guard{,-escalation,-narrow}.png`) already committed in `5242384`. This session's documentation/Graphify/review
  work did not change any Control Center source file, so no new capture was warranted; the existing screenshots
  remain accurate for the candidate verified here.
- Defects found and fixed this session: none — Phase 7's focused review found no new concrete defect (see
  above); every documentation claim added was written from direct source reading and cross-checked by either an
  existing passing test, a new test (`docs-context-guard-examples.test.ts`), a live manual CLI walkthrough, or a
  Graphify query independently confirmed against source, so no doc-only inaccuracy requiring correction was
  discovered after the fact.
- Known limitations (unchanged from the ADR/prior entries, restated here for completeness — see ADR-0013 and the
  `docs/THREAT_MODEL.md` Context Guard section for the full, authoritative list): no model-reasoning inspection
  or causal proof; one stdio connection/process may not equal one model conversation; `monitor` mode (the
  default) provides no blocking protection and `agentgate init` does not yet generate an `enforce`-mode block for
  new projects; no cross-restart context persistence; TTL expiry not yet actively scheduled; a residual
  cross-request evaluation/label-append race is not fully eliminated; the SSE "no historical replay to a fresh
  subscriber" property has no dedicated low-level automated test (unchanged gap, reconfirmed still accurate this
  session); Context Guard's hash chain is local tamper evidence, not tamper-proof. This session's own added
  limitations: Graphify's semantic (doc-content) layer was not re-extracted, only the AST (code) layer (stated
  scope decision above); Phase 7's review was a focused, targeted re-read of the highest-risk paths, not an
  exhaustive line-by-line audit of every file in the milestone's diff.
- Current Git state at the time of this entry: branch `main`, local HEAD `efe73e35116aab9c7435a99fccb0c471cac20b
  ca` (seven commits ahead of `origin/main`, all local, all still unpushed as of this entry); `origin/main`
  unchanged at `2e959e3121e542ea01a4d5f6ba28424a647cb865`; `git status --short` shows only `.claude/`/`CLAUDE.md`
  untracked, nothing else.
- Unresolved questions: none blocking.
- Exact next action: append this entry (already done, immediately above), stage it alone, run a final
  staged-diff check and secret scan, commit with a message file, then proceed to the pre-push audit and push
  `main` normally — per this turn's explicit scope, observing GitHub CI/Security to green afterward.

### 2026-08-28 — Milestone 7 push and CI/Security observation (tested commit `fb414da`)

- Prompt objective: perform the final pre-push audit, push `main` normally, and observe GitHub CI/Security to
  green for the exact pushed commit.
- Pre-push audit: inspected every commit in `origin/main..HEAD` (8 commits: `61c02c3`, `c8ed307`, `2bdbd99`,
  `b43bec6`, `5242384`, `5d8da1b`, `efe73e3`, `fb414da`) and the aggregate diff (`git diff --stat
  origin/main...HEAD`: 62 files changed, 10569 insertions(+), 116 deletions(-)) — confirmed no unrelated files,
  no `.claude/`/`CLAUDE.md`/`graphify-out/` present anywhere in the diff, no tracked database/log/`.env`/archive
  file, no `package.json` change of any kind (all three publishable packages remain `"private": true`,
  unchanged), no git tag created. A full secret scan (the exact `security.yml` pattern/allowlist) over the
  complete aggregate diff was clean.
- Pushed: `git push origin main` → `2e959e3..fb414da main -> main`. Confirmed `git rev-parse HEAD` equals
  `git rev-parse origin/main` (`fb414dae70338e9da3b6cc39fab365ca47348636`) immediately after, via a fresh
  `git fetch`.
- GitHub Actions observation for the exact pushed commit (`fb414dae70338e9da3b6cc39fab365ca47348636`):
  - **CI** — run [`33175696438`](https://github.com/chidhvilasa/agentgate/actions/runs/33175696438) —
    **conclusion: success**. Three jobs, all `success`: `build-test (ubuntu, node 20)`,
    `build-test (ubuntu, node 22)`, `build-test (windows, node 22)` — each ran install/build/lint/test, all five
    demos including the new `Context Guard cross-tool prompt-injection demo (ADR-0013)` step, packed-install
    verification, the whitespace/hygiene check, and the no-generated-artifacts check; every step in every job
    reported `success`.
  - **Security** — run [`33175696263`](https://github.com/chidhvilasa/agentgate/actions/runs/33175696263) —
    **conclusion: success**. Three jobs, all `success`: `Dependency audit (high+ severity)`,
    `CodeQL (TypeScript/JavaScript)`, `Tracked-file secret scan (deterministic, local)`.
  - No job failed; no re-run was needed.
- Repository hygiene at this point: `git status --short` shows only `.claude/`/`CLAUDE.md` untracked; local HEAD
  equals `origin/main` equals `fb414da`.
- Known limitations: unchanged from the entry immediately above — see that entry and ADR-0013/
  `docs/THREAT_MODEL.md` for the full, authoritative list. No new limitation was introduced by pushing.
- Unresolved questions: none blocking.
- Exact next action: append the final Milestone 7 publication-closeout ledger entry (this session, immediately
  after this one) recording this already-observed green CI/Security state, run the same commit-hygiene checks,
  and push that ledger-only commit — the last action of this turn's explicit scope.

### 2026-08-28 — Milestone 8 release-candidate implementation session (built on `1f1a59a`)

- Prompt objective: prepare a public-beta release CANDIDATE — packaging, secure defaults, cross-platform CI, a
  prepared-but-inert trusted-publishing release workflow, checksum/SBOM/manifest generation, and public-beta
  documentation — with no npm publish, tag, GitHub Release, or repository-setting mutation.
- Evidence gathered before any implementation commit: `npm whoami` → `ENEEDAUTH` (no authenticated npm account in
  this environment); `npm view agentgate` → a real, unrelated, already-published third-party package
  (`agentgate@0.16.0`, `github.com/monteslu/agentgate`) — ruling out an unscoped meta-package name permanently;
  `npm view @agentgate/{gateway,policy,protocol}` → all 404 (unpublished; scope-claim status itself unverified by
  an unauthenticated probe); fetched current npm/GitHub docs for trusted-publishing/provenance/attestation exact
  requirements; read `packages/gateway/src/onboarding/init.ts` and `packages/gateway/src/config/registry.ts` in
  full, confirming `tool_integrity: mode: explicit` was already generated by `init` but `context_guard` was not
  generated at all (schema default `monitor` applies silently) — the concrete Phase 2 beta-blocker.
- Decisions added: **ADR-0014** (release/distribution architecture — package topology, lockstep beta versioning,
  OIDC trusted-publishing model, release trigger/approval boundary, and the two Phase 2 security fixes below).
  No prior ADR was modified or superseded.
- Phase 2 fixes, each adversarially re-tested: `agentgate init` now generates an explicit
  `context_guard: { mode: enforce }` block (empty tools/rules) for new projects;
  `checkApprovalContextValid()`'s `tool_fingerprint` check now fails closed on ANY null/non-null transition, not
  only a value-to-different-value drift; added the previously-missing deterministic Context Guard SSE
  no-historical-replay test. Full gateway suite re-run after each change (41 files / 475 passed / 2 pre-existing
  platform skips, unchanged).
- Phase 3: removed `private: true` from the three publishable packages; added accurate
  `repository`/`homepage`/`bugs`/`keywords`/`publishConfig.access:"public"` and a restrictive `files` allowlist;
  added a per-package `README.md` (contents checked against actual exports in `src/index.ts`) and a copied
  `LICENSE`. Extended `scripts/verify-packed-install.mjs` with a SHA-256/size manifest, a forbidden-path content
  scan, and a packed-`package.json` dependency-specifier check (no `workspace:`/`file:`/`link:`/`portal:`). Full
  run: all checks pass; real installed-CLI `--version` returned `0.1.0-beta.1` from a clean external consumer
  directory with zero workspace access.
- Phase 4: adopted lockstep prerelease versioning (`0.1.0-beta.1` across all three packages, justified in ADR-0014
  point 2); added `scripts/check-release-consistency.mjs` (+ `scripts/check-release-consistency.test.mjs`, 7
  cases) verifying the lockstep invariant and an optional git-tag-matches-version check. No tag created.
- Phase 5: added a `build-test-macos` job to `.github/workflows/ci.yml` — build, lint, full test suite (exercises
  the `better-sqlite3` native module), packed-install verification, release-consistency check; the five demo
  scripts deliberately not tripled across all three OSes (justified in the job's own comment).
- Phase 6: added `.github/workflows/release.yml` — triggers only on a `v*.*.*` tag push or manual
  `workflow_dispatch`; a real `npm publish` additionally requires an explicit `workflow_dispatch` `publish: true`
  input AND the `npm-publish` GitHub Environment's approval (an environment this workflow only references, not
  creates); OIDC trusted publishing (`id-token: write`, no `NPM_TOKEN`); npm CLI ≥11.5.1 / Node ≥22.14.0 asserted
  explicitly in-job; no dependency caching in the publish jobs; SHA-pinned third-party action (`pnpm/setup`,
  matching the existing repo convention), official actions pinned by major tag; concurrency protection; a
  build-provenance attestation job (`actions/attest-build-provenance@v2`) that only runs after a real publish
  succeeds. Reviewed for YAML validity via `js-yaml` (found and fixed one real syntax bug: an unquoted step name
  containing `workspace:` was parsed as a mapping key). Not executed — no tag exists to trigger it.
- Phase 7: added `scripts/generate-release-manifest.mjs` (SHA-256 checksums, a CycloneDX 1.5 SBOM and a license
  inventory built from the real resolved production dependency graph via `pnpm licenses list --prod` — 184
  dependencies, all matching an explicit permissive-license allowlist, the check is a release gate not just a
  report — and a machine-readable `release-manifest.json`) and `scripts/scan-release-artifacts.mjs` (+ test
  suite, 8 cases) for a deterministic credential/local-path scan of generated artifacts. Verified no local
  filesystem path/username appears in any generated file (checked directly on the written bytes, and via the
  scanner's own test suite).
- Phase 8: substantially expanded README.md's Installation section (prerequisites, "not published yet" stated
  up front, future-registry install explicitly labeled unavailable, checksum/SBOM/attestation verification
  instructions, upgrade/downgrade/uninstall guidance) and Project status (public-beta framing, updated test
  counts, macOS added to the platform matrix); added a "Milestone 8 Verification" section to
  `docs/VERIFICATION.md` following the file's existing per-milestone evidence-table convention; added a
  Milestone 8 CHANGELOG.md entry (still `[Unreleased]`) stating both compatibility-affecting fixes' impact
  explicitly. Audited (not rewritten) `SECURITY.md`/`docs/QUICKSTART.md` — no stale reference to this milestone's
  changes found in either.
- Phase 9: covered inline with each fix above (dedicated tests for every new/changed behavior); re-ran the full
  workspace test suite (protocol/policy/gateway/control-center: 632 tests) and all five existing attack/defense
  demos after the packaging changes — all pass, zero regressions.
- Phase 10: not applicable — no Control Center UI code was changed this session; no screenshot was regenerated.
- Phase 11 (Graphify): ran `graphify update .` (AST-only) — graph rebuilt to 1628 nodes/2534 edges/113
  communities (up from 1514/2409/104). Ran six `explain`/`path` queries against symbols this milestone
  added/changed (`checkApprovalContextValid`, `buildConfigTemplate`, `checkReleaseConsistency`, `buildSbom`,
  `scanReleaseArtifacts`, and an undirected path between `checkApprovalContextValid` and `getTrustedFingerprint`);
  all six independently confirmed byte-accurate against source read directly this session, recorded in
  `docs/GRAPHIFY_VERIFICATION.md`. No new false positive was found this milestone — reported honestly as such,
  not manufactured to match the pattern of Milestones 6-7 each finding one.
- Verification performed this session: full workspace test suite (632 tests) + new root release-tooling tests
  (15) all pass; `pnpm run lint` clean (0 errors; 2 pre-existing warnings unrelated to this session's changes);
  all five demos re-run and passing; `scripts/verify-packed-install.mjs` and
  `scripts/generate-release-manifest.mjs` both run clean with real evidence (tarball hashes/sizes, 184-dependency
  license inventory, valid CycloneDX SBOM); YAML syntax of all three workflow files validated with `js-yaml`.
- Known limitations / unresolved items carried into the next checkpoint: `@agentgate` npm scope ownership remains
  genuinely unverified (no authenticated npm session available in this environment); the release workflow has
  been reviewed structurally but never actually executed (no tag exists); tarball byte-for-byte reproducibility
  was verified only for immediately-consecutive `pnpm pack` invocations with no intervening `pnpm install` — an
  intervening install can change embedded file mtimes and thus the tarball hash even with unchanged source
  content, so "reproducible" is not claimed beyond that specific, stated boundary.
- Exact next action: run the full local gate, take a release-candidate checkpoint commit, perform the genuine
  `git clone --no-local` clean-clone verification with all 14 required checks, then push and observe CI/Security
  for the final candidate commit.

### 2026-08-28 — Milestone 8 clean-clone verification, push, and CI-fix session (candidate `0d9c63c` → final `6001a13`)

- Local release-candidate gate at checkpoint `0d9c63c`: `pnpm install --frozen-lockfile` clean; `pnpm run build`
  clean; `pnpm run lint` clean (0 errors, 2 pre-existing unrelated warnings); full workspace test suite — 52
  (`policy`) + 105 (`control-center`) + 475 passed/2 skipped (`gateway`) = 632 workspace tests, plus 15 root
  release-tooling tests = 647 total, all passing; all five demos re-run with real exit code 0 and their full
  PASS-assertion counts unchanged (6/7/28/48/58); `scripts/verify-packed-install.mjs`,
  `scripts/check-release-consistency.mjs`, and `scripts/generate-release-manifest.mjs` all run clean with real
  tarball hashes/sizes and a 184-dependency license-checked SBOM; `scripts/scan-release-artifacts.mjs` found
  nothing; `git diff --check` clean; `git status --short` clean (only `.claude/`/`CLAUDE.md`).
- Genuine clean-clone verification: `git clone --no-local` into a fresh scratch directory at exactly `0d9c63c`.
  Ran all 14 required checks there independently: frozen install, build, lint, full test suite (byte-identical
  counts to the outer repo: 52+105+475/2skip+15), all five demos (byte-identical PASS counts), a dedicated
  `agentgate smoke-test` run, the tarball content/allowlist audit, a clean external consumer install of all three
  tarballs with zero workspace access, installed-CLI verification (`--version` → `0.1.0-beta.1`, `context --help`/
  `status`/`verify`), SBOM/checksum/manifest generation and validation, audit-chain (8 records, smoke-test) and
  Context-Guard-chain (`context verify`, packed-install step 7) verification, a tracked-file secret scan, the
  release-artifact scan, `git diff --check`, and a final `git status --short` — all 14 passed, the final status
  was completely empty (no residue from any build/test/pack/scan step). **Important refined finding**: the
  clean-clone tarballs' SHA-256 hashes differed from the outer working directory's tarballs for identical source
  content (e.g. protocol: `28817d43...` outer vs `4c6a577e...` clean-clone) — tarball byte-reproducibility is
  narrower than the prior session-log entry stated: it does not hold even across a fresh clone/build with zero
  intervening installs, only within immediately-consecutive `pnpm pack` runs of the exact same already-built
  working directory (most likely due to embedded file mtimes differing between a freshly-cloned/rebuilt tree and
  an already-built one). This refined understanding is recorded here rather than by editing the prior entry.
  Scratch clone directory removed after verification.
- Pre-push audit at `0d9c63c`: 4 commits ahead of `origin/main` (`679b46b`, `721fe62`, `0c0d51b`, `0d9c63c`), 32
  files changed (`git diff --stat origin/main...HEAD`), no `.claude/`/`CLAUDE.md`/`graphify-out/`/database/`.env`
  file present in the diff, no tag created, full secret/local-path scan of the aggregate diff clean.
- Pushed `1f1a59a..0d9c63c` to `origin/main`; confirmed local HEAD == `origin/main`. Triggered CI run `33186613515`
  and Security run `33186613616`.
- **CI run `33186613515` result**: `build-test (ubuntu, node 20)` success, `build-test (ubuntu, node 22)` success,
  `build-test (windows, node 22)` success, **`build-test (macos, node 22)` FAILURE** — the very first real macOS
  CI run this project has ever had, and it found a genuine, previously-invisible platform bug:
  `packages/gateway/tests/registry.test.ts`'s relative-config-path test failed
  (`expected '/private/var/folders/...' to be '/var/folders/...'`) — macOS's `/var/folders/...` temp path is
  itself a symlink to `/private/var/folders/...`, and `process.chdir()`+`process.cwd()` (which
  `loadGatewayConfig()`'s relative-path resolution depends on) reports the OS-canonicalized form; the test's raw,
  un-resolved `tmpDir` reference did not. AgentGate's production code was correct; only the test's comparison was
  not symlink-aware. **Security run `33186613616` result**: `Dependency audit` success, `CodeQL` success,
  **`Tracked-file secret scan` FAILURE** — this milestone's own new test fixture literal
  (`AKIAABCDEFGHIJKLMNOP`, in `scripts/scan-release-artifacts.test.mjs`) was correctly flagged as unrecognized by
  the scan's allowlist, exactly as the scan is designed to do for any new synthetic credential-shaped literal.
- Fixed both real findings (commit `6154053`): `registry.test.ts` now compares against `fs.realpathSync(tmpDir)`
  (a no-op on Linux/Windows); `security.yml`'s `ALLOWED` list gained the new literal, by exact value, matching
  the established convention. Re-ran the full gateway suite locally (475 passed/2 skipped, unchanged) and the
  exact security.yml scan logic locally (clean) before pushing. Pushed; triggered CI run `33187187187` and
  Security run `33187187138`.
- **CI run `33187187187` result**: the macOS symlink fix worked, but a SECOND, independent real macOS-only bug
  surfaced immediately after: `build-test (macos, node 22)` FAILED again, this time at the
  "Packed-package install verification" step — `tar: Option --force-local is not supported`. Root cause:
  `--force-local` is a GNU-tar-only extension (needed on Windows to stop tar misreading a `C:\...` path's
  drive-letter colon as a remote-tar host spec); macOS ships BSD tar (libarchive), which rejects the flag
  outright with a usage error. This flag had been passed unconditionally in `scripts/verify-packed-install.mjs`
  and `scripts/scan-release-artifacts.mjs` since this milestone extended/added them — invisible until the very
  first real macOS run. **Security run `33187187138` result**: all 3 jobs success (the earlier allowlist fix
  held).
- Fixed (commit `6001a13`): both scripts now gate `--force-local` behind `process.platform === 'win32'` via a
  shared `TAR_LOCAL_FLAGS` constant, with the exact cross-platform reasoning documented inline. Re-verified
  locally on Windows (`verify-packed-install.mjs` full pass with real hashes; `scan-release-artifacts.mjs` full
  pass; `pnpm run lint` clean; root release-tooling tests 15/15 passing) before pushing. Pushed; triggered CI run
  `33187807678` and Security run `33187807655`.
- **Final result — both green for commit `6001a13`**:
  [CI run `33187807678`](https://github.com/chidhvilasa/agentgate/actions/runs/33187807678) — **conclusion:
  success**, all 4 jobs success (`build-test (macos, node 22)` in 1m32s, `build-test (windows, node 22)` in
  3m50s, `build-test (ubuntu, node 22)` in 2m12s, `build-test (ubuntu, node 20)` in 2m1s — the macOS job passing
  for the first time in this project's history, with every step including the new release-tooling checks);
  [Security run `33187807655`](https://github.com/chidhvilasa/agentgate/actions/runs/33187807655) — **conclusion:
  success**, all 3 jobs success (`Tracked-file secret scan` 5s, `CodeQL` 1m17s, `Dependency audit` 19s).
- Repository hygiene at this point: `git status --short` shows only `.claude/`/`CLAUDE.md` untracked; local HEAD
  equals `origin/main` equals `6001a13fca87c19510703768517061a41b239c6`.
- Known limitations, honestly carried forward: `@agentgate` npm scope ownership remains unverified (no
  authenticated npm session in this environment); the release workflow (`release.yml`) has been reviewed
  structurally and its YAML validated, but has never actually been executed by GitHub Actions (no tag exists to
  trigger it) — its correctness under real execution is therefore unverified beyond static review; tarball
  byte-reproducibility holds only within consecutive `pnpm pack` runs of one already-built working directory, not
  across a fresh clone/build (see the clean-clone finding above) — this is a materially narrower claim than
  "reproducible build" and must be stated as such in any future report.
- Unresolved questions: none blocking this milestone's scope.
- Exact next action: append the final Milestone 8 closeout ledger entry recording this already-observed green
  CI/Security state (this session, immediately after this one, as a ledger-only commit), then report the
  milestone's final result to the operator.

### 2026-08-29 — First-publication identity resolution and zero-cost release preparation

- Starting local and remote HEAD: `4c65010cec17ee72071ac9cebdc769a6e06591cc`, branch `main`, with only the
  owner's pre-existing `.claude/` and `CLAUDE.md` untracked.
- npm account evidence: authenticated browser session belongs to `chidhvilasa`; account settings report 2FA
  enabled for authorization and publishing with one security key. The account initially had no organizations.
- Scope result: an authenticated attempt to create the free, public-only npm organization `agentgate` returned
  the authoritative error `This name is unavailable.` No organization was created and no payment or paid plan
  was initiated. The three `@chidhvilasa/{protocol,policy,gateway}` package records were independently confirmed
  unpublished before this change. ADR-0016 records the resulting decision to use the already-owned, free
  `@chidhvilasa` user scope.
- Implementation: changed all four workspace package identities and every live TypeScript import, workspace
  dependency, filter, release script, release workflow, test, package README, and current documentation reference
  from `@agentgate/*` to `@chidhvilasa/*`. Historical ADR/session prose remains intact except ADR-0014's explicit
  pointer to ADR-0016. Updated release tarball patterns from `agentgate-*.tgz` to the actual scoped-pack output
  `chidhvilasa-*.tgz`; added a structural regression test for both the package identity and tarball patterns.
- Two genuine current-Windows compatibility findings were fixed before publication: Vite/Vitest's default
  config bundler attempted to traverse a sandbox-inaccessible parent directory, while their supported `runner`
  config loader builds/tests correctly; Control Center scripts now select that loader. Windows 11's current
  bundled bsdtar 3.8.8 rejects `--force-local`, while older Windows tar variants required it for drive-letter
  paths; both tar-consuming release scripts now detect the option before using it, and
  `verify-packed-install.mjs` also normalizes CRLF tar listings.
- Verification before the first release checkpoint: frozen workspace install clean; build clean (all four
  buildable workspaces); lint 0 errors/2 pre-existing warnings; 52 policy + 105 Control Center + 475 gateway
  passed with 2 gateway skips = 632 passing workspace tests; all five adversarial demos passed with their
  established assertion counts; release-tooling tests increased from 28 to 29 and all pass; release consistency
  passes; packed-install verification passes all 30 checks against the real renamed tarballs and an isolated
  external consumer, including installed CLI `--version`, smoke-test, and Context Guard commands.
- No package, tag, GitHub Release, GitHub Environment, trusted publisher, repository setting, organization, token,
  or paid plan has been created at the time of this checkpoint entry. The implementation commit hash cannot be
  recorded here before that commit exists; a later entry must record the actual hash and publication evidence.
- Exact next action: commit and push the fully verified package-identity change, wait for CI/Security on that exact
  commit, regenerate and scan release artifacts from it, authenticate npm's CLI through the web flow, and publish
  the first versions in dependency order only if all gates remain green.
