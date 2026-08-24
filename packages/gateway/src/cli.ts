#!/usr/bin/env node
import { startGateway } from './server.js';
import { validatePolicy, sanitizeErrorMessage, loadPolicyFile } from '@agentgate/policy';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const [, , command, ...rawArgs] = process.argv;

/** Strips known boolean flags out of positional args, returning both. */
function splitFlags(args: string[], flagNames: string[]): { positional: string[]; flags: Set<string> } {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const a of args) {
    if (flagNames.includes(a)) flags.add(a);
    else positional.push(a);
  }
  return { positional, flags };
}

/** Extracts a `--flag value` pair from args, returning the value and the remaining args (flag+value removed). */
function extractValueFlag(args: string[], flagName: string): { value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flagName);
  if (idx === -1) return { value: undefined, rest: args };
  const value = args[idx + 1];
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, rest };
}

/** Always double-quotes a path for display in a printed shell command — safe, readable across bash/PowerShell/cmd for ordinary paths, including ones with spaces or Unicode. */
function quotePath(p: string): string {
  return `"${p}"`;
}

function reportFatal(err: unknown): void {
  console.error('[agentgate] Fatal:', sanitizeErrorMessage(err, { source: 'internal' }).message);
  process.exitCode = 1;
}

function resolveDbPath(configPath: string): string {
  let dbPath = './agentgate.sqlite';
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { db_path?: string } | undefined;
    if (parsed?.db_path) dbPath = parsed.db_path;
  } catch {
    // use default
  }
  return dbPath;
}

const args = rawArgs;

