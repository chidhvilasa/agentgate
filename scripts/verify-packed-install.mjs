// Packed-package installability verification (Milestone 5, Phase 1/11).
//
// Proves — with real `pnpm pack` and a real `npm install` into a clean,
// isolated consumer project, not an assumption — that AgentGate can
// actually be installed and run from packed tarballs, not only from a
// source checkout. This is the executable evidence behind any "packaged
// install" claim in the docs.
//
// Requires network access to resolve the packages' own external
// dependencies (fastify, zod, etc.) from the real npm registry — this is
// no different from the frozen-lockfile `pnpm install` step CI already
// performs, and does not weaken the separate, fully-offline requirement
// on `agentgate smoke-test` itself (verified independently).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PACKAGES = ['protocol', 'policy', 'gateway'];
// pnpm/npm are .cmd shims on Windows — execFileSync needs shell:true there
// to resolve them; POSIX doesn't need or want it.
const SHELL = process.platform === 'win32';

function check(label, condition) {
  console.log(`${condition ? '✅ PASS' : '❌ FAIL'} — ${label}`);
  return Boolean(condition);
}

async function main() {
  const packDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-pack-'));
  const consumerDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentgate-consumer-'));
  const results = [];

  try {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  AgentGate — Packed-Install Verification                   ');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('Step 1 — pnpm pack each publishable package...');
    const tarballs = [];
    for (const pkg of PACKAGES) {
      const out = execFileSync('pnpm', ['pack', '--pack-destination', packDir], {
        cwd: path.join(ROOT, 'packages', pkg),
        encoding: 'utf-8',
        shell: SHELL,
      });
      const tarballLine = out.trim().split('\n').pop();
      const tarballPath = tarballLine.startsWith(packDir) ? tarballLine : path.join(packDir, tarballLine);
      tarballs.push(tarballPath);
      results.push(check(`pnpm pack produced a tarball for @agentgate/${pkg}`, fs.existsSync(tarballPath)));
    }

    console.log('\nStep 2 — verify tarball contents exclude src/ and tests/ (packaging hygiene)...');
    const gatewayTarball = tarballs[tarballs.length - 1];
    // --force-local avoids tar misreading a Windows "C:\..." absolute path
    // as a "host:path" remote-tar spec (the colon after the drive letter).
    const listing = execFileSync('tar', ['--force-local', '-tzf', gatewayTarball], { encoding: 'utf-8' });
    results.push(check('gateway tarball does not include src/', !listing.includes('package/src/')));
    results.push(check('gateway tarball does not include tests/', !listing.includes('package/tests/')));
    results.push(check('gateway tarball includes dist/cli.js', listing.includes('package/dist/cli.js')));
    results.push(check('gateway tarball includes the smoke-test fixture', listing.includes('package/dist/onboarding/smokeFixtureServer.mjs')));

    console.log('\nStep 3 — npm install all three tarballs together into a clean consumer project...');
    execFileSync('npm', ['init', '-y'], { cwd: consumerDir, stdio: 'ignore', shell: SHELL });
    execFileSync('npm', ['install', ...tarballs], { cwd: consumerDir, stdio: 'ignore', shell: SHELL });
    const binName = process.platform === 'win32' ? 'agentgate.cmd' : 'agentgate';
    const binPath = path.join(consumerDir, 'node_modules', '.bin', binName);
    results.push(check('agentgate CLI binary was installed into node_modules/.bin', fs.existsSync(binPath)));

    console.log('\nStep 4 — run the installed CLI...');
    const helpOut = execFileSync(binPath, [], { cwd: consumerDir, encoding: 'utf-8', shell: process.platform === 'win32' });
    results.push(check('agentgate (no args) prints usage help', helpOut.includes('AgentGate') && helpOut.includes('smoke-test')));

    const versionOut = execFileSync(binPath, ['--version'], { cwd: consumerDir, encoding: 'utf-8', shell: process.platform === 'win32' }).trim();
    results.push(check(`agentgate --version prints a version string (got "${versionOut}")`, /^\d+\.\d+\.\d+/.test(versionOut)));

    const smokeOut = execFileSync(binPath, ['smoke-test'], { cwd: consumerDir, encoding: 'utf-8', shell: process.platform === 'win32' });
    results.push(check('agentgate smoke-test passes from the installed package', smokeOut.includes('Smoke test passed')));

    console.log('\nStep 5 — Context Guard CLI (ADR-0013) help/read-only command smoke from the installed package...');
    const contextHelpOut = execFileSync(binPath, ['context', '--help'], { cwd: consumerDir, encoding: 'utf-8', shell: process.platform === 'win32' });
    results.push(check('agentgate context --help prints usage and the conservative-observation wording', contextHelpOut.includes('Usage: agentgate context') && /conservative/i.test(contextHelpOut)));

    // A minimal real config + empty db so `context status`/`verify` (read-only) can run against a genuine, if empty, database — never a downstream launch.
    fs.writeFileSync(path.join(consumerDir, 'policy.yml'), 'version: 1\ndefaults:\n  decision: deny\nrules: []\n');
    fs.writeFileSync(
      path.join(consumerDir, 'agentgate.yml'),
      'version: 1\ngateway_port: 4799\ncontrol_port: 4798\npolicy: ./policy.yml\ndb_path: ./context-guard-smoke.sqlite\ncontext_guard:\n  mode: enforce\nservers:\n  - id: fixture\n    transport: stdio\n    command: node\n    args: ["dummy.mjs"]\n'
    );
    const contextStatusOut = execFileSync(binPath, ['context', 'status', '--config', 'agentgate.yml', '--json'], {
      cwd: consumerDir,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    });
    const contextStatusParsed = JSON.parse(contextStatusOut);
    results.push(check('agentgate context status --json runs read-only against a fresh installed database', Array.isArray(contextStatusParsed.contexts)));

    const contextVerifyOut = execFileSync(binPath, ['context', 'verify', '--config', 'agentgate.yml'], { cwd: consumerDir, encoding: 'utf-8', shell: process.platform === 'win32' });
    results.push(check('agentgate context verify passes against a fresh installed (empty) chain', contextVerifyOut.includes('✅') || /verified/i.test(contextVerifyOut)));
    fs.unlinkSync(path.join(consumerDir, 'context-guard-smoke.sqlite'));

    const allPassed = results.every(Boolean);
    console.log('');
    if (allPassed) {
      console.log('🎉 ALL CHECKS PASSED. AgentGate installs and runs correctly from packed tarballs.');
    } else {
      console.error('❌ One or more checks failed — see PASS/FAIL lines above.');
    }
    process.exitCode = allPassed ? 0 : 1;
  } finally {
    await fsp.rm(packDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(consumerDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
