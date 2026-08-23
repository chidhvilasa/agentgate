import { z } from 'zod';
import fs from 'node:fs';
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

  return result.data;
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
