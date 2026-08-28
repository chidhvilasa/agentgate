# AgentGate — Milestone 1 Verification Report

This document records the verification steps performed to prove the security and functional claims of AgentGate Milestone 1.

## Claim 1: True Append-Only Audit Trail
**Verification:**
The SQLite database schema was refactored into two tables: `audit_events` and `audit_lifecycle_records`.
- All updates to an event (e.g., status changes to DENIED, APPROVED) are strictly implemented as **INSERTs** into the `audit_lifecycle_records` table.
- Each record includes a `previous_hash` forming a cryptographic hash chain.
- The `agentgate audit verify` CLI command independently traverses this chain to detect tampering.
- **Evidence:** `tests/storage.test.ts` passes, confirming hash linking and tamper detection.

## Claim 2: Deep Redaction of Secrets
**Verification:**
The policy engine (`redactArgumentsForAudit`) intercepts all MCP tool call arguments before they reach the database.
- Detected secrets (like AWS keys, API tokens) are replaced with `[REDACTED]`.
- The `demo.mjs` attack simulation successfully verified that despite the prompt-injected agent passing an AWS key to `network.request`, the persisted database only contained `[REDACTED]`.
- **Evidence:** The real end-to-end `demo.mjs` successfully runs and passes all database assertions.

## Claim 3: Legacy MCP Support & Stdio Proxying
**Verification:**
The stdio transport intercepts JSON-RPC requests on the fly.
- Hardcoded `legacy-2025` is supported using the official `@modelcontextprotocol/sdk`.
- The gateway acts as a server to the AI agent, and as a client to the downstream server, faithfully proxying allowed requests and injecting blocks for denied ones.
- **Evidence:** `demo.mjs` spawns the gateway via StdioClientTransport and receives a simulated DENY JSON-RPC payload seamlessly.

## Claim 4: Control API Security
**Verification:**
The Control API (`http://127.0.0.1:4001`) prevents malicious access from random browser tabs.
- Binds exclusively to loopback addresses.
- Enforces strict `Host` and `Origin` header validation.
- Requires `x-agentgate-token` for all endpoints.
- Specifies `Referrer-Policy: no-referrer` and restricts CORS origins.
- **Evidence:** `tests/api.test.ts` passes, correctly rejecting malicious headers and invalid tokens.

## End-to-End Demo Status
The `examples/secret-exfiltration/demo.mjs` script acts as an executable proof of these claims. It successfully spawns the gateway, performs an attack, verifies the block, and verifies the tamper-evident hash chain in the SQLite database.

**Status:** PASS

---

# Milestone 3 Verification — Bidirectional Secret Safety (ADR-0009)

Each row names an exact test file/case or reproducible command. All commands below were run from the repository
root against this milestone's final candidate commit.

