// `agentgate doctor` — read-only diagnostics (Milestone 5, Phase 4).
//
// Hard invariant: this module NEVER executes a downstream MCP server,
// NEVER opens an external network connection, NEVER modifies configuration
// or policy files, NEVER creates an approval, NEVER auto-repairs a
// database, and NEVER prints a secret or auth token. Every check below is
// either a filesystem stat/read, a local-loopback port probe that
// immediately closes, or a read-only/no-op-when-current database
// inspection — see the `audit_chain` check for the specific reasoning
// about why it is safe despite not using `readonly: true` in one case.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGatewayConfig, type GatewayConfig } from '../config/registry.js';
import { AuditStorage, LATEST_SCHEMA_VERSION, readSchemaVersionReadOnly } from '../storage.js';
import { validateConfigFile } from './configValidate.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorOptions {
  configPath: string;
  /** Optional path to a generated client-integration JSON file to validate. */
  clientConfigPath?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True only if no check reported FAIL (WARN/SKIP do not block this). */
  ok: boolean;
}

function push(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
}

function gatewayPackageDir(): string {
  // Two levels up from this module (src/onboarding/doctor.ts or
  // dist/onboarding/doctor.js) is the gateway package root, in both the
  // source (tsx) and compiled (dist) layouts, since dist/ mirrors src/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function checkNodeVersion(checks: DoctorCheck[]): void {
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 20) {
    push(checks, { id: 'node_version', status: 'PASS', message: `Node.js ${process.version} (>= 20 required).` });
  } else {
    push(checks, {
      id: 'node_version',
      status: 'FAIL',
      message: `Node.js ${process.version} is below the minimum supported version (20).`,
      remediation: 'Install Node.js 20 or newer (see .nvmrc / package.json engines.node).',
    });
  }
}

function checkPlatform(checks: DoctorCheck[]): void {
  push(checks, {
    id: 'platform',
    status: 'PASS',
    message: `${os.platform()} / ${os.arch()}.`,
  });
}

function checkAgentgateVersion(checks: DoctorCheck[]): void {
  try {
    const pkgPath = path.join(gatewayPackageDir(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    push(checks, { id: 'agentgate_version', status: 'PASS', message: `@chidhvilasa/gateway ${pkg.version ?? 'unknown'}.` });
  } catch (err) {
    push(checks, {
      id: 'agentgate_version',
      status: 'WARN',
      message: `Could not read gateway package.json: ${(err as Error).message}`,
    });
  }
}

function checkPackageBuildComplete(checks: DoctorCheck[]): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, '..'); // .../dist (or .../src in dev mode)
  const required = ['cli.js', 'server.js', 'pipeline.js', 'storage.js', 'replay.js', 'api/control.js'];
  const isDist = distDir.endsWith(`${path.sep}dist`) || distDir.endsWith('/dist');
  if (!isDist) {
    push(checks, {
      id: 'package_build_complete',
      status: 'SKIP',
      message: 'Running from source (not a compiled dist/) — build completeness check does not apply.',
    });
    return;
  }
  const missing = required.filter((f) => !fs.existsSync(path.join(distDir, f)));
  if (missing.length === 0) {
    push(checks, { id: 'package_build_complete', status: 'PASS', message: 'All required compiled files are present.' });
  } else {
    push(checks, {
      id: 'package_build_complete',
      status: 'FAIL',
      message: `Missing compiled file(s): ${missing.join(', ')}.`,
      remediation: 'Run `pnpm run build` from the repository root, or reinstall the package.',
    });
  }
}

