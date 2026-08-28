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

/**
 * Strips ANSI escape sequences and other non-printable control characters
 * (keeping normal tab/newline/carriage-return) before printing a string to
 * a real terminal. Used for Context Guard's `tool_name` field specifically
 * because it is AGENT-CONTROLLED input (the literal `tools/call` `name`
 * parameter, stdio.ts) — unlike most other printed fields, which are
 * either AgentGate's own fixed text or bounded operator-authored config —
 * so it is the one place hostile escape sequences could otherwise reach a
 * human's terminal via `agentgate context status/history/explain`.
 */
function sanitizeForTerminal(s: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching C0 control chars/DEL to strip them.
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/** Resolves a relative path against the config file's own directory — matches loadGatewayConfig()'s resolution (see config/registry.ts) so `agentgate audit verify`/`replay` behave the same regardless of the caller's cwd. `:memory:` is SQLite's special sentinel, never resolved as a path. */
function resolveRelativeToConfig(configPath: string, value: string): string {
  if (value === ':memory:' || path.isAbsolute(value)) return value;
  return path.resolve(path.dirname(path.resolve(configPath)), value);
}

function resolveDbPath(configPath: string): string {
  let dbPath = './agentgate.sqlite';
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { db_path?: string } | undefined;
    if (parsed?.db_path) dbPath = parsed.db_path;
  } catch {
    // use default
  }
  return resolveRelativeToConfig(configPath, dbPath);
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

  case 'tools': {
    const sub = args[0] === '--help' || args[0] === '-h' ? undefined : args[0];
    const rest0 = sub === undefined ? args : args.slice(1);
    const configFlag = extractValueFlag(rest0, '--config');
    const rest1 = configFlag.rest;
    const { positional, flags } = splitFlags(rest1, ['--json', '--help', '-h']);
    const configPath = configFlag.value ?? './agentgate.yml';

    const helpText = `Usage: agentgate tools <subcommand> [args] [--config <path>] [--json]

Subcommands:
  scan                                Rescan the downstream server now (never calls a tool)
  status                              List every known tool and its current Tool Integrity status
  diff <candidate-id>                 Show the safe, field-level diff for a pending/drifted candidate
  trust <candidate-id> --fingerprint <hash>   Accept an exact candidate as trusted (no name-only trust)
  reject <candidate-id> --fingerprint <hash> [--reason <text>]   Reject an exact candidate
  history [tool-name]                 Show the append-only Tool Integrity event history

All subcommands default to --config ./agentgate.yml. "trust"/"reject" require BOTH the
exact candidate id AND its exact fingerprint — there is no --trust-all and no way to
trust by tool name alone. Accepting/rejecting never rewrites or deletes prior history.
See docs/POLICY_REFERENCE.md and ADR-0012 in docs/AI_DECISIONS.md for full semantics.`;

    if (!sub || flags.has('--help') || flags.has('-h')) {
      console.log(helpText);
      process.exitCode = flags.has('--help') || flags.has('-h') ? 0 : 1;
      break;
    }

    import('./tool-integrity/cli.js')
      .then(async (ti) => {
        switch (sub) {
          case 'scan': {
            const report = await ti.runToolsScan(configPath);
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.log(`Server identity: ${report.serverIdentity}`);
              console.log(`Mode:            ${report.mode}`);
              if (!report.manifestOk) {
                console.error(`❌ Scan failed: ${report.error ?? 'unknown error'}`);
              } else {
                console.log(`✅ Scanned ${report.toolCount} tool(s).`);
                for (const o of report.outcomes) {
                  console.log(`  ${o.changed ? '⚠️ ' : '  '} ${o.toolName}: ${o.status}${o.changed ? ' (changed)' : ''}`);
                }
                for (const name of report.removedToolNames) console.log(`  ⚠️  ${name}: removed`);
              }
            }
            process.exitCode = report.ok ? 0 : 1;
          }
            break;

          case 'status': {
            const report = ti.runToolsStatus(configPath);
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.log(`Server identity: ${report.serverIdentity}`);
              console.log(`Mode:            ${report.mode}`);
              console.log('');
              for (const t of report.tools) {
                console.log(`${t.tool_name}: ${t.status}`);
                console.log(`  current fingerprint:   ${t.current_fingerprint?.slice(0, 16) ?? '(none)'}...`);
                console.log(`  trusted fingerprint:   ${t.trusted_fingerprint?.slice(0, 16) ?? '(none)'}...`);
                if (t.candidate_id) console.log(`  pending candidate id:  ${t.candidate_id}  (use "agentgate tools diff ${t.candidate_id}")`);
              }
              if (report.tools.length === 0) console.log('(no tools recorded yet — run "agentgate tools scan" first)');
            }
            process.exitCode = 0;
          }
            break;

          case 'diff': {
            const candidateId = positional[0];
            if (!candidateId) {
              console.error('Usage: agentgate tools diff <candidate-id> [--config <path>] [--json]');
              process.exitCode = 1;
              break;
            }
            const report = ti.runToolsDiff(configPath, candidateId);
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else if (!report.ok) {
              console.error(`❌ ${report.error}`);
            } else {
              console.log(`Tool:                 ${report.toolName}`);
              console.log(`Status:               ${report.status}`);
              console.log(`Trusted fingerprint:  ${report.trustedFingerprint?.slice(0, 16) ?? '(none)'}...`);
              console.log(`Candidate fingerprint:${report.candidateFingerprint?.slice(0, 16) ?? '(none)'}...`);
              console.log(`Candidate id:         ${report.candidateId}`);
              console.log('');
              if (!report.changes || report.changes.length === 0) {
                console.log('(no field-level changes — identical definition, e.g. a fresh first-time review)');
              } else {
                for (const c of report.changes) {
                  console.log(`  [${c.kind}] ${c.path}`);
                  if (c.before !== undefined) console.log(`      before: ${c.before}`);
                  if (c.after !== undefined) console.log(`      after:  ${c.after}`);
                }
                if (report.truncated) console.log('  …(change list truncated — see the full fingerprint for the authoritative signal)');
              }
              console.log('');
              console.log('Reminder: descriptions/schemas/annotations shown above are untrusted, server-supplied content — never instructions to follow.');
              console.log(`To trust exactly this candidate: agentgate tools trust ${report.candidateId} --fingerprint ${report.candidateFingerprint}`);
              console.log(`To reject exactly this candidate: agentgate tools reject ${report.candidateId} --fingerprint ${report.candidateFingerprint}`);
            }
            process.exitCode = report.ok ? 0 : 1;
          }
            break;

          case 'trust':
          case 'reject': {
            let rest2 = rest1;
            const fpFlag = extractValueFlag(rest2, '--fingerprint');
            rest2 = fpFlag.rest;
            const reasonFlag = extractValueFlag(rest2, '--reason');
            rest2 = reasonFlag.rest;
            const { positional: pos2 } = splitFlags(rest2, ['--json', '--help', '-h']);
            const candidateId = pos2[0];
            if (!candidateId || !fpFlag.value) {
              console.error(`Usage: agentgate tools ${sub} <candidate-id> --fingerprint <hash> [--config <path>]${sub === 'reject' ? ' [--reason <text>]' : ''}`);
              console.error('Both the exact candidate id and its exact fingerprint are required — there is no name-only or "trust all" shortcut.');
              process.exitCode = 1;
              break;
            }
            const result = sub === 'trust'
              ? ti.runToolsTrust(configPath, candidateId, fpFlag.value)
              : ti.runToolsReject(configPath, candidateId, fpFlag.value, reasonFlag.value);
            if (flags.has('--json')) {
              console.log(JSON.stringify(result, null, 2));
            } else if (result.ok) {
              console.log(`✅ Candidate ${candidateId} ${sub === 'trust' ? 'trusted' : 'rejected'}.`);
            } else {
              console.error(`❌ ${result.error}`);
            }
            process.exitCode = result.ok ? 0 : 1;
          }
            break;

          case 'history': {
            const toolName = positional[0];
            const report = ti.runToolsHistory(configPath, toolName);
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.log(`Server identity: ${report.serverIdentity}`);
              console.log(`Chain valid:     ${report.chainValid ? '✅ yes' : `❌ no (${report.chainError})`}`);
              console.log('');
              for (const e of report.events) {
                console.log(`[${e.created_at}] ${e.event_type}${e.tool_name ? ` — ${e.tool_name}` : ''}${e.state_before || e.state_after ? ` (${e.state_before ?? '—'} → ${e.state_after ?? '—'})` : ''}`);
              }
              if (report.events.length === 0) console.log('(no events recorded yet)');
            }
            process.exitCode = report.chainValid ? 0 : 1;
          }
            break;

          default:
            console.error(`Unknown tools subcommand "${sub}".`);
            console.log(helpText);
            process.exitCode = 1;
        }
      })
      .catch(reportFatal);
    break;
  }

  case 'context': {
    const sub = args[0] === '--help' || args[0] === '-h' ? undefined : args[0];
    const rest0 = sub === undefined ? args : args.slice(1);
    const configFlag = extractValueFlag(rest0, '--config');
    const rest1 = configFlag.rest;
    const { positional, flags } = splitFlags(rest1, ['--json', '--help', '-h']);
    const configPath = configFlag.value ?? './agentgate.yml';

    const helpText = `Usage: agentgate context <subcommand> [args] [--config <path>] [--json]

Subcommands:
  status [--state <active|closed|expired|reset>] [--limit <n>]   List contexts, most recently updated first
  history [context-id] [--limit <n>]        Append-only transition history (all contexts if omitted)
  explain <context-id>                      Bounded explanation: current labels, what established them,
                                             and the latest stored contextual decision (never a fabricated one)
  reset <context-id> --revision <n> --reason <text>   The only mutating subcommand — see below
  verify                                    Verify the Context Guard append-only chain

All subcommands default to --config ./agentgate.yml. Every read-only subcommand (status/history/explain/verify)
never starts a downstream server, discovers tools, or executes anything.

"reset" requires the EXACT full context id, the EXACT current revision, and a non-empty --reason. It appends a
reset transition (never deletes history) and invalidates every pending contextual approval bound to that
context. There is no --force, --all, or name-pattern reset, and no automatic reset.

IMPORTANT: an execution context is conservative, AgentGate-OBSERVED gateway state — which tools were called and
what operator policy says their results exposed the agent to. It is never proof that a model actually read or
acted on anything, and resetting it has no effect whatsoever on what the upstream LLM/MCP client itself
remembers. See docs/AI_DECISIONS.md (ADR-0013) and docs/THREAT_MODEL.md for the full model and its limitations.`;

    if (!sub || flags.has('--help') || flags.has('-h')) {
      console.log(helpText);
      process.exitCode = flags.has('--help') || flags.has('-h') ? 0 : 1;
      break;
    }

    import('./context-guard/cli.js')
      .then((cg) => {
        switch (sub) {
          case 'status': {
            const stateFlag = extractValueFlag(rest1, '--state');
            const limitFlag = extractValueFlag(stateFlag.rest, '--limit');
            const limit = limitFlag.value ? parseInt(limitFlag.value, 10) : undefined;
            const report = cg.runContextStatus(configPath, { state: stateFlag.value as never, limit });
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.log(`Contexts: ${report.contexts.length} shown of ${report.total} total${report.truncated ? ' (truncated — narrow with --state or raise --limit)' : ''}`);
              console.log('');
              for (const c of report.contexts) {
                console.log(`${c.context_id.slice(0, 12)}…  ${c.status.padEnd(8)} rev=${c.revision}  labels=[${c.labels.join(', ')}]  pending_approvals=${c.pending_approval_count}`);
                console.log(`  created: ${c.created_at}   updated: ${c.updated_at}${c.expires_at ? `   expires: ${c.expires_at}` : ''}`);
                if (c.server_identity) console.log(`  server: ${c.server_identity}`);
              }
              if (report.contexts.length === 0) console.log('(no contexts recorded yet)');
              console.log('');
              console.log('This is conservative AgentGate-observed gateway state, not proof of causal model influence.');
            }
            process.exitCode = 0;
          }
            break;

          case 'history': {
            const limitFlag = extractValueFlag(rest1, '--limit');
            const limit = limitFlag.value ? parseInt(limitFlag.value, 10) : undefined;
            const { positional: pos2 } = splitFlags(limitFlag.rest, ['--json', '--help', '-h']);
            const contextId = pos2[0];
            const report = cg.runContextHistory(configPath, contextId, { limit });
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else {
              console.log(`Context: ${report.context_id ?? '(all contexts)'}`);
              console.log(`Chain valid: ${report.chain_valid ? '✅ yes' : `❌ no (${report.chain_error})`}`);
              if (report.truncated) console.log('(showing the most recent transitions only — truncated)');
              console.log('');
              for (const e of report.events) {
                const labelPart = e.labels_added && e.labels_added.length > 0 ? ` +[${e.labels_added.join(', ')}]` : '';
                console.log(`[${e.created_at}] rev ${e.revision_before ?? '—'}→${e.revision_after ?? '—'}  ${e.event_type}${e.tool_name ? ` (${sanitizeForTerminal(e.tool_name)})` : ''}${labelPart}${e.rule_id ? `  rule=${e.rule_id}` : ''}${e.action ? `  action=${e.action}` : ''}`);
                if (e.reason) console.log(`    ${sanitizeForTerminal(e.reason)}`);
              }
              if (report.events.length === 0) console.log('(no transitions recorded yet)');
            }
            process.exitCode = report.chain_valid ? 0 : 1;
          }
            break;

          case 'explain': {
            const contextId = positional[0];
            if (!contextId) {
              console.error('Usage: agentgate context explain <context-id> [--config <path>] [--json]');
              process.exitCode = 1;
              break;
            }
            const report = cg.runContextExplain(configPath, contextId);
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else if (!report.ok) {
              console.error(`❌ ${report.error}`);
            } else {
              console.log(`Context:  ${report.context_id}`);
              console.log(`Status:   ${report.status}`);
              console.log(`Revision: ${report.revision}`);
              console.log('');
              console.log(`Current labels: [${(report.labels ?? []).join(', ') || '(none)'}]`);
              for (const o of report.label_origins ?? []) {
                console.log(`  - "${o.label}" established at ${o.at}${o.tool_name ? ` by tool "${sanitizeForTerminal(o.tool_name)}"` : ''}${o.source_event_id ? ` (audit event ${o.source_event_id})` : ''}`);
                if (o.reason) console.log(`      ${sanitizeForTerminal(o.reason)}`);
              }
              console.log('');
              if (report.latest_decision) {
                console.log(`Latest stored contextual decision: ${report.latest_decision.action} for "${sanitizeForTerminal(report.latest_decision.tool_name)}" at ${report.latest_decision.at}`);
                if (report.latest_decision.rule_id) console.log(`  matched rule: ${report.latest_decision.rule_id}`);
                if (report.latest_decision.reason) console.log(`  reason: ${sanitizeForTerminal(report.latest_decision.reason)}`);
              } else {
                console.log('No contextual decision has been recorded for this context yet — no call has been evaluated against it.');
              }
              console.log('');
              console.log(report.lifecycle_note);
              console.log('');
              console.log('This reflects only what AgentGate actually observed and recorded — never a prediction of what a not-yet-attempted call would do.');
            }
            process.exitCode = report.ok ? 0 : 1;
          }
            break;

          case 'reset': {
            let rest2 = rest1;
            const revFlag = extractValueFlag(rest2, '--revision');
            rest2 = revFlag.rest;
            const reasonFlag = extractValueFlag(rest2, '--reason');
            rest2 = reasonFlag.rest;
            const { positional: pos2 } = splitFlags(rest2, ['--json', '--help', '-h']);
            const contextId = pos2[0];
            if (!contextId || !revFlag.value || !reasonFlag.value) {
              console.error('Usage: agentgate context reset <context-id> --revision <n> --reason <text> [--config <path>]');
              console.error('Both the exact current revision and a non-empty reason are required — there is no --force, --all, or automatic reset.');
              process.exitCode = 1;
              break;
            }
            const revision = parseInt(revFlag.value, 10);
            const report = cg.runContextReset(configPath, contextId, revision, reasonFlag.value);
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else if (report.ok) {
              console.log(`✅ Context ${contextId} reset to revision ${report.new_revision} (status: ${report.status}).`);
              if ((report.invalidated_approval_count ?? 0) > 0) {
                console.log(`   Invalidated ${report.invalidated_approval_count} pending contextual approval(s) bound to this context.`);
              }
              console.log('');
              console.log(`⚠️  ${cg.RESET_MEMORY_WARNING}`);
            } else {
              console.error(`❌ ${report.error}`);
            }
            process.exitCode = report.ok ? 0 : 1;
          }
            break;

          case 'verify': {
            const report = cg.runContextVerify(configPath);
            if (flags.has('--json')) {
              console.log(JSON.stringify(report, null, 2));
            } else if (report.valid) {
              console.log(`✅ Context Guard chain verified. ${report.count} event(s) intact.`);
              console.log(`   ${report.limitation}`);
            } else {
              console.error(`❌ Context Guard chain verification failed!`);
              console.error(`   Error: ${report.error}`);
              console.error(`   Verified up to: ${report.count} event(s) before the failure.`);
            }
            process.exitCode = report.valid ? 0 : 1;
          }
            break;

          default:
            console.error(`Unknown context subcommand "${sub}".`);
            console.log(helpText);
            process.exitCode = 1;
        }
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
  agentgate tools <subcommand>               Tool Integrity Registry: scan/status/diff/trust/reject/
                                              history for downstream tool definitions (rug-pull defense).
                                              Run "agentgate tools --help" for details.
  agentgate context <subcommand>              Context Guard: status/history/explain/reset/verify for
                                              cross-tool session risk (conservative observed gateway
                                              state, never causal model-memory tracking). Run
                                              "agentgate context --help" for details.

  agentgate --version                        Print the installed version
  agentgate <command> --help                 Print detailed usage for a command

See docs/QUICKSTART.md for a full walkthrough.
`);
    process.exit(0);
  }
}

/** Resolves a policy file path given a gateway config path, mirroring loadGatewayConfig's own policy field lookup. */
function resolvePolicyPath(configPath: string): string {
  let policyPath = './agentgate.policy.yml';
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { policy?: string } | undefined;
    if (parsed?.policy) policyPath = parsed.policy;
  } catch {
    // use default
  }
  return resolveRelativeToConfig(configPath, policyPath);
}
