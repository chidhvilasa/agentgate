// Direct unit tests for Context Guard enforcement helpers (Milestone 7,
// ADR-0013) — packages/gateway/src/context-guard/enforcement.ts:
// evaluateContextGuard(), modeEnforces(), computeArgumentDigest(),
// checkApprovalContextValid(). Real in-memory AuditStorage, real config
// objects built through defaultContextGuardConfig()/loadGatewayConfig() —
// never a mock of the storage or config layer.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditStorage } from '../src/storage.js';
import { createContext, appendContextLabels, closeOrExpireContext } from '../src/context-guard/state.js';
import { evaluateContextGuard, modeEnforces, computeArgumentDigest, checkApprovalContextValid } from '../src/context-guard/enforcement.js';
import { defaultContextGuardConfig, loadGatewayConfig, type ContextGuardConfig } from '../src/config/registry.js';
import type { Approval } from '@agentgate/protocol';

function baseApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    event_id: 'evt-1',
    status: 'APPROVED',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed: false,
    proposed_action_display: 'send_webhook({})',
    policy_reason: 'requires approval',
    scope: 'send_webhook',
    created_at: new Date().toISOString(),
    resolved_at: new Date().toISOString(),
    resolved_by: 'human',
    context_id: null,
    context_revision: null,
    tool_fingerprint: null,
    argument_digest: null,
    contextual_rule_id: null,
    ...overrides,
  };
}

