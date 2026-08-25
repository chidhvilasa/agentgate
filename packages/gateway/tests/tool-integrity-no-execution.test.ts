import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TI_DIR = path.join(__dirname, '../src/tool-integrity');

function importLinesOf(file: string): string {
  const source = fs.readFileSync(path.join(TI_DIR, file), 'utf8');
  return source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line))
    .join('\n');
}

/**
 * Structural, permanent guardrails (Milestone 6, ADR-0012) — mirrors the
 * approach in replay-no-execution.test.ts. These check only actual import
 * statements, not comment prose (which is free to mention these names
 * when explaining why they are absent). The point is to catch, at the
 * import-graph level, any future change that accidentally wires a module
 * that is supposed to be pure/inert to the MCP SDK, downstream execution,
 * or the policy pipeline — regardless of what the code happens to do at
 * runtime today.
 *
 * scan.ts is deliberately exempt: it is documented as the ONLY module in
 * Tool Integrity that ever spawns/connects to a downstream server, and it
 * still may never import executeDownstream, runPipeline, or the approval
 * manager — it only ever calls `initialize` and `tools/list`.
 */
describe('Tool Integrity — structural no-execution guarantees (ADR-0012)', () => {
  const forbiddenExecutionSymbols = [
    /\bexecuteDownstream\b/,
    /\brunPipeline\b/,
    /\bApprovalManager\b/,
  ];

  it('canonicalize.ts never imports the MCP SDK, execution, or approvals', () => {
    const importLines = importLinesOf('canonicalize.ts');
    expect(importLines).not.toContain('@modelcontextprotocol/sdk');
    expect(importLines).not.toContain('approval.js');
    for (const pattern of forbiddenExecutionSymbols) {
      expect(importLines).not.toMatch(pattern);
    }
  });

  it('identity.ts never imports the MCP SDK, execution, or approvals', () => {
    const importLines = importLinesOf('identity.ts');
    expect(importLines).not.toContain('@modelcontextprotocol/sdk');
    expect(importLines).not.toContain('approval.js');
    for (const pattern of forbiddenExecutionSymbols) {
      expect(importLines).not.toMatch(pattern);
    }
  });

  it('registry.ts never imports the MCP SDK, execution, or approvals', () => {
    const importLines = importLinesOf('registry.ts');
    expect(importLines).not.toContain('@modelcontextprotocol/sdk');
    expect(importLines).not.toContain('approval.js');
    for (const pattern of forbiddenExecutionSymbols) {
      expect(importLines).not.toMatch(pattern);
    }
  });

  it('diff.ts never imports the MCP SDK, execution, or approvals — it is pure and side-effect-free', () => {
    const importLines = importLinesOf('diff.ts');
    expect(importLines).not.toContain('@modelcontextprotocol/sdk');
    expect(importLines).not.toContain('approval.js');
    for (const pattern of forbiddenExecutionSymbols) {
      expect(importLines).not.toMatch(pattern);
    }
  });

  it('enforcement.ts never imports the MCP SDK, execution, or approvals — it only reads stored registry state', () => {
    const importLines = importLinesOf('enforcement.ts');
    expect(importLines).not.toContain('@modelcontextprotocol/sdk');
    expect(importLines).not.toContain('approval.js');
    for (const pattern of forbiddenExecutionSymbols) {
      expect(importLines).not.toMatch(pattern);
    }
  });

  it('scan.ts is the only Tool Integrity module permitted to import the MCP client transport, and even it never imports execution or approvals', () => {
    const importLines = importLinesOf('scan.ts');
    expect(importLines).toContain('@modelcontextprotocol/sdk/client');
    expect(importLines).not.toContain('approval.js');
    for (const pattern of forbiddenExecutionSymbols) {
      expect(importLines).not.toMatch(pattern);
    }
  });

  it('no other file under tool-integrity/ imports the MCP SDK', () => {
    const files = fs.readdirSync(TI_DIR).filter((f) => f.endsWith('.ts') && f !== 'scan.ts');
    for (const file of files) {
      const importLines = importLinesOf(file);
      expect(importLines, `${file} must not import the MCP SDK`).not.toContain('@modelcontextprotocol/sdk');
    }
  });
});
