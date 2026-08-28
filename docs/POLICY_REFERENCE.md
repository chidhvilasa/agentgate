# Policy Reference

This reference documents every field the policy schema actually accepts (`packages/policy/src/schema.ts`) and how
evaluation actually works (`packages/policy/src/engine.ts`). Nothing below is aspirational — if a field or command
is listed here, it exists in the code cited beside it.

## Schema version

```yaml
version: 1
```

Required. `1` is the only accepted value (`z.literal(1)`); any other value fails validation.

## Top-level shape

```yaml
version: 1
defaults:
  decision: deny        # applied when no rule matches
rules:
  - id: ...
    # ... matching fields ...
    decision: ...
    # ... decision-specific fields ...
```

- `defaults.decision` — defaults to `deny` if omitted entirely. This is the **secure default**: an empty or
  rule-less policy denies everything.
- `rules` — defaults to `[]` if omitted.

## Deterministic first-match semantics

Rules are evaluated **in the order they appear in the file**. The first rule whose match criteria are *all*
satisfied wins; evaluation stops there (`evaluate()` in `engine.ts`). If no rule matches, `defaults.decision` is
applied. There is no rule priority, weighting, or "most specific wins" behavior — order is the only thing that
determines precedence. Put more specific/restrictive rules before more general ones.

## Match fields

All match fields on a rule are combined with **AND** — every field you specify must match for the rule to apply.
Fields you omit are not checked (an absent field never excludes a match).