function checkConfigAndPolicy(checks: DoctorCheck[], configPath: string): GatewayConfig | null {
  if (!fs.existsSync(configPath)) {
    push(checks, {
      id: 'config_exists',
      status: 'FAIL',
      message: `Config file not found: "${configPath}".`,
      remediation: 'Run `agentgate init` to generate one, or pass the correct path.',
    });
    push(checks, { id: 'policy_valid', status: 'SKIP', message: 'Skipped — no config to read the policy path from.' });
    push(checks, { id: 'db_writable', status: 'SKIP', message: 'Skipped — no config to read the database path from.' });
    push(checks, { id: 'audit_chain', status: 'SKIP', message: 'Skipped — no config to read the database path from.' });
    push(checks, { id: 'downstream_commands', status: 'SKIP', message: 'Skipped — no config to read servers from.' });
    return null;
  }
  push(checks, { id: 'config_exists', status: 'PASS', message: `Config file found: "${configPath}".` });

  const result = validateConfigFile(configPath);
  for (const issue of result.issues) {
    push(checks, {
      id: issue.category === 'missing_file' && result.policyPath === null ? 'config_valid' : 'policy_valid',
      status: 'FAIL',
      message: issue.message,
      remediation:
        issue.category === 'syntax_error'
          ? 'Fix the YAML syntax error and re-run.'
          : issue.category === 'schema_error' || issue.category === 'policy_error'
            ? 'Fix the reported schema/policy error — see docs/POLICY_REFERENCE.md.'
            : issue.category === 'unsafe_value'
              ? 'Adjust the reported unsafe value.'
              : 'Check the reported file path exists and is readable.',
    });
  }
  if (result.valid) {
    push(checks, {
      id: 'policy_valid',
      status: 'PASS',
      message: `Config and policy are both valid (${result.summary?.servers ?? 0} downstream server(s) configured).`,
    });
  }

  if (!result.valid) return null;
  try {
    return loadGatewayConfig(configPath);
  } catch {
    return null;
  }
}

function checkDbAndChain(checks: DoctorCheck[], config: GatewayConfig, configDir: string): void {
  const dbPath = path.isAbsolute(config.db_path) ? config.db_path : path.resolve(configDir, config.db_path);
  const dbExists = fs.existsSync(dbPath);

  if (!dbExists) {
    // No database yet — check the PARENT directory is writable via a
    // throwaway probe file, created and removed immediately. Never touches
    // dbPath itself.
    const parentDir = path.dirname(dbPath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
      const probe = path.join(parentDir, `.agentgate-doctor-probe-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      push(checks, {
        id: 'db_writable',
        status: 'PASS',
        message: `No database yet at "${dbPath}" — its parent directory is writable (one will be created on first start).`,
      });
    } catch (err) {
      push(checks, {
        id: 'db_writable',
        status: 'FAIL',
        message: `Database parent directory is not writable: ${(err as Error).message}`,
        remediation: 'Choose a db_path whose parent directory you can write to, or fix its permissions.',
      });
    }
    push(checks, { id: 'audit_chain', status: 'SKIP', message: 'Skipped — no database exists yet.' });
    return;
  }

  push(checks, { id: 'db_writable', status: 'PASS', message: `Database file exists and is readable: "${dbPath}".` });

  let schemaVersion: number;
  try {
    schemaVersion = readSchemaVersionReadOnly(dbPath);
  } catch (err) {
    push(checks, {
      id: 'audit_chain',
      status: 'FAIL',
      message: `Could not read the database's schema version: ${(err as Error).message}`,
      remediation: 'Confirm this is a genuine AgentGate SQLite database, not a corrupted or unrelated file.',
    });
    return;
  }

  if (schemaVersion < LATEST_SCHEMA_VERSION) {
    push(checks, {
      id: 'audit_chain',
      status: 'WARN',
      message: `Database schema is at version ${schemaVersion}, behind the current version ${LATEST_SCHEMA_VERSION}. Doctor does not apply migrations itself.`,
      remediation: 'Run `agentgate start` normally once — it applies pending migrations automatically — then re-run doctor.',
    });
    return;
  }

  // Schema is already fully migrated, so opening it via AuditStorage makes
  // no writes (the migration loop is a no-op when already current) —
  // reusing the real verifyChain()/verifyReplayChain() implementation here
  // is deliberate: a second, hand-rolled verifier could silently drift
  // from the one that actually protects the audit trail.
  let storage: AuditStorage | null = null;
  try {
    storage = new AuditStorage(dbPath);
    const audit = storage.verifyChain();
    const replay = storage.verifyReplayChain();
    if (audit.valid && replay.valid) {
      push(checks, {
        id: 'audit_chain',
        status: 'PASS',
        message: `Audit chain (${audit.count} records) and replay lineage (${replay.count} records) both verified.`,
      });
    } else {
      push(checks, {
        id: 'audit_chain',
        status: 'FAIL',
        message: `Chain verification failed — audit: ${audit.valid ? 'ok' : audit.error}; replay: ${replay.valid ? 'ok' : replay.error}`,
        remediation: 'The database may have been modified outside AgentGate. See docs/THREAT_MODEL.md#database-replacement-by-a-local-administrator.',
      });
    }
  } catch (err) {
    push(checks, {
      id: 'audit_chain',
      status: 'FAIL',
      message: `Could not open the database for verification: ${(err as Error).message}`,
    });
  } finally {
    storage?.close();
  }
}

