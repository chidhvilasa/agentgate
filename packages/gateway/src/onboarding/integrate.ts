// `agentgate integrate <client>` — generates (prints by default; writes to
// an explicitly-chosen new file, never silently patches a live user
// config) an MCP client integration snippet (Milestone 5, Phase 5).
//
// Support matrix, each backed by an authoritative, cited source fetched
// and verified during this milestone's work (see docs/AI_DECISIONS.md):
//   - claude-code : verified against https://code.claude.com/docs/en/mcp
//   - antigravity : verified against https://antigravity.google/docs/ide/mcp/
//   - generic     : NOT a specific product — a labeled, generic stdio-MCP
//                    recipe for any client not explicitly listed above.
// No client integration ever embeds the Control API auth token — it is
// generated fresh per launch and only ever printed to the gateway's own
// stderr; nothing here has a token to embed in the first place.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type SupportedClient = 'claude-code' | 'antigravity' | 'generic';

export const SUPPORTED_CLIENTS: SupportedClient[] = ['claude-code', 'antigravity', 'generic'];

export interface IntegrateOptions {
  client: SupportedClient;
  /** Path to the agentgate.yml this integration should start. */
  configPath: string;
  /** Path to the agentgate CLI entrypoint to invoke. */
  cliPath: string;
  /** Name to register the server under. */
  serverName?: string;
}

export interface IntegrateResult {
  client: SupportedClient;
  verified: boolean;
  sourceUrl: string | null;
  serverName: string;
  /** The full JSON file content this client expects. */
  fileContent: string;
  /** Where this file conventionally lives, for this client/scope. */
  targetFileHint: string;
  scopeNote: string;
  removalNote: string;
}

function toYamlSafePosixLike(p: string): string {
  // JSON strings do not need shell quoting — spaces/Unicode are handled by
  // JSON encoding itself. We still normalize to forward slashes for
  // readability/portability in the generated file, matching this
  // project's existing convention for generated YAML paths.
  return p.split(path.sep).join('/');
}

function buildServerEntry(cliPath: string, configPath: string): Record<string, unknown> {
  return {
    command: 'node',
    args: [toYamlSafePosixLike(cliPath), 'start', toYamlSafePosixLike(configPath)],
  };
}

export function buildIntegration(opts: IntegrateOptions): IntegrateResult {
  const serverName = opts.serverName ?? 'agentgate';
  const entry = buildServerEntry(opts.cliPath, opts.configPath);
  const fileObject = { mcpServers: { [serverName]: entry } };
  const fileContent = JSON.stringify(fileObject, null, 2) + '\n';

  switch (opts.client) {
    case 'claude-code':
      return {
        client: opts.client,
        verified: true,
        sourceUrl: 'https://code.claude.com/docs/en/mcp',
        serverName,
        fileContent,
        targetFileHint: '.mcp.json (project root) for a project-scoped server shared via version control, or run `claude mcp add-json` for a user-scoped one.',
        scopeNote:
          'Project scope (.mcp.json, committed) is shared with everyone who opens this project in Claude Code and requires a one-time approval prompt per teammate. User scope (`claude mcp add-json`) applies only to your own Claude Code installation.',
        removalNote: 'Delete the "agentgate" entry from .mcp.json\'s mcpServers object, or run `claude mcp remove agentgate` for a user-scoped server.',
      };
    case 'antigravity':
      return {
        client: opts.client,
        verified: true,
        sourceUrl: 'https://antigravity.google/docs/ide/mcp/',
        serverName,
        fileContent,
        targetFileHint: '.agents/mcp_config.json (workspace-scoped, project root) or ~/.gemini/config/mcp_config.json (global, applies to every workspace).',
        scopeNote:
          'Workspace scope (.agents/mcp_config.json) applies only to this project. Global scope (~/.gemini/config/mcp_config.json) applies to every Antigravity workspace on this machine.',
        removalNote: 'Delete the "agentgate" entry from the mcpServers object in whichever mcp_config.json you added it to, or set "disabled": true to keep it without removing it.',
      };
    case 'generic':
      return {
        client: opts.client,
        verified: false,
        sourceUrl: null,
        serverName,
        fileContent,
        targetFileHint:
          'GENERIC RECIPE — not verified against any specific product\'s current documentation. Most MCP clients that support local stdio servers use a top-level "mcpServers" object shaped like this; consult your client\'s own docs for the exact file path and scope rules before using it.',
        scopeNote: 'Unknown — this client is not in AgentGate\'s verified support matrix. Map this manually.',
        removalNote: 'Remove the "agentgate" entry from your client\'s MCP server list using whatever mechanism your client documents.',
      };
  }
}

// ─── Optional, explicit-opt-in "apply" mode ───────────────────────────────
//
// Default `integrate` behavior only ever prints a snippet or writes to a
// NEW, explicitly-named file. Actually patching a real, possibly-existing
// client config file is a materially more dangerous operation and is only
// reachable through `applyIntegration()`, called by the CLI only when the
// user passes an explicit `--apply <path>` flag. It always previews,
// always backs up before writing, writes atomically, and preserves every
// unrelated key/entry in the target file.

export interface ApplyIntegrationOptions {
  targetPath: string;
  serverName: string;
  entry: Record<string, unknown>;
  /** If true, compute and return the result without writing anything. */
  dryRun: boolean;
}

export interface ApplyIntegrationResult {
  targetPath: string;
  backupPath: string | null;
  before: unknown;
  after: unknown;
  wrote: boolean;
  /** True if an entry with this name already existed and was overwritten. */
  overwroteExisting: boolean;
}

/**
 * Merges `{ mcpServers: { [serverName]: entry } }` into an existing (or
 * new) JSON file at `targetPath`, preserving every other top-level key and
 * every other entry already present under `mcpServers`. Creates a
 * timestamped backup of the original file (if any) before writing, and
 * writes atomically (temp file + rename). Never touches any file other
 * than `targetPath` and its own backup.
 */
export function applyIntegration(opts: ApplyIntegrationOptions): ApplyIntegrationResult {
  const targetPath = path.resolve(opts.targetPath);
  let before: unknown = {};
  let backupPath: string | null = null;

  if (fs.existsSync(targetPath)) {
    const raw = fs.readFileSync(targetPath, 'utf-8');
    try {
      before = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch (err) {
      throw new Error(`Refusing to modify "${targetPath}": it is not valid JSON (${(err as Error).message}). Fix it or choose a different --apply target.`);
    }
    if (typeof before !== 'object' || before === null || Array.isArray(before)) {
      throw new Error(`Refusing to modify "${targetPath}": its top level is not a JSON object.`);
    }
  }

  const beforeObj = before as Record<string, unknown>;
  const existingServers =
    typeof beforeObj.mcpServers === 'object' && beforeObj.mcpServers !== null && !Array.isArray(beforeObj.mcpServers)
      ? (beforeObj.mcpServers as Record<string, unknown>)
      : {};
  const overwroteExisting = Object.prototype.hasOwnProperty.call(existingServers, opts.serverName);

  const after: Record<string, unknown> = {
    ...beforeObj,
    mcpServers: { ...existingServers, [opts.serverName]: opts.entry },
  };

  if (opts.dryRun) {
    return { targetPath, backupPath: null, before, after, wrote: false, overwroteExisting };
  }

  if (fs.existsSync(targetPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${targetPath}.backup-${stamp}`;
    fs.copyFileSync(targetPath, backupPath);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(after, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, targetPath);

  return { targetPath, backupPath, before, after, wrote: true, overwroteExisting };
}
