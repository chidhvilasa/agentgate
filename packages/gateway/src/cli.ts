#!/usr/bin/env node
import { startGateway } from './server.js';
import { validatePolicy, sanitizeErrorMessage, loadPolicyFile } from '@agentgate/policy';
import fs from 'node:fs';
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

  default: {
    console.log(`
AgentGate — The open-source firewall for AI agents.

Usage:
  agentgate start [config.yml]              Start the gateway (default: agentgate.yml)
  agentgate validate [policy.yml]            Validate a policy file
  agentgate audit verify [config]            Verify the tamper-evident audit chain and replay lineage
  agentgate replay <event-id> [config]       Safe Replay: re-evaluate a historical event against the
                                              current policy. Policy re-evaluation only — never executes
                                              the tool. Add --json for machine-readable output.
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
