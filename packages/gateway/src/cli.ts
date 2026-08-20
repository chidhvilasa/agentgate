#!/usr/bin/env node
import { startGateway } from './server.js';
import { loadPolicyFile, validatePolicy } from '@agentgate/policy';
import { loadGatewayConfig } from './config/registry.js';
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
  }

  default: {
    console.log(`
AgentGate — The open-source firewall for AI agents.

Usage:
  agentgate start [config.yml]     Start the gateway (default: agentgate.yml)
  agentgate validate [policy.yml]  Validate a policy file
`);
    process.exit(0);
  }
}