switch (command) {
  case 'start': {
    const configPath = args[0] ?? './agentgate.yml';
    startGateway(configPath).catch((err) => {
      // A startup failure here is almost always a bad config/policy path on
      // the operator's own machine, but route it through the same canonical
      // sanitizer as every other gateway log line for consistency (ADR-0009).
      console.error('[agentgate] Fatal:', sanitizeErrorMessage(err, { source: 'internal' }).message);
      process.exit(1);
    });
    break;
  }

  case 'validate': {
    const policyPath = args[0] ?? './agentgate.policy.yml';
    let raw: string;
    try {
      raw = fs.readFileSync(policyPath, 'utf-8');
    } catch (err) {
      console.error(`Cannot read policy file: ${(err as Error).message}`);
      process.exit(1);
    }
    const parsed = yaml.load(raw);
    const result = validatePolicy(parsed);
    if (result.valid) {
      console.log(`✅ Policy "${policyPath}" is valid.`);
      for (const w of result.warnings) console.warn(`  ⚠️  ${w}`);
      process.exit(0);
    } else {
      console.error(`❌ Policy "${policyPath}" has errors:`);
      for (const e of result.errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    break;
  }

  case 'audit': {
    const sub = args[0];
    if (sub === 'verify') {
      const configPath = args[1] ?? './agentgate.yml';
      const dbPath = resolveDbPath(configPath);
      import('./storage.js')
        .then(({ AuditStorage }) => {
          const storage = new AuditStorage(dbPath);
          const auditResult = storage.verifyChain();
          const replayResult = storage.verifyReplayChain();
          storage.close();

          if (auditResult.valid) {
            console.log(`✅ Audit chain verified. ${auditResult.count} records intact.`);
          } else {
            console.error(`❌ Audit chain verification failed!`);
            console.error(`   Error: ${auditResult.error}`);
          }

          // ADR-0010: replay lineage is a separate chain, verified alongside
          // the audit chain by the same command rather than requiring a
          // second, easy-to-forget invocation.
          if (replayResult.valid) {
            console.log(`✅ Replay lineage verified. ${replayResult.count} records intact.`);
          } else {
            console.error(`❌ Replay lineage verification failed!`);
            console.error(`   Error: ${replayResult.error}`);
          }

          process.exit(auditResult.valid && replayResult.valid ? 0 : 1);
        })
        .catch((err: unknown) => {
          console.error('[agentgate] Fatal:', sanitizeErrorMessage(err, { source: 'internal' }).message);
          process.exit(1);
        });
      break;
    }
    console.error('Unknown audit subcommand. Try: agentgate audit verify');
    process.exit(1);
    break;
  }

  case 'replay': {
    // ADR-0010: Safe Replay is policy re-evaluation only, permanently. There
    // is intentionally no --execute, --no-dry-run, or equivalent flag here,
    // and never will be for this command — see docs/AI_DECISIONS.md.
    const { positional, flags } = splitFlags(args, ['--json']);
    const eventId = positional[0];
    const configPath = positional[1] ?? './agentgate.yml';
    const asJson = flags.has('--json');

    if (!eventId) {
      console.error('Usage: agentgate replay <event-id> [config.yml] [--json]');
      process.exit(1);
      break;
    }

    Promise.all([import('./storage.js'), import('./replay.js')])
      .then(([{ AuditStorage }, { evaluateHistoricalEvent, ReplayUnsupportedEventError }]) => {
        const dbPath = resolveDbPath(configPath);
        const storage = new AuditStorage(dbPath);
        try {
          const sourceEvent = storage.getEvent(eventId);
          if (!sourceEvent) {
            console.error(`❌ No event found with id "${eventId}".`);
            process.exitCode = 1;
            return;
          }

          let currentPolicy;
          try {
            currentPolicy = loadPolicyFile(resolvePolicyPath(configPath));
          } catch (err) {
            console.error(`❌ Could not load current policy: ${sanitizeErrorMessage(err, { source: 'internal' }).message}`);
            process.exitCode = 1;
            return;
          }

          let comparison;
          try {
            comparison = evaluateHistoricalEvent({ sourceEvent, currentPolicy });
          } catch (err) {
            if (err instanceof ReplayUnsupportedEventError) {
              console.error(`❌ ${err.message}`);
              process.exitCode = 1;
              return;
            }
            throw err;
          }

          const stored = storage.insertReplayEvaluation({
            source_event_id: eventId,
            evaluated_at: comparison.evaluated_at,
            policy_digest: comparison.policy_digest,
            original_decision_type: comparison.original.decision_type,
            original_rule_id: comparison.original.matched_rule_id,
            original_reason_code: comparison.original.reason_code,
            current_decision_type: comparison.current.decision_type,
            current_rule_id: comparison.current.matched_rule_id,
            current_reason_code: comparison.current.reason_code,
            current_explanation: comparison.current.explanation,
            current_transformations: comparison.current.transformations,
            decision_changed: comparison.decision_changed,
            matched_rule_changed: comparison.matched_rule_changed,
            reason_code_changed: comparison.reason_code_changed,
            source_arguments_redacted: comparison.source_arguments_redacted,
            limitations: comparison.limitations,
          });

          if (asJson) {
            console.log(
              JSON.stringify(
                {
                  replay_id: stored.id,
                  source_event_id: eventId,
                  evaluated_at: stored.evaluated_at,
                  mode: 'policy_only',
                  executed: false,
                  source_arguments_redacted: comparison.source_arguments_redacted,
                  policy_digest: comparison.policy_digest,
                  original: comparison.original,
                  current: comparison.current,
                  decision_changed: comparison.decision_changed,
                  matched_rule_changed: comparison.matched_rule_changed,
                  reason_code_changed: comparison.reason_code_changed,
                  comparison: comparison.comparison,
                  limitations: comparison.limitations,
                },
                null,
                2
              )
            );
          } else {
            console.log('AgentGate Safe Replay — policy re-evaluation only');
            console.log('');
            console.log(`Source event:              ${eventId}`);
            console.log('Mode:                       POLICY ONLY');
            console.log('Executed:                   NO');
            console.log(`Source arguments redacted:  ${comparison.source_arguments_redacted ? 'YES' : 'NO'}`);
            console.log(`Policy digest:              ${comparison.policy_digest}`);
            console.log('');
            console.log(`Original decision:          ${comparison.original.decision_type ?? '(none recorded)'}`);
            console.log(`Original matched rule:      ${comparison.original.matched_rule_id ?? '(none)'}`);
            console.log(`Current decision:           ${comparison.current.decision_type}`);
            console.log(`Current matched rule:       ${comparison.current.matched_rule_id ?? '(none)'}`);
            console.log('');
            console.log(`Changed:                    ${comparison.decision_changed ? 'YES' : 'NO'}`);
            console.log(`Comparison:                 ${comparison.comparison}`);
            console.log('');
            console.log('Limitations:');
            for (const l of comparison.limitations) console.log(`  - ${l}`);
            console.log('');
            console.log(`Replay evaluation ID:       ${stored.id}`);
          }
          process.exitCode = 0;
        } finally {
          storage.close();
        }
      })
      .catch((err: unknown) => {
        console.error('[agentgate] Fatal:', sanitizeErrorMessage(err, { source: 'internal' }).message);
        process.exitCode = 1;
      });
    break;
  }

  case 'init': {
    const { positional, flags } = splitFlags(args, ['--force', '--help', '-h']);
    if (flags.has('--help') || flags.has('-h')) {
      console.log(`Usage: agentgate init [directory] [--force]

Generates a deny-by-default AgentGate config (agentgate.yml) and starter
policy (agentgate.policy.yml) in [directory] (default: current directory).
Never overwrites an existing file unless --force is passed. Non-interactive
and deterministic — see docs/DEVELOPMENT.md for interactive-mode status.`);
      process.exitCode = 0;
      break;
    }
    const targetDir = positional[0] ?? '.';
    import('./onboarding/init.js')
      .then(({ runInit }) => {
        const result = runInit({ targetDir, force: flags.has('--force') });
        for (const f of result.files) {
          if (f.action === 'written') {
            console.log(`✅ Wrote ${f.relativePath}`);
          } else {
            console.log(`⏭  Skipped ${f.relativePath} — already exists (pass --force to overwrite)`);
          }
        }
        if (!result.ok) {
          console.log('');
          console.log('One or more files already existed and were not overwritten. Re-run with --force to overwrite them, or choose a different directory.');
          process.exitCode = 1;
          return;
        }
        const configPath = path.join(result.targetDir, 'agentgate.yml');
        console.log('');
        console.log('Next steps:');
        console.log(`  1. Edit ${quotePath(configPath)} — replace the placeholder downstream server command.`);
        console.log(`  2. agentgate config validate ${quotePath(configPath)}`);
        console.log(`  3. agentgate doctor ${quotePath(configPath)}`);
        console.log(`  4. agentgate start ${quotePath(configPath)}`);
        console.log('');
        console.log('Or, to verify AgentGate itself works right now without editing anything: agentgate smoke-test');
        process.exitCode = 0;
      })
      .catch(reportFatal);
    break;
  }

  case 'config': {
    const sub = args[0];
    if (sub === 'validate') {
      const rest = args.slice(1);
      const { positional, flags } = splitFlags(rest, ['--json', '--help', '-h']);
      if (flags.has('--help') || flags.has('-h')) {
        console.log(`Usage: agentgate config validate [config.yml] [--json]

Validates a gateway config and its referenced policy file using the exact
same loaders \`agentgate start\` uses. Exits 0 only when the configuration
is usable.`);
        process.exitCode = 0;
        break;
      }
      const configPath = positional[0] ?? './agentgate.yml';
      import('./onboarding/configValidate.js')
        .then(({ validateConfigFile }) => {
          const result = validateConfigFile(configPath);
          if (flags.has('--json')) {
            console.log(JSON.stringify(result, null, 2));
          } else if (result.valid) {
            console.log(`✅ Config "${configPath}" is valid.`);
            console.log(`   Policy: "${result.policyPath}"`);
            console.log(`   Downstream servers: ${result.summary?.servers ?? 0}`);
          } else {
            console.error(`❌ Config "${configPath}" is invalid:`);
            for (const issue of result.issues) console.error(`  [${issue.category}] ${issue.message}`);
          }
          process.exitCode = result.valid ? 0 : 1;
        })
        .catch(reportFatal);
      break;
    }
    console.error('Unknown config subcommand. Try: agentgate config validate [config.yml]');
    process.exitCode = 1;
    break;
  }

  case 'doctor': {
    const { value: clientConfigPath, rest } = extractValueFlag(args, '--client-config');
    const { positional, flags } = splitFlags(rest, ['--json', '--help', '-h']);
    if (flags.has('--help') || flags.has('-h')) {
      console.log(`Usage: agentgate doctor [config.yml] [--client-config <path>] [--json]

Read-only diagnostics. Never executes a downstream server, never opens a
network connection, never modifies configuration or the database. Exits 0
only when no check reports FAIL (WARN/SKIP do not block).`);
      process.exitCode = 0;
      break;
    }
    const configPath = positional[0] ?? './agentgate.yml';
    import('./onboarding/doctor.js')
      .then(async ({ runDoctor }) => {
        const report = await runDoctor({ configPath, clientConfigPath });
        if (flags.has('--json')) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const c of report.checks) {
            const icon = c.status === 'PASS' ? '✅' : c.status === 'WARN' ? '⚠️ ' : c.status === 'SKIP' ? '⏭ ' : '❌';
            console.log(`${icon} [${c.status}] ${c.id}: ${c.message}`);
            if (c.remediation) console.log(`      → ${c.remediation}`);
          }
          console.log('');
          console.log(report.ok ? '✅ No blocking issues found.' : '❌ One or more checks failed — see above.');
        }
        process.exitCode = report.ok ? 0 : 1;
      })
      .catch(reportFatal);
    break;
  }

  case 'integrate': {
    const clientArg = args[0];
    let rest = args.slice(1);
    const configFlag = extractValueFlag(rest, '--config');
    rest = configFlag.rest;
    const cliPathFlag = extractValueFlag(rest, '--cli-path');
    rest = cliPathFlag.rest;
    const outFlag = extractValueFlag(rest, '--out');
    rest = outFlag.rest;
    const applyFlag = extractValueFlag(rest, '--apply');
    rest = applyFlag.rest;
    const nameFlag = extractValueFlag(rest, '--name');
    rest = nameFlag.rest;
    const { positional, flags } = splitFlags(rest, ['--dry-run', '--help', '-h']);

    if (!clientArg || flags.has('--help') || flags.has('-h')) {
      console.log(`Usage: agentgate integrate <client> [config.yml] [--cli-path <path>] [--name <name>]
                                            [--out <file> | --apply <file> [--dry-run]]

Generates an MCP client integration snippet. Supported clients: claude-code,
antigravity (both verified against current official docs — see
docs/DEVELOPMENT.md for sources), generic (unverified, labeled recipe).

Default behavior prints the snippet only. --out writes it to a NEW file you
name explicitly. --apply merges it into an existing client config file —
always backs up the original first, writes atomically, and preserves every
unrelated entry; add --dry-run to preview without writing.`);
      process.exitCode = clientArg ? 0 : 1;
      break;
    }

    import('./onboarding/integrate.js')
      .then(({ buildIntegration, applyIntegration, SUPPORTED_CLIENTS }) => {
        if (!SUPPORTED_CLIENTS.includes(clientArg as (typeof SUPPORTED_CLIENTS)[number])) {
          console.error(`Unknown client "${clientArg}". Supported: ${SUPPORTED_CLIENTS.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        const configPath = configFlag.value ?? positional[0] ?? './agentgate.yml';
        const cliPath = cliPathFlag.value ?? fileURLToPath(import.meta.url);
        const result = buildIntegration({
          client: clientArg as (typeof SUPPORTED_CLIENTS)[number],
          configPath,
          cliPath,
          serverName: nameFlag.value,
        });

        if (!result.verified) {
          console.error(`⚠️  "${result.client}" is a GENERIC recipe — not verified against a specific product's current documentation.`);
        }

        if (applyFlag.value) {
          const parsedEntry = (JSON.parse(result.fileContent) as { mcpServers: Record<string, Record<string, unknown>> })
            .mcpServers[result.serverName];
          const applied = applyIntegration({
            targetPath: applyFlag.value,
            serverName: result.serverName,
            entry: parsedEntry,
            dryRun: flags.has('--dry-run'),
          });
          if (flags.has('--dry-run')) {
            console.log('Preview (dry run — nothing was written):');
            console.log(JSON.stringify(applied.after, null, 2));
          } else {
            console.log(`✅ Updated "${applied.targetPath}".`);
            if (applied.backupPath) console.log(`   Backup of the previous file: "${applied.backupPath}"`);
            if (applied.overwroteExisting) console.log(`   Note: an existing "${result.serverName}" entry was overwritten.`);
          }
        } else if (outFlag.value) {
          if (fs.existsSync(outFlag.value)) {
            console.error(`❌ "${outFlag.value}" already exists. Choose a different --out path, or use --apply to merge instead.`);
            process.exitCode = 1;
            return;
          }
          fs.writeFileSync(outFlag.value, result.fileContent, 'utf-8');
          console.log(`✅ Wrote ${outFlag.value}`);
        } else {
          console.log(result.fileContent);
        }
        console.log(`# Target file: ${result.targetFileHint}`);
        console.log(`# Scope: ${result.scopeNote}`);
        console.log(`# Remove: ${result.removalNote}`);
        console.log(`# Source: ${result.sourceUrl ?? 'UNVERIFIED — generic recipe, confirm against your client\'s own docs'}`);
        process.exitCode = 0;
      })
      .catch(reportFatal);
    break;
  }

  case 'smoke-test': {
    const { flags } = splitFlags(args, ['--json', '--help', '-h']);
    if (flags.has('--help') || flags.has('-h')) {
      console.log(`Usage: agentgate smoke-test [--json]

Local, offline, harmless proof that the policy engine and audit trail
work. Uses AgentGate's own built-in fixture downstream server — never your
real downstream servers or the network. Self-cleaning on success and
failure.`);
      process.exitCode = 0;
      break;
    }
    import('./onboarding/smokeTest.js')
      .then(async ({ runSmokeTest }) => {
        const report = await runSmokeTest();
        if (flags.has('--json')) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log('AgentGate smoke test — local, offline, harmless.');
          console.log('');
          for (const s of report.steps) console.log(`${s.ok ? '✅' : '❌'} ${s.id}: ${s.message}`);
          console.log('');
          console.log(report.ok ? '🎉 Smoke test passed — AgentGate is working correctly.' : '❌ Smoke test failed — see above.');
        }
        process.exitCode = report.ok ? 0 : 1;
      })
      .catch(reportFatal);
    break;
  }

  case '--version':
  case '-v': {
    try {
      const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
      console.log(pkg.version ?? 'unknown');
      process.exitCode = 0;
    } catch (err) {
      reportFatal(err);
    }
    break;
  }

  default: {
    console.log(`
AgentGate — The open-source firewall for AI agents.

Getting started:
  agentgate init [directory] [--force]       Generate a deny-by-default config + policy
  agentgate config validate [config.yml]     Validate a config and its policy before starting
  agentgate doctor [config.yml]              Read-only diagnostics (never executes, never mutates)
  agentgate integrate <client> [config.yml]  Generate an MCP client integration snippet
                                              (clients: claude-code, antigravity, generic)
  agentgate smoke-test                       Harmless, offline, built-in proof AgentGate works

Running:
  agentgate start [config.yml]               Start the gateway (default: agentgate.yml)
  agentgate validate [policy.yml]            Validate a policy file only (see also: config validate)
  agentgate audit verify [config]            Verify the tamper-evident audit chain and replay lineage
  agentgate replay <event-id> [config]       Safe Replay: re-evaluate a historical event against the
                                              current policy. Policy re-evaluation only — never executes
                                              the tool. Add --json for machine-readable output.

  agentgate --version                        Print the installed version
  agentgate <command> --help                 Print detailed usage for a command

See docs/QUICKSTART.md for a full walkthrough.
`);
    process.exit(0);
  }
}

/** Resolves a policy file path given a gateway config path, mirroring loadGatewayConfig's own policy field lookup. */
function resolvePolicyPath(configPath: string): string {
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { policy?: string } | undefined;
    return parsed?.policy ?? './agentgate.policy.yml';
  } catch {
    return './agentgate.policy.yml';
  }
}
