# AgentGate Decision Ledger

This file is the durable source of truth for architectural and product
decisions across AI-agent sessions. Verify entries against the repository.

## Project State

- Current phase: Milestone 1 Execution
- Current branch: main
- Last verified commit: N/A
- Last updated: 2026-08-20
- Updated by: Antigravity
- Next action: Implement Shared Contracts (packages/protocol)

## Active Decisions

### ADR-0001: Initial Architecture and Stack

- Status: ACCEPTED
- Date: 2026-08-20
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

- Status: ACCEPTED
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
- Superseded by: NONE

### ADR-0003: Policy and Identity Model

- Status: ACCEPTED
- Date: 2026-08-20
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

## Superseded Decisions

## Session Log

### 2026-08-20 — Antigravity - Repository Bootstrap

- Prompt objective: Initialize repository and seed decision ledger.
- Decisions added or changed: ADR-0001, ADR-0002, ADR-0003
- Implementation completed: Monorepo foundation files created.
- Files materially changed: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`, `.gitignore`, `docs/AI_DECISIONS.md`.
- Verification performed: Verified file creation.
- Verification result: PASS
- Known limitations: None yet.
- Unresolved questions: None.
- Exact next action: Initialize packages/protocol.
