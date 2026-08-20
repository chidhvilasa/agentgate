#!/usr/bin/env node
import { startGateway } from './server.js';
import { validatePolicy } from '@agentgate/policy';
import fs from 'node:fs';
import yaml from 'js-yaml';

const [, , command, ...args] = process.argv;

switch (command) {
  case 'start': {
    const configPath = args[0] ?? './agentgate.yml';
    startGateway(configPath).catch((err) => {
      console.error('[agentgate] Fatal:', err.message);
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
      let dbPath = './agentgate.sqlite';
      try {
        const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8')) as { db_path?: string } | undefined;
        if (parsed?.db_path) dbPath = parsed.db_path;
      } catch {
        // use default
      }
      import('./storage.js')
        .then(({ AuditStorage }) => {
          const storage = new AuditStorage(dbPath);
          const result = storage.verifyChain();
          storage.close();
          if (result.valid) {
            console.log(`✅ Audit chain verified. ${result.count} records intact.`);
            process.exit(0);
          } else {
            console.error(`❌ Audit chain verification failed!`);
            console.error(`   Error: ${result.error}`);
            process.exit(1);
          }
        })
        .catch((err: unknown) => {
          console.error('[agentgate] Fatal:', err);
          process.exit(1);
        });
      break;
    }
    console.error('Unknown audit subcommand. Try: agentgate audit verify');
    process.exit(1);
    break;
  }

  default: {
    console.log(`
AgentGate — The open-source firewall for AI agents.

Usage:
  agentgate start [config.yml]     Start the gateway (default: agentgate.yml)
  agentgate validate [policy.yml]  Validate a policy file
  agentgate audit verify [config]  Verify the tamper-evident audit chain
`);
    process.exit(0);
  }
}