| Field | Type | Matches against | Notes |
|---|---|---|---|
| `agents` | `string[]` (glob) | the MCP client's **self-reported** `declared_name` | Untrusted signal — do not rely on this as a security boundary (see [`THREAT_MODEL.md`](THREAT_MODEL.md#forged--self-reported-agent-identity)). Empty/missing `declared_name` matches against `''`. |
| `tools` | `string[]` (glob) | the tool name as called | e.g. `"read_file"`, `"network.*"`. |
| `paths` | `string[]` (glob) | the normalized primary path argument | Only applies if the tool call has a recognized path-like argument (`path`, `file`, `filepath`, `file_path`, `directory`, or `dir`); a rule with `paths` set but no such argument present **never matches**. Supports `${PROJECT_ROOT}` expansion (see below). |
| `commands` | `string[]` (glob) | the normalized command string | Recognized argument keys: `command`, `cmd`, `shell`, `exec`. Same "no such argument → never matches" rule as `paths`. |
| `hosts` | `string[]` (glob) | the target host/URL | Recognized argument keys: `url`, `host`, `endpoint`, `uri`. If the value parses as a URL, its `hostname` is used; otherwise the raw string is matched. |
| `risk` | `("read"\|"write"\|"destructive"\|"network"\|"secret")[]` | *(accepted, not evaluated — see [Common mistakes](#common-mistakes))* | Descriptive tag only in this milestone. |
| `contains_secrets` | `boolean` | whether `detectSecrets()` finds a secret pattern in the flattened argument text | Only meaningful as `true`; `false`/omitted means "don't check". |

Glob matching uses [`micromatch`](https://github.com/micromatch/micromatch), case-insensitive on Windows
(`nocase: process.platform === 'win32'`), case-sensitive elsewhere.

## Path semantics

Paths are normalized before matching (`normalizePath()`):

1. Backslashes (`\`) are converted to forward slashes (`/`).
2. `.`/`..` segments are resolved via POSIX-style normalization (`path.posix.normalize`).
3. **No filesystem access and no symlink resolution** — this is purely lexical. A symlink pointing outside an
   allowed directory is not detected (see [`THREAT_MODEL.md`](THREAT_MODEL.md#path-traversal-and-normalization-mismatch)).

This makes path patterns portable across Windows and POSIX policy authors — always write patterns with forward
slashes (e.g. `${PROJECT_ROOT}/**`), regardless of the host OS.

`${PROJECT_ROOT}` in a `paths` pattern expands to `normalizePath(process.cwd())` — the **gateway process's own
working directory at evaluation time**, not a per-request value. Start the gateway from the directory you want
`${PROJECT_ROOT}` to mean.

## Secret detection behavior and limitations

`contains_secrets: true` and audit-record redaction both use the same pattern set
(`packages/policy/src/transformation.ts`, `SECRET_PATTERNS`): generic `api_key=`/`apikey=` assignments, `Bearer `
tokens, GitHub PATs (classic and fine-grained), OpenAI-style `sk-...` keys, Anthropic `sk-ant-...` keys, AWS access
key IDs (`AKIA...`) and secret keys, generic `password=`/`secret=`/`token=` assignments, PEM private-key headers,
and database connection strings with embedded credentials.

This is **pattern matching, not a secret scanner with entropy analysis** — it is intentionally conservative
("prefer false positives over false negatives," per the in-code comment) and will miss custom/internal secret
formats that don't match a known pattern. Redaction of matched secrets to persisted audit records happens
**unconditionally**, on every decision type, independent of whether `contains_secrets` is used anywhere in your
policy.

The same pattern set (and the same limitations) also protects the *outbound* direction — see
[Output security (gateway-level)](#output-security-gateway-level) below.

## Output security (gateway-level)

This is a **gateway config field, not a policy field** — it lives in your `agentgate.yml`/gateway config, not in a
policy rule, and applies uniformly to every downstream result regardless of which rule allowed the call. It is
unrelated to `allow_with_transform` above: `allow_with_transform` redacts *inbound arguments* before forwarding
them to the downstream server; `output_security` redacts (or blocks) the downstream *result* before forwarding it
back to the upstream client. See ADR-0009 in `docs/AI_DECISIONS.md` and
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#output-security-configuration) for the full design rationale.

Schema (`packages/gateway/src/config/registry.ts`, `OutputSecuritySchema`):

```yaml
output_security:
  mode: redact                        # "redact" | "block" — default "redact"
  opaque_content: allow_uninspected    # only this literal value validates today
  max_depth: 8                        # 1-20, default 8
  max_text_bytes: 1000000             # 1024-10000000, default 1000000
```

All fields are optional; omitting `output_security` entirely uses every default above. Zod rejects any other
`mode` value, any `opaque_content` value other than `allow_uninspected`, or an out-of-range `max_depth`/
`max_text_bytes` with a structured validation error at gateway startup (`loadGatewayConfig()`), the same way any
other malformed config field is rejected.

| Field | Type | Default | Behavior |
|---|---|---|---|
| `mode` | `"redact" \| "block"` | `redact` | `redact`: recognized secrets in inspectable content are replaced with `[REDACTED]`; the result is still returned. `block`: if a secret is detected in inspectable content, **or** a `max_depth`/`max_text_bytes` limit prevented full inspection of otherwise-inspectable text/structured content, the *entire* result is replaced with a protocol-valid AgentGate error (`isError: true`) that reveals no secret. |
| `opaque_content` | `"allow_uninspected"` | `allow_uninspected` | The only implemented behavior: MCP `image`/`audio` content and `EmbeddedResource` content with a `blob` field are base64 binary and are **never** regex-scanned or mutated, in either mode — this field exists to make that fixed behavior an explicit, self-documenting config value rather than an invisible hardcoded choice, not to offer a second behavior that doesn't exist yet. |
| `max_depth` | integer, 1–20 | `8` | Maximum object/array nesting actually inspected in `structuredContent`. A nested value beyond this depth is passed through **unchanged** (not silently dropped) and marked `not_inspected` internally; in `block` mode this counts as "could not be proven safe" and blocks the result. |
| `max_text_bytes` | integer, 1024–10,000,000 | `1,000,000` | Maximum UTF-8 byte length of a single string leaf actually scanned. An oversized string is passed through unchanged and, in `block` mode, blocks the result for the same reason as a depth-limit truncation. |

**What is inspected:** MCP `text` content, `EmbeddedResource` content with a `text` field, `resource_link`
string metadata (`uri`/`name`/`description`/`title`), and `structuredContent` (string leaves only — numbers,
booleans, and null are left untouched, and object keys are preserved).

**What is never inspected, in either mode:** `image`/`audio` content, `EmbeddedResource` content with a `blob`
field, unrecognized/future MCP content-block `type` values, the top-level `_meta` field (and per-content-block
`_meta`), and any top-level `CallToolResult` field beyond `content`/`structuredContent`/`isError`/`_meta`. These
all pass through completely unmodified — deterministic, and safe against future protocol additions AgentGate
doesn't yet understand, but also genuinely uninspected. See
[`docs/THREAT_MODEL.md`](THREAT_MODEL.md#malicious-downstream-mcp-server) for the security implications.

**Audit metadata**: `AuditEvent.result_redacted`/`result_blocked`/`result_finding_count` record what actually
happened — never the matched secret text or the raw result, which is never persisted regardless of `mode`.
`error_redacted` records whether a downstream/internal error message was modified by the same pattern set before
being persisted. See [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#audit-lifecycle-data-model).

**Interaction with false positives**: because this reuses the same conservative `SECRET_PATTERNS` as inbound
redaction, a benign string that happens to match a pattern (e.g. a long non-secret value following the word
`token`) will be redacted (or, in `block` mode, cause the whole result to be replaced) exactly as it would be for
inbound arguments. There is no per-tool or per-pattern exception list in this milestone; if a specific tool's
legitimate output regularly false-positives, the only mitigations today are switching that deployment to
`redact` mode (if not already) or accepting the redaction.

## Tool Integrity

This is also a **gateway config field, not a policy field** — rug-pull / tool-definition-poisoning defense (see
ADR-0012 in `docs/AI_DECISIONS.md` and [`docs/THREAT_MODEL.md`](THREAT_MODEL.md#tool-definition-poisoning-rug-pull-adr-0012)).
It governs whether a new or changed downstream tool *definition* is quarantined, independent of everything else
on this page, which governs individual tool *calls*.

Schema (`packages/gateway/src/config/registry.ts`, `ToolIntegritySchema`):

```yaml
tool_integrity:
  mode: explicit    # "explicit" | "tofu" | "monitor" | "disabled" — default "monitor" if omitted entirely
```

| Mode | Behavior | Recommended for |
|---|---|---|
| `explicit` | Every new or changed tool definition is quarantined (`pending_review`/`drifted`) until a human accepts its EXACT fingerprint via the CLI, Control API, or Control Center. Blocks both `tools/list` exposure and direct `tools/call` dispatch. | New projects — this is what `agentgate init` generates. High-security deployments. |
| `tofu` | A tool's first-ever observed definition is trusted automatically ("trust on first use"). Any LATER change to an already-trusted tool is still quarantined exactly like `explicit`. | A deployment that wants zero manual review for a server's initial tool set, but still wants drift blocked. |
| `monitor` | Drift is still detected, classified, and recorded (visible in `agentgate tools status`, the Control API, the Control Center) but **never blocks** discovery or calls. | **The default when `tool_integrity` is omitted.** Kept as the default specifically so a config file written before this feature existed keeps working, unmodified, with zero new blocking behavior on upgrade — see "Migration" below. Never described anywhere in this codebase as protection; it is reporting only. |
| `disabled` | The registry is not consulted for enforcement at all. Identical to every AgentGate version before this feature. | Backwards-compatibility only. Using this removes the defense entirely. |

**Migration**: if you have an existing `agentgate.yml` without a `tool_integrity` section, it already behaves as
`monitor` (no new blocking behavior) — you do not need to change anything for AgentGate to keep working exactly
as before. To adopt the recommended, blocking behavior, add:

```yaml
tool_integrity:
  mode: explicit
```

then run `agentgate tools scan --config agentgate.yml` followed by `agentgate tools status --config agentgate.yml`
to review and `agentgate tools trust <candidate-id> --fingerprint <hash> --config agentgate.yml` to accept each
currently-in-use tool's definition once, before restarting the gateway (a currently-untrusted tool is quarantined
immediately once `explicit`/`tofu` mode is active).

**What is fingerprinted**: the entire tool definition object as returned by the downstream server's `tools/list`
— every field present (`name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, and any
other field, known or unknown), not a hand-picked subset. Object keys are sorted before hashing (so re-ordering a
server's own JSON output never creates false drift); array order is preserved (so a real ordering change, e.g. in
`required`, does count as drift). A secret-shaped substring found anywhere in the definition is redacted before
hashing (reusing the same detector as [Output security](#output-security-gateway-level) above), which means a
change confined ENTIRELY to a redacted secret's own characters — with everything else byte-identical — would not
by itself change the fingerprint; this is a documented, narrow tradeoff, not an oversight.

**What annotations do and do not affect**: `readOnlyHint`/`destructiveHint`/etc. are stored and shown (they are
part of what gets fingerprinted, so a server changing them does count as drift), but they are **never consulted
by enforcement** to reduce risk — a server can't self-declare its way past quarantine by claiming to be
`readOnlyHint: true`.

**Reviewing and trusting/rejecting** always requires the EXACT `candidate_id` AND `fingerprint` currently on
record for that tool — there is no name-only or "trust all" shortcut anywhere (CLI, Control API, or Control
Center). If the tool has drifted again since you last looked, an attempt to accept/reject using the stale
id/fingerprint fails outright rather than silently applying to whatever the current candidate happens to be.

## Context Guard

This is also a **gateway config field, not a policy field** — cross-tool session-risk escalation defense (see
ADR-0013 in `docs/AI_DECISIONS.md` and
[`docs/THREAT_MODEL.md`](THREAT_MODEL.md#context-guard-cross-tool-escalation-defense-adr-0013)). It governs
whether a tool's *result* adds risk labels to the current execution context, and whether a *later* call's
declared effects are checked against those accumulated labels — independent of everything else on this page,
which governs individual calls in isolation.

Schema (`packages/gateway/src/config/registry.ts`, `ContextGuardSchema`):

```yaml
context_guard:
  mode: enforce               # "enforce" | "monitor" (default if omitted) | "disabled"
  labels: [my_custom_label]   # optional — custom labels beyond the built-in vocabulary below
  tools:
    <tool-name>:
      effects: [external_communication]        # what this tool's CALL declares — max 16 labels
      adds_on_result: [untrusted_content]       # what a SUCCESSFUL, non-blocked result adds — max 16 labels
  rules:
    - id: my-rule-id
      when:
        context_has_any: [untrusted_content]    # true if the context currently has ANY listed label
        # context_has_all / context_lacks_all / context_lacks_any / target_has_any / target_has_all also exist —
        # at least one condition is required per rule
      action: deny                              # "deny" | "require_approval" — contextual rules only ESCALATE
      reason: "..."                              # required, 1-500 characters
      approval_ttl_seconds: 60                   # only meaningful with action: require_approval; 1-3600
```

| Mode | Behavior | Recommended for |
|---|---|---|
| `enforce` | Contextual rules can DENY or REQUIRE_APPROVAL a call before it ever reaches policy execution or the downstream server. | High-security deployments; the whole point of enabling this feature. |
| `monitor` | Context labels are still accumulated and contextual rules are still evaluated and recorded, but the result never blocks or escalates a call. | **The default when `context_guard` is omitted.** Kept as the default so a config file written before this milestone keeps working unmodified — see "Migration" below. Never described anywhere in this codebase as protection; it is reporting only. |
| `disabled` | No context is created, no labels are tracked, no contextual rule is ever evaluated. Identical to every AgentGate version before this milestone. | Backwards-compatibility only. Using this removes the defense entirely. |

**Migration**: an existing `agentgate.yml` without a `context_guard` section already behaves as `monitor` — no
new blocking behavior, nothing to change for AgentGate to keep working exactly as before. Unlike Tool Integrity,
`agentgate init` does **not** currently generate a `context_guard` block for new projects (a stated, honest gap,
not an oversight) — a new project also starts in `monitor` mode until an operator explicitly adds one. To adopt
enforcement:

```yaml
context_guard:
  mode: enforce
  tools:
    <name-of-a-tool-whose-result-exposes-untrusted-or-sensitive-content>:
      adds_on_result: [untrusted_content]
    <name-of-your-highest-risk-outbound-tool>:
      effects: [external_communication]
  rules:
    - id: deny-external-after-untrusted-content
      when:
        context_has_any: [untrusted_content]
        target_has_any: [external_communication]
      action: deny
      reason: "External communication blocked: untrusted content was accessed earlier in this session."
```

**Built-in label vocabulary** (`BUILTIN_CONTEXT_LABELS`/`BUILTIN_EFFECT_LABELS`) — a starting vocabulary, not a
closed one; `context_guard.labels` extends it with custom, operator-declared labels (max 64), never replaces it:

| Kind | Label | Meaning |
|---|---|---|
| Source (what a *result* may have exposed the agent to) | `untrusted_content` | The result contains content from an untrusted origin the agent could be steered by. |
| Source | `sensitive_data_accessed` | The result exposed sensitive/confidential data. |
| Source | `prompt_injection_suspected` | Only ever set by your own config on a tool whose result you specifically classify this way — AgentGate itself never infers this from content; there is no built-in injection detector. If you configure a tool this way, document in your own policy comments exactly what heuristic led you to that classification, since it is your assertion, not a verified fact. |
| Effect (what a *call itself* does) | `external_communication` | The call sends data outside the local system. |
| Effect | `destructive_write` | The call destructively modifies state. |
| Effect | `code_execution` | The call executes code. |
| Effect | `credential_use` | The call uses a credential. |
| Effect | `privilege_change` | The call changes privileges. |
| Effect | `sensitive_read` | The call reads sensitive data. |

Label names must be lowercase `snake_case`, starting with a letter, max 64 characters
(`^[a-z][a-z0-9_]{0,63}$`) — deliberately narrow so labels stay readable in CLI/UI/audit output and cannot smuggle
unbounded or hostile text. Every label referenced anywhere in config (`tools.*.effects`, `tools.*.adds_on_result`,
`rules.*.when.*`) is validated against the built-in set plus `context_guard.labels` at config-parse time
(`loadGatewayConfig()`) — an unknown label fails validation outright, it does not silently become a no-op rule at
runtime. Max 128 rules total.

**`when` operators** (`ContextGuardWhenSchema`) — at least one required per rule, combined with AND when more
than one is present:

| Operator | True when |
|---|---|
| `context_has_all` | The active context currently has EVERY listed label. |
| `context_has_any` | The active context currently has ANY listed label. |
| `context_lacks_all` | The active context currently has NONE of the listed labels. |
| `context_lacks_any` | The active context is missing AT LEAST ONE listed label (i.e. not all are present). |
| `target_has_any` | The ATTEMPTED call's own declared `effects` include ANY listed label. |
| `target_has_all` | The ATTEMPTED call's own declared `effects` include EVERY listed label. |

**Action semantics and the stricter-merge invariant**: a contextual rule's `action` is only ever `deny` or
`require_approval` — there is no contextual `allow`, by design (this is what makes "Context Guard can only make
things stricter" a provable, testable property rather than something policy authors must trust by convention).
The contextual result and the base policy decision are merged via a strictest-wins rule
(`ALLOW < REQUIRE_APPROVAL < DENY`): a base-policy `deny` can never become a contextual `allow`/
`require_approval`, and an already-`require_approval` base decision can never be silently downgraded to `allow`
by a non-matching contextual rule.

**Exact transition timing**: a tool's `adds_on_result` labels are added ONLY when that call actually
`SUCCEEDED` and its result was not entirely replaced by output security (ADR-0009) — a denied, cancelled,
expired, failed, or fully-blocked call adds no labels, because nothing the label would describe actually reached
the agent. A redacted-but-still-delivered result *does* still add its configured labels (content beyond the
redacted secret pattern still reached the agent) — a deliberately conservative trade-off, not an oversight. If
every label in a call's `adds_on_result` is already active, this is a no-op: no new history event, no revision
bump — context history stays proportional to real change.

**Validation failures**: `loadGatewayConfig()` rejects, at gateway startup, the same way any other malformed
config field is rejected: an unknown label anywhere, a duplicate custom label, a duplicate rule `id`, a `when`
clause with zero conditions, a `reason` outside 1–500 characters, an `approval_ttl_seconds` outside 1–3600, more
than 16 labels on one tool's `effects`/`adds_on_result`, more than 64 custom labels, or more than 128 rules.

**Anti-example — MCP annotations do not grant, and cannot be used to grant, any permission here.** A downstream
tool declaring `annotations: { readOnlyHint: true }` has **zero** effect on Context Guard evaluation — enforcement
never reads a tool's self-declared annotations for any decision, exactly as Tool Integrity never trusts them
either (see [Tool Integrity](#tool-integrity) above). This is deliberate: a malicious or buggy downstream server
could otherwise self-report its way to a lower risk classification simply by claiming to be read-only. The ONLY
way a tool's effects/adds_on_result are ever set is your own `context_guard.tools.<name>` config — never inferred
from anything the server itself advertises.

```yaml
# WRONG assumption: "this tool says readOnlyHint: true, so it must be safe from Context Guard's perspective."
# Context Guard never even looks at that field. If a tool's call is genuinely an external-communication effect,
# you must declare it yourself:
context_guard:
  tools:
    send_webhook:
      effects: [external_communication]   # <- this is what actually matters, regardless of any annotation
```

**Complete example — deny path** (send_webhook denied outright once risk has accumulated):

```yaml
context_guard:
  mode: enforce
  tools:
    fetch_ticket:
      adds_on_result: [untrusted_content]
    read_secret:
      effects: [sensitive_read]
      adds_on_result: [sensitive_data_accessed]
    send_webhook:
      effects: [external_communication]
  rules:
    - id: deny-external-after-risk
      when:
        context_has_any: [untrusted_content, sensitive_data_accessed]
        target_has_any: [external_communication]
      action: deny
      reason: "External communication blocked: untrusted or sensitive content was accessed earlier in this session."
```

**Complete example — require-approval path** (same trigger, but a human is asked instead of an outright deny):

```yaml
context_guard:
  mode: enforce
  tools:
    fetch_ticket:
      adds_on_result: [untrusted_content]
    send_webhook:
      effects: [external_communication]
  rules:
    - id: approve-external-after-risk
      when:
        context_has_any: [untrusted_content]
        target_has_any: [external_communication]
      action: require_approval
      reason: "External communication requires approval: untrusted content was accessed earlier in this session."
      approval_ttl_seconds: 60
```

An approval created this way is bound to the exact context revision, redacted-argument digest, and (where a
trusted Tool Integrity definition exists) exact tool fingerprint present at creation time, and is re-validated
fresh against current state immediately before execution — see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#context-guard-adr-0013) for the exact mechanism.

```sh
agentgate context status  --config agentgate.yml --json
agentgate context history <context-id> --config agentgate.yml
agentgate context explain <context-id> --config agentgate.yml
agentgate context reset   <context-id> --revision <n> --reason <text> --config agentgate.yml
agentgate context verify  --config agentgate.yml
```

There is no `reset-all`, no per-label removal, no "mark safe," and no force-approve anywhere — `reset` requires
the exact current revision and a non-empty bounded reason, and it cannot erase anything the upstream model or MCP
client itself remembers from before the reset. See [Troubleshooting](TROUBLESHOOTING.md#a-tool-call-is-denied-or-
requires-approval-because-of-context-guard) if a call is unexpectedly denied or gated.

## Decision: `allow`

```yaml
- id: allow-project-reads
  tools: ["read_file"]
  decision: allow
```

Executes the call against the downstream server immediately. No decision-specific fields. Arguments are still
redacted in the audit record if they match a secret pattern — `allow` does not exempt a call from audit redaction,
it only skips human approval and does not transform what is *forwarded*.

## Decision: `deny`

```yaml
- id: block-secret-exfiltration
  tools: ["network.*", "fetch", "http_request"]
  contains_secrets: true
  decision: deny
```

Blocks execution. The MCP client receives an error response (`isError: true`) with the rule's explanation text;
an audit event with status `DENIED` is recorded. No decision-specific fields.

## Decision: `require_approval`

```yaml
- id: approve-file-writes
  tools: ["write_file", "create_directory"]
  decision: require_approval
  approval_ttl_seconds: 120
```

Pauses the call and creates a pending `Approval`, visible in the Control Center's Approvals queue, until a human
approves or denies it (or the TTL elapses). See [Approval TTL](#approval-ttl) below.

## Decision: `allow_with_transform`

```yaml
- id: redact-webhook-secret
  tools: ["http_request"]
  hosts: ["hooks.example.com"]
  decision: allow_with_transform
  transformations:
    - redact_field: "headers.Authorization"
      replace_with: "[REDACTED]"
```

Executes the call, but first applies each `transformations` entry to the arguments **before forwarding to the
downstream server** (not just before persistence, unlike the always-on audit redaction described above).

| Field | Type | Notes |
|---|---|---|
| `redact_field` | `string` | Dot-separated path into the arguments object, e.g. `"body"` or `"env.SECRET_KEY"`. |
| `replace_with` | `string`, default `"[REDACTED]"` | Replacement value. |

If a `redact_field` path doesn't exist in the actual arguments, that transformation is silently a no-op for that
call (`redactField()` returns the object unchanged for a missing path — this is intentional, not an error, since
different calls to the same tool may have different argument shapes).

## Approval TTL

`approval_ttl_seconds` (10–3600, i.e. 10 seconds to 1 hour) is only meaningful on `require_approval` rules. If
omitted, it defaults to **120 seconds** (`DEFAULT_APPROVAL_TTL_SECONDS` in `engine.ts`) — `validatePolicy()` emits
a warning (not an error) when this happens. Once the TTL elapses without a human decision, the event is recorded as
`EXPIRED`, not `DENIED` — distinguishable in the Timeline/Event Detail views. Approvals are single-use: consuming
one (approve or deny) marks it `consumed`, and it cannot be re-decided or replayed.

## Validation failures

`agentgate validate <policy.yml>` (and `loadPolicyFile()` internally) reports **errors** (schema violations —
missing required fields, wrong types, invalid `version`) and **warnings** (schema-valid but likely mistakes):

- a `require_approval` rule with no `approval_ttl_seconds` (defaults to 120s, warns so you know),
- an `allow_with_transform` rule with no `transformations` (warns that it behaves as a plain `allow`),
- a duplicate rule `id` (warns that only the first occurrence can ever match, since evaluation stops at first
  match).

Errors make the policy fail to load entirely (the gateway will not start with an invalid policy). Warnings do not
block loading.

```sh
$ node packages/gateway/dist/cli.js validate policies/agentgate.example.yml
✅ Policy "policies/agentgate.example.yml" is valid.
```

## Worked examples

**Deny by default, allow only reads inside the project, everything else falls through to `deny-outside-project`:**

See [`policies/agentgate.example.yml`](../policies/agentgate.example.yml) in full — it is the policy exercised by
`node examples/secret-exfiltration/demo.mjs` and by every gateway integration test.

**The smallest possible starting point:** `agentgate init` (see [`docs/DEVELOPMENT.md`](DEVELOPMENT.md#onboarding-cli))
generates a policy with exactly one rule — an `allow` for a single harmless tool name — under a `deny` default.
It is deliberately narrower than the example above: a starting point meant to be edited and widened
deliberately, not a template for a real deployment. See `packages/gateway/src/onboarding/init.ts`'s
`buildPolicyTemplate()` for its exact, current contents.

**Require approval only for destructive shell commands, allow everything else read-only:**

```yaml
version: 1
defaults:
  decision: deny
rules:
  - id: allow-reads
    tools: ["read_file", "list_directory"]
    decision: allow
  - id: approve-destructive-shell
    tools: ["shell.execute"]
    commands: ["rm *", "rm -rf *", "git push*"]
    decision: require_approval
    approval_ttl_seconds: 300
  - id: deny-shell-otherwise
    tools: ["shell.execute"]
    decision: deny
```

## Common mistakes

- **Relying on `agents:` as a security boundary.** It matches a self-reported, unverified name — see
  [Match fields](#match-fields) and the threat model.
- **Setting `risk:` and expecting it to affect matching.** The field is accepted by the schema (so authoring tools
  and future rules can use it as metadata) but `ruleMatches()` in `engine.ts` does not currently read it — a rule
  with only `risk: ["destructive"]` and no other match field matches **every** tool call. Always pair `risk` with
  at least one of `tools`/`paths`/`commands`/`hosts`/`agents`.
- **Expecting `paths`/`commands` rules to match calls without that argument.** If the tool call has no recognized
  path/command argument key, a rule requiring `paths`/`commands` simply never matches that call — it does not
  error, and it does not fall back to matching on presence alone.
- **Assuming `allow` skips audit redaction.** It doesn't — redaction of detected secrets from persisted audit
  records happens for every decision type. Only `allow_with_transform`'s explicit `transformations` affect what is
  actually *forwarded* to the downstream server.
- **Forgetting rule order determines precedence.** There is no specificity-based ordering; put your most specific
  `deny`/`require_approval` rules before broader `allow` rules that might otherwise match first.
- **Reusing a rule `id`.** Only the first rule with a given `id` can ever be reached; `validatePolicy()` warns on
  this but does not error.
- **Putting `output_security` inside a policy rule.** It is not a policy field at all — it is a top-level gateway
  config block (see [Output security (gateway-level)](#output-security-gateway-level)) and has no effect if
  nested under `rules:`.
- **Putting `tool_integrity` inside a policy rule, or expecting a policy `allow` rule to bypass quarantine.** Tool
  Integrity is a separate, earlier gate — a quarantined tool is blocked before policy evaluation ever runs, so no
  `allow`/`decision` in a policy rule can override it. See [Tool Integrity](#tool-integrity) above.
- **Putting `context_guard` inside a policy rule, or expecting a policy `allow` rule to override a contextual
  deny/require-approval.** Context Guard is gateway-level config, evaluated alongside (and merged strictest-wins
  with) the base policy decision — not a policy rule field. See [Context Guard](#context-guard) above.
- **Assuming a downstream tool's `annotations` (e.g. `readOnlyHint`) affect Context Guard's evaluation.** They
  don't, ever — only your own `context_guard.tools.<name>.effects`/`.adds_on_result` config does. See the
  anti-example under [Context Guard](#context-guard) above.
- **Forgetting `context_guard` defaults to `monitor` (reporting only) when omitted**, and that `agentgate init`
  does not currently generate an `enforce`-mode block for new projects — unlike `tool_integrity`, which does.
  Explicitly add `context_guard: { mode: enforce, ... }` to get real blocking behavior.

## CLI

There is no `agentgate explain`/`agentgate test` subcommand in this milestone — `validate` checks a policy file's
shape without running the gateway, and `replay <event-id> [config]` (ADR-0010) answers a narrower, adjacent
question: given a *real historical event*, would today's policy decide it differently? Replay is not a policy
linter or test runner — it re-evaluates one specific stored event, never executes anything, and requires an
existing audit database with at least one recorded event. `agentgate context status|history|explain|reset|verify`
(ADR-0013) is a separate, adjacent surface again: it reports on Context Guard's own accumulated-label state and
history, never a policy file's shape, and `reset` is its only mutating subcommand (exact revision + reason
required). See [`README.md`](../README.md#cli) for all three command families and
[`docs/AI_DECISIONS.md`](AI_DECISIONS.md) (ADR-0010, ADR-0013) for what Safe Replay and Context Guard each do and
do not do.
