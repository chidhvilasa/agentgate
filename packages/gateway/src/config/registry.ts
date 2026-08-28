import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ─── Downstream Server Definition ─────────────────────────────────────────────

const StdioServerSchema = z.object({
  transport: z.literal('stdio'),
  /** Command to launch the downstream MCP server. */
  command: z.string(),
  /** Arguments to pass to the command. */
  args: z.array(z.string()).default([]),
  /** Environment variables to inject. */
  env: z.record(z.string()).optional(),
});

const HttpServerSchema = z.object({
  transport: z.literal('http'),
  /** Full URL of the downstream streamable HTTP MCP server. */
  url: z.string().url(),
});

const DownstreamServerSchema = z.discriminatedUnion('transport', [
  StdioServerSchema,
  HttpServerSchema,
]).and(
  z.object({
    /** Unique identifier for this downstream server. */
    id: z.string().min(1),
    /** Human-readable description. */
    description: z.string().optional(),
    /**
     * Tool name prefixes or exact names this server owns.
     * Glob-style. If omitted, all tool names are tried against this server.
     * When two servers have overlapping names, first-listed wins.
     */
    tools: z.array(z.string()).optional(),
  })
);

// ─── Output Security (ADR-0009) ────────────────────────────────────────────────

/**
 * Governs sanitization of downstream MCP results before they are forwarded
 * to the upstream client. See ADR-0009 in docs/AI_DECISIONS.md and
 * docs/POLICY_REFERENCE.md for the full behavior.
 *
 * `opaque_content` currently validates only one literal value
 * (`allow_uninspected`) — image/audio/blob content is never regex-scanned in
 * either mode (that would risk corrupting binary payloads), so there is
 * exactly one implemented behavior today. The field exists so this is an
 * explicit, self-documenting config value rather than an invisible hardcoded
 * choice; it deliberately does not offer a mode that doesn't exist yet.
 */
const OutputSecuritySchema = z.object({
  /**
   * redact: replace recognized secret patterns in inspectable output with
   *   [REDACTED] and still return the result.
   * block: replace the entire result with a protocol-valid AgentGate error
   *   if a secret is detected, or if a depth/size limit prevented full
   *   inspection of otherwise-inspectable text/structured content.
   */
  mode: z.enum(['redact', 'block']).default('redact'),
  opaque_content: z.literal('allow_uninspected').default('allow_uninspected'),
  /** Maximum object/array nesting depth actually inspected in structured content. */
  max_depth: z.number().int().min(1).max(20).default(8),
  /** Maximum UTF-8 byte length of a single text/string leaf actually scanned. */
  max_text_bytes: z.number().int().min(1024).max(10_000_000).default(1_000_000),
});
export type OutputSecurityConfig = z.infer<typeof OutputSecuritySchema>;

// ─── Tool Integrity (Milestone 6, ADR-0012) ────────────────────────────────────

/**
 * Governs the Tool Integrity Registry — rug-pull / tool-definition-poisoning
 * defense. See docs/AI_DECISIONS.md (ADR-0012) and docs/THREAT_MODEL.md.
 *
 * - `explicit`   : every new or changed tool definition is quarantined until
 *                  a human explicitly accepts its exact fingerprint. The
 *                  recommended, high-security mode.
 * - `tofu`       : a tool's *first-ever* observed definition is trusted
 *                  automatically ("trust on first use"); any LATER change to
 *                  an already-trusted tool is still quarantined exactly like
 *                  `explicit` mode.
 * - `monitor`    : drift is still detected, classified, and recorded, but
 *                  never blocks discovery or calls. Reporting only — never
 *                  described as protection. This is the default when
 *                  `tool_integrity` is omitted entirely, for backwards
 *                  compatibility with configs written before this milestone
 *                  (see ADR-0012 for why this specific trade-off was made).
 * - `disabled`   : the registry is not consulted at all; behavior is
 *                  identical to every version of AgentGate before this
 *                  milestone. Only for compatibility; removes this defense
 *                  entirely and is documented as doing so.
 */
