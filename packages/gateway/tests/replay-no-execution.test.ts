import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/pipeline.js';
import { evaluateHistoricalEvent } from '../src/replay.js';
import { AuditStorage } from '../src/storage.js';
import { ApprovalManager } from '../src/approval.js';
import type { AgentIdentity } from '@agentgate/protocol';
import type { GatewayConfig } from '../src/config/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(__dirname, 'fixtures/fixture-downstream-server.mjs');

const AGENT: AgentIdentity = {
  session_id: 'replay-no-execution-test',
  declared_name: null,
  declared_version: null,
  connection_identity: 'test',
  verified_identity: false,
};

function readCounter(counterFile: string): number {
  try {
    return parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

describe('Safe Replay — structural no-execution guarantee (ADR-0010)', () => {
  it('replay.ts imports nothing capable of reaching a downstream server or creating an approval', () => {
    // A structural, permanent guardrail — not just a behavioral test of
    // today's code paths. If a future change accidentally wires replay.ts
    // to the MCP SDK, executeDownstream, runPipeline, or ApprovalManager,
    // this fails immediately regardless of what the code actually does at
    // runtime. Only actual import statements are checked (not comment
    // prose, which is free to mention these names when explaining why they
    // are absent).
    const source = fs.readFileSync(path.join(__dirname, '../src/replay.ts'), 'utf8');
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');

    expect(importLines).not.toContain('@modelcontextprotocol/sdk');
    expect(importLines).not.toContain('approval.js');
    expect(importLines).not.toContain('StdioClientTransport');
    expect(importLines).not.toMatch(/\bexecuteDownstream\b/);
    expect(importLines).not.toMatch(/\brunPipeline\b/);

    // Only the three pure, side-effect-free extractor helpers may be
    // imported from pipeline.ts — anything else from that module would be
    // a red flag worth reviewing by hand.
    const pipelineImportLine = source.split('\n').find((l) => l.includes("from './pipeline.js'"));
    expect(pipelineImportLine).toBeDefined();
    expect(pipelineImportLine).toMatch(/extractPrimaryPath/);
    expect(pipelineImportLine).toMatch(/extractCommand/);
    expect(pipelineImportLine).toMatch(/extractHost/);
  });
});

describe('Safe Replay — executable no-execution proof (fixture call counter)', () => {
  let tmpDir: string;
  let counterFile: string;
  let policyPath: string;
  let storage: AuditStorage;
  let approvalManager: ApprovalManager;
  let config: GatewayConfig;
  let sourceEventId: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-replay-noexec-'));
    counterFile = path.join(tmpDir, 'call-count.txt');
    policyPath = path.join(tmpDir, 'policy.yml');
    fs.writeFileSync(
      policyPath,
      `
version: 1
defaults:
  decision: deny
rules:
  - id: allow-echo
    tools: ["echo"]
    decision: allow
`
    );

    storage = new AuditStorage(':memory:');
    approvalManager = new ApprovalManager(storage);
    config = {
      version: 1,
      gateway_port: 0,
      control_port: 0,
      policy: policyPath,
      db_path: ':memory:',
      servers: [
        {
          id: 'fixture',
          transport: 'stdio',
          command: 'node',
          args: [FIXTURE_SERVER],
          env: { FIXTURE_CALL_COUNT_FILE: counterFile },
        },
      ],
      retention: { max_days: 30, max_events: 100000 },
      output_security: { mode: 'redact', opaque_content: 'allow_uninspected', max_depth: 8, max_text_bytes: 1_000_000 },
    };

    // One REAL execution — this is expected to bump the counter to 1 and
    // creates the source event replay will later be evaluated against.
    const ctx = { storage, approvalManager, config, emitEvent: () => {} };
    const { event } = await runPipeline({
      ctx,
      agent: AGENT,
      toolName: 'echo',
      rawArgs: { text: 'real execution' },
      mcpEra: 'legacy-2025',
      jsonrpcId: '1',
    });
    sourceEventId = event.id;
    expect(event.status).toBe('SUCCEEDED');
  });

  afterAll(async () => {
    approvalManager.destroy();
    storage.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('the fixture counter is 1 after one real execution (sanity check on the proof mechanism itself)', () => {
    expect(readCounter(counterFile)).toBe(1);
  });

  it('replaying the same event many times never increments the downstream call counter', () => {
    const currentPolicy = { version: 1 as const, defaults: { decision: 'deny' as const }, rules: [{ id: 'allow-echo', tools: ['echo'], decision: 'allow' as const }] };
    const sourceEvent = storage.getEvent(sourceEventId)!;

    for (let i = 0; i < 5; i++) {
      const comparison = evaluateHistoricalEvent({ sourceEvent, currentPolicy });
      expect(comparison.current.decision_type).toBe('ALLOW');
    }

    expect(readCounter(counterFile)).toBe(1); // still 1 — replay never touched the fixture
  });

  it('never creates or resolves an approval during replay', () => {
    const createSpy = vi.spyOn(approvalManager, 'create');
    const approveSpy = vi.spyOn(approvalManager, 'approve');
    const denySpy = vi.spyOn(approvalManager, 'deny');

    const currentPolicy = {
      version: 1 as const,
      defaults: { decision: 'deny' as const },
      rules: [{ id: 'approve-echo', tools: ['echo'], decision: 'require_approval' as const, approval_ttl_seconds: 60 }],
    };
    const sourceEvent = storage.getEvent(sourceEventId)!;
    const comparison = evaluateHistoricalEvent({ sourceEvent, currentPolicy });

    // The hypothetical current decision IS require_approval — proving the
    // comparison reports it honestly — but no real Approval was created.
    expect(comparison.current.decision_type).toBe('REQUIRE_APPROVAL');
    expect(createSpy).not.toHaveBeenCalled();
    expect(approveSpy).not.toHaveBeenCalled();
    expect(denySpy).not.toHaveBeenCalled();
    expect(approvalManager.listPending()).toHaveLength(0);

    createSpy.mockRestore();
    approveSpy.mockRestore();
    denySpy.mockRestore();
  });

  it('never modifies the source event or appends a new audit lifecycle record', () => {
    const beforeEvent = storage.getEvent(sourceEventId)!;
    const beforeAuditCount = storage.verifyChain().count;
    const beforeReplayCount = storage.verifyReplayChain().count;

    const currentPolicy = { version: 1 as const, defaults: { decision: 'deny' as const }, rules: [] as never[] };
    evaluateHistoricalEvent({ sourceEvent: beforeEvent, currentPolicy });
    evaluateHistoricalEvent({ sourceEvent: beforeEvent, currentPolicy });

    const afterEvent = storage.getEvent(sourceEventId)!;
    const afterAuditCount = storage.verifyChain().count;

    // evaluateHistoricalEvent() alone (the pure service) writes nothing —
    // no new audit lifecycle record and the source event is byte-identical.
    expect(afterEvent).toEqual(beforeEvent);
    expect(afterAuditCount).toBe(beforeAuditCount);
    // Sanity: replay lineage IS a separate concern, written only via
    // insertReplayEvaluation() (tested in storage-replay.test.ts), not by
    // evaluateHistoricalEvent() itself — confirm it stayed at 0 here since
    // this test never calls insertReplayEvaluation().
    expect(storage.verifyReplayChain().count).toBe(beforeReplayCount);
  });
});