| Claim | Evidence |
|---|---|
| A clean downstream result is forwarded unchanged | `packages/gateway/tests/pipeline-output-security.test.ts` → *"forwards a clean result unchanged and stores no redaction metadata"*; `packages/gateway/tests/output-security.test.ts` → *"forwards a clean text result unchanged"* |
| A synthetic secret in downstream **text** content is redacted before reaching the upstream client | `packages/gateway/tests/pipeline-output-security.test.ts` → *"redacts a secret-bearing result before it is returned upstream and records metadata"*; `node examples/downstream-secret-result/demo.mjs` (Scenario 1) |
| Nested **structured content** (arrays/objects) is deep-scanned and redacted | `packages/policy/tests/output-sanitization.test.ts` → *"deep-scans nested arrays and objects"*; `packages/gateway/tests/output-security.test.ts` → *"deep-scans structuredContent and redacts nested secrets"* |
| `isError: true` results are sanitized identically to success results | `packages/gateway/tests/output-security.test.ts` → *"sanitizes text content even when isError is true"*; `packages/gateway/tests/pipeline-output-security.test.ts` → *"sanitizes downstream isError results the same as success results"* |
| `output_security.mode: block` replaces a secret-bearing result with a protocol-valid, secret-free error | `packages/gateway/tests/output-security.test.ts` → *"replaces the whole result with a protocol-valid error when a secret is detected"*; `packages/gateway/tests/pipeline-output-security.test.ts` → *"block mode replaces a secret-bearing result with a protocol-valid error and never persists the raw result"* |
| Opaque binary content (`image`/`audio`/resource `blob`) is passed through byte-identical, in either mode, and never blocks on its own | `packages/gateway/tests/output-security.test.ts` → *"passes image content through completely untouched"*, *"passes audio content through untouched and never blocks purely for being opaque"*, *"passes an embedded resource blob through untouched"* |
| Unknown content-block types and unrecognized top-level result fields pass through unmodified | `packages/gateway/tests/output-security.test.ts` → *"passes an unrecognized content-block type through unmodified"*, *"passes an unrecognized top-level field through unmodified"* |
| The sanitizer never mutates its input | `packages/policy/tests/output-sanitization.test.ts` → *"does not mutate the input object"*; `packages/gateway/tests/output-security.test.ts` → *"never mutates the original result object"* |
| Depth/size limits are enforced and truncated content is marked, not silently claimed safe | `packages/policy/tests/output-sanitization.test.ts` → *"enforces maximum depth..."*, *"enforces maximum text size..."* |
| Circular references and prototype-pollution-shaped keys (`__proto__`, `constructor`) are handled safely, without hanging or polluting `Object.prototype` | `packages/policy/tests/output-sanitization.test.ts` → *"detects and safely breaks a circular reference"*, *"handles a __proto__-named key without polluting Object.prototype"*, *"handles a constructor-named key safely"* |
| Downstream/internal error messages are redacted, length-bounded, and control-character-normalized before persistence | `packages/policy/tests/output-sanitization.test.ts` (`sanitizeErrorMessage` describe block, 9 cases); `node examples/downstream-secret-result/demo.mjs` (Scenario 2) |
| A hostile error object with a throwing `message` getter fails safe rather than crashing or leaking | `packages/policy/tests/output-sanitization.test.ts` → *"handles a malicious object with a throwing message getter"* |
| Audit metadata (`result_redacted`/`result_blocked`/`result_finding_count`/`error_redacted`) is hash-chain protected | `packages/gateway/tests/storage-migration.test.ts` → *"detects tampering with a new (v2-only) metadata field"* |
| A database created before this migration (`canonical_payload_version: '1'`) continues to verify correctly after the upgrade, across a mixed v1→v2 chain | `packages/gateway/tests/storage-migration.test.ts` → *"migrates a hand-crafted legacy v1 lifecycle record and continues the chain under v2"* |
| The migration survives a process restart | `packages/gateway/tests/storage-migration.test.ts` → *"continues the sequence and chain correctly across a process restart"* |
| The approval flow is unaffected by output security | `packages/gateway/tests/pipeline-output-security.test.ts` → *"the approval path still works end-to-end with output security enabled"* |
| A raw synthetic secret never appears in the upstream MCP response, the SQLite database, or the Control API/SSE payload | `node examples/downstream-secret-result/demo.mjs` (dumps every `audit_events` row and asserts the synthetic key is absent); `packages/gateway/tests/pipeline-output-security.test.ts` → *"block mode ... never persists the raw result"* (direct row query) |
| The prior inbound secret-exfiltration demo has no regression | `node examples/secret-exfiltration/demo.mjs` re-run and passing after this milestone's changes |

**Status:** PASS — 86 tests (52 in `packages/policy`, 34 in `packages/gateway`) plus both end-to-end demos, all
passing as of this milestone's final candidate commit. See the dated Milestone 3 entry in
`docs/AI_DECISIONS.md` for the exact commands run and their output.

---

# Milestone 4 Verification — Safe Replay and Policy-Drift Analysis (ADR-0010)

Each row names an exact test file/case or reproducible command. All commands below were run from the repository
root against this milestone's final candidate commit.