const ToolIntegrityModeSchema = z.enum(['explicit', 'tofu', 'monitor', 'disabled']);
export type ToolIntegrityMode = z.infer<typeof ToolIntegrityModeSchema>;

const ToolIntegritySchema = z.object({
  mode: ToolIntegrityModeSchema.default('monitor'),
});
export type ToolIntegrityConfig = z.infer<typeof ToolIntegritySchema>;

// ─── Context Guard (Milestone 7, ADR-0013) ─────────────────────────────────────

/**
 * Cross-tool escalation defense. A tool's SUCCESSFUL, non-blocked result can
 * mark the active local execution context with operator-owned risk labels
 * (`adds_on_result`); a later call's declared `effects` are checked against
 * the context's ACCUMULATED labels by `rules`. This is a local, conservative
 * policy-state label — never proof that one tool result actually caused a
 * later call, and never a substitute for real information-flow tracking. See
 * ADR-0013 in docs/AI_DECISIONS.md and docs/THREAT_MODEL.md for the full
 * model and its explicit limitations.
 *
 * - `enforce`  : contextual rules can DENY or REQUIRE_APPROVAL a call before
 *                it ever reaches policy execution. Recommended, high-security
 *                mode.
 * - `monitor`  : context labels are still accumulated and contextual rules
 *                are still evaluated and recorded, but the result never
 *                blocks or escalates a call — reporting only, never described
 *                as protection. This is the default when `context_guard` is
 *                omitted entirely, for backwards compatibility with configs
 *                written before this milestone (see ADR-0013 for why).
 * - `disabled` : no context is created, no labels are tracked, no contextual
 *                rule is ever evaluated; identical to every AgentGate version
 *                before this milestone.
 */
const ContextGuardModeSchema = z.enum(['enforce', 'monitor', 'disabled']);
export type ContextGuardMode = z.infer<typeof ContextGuardModeSchema>;

/** Label name: lowercase snake_case, bounded length — deliberately narrow so labels stay readable in CLI/UI/audit output and can't be used to smuggle unbounded/hostile text. */
const LABEL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const labelNameSchema = z.string().regex(LABEL_NAME_PATTERN, 'Label names must be lowercase snake_case, starting with a letter, max 64 characters.');
const MAX_LABELS_PER_TOOL = 16;
const MAX_CUSTOM_LABELS = 64;
const MAX_RULES = 128;

/** Built-in source/context labels (what the RESULT of a call may have exposed the agent to) — see docs/POLICY_REFERENCE.md for the authoritative, documented meaning of each. Operator-declared custom labels extend this set; they never replace it. */
export const BUILTIN_CONTEXT_LABELS = [
  'untrusted_content',
  'sensitive_data_accessed',
  'prompt_injection_suspected',
] as const;

/** Built-in target/effect labels (what a CALL ITSELF does, checked against accumulated context labels before the call is allowed). */
export const BUILTIN_EFFECT_LABELS = [
  'external_communication',
  'destructive_write',
  'code_execution',
  'credential_use',
  'privilege_change',
  'sensitive_read',
] as const;

const ContextGuardToolSchema = z.object({
  /** Effect labels this tool's CALL carries — checked against the active context's accumulated labels by `target_has_any`/`target_has_all` before the call is allowed. Never mutates context state by itself. */
  effects: z.array(labelNameSchema).max(MAX_LABELS_PER_TOOL).default([]),
  /** Labels added to the active execution context after this tool's call SUCCEEDS with a non-blocked result — see ADR-0013 for the exact, deterministic per-outcome rule (never on deny/error/blocked-result). */
  adds_on_result: z.array(labelNameSchema).max(MAX_LABELS_PER_TOOL).default([]),
});

