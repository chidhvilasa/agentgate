# Changelog

All notable changes to this project are documented in this file. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). AgentGate has not yet published a versioned release or
npm package — see [Project status](README.md#project-status).

## [Unreleased] — Milestone 5: Zero-friction adoption, diagnostics, and release readiness

### Added
- **`agentgate init [directory] [--force]`**: deterministic, non-interactive generation of a deny-by-default
  gateway config and starter policy. Never overwrites without `--force`; writes atomically; embeds no token or
  secret; the starter policy permits exactly one narrow tool, never a wildcard.
- **`agentgate config validate [config.yml] [--json]`**: validates a gateway config and its referenced policy
  using the exact same production loaders `agentgate start` uses.
- **`agentgate doctor [config.yml] [--client-config <path>] [--json]`**: read-only diagnostics (Node/platform
  version, config/policy validity, database writability and — only when already fully migrated — audit/replay
  chain verification, downstream command resolution without execution, port availability, Control Center build
  status, stale-artifact detection, optional client-integration-fixture validation). Never executes a
  downstream server, never opens a network connection, never modifies configuration or the database.
- **`agentgate integrate <client> [config.yml] [--out|--apply] [--dry-run]`**: generates an MCP client
  integration snippet. `claude-code` and `antigravity` are supported, each verified against fetched, current
  official documentation this milestone; `generic` is an explicitly unverified fallback recipe for other
  clients. Default behavior only prints or writes a new file; `--apply` is an explicit opt-in that always backs
  up, writes atomically, and preserves unrelated content, with `--dry-run` for a zero-write preview.
- **`agentgate smoke-test [--json]`**: local, offline, harmless proof the policy engine and audit trail work —
  one real allow, one real deny, one redaction case, chain verification, and an on-disk secret-absence check —
  using a new built-in fixture server that ships with the compiled package. Fully self-cleaning.
- **`agentgate --version`** and per-command `--help` for every command, new and existing.
- **Graceful shutdown**: the gateway now handles SIGINT/SIGTERM, closing the Control API, approval manager, and
  database cleanly before exiting — previously there was no signal handling at all.
- **Packaging**: `"files": ["dist"]` added to all three publishable packages (previously shipped `src`/`tests`
  in every tarball); new `scripts/verify-packed-install.mjs` proves — with a real `pnpm pack` and `npm install`
  into an isolated consumer — that installing all three tarballs together works end-to-end, including running
  the installed `agentgate smoke-test`. Wired into CI.
- New ADR-0011 (Zero-Friction Onboarding Without New Trust or Execution Surfaces).
- 56 new tests (50 across five `onboarding-*.test.ts` files, 4 in a new `lifecycle.test.ts`, 2 of which are
  correctly platform-skipped on Windows) — 206 total across the workspace.

### Fixed
- **Control Center `.main-content` card clipping**: a flex-column container with `overflow-y:auto` let its
  `.card` children shrink below their real content height instead of the container scrolling, and each card's
  own `overflow:hidden` then clipped the shrunk content — visible on any page with enough cards to exceed the
  viewport (e.g. Event Detail with the Safe Replay card). Documented as a known limitation since Milestone 4's
  Phase 5 session log; fixed this milestone with `flex-shrink: 0` on `.card`/`.page-header`, and verified in a
  real browser at both a desktop and a narrow viewport.
- Publishable-package tarball bloat (see Packaging above).

### Changed
- README rewritten from the quickstart down: leads with the new onboarding commands, a verified installation
  section (source + packed tarballs), a client-integrations table with cited authoritative sources, and a
  platform/runtime support matrix backed by CI (Ubuntu 20/22, Windows 22; macOS explicitly stated as untested,
  not implied covered).
- `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/DEVELOPMENT.md`, `docs/TROUBLESHOOTING.md`,
  `docs/VERIFICATION.md` updated with the onboarding CLI's design, threats/mitigations, contributor notes, a
  doctor check-id reference table, and a full evidence table respectively.

### Known limitations (unchanged claims, restated for this milestone)
- No published npm package — packed-tarball install requires running `pnpm pack` from a source checkout
  yourself; installing the gateway tarball in isolation (without its two workspace siblings) does not work.
- `agentgate init` has no interactive mode in this milestone (deterministic/non-interactive only).
- The verified client-integration matrix is intentionally small (two verified clients, one labeled-generic
  fallback).
- macOS is not covered by CI in this milestone.

## [Unreleased] — Milestone 4: Safe Replay and policy-drift analysis

### Added
- **Safe Replay** (ADR-0010): re-evaluates a historical, already-redacted `AuditEvent` against the *current*
  policy and reports whether the decision would change — policy re-evaluation only, never tool re-execution.
  `executed` in every response is the TypeScript literal type `false`, not `boolean`; there is no `dry_run`
  toggle, `execute` flag, or any other input that changes this, and none is planned as an "escape hatch" —
  the API and CLI both reject an execution-like or unknown request field outright rather than ignoring it.
  - New pure service `packages/gateway/src/replay.ts`: imports only the policy engine's `evaluate()` (the same
    function the live pipeline calls) and three existing pure argument-extraction helpers re-exported from
    `pipeline.ts` — never the MCP SDK, `executeDownstream()`, `runPipeline()`, or `ApprovalManager`.
  - New `POST /api/events/:id/replay`, `GET /api/events/:id/replays`, and `GET /api/replays/:replayId` Control
    API routes (`packages/gateway/src/api/control.ts`).
  - New `agentgate replay <event-id> [config.yml] [--json]` CLI command; `agentgate audit verify` now also
    verifies the new replay lineage chain alongside the audit chain in the same invocation.
  - New append-only, hash-chained `replay_evaluations` table (`AuditStorage.insertReplayEvaluation()`/
    `verifyReplayChain()`), independent of the audit chain — no raw argument, result, or secret column exists in
    its schema at all.
  - New `computePolicyDigest()` (`packages/policy/src/digest.ts`) — a stable hash of the canonicalized policy
    structure (never raw file bytes), recorded on every replay evaluation.
  - Real Safe Replay card in the Control Center's Event Detail page (`apps/control-center/src/pages/
    EventDetail.tsx`), replacing the previously disabled "Dry-run Replay (coming in Milestone 2)" stub: a
    prominent no-execution indicator, original-vs-current decision/rule/reason, a clear changed/unchanged result,
    a redacted-source-arguments warning when applicable, and loading/success/safe-error(with retry) states —
    with no execute/run/approve control anywhere, because none is possible.
  - New end-to-end demo: `examples/policy-drift-replay/demo.mjs` — a real gateway and a real fixture downstream
    server; one real audited tool call under policy A, a policy change to policy B, then a replay of that same
    historical event through both the Control API and the CLI, asserting the correct decision drift, an
    unchanged downstream call counter, no approval created, and an unchanged source event.
  - 60 new tests: 52 in `packages/gateway` (19 decision-transition/edge-case tests, 5 no-execution-invariant
    tests including an executable fixture-counter proof, 12 storage/tamper-evidence tests, 16 Control API tests)
    and 8 new Control Center component tests — 154 total across the workspace.
  - CI now also runs the policy-drift Safe Replay demo (`.github/workflows/ci.yml`).

### Fixed
- `control.ts`: Fastify's default JSON body parser rejected a genuinely empty request body sent with
  `Content-Type: application/json` — exactly what a browser `fetch()` via the Control Center's `post()` helper
  sends. This was found while testing the new replay endpoint but was already present and already affected the
  pre-existing `/api/approvals/:id/deny` endpoint before this milestone. A custom content-type parser now treats
  an empty body as `{}` and still returns `400` (not `500`) for genuinely malformed non-empty JSON.
- `control.ts`: the in-flight replay request-deduplication cleanup produced a separate, unhandled promise
  rejection distinct from the one the request handler itself already caught; fixed with a
  `.then(onFulfilled, onRejected)` cleanup whose resulting promise never itself rejects.

### Changed
- `packages/protocol/src/api.ts`: replaced the old, unimplemented `ReplayRequest`/`ReplayResponse` contract
  (which had a `dry_run?: boolean` field and a comment reading *"Must explicitly set to false to execute"*) with
  the real `ReplayEvaluationRequest`/`ReplayEvaluationResponse` contract described above.
- `docs/THREAT_MODEL.md`: replaced the "Unsafe replay" (deferred/unimplemented) section with a full "Safe Replay
  (ADR-0010)" section covering replay endpoint abuse, execution-flag smuggling, forged event IDs,
  policy-replacement/time-of-check confusion, redacted-input ambiguity, replay-chain tampering, and
  sensitive-data leakage — each with its actual implemented mitigation, not a promise of a future one.
- `README.md`, `docs/ARCHITECTURE.md`, `docs/POLICY_REFERENCE.md`, `docs/VERIFICATION.md`,
  `docs/DEVELOPMENT.md`, `docs/TROUBLESHOOTING.md`: updated with Safe Replay usage, architecture, a new
  screenshot, and troubleshooting guidance; removed stale "coming in Milestone 2"/"no replay" claims.

### Known limitations (unchanged claims, restated for this milestone)
- Safe Replay always evaluates against the *current* policy — there is no per-event historical policy snapshot,
  so it answers "what would this decision be today," not "what was policy at some specific past moment."
- A source event whose arguments were redacted at ingest can show `decision_changed: true` on replay purely from
  representational drift (the stored `[REDACTED]` placeholder no longer matching a `contains_secrets` rule that
  matched the original value) — always surfaced explicitly in the response, never silently.
- The replay lineage chain shares the same local tamper-*evidence*-not-tamper-*proof* limitation as the audit
  chain — see [Database replacement](docs/THREAT_MODEL.md#database-replacement-by-a-local-administrator).
- Retention enforcement, rate limiting, and modern/HTTP-transport MCP support remain deferred (unchanged from
  Milestone 3).

## [Unreleased] — Milestone 3: Bidirectional secret safety

### Added
- **Downstream result sanitization** (ADR-0009): `sanitizeToolResult()` (`packages/gateway/src/output-security.ts`)
  inspects a downstream tool's result — MCP text content, structured content, and embedded-resource text — for
  recognized secret patterns before it is ever returned to the upstream MCP client. Configurable via a new
  gateway-level `output_security` config block (`mode: redact | block`, `max_depth`, `max_text_bytes`; see
  `docs/POLICY_REFERENCE.md`). Image/audio content and embedded-resource `blob` data (base64 binary) are always
  passed through untouched in both modes — never regex-scanned, to avoid corrupting binary payloads.
- **Canonical error sanitization** (ADR-0009): `sanitizeErrorMessage()` (`packages/policy/src/output-sanitization.ts`)
  redacts recognized secret patterns, bounds length, and normalizes control characters/newlines in every
  downstream/internal error before it is persisted, hash-chained, returned by the Control API, pushed over SSE,
  rendered in the Control Center, or written to a gateway log line.
- New `AuditEvent` fields `result_blocked`, `result_finding_count`, and `error_redacted` (alongside the
  pre-existing `result_redacted`, whose meaning is corrected — see Changed below). All four are hash-chain
  protected under a new `canonical_payload_version: '2'`; `verifyChain()` dispatches canonicalization by each
  lifecycle record's own stored version, so a chain spanning the v1→v2 migration boundary still verifies.
- New end-to-end demo: `examples/downstream-secret-result/demo.mjs` — a real gateway and a real fixture
  downstream MCP server that leaks a synthetic credential in both a result and an error message; verifies both
  are sanitized before reaching the upstream client/database, self-cleaning, no real network/secrets.
- 34 new tests (28 sanitizer unit tests in `packages/policy`, 16 gateway output-security shape tests, 6 pipeline
  integration tests against a real spawned fixture downstream server, 4 storage migration/hash-chain-tampering
  tests) — 86 total across the workspace.
- CI now runs both attack demos (`.github/workflows/ci.yml`).

### Fixed
- `stdio.ts`: a `FAILED` (downstream execution threw) response to the upstream client previously showed the
  stale `ALLOW` decision's explanation instead of the actual failure reason; now shows the sanitized
  `execution_error`.
- `storage.ts`: `insertEvent()`'s and `rowToEvent()`'s returned `AuditEvent.canonical_payload_version` was
  hardcoded to `'1'` regardless of a record's actual stored version.

### Changed
- `AuditEvent.result_redacted`'s doc-comment previously (inaccurately) implied redaction "before persistence."
  Raw downstream results were never persisted, before or after this milestone — `result_redacted` now correctly
  documents that it means "redacted before being forwarded to the upstream client."
- `docs/THREAT_MODEL.md`: the "downstream results/errors are not secret-scanned" deferred-mitigation language is
  replaced with the implemented mitigation and its actual, narrower remaining limitations (opaque binary content,
  unknown content-block types, pattern-detector false positives/negatives — this is not a general DLP/PII system).
- `docs/ARCHITECTURE.md`, `docs/POLICY_REFERENCE.md`, `README.md`: updated diagrams, a new `output_security`
  config reference, and a concise "Output security" section describing the new boundary.

### Known limitations (unchanged claims, restated for this milestone)
- This is not production-ready, not a general DLP/PII/malware-scanning system, and does not claim complete
  secret detection — the same conservative, pattern-based detector used for inbound arguments is reused, not
  replaced with something more capable.
- Opaque binary result content (image/audio/blob) is never inspected, in either output-security mode.
- Retention enforcement, rate limiting, a working replay endpoint, and modern/HTTP-transport MCP support remain
  deferred (unchanged from Milestone 2).

## [Unreleased] — Milestone 2: Public launch preparation

### Added
- `README.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/POLICY_REFERENCE.md`,
  `docs/DEVELOPMENT.md`, `docs/QUICKSTART.md`, `docs/TROUBLESHOOTING.md`, `docs/GRAPHIFY_VERIFICATION.md`.
- Open-source community files: `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates, PR
  template.