| Claim | Evidence |
|---|---|
| Replay never executes the original tool call — structurally, not just today | `packages/gateway/tests/replay-no-execution.test.ts` → *"replay.ts imports nothing capable of reaching a downstream server or creating an approval"* (inspects only actual `import` statements, not comment prose) |
| Replay never contacts a downstream server — executable, process-external proof | `packages/gateway/tests/replay-no-execution.test.ts` → a real fixture downstream MCP server's call counter (persisted to a temp file) is 1 after one real execution and **still 1** after 5 subsequent replays of the same event; `node examples/policy-drift-replay/demo.mjs` reproduces this against production-built (`dist`) packages, through both the Control API and the CLI, and asserts the counter unchanged after each |
| Replay never creates or resolves an approval | `packages/gateway/tests/replay-no-execution.test.ts` → *"never creates or resolves an approval during replay"* (spies on `ApprovalManager.create/approve/deny`, confirms none called even when the hypothetical current decision is `REQUIRE_APPROVAL`); `node examples/policy-drift-replay/demo.mjs` asserts `GET /api/approvals` is empty after a real replay |
| Replay never mutates the source event | `packages/gateway/tests/replay-no-execution.test.ts` → *"never modifies the source event or appends a new audit lifecycle record"*; `packages/gateway/tests/replay-api.test.ts` → *"does not mutate the source event when replaying"*; `node examples/policy-drift-replay/demo.mjs` asserts the source event is byte-identical before/after two real replays |
| Every decision-transition combination is correctly reported (ALLOW↔DENY, to/from `REQUIRE_APPROVAL`, `ALLOW_WITH_TRANSFORM`), including matched-rule-only and reason-code-only drift | `packages/gateway/tests/replay.test.ts` (19 cases) |
| A source event whose arguments were redacted at ingest surfaces an explicit limitation, never silently | `packages/gateway/tests/replay.test.ts` → *"warns explicitly when source arguments were redacted"* / *"does not claim a redaction limitation when arguments were not redacted"* |
| A malformed/legacy/unsupported historical event is rejected, not guessed at, and never echoes a raw value in its error | `packages/gateway/tests/replay.test.ts` → the `ReplayUnsupportedEventError` cases; `packages/gateway/tests/replay-api.test.ts` → *"returns 409 for a non-replayable (malformed) historical event"* |
| Replay evaluations are append-only and hash-chained, with tampering/deletion/reordering all detected | `packages/gateway/tests/storage-replay.test.ts` (12 cases: schema creation, chaining, multi-evaluation lineage, referential integrity, tampering on decision/policy-digest fields, deletion-gap detection, reordering detection, restart continuation) |
| The `replay_evaluations` table has no raw-argument/result column at all (schema-level guarantee, not just behavioral) | `packages/gateway/tests/storage-replay.test.ts` → *"never stores raw arguments or raw secrets (schema-level guarantee: no such column exists)"* |
| `agentgate audit verify` checks both the audit chain and the replay lineage chain in one invocation | `packages/gateway/tests/storage-replay.test.ts` → *"verifyChain and verifyReplayChain are independent"*; `node examples/policy-drift-replay/demo.mjs` (Step 6) |
| The Control API rejects `dry_run:false`/`execute:true`/`run:true`/any unknown field, rather than ignoring it | `packages/gateway/tests/replay-api.test.ts` (4 cases) |
| The Control API requires auth, rejects a hostile Host header, and returns safe, generic errors for missing/malformed events and a malformed policy file (no local path leakage) | `packages/gateway/tests/replay-api.test.ts` (7 cases) |
| No raw secret ever appears in the API response, CLI output, or `agentgate audit verify` output | `packages/gateway/tests/replay-api.test.ts` → *"never leaks a raw secret-shaped value..."*; `node examples/policy-drift-replay/demo.mjs` (asserted after every replay path and the verify command) |
| The Control Center's Safe Replay card has no execution control anywhere, handles every UI state, and never renders anything the API didn't actually return | `apps/control-center/src/pages/EventDetail.test.tsx` (8 cases: initial no-execution state with no execution control present, success unchanged, success changed, redacted-source warning shown/not-shown, safe error with working retry, double-submit prevention, no value fabrication) |
| A real historical event, replayed under a genuinely changed policy, through both the API and the CLI, shows the correct drift end-to-end against production-built packages | `node examples/policy-drift-replay/demo.mjs` — 24 in-demo assertions, all PASS |
| The prior two demos have no regression | `node examples/secret-exfiltration/demo.mjs` and `node examples/downstream-secret-result/demo.mjs` re-run and passing after this milestone's changes |

**Status:** PASS — 154 tests total across the workspace (52 in `packages/policy`, 86 in `packages/gateway`
[including 52 new Safe Replay tests], 16 in `apps/control-center` [including 8 new Safe Replay component tests])
plus all three end-to-end demos, all passing as of this milestone's final candidate commit. See the dated Safe
Replay session-log entries in `docs/AI_DECISIONS.md` for the exact commands run and their output, phase by
phase.

---

# Milestone 5 Verification — Zero-Friction Adoption, Diagnostics, and Release Readiness (ADR-0011)

Each row names an exact test file/case or reproducible command. All commands below were run from the repository
root against this milestone's final candidate commit.