const ContextGuardWhenSchema = z
  .object({
    /** True only if the active context currently has EVERY listed label. */
    context_has_all: z.array(labelNameSchema).optional(),
    /** True if the active context currently has ANY listed label. */
    context_has_any: z.array(labelNameSchema).optional(),
    /** True only if the active context currently has NONE of the listed labels. */
    context_lacks_all: z.array(labelNameSchema).optional(),
    /** True if the active context is currently missing AT LEAST ONE listed label (i.e. not all are present). */
    context_lacks_any: z.array(labelNameSchema).optional(),
    /** True if the ATTEMPTED call's own declared `effects` include ANY listed label. */
    target_has_any: z.array(labelNameSchema).optional(),
    /** True only if the ATTEMPTED call's own declared `effects` include EVERY listed label. */
    target_has_all: z.array(labelNameSchema).optional(),
  })
  .strict()
  .refine(
    (w) => Object.values(w).some((v) => v !== undefined),
    { message: 'A contextual rule "when" clause must specify at least one condition.' }
  );

const ContextGuardRuleSchema = z.object({
  id: z.string().min(1).max(128),
  when: ContextGuardWhenSchema,
  /** Contextual rules only ever ESCALATE — there is no "allow" action here by design (see ADR-0013's monotonicity invariant); the strictest of the base policy decision and any matching contextual rule's action is always what is enforced. */
  action: z.enum(['deny', 'require_approval']),
  reason: z.string().min(1).max(500),
  /** Only used when action is require_approval; falls back to the policy's own default TTL handling if omitted. */
  approval_ttl_seconds: z.number().int().min(1).max(3600).optional(),
});