- `.github/workflows/ci.yml` (cross-platform build/lint/test/demo) and `.github/workflows/security.yml`
  (dependency audit, secret scan, CodeQL).
- Real Control Center screenshots (`docs/assets/`), captured from the running application against synthetic data.
- Genuine local verification of [Graphify](https://github.com/safishamsi/graphify) as optional developer tooling.

### Fixed
- A bug in `startStdioProxy()` where downstream tool discovery constructed an `StdioClientTransport` but never
  called `connect()` before `listTools()`, silently failing every discovery attempt.
- An unbound `this.rowToApproval` method reference passed directly to `Array.prototype.map`.
- Two `no-fallthrough` gaps and several floating/misused promises surfaced by the new lint configuration (see
  Milestone 1 hardening commit for the full list — this changelog does not restate every lint-driven fix).
- Control Center: clicking a high-risk event row on the Overview page set `window.location.hash` instead of
  navigating via `react-router-dom`'s `useNavigate`, which is a no-op under `BrowserRouter` — the row click did
  nothing. Fixed in `Overview.tsx` to match the working pattern already used in `Timeline.tsx`.
- Control Center: the decision-badge color logic in `Overview.tsx`, `Timeline.tsx`, and `EventDetail.tsx` checked
  for the substring `deny`, which never matches the actual status literal `DENIED` — every denied event rendered
  with a neutral/gray badge instead of red. Also, a `SUCCEEDED` event fell through to the same red "failed" class
  in `Timeline.tsx`/`EventDetail.tsx` (no explicit `succeeded` case). Found while capturing real screenshots for
  this milestone; found and fixed before publication.
- Added a `.badge.neutral` CSS rule (`index.css`) for the status-class fallback path, which previously had no
  color styling of its own.
- `.github/workflows/security.yml`'s tracked-file secret scan allowlisted only the two AWS-shaped placeholder
  keys; it did not yet allowlist the `sk-...`/`ghp_...`-shaped synthetic literals in `packages/policy/tests`
  used to exercise `detectSecrets()`, so the scan would have failed CI on its own test fixtures. Fixed by
  allowlisting those specific literals by exact value before the first push.

### Changed
- `docs/AI_DECISIONS.md`'s "Last verified commit" field, which previously tried to record its own future commit
  hash, replaced with a "Last verified implementation commit" + "Ledger status" pair.
- `.gitignore`'s broad `*token*` rule narrowed to the specific runtime-secret filenames AgentGate actually
  produces, so source files like `token-validator.ts` are never accidentally excluded.
- `examples/secret-exfiltration/demo.mjs` now writes all generated fixtures into a unique `os.tmpdir()` directory
  and cleans up in a `try/finally` on both success and failure, instead of writing to the repository root.
- `pnpm run lint` now runs a real, single root ESLint flat configuration (`eslint.config.mjs`) covering every
  workspace package and the example scripts, replacing a recursive `pnpm -r run lint` that silently did nothing
  because no package defined a `lint` script.

## Milestone 1 — Initial implementation

- Policy engine: YAML schema, first-match evaluation, path normalization/traversal defenses, secret detection and
  redaction (`packages/policy`).
- Gateway: MCP legacy-2025 stdio proxy, evaluation pipeline, human-in-the-loop approvals, tamper-evident
  hash-chained audit storage in SQLite, loopback-only Control API (`packages/gateway`).
- Control Center: Overview, Timeline (live SSE), Approvals, Event Detail, Policies views (`apps/control-center`).
- Shared protocol types (`packages/protocol`).
- End-to-end secret-exfiltration attack demo and an initial gateway/policy test suite.
- See `docs/AI_DECISIONS.md` for the full ADR history and session log of this phase.
