// Version / tag consistency check (Milestone 8 / ADR-0014, Phase 4).
//
// Verifies AgentGate's lockstep versioning invariant, decided in ADR-0014:
// the three publishable packages (@agentgate/protocol, @agentgate/policy,
// @agentgate/gateway) must always carry the EXACT SAME version string, and
// @agentgate/control-center plus the monorepo root must stay `private: true`
// (never published). Also verifies each publishable package's declared
// `@agentgate/protocol` dependency range is satisfied by the actual current
// protocol version — a lockstep promise that is otherwise easy to silently
// violate by hand-editing one package.json and forgetting the others.
//
// Optionally verifies a git tag (passed as `--tag vX.Y.Z` or read from the
// GITHUB_REF_NAME env var when it looks like a tag) matches the lockstep
// version exactly, prefixed with "v" — this is the exact check the release
// workflow (Phase 6) runs before ever attempting to publish; running it here
// too means the same logic is unit-testable in isolation from any CI
// environment or GitHub Actions context.
//
// Pure/offline: reads only the package.json files already on disk. No
// network access, no `npm view`, no registry check — registry-ownership
// verification is a distinct, explicitly-unverified concern (see ADR-0014).
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const PUBLISHABLE_PACKAGES = ['protocol', 'policy', 'gateway'];
export const PRIVATE_PACKAGES = [
  { dir: '.', label: 'monorepo root' },
  { dir: 'apps/control-center', label: '@agentgate/control-center' },
];

function readPkg(relDir) {
  const pkgPath = path.join(ROOT, relDir, 'package.json');
  return { pkgPath, pkg: JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) };
}

/**
 * Runs every consistency check and returns { ok, findings } — never throws
 * on a failed check (only on a genuinely missing/unparseable file), so
 * callers (CLI entry point below, and tests) get a complete report rather
 * than stopping at the first problem.
 */
export function checkReleaseConsistency({ expectedTag } = {}) {
  const findings = [];
  const add = (ok, message) => findings.push({ ok, message });

  const publishable = PUBLISHABLE_PACKAGES.map((name) => ({ name, ...readPkg(`packages/${name}`) }));

  for (const { name, pkg } of publishable) {
    add(pkg.private !== true, `@agentgate/${name}: not marked private (publishable)`);
    add(typeof pkg.version === 'string' && semver.valid(pkg.version) !== null, `@agentgate/${name}: version "${pkg.version}" is valid semver`);
    add(pkg.publishConfig?.access === 'public', `@agentgate/${name}: publishConfig.access is "public"`);
    add(typeof pkg.repository?.url === 'string' && pkg.repository.url.includes('github.com/chidhvilasa/agentgate'), `@agentgate/${name}: repository.url points at the real repo`);
    add(Array.isArray(pkg.files) && pkg.files.length > 0, `@agentgate/${name}: has a restrictive "files" allowlist`);
  }

  const versions = new Set(publishable.map((p) => p.pkg.version));
  add(versions.size === 1, `all publishable packages share one lockstep version (found: ${[...versions].join(', ')})`);
  const lockstepVersion = versions.size === 1 ? [...versions][0] : null;

  const protocolVersion = publishable.find((p) => p.name === 'protocol')?.pkg.version;
  for (const { name, pkg } of publishable) {
    if (name === 'protocol') continue;
    const declaredRange = pkg.dependencies?.['@agentgate/protocol'];
    if (declaredRange === undefined) continue;
    if (declaredRange.startsWith('workspace:')) {
      // Expected in the source tree (rewritten by `pnpm pack`); not a lockstep violation here.
      continue;
    }
    add(
      protocolVersion !== undefined && semver.satisfies(protocolVersion, declaredRange),
      `@agentgate/${name}: declared @agentgate/protocol range "${declaredRange}" is satisfied by protocol's actual version "${protocolVersion}"`
    );
  }

  for (const { dir, label } of PRIVATE_PACKAGES) {
    const { pkg } = readPkg(dir);
    add(pkg.private === true, `${label}: correctly marked private (never published)`);
  }

  if (expectedTag !== undefined && expectedTag !== null) {
    const expectedVersionFromTag = expectedTag.startsWith('v') ? expectedTag.slice(1) : expectedTag;
    add(
      lockstepVersion !== null && expectedVersionFromTag === lockstepVersion,
      `git tag "${expectedTag}" matches the lockstep package version "${lockstepVersion}" (expected tag "v${lockstepVersion}")`
    );
  }

  return { ok: findings.every((f) => f.ok), findings, lockstepVersion };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') out.tag = argv[++i];
  }
  return out;
}

// Only run as a CLI when executed directly (not when imported by tests).
if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const { tag } = parseArgs(process.argv.slice(2));
  // Falls back to a tag-shaped GITHUB_REF_NAME (e.g. "v0.1.0-beta.1") if
  // --tag was not passed explicitly and this is running in a tag-triggered
  // GitHub Actions job — inert/no-op locally, where that env var is unset.
  const inferredTag = tag ?? (process.env.GITHUB_REF_NAME && /^v\d/.test(process.env.GITHUB_REF_NAME) ? process.env.GITHUB_REF_NAME : undefined);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AgentGate — Release Version/Tag Consistency Check         ');
  console.log('═══════════════════════════════════════════════════════════\n');

  const { ok, findings, lockstepVersion } = checkReleaseConsistency({ expectedTag: inferredTag });
  for (const f of findings) {
    console.log(`${f.ok ? '✅ PASS' : '❌ FAIL'} — ${f.message}`);
  }
  console.log('');
  console.log(`Lockstep version: ${lockstepVersion ?? '(inconsistent — see failures above)'}`);
  if (ok) {
    console.log('🎉 ALL CHECKS PASSED.');
  } else {
    console.error('❌ One or more consistency checks failed — see FAIL lines above.');
  }
  process.exitCode = ok ? 0 : 1;
}
