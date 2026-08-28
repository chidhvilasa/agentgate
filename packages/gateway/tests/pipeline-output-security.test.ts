import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/pipeline.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import type { AgentIdentity } from '@chidhvilasa/protocol';
import type { GatewayConfig } from '../src/config/registry.js';
import { defaultContextGuardConfig } from '../src/config/registry.js';
import { createContext } from '../src/context-guard/state.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/fixture-downstream-server.mjs');

// Synthetic-only, matches the fixture server's SYNTHETIC_SECRET.
const SYNTHETIC_SECRET = 'AKIAIOSFODNN7EXAMPLE';

const AGENT: AgentIdentity = {
  session_id: 'pipeline-output-security-test',
  declared_name: null,
  declared_version: null,
  connection_identity: 'test',
  verified_identity: false,
};

describe('Pipeline output security (ADR-0009)', () => {
  let tmpDir: string;
  let policyPath: string;
  let storage: AuditStorage;
  let approvalManager: ApprovalManager;

  function makeConfig(mode: 'redact' | 'block'): GatewayConfig {
    return {
      version: 1,
      gateway_port: 0,
      control_port: 0,
      policy: policyPath,
      db_path: ':memory:',
      servers: [{ id: 'fixture', transport: 'stdio', command: 'node', args: [FIXTURE_SERVER] }],
      retention: { max_days: 30, max_events: 100000 },
      output_security: { mode, opaque_content: 'allow_uninspected', max_depth: 8, max_text_bytes: 1_000_000 },
      context_guard: defaultContextGuardConfig(),
    };
  }

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-pipeline-test-'));
    policyPath = path.join(tmpDir, 'policy.yml');
    fs.writeFileSync(
      policyPath,
      `
version: 1
defaults:
  decision: deny
rules:
  - id: allow-fixture-tools
    tools: ["echo", "leak_secret", "leak_error", "error_result"]
    decision: allow
  - id: require-approval-for-approve-me
    tools: ["approve_me"]
    decision: require_approval
    approval_ttl_seconds: 30
  - id: deny-forbidden
    tools: ["forbidden_tool"]
    decision: deny
`
    );
  });

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function freshContext(mode: 'redact' | 'block') {
    storage = new AuditStorage(':memory:');
    approvalManager = new ApprovalManager(storage);
    const config = makeConfig(mode);
    // A real Context Guard execution context, created exactly the way
    // server.ts creates one for a real upstream connection (ADR-0013) —
    // runPipeline() requires one to already exist, same as production.
    const contextId = crypto.randomUUID();
    createContext(storage, contextId, null);
    const ctx = { storage, approvalManager, config, contextId, emitEvent: () => {} };
    return ctx;
  }

  it('forwards a clean result unchanged and stores no redaction metadata', async () => {
    const ctx = freshContext('redact');
    try {
      const { event, result } = await runPipeline({
        ctx,
        agent: AGENT,
        toolName: 'echo',
        rawArgs: { text: 'hello there' },
        mcpEra: 'legacy-2025',
        jsonrpcId: '1',
      });
      expect(event.status).toBe('SUCCEEDED');
      expect(event.result_redacted).toBe(false);
      expect(event.result_blocked).toBe(false);
      expect((result as { content: Array<{ text: string }> }).content[0].text).toBe('hello there');
      expect(storage.verifyChain().valid).toBe(true);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('redacts a secret-bearing result before it is returned upstream and records metadata', async () => {
    const ctx = freshContext('redact');
    try {
      const { event, result } = await runPipeline({
        ctx,
        agent: AGENT,
        toolName: 'leak_secret',
        rawArgs: {},
        mcpEra: 'legacy-2025',
        jsonrpcId: '1',
      });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      expect(text).not.toContain(SYNTHETIC_SECRET);
      expect(event.status).toBe('SUCCEEDED');
      expect(event.result_redacted).toBe(true);
      expect(event.result_blocked).toBe(false);
      expect(event.result_finding_count).toBeGreaterThan(0);

      // Re-fetch from storage independently — metadata must have actually persisted.
      const stored = storage.getEvent(event.id)!;
      expect(stored.result_redacted).toBe(true);
      expect(storage.verifyChain().valid).toBe(true);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('sanitizes downstream isError results the same as success results', async () => {
    const ctx = freshContext('redact');
    try {
      const { result } = await runPipeline({
        ctx,
        agent: AGENT,
        toolName: 'error_result',
        rawArgs: {},
        mcpEra: 'legacy-2025',
        jsonrpcId: '1',
      });
      const r = result as { content: Array<{ text: string }>; isError: boolean };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).not.toContain(SYNTHETIC_SECRET);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('block mode replaces a secret-bearing result with a protocol-valid error and never persists the raw result', async () => {
    const ctx = freshContext('block');
    try {
      const { event, result } = await runPipeline({
        ctx,
        agent: AGENT,
        toolName: 'leak_secret',
        rawArgs: {},
        mcpEra: 'legacy-2025',
        jsonrpcId: '1',
      });
      const r = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(r.isError).toBe(true);
      expect(r.content[0].type).toBe('text');
      expect(r.content[0].text).not.toContain(SYNTHETIC_SECRET);
      expect(event.result_blocked).toBe(true);
      expect(event.result_redacted).toBe(false);

      // The raw synthetic secret must never appear anywhere in the persisted row.
      const row = (storage as unknown as { db: { prepare: (q: string) => { get: (id: string) => unknown } } }).db
        .prepare('SELECT * FROM audit_events WHERE id = ?')
        .get(event.id);
      expect(JSON.stringify(row)).not.toContain(SYNTHETIC_SECRET);
      expect(storage.verifyChain().valid).toBe(true);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  });

  it('denied inbound calls are unaffected by output security (no regression)', async () => {
    const ctx = freshContext('redact');
    try {
      const { event, result } = await runPipeline({
        ctx,
        agent: AGENT,
        toolName: 'forbidden_tool',
        rawArgs: {},
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

  it('the approval path still works end-to-end with output security enabled', async () => {
    const ctx = freshContext('redact');
    try {
      const pipelinePromise = runPipeline({
        ctx,
        agent: AGENT,
        toolName: 'approve_me',
        rawArgs: {},
        mcpEra: 'legacy-2025',
        jsonrpcId: '1',
      });

      // Poll for the approval to appear, then approve it — runPipeline() is
      // concurrently polling storage every 500ms waiting for this decision.
      let approvalId: string | undefined;
      const deadline = Date.now() + 10_000;
      while (!approvalId && Date.now() < deadline) {
        const pending = approvalManager.listPending();
        if (pending.length > 0) approvalId = pending[0].id;
        else await new Promise((r) => setTimeout(r, 100));
      }
      expect(approvalId).toBeDefined();
      const approveResult = approvalManager.approve(approvalId!);
      expect(approveResult.ok).toBe(true);

      const { event } = await pipelinePromise;
      // approve_me isn't a real fixture tool, so downstream resolution will
      // fail after approval — the point of this test is that the approval
      // hand-off itself still works with output security wired in, not the
      // downstream outcome.
      expect(['SUCCEEDED', 'FAILED']).toContain(event.status);
    } finally {
      approvalManager.destroy();
      storage.close();
    }
  }, 15_000);
});
