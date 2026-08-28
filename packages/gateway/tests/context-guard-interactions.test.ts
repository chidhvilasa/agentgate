// Interaction/regression tests (Milestone 7, ADR-0013): proves Context
// Guard composes correctly with every OTHER gateway boundary — Tool
// Integrity, base first-match policy, input secret detection,
// allow_with_transform, ordinary (non-contextual) approvals, Safe Replay's
// no-execution guarantee, downstream result/error secret inspection, the
// audit chain, and SSE publication — using the real pipeline/storage/
// approval code, a real downstream fixture process, and real config
// objects. Complements (does not replace) context-guard-gateway-
// enforcement.test.ts's real-gateway-path zero-contact proof.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/pipeline.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import { createContext } from '../src/context-guard/state.js';
import { defaultContextGuardConfig, type GatewayConfig } from '../src/config/registry.js';
import type { AgentIdentity } from '@agentgate/protocol';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/fixture-downstream-server.mjs');

const AGENT: AgentIdentity = {
  session_id: 'context-guard-interactions-test',
  declared_name: null,
  declared_version: null,
  connection_identity: 'test',
  verified_identity: false,
};

describe('Context Guard interactions with the rest of the gateway pipeline (ADR-0013)', () => {
  let tmpDir: string;
  let policyPath: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-cg-interactions-'));
    policyPath = path.join(tmpDir, 'policy.yml');
    fs.writeFileSync(
      policyPath,
      `
version: 1
defaults:
  decision: deny
rules:
  - id: secret-in-args
    tools: ["echo"]
    contains_secrets: true
    decision: deny
  - id: allow-echo
    tools: ["echo"]
    decision: allow
  - id: allow-leak-secret-transform
    tools: ["leak_secret"]
    decision: allow_with_transform
  - id: approve-error-result
    tools: ["error_result"]
    decision: require_approval
    approval_ttl_seconds: 10
  - id: base-deny-forbidden
    tools: ["forbidden_tool"]
    decision: deny
`
    );
  });

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(contextGuardOverrides: Partial<ReturnType<typeof defaultContextGuardConfig>> = {}) {
    const storage = new AuditStorage(':memory:');
    const approvalManager = new ApprovalManager(storage);
    const config: GatewayConfig = {
      version: 1,
      gateway_port: 4700,
      control_port: 4701,
      policy: policyPath,
      db_path: ':memory:',
      servers: [{ id: 'fixture', transport: 'stdio', command: 'node', args: [FIXTURE_SERVER] }],
      retention: { max_days: 30, max_events: 100000 },
      output_security: { mode: 'redact', opaque_content: 'allow_uninspected', max_depth: 8, max_text_bytes: 1_000_000 },
      tool_integrity: { mode: 'disabled' },
      context_guard: { ...defaultContextGuardConfig(), ...contextGuardOverrides },
    };
    const contextId = crypto.randomUUID();
    createContext(storage, contextId, null);
    const events: unknown[] = [];
    const ctx = { storage, approvalManager, config, contextId, emitEvent: (e: unknown) => events.push(e) };
    return { ctx, storage, approvalManager, events };
  }

  it('base first-match policy DENY is never loosened by Context Guard — a contextual rule with a matching require_approval action cannot override an already-DENY base decision', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      tools: { forbidden_tool: { effects: ['destructive_write'] } },
      rules: [{ id: 'r1', when: { target_has_any: ['destructive_write'] }, action: 'require_approval', reason: 'x' }],
    });
    try {
      const { event, result } = await runPipeline({ ctx, agent: AGENT, toolName: 'forbidden_tool', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      expect(event.status).toBe('DENIED'); // still DENIED, never downgraded to PENDING_APPROVAL
      expect(result).toBeNull();
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('input secret detection (contains_secrets) DENY composes correctly — the call never reaches Context Guard escalation OR downstream execution', async () => {
    const { ctx, storage, approvalManager } = makeCtx({ mode: 'enforce' });
    try {
      const { event, result } = await runPipeline({
        ctx,
        agent: AGENT,
        toolName: 'echo',
        rawArgs: { text: 'my key is AKIAIOSFODNN7EXAMPLE' },
        mcpEra: 'legacy-2025',
        jsonrpcId: '1',
      });
      expect(event.status).toBe('DENIED');
      expect(result).toBeNull();
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('allow_with_transform composes with Context Guard: an unrelated contextual rule does not disturb the transform decision, and redacted args are what execute', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      rules: [{ id: 'unrelated', when: { target_has_any: ['external_communication'] }, action: 'deny', reason: 'x' }], // never matches leak_secret's (no) declared effects
    });
    try {
      const { event, result } = await runPipeline({ ctx, agent: AGENT, toolName: 'leak_secret', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      expect(event.status).toBe('SUCCEEDED');
      expect(event.decision?.type).toBe('ALLOW_WITH_TRANSFORM');
      expect((result as { content: Array<{ text: string }> }).content[0].text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('Context Guard escalates an allow_with_transform decision to DENY when a contextual rule DOES match — strictly stricter, never silently ignored', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      tools: { leak_secret: { effects: ['sensitive_read'] } },
      rules: [{ id: 'deny-sensitive', when: { target_has_any: ['sensitive_read'] }, action: 'deny', reason: 'contextually blocked' }],
    });
    try {
      const { event, result } = await runPipeline({ ctx, agent: AGENT, toolName: 'leak_secret', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      expect(event.status).toBe('DENIED');
      expect(event.decision?.reason_code).toBe('CONTEXT_GUARD_ESCALATION');
      expect(result).toBeNull();
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('an ORDINARY (non-contextual) approval — base policy alone requires it, no contextual rule matched — is still bound to the current context with contextual_rule_id "base-policy" when Context Guard is not disabled', async () => {
    const { ctx, storage, approvalManager } = makeCtx({ mode: 'enforce', rules: [] });
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'error_result', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      // Poll for the approval to appear, then approve it.
      let approval;
      for (let i = 0; i < 50 && !approval; i++) {
        approval = storage.listPendingApprovals()[0];
        if (!approval) await new Promise((r) => setTimeout(r, 100));
      }
      expect(approval).toBeDefined();
      expect(approval.contextual_rule_id).toBe('base-policy');
      expect(approval.context_id).toBe(ctx.contextId);
      expect(approval.context_revision).toBe(0);
      approvalManager.approve(approval.id);
      const { event } = await promise;
      expect(event.status).toBe('SUCCEEDED');
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('when Context Guard is disabled, an ordinary approval has NO context binding at all (contextBinding omitted, not defaulted to a fake value)', async () => {
    const { ctx, storage, approvalManager } = makeCtx({ mode: 'disabled' });
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'error_result', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      let approval;
      for (let i = 0; i < 50 && !approval; i++) {
        approval = storage.listPendingApprovals()[0];
        if (!approval) await new Promise((r) => setTimeout(r, 100));
      }
      expect(approval).toBeDefined();
      expect(approval.context_id).toBeNull();
      expect(approval.context_revision).toBeNull();
      expect(approval.contextual_rule_id).toBeNull();
      approvalManager.approve(approval.id);
      await promise;
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('a fully BLOCKED result (output security, block mode) never adds context labels — even though the call itself SUCCEEDED', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      tools: { leak_secret: { adds_on_result: ['sensitive_data_accessed'] } },
    });
    ctx.config.output_security = { ...ctx.config.output_security, mode: 'block' };
    try {
      const { event } = await runPipeline({ ctx, agent: AGENT, toolName: 'leak_secret', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      expect(event.status).toBe('SUCCEEDED');
      expect(event.result_blocked).toBe(true);
      const state = storage.getContextState(ctx.contextId)!;
      expect(state.labels).toEqual([]); // no label added — the blocked result never actually reached the agent.
      expect(state.revision).toBe(0);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('a REDACTED (not blocked) result DOES still add its configured context label — the documented conservative trade-off (ADR-0013 point 8)', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      tools: { leak_secret: { adds_on_result: ['sensitive_data_accessed'] } },
    }); // redact mode is the default from makeCtx()
    try {
      const { event } = await runPipeline({ ctx, agent: AGENT, toolName: 'leak_secret', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      expect(event.status).toBe('SUCCEEDED');
      expect(event.result_redacted).toBe(true);
      expect(event.result_blocked).toBe(false);
      const state = storage.getContextState(ctx.contextId)!;
      expect(state.labels).toEqual(['sensitive_data_accessed']); // still added — redacted-but-delivered still reached the agent.
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('an isError:true downstream result that is NOT blocked still adds its configured context label — "error results that still expose observable untrusted content" (ADR-0013 point 8)', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      tools: { error_result: { adds_on_result: ['untrusted_content'] } },
    });
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'error_result', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      let approval;
      for (let i = 0; i < 50 && !approval; i++) {
        approval = storage.listPendingApprovals()[0];
        if (!approval) await new Promise((r) => setTimeout(r, 100));
      }
      approvalManager.approve(approval.id);
      const { event } = await promise;
      expect(event.status).toBe('SUCCEEDED'); // isError:true from downstream is still a policy-level SUCCEEDED — the downstream call itself did not throw.
      const state = storage.getContextState(ctx.contextId)!;
      expect(state.labels).toEqual(['untrusted_content']); // still labeled — content reached the agent regardless of the tool's own isError flag.
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('a genuinely FAILED call (downstream execution threw) never adds context labels — no result was ever produced to describe', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      tools: { leak_error: { adds_on_result: ['untrusted_content'] } },
    });
    ctx.config.policy = policyPath; // uses the shared policy; leak_error is not allowed, add a fresh allow-all policy for this one case
    const localPolicyPath = path.join(tmpDir, 'policy-allow-leak-error.yml');
    fs.writeFileSync(localPolicyPath, 'version: 1\ndefaults:\n  decision: allow\nrules: []\n');
    ctx.config.policy = localPolicyPath;
    try {
      const { event } = await runPipeline({ ctx, agent: AGENT, toolName: 'leak_error', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      expect(event.status).toBe('FAILED');
      const state = storage.getContextState(ctx.contextId)!;
      expect(state.labels).toEqual([]);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('the audit chain and the Context Guard chain both stay independently valid across a mixed sequence of calls', async () => {
    const { ctx, storage, approvalManager } = makeCtx({
      mode: 'enforce',
      tools: { echo: { adds_on_result: ['untrusted_content'] }, forbidden_tool: {} },
    });
    try {
      await runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      await runPipeline({ ctx, agent: AGENT, toolName: 'forbidden_tool', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '2' });
      expect(storage.verifyChain().valid).toBe(true);
      expect(storage.verifyContextChain().valid).toBe(true);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('SSE/audit ordering: every emitted event for a Context-Guard-escalated DENY is preceded by its own durable storage write, in the same fixed order as every other decision type', async () => {
    const { ctx, storage, approvalManager, events } = makeCtx({
      mode: 'enforce',
      tools: { forbidden_tool: { effects: ['destructive_write'] } },
      rules: [{ id: 'r1', when: { target_has_any: ['destructive_write'] }, action: 'deny', reason: 'x' }],
    });
    // Checked INSIDE the mock, synchronously, at the exact moment each
    // event is emitted — the storage write must already be durable at
    // that instant, not merely "eventually" by the time the whole
    // pipeline call finishes (which would trivially always show the
    // FINAL status and prove nothing about ordering). The SAME bus now
    // carries both AuditEvent transitions (RECEIVED/DENIED — discriminate
    // by `status`) and the Context Guard `call_evaluated` ContextEvent
    // (discriminate by `event_type`) — see pipeline.ts step 4.5.
    type EmittedKind = { kind: 'audit'; emittedStatus: string; storedStatusAtThatMoment: string } | { kind: 'context'; emittedEventType: string };
    const snapshotsAtEmitTime: EmittedKind[] = [];
    const emitSpy = vi.fn((event: { id: string; status?: string; event_type?: string }) => {
      if ('event_type' in event && event.event_type) {
        snapshotsAtEmitTime.push({ kind: 'context', emittedEventType: event.event_type });
        return;
      }
      const storedNow = storage.getEvent(event.id);
      snapshotsAtEmitTime.push({ kind: 'audit', emittedStatus: event.status!, storedStatusAtThatMoment: storedNow!.status });
    });
    ctx.emitEvent = emitSpy as unknown as typeof ctx.emitEvent;
    try {
      await runPipeline({ ctx, agent: AGENT, toolName: 'forbidden_tool', rawArgs: {}, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      expect(emitSpy).toHaveBeenCalledTimes(3); // RECEIVED, call_evaluated, then DENIED
      expect(
        snapshotsAtEmitTime.map((s) => (s.kind === 'audit' ? s.emittedStatus : `context:${s.emittedEventType}`))
      ).toEqual(['RECEIVED', 'context:call_evaluated', 'DENIED']);
      // At the moment of EACH audit-event emit, storage already durably
      // reflects that exact status — the write always precedes the
      // notify, never the reverse, for every transition including a
      // Context-Guard-escalated one.
      for (const snap of snapshotsAtEmitTime) {
        if (snap.kind === 'audit') expect(snap.storedStatusAtThatMoment).toBe(snap.emittedStatus);
      }
      void events;
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('Safe Replay never invokes any Context Guard code path: replay.ts imports nothing from context-guard/*', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/replay.ts'), 'utf8');
    const importLines = source
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    expect(importLines).not.toMatch(/context-guard/);
  });

  it('Tool Integrity quarantine precedes Context Guard structurally: transport/stdio.ts checks checkCallAllowed() and returns BEFORE runPipeline() is ever reached for a blocked call', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/transport/stdio.ts'), 'utf8');
    const checkIdx = source.indexOf('checkCallAllowed(');
    const runPipelineIdx = source.indexOf('await runPipeline(');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(runPipelineIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(runPipelineIdx); // Tool Integrity gate is checked strictly before Context Guard/base policy ever run.
    // The blocked branch itself returns — proven by the literal source
    // shape immediately following the check.
    const blockedBranch = source.slice(checkIdx, runPipelineIdx);
    expect(blockedBranch).toMatch(/if\s*\(!callCheck\.allowed\)\s*\{[\s\S]*return/);
  });
});