| Claim | Evidence |
|---|---|
| Packed-tarball install actually works end-to-end (pack → install all three together → run the installed CLI) | `node scripts/verify-packed-install.mjs` — 9 assertions, all PASS; wired into both CI jobs |
| Installing the gateway tarball alone genuinely fails (a real limitation, not hypothetical) | Reproduced manually with `npm install <gateway-tarball-only>` → real `npm error 404` for `@agentgate/policy`; documented in `docs/DEVELOPMENT.md#installability`, not silently omitted |
| Publishable tarballs contain only `dist/` (no `src`/`tests`/`tsconfig`) | `scripts/verify-packed-install.mjs`'s tarball-content assertions; tarball size comparison recorded in the dated ledger entry |
| `agentgate init` never overwrites without `--force`, writes atomically, and generates a deny-by-default, non-wildcard-allow policy | `packages/gateway/tests/onboarding-init.test.ts` (11 cases: clean init, overwrite refusal, `--force` overwrite, nested-dir creation, spaces/Unicode paths, determinism, real-loader parse success, deny-by-default with exactly one narrow rule, no token/secret literal, loopback-only) |
| `agentgate config validate` reuses the exact production loaders, never a second validator | `packages/gateway/tests/onboarding-config-validate.test.ts` (8 cases covering every failure category: missing_file, syntax_error, schema_error, policy_error, unsafe_value, plus a valid pass and a never-throws guarantee) |
| `agentgate doctor` is read-only and never executes a downstream server | `packages/gateway/tests/onboarding-doctor.test.ts` (10 cases, including a structural no-`child_process`-import guardrail mirroring Safe Replay's own no-execution test, an mtime-unchanged assertion after a real audit-chain check, and a genuine tampering-detection case) |
| `agentgate integrate` supports exactly `claude-code`/`antigravity` (both verified against fetched, current docs) plus a `generic` fallback explicitly labeled unverified | `packages/gateway/tests/onboarding-integrate.test.ts` (17 cases) |
| `integrate --apply` backs up, writes atomically, and preserves unrelated content; `--dry-run` writes nothing | `packages/gateway/tests/onboarding-integrate.test.ts`'s `applyIntegration` suite (9 cases: new-file creation, unrelated-key/entry preservation, timestamped backup, dry-run no-op, overwrite reporting, malformed-JSON refusal, non-object refusal, atomic no-leftover-temp-file) |
| `agentgate smoke-test` proves allow/deny/redaction/chain-verification, fully offline, and cleans up on success | `packages/gateway/tests/onboarding-smoke-test.test.ts` (4 cases) and a real run from an **installed, packed** package via `scripts/verify-packed-install.mjs` |
| The gateway shuts down cleanly on SIGINT/SIGTERM (POSIX) and a structural guardrail confirms the handler exists regardless of platform | `packages/gateway/tests/lifecycle.test.ts` (4 cases; 2 POSIX-only, correctly skipped on Windows — see the dated ledger entry for the verified Node/Windows platform limitation that necessitated this) |
| A second gateway on an occupied port fails clearly without affecting the first | `packages/gateway/tests/lifecycle.test.ts` |
| The Control Center `.main-content` card-clipping bug (documented as a known limitation since Milestone 4) is fixed | Real browser verification: a live Event Detail/Safe Replay page at both a desktop (1280×900) and a narrow (420×800) viewport, asserting `card.scrollHeight <= card.clientHeight + 2px` (i.e. nothing hidden by overflow) at both sizes, zero console errors at both sizes; screenshots `docs/assets/control-center-{desktop,narrow}-no-clip.png` |
| No secret/token/path leakage across onboarding stdout/stderr/JSON/generated files | Per-command assertions across all five `onboarding-*.test.ts` files (each checks for `AKIA...`, `x-agentgate-token`, and similar patterns in its own command's output) |

**Status:** PASS — 206 tests total across the workspace (52 policy + 16 control-center + 138 gateway, of which 2
gateway tests are correctly platform-skipped on Windows), all three pre-existing demos, `scripts/
verify-packed-install.mjs`, and a real browser verification of the clipping fix, all passing as of this
milestone's final candidate commit. See the dated Milestone 5 session-log entries in `docs/AI_DECISIONS.md` for
the exact commands run and their output, phase by phase.

---

# Milestone 6 Verification — Tool Integrity Registry and Rug-Pull Defense (ADR-0012)

Each row names an exact test file/case or reproducible command. All commands below were run from the repository
root against this milestone's final candidate commit.

| Claim | Evidence |
|---|---|
| Key/tool-list reordering never causes false drift; array-order changes where semantically meaningful do | `packages/gateway/tests/tool-integrity-canonicalize.test.ts` (27 golden-fixture cases) |
| Every supported definition-field change (description, title, input/output schema, annotations, added/removed fields, unknown/future fields) is detected | `packages/gateway/tests/tool-integrity-canonicalize.test.ts`; `packages/gateway/tests/tool-integrity-diff.test.ts` (29 cases, including all 5 diff-change classifications) |
| Duplicate and case-confusable tool names, and malformed/oversized/deeply-nested/cyclic definitions, fail closed | `packages/gateway/tests/tool-integrity-canonicalize.test.ts` |
| Server identity is not `serverInfo.name` alone; distinguishes two servers with the same name; stable across harmless path-separator differences; changes on security-relevant config change; never persists raw env values | `packages/gateway/tests/tool-integrity-identity.test.ts` (12 cases) |
| Every registry state transition (unseen→pending/trusted, trusted→drifted, rejected→same-fingerprint-stays-rejected/new-fingerprint-reopens-drift, removed→reappeared-always-requires-review) is correct | `packages/gateway/tests/tool-integrity-registry.test.ts` (21 cases) |
| Exact-fingerprint accept/reject required; a stale review can never silently approve a superseded candidate | `packages/gateway/tests/tool-integrity-registry.test.ts`; `packages/gateway/tests/tool-integrity-cli.test.ts`; `packages/gateway/tests/tool-integrity-api.test.ts` (409/404 cases); `examples/tool-rug-pull/demo.mjs` (Step 14) |
| Accepting a candidate never rewrites/deletes the prior trusted baseline or review history (append-only) | `packages/gateway/tests/tool-integrity-registry.test.ts`; `packages/gateway/tests/tool-integrity-api.test.ts` → *"reject does not rewrite or delete a previously trusted baseline"*; `examples/tool-rug-pull/demo.mjs` (Step 17) |
| Registry migration from a pre-Milestone-6 database, restart persistence, tampering (field mutation), deleted-row (sequence gap), reordered-row, and broken-hash-link detection | `packages/gateway/tests/tool-integrity-storage-migration.test.ts` (8 cases) |
| `scan.ts` is the ONLY Tool Integrity module that ever connects to a downstream server; every other module (including `diff.ts`) never imports the MCP SDK, `executeDownstream`, or `runPipeline` | `packages/gateway/tests/tool-integrity-no-execution.test.ts` (6 cases) |
| A quarantined tool is filtered from the REAL gateway's `tools/list`; a direct cached-name `tools/call` is blocked BEFORE policy evaluation or downstream contact; the SAME already-open MCP client connection succeeds immediately after an out-of-process exact-fingerprint accept, with no restart | `packages/gateway/tests/tool-integrity-gateway-enforcement.test.ts` — spawns the real compiled gateway, connects a real `@modelcontextprotocol/sdk` `Client` over stdio; the downstream fixture's own call counter proves 0 calls during the blocked attempt |
| Untrusted annotations (`readOnlyHint`/`destructiveHint`) never reduce enforced risk | `packages/gateway/src/tool-integrity/enforcement.ts` never reads them (structural, by construction — reviewed directly); `examples/tool-rug-pull/demo.mjs` generation 2 flips both annotations AND is still quarantined |
| CLI `scan`/`status`/`diff`/`history` are read-only and never call a tool; `trust`/`reject` require exact identity/fingerprint; safe human/JSON output; correct exit codes | `packages/gateway/tests/tool-integrity-cli.test.ts` (9 cases against a real fixture downstream server) plus a manual end-to-end walkthrough of the built CLI binary |
| Control API: auth required, hostile Host/Origin rejected, malformed candidate ids/unknown fields/oversized reason rejected (400), stale fingerprint (409), double-submit safely rejected (404, candidate already consumed), concurrent accept-vs-reject mutually exclusive, no secret/token/path leakage in any response | `packages/gateway/tests/tool-integrity-api.test.ts` (19 cases) |
| Control Center renders every major state (loading/empty/trusted/quarantine/drifted), all 5 diff-change kinds, truncation, exact-fingerprint accept (with confirmation)/reject (no confirmation, calmer default), stale/already-consumed error surfaces, double-submit prevention, rescan busy/error, history, and renders hostile HTML/prompt-injection/ANSI as inert text only (zero `<script>` elements created) — with no "trust all" control anywhere | `apps/control-center/src/pages/ToolIntegrity.test.tsx` (31 cases) |
| A real benign-to-malicious rug-pull is detected, quarantined, and blocked before downstream execution, end to end, against production-built packages | `examples/tool-rug-pull/demo.mjs` — ~40 in-demo assertions, all PASS, run 3× consecutively with identical results |
| The rug-pull demo's cleanup runs even on a real injected mid-run failure, not merely a `finally` block inspected by eye | `packages/gateway/tests/tool-rug-pull-demo-cleanup.test.ts` (2 cases: injected failure → no temp-dir residue and the control port stops listening; hook is a true no-op when unset) |
| The prior four demos have no regression | `node examples/{secret-exfiltration,downstream-secret-result,policy-drift-replay}/demo.mjs` and `node scripts/verify-packed-install.mjs` re-run and passing after this milestone's changes |
| `agentgate init` generates new projects with the recommended `explicit` mode; the generated config is valid YAML that passes `agentgate config validate` | Manual verification (documented in the dated Milestone 6 ledger entries); `packages/gateway/tests/onboarding-init.test.ts` unaffected/still passing |

**Status:** PASS as of the commands recorded in the dated Milestone 6 session-log entries in
`docs/AI_DECISIONS.md` — see those entries for the exact test counts, gate results, and commands run, phase by
phase; the final candidate commit's exact counts are recorded in the milestone's final report and ledger entry.

---

# Milestone 7 Verification — Context Guard Cross-Tool Escalation Defense (ADR-0013)

Each row names an exact test file/case or reproducible command. All commands below were run from the repository
root against this milestone's final candidate commit.

| Claim | Evidence |
|---|---|
| Context state machine (created/label_added/call_evaluated/reset/expired/closed), monotonic revision, label-union accumulation, and outcome-gated label-append timing are all correct | `packages/gateway/tests/context-guard-state.test.ts` |
| Contextual rule evaluation (`when` operators, first-match, strictest-wins merge with base policy) is correct | `packages/gateway/tests/context-guard-rules.test.ts` (23 cases) |
| Context Guard interacts correctly with the rest of the pipeline: `allow_with_transform` composition, ordinary (non-contextual) approvals still bind with `contextual_rule_id: "base-policy"`, disabled mode omits binding entirely, blocked/redacted/failed/errored results add labels exactly per the documented outcome table, and the audit and context chains both stay independently valid across a mixed sequence | `packages/gateway/tests/context-guard-interactions.test.ts` (14 cases) |
| Context migration (version 9 / `MIGRATION_VERSIONS.CONTEXT_GUARD`) from an authentic pre-Milestone-7 database, restart persistence, and tampering/deleted-row/reordered-row detection | `packages/gateway/tests/context-guard-storage-migration.test.ts` |
| A real compiled gateway denies a direct/cached-name `send_webhook` call after accumulated risk, with the fixture's own call counter proving zero downstream contact — twice (fresh call and repeated cached-name call) — and a fresh, independent connection/context does not inherit the first context's labels | `packages/gateway/tests/context-guard-gateway-enforcement.test.ts` -> "zero-contact proof..." |
| Contextual REQUIRE_APPROVAL: a stale-revision approval fails consumption-time revalidation with the counter at 0; a fresh approval bound to the current revision executes (counter becomes exactly 1); approval is single-use and does not clear context labels | `packages/gateway/tests/context-guard-gateway-enforcement.test.ts` -> "contextual REQUIRE_APPROVAL..." |
| `tool_fingerprint` approval binding populates from the REAL currently-trusted Tool Integrity fingerprint (never client-supplied), binds `null` correctly for an unscanned/quarantined/rejected tool, and consumption-time revalidation rejects when the tool drifts or is quarantined between approval creation and a human decision, with zero downstream contact | `packages/gateway/tests/context-guard-fingerprint-binding.test.ts` (7 cases, pipeline-level, real Tool Integrity state) |
| The same fingerprint-binding proof against a real, out-of-process Tool Integrity drift simulation on a real compiled gateway | `packages/gateway/tests/context-guard-fingerprint-gateway.test.ts` |
| CLI `status`/`history`/`explain`/`reset`/`verify` — bounded output, stored-evidence-only `explain` (never a fabricated decision), exact-revision reset requiring a non-empty reason, ANSI/control-character stripping of hostile tool names/reasons before printing, and packaged-artifact (installed CLI) smoke coverage | `packages/gateway/tests/context-guard-cli.test.ts` (32 cases) |
| Control API: all 6 routes behind the existing loopback/Host/Origin/CORS/token/`Referrer-Policy` middleware, strict reset body-schema validation (exact `{revision, reason}`, unknown fields rejected), concurrent double-reset resolves to exactly one 200/one 409, no reset-all/label-removal/permanent-approval/Tool-Integrity-modification route exists, no raw arguments/results/secrets/tokens/paths/stack traces in any response (including against a script-shaped context id and a tampered chain) | `packages/gateway/tests/context-guard-api.test.ts` (37 cases) |
| SSE: `context_event` frames are published on the same stream as `audit_event`, discriminated by `event_type`, with a bounded/redacted payload | `packages/gateway/tests/context-guard-sse.test.ts` (5 cases) |
| Documented Context Guard YAML examples (README.md and docs/POLICY_REFERENCE.md, both the deny-path and require-approval-path complete examples, and the migration snippet) parse through the real `loadGatewayConfig()` production loader, and an omitted `context_guard` block defaults to `monitor` mode unchanged | `packages/gateway/tests/docs-context-guard-examples.test.ts` (5 cases) |
| Control Center Context Guard page: loading/unavailable(404)/error+retry/empty states; overview stats incl. truncation and chain-integrity verified/FAILED; list rendering incl. state-filter refetch, row selection, deep-link, and a genuinely separate narrow (~420px) card-list layout (not a squeezed table) with keyboard activation; detail lifecycle/correlation-note/reset-availability-per-status; escalation display for deny/require_approval/allow/never-evaluated with no fabricated decisions; label origins; transition timeline ordering/chain-invalid/truncated/empty; the full reset flow (exact-revision submission, 409 stale handling, double-submit prevention, Escape, focus, no broad reset-all/mark-safe control); SSE refetch-once/idempotent-duplicate/reconnect-indicator/unmount-cleanup; hostile HTML/Markdown/ANSI/secret/long-value handling rendered as inert text only; accessible-name coverage on every interactive control | `apps/control-center/src/pages/ContextGuard.test.tsx` (53 cases) |
| Approvals page renders the new `context_id`/`context_revision`/`contextual_rule_id`/`tool_fingerprint` binding fields only when actually bound, links to Context Guard with the exact context id, and never renders a raw/full secret-shaped fingerprint value | `apps/control-center/src/pages/Approvals.test.tsx` (5 cases) |
| A real cross-tool poisoned-result attack (synthetic indirect-prompt-injection ticket -> synthetic-secret read -> denied external send, twice) is blocked end-to-end against production-built packages, with the fixture's own external-send call counter proving zero contact for both attempts; a second, independent context/connection demonstrates the full require_approval lifecycle (stale-binding failure at counter 0, fresh-approval success at counter exactly 1, third-attempt single-use proof); the synthetic secret and the raw injected-instruction phrase never appear in any CLI output or stored `context_events` row | `node examples/context-poisoning/demo.mjs` — 58 in-demo PASS assertions, 0 FAIL, run 3 consecutive times with identical results |
| The demo's `finally`-block cleanup actually runs on a real injected mid-run failure (no leftover temp directory, both gateway control ports stop listening), and the fault-injection hook is a true no-op when unset | `packages/gateway/tests/context-poisoning-demo-cleanup.test.ts` (2 cases) |
| Real-browser evidence: the live Context Guard page against genuinely live gateway state at 1280x900 and 420x800, zero console errors, zero failed/4xx/5xx requests, reset-dialog warnings/focus/Escape confirmed, and the raw injected-instruction text/synthetic secret/local auth token confirmed absent from the rendered page | Sanitized screenshots `docs/assets/control-center-context-guard{,-escalation,-narrow}.png`; capture method and exact assertions recorded in the dated Milestone 7 UI/demo session-log entry in `docs/AI_DECISIONS.md` |
| The prior five demos have no regression | `node examples/{secret-exfiltration,downstream-secret-result,policy-drift-replay,tool-rug-pull}/demo.mjs` and `node scripts/verify-packed-install.mjs` re-run and passing after this milestone's changes |
| Clean-clone verification at the exact final candidate commit | See the dated Milestone 7 final verification/publication ledger entries in `docs/AI_DECISIONS.md` for the exact commands and results |

**Status:** see the dated Milestone 7 final verification and publication session-log entries in
`docs/AI_DECISIONS.md` for the exact test counts, gate results, clean-clone result, and commands run, phase by
phase; the final candidate commit's exact counts are recorded there, not invented in advance here.

---

# Milestone 8 Verification — Public Beta Release Candidate and Verifiable Supply Chain (ADR-0014)

Each row names an exact test file/case or reproducible command. All commands below were run from the repository
root against this milestone's final candidate commit. **No npm publish, version tag, or GitHub Release was created
by this milestone** — every claim below is about a prepared, verified release CANDIDATE, never a completed
publication; see ADR-0014 in `docs/AI_DECISIONS.md` and the dated Milestone 8 session-log entries there for the
exact final counts/hashes/commit, not invented in advance here.

| Claim | Evidence |
|---|---|
| `agentgate init` generates an explicit, non-monitor `context_guard: { mode: enforce }` block for new projects (closing the beta-blocker: new installs no longer silently start in the non-blocking `monitor` default) | `packages/gateway/tests/onboarding-init.test.ts` → *"generates an explicit, high-security tool_integrity AND context_guard mode for new projects"* |
| A contextual approval's `tool_fingerprint` binding fails closed on ANY transition (null-to-value, value-to-null, value-to-different-value) between approval creation and consumption, not only a value-to-different-value drift | `packages/gateway/tests/context-guard-enforcement.test.ts` (two new adversarial cases); full existing fingerprint-binding suites (`context-guard-fingerprint-binding.test.ts`, `context-guard-fingerprint-gateway.test.ts`) re-run and pass unchanged |
| A fresh Context Guard SSE subscriber never receives historically-published `context_event` frames, proven deterministically (no negative-timeout wait) | `packages/gateway/tests/context-guard-sse.test.ts` → *"never replays historical context transitions to a fresh subscriber..."* |
| Every publishable package (`@agentgate/protocol`, `@agentgate/policy`, `@agentgate/gateway`) is not `private`, carries accurate `repository`/`homepage`/`bugs`/`keywords`/`publishConfig.access:"public"`, and a restrictive `files` allowlist | `scripts/check-release-consistency.mjs` (also unit-tested in `scripts/check-release-consistency.test.mjs`, 7 cases) |
| Packed tarballs contain no forbidden path (`src/`, `tests/`, `.env`, `.git/`, `node_modules/`, `*.sqlite*`, `*.map`, `.npmrc`, `.claude/`, `CLAUDE.md`) and every packed `package.json` is free of `workspace:`/`file:`/`link:`/`portal:` dependency specifiers | `scripts/verify-packed-install.mjs` — extended this milestone with a per-package content-allowlist check and a packed-manifest dependency-specifier check, run against real `pnpm pack` output |
| A clean, external consumer project (zero workspace access) can `npm install` all three tarballs together and run the real installed `agentgate` CLI (`--version`, `smoke-test`, `context --help`/`status`/`verify`) | `scripts/verify-packed-install.mjs` full run |
| The three publishable packages share one lockstep version, and a git tag exactly matching `v<version>` is required by the tag-consistency check (a mismatched tag fails) | `scripts/check-release-consistency.test.mjs` (7 cases, including a real tag-mismatch failure case) |
| A macOS CI job actually builds, lints, runs the full test suite (exercising the `better-sqlite3` native module), and runs the packed-install/release-consistency checks | `.github/workflows/ci.yml` `build-test-macos` job — see the linked GitHub Actions run for this milestone's final commit in the Milestone 8 session-log entry for its actual conclusion |
| The release workflow cannot publish on an ordinary push to `main`, a pull request, or a bare tag push alone — a real `npm publish` requires an explicit manual `workflow_dispatch` input AND the `npm-publish` protected GitHub Environment's approval | `.github/workflows/release.yml` — structural `if:` condition on the `publish` job; reviewed directly, not executed (no tag exists to trigger it) |
| The release workflow asserts npm CLI >=11.5.1 and Node >=22.14.0 before any publish attempt, uses no dependency caching in the publish jobs, and never publishes via a stored long-lived token (OIDC `id-token: write` only) | `.github/workflows/release.yml` — reviewed directly (`publish-dry-run`/`publish` jobs) |
| A real SHA-256 checksum manifest, a CycloneDX 1.5 SBOM built from the actual resolved production dependency graph, and a machine-readable release manifest are generated from real tarballs, with every dependency's license checked against an explicit allowlist and no local filesystem path/username in any generated file | `node scripts/generate-release-manifest.mjs` — see the dated Milestone 8 session-log entry for the exact dependency count/hashes from this milestone's final run |
| Generated release artifacts (and, separately, tracked source files) are scanned for credential-shaped strings and local filesystem paths, deterministically | `scripts/scan-release-artifacts.mjs` (unit-tested in `scripts/scan-release-artifacts.test.mjs`, 8 cases: clean pass, real AKIA-shaped detection, allowed-placeholder non-detection, Windows-path detection, Unix-path detection, GitHub-token detection, missing-directory no-op, subdirectory recursion) |
| The prior six demos have no regression | `node examples/{secret-exfiltration,downstream-secret-result,policy-drift-replay,tool-rug-pull,context-poisoning}/demo.mjs` re-run and passing after this milestone's changes |
| Clean-clone verification at the exact final candidate commit, including the packed-consumer install and generated-artifact scans | See the dated Milestone 8 final verification session-log entry in `docs/AI_DECISIONS.md` for the exact commands and results |

**Status:** see the dated Milestone 8 session-log entries in `docs/AI_DECISIONS.md` for the exact test counts, gate
results, clean-clone result, tarball hashes, and commands run, phase by phase; the final candidate commit's exact
counts are recorded there, not invented in advance here. This section describes a verified release CANDIDATE — no
package has been published, no tag or GitHub Release created, as stated throughout ADR-0014.

---

# First Publication Preflight — Owner Authorization Gate (ADR-0015)

A read-only preflight against the Milestone 8 release candidate, plus real defects found in
`.github/workflows/release.yml` (never executed) and fixed. See [ADR-0015](AI_DECISIONS.md) for the full design
amendment and [`docs/RELEASE_RUNBOOK.md`](RELEASE_RUNBOOK.md) for the resulting operator process.

| Claim | Evidence |
|---|---|
| The release candidate commit had not drifted; the full local gate (install/build/lint/632+15 tests/all 5 demos/packed-install/release-consistency) still passes identically | Re-run this session; see the dated ledger entry for exact counts |
| npm registry state for all three package names, and whether `@agentgate` scope ownership can be verified in this environment | `npm whoami` → `ENEEDAUTH`; `npm view @agentgate/{protocol,policy,gateway}` → all 404; scope ownership genuinely unverifiable without an authenticated npm session (not "confirmed available") |
| **npm trusted publishing cannot be configured for a never-published package** — a first-publish bootstrap requirement not previously documented | Verified against current official npm documentation and community sources this session; see ADR-0015 point 2 |
| The release workflow's `publish` job could previously be dispatched from an arbitrary branch commit with no tag, contradicting its own stated design | Found by direct line-by-line review; fixed by adding `github.ref_type == 'tag'` to the job's `if:` condition; regression-tested in `scripts/release-workflow-structure.test.mjs` |
| Attested/checksummed/SBOM'd artifacts were not necessarily the same bytes that would actually be published (separate, non-reproducible rebuilds) | Found by tracing the build graph against Milestone 8's own documented tarball-reproducibility limitation; fixed by having every job reuse the exact tarballs `verify` already built; regression-tested |
| The publish loop had no idempotent-retry handling for a partial-publish rerun | Found by reasoning through GitHub Actions' bash `-e` default and npm's immutable-version behavior; fixed with a `npm view <name>@<version>` already-published check; regression-tested |
| No GitHub Environment exists yet in this repository; referencing a non-existent Environment risks an unprotected auto-created one | `gh api repos/chidhvilasa/agentgate/environments` → `total_count: 0`; documented as a critical sequencing warning in the runbook, not fixed in code (would require a repository-setting mutation, out of scope) |
| The release workflow's structural invariants (trigger set, publish gating, artifact reuse, permission scoping, no stored secret, publish order, idempotency, documentation of the bootstrap requirement) | `scripts/release-workflow-structure.test.mjs` (13 cases, parses the real YAML) |
| No package, tag, GitHub Release, npm scope, trusted publisher, GitHub Environment, repository setting, or secret was created or modified during this preflight | Directly confirmed — see the dated ledger entry and this preflight's final report |

**Status:** see the dated ledger entry for this session in `docs/AI_DECISIONS.md` for the exact final commit,
CI/Security run results, and complete evidence. This remains a verified release CANDIDATE with a corrected,
regression-tested release workflow — still not published, tagged, or released.
