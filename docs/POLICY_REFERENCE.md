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

## CLI

There is no `agentgate explain`/`agentgate test` subcommand in this milestone — `validate` checks a policy file's
shape without running the gateway, and `replay <event-id> [config]` (ADR-0010) answers a narrower, adjacent
question: given a *real historical event*, would today's policy decide it differently? Replay is not a policy
linter or test runner — it re-evaluates one specific stored event, never executes anything, and requires an
existing audit database with at least one recorded event. See [`README.md`](../README.md#cli) for both commands
and [`docs/AI_DECISIONS.md`](AI_DECISIONS.md) (ADR-0010) for what Safe Replay does and does not do.
