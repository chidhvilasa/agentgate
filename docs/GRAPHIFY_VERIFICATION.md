# Graphify Verification

This document records a real, executed verification of [Graphify](https://github.com/safishamsi/graphify) against the
AgentGate codebase, performed as part of Milestone 2. Graphify is an **optional local developer tool** — it is not a
runtime dependency of AgentGate and nothing in `packages/` or `apps/` imports it. Its generated output lives entirely
in the untracked `graphify-out/` directory (see [`.gitignore`](../.gitignore)).

## Executable and version

| Item | Value |
|---|---|
| Resolved executable | `graphify` on `PATH` (also directly reachable at `%USERPROFILE%\.local\bin\graphify.EXE` on the machine this verification was run on) |
| Version | `graphify 0.9.48` |
| Install manager | [`uv`](https://github.com/astral-sh/uv) tool install (`graphifyy` PyPI package) |
| Project skill | `.claude/skills/graphify/SKILL.md` (readable, present) |
| Project settings | `.claude/settings.json` — `PreToolUse` hooks route `Bash`/`Grep` through `graphify hook-guard search` and `Read`/`Glob` through `graphify hook-guard read` |
| Hook/executable match | Consistent — `.claude/settings.json` points at the same `graphify.EXE` resolved above |

```text
$ graphify --version
graphify 0.9.48

$ graphify hook status
post-commit: not installed
post-checkout: not installed
merge driver: not registered
```

No post-commit/post-checkout hook or merge driver is installed for this repository. Only the Claude Code
`PreToolUse` search/read hooks are active (project-local, in `.claude/settings.json`, untracked — see
[Local/untracked artifact policy](#localuntracked-artifact-policy) below).

## Graph build (code-only, no API key)

AgentGate's corpus is TypeScript/JavaScript source plus a handful of Markdown docs. To stay strictly in the
"code-only, no LLM" path described by the skill (`graphify update <path>` — *"re-extract code files... no LLM
needed"*), the graph was built directly from the CLI rather than through the full interactive semantic-extraction
pipeline, which would otherwise dispatch subagents to summarize the Markdown files. No `GEMINI_API_KEY` /
`GOOGLE_API_KEY` was set, none was requested, and no Anthropic key was ever read by Graphify (per the skill's own
"Honesty Rules" and the "no API key" guarantee for code corpora).

```text
$ graphify update . --no-cluster
Re-extracting code files in . (no LLM needed)...
[graphify watch] Rebuilt (no clustering): 511 nodes, 721 edges
[graphify watch] graph.json updated in graphify-out
Code graph updated. For doc/paper/image changes run /graphify --update in your AI assistant.
Tip: set GEMINI_API_KEY or GOOGLE_API_KEY to use Gemini for semantic extraction.

$ graphify cluster-only . --no-label
Loading existing graph...
Graph: 511 nodes, 624 edges
Re-clustering...
Done - 38 communities. GRAPH_REPORT.md, graph.json and graph.html updated.
```

`--no-label` was used so community naming also stayed local (Louvain clustering via NetworkX/graspologic, no LLM
call for labels — communities are numbered `Community 0`, `Community 1`, ... rather than given plain-language
names).

### Generated outputs

| File | Present |
|---|---|
| `graphify-out/graph.json` | ✅ (511 nodes, 624 edges, 38 communities) |
| `graphify-out/GRAPH_REPORT.md` | ✅ |
| `graphify-out/graph.html` | ✅ (interactive visualization) |
| `graphify-out/wiki/index.md` | Not generated — the `--wiki` export was skipped; it is meant for onboarding a large multi-doc corpus and adds one file per community, which is not a good trade for AgentGate's small, single-purpose codebase. Can be produced on demand with `graphify export wiki` if ever needed. |

### Observed graph quality (from `GRAPH_REPORT.md`)

**God nodes (most-connected — the real architectural hubs):**

1. `AuditStorage` — 31 edges (`packages/gateway/src/storage.ts`)
2. `ApprovalManager` — 16 edges (`packages/gateway/src/approval.ts`)
3. `runPipeline()` — 9 edges (`packages/gateway/src/pipeline.ts`)

This matches the real design: the audit store and the approval manager are the two objects nearly everything else
in the gateway depends on, and `runPipeline()` is the single function every tool call passes through.

**Surprising connections (all independently verified against source):**

- `Timeline()` → `openEventStream()` (`apps/control-center/src/pages/Timeline.tsx` → `apps/control-center/src/api.ts`) — the live SSE subscription.
- `startStdioProxy()` → `buildAgentIdentity()` (`packages/gateway/src/transport/stdio.ts` → `packages/gateway/src/agent-identity.ts`) — untrusted identity is built per tool call, not per connection.
- `startGateway()` → `buildControlApi()` (`packages/gateway/src/server.ts` → `packages/gateway/src/api/control.ts`).
- `ApprovalManager` → `AuditStorage`, `PipelineContext` → `ApprovalManager` — the dependency chain the approval flow runs through.

Every one of these edges was cross-checked by reading the referenced source file directly; all five were accurate.

## Query smoke tests

Four AgentGate-specific questions were run with `graphify query "<question>"` (BFS, default depth/budget):

| Question | Result |
|---|---|
| *How does an MCP tool call flow from stdio through policy evaluation to audit storage?* | Found `Policy`, `ToolCall`, `AuditStorage`, `EvaluationInput`, `stdio.ts`, `storage.ts` — the right cast of types, but shallow (depth-2 BFS did not surface the connecting edges) and included one irrelevant hit from a `tsconfig.json` flag name (`noFallthroughCasesInSwitch`) matched on the word "switch". Useful as a *starting point*, not a complete answer on its own. |
| *Where is secret redaction applied before persistence?* | **Directly useful.** Correctly located `detectSecrets()`, `redactSecrets()`, `redactField()`, `redactArgumentsForAudit()` in `packages/policy/src/transformation.ts`, plus every real caller (`engine.ts`, `transformation.test.ts`) and the `SECRET_PATTERNS` node — all confirmed against source. |
| *How do approval lifecycle transitions reach the Control Center?* | **Directly useful.** Surfaced `ApprovalManager`, the `storage.ts` approval methods (`insertApproval`, `resolveApproval`, `listPendingApprovals`, `expireStaleApprovals`), `apps/control-center/src/pages/Approvals.tsx`, and `openEventStream()`/SSE in `api.ts` — correctly spans backend and frontend. Truncated at the 2000-token default budget (108 nodes found); raising `--budget` or narrowing with `context_filter` would show the rest. |
| *What protects and verifies the append-only audit lifecycle chain?* | **Directly useful.** Correctly found `appendLifecycleRecord()`, `verifyChain()`, `canonicalize()`, `sha256()`, and the audit-related ADR-0004 entry in `docs/AI_DECISIONS.md`. |

**Verdict: 3 of 4 queries returned directly usable, source-accurate results; the fourth (broad "flow" question)
returned the right vocabulary but needed a follow-up `path`/`explain` call to become a real trace** — expected for a
BFS over a "flow" question that spans three packages, and exactly what `graphify path`/`graphify explain` are for.

## Path test (concrete relationship)

```text
$ graphify path "runPipeline()" "AuditStorage" --undirected
Shortest path (2 hops):
  runPipeline() <--contains [EXTRACTED]-- pipeline.ts --imports [EXTRACTED]--> AuditStorage
```

Accurate: `runPipeline()` is defined in `pipeline.ts`, which imports the `AuditStorage` type from `./storage.js`.
(The graph was built undirected — `graphify path` defaults to directed traversal and needs `--undirected` explicitly
to match; documented here so a future run does not appear to fail.)

## Incremental update test

This was run twice in this session, deliberately, to demonstrate the tool tracks real changes rather than being
run once for show:

**First pass**, after the Milestone 2 documentation and CI/community files were added but before the Control
Center bugs below were found:

```text
$ graphify update .
Re-extracting code files in . (no LLM needed)...
[graphify watch] Rebuilt: 698 nodes, 831 edges, 48 communities
```

**Second pass**, after the `Overview.tsx`/`Timeline.tsx`/`EventDetail.tsx` decision-badge and routing fixes,
`docs/AI_DECISIONS.md`/`CHANGELOG.md` updates, and the `security.yml` allowlist fix described in the session log:

```text
$ graphify update .
Re-extracting code files in . (no LLM needed)...
[graphify watch] Rebuilt: 702 nodes, 835 edges, 47 communities
[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out
Code graph updated. For doc/paper/image changes run /graphify --update in your AI assistant.
```

511 → 698 → 702 nodes and 721 → 831 → 835 edges across the two passes, reflecting first the new Markdown docs and
`.github/` files, then the further Control Center/ledger edits. A follow-up `graphify query "How does the
Timeline page color a denied event badge?"` after the second pass correctly returned `Timeline.tsx`'s
`statusClass()` node at its new line number (moved by the fix) alongside `Overview.tsx`'s updated
`react-router-dom` import — confirming the incremental update reflects the actual code changes rather than a
stale graph. (See the Milestone 2 session log entry in `docs/AI_DECISIONS.md` for full details.)

## Hook status

No post-commit hook, post-checkout hook, or git merge driver is installed (`graphify hook status` — see above).
The only active integration is the Claude Code `PreToolUse` search/read guard in `.claude/settings.json`, which is
local tooling configuration, not a repository artifact.

## Local/untracked artifact policy

- `graphify-out/` is **derived, regenerable output** (`graphify update .` rebuilds it in seconds, no API key) and is
  now excluded via `.gitignore`. It is not committed.
- `.claude/` (skill files, settings, hooks) and the root `CLAUDE.md` are a **separate, pre-existing local
  installation** of the Graphify Claude Code skill, unrelated to this AgentGate session's work. They remain
  untracked, per the project's explicit instruction to preserve but not adopt them into the repository.
- No Graphify source-integration files were added to `.gitignore` broadly — only the generated `graphify-out/`
  directory.

## Limitations observed

- Broad "how does X flow through Y and Z" questions need `graphify path`/`graphify explain` (or a larger
  `--budget`) to become a complete trace; a single default-depth `query` call gives the right vocabulary but not
  always the connecting edges.
- The default 2000-token query budget truncates on medium-sized questions that span two packages (frontend +
  backend) — both truncated queries above still returned correct, on-topic results before the cutoff.
- `graphify path` defaults to directed traversal; this graph was built undirected, so `--undirected` is required.
- Community labels are numeric (`Community 0`, ...) rather than plain-language, since `--no-label` was used to
  avoid any LLM call — acceptable for internal navigation, less useful for a first-time reader browsing
  `GRAPH_REPORT.md` directly.
- One community-8 surprising-connection pass matched an unrelated TypeScript compiler flag
  (`noFallthroughCasesInSwitch` in `apps/control-center/tsconfig.app.json`) purely on the substring "switch" —
  a reminder that graph results should be spot-checked against source, which is exactly what this document does.

## Conclusion

Graphify is genuinely functional against AgentGate: it builds a 511-node, 624-edge graph from this repository in
seconds with no API key, its god-node and surprising-connection analysis independently rediscovers the real
architectural hubs, three of four targeted queries returned directly useful and source-accurate answers, the
`path` command produced a correct 2-hop trace, and an incremental `update` after further code changes reflected
those changes. It is adopted as **optional local developer tooling** (see `docs/DEVELOPMENT.md`), not a build or
CI dependency.