/** Cross-platform PATH lookup that never executes the resolved file. */
function commandResolvesOnPath(command: string): boolean {
  if (command.includes(path.sep) || command.includes('/')) {
    return fs.existsSync(command);
  }
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (fs.existsSync(candidate)) return true;
    }
  }
  return false;
}

function checkDownstreamCommands(checks: DoctorCheck[], config: GatewayConfig): void {
  const stdioServers = config.servers.filter((s) => s.transport === 'stdio');
  if (stdioServers.length === 0) {
    push(checks, { id: 'downstream_commands', status: 'SKIP', message: 'No stdio downstream servers configured.' });
    return;
  }
  const problems: string[] = [];
  for (const server of stdioServers) {
    if (server.command.includes('REPLACE_WITH_YOUR_DOWNSTREAM')) {
      problems.push(`server "${server.id}": still uses the generated placeholder command — edit agentgate.yml.`);
      continue;
    }
    if (!commandResolvesOnPath(server.command)) {
      problems.push(`server "${server.id}": command "${server.command}" was not found on PATH or as a file (not executed — resolution only).`);
    }
  }
  if (problems.length === 0) {
    push(checks, {
      id: 'downstream_commands',
      status: 'PASS',
      message: `All ${stdioServers.length} configured downstream command(s) resolve.`,
    });
  } else {
    push(checks, {
      id: 'downstream_commands',
      status: 'WARN',
      message: problems.join(' '),
      remediation: 'Edit the server command(s) in your config, or ensure the executable is installed and on PATH.',
    });
  }
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function checkPorts(checks: DoctorCheck[], config: GatewayConfig): Promise<void> {
  push(checks, {
    id: 'loopback_binding',
    status: 'PASS',
    message: 'AgentGate always binds the Control API to 127.0.0.1 — there is no configuration option to bind elsewhere.',
  });

  const gatewayFree = await isPortFree(config.gateway_port);
  const controlFree = await isPortFree(config.control_port);
  if (gatewayFree && controlFree) {
    push(checks, {
      id: 'ports_available',
      status: 'PASS',
      message: `Ports ${config.gateway_port} (gateway) and ${config.control_port} (control) are free.`,
    });
  } else {
    const busy = [!gatewayFree ? `gateway_port ${config.gateway_port}` : null, !controlFree ? `control_port ${config.control_port}` : null]
      .filter(Boolean)
      .join(', ');
    push(checks, {
      id: 'ports_available',
      status: 'WARN',
      message: `Already in use: ${busy}. (This may just be an AgentGate instance you already have running.)`,
      remediation: 'Stop the process using that port, or change gateway_port/control_port in your config.',
    });
  }
}

function checkControlCenter(checks: DoctorCheck[]): void {
  // Only meaningful when running from a source checkout of this monorepo —
  // an installed gateway package does not currently bundle the Control
  // Center at all (see the Milestone 5 installability audit in
  // docs/AI_DECISIONS.md / docs/DEVELOPMENT.md).
  const candidate = path.resolve(gatewayPackageDir(), '..', '..', 'apps', 'control-center');
  if (!fs.existsSync(candidate)) {
    push(checks, {
      id: 'control_center',
      status: 'SKIP',
      message: 'Not running from a source checkout — Control Center availability cannot be determined here.',
    });
    return;
  }
  const builtIndex = path.join(candidate, 'dist', 'index.html');
  if (fs.existsSync(builtIndex)) {
    push(checks, { id: 'control_center', status: 'PASS', message: 'Control Center production build found (apps/control-center/dist).' });
  } else {
    push(checks, {
      id: 'control_center',
      status: 'WARN',
      message: 'Control Center is not built yet.',
      remediation: 'Run `pnpm run build` (production) or `pnpm run dev:control` (development) from the repository root.',
    });
  }
}

function checkStaleArtifacts(checks: DoctorCheck[], config: GatewayConfig | null, configDir: string): void {
  if (!config) {
    push(checks, { id: 'stale_artifacts', status: 'SKIP', message: 'Skipped — no valid config to check against.' });
    return;
  }
  const dbPath = path.isAbsolute(config.db_path) ? config.db_path : path.resolve(configDir, config.db_path);
  const orphans: string[] = [];
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar) && !fs.existsSync(dbPath)) orphans.push(sidecar);
  }
  if (orphans.length > 0) {
    push(checks, {
      id: 'stale_artifacts',
      status: 'WARN',
      message: `Found orphaned SQLite sidecar file(s) with no matching database: ${orphans.join(', ')}.`,
      remediation: 'Safe to delete manually if you do not recognize them.',
    });
  } else {
    push(checks, { id: 'stale_artifacts', status: 'PASS', message: 'No orphaned runtime artifacts found next to the configured database.' });
  }
}