describe('Context Guard enforcement (ADR-0013)', () => {
  let storage: AuditStorage;

  beforeEach(() => {
    storage = new AuditStorage(':memory:');
  });

  afterEach(() => {
    storage.close();
  });

  describe('modeEnforces', () => {
    it('true only for "enforce"; monitor/disabled never enforce (compute-and-record only)', () => {
      expect(modeEnforces('enforce')).toBe(true);
      expect(modeEnforces('monitor')).toBe(false);
      expect(modeEnforces('disabled')).toBe(false);
    });
  });

  describe('evaluateContextGuard', () => {
    it('disabled mode always allows, without ever reading storage (no context needs to exist)', () => {
      const config: ContextGuardConfig = { ...defaultContextGuardConfig(), mode: 'disabled' };
      const result = evaluateContextGuard(storage, config, 'no-such-context', 'send_webhook');
      expect(result).toEqual({ action: 'allow', ruleId: null, reason: null, approvalTtlSeconds: null });
    });

    it('fails closed (deny) when no context exists yet for the given id, in a non-disabled mode — a missing context is a lifecycle inconsistency, never "assume no risk"', () => {
      const config: ContextGuardConfig = { ...defaultContextGuardConfig(), mode: 'enforce' };
      const result = evaluateContextGuard(storage, config, 'never-created', 'send_webhook');
      expect(result.action).toBe('deny');
      expect(result.reason).toMatch(/No execution context is recorded/);
    });

    it('enforcement before downstream execution is structural: evaluateContextGuard() never imports the MCP SDK or any downstream-execution primitive', () => {
      const source = fs.readFileSync(path.join(__dirname, '../src/context-guard/enforcement.ts'), 'utf8');
      const importLines = source
        .split('\n')
        .filter((l) => /^\s*import\b/.test(l))
        .join('\n');
      expect(importLines).not.toContain('@modelcontextprotocol/sdk');
      expect(importLines).not.toMatch(/executeDownstream/);
      expect(importLines).not.toMatch(/StdioClientTransport/);
    });

    it('a call whose effects match no rule defers to allow — base policy decides', () => {
      createContext(storage, 'ctx-1', null);
      const config: ContextGuardConfig = {
        ...defaultContextGuardConfig(),
        mode: 'enforce',
        tools: { echo: { effects: [], adds_on_result: [] } },
        rules: [{ id: 'r1', when: { context_has_any: ['untrusted_content'] }, action: 'deny', reason: 'x' }],
      };
      const result = evaluateContextGuard(storage, config, 'ctx-1', 'echo');
      expect(result.action).toBe('allow');
    });

    it('a call whose target effects match an active contextual rule returns that rule\'s action — "direct cached-name call" makes no difference: evaluateContextGuard() only ever reads contextId + toolName, never anything about HOW the call was invoked', () => {
      createContext(storage, 'ctx-1', null);
      appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'fetch_ticket', reason: 'r' });
      const config: ContextGuardConfig = {
        ...defaultContextGuardConfig(),
        mode: 'enforce',
        tools: { send_webhook: { effects: ['external_communication'], adds_on_result: [] } },
        rules: [{ id: 'deny-rule', when: { context_has_any: ['untrusted_content'], target_has_any: ['external_communication'] }, action: 'deny', reason: 'blocked' }],
      };
      const result = evaluateContextGuard(storage, config, 'ctx-1', 'send_webhook');
      expect(result.action).toBe('deny');
      expect(result.ruleId).toBe('deny-rule');
    });

    it('a tool with no declared effects is treated as having zero effect labels — never throws for an unconfigured tool name', () => {
      createContext(storage, 'ctx-1', null);
      const config: ContextGuardConfig = { ...defaultContextGuardConfig(), mode: 'enforce', rules: [] };
      const result = evaluateContextGuard(storage, config, 'ctx-1', 'totally_unconfigured_tool');
      expect(result.action).toBe('allow');
    });

    it('storage lookup failure fails closed (deny), never throws out of evaluateContextGuard', () => {
      const config: ContextGuardConfig = { ...defaultContextGuardConfig(), mode: 'enforce' };
      const brokenStorage = { getContextState: () => { throw new Error('db is gone'); } } as unknown as AuditStorage;
      const result = evaluateContextGuard(brokenStorage, config, 'ctx-1', 'send_webhook');
      expect(result.action).toBe('deny');
      expect(result.reason).toMatch(/storage lookup failed/);
      // Never leaks the raw internal error message/stack.
      expect(result.reason).not.toContain('db is gone');
    });
  });

  describe('computeArgumentDigest', () => {
    it('is deterministic: the same input always produces the same digest', () => {
      const args = { url: 'https://example.com', count: 3 };
      expect(computeArgumentDigest(args)).toBe(computeArgumentDigest({ url: 'https://example.com', count: 3 }));
    });

    it('changes when the arguments change (argument-substitution detection)', () => {
      const d1 = computeArgumentDigest({ url: 'https://a.example' });
      const d2 = computeArgumentDigest({ url: 'https://b.example' });
      expect(d1).not.toBe(d2);
    });

    it('is a fixed-length hex digest, never containing the raw argument values verbatim as a substring for a distinguishing value', () => {
      const digest = computeArgumentDigest({ secret: 'unmistakably-unique-marker-value' });
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(digest).not.toContain('unmistakably-unique-marker-value');
    });
  });

  describe('checkApprovalContextValid — exact binding and revalidation', () => {
    it('a non-contextual approval (context_id null) always passes, unchanged from pre-Milestone-7 behavior', () => {
      const approval = baseApproval({ context_id: null });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'any-digest', null);
      expect(result.ok).toBe(true);
    });

    it('fails closed when the bound context no longer exists', () => {
      const approval = baseApproval({ context_id: 'never-existed', context_revision: 0, argument_digest: null });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', null);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no longer exists/);
    });

    it('a stale context revision invalidates the approval — context advanced since creation', () => {
      createContext(storage, 'ctx-1', null);
      appendContextLabels(storage, 'ctx-1', ['untrusted_content'], { sourceEventId: null, toolName: 'a', reason: 'r' }); // revision -> 1
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', null);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/has advanced from revision 0 to 1/);
    });

    it('an exact-matching current revision, tool, and argument digest passes', () => {
      createContext(storage, 'ctx-1', null);
      const digest = computeArgumentDigest({ url: 'https://x' });
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: digest, scope: 'send_webhook' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', digest, null);
      expect(result.ok).toBe(true);
    });

    it('argument substitution (a changed argument digest) is rejected even at the exact same revision', () => {
      createContext(storage, 'ctx-1', null);
      const originalDigest = computeArgumentDigest({ url: 'https://original.example' });
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: originalDigest, scope: 'send_webhook' });
      const substitutedDigest = computeArgumentDigest({ url: 'https://attacker.example' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', substitutedDigest, null);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/arguments no longer match/);
    });

    it('a null argument_digest on the approval (not bound to a specific argument set) skips the digest check entirely', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'whatever-digest', null);
      expect(result.ok).toBe(true);
    });

    it('a wrong/mismatched target tool (scope) is rejected — an approval for one tool cannot execute a different one', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook' });
      const result = checkApprovalContextValid(approval, storage, 'read_secret', 'digest', null);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/target tool no longer matches/);
    });

    it('a closed/expired context invalidates a still-pending approval bound to it, even at the exact same revision number', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook' });
      closeOrExpireContext(storage, 'ctx-1', 'closed'); // revision bumps to 1 as part of closing
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', null);
      expect(result.ok).toBe(false); // revision no longer matches (0 vs 1) — fails closed either way
    });

    it('storage failure during revalidation fails closed, never throws', () => {
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0 });
      const brokenStorage = { getContextState: () => { throw new Error('disk error'); } } as unknown as AuditStorage;
      const result = checkApprovalContextValid(approval, brokenStorage, 'send_webhook', 'digest', null);
      expect(result.ok).toBe(false);
      expect(result.reason).not.toContain('disk error'); // no raw internal error leakage
    });

    it('public rejection reasons never leak a secret, token, raw argument value, or raw path', () => {
      createContext(storage, 'ctx-1', null);
      const secretLikeDigest = computeArgumentDigest({ token: 'sk-live-should-never-appear-verbatim' });
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: secretLikeDigest, scope: 'send_webhook' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', computeArgumentDigest({ token: 'different' }), null);
      expect(result.ok).toBe(false);
      expect(result.reason).not.toContain('sk-live-should-never-appear-verbatim');
      expect(result.reason).not.toMatch(/[/\\][A-Za-z]:[/\\]|\/(home|Users)\//); // no raw filesystem path
    });
  });

  describe('checkApprovalContextValid — tool_fingerprint binding (Tool Integrity)', () => {
    it('a null-to-null fingerprint (no trusted definition existed at creation time, and none exists now either) passes — nothing was ever bound and nothing has changed', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', tool_fingerprint: null });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', null);
      expect(result.ok).toBe(true);
    });

    it('Milestone 8 / ADR-0014 fail-closed fix: a tool that had NO trusted definition at approval creation (fingerprint null) but becomes trusted before consumption is rejected — the approving human never saw the definition it is now bound under', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', tool_fingerprint: null });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', 'fp-now-trusted');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/trusted definition has changed/);
    });

    it('Milestone 8 / ADR-0014 fail-closed fix: the reverse transition — a fingerprint WAS bound at creation but the tool has since become untrusted (removed/never-re-scanned) — is also rejected, symmetric with the drift/quarantine case', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', tool_fingerprint: 'fp-was-trusted' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', null);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/trusted definition has changed/);
    });

    it('an exact-matching bound fingerprint and current trusted fingerprint passes', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', tool_fingerprint: 'fp-abc123' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', 'fp-abc123');
      expect(result.ok).toBe(true);
    });

    it('tool drift after approval creation (current fingerprint differs from bound) is rejected — the trusted definition changed', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', tool_fingerprint: 'fp-original' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', 'fp-drifted');
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/trusted definition has changed/);
    });

    it('quarantine after approval creation (current trusted fingerprint becomes null) is rejected when a fingerprint WAS bound', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', tool_fingerprint: 'fp-original' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', null); // getTrustedFingerprint() would now return null — quarantined/drifted/rejected/removed
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/trusted definition has changed/);
    });

    it('public rejection reason for a fingerprint mismatch never leaks the raw fingerprint values themselves', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', tool_fingerprint: 'fp-unmistakably-original-marker' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', 'fp-unmistakably-drifted-marker');
      expect(result.ok).toBe(false);
      expect(result.reason).not.toContain('fp-unmistakably-original-marker');
      expect(result.reason).not.toContain('fp-unmistakably-drifted-marker');
    });
  });

  describe('policy digest / rule binding — as far as this milestone implements it', () => {
    it('contextual_rule_id is carried through on the approval object but is not independently re-verified against a live policy digest by checkApprovalContextValid() — an honest scope statement, not a silent gap: revision/tool/argument-digest are what is actually re-checked', () => {
      createContext(storage, 'ctx-1', null);
      const approval = baseApproval({ context_id: 'ctx-1', context_revision: 0, argument_digest: null, scope: 'send_webhook', contextual_rule_id: 'deny-rule' });
      const result = checkApprovalContextValid(approval, storage, 'send_webhook', 'digest', null);
      expect(result.ok).toBe(true); // passes on revision/tool/digest alone, regardless of contextual_rule_id's value
    });
  });

  describe('missing/legacy context_guard configuration uses the canonical parsed default', () => {
    let tmpDir: string;
    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-cg-enforcement-config-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loadGatewayConfig() with no context_guard block yields the exact same config defaultContextGuardConfig() returns', () => {
      const configPath = path.join(tmpDir, 'agentgate.yml');
      fs.writeFileSync(configPath, 'version: 1\npolicy: ./p.yml\ndb_path: ./db.sqlite\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n');
      const config = loadGatewayConfig(configPath);
      expect(config.context_guard).toEqual(defaultContextGuardConfig());
    });
  });
});
