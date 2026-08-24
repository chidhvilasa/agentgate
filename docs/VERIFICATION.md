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
