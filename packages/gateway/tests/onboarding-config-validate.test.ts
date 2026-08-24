import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfigFile } from '../src/onboarding/configValidate.js';

describe('agentgate config validate (Milestone 5)', () => {
  let tmpDir: string;
  let configPath: string;
  let policyPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-config-validate-'));
    configPath = path.join(tmpDir, 'agentgate.yml');
    policyPath = path.join(tmpDir, 'policy.yml');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeValidPair() {
    fs.writeFileSync(
      policyPath,
      'version: 1\ndefaults:\n  decision: deny\nrules:\n  - id: allow-echo\n    tools: ["echo"]\n    decision: allow\n'
    );
    fs.writeFileSync(
      configPath,
      `version: 1\ngateway_port: 4100\ncontrol_port: 4101\npolicy: ${policyPath.split(path.sep).join('/')}\ndb_path: ${path.join(tmpDir, 'a.sqlite').split(path.sep).join('/')}\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n`
    );
  }

  it('reports missing_file when the config does not exist', () => {
    const result = validateConfigFile(path.join(tmpDir, 'nope.yml'));
    expect(result.valid).toBe(false);
    expect(result.issues[0].category).toBe('missing_file');
  });

  it('reports syntax_error for invalid YAML', () => {
    fs.writeFileSync(configPath, 'not: [valid, yaml');
    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(false);
    expect(result.issues[0].category).toBe('syntax_error');
  });

  it('reports schema_error for a structurally invalid config (e.g. no servers)', () => {
    fs.writeFileSync(configPath, 'version: 1\nservers: []\n');
    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(false);
    expect(result.issues[0].category).toBe('schema_error');
  });

  it('reports missing_file when the referenced policy does not exist', () => {
    fs.writeFileSync(
      configPath,
      `version: 1\npolicy: ${path.join(tmpDir, 'missing-policy.yml').split(path.sep).join('/')}\ndb_path: ./a.sqlite\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n`
    );
    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.category === 'missing_file')).toBe(true);
  });

  it('reports policy_error for an invalid policy file', () => {
    fs.writeFileSync(policyPath, 'version: 1\nrules:\n  - id: x\n    decision: not_a_real_decision\n');
    fs.writeFileSync(
      configPath,
      `version: 1\npolicy: ${policyPath.split(path.sep).join('/')}\ndb_path: ./a.sqlite\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n`
    );
    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.category === 'policy_error')).toBe(true);
  });

  it('reports unsafe_value when gateway_port and control_port collide', () => {
    fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: deny\nrules: []\n');
    fs.writeFileSync(
      configPath,
      `version: 1\ngateway_port: 4200\ncontrol_port: 4200\npolicy: ${policyPath.split(path.sep).join('/')}\ndb_path: ./a.sqlite\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n`
    );
    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.category === 'unsafe_value')).toBe(true);
  });

  it('returns valid: true with a populated summary for a genuinely valid pair', () => {
    writeValidPair();
    const result = validateConfigFile(configPath);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.summary).toEqual({ servers: 1, gatewayPort: 4100, controlPort: 4101, dbPath: expect.stringContaining('a.sqlite') });
  });

  it('never throws — every failure mode is captured as a result, not an exception', () => {
    expect(() => validateConfigFile(path.join(tmpDir, 'definitely-not-there.yml'))).not.toThrow();
    fs.writeFileSync(configPath, '{{{not yaml at all');
    expect(() => validateConfigFile(configPath)).not.toThrow();
  });
});
