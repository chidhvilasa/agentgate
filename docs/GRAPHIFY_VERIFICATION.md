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

## Milestone 3 incremental update (2026-08-24)

After implementing bidirectional output/error sanitization (ADR-0009), `graphify update .` was re-run:

```text
$ graphify update .
Re-extracting code files in . (no LLM needed)...
[graphify watch] Rebuilt: 813 nodes, 987 edges, 54 communities
[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out
```

702 → 813 nodes and 835 → 987 edges (the Milestone 2 baseline recorded at the end of the previous section),
reflecting the two new source modules (`packages/policy/src/output-sanitization.ts`,
`packages/gateway/src/output-security.ts`), the new test/fixture files, and the new
`examples/downstream-secret-result/` demo.

**Queries** (all outputs cross-checked against source):

| Question | Result |
|---|---|
| *Where are downstream MCP results sanitized before they reach the upstream client?* | **Directly useful.** Correctly surfaced `sanitizeToolResult()` (`packages/gateway/src/output-security.ts:120` — confirmed against source), plus `sanitizeContentBlock()`, `sanitizeTextLeaf()`, `sanitizeJsonValue()`, `sanitizeErrorMessage()`, and `OutputSecurityConfig`. |
| *How does EventDetail display result redaction and blocking metadata?* | Useful but structural-only: correctly found `EventDetail.tsx --contains--> statusClass()`, the `App.tsx --imports_from--> EventDetail.tsx` routing edge, and (separately in the result set) `pipeline.ts --imports--> sanitizeToolResult()`. It does **not** surface the new conditional JSX ("Result Security" card) itself — the AST extraction does not parse into JSX conditional-render bodies, a known, pre-existing limitation (see below), not a Milestone 3 regression. |
| *How are downstream execution errors sanitized before audit persistence?* | Useful vocabulary (`sanitizeErrorMessage()`, `.updateEventStatus()`, `runPipeline()`, `stdio.ts`) but, consistent with the Milestone 2 finding, a broad "flow" question needed the `path` follow-up below to become a full trace rather than a single query call. |

**Path test**: `graphify path "sanitizeToolResult()" "EventDetail.tsx" --undirected` returned **no path** — an
honest, structurally-correct negative result, not a graph defect. Control Center (`apps/control-center`) and the
gateway/policy packages communicate only over HTTP/SSE at runtime; there is no static import or call edge
between them anywhere in this codebase (confirmed independently: `grep -rn "@agentgate/protocol"
apps/control-center/src/` finds zero real imports, only one comment). This is a genuine, pre-existing limitation
of an AST-only graph for any full-stack app with a network boundary between frontend and backend — not specific
to output security. A connectable, real path was confirmed instead:

```text
$ graphify path "sanitizeToolResult()" "storage.ts" --undirected
Shortest path (2 hops):
  sanitizeToolResult() <--imports [EXTRACTED]-- pipeline.ts --imports_from [EXTRACTED]--> storage.ts
```

Accurate: `pipeline.ts` imports `sanitizeToolResult` from `output-security.ts` and the `AuditStorage` type from
`storage.ts`, exactly as the path states.

## Milestone 4 incremental update (2026-08-24) — Safe Replay

After implementing Safe Replay (ADR-0010), `graphify update .` was re-run:

```text
$ graphify update .
Re-extracting code files in . (no LLM needed)...
[graphify watch] backed up curated graph (5 files) -> 2026-08-24/
[graphify watch] Rebuilt: 903 nodes, 1135 edges, 54 communities
[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out
```

813 → 903 nodes and 987 → 1135 edges (the Milestone 3 baseline recorded above), reflecting the new
`packages/gateway/src/replay.ts`, `packages/policy/src/digest.ts`, the four new replay test files, the new
`SafeReplayCard` component, and the new `examples/policy-drift-replay/` demo.

**Orientation query** (all outputs cross-checked against source):

