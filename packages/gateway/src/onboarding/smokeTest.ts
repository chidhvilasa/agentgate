// `agentgate smoke-test` — local, offline, harmless proof that the policy
// engine and audit trail work (Milestone 5, Phase 6). Uses the built-in
// fixture downstream server (smokeFixtureServer.ts) exclusively — never a
// user's real downstream server, never the network. Fully self-cleaning:
// every generated file lives under one mkdtemp'd directory, removed in a
// `finally` on both success and failure.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditStorage } from '../storage.js';
import { ApprovalManager } from '../approval.js';
import { runPipeline, type PipelineContext } from '../pipeline.js';
import type { AgentIdentity } from '@agentgate/protocol';
import type { GatewayConfig } from '../config/registry.js';

export interface SmokeTestStep {
  id: string;
  ok: boolean;
  message: string;
}

export interface SmokeTestReport {
  ok: boolean;
  steps: SmokeTestStep[];
}

// Synthetic-only, unmistakably fake — never a real credential. Matches the
// literal already allowlisted in .github/workflows/security.yml.
const SYNTHETIC_SECRET = 'AKIAIOSFODNN7EXAMPLE';

const AGENT: AgentIdentity = {
  session_id: 'smoke-test',
  declared_name: 'agentgate-smoke-test',
  declared_version: '1.0.0',
  connection_identity: 'smoke-test',
  verified_identity: false,
};

function fixtureServerPath(): string {
  // Plain-JS sibling, not a compiled .ts — present at this exact relative
  // path both in src/ (tests run directly against source via vitest) and
  // in dist/ (copied there by scripts/copy-assets.mjs during `pnpm run
  // build`) — see smokeFixtureServer.mjs's own top comment for why.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'smokeFixtureServer.mjs');
}

export async function runSmokeTest(): Promise<SmokeTestReport> {
  const steps: SmokeTestStep[] = [];
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-smoke-test-'));
  let storage: AuditStorage | null = null;
  let approvalManager: ApprovalManager | null = null;

  try {
    const dbPath = path.join(tmpDir, 'agentgate.sqlite');
    const policyPath = path.join(tmpDir, 'policy.yml');
    fs.writeFileSync(
      policyPath,
      `version: 1\ndefaults:\n  decision: deny\nrules:\n  - id: allow-echo\n    tools: ["echo"]\n    decision: allow\n`
    );
    const config: GatewayConfig = {
      version: 1,
      gateway_port: 0,
      control_port: 0,
      policy: policyPath,
      db_path: dbPath,
      servers: [
        {
          id: 'smoke-fixture',
          transport: 'stdio',
          command: process.execPath,
          args: [fixtureServerPath()],
        },
      ],
      retention: { max_days: 30, max_events: 100000 },
      output_security: { mode: 'redact', opaque_content: 'allow_uninspected', max_depth: 8, max_text_bytes: 1_000_000 },
      // Milestone 6: monitor mode — the smoke test is about the policy
      // engine and audit trail, not Tool Integrity; monitor mode records
      // drift without blocking, matching this project's documented default
      // (see ADR-0012) and keeping the smoke test's existing behavior
      // unchanged.
      tool_integrity: { mode: 'monitor' },
      // Milestone 7: monitor mode — same reasoning as tool_integrity above;
      // the smoke test proves the base policy engine and audit trail work,
      // not Context Guard, and monitor mode never blocks (see ADR-0013).
      context_guard: { mode: 'monitor', labels: [], tools: {}, rules: [] },
    };

    storage = new AuditStorage(dbPath);
    approvalManager = new ApprovalManager(storage);
    const ctx: PipelineContext = { storage, approvalManager, config, contextId: 'smoke-test-context', emitEvent: () => {} };

    // Step 1: a harmless call that policy allows.
    const allowed = await runPipeline({
      ctx,
      agent: AGENT,
      toolName: 'echo',
      rawArgs: { text: 'agentgate smoke test' },
      mcpEra: 'legacy-2025',
      jsonrpcId: '1',
    });
    const allowOk = allowed.event.status === 'SUCCEEDED' && allowed.event.decision?.type === 'ALLOW';
    steps.push({
      id: 'allowed_call',
      ok: allowOk,
      message: allowOk
        ? `"echo" was correctly ALLOWED and executed (status: ${allowed.event.status}).`
        : `Expected "echo" to be ALLOWED and SUCCEEDED, got status=${allowed.event.status} decision=${allowed.event.decision?.type}.`,
    });

    // Step 2: an intentionally denied call — this policy has no rule for it.
    const denied = await runPipeline({
      ctx,
      agent: AGENT,
      toolName: 'delete_everything',
      rawArgs: {},
      mcpEra: 'legacy-2025',
      jsonrpcId: '2',
    });
    const denyOk = denied.event.status === 'DENIED' && denied.event.decision?.type === 'DENY';
    steps.push({
      id: 'denied_call',
      ok: denyOk,
      message: denyOk
        ? `"delete_everything" was correctly DENIED by the default-deny policy.`
        : `Expected "delete_everything" to be DENIED, got status=${denied.event.status} decision=${denied.event.decision?.type}.`,
    });

    // Step 3: a call whose arguments carry a synthetic secret — verifies
    // redaction end-to-end, not just the allow/deny decision.
    const redacted = await runPipeline({
      ctx,
      agent: AGENT,
      toolName: 'echo',
      rawArgs: { text: `hello`, note: SYNTHETIC_SECRET },
      mcpEra: 'legacy-2025',
      jsonrpcId: '3',
    });
    const redactedOk =
      redacted.event.arguments_redacted === true &&
      JSON.stringify(redacted.event.tool_call.normalized_arguments).includes(SYNTHETIC_SECRET) === false;
    steps.push({
      id: 'secret_redaction',
      ok: redactedOk,
      message: redactedOk
        ? 'A synthetic secret in the call arguments was correctly redacted before persistence.'
        : 'Expected the synthetic secret to be redacted from the persisted arguments, but it was not.',
    });

    // Step 4: the audit chain (both records above plus the redaction call)
    // verifies cleanly.
    const chain = storage.verifyChain();
    steps.push({
      id: 'audit_chain',
      ok: chain.valid,
      message: chain.valid ? `Audit chain verified (${chain.count} records).` : `Audit chain invalid: ${chain.error}`,
    });

    // Step 5: no synthetic secret survives anywhere in the database file
    // (belt-and-suspenders check beyond the in-memory assertion above).
    const dbText = fs.readFileSync(dbPath, 'latin1');
    const secretAbsent = !dbText.includes(SYNTHETIC_SECRET);
    steps.push({
      id: 'no_secret_in_storage',
      ok: secretAbsent,
      message: secretAbsent
        ? 'The synthetic secret does not appear anywhere in the on-disk database.'
        : 'The synthetic secret was found in the on-disk database file — this would be a real defect.',
    });

    const ok = steps.every((s) => s.ok);
    return { ok, steps };
  } finally {
    approvalManager?.destroy();
    storage?.close();
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
