# Security Policy

AgentGate is early-stage software (see [Project status](README.md#project-status)) that is nonetheless explicitly
designed to reduce risk from untrusted AI-agent tool calls. We take reports about it seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Use GitHub's private vulnerability reporting for this repository:
[https://github.com/chidhvilasa/agentgate/security/advisories/new](https://github.com/chidhvilasa/agentgate/security/advisories/new)

If private reporting is not enabled or not visible to you, open a regular issue asking a maintainer to enable it or
to provide an alternative private channel — **without describing the vulnerability itself** in that issue.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce (a minimal policy file + tool call sequence is ideal).
- The AgentGate commit/version, OS, and Node version.
- Whether you believe it affects the threat model described in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) or is
  something not yet covered there.

## What is in scope

- The policy engine, secret detection/redaction, and audit hash chain (`packages/policy`, `packages/gateway/src/storage.ts`).
- The MCP stdio proxy and pipeline (`packages/gateway/src/transport`, `packages/gateway/src/pipeline.ts`).
- The Control API's authentication, CORS, and Host/Origin checks (`packages/gateway/src/api/control.ts`).
- The Control Center's handling of the auth token and rendered data (`apps/control-center`).

## What is already known and documented (not a new report)

Please check [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) first — several limitations are already tracked
there as deliberate, documented gaps rather than undiscovered vulnerabilities, including:

- The audit hash chain is **tamper-evident, not tamper-proof**, and provides no non-repudiation guarantee against
  someone with direct filesystem access to the SQLite database.
- Downstream MCP server **results** are not currently secret-scanned or redacted before persistence, unlike
  request arguments.
- The SSE live-timeline auth token is passed as a URL query parameter (an `EventSource` limitation).
- No retention enforcement or rate limiting is implemented yet, despite configurable retention settings.
- Self-reported agent identity (`declared_name`/`declared_version`) is never used for authorization.

If you find a way to exploit one of these in a way *not* already described, or a way around a mitigation that *is*
documented as implemented, that is a valid report.

## Response

This is a small, early-stage open-source project without a dedicated security team or SLA. We will do our best to
acknowledge reports promptly and to be transparent about triage and fix timelines once a report is received.

## Disclosure

Please give us a reasonable opportunity to address a report before any public disclosure. We intend to credit
reporters (with permission) in the eventual advisory/changelog entry.
