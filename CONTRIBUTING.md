# Contributing to AgentGate

Thanks for considering a contribution. AgentGate is early-stage and security-focused — please read
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) before proposing a change to policy evaluation, redaction, or the
audit chain, so your PR description can speak to any threat-model impact directly.

## Before you start

- For anything beyond a small fix, open an issue first describing what you want to change and why — this avoids
  duplicated or wasted work on a design that wouldn't be accepted.
- Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) to
  understand the workspace layout and where a change belongs.
- **Never include real credentials, real audit databases, or unredacted logs in an issue, PR, or commit** — see
  [SECURITY.md](SECURITY.md) for how to report a vulnerability privately instead of in a public issue.

## Development setup

```sh
git clone https://github.com/chidhvilasa/agentgate.git
cd agentgate
pnpm install --frozen-lockfile
pnpm run build
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the full workflow, including running the gateway and Control
Center locally.

## Before opening a PR

Run the full local gate and make sure every step genuinely passes:

```sh
pnpm run build
pnpm run lint
pnpm run test
node examples/secret-exfiltration/demo.mjs
node examples/downstream-secret-result/demo.mjs
git diff --check
```

- **Tests**: add or update tests for any behavior change. Gateway/policy tests use Vitest against real objects
  (real `AuditStorage` on a throwaway SQLite file, real `runPipeline()`) — prefer that over mocking internals.
- **Lint**: `pnpm run lint` is a real gate (exit code reflects real errors). Do not disable a rule just to make a
  change pass — fix the code, or explain in the PR why the rule doesn't apply and get agreement first.
- **Do not weaken a security check to make a test pass.** If a test is failing because your change makes AgentGate
  less strict (e.g. loosening a redaction pattern, widening a default), that is a decision that needs explicit
  discussion in the PR description, not a quiet test edit.

## Decision ledger

Any **durable architectural decision** — a new component, a changed default, a superseded design, a security
trade-off — should be recorded as a new ADR entry in [`docs/AI_DECISIONS.md`](docs/AI_DECISIONS.md):

- Use the next unused sequential ADR number. Never renumber or reuse an existing ID.
- Never mark a decision `SUPERSEDED` by deleting it — add a new ADR with `Supersedes: ADR-XXXX` and update the old
  one's `Superseded by` field, exactly as `ADR-0002`/`ADR-0005` do today.
- A bug fix, refactor, or dependency bump is usually *not* a durable decision and does not need an ADR entry.

## Pull request expectations

Your PR description should include:

- **What changed and why.**
- **Security impact** — even "none" is a useful, explicit statement. If your change touches policy evaluation,
  redaction, the audit chain, or the Control API's auth/CORS/Host checks, say so explicitly and reference the
  relevant section of [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
- **Verification evidence** — the actual output (or a summary) of the commands above, not just "tests pass."

See [`.github/pull_request_template.md`](.github/pull_request_template.md), which is applied automatically.

## Code style

Match the surrounding code: comment density, naming, and idiom. The shared `eslint.config.mjs` is the source of
truth for what's enforced — see [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#install--build--lint--test) for how it
is organized and why certain type-aware rules are intentionally off.

## Reporting bugs and requesting features

Use the issue templates: [`.github/ISSUE_TEMPLATE/bug_report.yml`](.github/ISSUE_TEMPLATE/bug_report.yml) and
[`.github/ISSUE_TEMPLATE/feature_request.yml`](.github/ISSUE_TEMPLATE/feature_request.yml). **Redact logs and audit
data before pasting them** — bug reports are public.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md), version 2.1.
