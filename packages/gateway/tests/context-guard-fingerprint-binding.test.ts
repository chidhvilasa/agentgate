// Tool-fingerprint approval-binding tests (Milestone 7, ADR-0013 amendment).
// Unit-level (getTrustedFingerprint, checkApprovalContextValid) coverage
// lives in tool-integrity/enforcement.ts's own module and
// context-guard-enforcement.test.ts respectively. This file covers the
// PIPELINE-level real call site: runPipeline() actually populating
// contextBinding.tool_fingerprint from real Tool Integrity state at
// approval creation, and actually revalidating it fresh at consumption
// time — using a real in-memory AuditStorage and real
// upsertToolIntegrityState() rows, never a mock.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { runPipeline } from '../src/pipeline.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import { createContext } from '../src/context-guard/state.js';
import { computeServerIdentity } from '../src/tool-integrity/identity.js';
import { defaultContextGuardConfig, type GatewayConfig } from '../src/config/registry.js';
import type { AgentIdentity } from '@chidhvilasa/protocol';
import type { ToolIntegrityState } from '../src/tool-integrity/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/fixture-downstream-server.mjs');

const AGENT: AgentIdentity = {
  session_id: 'fingerprint-binding-test',
  declared_name: null,
  declared_version: null,
  connection_identity: 'test',
  verified_identity: false,
};

