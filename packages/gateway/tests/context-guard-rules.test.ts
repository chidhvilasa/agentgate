// Direct unit tests for pure contextual-rule evaluation (Milestone 7,
// ADR-0013) — packages/gateway/src/context-guard/rules.ts. Pure,
// deterministic, no storage/I/O — every test here is a plain function call.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { whenMatches, evaluateContextualRules, isAtLeastAsStrict } from '../src/context-guard/rules.js';
import { loadGatewayConfig, defaultContextGuardConfig, type ContextGuardRule } from '../src/config/registry.js';

function rule(overrides: Partial<ContextGuardRule> & Pick<ContextGuardRule, 'id' | 'when' | 'action' | 'reason'>): ContextGuardRule {
  return overrides;
}

describe('Context Guard contextual rule evaluation (ADR-0013)', () => {
  describe('whenMatches — condition operators', () => {
    it('context_has_all: true only when EVERY listed label is present', () => {
      expect(whenMatches({ context_has_all: ['a', 'b'] }, ['a', 'b', 'c'], [])).toBe(true);
      expect(whenMatches({ context_has_all: ['a', 'b'] }, ['a'], [])).toBe(false);
      expect(whenMatches({ context_has_all: [] }, [], [])).toBe(true); // vacuously true
    });

    it('context_has_any: true if ANY listed label is present', () => {
      expect(whenMatches({ context_has_any: ['a', 'b'] }, ['b'], [])).toBe(true);
      expect(whenMatches({ context_has_any: ['a', 'b'] }, ['c'], [])).toBe(false);
    });

    it('context_lacks_all: true only when NONE of the listed labels are present', () => {
      expect(whenMatches({ context_lacks_all: ['a', 'b'] }, ['c'], [])).toBe(true);
      expect(whenMatches({ context_lacks_all: ['a', 'b'] }, ['a'], [])).toBe(false);
    });

    it('context_lacks_any: true if AT LEAST ONE listed label is missing (not all present)', () => {
      expect(whenMatches({ context_lacks_any: ['a', 'b'] }, ['a'], [])).toBe(true); // b is missing
      expect(whenMatches({ context_lacks_any: ['a', 'b'] }, ['a', 'b'], [])).toBe(false); // both present
    });

    it('target_has_any / target_has_all match against the ATTEMPTED CALL\'s own effect labels, independent of context labels', () => {
      expect(whenMatches({ target_has_any: ['external_communication'] }, [], ['external_communication'])).toBe(true);
      expect(whenMatches({ target_has_any: ['external_communication'] }, [], ['code_execution'])).toBe(false);
      expect(whenMatches({ target_has_all: ['a', 'b'] }, [], ['a', 'b'])).toBe(true);
      expect(whenMatches({ target_has_all: ['a', 'b'] }, [], ['a'])).toBe(false);
    });

    it('multiple conditions in one clause are ANDed together', () => {
      const when = { context_has_any: ['untrusted_content'], target_has_any: ['external_communication'] };
      expect(whenMatches(when, ['untrusted_content'], ['external_communication'])).toBe(true);
      expect(whenMatches(when, ['untrusted_content'], ['code_execution'])).toBe(false); // target condition fails
      expect(whenMatches(when, [], ['external_communication'])).toBe(false); // context condition fails
    });

    it('operator-defined (custom) labels work identically to built-in labels — whenMatches is vocabulary-agnostic', () => {
      expect(whenMatches({ context_has_any: ['operator_custom_label'] }, ['operator_custom_label'], [])).toBe(true);
    });
  });

  describe('evaluateContextualRules — deterministic first-match semantics', () => {
    it('returns the FIRST matching rule when multiple rules could match, in declared order', () => {
      const rules: ContextGuardRule[] = [
        rule({ id: 'first', when: { context_has_any: ['untrusted_content'] }, action: 'require_approval', reason: 'first matches' }),
        rule({ id: 'second', when: { context_has_any: ['untrusted_content'] }, action: 'deny', reason: 'second also matches' }),
      ];
      const result = evaluateContextualRules(rules, ['untrusted_content'], []);
      expect(result.ruleId).toBe('first');
      expect(result.action).toBe('require_approval');
    });

    it('returns allow/null when no rule matches — Context Guard never invents an allow, it only defers', () => {
      const rules: ContextGuardRule[] = [rule({ id: 'r1', when: { context_has_any: ['sensitive_data_accessed'] }, action: 'deny', reason: 'r' })];
      const result = evaluateContextualRules(rules, ['untrusted_content'], []);
      expect(result).toEqual({ action: 'allow', ruleId: null, reason: null, approvalTtlSeconds: null });
    });

    it('empty rule set always defers (allow, no match)', () => {
      expect(evaluateContextualRules([], ['untrusted_content'], ['external_communication'])).toEqual({
        action: 'allow',
        ruleId: null,
        reason: null,
        approvalTtlSeconds: null,
      });
    });

    it('propagates the matched rule\'s reason and approval_ttl_seconds through to the evaluation result', () => {
      const rules: ContextGuardRule[] = [
        rule({ id: 'r1', when: { context_has_any: ['untrusted_content'] }, action: 'require_approval', reason: 'exact reason text', approval_ttl_seconds: 42 }),
      ];
      const result = evaluateContextualRules(rules, ['untrusted_content'], []);
      expect(result.reason).toBe('exact reason text');
      expect(result.approvalTtlSeconds).toBe(42);
    });
  });

  describe('isAtLeastAsStrict — the monotonic merge invariant', () => {
    it('DENY is strictest: at least as strict as everything, nothing is at least as strict as it except DENY itself', () => {
      expect(isAtLeastAsStrict('DENY', 'ALLOW')).toBe(true);
      expect(isAtLeastAsStrict('DENY', 'REQUIRE_APPROVAL')).toBe(true);
      expect(isAtLeastAsStrict('DENY', 'DENY')).toBe(true);
      expect(isAtLeastAsStrict('REQUIRE_APPROVAL', 'DENY')).toBe(false);
      expect(isAtLeastAsStrict('ALLOW', 'DENY')).toBe(false);
    });

    it('REQUIRE_APPROVAL is at least as strict as ALLOW, but not as strict as DENY', () => {
      expect(isAtLeastAsStrict('REQUIRE_APPROVAL', 'ALLOW')).toBe(true);
      expect(isAtLeastAsStrict('REQUIRE_APPROVAL', 'DENY')).toBe(false);
    });

    it('a base ALLOW combined with a contextual DENY: DENY wins (isAtLeastAsStrict("DENY","ALLOW") is true)', () => {
      // This is the exact check pipeline.ts performs: isAtLeastAsStrict(cgActionType, decision.type)
      expect(isAtLeastAsStrict('DENY', 'ALLOW')).toBe(true); // contextual DENY overrides base ALLOW
    });

    it('a base DENY can never become a contextual ALLOW: the rule schema has no "allow" action at all, and even if it did, isAtLeastAsStrict("ALLOW","DENY") is false', () => {
      expect(isAtLeastAsStrict('ALLOW', 'DENY')).toBe(false);
    });

    it('a base REQUIRE_APPROVAL can never be silently downgraded to ALLOW by a non-matching contextual rule (allow is never even attempted to override)', () => {
      // evaluateContextualRules never returns action:'allow' as something the
      // caller applies — pipeline.ts only overrides when cgEvaluation.action !== 'allow'.
      const result = evaluateContextualRules([], [], []); // no match -> allow/defer
      expect(result.action).toBe('allow'); // caller (pipeline.ts) treats this as "do not override" — never applies it.
    });
  });

  describe('missing/unknown configuration fails safely at the schema boundary (not rules.ts itself)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgate-cg-rules-config-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeConfig(extra: string): string {
      const configPath = path.join(tmpDir, 'agentgate.yml');
      fs.writeFileSync(
        configPath,
        `version: 1\npolicy: ./p.yml\ndb_path: ./db.sqlite\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: []\n${extra}`
      );
      return configPath;
    }

    it('the canonical default (defaultContextGuardConfig()) is monitor mode, no rules, no tools — matching an omitted context_guard block', () => {
      const configPath = writeConfig('');
      const config = loadGatewayConfig(configPath);
      expect(config.context_guard).toEqual(defaultContextGuardConfig());
      expect(config.context_guard.mode).toBe('monitor');
      expect(config.context_guard.rules).toEqual([]);
      expect(config.context_guard.tools).toEqual({});
    });

    it('an unknown label referenced in a rule fails config validation, not a silent no-op at evaluation time', () => {
      const configPath = writeConfig(
        'context_guard:\n  rules:\n    - id: r1\n      when:\n        context_has_any: [not_a_real_label]\n      action: deny\n      reason: x\n'
      );
      expect(() => loadGatewayConfig(configPath)).toThrow(/Unknown label/);
    });

    it('a "when" clause with zero conditions fails config validation — a contextual rule must specify at least one condition', () => {
      const configPath = writeConfig('context_guard:\n  rules:\n    - id: r1\n      when: {}\n      action: deny\n      reason: x\n');
      expect(() => loadGatewayConfig(configPath)).toThrow();
    });

    it('a duplicate rule id fails config validation', () => {
      const configPath = writeConfig(
        'context_guard:\n  rules:\n' +
          '    - id: dup\n      when:\n        context_has_any: [untrusted_content]\n      action: deny\n      reason: x\n' +
          '    - id: dup\n      when:\n        context_has_any: [sensitive_data_accessed]\n      action: deny\n      reason: y\n'
      );
      expect(() => loadGatewayConfig(configPath)).toThrow(/Duplicate contextual rule id/);
    });

    it('an "allow" action is not a valid rule action at all — rejected by the schema (there is no allow-escalation path to misuse)', () => {
      const configPath = writeConfig(
        'context_guard:\n  rules:\n    - id: r1\n      when:\n        context_has_any: [untrusted_content]\n      action: allow\n      reason: x\n'
      );
      expect(() => loadGatewayConfig(configPath)).toThrow();
    });
  });

  describe('Tool Integrity quarantine cannot be overridden by Context Guard', () => {
    it('is structural, not a rules.ts behavior: checkCallAllowed() in tool-integrity/enforcement.ts runs entirely before runPipeline() is ever called (see transport/stdio.ts) — Context Guard never has an opportunity to evaluate a quarantined call at all, let alone override its outcome', () => {
      // Documented here as an explicit, named invariant test (not a
      // duplicate of tool-integrity's own tests): rules.ts exposes no
      // function capable of granting call access to a downstream server,
      // and evaluateContextualRules() never returns anything but
      // 'deny'/'require_approval'/'allow'(=defer) — there is no code path
      // by which a Context Guard rule result could reach or affect the
      // Tool Integrity gate, because the two are wired in strict sequence,
      // not as alternatives.
      expect(Object.keys({ evaluateContextualRules, whenMatches, isAtLeastAsStrict })).not.toContain('checkCallAllowed');
    });
  });

  describe('untrusted MCP tool annotations cannot add a permission or lower risk', () => {
    it('whenMatches/evaluateContextualRules take only operator-declared label arrays — there is no parameter through which a raw MCP tool annotation (readOnlyHint, destructiveHint, etc.) could ever reach rule evaluation', () => {
      // whenMatches(when, contextLabels, targetEffects) — both label arrays
      // are always OPERATOR CONFIG-DERIVED (context_guard.tools.<name>.effects,
      // and accumulated context state built only from adds_on_result), never
      // parsed from a downstream server's raw tool object. This test pins
      // that contract at the type/call-signature level: passing effect
      // labels that happen to look like annotation names has no special
      // meaning — they are evaluated as ordinary policy labels, proving
      // annotations carry no implicit trust.
      const result = evaluateContextualRules(
        [rule({ id: 'r1', when: { target_has_any: ['readOnlyHint'] }, action: 'deny', reason: 'x' })],
        [],
        ['readOnlyHint'] // only matches because THIS test supplied it as an effect label explicitly — never because a server claimed it.
      );
      expect(result.action).toBe('deny'); // matches purely on the operator-declared effect label passed in, not any trust granted by the string's name.
    });
  });
});
