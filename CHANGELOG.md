# Changelog

All notable changes to this project are documented in this file. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). AgentGate has not yet published a versioned release or
npm package — see [Project status](README.md#project-status).

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
