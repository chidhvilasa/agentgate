# AgentGate Decision Ledger

This file is the durable source of truth for architectural and product
decisions across AI-agent sessions. Verify entries against the repository.

## Project State

- Current phase: Milestone 1 Verification — COMPLETE
- Current branch: master
- Last verified commit: baae972 (chore(milestone1): security hardening, true append-only audit, and verification) [Clean Working Tree]
- Last updated: 2026-08-21
- Updated by: Antigravity
- Next action: Milestone 2 — README, ARCHITECTURE.md, THREAT_MODEL.md, CI workflows, Control Center screenshot, push to GitHub public repo

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

## Superseded Decisions



## Session Log

### 2026-08-20 — Antigravity - Milestone 1 Hardening and Truthful Verification

- Prompt objective: Perform Security Hardening and Verification for Milestone 1. Ensure all claims are supported by executable evidence.
- Decisions added or changed: Added ADR-0004 (Audit Tamper-Evidence), updated ADR-0002 to legacy-only.
- Implementation completed: Fixed MCP protocol proxying, implemented append-only hash chains in `storage.ts`, ran real E2E stdio attack demo, added gateway security tests (pipeline, approval, API), restricted Control API CORS and origin checks.
- Files materially changed: `packages/gateway/src/storage.ts`, `packages/gateway/src/api/control.ts`, `examples/secret-exfiltration/demo.mjs`, `packages/gateway/tests/*`.
- Verification performed: E2E attack demo successfully spawns gateway, issues malicious tool call, blocks it, and verifies the hash chain. All workspace tests passing.
- Verification result: PASS
- Known limitations: Control Center UI is view-only for policies; no replay yet.
- Unresolved questions: None.
- Exact next action: Proceed to Milestone 2 (Documentation, CI, and GitHub push).