const ContextGuardSchema = z
  .object({
    mode: ContextGuardModeSchema.default('monitor'),
    /** Operator-declared custom labels, beyond the built-in vocabulary above — every label referenced anywhere below (tools.*.effects, tools.*.adds_on_result, rules.*.when.*) must be built-in or declared here, checked below. */
    labels: z.array(labelNameSchema).max(MAX_CUSTOM_LABELS).default([]),
    tools: z.record(ContextGuardToolSchema).default({}),
    rules: z.array(ContextGuardRuleSchema).max(MAX_RULES).default([]),
  })
  .superRefine((cfg, ctx) => {
    const known = new Set<string>([...BUILTIN_CONTEXT_LABELS, ...BUILTIN_EFFECT_LABELS, ...cfg.labels]);
    const dupCustom = cfg.labels.filter((l, i) => cfg.labels.indexOf(l) !== i);
    if (dupCustom.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labels'], message: `Duplicate custom label(s): ${[...new Set(dupCustom)].join(', ')}.` });
    }
    const checkLabels = (labels: string[] | undefined, path: (string | number)[]) => {
      for (const l of labels ?? []) {
        if (!known.has(l)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Unknown label "${l}" — must be a built-in label or declared in context_guard.labels.` });
        }
      }
    };
    for (const [toolName, toolCfg] of Object.entries(cfg.tools)) {
      if (toolName.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tools'], message: 'Tool name keys must be non-empty.' });
      }
      checkLabels(toolCfg.effects, ['tools', toolName, 'effects']);
      checkLabels(toolCfg.adds_on_result, ['tools', toolName, 'adds_on_result']);
    }
    const ruleIds = new Set<string>();
    cfg.rules.forEach((rule, i) => {
      if (ruleIds.has(rule.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', i, 'id'], message: `Duplicate contextual rule id "${rule.id}".` });
      }
      ruleIds.add(rule.id);
      checkLabels(rule.when.context_has_all, ['rules', i, 'when', 'context_has_all']);
      checkLabels(rule.when.context_has_any, ['rules', i, 'when', 'context_has_any']);
      checkLabels(rule.when.context_lacks_all, ['rules', i, 'when', 'context_lacks_all']);
      checkLabels(rule.when.context_lacks_any, ['rules', i, 'when', 'context_lacks_any']);
      checkLabels(rule.when.target_has_any, ['rules', i, 'when', 'target_has_any']);
      checkLabels(rule.when.target_has_all, ['rules', i, 'when', 'target_has_all']);
    });
  });
export type ContextGuardConfig = z.infer<typeof ContextGuardSchema>;
export type ContextGuardRule = z.infer<typeof ContextGuardRuleSchema>;
export type ContextGuardWhen = z.infer<typeof ContextGuardWhenSchema>;

/**
 * Canonical runtime-safe Context Guard default — the exact schema default
 * (`monitor` mode, no custom labels/tools/rules), derived from the real
 * schema rather than hand-copied. Safe to reuse at any boundary that must
 * tolerate a missing `context_guard`: a `GatewayConfig`-shaped object built
 * by hand rather than parsed through `loadGatewayConfig()` (e.g. a test
 * fixture predating this milestone), or any other caller that cannot
 * guarantee the field was schema-validated. Never hand-write an equivalent
 * `{ mode: 'monitor', ... }` literal elsewhere — this is the single source
 * of truth for what "omitted" means.
 */
export function defaultContextGuardConfig(): ContextGuardConfig {
  return ContextGuardSchema.parse({});
}

// ─── Gateway Runtime Config ────────────────────────────────────────────────────

const GatewayConfigSchema = z.object({
  version: z.literal(1),

  /** Port the MCP stdio proxy listens on internally (not exposed). */
  gateway_port: z.number().int().min(1024).max(65535).default(4000),
  /** Port for the Control Center API (loopback only). */
  control_port: z.number().int().min(1024).max(65535).default(4001),

  /** Path to the policy YAML file. */
  policy: z.string().default('./agentgate.policy.yml'),

  /** SQLite database path. */
  db_path: z.string().default('./agentgate.sqlite'),

  /** Downstream MCP servers. */
  servers: z.array(DownstreamServerSchema).min(1),

  retention: z
    .object({
      /** Keep audit events for this many days. 0 = keep forever. */
      max_days: z.number().int().min(0).default(30),
      /** Maximum number of events to keep. 0 = unlimited. */
      max_events: z.number().int().min(0).default(100000),
    })
    .default({}),

  /** Downstream result/error sanitization. See ADR-0009. */
  output_security: OutputSecuritySchema.default({}),

  /** Tool Integrity Registry — rug-pull defense. See ADR-0012. */
  tool_integrity: ToolIntegritySchema.default({}),

  /** Context Guard — cross-tool escalation defense. See ADR-0013. */
  context_guard: ContextGuardSchema.default({}),
});

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type DownstreamServer = z.infer<typeof DownstreamServerSchema>;

// ─── Load Config ──────────────────────────────────────────────────────────────

export function loadGatewayConfig(filePath: string): GatewayConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read config file "${filePath}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Config file "${filePath}" is not valid YAML: ${(err as Error).message}`);
  }

  const result = GatewayConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Config file "${filePath}" is invalid:\n${errors}`);
  }

  // Milestone 5 fix: `policy`/`db_path` are resolved relative to the config
  // file's own directory, not the process's current working directory.
  // Before this fix, a relative `policy: ./agentgate.policy.yml` only
  // worked if the gateway happened to be launched from that exact
  // directory — `agentgate start some/other/dir/agentgate.yml` from
  // anywhere else silently looked for the policy file next to wherever the
  // command was actually run from and failed with a confusing "file not
  // found". `packages/gateway/src/onboarding/{configValidate,doctor}.ts`
  // already assumed this (safer) behavior when locating the policy file to
  // check — this fix makes the real runtime match what they already
  // promised, instead of the other way around. `:memory:` is SQLite's own
  // special in-memory-database sentinel, never a real file path, and is
  // deliberately left untouched.
  const configDir = path.dirname(path.resolve(filePath));
  const resolved = {
    ...result.data,
    policy: path.isAbsolute(result.data.policy) ? result.data.policy : path.resolve(configDir, result.data.policy),
    db_path:
      result.data.db_path === ':memory:' || path.isAbsolute(result.data.db_path)
        ? result.data.db_path
        : path.resolve(configDir, result.data.db_path),
  };

  return resolved;
}

/**
 * Resolves which downstream server should handle a given tool call.
 * First server whose `tools` glob list matches wins.
 * If no server has a `tools` constraint, the first server is used.
 */
import micromatch from 'micromatch';

export function resolveServer(
  config: GatewayConfig,
  toolName: string
): DownstreamServer | null {
  for (const server of config.servers) {
    if (!server.tools?.length) continue;
    if (micromatch.isMatch(toolName, server.tools)) return server;
  }
  // Fall back to first server with no tool constraint
  const fallback = config.servers.find((s) => !s.tools?.length);
  return fallback ?? null;
}
