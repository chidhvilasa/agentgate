// Startup/shutdown lifecycle hardening (Milestone 5, Phase 7). Spawns the
// real, compiled CLI as a child process — these are the only tests in the
// suite that require `pnpm run build` to have run first, matching how
// examples/*/demo.mjs already work.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../');
const CLI_BIN = path.join(ROOT, 'packages/gateway/dist/cli.js');

function toYamlPath(p: string): string {
  return p.split(path.sep).join('/');
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe('Gateway lifecycle (Milestone 5)', () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const tmpDirs: string[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (!child.killed) child.kill('SIGKILL');
    }
    for (const dir of tmpDirs.splice(0)) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function startGateway(port: number, controlPort: number): Promise<{ child: ChildProcessWithoutNullStreams; stderr: string[]; tmpDir: string }> {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-lifecycle-'));
    tmpDirs.push(tmpDir);
    const policyPath = path.join(tmpDir, 'policy.yml');
    const configPath = path.join(tmpDir, 'agentgate.yml');
    fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: deny\nrules: []\n');
    fs.writeFileSync(
      configPath,
      `version: 1\ngateway_port: ${port}\ncontrol_port: ${controlPort}\npolicy: ${toYamlPath(policyPath)}\ndb_path: ${toYamlPath(path.join(tmpDir, 'a.sqlite'))}\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: ["--version"]\n`
    );

    const child = spawn('node', [CLI_BIN, 'start', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    await waitFor(() => stderr.some((l) => l.includes('Control API listening')), 8000, 'Control API to start listening');
    return { child, stderr, tmpDir };
  }

  // Node's child_process.kill('SIGINT'/'SIGTERM') is a real, catchable
  // signal delivery on POSIX (Linux/macOS) — exactly what a real terminal
  // Ctrl+C or `kill -TERM` sends — but on Windows it unconditionally
  // terminates the child process outright, bypassing any registered
  // `process.on('SIGINT', ...)` handler entirely (a documented Node/
  // Windows platform limitation, not a defect in the handler itself: a
  // real Windows CTRL_C console event, which this test cannot simulate
  // via child_process.kill(), is delivered differently). The strict
  // graceful-shutdown assertions therefore only run on POSIX; a separate,
  // platform-agnostic structural test below confirms the handler code
  // itself is present regardless of platform.
  it.skipIf(process.platform === 'win32')(
    'shuts down cleanly on SIGINT: process exits with code 0 and prints a shutdown-complete message',
    async () => {
      const { child, stderr } = await startGateway(4501, 4502);

      child.kill('SIGINT');
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });

      expect(exit.code).toBe(0);
      const combined = stderr.join('');
      expect(combined).toContain('Received SIGINT');
      expect(combined).toContain('Shutdown complete');
    },
    15000
  );

  it.skipIf(process.platform === 'win32')(
    'shuts down cleanly on SIGTERM as well',
    async () => {
      const { child, stderr } = await startGateway(4503, 4504);

      child.kill('SIGTERM');
      const exit = await new Promise<{ code: number | null }>((resolve) => {
        child.on('exit', (code) => resolve({ code }));
      });

      expect(exit.code).toBe(0);
      expect(stderr.join('')).toContain('Received SIGTERM');
    },
    15000
  );

  it('registers real SIGINT and SIGTERM handlers in source (platform-agnostic structural check, complementing the POSIX-only behavioral tests above)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf-8');
    expect(source).toContain("process.on('SIGINT'");
    expect(source).toContain("process.on('SIGTERM'");
    expect(source).toContain('storage.close()');
  });

  it('a second gateway on an already-occupied control port fails with a clear error and does not affect the first process', async () => {
    const first = await startGateway(4505, 4506);

    const secondTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-lifecycle-'));
    tmpDirs.push(secondTmp);
    const policyPath = path.join(secondTmp, 'policy.yml');
    const configPath = path.join(secondTmp, 'agentgate.yml');
    fs.writeFileSync(policyPath, 'version: 1\ndefaults:\n  decision: deny\nrules: []\n');
    fs.writeFileSync(
      configPath,
      `version: 1\ngateway_port: 4507\ncontrol_port: 4506\npolicy: ${toYamlPath(policyPath)}\ndb_path: ${toYamlPath(path.join(secondTmp, 'b.sqlite'))}\nservers:\n  - id: s\n    transport: stdio\n    command: node\n    args: ["--version"]\n`
    );

    const second = spawn('node', [CLI_BIN, 'start', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(second);
    const secondStderr: string[] = [];
    second.stderr.on('data', (chunk: Buffer) => secondStderr.push(chunk.toString('utf8')));

    const exit = await new Promise<{ code: number | null }>((resolve) => {
      second.on('exit', (code) => resolve({ code }));
    });

    expect(exit.code).not.toBe(0);
    expect(secondStderr.join('').toLowerCase()).toMatch(/address already in use|eaddrinuse/);

    // The first process must be completely unaffected by the second one's failed start.
    expect(first.child.killed).toBe(false);
    expect(first.child.exitCode).toBeNull();
  }, 15000);
});