| Question | Result |
|---|---|
| *How does the Safe Replay API route reach the policy engine?* | Directly useful, correctly scoped: surfaced `replay.ts`, `evaluateHistoricalEvent()`, `buildEvaluationInput()`, `assertReplayable()`, `boundedLimitation()`, `control.ts`, `cli.ts`, `engine.ts`, `evaluate()`, `normalizePath()`, `ruleMatches()`, `EvaluationInput`, and the new `ReplayComparison`/`ReplayDecisionSummary`/`ReplayCurrentDecisionSummary` types — a materially smaller, more targeted result set than reading `pipeline.ts`/`replay.ts`/`engine.ts` in full would require, confirming the tool's stated value proposition for this codebase. |

**Path tests** (all cross-checked against source, both confirming and disconfirming results reported honestly):

1. `graphify path "control.ts" "evaluateHistoricalEvent"` → **1 hop**, `control.ts --imports--> evaluateHistoricalEvent()`. Accurate — the Control API route directly calls this function.
2. `graphify path "EventDetail.tsx" "control.ts"` (and `--undirected`) → **no path**. Consistent with the Milestone 3 finding: Control Center and the gateway communicate only over HTTP, no static edge.
3. `graphify path "replay.ts" "executeDownstream"` → reported a **2-hop path**: `replay.ts --imports_from--> pipeline.ts --contains--> executeDownstream()`. Likewise `graphify path "replay.ts" "ApprovalManager"` → `replay.ts --imports_from--> pipeline.ts --imports--> ApprovalManager`. **These are misleading at face value and were verified against source before being trusted**: `grep -n "^import" packages/gateway/src/replay.ts` shows `replay.ts`'s only relative import is `import { extractPrimaryPath, extractCommand, extractHost } from './pipeline.js'` — never `executeDownstream` or `ApprovalManager`. Graphify's `imports_from`/`contains` edges are **file-level**, not per-named-export: it records only "this file imports *something* from that file," and separately "that file *contains* this symbol," which composes into a misleading transitive "path" whenever the source file happens to also contain unrelated, non-imported symbols. **This is a real, newly-confirmed limitation of the graph's granularity, not evidence against the no-execution invariant** — the actual proof that `replay.ts` cannot reach `executeDownstream()` or `ApprovalManager` is the dedicated structural test (`packages/gateway/tests/replay-no-execution.test.ts`), which parses only the file's real `import` statement lines, not file-level graph edges. **No code or claim was changed based on the graph's path result** — it was checked against source first, exactly as this document's own methodology requires, and found to be a graph limitation rather than an actual connection.
4. `graphify path "replay.ts" "evaluate()" --undirected` → **no path found**, despite `replay.ts` genuinely importing `evaluate` from `@agentgate/policy` (`import { evaluate, normalizePath, computePolicyDigest, ... } from '@agentgate/policy'`). Sanity-checked against `pipeline.ts`, which imports `evaluate` the identical way and *also* shows no path — confirming this is a **general Graphify limitation with cross-workspace-package imports** (`@agentgate/policy`, a pnpm workspace alias resolved via package name, not a relative path), not specific to `replay.ts` or a regression. The AST extractor evidently does not resolve package-name imports into graph edges the way it resolves relative (`./pipeline.js`-style) imports. This is a new, distinct limitation from the already-documented frontend/backend HTTP-boundary gap (#2 above) — recorded here as its own finding since it applies within a single Node process, not just across a network boundary.

**Net assessment for the "no-execution separation" requirement**: Graphify's path queries alone are **not** sufficient to prove or disprove the no-execution invariant, for two independent reasons found this session (file-level edge granularity producing false-positive-looking paths; no edges at all for cross-package imports producing false-negative-looking gaps). The actual, trustworthy proof of separation is the dedicated automated test that reads `replay.ts`'s real import statements plus an executable fixture-counter test — both already relied upon as the actual evidence in `docs/VERIFICATION.md` and `docs/AI_DECISIONS.md` (ADR-0010), never the graph. Graphify remains valuable here for *orientation* (query #1 above) and for confirming *known* architectural boundaries (#2), just not as a source of truth for a fine-grained security guarantee.

## Milestone 5 incremental update (2026-08-25) — Onboarding CLI

After implementing the onboarding CLI (`init`/`config validate`/`doctor`/`integrate`/`smoke-test`, ADR-0011),
`graphify update .` was re-run:

```text
$ graphify update .
Re-extracting code files in . (no LLM needed)...
[graphify watch] Rebuilt: 1017 nodes, 1322 edges, 69 communities
[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out
```

903 → 1017 nodes and 1135 → 1322 edges (the Milestone 4 baseline recorded above), reflecting the five new
`packages/gateway/src/onboarding/*.ts` modules, the new fixture, `scripts/copy-assets.mjs`,
`scripts/verify-packed-install.mjs`, and six new test files.

**Orientation query** (cross-checked against source): *"how do the onboarding CLI commands init, config
validate, doctor, integrate, and smoke-test work"* → correctly surfaced every real function in all five modules
(`runInit`, `buildConfigTemplate`, `buildPolicyTemplate`, `validateConfigFile`, `runDoctor` and its dozen
per-check helper functions, `buildIntegration`, `applyIntegration`, `runSmokeTest`, `fixtureServerPath`), plus
the correct shared dependencies (`loadGatewayConfig`, `AuditStorage`, `runPipeline`, `readSchemaVersionReadOnly`)
— a materially smaller, correctly-scoped result set versus reading all five files in full.

**Path tests** (all cross-checked against source, per this document's established methodology):

1. `graphify path "configValidate.ts" "loadGatewayConfig"` and `graphify path "doctor.ts" "loadGatewayConfig"`
   → both **1 hop**, `--imports-->`. Confirmed accurate: `grep -n "^import"` on both files shows each genuinely
   imports `loadGatewayConfig` from `../config/registry.js` directly — proving, not just claiming, that neither
   command duplicates config-parsing logic (ADR-0011 point 3).
2. `graphify path "doctor.ts" "executeDownstream"`, `graphify path "integrate.ts" "executeDownstream"`, and
   `graphify path "doctor.ts" "runPipeline"` → **no path found** for all three (directed, and this time genuinely
   absent even as a misleading file-level artifact, unlike the Milestone 4 `replay.ts`/`pipeline.ts` case —
   because `doctor.ts` and `integrate.ts` import *nothing* from `pipeline.ts` at all, so there is no file-level
   edge for a contained symbol to piggyback on). Confirmed accurate: both files' full import lists (checked via
   `grep -n "^import"`) contain only Node builtins and this project's own non-execution modules.
3. `graphify path "smokeTest.ts" "runPipeline"` → **1 hop**, `--imports-->` — a genuine, expected, positive
   result: `smoke-test` *does* legitimately call `runPipeline()`, unlike `doctor`/`integrate`. What matters is
   *what it's configured with*, which a static graph edge cannot show — confirmed by reading `smokeTest.ts`'s own
   `GatewayConfig` construction directly: its one `servers` entry always points at `fixtureServerPath()`
   (`packages/gateway/src/onboarding/smokeFixtureServer.mjs`), never a user-supplied path.
4. `graphify path "smokeTest.ts" "fixtureServerPath"` → **1 hop**, `--contains-->`, accurate (it's a function
   defined in the same file).

**Net assessment**: this session's four path queries all produced results confirmed accurate against source —
the two "no path" results genuinely reflect zero relevant imports (not the file-level-granularity false
positive documented in Milestone 4), and the two "real path" results are legitimate, intended connections
whose safety depends on *configuration* (verified by reading source), not on the mere existence of the call
edge itself — exactly the same caveat this document has carried since Milestone 4's findings.

## Milestone 6 incremental update (2026-08-25) — Tool Integrity Registry and Rug-Pull Defense

After implementing the Tool Integrity Registry (ADR-0012: `packages/gateway/src/tool-integrity/*`, the six new
`agentgate tools` CLI subcommands, seven new Control API routes, the Control Center's `ToolIntegrity.tsx` page,
and `examples/tool-rug-pull/demo.mjs`), `graphify update .` was re-run:

```text
$ graphify update .
Re-extracting code files in . (no LLM needed)...
  AST extraction: 101/101 uncached files (100%) [22 workers]
[graphify watch] Rebuilt: 1218 nodes, 1744 edges, 85 communities
[graphify watch] graph.json, graph.html and GRAPH_REPORT.md updated in graphify-out
```

1017 → 1218 nodes and 1322 → 1744 edges (the Milestone 5 baseline recorded above), reflecting the eight new
`tool-integrity/*.ts` modules, the CLI/Control API/Control Center additions, the rug-pull demo and its dynamic
fixture server, and eleven new test files.

**Required verification queries** (per the governing prompt, each cross-checked against source):

1. *"how does tool discovery flow from canonicalization to fingerprint to registry"* → correctly surfaced
   `scan.ts`, `canonicalize.ts` (`canonicalizeToolDefinition()`/`canonicalizeManifest()`), `registry.ts`
   (`applyScanToRegistry()`), `storage.ts`, and the relevant test files as the top-connected nodes — an accurate,
   scoped orientation to the real discovery→fingerprint→registry pipeline.
2. *"how does upstream tool list filtering and direct call quarantine enforcement work in the gateway"* →
   surfaced `startStdioProxy() --calls--> applyScanToRegistry()` (confirmed accurate: `stdio.ts:L61`) directly,
   but did not surface `filterTrustedTools()`/`checkCallAllowed()` as edges within the query's token budget
   (both exist as separate, real edges — see the targeted `graphify explain` follow-up below, which found them).
3. `graphify explain "filterTrustedTools"` and `graphify explain "checkCallAllowed"` → both correctly show
   `startStdioProxy() --calls--> filterTrustedTools()` at `stdio.ts:L90` and
   `startStdioProxy() --calls--> checkCallAllowed()` at `stdio.ts:L104`. **Cross-checked directly against
   source** (`sed -n '85,108p' packages/gateway/src/transport/stdio.ts`): both line numbers and call sites match
   exactly — `filterTrustedTools()` is called inside the `ListToolsRequestSchema` handler (attributed to the
   enclosing `startStdioProxy()` function, which is correct AST-level attribution since the handler is an inline
   closure, not a separately named function) and `checkCallAllowed()` inside the `CallToolRequestSchema` handler,
   exactly as ADR-0012 describes.
4. *"Control Center Tool Integrity page calling the Control API accept and reject routes with exact
   fingerprint"* → correctly surfaced `apps/control-center/src/api.ts`, `ToolIntegrity.tsx`, `control.ts`,
   `acceptCandidate()`, and `rejectCandidate()` all in the same result set, confirming the graph does connect
   the Control Center → Control API → registry path at the file/community level.
5. `graphify path "src/cli.ts" "tool-integrity/registry.ts"` → **2 hops**:
   `src/cli.ts --dynamic_import--> tool-integrity/cli.ts --imports_from--> tool-integrity/registry.ts`.
   **Confirmed accurate**: `cli.ts`'s `tools` command handler does `import('./tool-integrity/cli.js')`
   (dynamic import, matching the established lazy-load pattern already used for every other CLI subcommand in
   this codebase), and `tool-integrity/cli.ts` does statically `import { ... } from './registry.js'`.

**New false-path/coverage-gap findings this milestone** (both cross-checked against source, both confirmed to be
the SAME class of pre-existing extractor limitation already documented in Milestones 4–5, not new defects):

1. `graphify explain "toolIntegrityAccept"` → **"No node matching found."** `toolIntegrityAccept` (and every
   other `api.ts` client method added this milestone — `toolIntegritySummary`, `toolIntegrityDiff`, etc.) is
   defined as an arrow-function VALUE inside an object literal (`export const api = { toolIntegrityAccept:
   (candidateId, fingerprint) => ... }`), not a standalone named function declaration. **Verified this is a
   pre-existing, systemic limitation, not new**: `graphify explain "replay"` (the Milestone 4 `api.replay`
   method, defined identically) returns 8 AMBIGUOUS matches across other files but never the `api.ts` method
   itself either — confirming the AST extractor does not attribute object-literal arrow-function properties as
   distinct callable nodes, for old code and new code alike.
2. `graphify explain "bumpCallCounter"` (rug-pull fixture) → shows only a `contains` edge (degree 1), missing
   the real call edge from the `CallToolRequestSchema` inline handler that actually invokes it on every real
   tool call. **Verified this is the same class of limitation**: the call site is inside an anonymous arrow
   function passed directly as a `server.setRequestHandler(...)` argument, not a named function — the extractor
   does not attribute calls made from an inline/anonymous callback body to a symbol. The real, correct behavior
   (the counter increments exactly once per real `read_file` call and never during discovery) is independently
   proven by the passing executable tests and the rug-pull demo's own counter assertions
   (`tests/tool-integrity-gateway-enforcement.test.ts`, `examples/tool-rug-pull/demo.mjs`), not by the graph.

**Net assessment**: every query and path test this milestone was cross-checked against real source before being
trusted. Two genuine positive results were confirmed byte-accurate against source (`filterTrustedTools()`/
`checkCallAllowed()` call sites, the CLI→registry dynamic-import path). Two coverage gaps were found and both
confirmed to be instances of an already-documented limitation class (object-literal/inline-callback function
attribution), not new tool defects or new blind spots specific to Tool Integrity — no source change was made
solely because Graphify reported (or failed to report) a path without independently confirming it first.

## Milestone 7 incremental update (2026-08-28) — Context Guard cross-tool escalation defense

**Command run**: `graphify update .` (the direct CLI, per this project's `CLAUDE.md` — AST-only, no API key, no
LLM cost). Result: `AST extraction: 126/126 uncached files (100%)`, graph rebuilt to **1514 nodes, 2409 edges,
104 communities** (up from 1218 nodes/1744 edges/85 communities at the end of Milestone 6), `graph.json`/
`graph.html`/`GRAPH_REPORT.md` all regenerated. A prior curated-label backup was written to
`graphify-out/2026-08-28/` automatically, per graphify's own community-label-drift handling.

**Scope decision, stated explicitly**: this session ran the AST (code) re-index via the direct CLI, which
requires no LLM/subagent dispatch and genuinely re-extracted every changed `.ts`/`.tsx`/`.mjs` file this
milestone touched. It did **not** additionally dispatch subagents for semantic (LLM-based) re-extraction of the
changed Markdown documentation files (`README.md`, `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`,
`docs/POLICY_REFERENCE.md`, `docs/VERIFICATION.md`, `docs/DEVELOPMENT.md`, `docs/TROUBLESHOOTING.md`,
`CHANGELOG.md`, `docs/AI_DECISIONS.md`) — a deliberate scope decision given the significant additional
subagent-dispatch cost for a milestone whose verification-relevant queries below are entirely about *code*
relationships (which the AST pass covers completely), not doc-node semantic edges. This is a real, named gap in
this session's re-index, not a silent omission: the doc *nodes* in the graph for these 9 files still reflect
their pre-Milestone-7 semantic extraction (their content on disk has since changed) until a future `/graphify
--update` session dispatches subagents for them.

**Orientation/verification queries run against the freshly AST-updated graph, each manually cross-checked
against source before being trusted** (all of `runPipeline()`'s exact call-site line numbers below were
independently confirmed by direct source reading earlier in this same session, before running any query — the
graph's answers were checked against that reading, not the other way around):

1. `graphify explain "evaluateContextGuard"` → `runPipeline() [calls] pipeline.ts:L205`, imported from
   `context-guard/enforcement.ts:L20`. **Confirmed accurate**: `pipeline.ts` line 205 is exactly
   `const cgEvaluation = evaluateContextGuard(ctx.storage, contextGuardConfig, ctx.contextId, toolName);` —
   proving the graph correctly captures the Tool-Integrity-gate-then-Context-Guard-evaluation ordering point in
   the real request path (Tool Integrity's `checkCallAllowed()` gate runs earlier, in `transport/stdio.ts`,
   outside `runPipeline()` entirely — by design, per ADR-0013 point 9 — so no single-file graph edge captures
   the FULL "stdio → Tool Integrity → pipeline → Context Guard" chain in one hop; this is an accurate reflection
   of the real code structure, not a graph gap).
2. `graphify explain "checkApprovalContextValid"` → `runPipeline() [calls] pipeline.ts:L326`. **Confirmed
   accurate** against the exact same line read directly in source this session: the consumption-time
   revalidation call site, immediately after a human APPROVED decision is observed.
3. `graphify explain "appendContextLabels"` → `runPipeline() [calls] pipeline.ts:L410`. **Confirmed accurate**:
   line 410 is exactly the label-append call inside pipeline step 8's `if (contextGuardConfig.mode !== 'disabled'
   && finalStatus === 'SUCCEEDED' && !resultBlocked)` block — correctly capturing the downstream-result →
   result-safety → context-label-transition path's real call site and its outcome-gating condition.
4. `graphify explain "summarizeContexts"` → `buildControlApi() [calls] control.ts:L558`; `runContextStatus()
   [calls] context-guard/cli.ts:L289`. **Confirmed accurate**: this is the exact shared-function pattern ADR-0013
   documents — the same `summarizeContexts()` reused by both the CLI (`runContextStatus`) and the Control API
   (`buildControlApi`'s `GET /api/contexts` route), never two independent implementations — visible directly in
   the graph's own connection list without needing to separately query each caller.
5. `graphify explain "openEventStream"` → `ContextGuard() [calls] ContextGuard.tsx:L522`; `Timeline() [calls]
   Timeline.tsx:L35`; imported by both `ContextGuard.tsx:L3` and `Timeline.tsx:L3`. **Confirmed accurate**: the
   new Context Guard page's SSE subscription correctly resolves to the exact same pre-existing
   `openEventStream()` function `Timeline.tsx` already used — proving the graph captured that this milestone's
   `context_event` frames ride the SAME stream/function as pre-existing `audit_event` traffic, not a second
   parallel one, matching ADR-0013's own stated design.
6. `graphify explain "bumpCallCounter"` (disambiguated to the new `examples/context-poisoning/fixtures/
   context-poisoning-fixture-server.mjs` node specifically) → `contains` edge only (degree 2: contains +
   one outbound call to `counterPath()`), no inbound `calls` edge from the `CallToolRequestSchema` handler that
   actually invokes it on every real tool call. **Verified this is the SAME class of limitation already
   documented in Milestone 6** (see above): the real call site is inside an anonymous callback passed to
   `server.setRequestHandler(...)`, which the AST extractor does not attribute to its enclosing symbol — not a
   new defect, not new to Context Guard's fixture specifically. The real, correct counter behavior is
   independently proven by the passing executable tests and the demo's own counter assertions (`context-guard-
   gateway-enforcement.test.ts`, `examples/context-poisoning/demo.mjs`), not by the graph.

**New false-positive finding this milestone**: `graphify path "apps/control-center/src/api.ts"
"packages/gateway/src/api/control.ts" --undirected` returned *"both resolved to the same node
'apps_control_center_src_api'"* — an entity-resolution collision where two genuinely different files (the
frontend API client and the backend Control API server) fuzzy-matched onto the same graph node because their
labels share the substring `api`. **Confirmed as a real (if narrow) entity-resolution limitation, not a data
error**: re-querying with the exact symbol name (`summarizeContexts`, above) resolved correctly and independently
confirmed the real Control-Center-to-Control-API relationship via each function's own accurate connection list —
so the underlying graph data was correct; only the loose file-path-label matching used by `path` for this
specific ambiguous pair produced a wrong resolution. Also newly observed: `graphify path "transport/stdio.ts"
"context-guard/enforcement.ts"` reported an ambiguous top-score source match and then "no path found" — accurate
in outcome (stdio.ts imports `context-guard/state.ts`, not `enforcement.ts`, directly; only `pipeline.ts` imports
`enforcement.ts` — confirmed against source), but the ambiguous-match warning itself is a symptom of the same
loose-label-matching behavior as the collision above, not a new distinct bug class.

**Net assessment**: six of six symbol-level `explain` queries this milestone returned results independently
confirmed byte-accurate against source read directly earlier in this same session (not queried first, then
rationalized). One already-documented limitation class (object-literal/inline-callback call attribution)
recurred for the new demo's fixture, exactly as predicted from the Milestone 6 characterization. One
narrow, newly-observed entity-resolution limitation (ambiguous substring-based file-path matching for `path`
queries specifically) was found, cross-checked, and confirmed not to reflect any actual error in the underlying
extracted graph data — only in how `path`'s loose label-matching resolves two similarly-named file paths. No
source change was made based on a graph result alone in either case.

## Milestone 8 incremental update (2026-08-28) — Public beta release candidate and verifiable supply chain

**Command run**: `graphify update .` (direct CLI, AST-only, no LLM/API key). Result: graph rebuilt to **1628
nodes, 2534 edges, 113 communities** (up from 1514 nodes/2409 edges/104 communities at the end of Milestone 7).
The re-index newly covers `scripts/*.mjs` release tooling added this milestone (previously-existing `scripts/`
files, e.g. `verify-packed-install.mjs`, were already indexed; the four new/extended scripts are now included
too), confirming Graphify's AST extraction is not limited to `packages/`/`apps/` — any `.ts`/`.tsx`/`.mjs` file
in the repository is in scope.

**Scope decision, stated explicitly, same as Milestone 7**: only the AST (code) pass was re-run; the changed
Markdown documentation (README.md, CHANGELOG.md, docs/AI_DECISIONS.md, docs/VERIFICATION.md,
docs/POLICY_REFERENCE.md, docs/DEVELOPMENT.md) was not separately re-extracted via an LLM/subagent pass, since
this milestone's verification queries are entirely about code relationships the AST pass already covers.

**Six independently-verified queries** (each cross-checked against source read directly in this same session,
not queried first and then rationalized):

1. `graphify explain "checkApprovalContextValid"` — reported `pipeline.ts` L20 import and `runPipeline()` L326
   call site. Confirmed byte-accurate: the actual call at `pipeline.ts:326` passes
   `(resolvedApproval, ctx.storage, toolName, argumentDigest, currentTrustedFingerprint)`, matching this
   milestone's fail-closed fingerprint fix exactly.
2. `graphify explain "buildConfigTemplate"` — reported the function at `init.ts` L86 and its call site inside
   `runInit()` at L162. Confirmed by direct read: `init.ts:162` is exactly
   `{ relativePath: CONFIG_FILE_NAME, content: buildConfigTemplate() }` — the line number correctly reflects the
   ~14-line shift from this milestone's `context_guard` block insertion, proving the re-index picked up the
   edit, not a stale cached position.
3. `graphify explain "checkReleaseConsistency"` — reported `scripts/check-release-consistency.mjs` L47 (function)
   and L51 (a call to `readPkg()`). Confirmed by direct `grep -n`: exact match on both line numbers.
4. `graphify explain "buildSbom"` — reported `scripts/generate-release-manifest.mjs` L112 (function) and L190
   (`main()`'s call site). Confirmed by direct `grep -n`: exact match on both line numbers.
5. `graphify explain "scanReleaseArtifacts"` — reported `scripts/scan-release-artifacts.mjs` L73 (function), an
   internal call to `scanDirRecursive()` at L76, and an import from the new test file at L8. Confirmed by direct
   `grep -n`: exact match on all three line numbers.
6. `graphify path "checkApprovalContextValid" "getTrustedFingerprint" --undirected` — reported a 2-hop path
   through `pipeline.ts` (both functions imported by the same file). Confirmed by direct read of `pipeline.ts`:
   it does import and use both `checkApprovalContextValid` (context-guard/enforcement.ts) and
   `getTrustedFingerprint` (tool-integrity/enforcement.ts) together at the exact call site this milestone's fix
   touches (an initial `--directed` query found no path, correctly reflecting that neither function calls the
   other directly — only `--undirected` surfaces the shared-importer relationship, which is the accurate
   structure, not a bug).

**Net assessment**: six of six queries this milestone returned results independently confirmed byte-accurate
against source, including one case (query 2) that specifically demonstrates the re-index correctly tracked a
mid-file line-number shift from an edit made earlier in this same session — evidence the graph reflects current,
not stale, file content. **No new false positive was found this milestone** (unlike Milestones 6–7, which each
surfaced one); this is reported as a genuine result, not manufactured to match the pattern of prior entries. This
does not mean Graphify's previously-documented limitation classes (object-literal/inline-callback call
attribution; ambiguous similarly-named-file `path` resolution; no cross-workspace-package import resolution) no
longer exist — they were simply not triggered by this milestone's specific queries, which targeted named function
symbols in single files rather than the patterns known to trigger those limitations.

## Conclusion

Graphify is genuinely functional against AgentGate: it builds a graph from this repository in seconds with no
API key (511 nodes at Milestone 1 → 702 at the end of Milestone 2 → 813 after Milestone 3 → 903 after Milestone
4 → 1017 after Milestone 5 → 1218 after Milestone 6 → 1514 after Milestone 7 → 1628 after Milestone 8's AST-only
re-indexes), its god-node and surprising-connection analysis independently rediscovers the real architectural
hubs, targeted queries consistently return directly useful and source-accurate vocabulary for orientation, `path`
produces correct traces for anything actually connected by a relative-import edge in source, and incremental
`update` calls after further code changes (now exercised eight times across seven milestones) reliably reflect
those changes. Its
limitations, confirmed across Milestones 4–7: it cannot trace a relationship with no static source-level edge at
all (a frontend/backend HTTP boundary, confirmed again); its `imports_from`/`contains` edges are file-level, not
per-named-export, which can produce a misleading transitive "path" between a file and a symbol the importing file
never actually imports; it does not resolve cross-workspace-package (`@agentgate/policy`-style) import edges the
way it resolves relative imports; `path`'s file-label matching can collide two similarly-named files onto the
same node for an ambiguous pair (newly observed in Milestone 7, resolved by re-querying with an exact symbol
name instead); and — newly characterized precisely in Milestone 6, though observed in earlier milestones too,
and reconfirmed recurring in Milestone 7 — it does not
attribute a call made from an object-literal arrow-function property or an anonymous inline callback body to its
enclosing symbol, undercounting real call edges for code written in that style (which this project uses for
both the Control Center's `api` client object and every MCP SDK `setRequestHandler(...)` callback). None of
these are tool defects in the sense of Graphify malfunctioning — they are the accurate behavior of an AST-only,
no-LLM-required tool, and every finding in this document was checked against real source before being trusted or
acted on. It remains adopted as **optional local developer tooling** (see `docs/DEVELOPMENT.md`), not a build or
CI dependency, and specifically **not** a substitute for the executable tests that actually prove Tool
Integrity's enforcement invariants (`tests/tool-integrity-gateway-enforcement.test.ts`,
`examples/tool-rug-pull/demo.mjs`), Safe Replay's no-execution invariant, or Context Guard's zero-contact/
stale-approval-revalidation invariants (`tests/context-guard-gateway-enforcement.test.ts`,
`examples/context-poisoning/demo.mjs`).