function checkClientConfig(checks: DoctorCheck[], clientConfigPath: string | undefined): void {
  if (!clientConfigPath) {
    push(checks, { id: 'client_integration', status: 'SKIP', message: 'No --client-config path supplied.' });
    return;
  }
  if (!fs.existsSync(clientConfigPath)) {
    push(checks, { id: 'client_integration', status: 'FAIL', message: `Client config file not found: "${clientConfigPath}".` });
    return;
  }
  try {
    const raw = fs.readFileSync(clientConfigPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !('mcpServers' in parsed)) {
      push(checks, {
        id: 'client_integration',
        status: 'FAIL',
        message: `"${clientConfigPath}" is valid JSON but has no top-level "mcpServers" object.`,
      });
      return;
    }
    push(checks, { id: 'client_integration', status: 'PASS', message: `"${clientConfigPath}" is valid JSON with an "mcpServers" object.` });
  } catch (err) {
    push(checks, { id: 'client_integration', status: 'FAIL', message: `"${clientConfigPath}" is not valid JSON: ${(err as Error).message}` });
  }
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checkNodeVersion(checks);
  checkPlatform(checks);
  checkAgentgateVersion(checks);
  checkPackageBuildComplete(checks);

  const configDir = path.dirname(path.resolve(opts.configPath));
  const config = checkConfigAndPolicy(checks, opts.configPath);

  if (config) {
    checkDbAndChain(checks, config, configDir);
    checkDownstreamCommands(checks, config);
    await checkPorts(checks, config);
  }
  checkControlCenter(checks);
  checkStaleArtifacts(checks, config, configDir);
  checkClientConfig(checks, opts.clientConfigPath);

  const ok = checks.every((c) => c.status !== 'FAIL');
  return { checks, ok };
}
