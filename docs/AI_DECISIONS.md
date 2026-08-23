# AgentGate Decision Ledger

This file is the durable source of truth for architectural and product
decisions across AI-agent sessions. Verify entries against the repository.

## Project State

- Current phase: Milestone 2 — Documentation, CI, Graphify verification, visual proof, public launch — COMPLETE
  (pending final push/CI observation; see 2026-08-24 session log below)
- Current branch: main (renamed from master immediately before first public push, per ADR-0006)
- Last verified implementation commit (pre-Milestone-2, still on `master`): 5070a2b
- Ledger status: Updated after the Milestone 2 candidate commit(s); verify current HEAD with Git — this entry
  deliberately does not try to record its own future commit hash (see rule in the session-continuity instructions
  this session operated under).
- Last updated: 2026-08-24
- Updated by: Claude Code
- Next action: see "Exact next action" at the end of the 2026-08-24 session log below.

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
