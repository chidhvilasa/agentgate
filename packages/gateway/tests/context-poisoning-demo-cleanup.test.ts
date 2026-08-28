// Injected-failure cleanup proof for the context-poisoning demo (Milestone
// 7, ADR-0013). Mirrors tool-rug-pull-demo-cleanup.test.ts's structure and
// discipline exactly: the demo's `finally` block is executable evidence,
// not merely inspected by eye. This test spawns the real demo script as a
// child process with a deterministic fault-injection env var set (see
// `CONTEXT_POISONING_INJECT_FAILURE` in examples/context-poisoning/
// demo.mjs — a no-op in every normal run), forcing it to throw partway
// through (after context A has accumulated both risk labels but before the
// send_webhook deny path is attempted), and proves cleanup still happened —
// no leftover temp directory, and BOTH spawned gateways' control ports are
// no longer listening.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../');
const DEMO_SCRIPT = path.join(ROOT, 'examples/context-poisoning/demo.mjs');
// Must match GATEWAY_PORT_A/CONTROL_PORT_A/CONTROL_PORT_B constants in
// demo.mjs. Gateway B is never started when the fault is injected after
// Step 9 (before gateway A even closes), so only gateway A's control port
// is relevant here — checked anyway for gateway B as a defensive no-op
// (it should simply never have been listening in the first place).
const CONTROL_PORT_A = 4346;
const CONTROL_PORT_B = 4348;

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function runDemo(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DEMO_SCRIPT], { env, cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Context-poisoning demo — injected-failure cleanup proof', () => {
  it(
    'still removes its temp directory and stops both gateways when a mid-run failure is injected after Step 9',
    async () => {
      const before = new Set(fs.readdirSync(os.tmpdir()));

      const result = await runDemo({ ...process.env, CONTEXT_POISONING_INJECT_FAILURE: 'after-step-9' });

      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('injected failure: simulated fault after Step 9');

      // No new agentgate-context-poisoning-* temp directory left behind.
      const leftoverDirs = fs
        .readdirSync(os.tmpdir())
        .filter((f) => f.startsWith('agentgate-context-poisoning-') && !before.has(f));
      expect(leftoverDirs).toEqual([]);

      // Neither gateway's control port is still listening — the spawned
      // gateway child process(es) were actually terminated, not orphaned.
      // A short settle delay covers OS-level socket teardown timing.
      await new Promise((r) => setTimeout(r, 300));
      expect(await isPortListening(CONTROL_PORT_A)).toBe(false);
      expect(await isPortListening(CONTROL_PORT_B)).toBe(false);
    },
    30000
  );

  it('the fault-injection hook has zero effect when unset (sanity check that it is truly a no-op by default)', async () => {
    const result = await runDemo({ ...process.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ALL TESTS PASSED');
  }, 30000);
});
