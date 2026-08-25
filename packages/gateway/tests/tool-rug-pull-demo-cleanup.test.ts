// Injected-failure cleanup proof for the rug-pull demo (Milestone 6,
// ADR-0012, Phase C). The demo's `finally` block is executable evidence,
// not merely inspected by eye: this test spawns the real demo script as a
// child process with a deterministic fault-injection env var set (see
// `RUG_PULL_INJECT_FAILURE` in examples/tool-rug-pull/demo.mjs — a no-op in
// every normal run), forcing it to throw partway through, and then proves
// cleanup still happened — no leftover temp directory, and the spawned
// gateway's control port is no longer listening.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../');
const DEMO_SCRIPT = path.join(ROOT, 'examples/tool-rug-pull/demo.mjs');
const CONTROL_PORT = 4344; // must match GATEWAY_PORT/CONTROL_PORT constants in demo.mjs

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

describe('Tool rug-pull demo — injected-failure cleanup proof', () => {
  it(
    'still removes its temp directory and stops the gateway when a mid-run failure is injected after Step 3',
    async () => {
      const before = new Set(fs.readdirSync(os.tmpdir()));

      const result = await runDemo({ ...process.env, RUG_PULL_INJECT_FAILURE: 'after-step-3' });

      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('injected failure: simulated fault after Step 3');

      // No new agentgate-rug-pull-* temp directory left behind.
      const leftoverDirs = fs
        .readdirSync(os.tmpdir())
        .filter((f) => f.startsWith('agentgate-rug-pull-') && !before.has(f));
      expect(leftoverDirs).toEqual([]);

      // The gateway's control port is no longer listening — the spawned
      // gateway child process was actually terminated, not orphaned.
      // A short settle delay covers OS-level socket teardown timing.
      await new Promise((r) => setTimeout(r, 300));
      expect(await isPortListening(CONTROL_PORT)).toBe(false);
    },
    30000
  );

  it('the fault-injection hook has zero effect when unset (sanity check that it is truly a no-op by default)', async () => {
    const result = await runDemo({ ...process.env });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('ALL TESTS PASSED');
  }, 30000);
});
