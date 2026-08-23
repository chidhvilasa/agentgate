# Changelog

All notable changes to this project are documented in this file. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). AgentGate has not yet published a versioned release or
npm package — see [Project status](README.md#project-status).

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
