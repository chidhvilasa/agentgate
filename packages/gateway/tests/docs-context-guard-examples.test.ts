// Proves the exact Context Guard YAML examples published in
// docs/POLICY_REFERENCE.md and README.md actually parse through the real
// production loader (ADR-0013) — so a schema change that would silently
// break a published example is caught here, not discovered by a reader
// copy-pasting a doc snippet that no longer validates. Mirrors this
// project's existing practice of testing documented examples against real
// code rather than trusting prose to stay in sync (see e.g.
// tool-integrity-cli.test.ts's use of the exact README CLI invocations).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadGatewayConfig } from '../src/config/registry.js';

// The context_guard block itself, exactly as published in
// docs/POLICY_REFERENCE.md's "Migration" snippet.
const MIGRATION_EXAMPLE = `
context_guard:
  mode: enforce
  tools:
    fetch_ticket:
      adds_on_result: [untrusted_content]
    send_webhook:
      effects: [external_communication]
  rules:
    - id: deny-external-after-untrusted-content
      when:
        context_has_any: [untrusted_content]
        target_has_any: [external_communication]
      action: deny
      reason: "External communication blocked: untrusted content was accessed earlier in this session."
`;

// docs/POLICY_REFERENCE.md's "Complete example — deny path".
const DENY_PATH_EXAMPLE = `
context_guard:
  mode: enforce
  tools:
    fetch_ticket:
      adds_on_result: [untrusted_content]
    read_secret:
      effects: [sensitive_read]
      adds_on_result: [sensitive_data_accessed]
    send_webhook:
      effects: [external_communication]
  rules:
    - id: deny-external-after-risk
      when:
        context_has_any: [untrusted_content, sensitive_data_accessed]
        target_has_any: [external_communication]
      action: deny
      reason: "External communication blocked: untrusted or sensitive content was accessed earlier in this session."
`;

// docs/POLICY_REFERENCE.md's "Complete example — require-approval path".
const APPROVAL_PATH_EXAMPLE = `
context_guard:
  mode: enforce
  tools:
    fetch_ticket:
      adds_on_result: [untrusted_content]
    send_webhook:
      effects: [external_communication]
  rules:
    - id: approve-external-after-risk
      when:
        context_has_any: [untrusted_content]
        target_has_any: [external_communication]
      action: require_approval
      reason: "External communication requires approval: untrusted content was accessed earlier in this session."
      approval_ttl_seconds: 60
`;

// README.md's Context Guard config example.
const README_EXAMPLE = `
context_guard:
  mode: enforce
  tools:
    fetch_ticket:
      adds_on_result: [untrusted_content]
    read_secret:
      effects: [sensitive_read]
      adds_on_result: [sensitive_data_accessed]
    send_webhook:
      effects: [external_communication]
  rules:
    - id: deny-external-after-risk
      when:
        context_has_any: [untrusted_content, sensitive_data_accessed]
        target_has_any: [external_communication]
      action: deny
      reason: "External communication blocked: untrusted or sensitive content was accessed earlier in this session."
`;

describe('Documented Context Guard config examples parse through the real loader (ADR-0013)', () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  });

  function loadExample(contextGuardYaml: string) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-docs-example-'));
    const policyPath = path.join(tmpDir, 'policy.yml');
    const dbPath = path.join(tmpDir, 'agentgate.sqlite');
    const configPath = path.join(tmpDir, 'agentgate.yml');
    fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: deny\nrules: []\n');
    fs.writeFileSync(
      configPath,
      `version: 1\ngateway_port: 4500\ncontrol_port: 4501\npolicy: ${policyPath.split(path.sep).join('/')}\n` +
        `db_path: ${dbPath.split(path.sep).join('/')}\n` +
        `servers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["-e", "process.stdin.resume()"]\n` +
        contextGuardYaml
    );
    return loadGatewayConfig(configPath);
  }

  it('the POLICY_REFERENCE.md "Migration" example parses and enables enforce mode', () => {
    const config = loadExample(MIGRATION_EXAMPLE);
    expect(config.context_guard.mode).toBe('enforce');
    expect(config.context_guard.tools.fetch_ticket.adds_on_result).toEqual(['untrusted_content']);
    expect(config.context_guard.rules).toHaveLength(1);
    expect(config.context_guard.rules[0].action).toBe('deny');
  });

  it('the POLICY_REFERENCE.md "deny path" complete example parses correctly', () => {
    const config = loadExample(DENY_PATH_EXAMPLE);
    expect(config.context_guard.mode).toBe('enforce');
    expect(config.context_guard.tools.read_secret.effects).toEqual(['sensitive_read']);
    expect(config.context_guard.tools.read_secret.adds_on_result).toEqual(['sensitive_data_accessed']);
    expect(config.context_guard.rules[0]).toMatchObject({ id: 'deny-external-after-risk', action: 'deny' });
  });

  it('the POLICY_REFERENCE.md "require-approval path" complete example parses correctly', () => {
    const config = loadExample(APPROVAL_PATH_EXAMPLE);
    expect(config.context_guard.rules[0]).toMatchObject({
      id: 'approve-external-after-risk',
      action: 'require_approval',
      approval_ttl_seconds: 60,
    });
  });

  it('the README.md Context Guard config example parses correctly', () => {
    const config = loadExample(README_EXAMPLE);
    expect(config.context_guard.mode).toBe('enforce');
    expect(config.context_guard.rules[0].id).toBe('deny-external-after-risk');
  });

  it('a config omitting context_guard entirely defaults to monitor mode, unchanged for pre-Milestone-7 configs', () => {
    const config = loadExample('');
    expect(config.context_guard.mode).toBe('monitor');
    expect(config.context_guard.tools).toEqual({});
    expect(config.context_guard.rules).toEqual([]);
  });
});