function baseToolIntegrityState(overrides: Partial<ToolIntegrityState> = {}): ToolIntegrityState {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    server_identity: 'srv:fixture',
    server_id: 'fixture',
    tool_name: 'echo',
    status: 'trusted',
    current_fingerprint: 'fp-trusted-v1',
    trusted_fingerprint: 'fp-trusted-v1',
    candidate_fingerprint: null,
    candidate_id: null,
    trusted_definition_json: '{}',
    candidate_definition_json: null,
    first_seen_at: now,
    last_seen_at: now,
    last_scan_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('Context Guard tool_fingerprint approval binding — pipeline call site (ADR-0013)', () => {
  let tmpDir: string;
  let policyPath: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-cg-fp-binding-'));
    policyPath = path.join(tmpDir, 'policy.yml');
    fs.writeFileSync(
      policyPath,
      `
version: 1
defaults:
  decision: deny
rules:
  - id: approve-echo
    tools: ["echo"]
    decision: require_approval
    approval_ttl_seconds: 10
`
    );
  });

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx() {
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
      tool_integrity: { mode: 'monitor' }, // registry is still maintained/queried; enforcement gate itself is out of scope for this pipeline-level test
      context_guard: { ...defaultContextGuardConfig(), mode: 'enforce' },
    };
    const serverIdentity = computeServerIdentity(config.servers[0]).identity;
    const contextId = crypto.randomUUID();
    createContext(storage, contextId, serverIdentity);
    const ctx = { storage, approvalManager, config, contextId, emitEvent: () => {} };
    return { ctx, storage, approvalManager, serverIdentity };
  }

  async function waitForPendingApproval(storage: AuditStorage, scope: string) {
    for (let i = 0; i < 50; i++) {
      const approval = storage.listPendingApprovals().find((a) => a.scope === scope);
      if (approval) return approval;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no pending approval for ${scope} appeared within timeout`);
  }

  it('populates contextBinding.tool_fingerprint from the REAL currently-trusted Tool Integrity fingerprint, never a client-supplied value', async () => {
    const { ctx, storage, approvalManager, serverIdentity } = makeCtx();
    storage.upsertToolIntegrityState(baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', trusted_fingerprint: 'fp-real-trusted', current_fingerprint: 'fp-real-trusted' }));
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      const approval = await waitForPendingApproval(storage, 'echo');
      expect(approval.tool_fingerprint).toBe('fp-real-trusted');
      approvalManager.approve(approval.id);
      await promise;
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('binds a null tool_fingerprint when there is no trusted definition at all (never scanned) — a legitimate "not bound" state', async () => {
    const { ctx, storage, approvalManager } = makeCtx();
    // No upsertToolIntegrityState() call at all — echo has never been scanned.
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      const approval = await waitForPendingApproval(storage, 'echo');
      expect(approval.tool_fingerprint).toBeNull();
      approvalManager.approve(approval.id);
      await promise;
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('binds a null tool_fingerprint when the tool is quarantined (pending_review) rather than trusted', async () => {
    const { ctx, storage, approvalManager, serverIdentity } = makeCtx();
    storage.upsertToolIntegrityState(
      baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', status: 'pending_review', trusted_fingerprint: null, current_fingerprint: 'fp-candidate' })
    );
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      const approval = await waitForPendingApproval(storage, 'echo');
      expect(approval.tool_fingerprint).toBeNull();
      approvalManager.approve(approval.id);
      await promise;
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('CONSUMPTION-time revalidation rejects when the tool drifts (or is quarantined) between approval creation and a human decision — the downstream call never happens', async () => {
    const { ctx, storage, approvalManager, serverIdentity } = makeCtx();
    storage.upsertToolIntegrityState(baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', trusted_fingerprint: 'fp-v1', current_fingerprint: 'fp-v1' }));
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      const approval = await waitForPendingApproval(storage, 'echo');
      expect(approval.tool_fingerprint).toBe('fp-v1');

      // Simulate drift/quarantine happening WHILE the approval is pending —
      // a rescan observed a changed definition, moving the tool to
      // `drifted` and clearing trusted_fingerprint's active-trust status.
      storage.upsertToolIntegrityState(
        baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', status: 'drifted', trusted_fingerprint: 'fp-v1', current_fingerprint: 'fp-v2-drifted' })
      );

      approvalManager.approve(approval.id); // a human approves without knowing about the drift
      const { event, result } = await promise;
      expect(event.status).toBe('CANCELLED'); // execution refused on revalidation despite APPROVED status
      expect(result).toBeNull();
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('a fresh evaluation after re-trust requires its own NEW approval — the cancelled one is never silently retried/reused', async () => {
    const { ctx, storage, approvalManager, serverIdentity } = makeCtx();
    storage.upsertToolIntegrityState(baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', trusted_fingerprint: 'fp-v1', current_fingerprint: 'fp-v1' }));
    let firstApprovalId: string;
    try {
      const promise1 = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      const approval1 = await waitForPendingApproval(storage, 'echo');
      firstApprovalId = approval1.id;
      storage.upsertToolIntegrityState(
        baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', status: 'drifted', trusted_fingerprint: 'fp-v1', current_fingerprint: 'fp-v2-drifted' })
      );
      approvalManager.approve(approval1.id);
      const result1 = await promise1;
      expect(result1.event.status).toBe('CANCELLED');

      // Newly re-trust the drifted definition under its new fingerprint.
      storage.upsertToolIntegrityState(
        baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', status: 'trusted', trusted_fingerprint: 'fp-v2-drifted', current_fingerprint: 'fp-v2-drifted' })
      );

      const promise2 = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '2' });
      const approval2 = await waitForPendingApproval(storage, 'echo');
      expect(approval2.id).not.toBe(firstApprovalId); // a genuinely fresh evaluation, never a reuse
      expect(approval2.tool_fingerprint).toBe('fp-v2-drifted'); // bound to the NEW trusted fingerprint
      approvalManager.approve(approval2.id);
      const result2 = await promise2;
      expect(result2.event.status).toBe('SUCCEEDED');
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('wrong server identity: a trusted fingerprint recorded under a DIFFERENT server_identity is never bound to this tool\'s approval', async () => {
    const { ctx, storage, approvalManager } = makeCtx();
    storage.upsertToolIntegrityState(baseToolIntegrityState({ server_identity: 'srv:some-other-server', tool_name: 'echo', trusted_fingerprint: 'fp-belongs-elsewhere', current_fingerprint: 'fp-belongs-elsewhere' }));
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      const approval = await waitForPendingApproval(storage, 'echo');
      expect(approval.tool_fingerprint).toBeNull(); // this server/tool pair has no trusted state of its own
      approvalManager.approve(approval.id);
      await promise;
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('a rejected tool has a null trusted fingerprint bound, even though a (rejected) fingerprint is on record', async () => {
    const { ctx, storage, approvalManager, serverIdentity } = makeCtx();
    storage.upsertToolIntegrityState(
      baseToolIntegrityState({ server_identity: serverIdentity, tool_name: 'echo', status: 'rejected', trusted_fingerprint: null, current_fingerprint: 'fp-rejected-def' })
    );
    try {
      const promise = runPipeline({ ctx, agent: AGENT, toolName: 'echo', rawArgs: { text: 'hi' }, mcpEra: 'legacy-2025', jsonrpcId: '1' });
      const approval = await waitForPendingApproval(storage, 'echo');
      expect(approval.tool_fingerprint).toBeNull();
      approvalManager.approve(approval.id);
      await promise;
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });
});
