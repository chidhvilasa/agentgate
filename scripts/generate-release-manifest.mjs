// Release manifest, checksums, SBOM, and license inventory generation
// (Milestone 8 / ADR-0014, Phase 7).
//
// Produces, from REAL build artifacts and the REAL resolved dependency
// graph (never fabricated data):
//   - release-manifest.json — commit, packages/versions, tarball filenames/
//     hashes/sizes, Node/npm/pnpm versions used to build, and workflow
//     identity (filled in from GitHub Actions env vars when running there;
//     null fields locally).
//   - checksums.sha256 — a plain `sha256sum`-compatible manifest.
//   - sbom.cyclonedx.json — a CycloneDX 1.5 SBOM built from the ACTUAL
//     resolved production dependency graph (`pnpm licenses list --json
//     --prod`), covering all three publishable packages together, scoped
//     to production dependencies only (dev/build tooling is not shipped).
//   - licenses.json — the same real license data, human-readable, with a
//     hard failure if any dependency's license is unknown or on the
//     copyleft denylist (GPL/AGPL/LGPL family) — this is a release gate,
//     not just a report.
//
// Every generated file is written with NO local filesystem paths, usernames,
// or temp-directory references — `pnpm licenses list`'s own output includes
// local `paths` entries, which are explicitly stripped before anything is
// written to disk.
//
// Requires the three tarballs to already exist (produced by
// `verify-packed-install.mjs` or an equivalent `pnpm pack` run) OR packs
// them itself into the given --pack-dir if missing. Requires network access
// for `pnpm licenses list` to read already-resolved lockfile metadata (no
// new installs are performed — the workspace's existing node_modules is
// read, not re-fetched).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PACKAGES = ['protocol', 'policy', 'gateway'];
const SHELL = process.platform === 'win32';

// SPDX identifiers this project accepts for a shipped production
// dependency. Anything else (including an empty/unknown license) fails the
// gate. Deliberately permissive-only: no copyleft (GPL/AGPL/LGPL/MPL family)
// is accepted for a dependency of a distributed CLI/library, to keep
// AgentGate's own Apache-2.0 distribution unencumbered.
const ALLOWED_LICENSE_PATTERN =
  /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|CC0-1\.0|Unlicense|Python-2\.0|WTFPL)$/;

function check(label, condition) {
  console.log(`${condition ? '✅ PASS' : '❌ FAIL'} — ${label}`);
  return Boolean(condition);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** True if every individual SPDX identifier inside a (possibly compound, e.g. "(MIT OR WTFPL)") license string is on the allowlist. */
function licenseIsAllowed(licenseStr) {
  if (!licenseStr || licenseStr === 'Unknown') return false;
  const ids = licenseStr.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/i).map((s) => s.trim());
  return ids.every((id) => ALLOWED_LICENSE_PATTERN.test(id));
}

function getPackedTarballs(packDir) {
  fs.mkdirSync(packDir, { recursive: true });
  const tarballs = [];
  for (const pkg of PACKAGES) {
    const out = execFileSync('pnpm', ['pack', '--pack-destination', packDir], {
      cwd: path.join(ROOT, 'packages', pkg),
      encoding: 'utf-8',
      shell: SHELL,
    });
    const tarballLine = out.trim().split('\n').pop();
    const tarballPath = tarballLine.startsWith(packDir) ? tarballLine : path.join(packDir, tarballLine);
    tarballs.push({ pkg: `@agentgate/${pkg}`, tarballPath });
  }
  return tarballs;
}

function getRealLicenseInventory() {
  const filters = PACKAGES.flatMap((p) => ['--filter', `@agentgate/${p}`]);
  const out = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod', ...filters], {
    cwd: ROOT,
    encoding: 'utf-8',
    shell: SHELL,
    maxBuffer: 1024 * 1024 * 20,
  });
  const raw = JSON.parse(out);
  // Strip every `paths` array (local absolute filesystem paths) — never
  // written to a generated artifact. Everything else is real, resolved
  // dependency metadata (name, versions, license, author, homepage).
  const components = [];
  for (const [license, entries] of Object.entries(raw)) {
    for (const entry of entries) {
      for (const version of entry.versions) {
        components.push({
          name: entry.name,
          version,
          license,
          author: typeof entry.author === 'string' ? entry.author : (entry.author?.name ?? null),
          homepage: entry.homepage ?? null,
        });
      }
    }
  }
  components.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
  return components;
}

function buildSbom(components, commit) {
  const now = new Date().toISOString();
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: now,
      component: {
        type: 'application',
        name: 'agentgate',
        group: 'agentgate',
        description: 'AgentGate — MCP security gateway (@agentgate/protocol, @agentgate/policy, @agentgate/gateway)',
      },
      properties: commit ? [{ name: 'agentgate:commit', value: commit }] : [],
    },
    components: components.map((c) => ({
      type: 'library',
      name: c.name,
      version: c.version,
      purl: `pkg:npm/${c.name.startsWith('@') ? c.name.replace('@', '%40') : c.name}@${c.version}`,
      licenses: [{ license: { id: /^[A-Za-z0-9.-]+$/.test(c.license) ? c.license : undefined, name: /^[A-Za-z0-9.-]+$/.test(c.license) ? undefined : c.license } }],
      author: c.author ?? undefined,
      externalReferences: c.homepage ? [{ type: 'website', url: c.homepage }] : undefined,
    })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outDirArg = args.includes('--out-dir') ? args[args.indexOf('--out-dir') + 1] : null;
  const outDir = outDirArg ? path.resolve(outDirArg) : path.join(ROOT, 'release-artifacts');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  AgentGate — Release Manifest / SBOM / Checksum Generation ');
  console.log('═══════════════════════════════════════════════════════════\n');

  const results = [];

  console.log('Step 1 — pack all publishable packages...');
  const tarballs = getPackedTarballs(outDir);
  for (const t of tarballs) results.push(check(`packed ${t.pkg}`, fs.existsSync(t.tarballPath)));

  console.log('\nStep 2 — checksums...');
  const checksumLines = [];
  const tarballEntries = [];
  for (const { pkg, tarballPath } of tarballs) {
    const hash = sha256File(tarballPath);
    const size = fs.statSync(tarballPath).size;
    const filename = path.basename(tarballPath);
    checksumLines.push(`${hash}  ${filename}`);
    tarballEntries.push({ package: pkg, filename, size_bytes: size, sha256: hash });
    console.log(`  sha256:${hash}  ${filename}  (${size} bytes)`);
  }
  fs.writeFileSync(path.join(outDir, 'checksums.sha256'), checksumLines.join('\n') + '\n');
  results.push(check('checksums.sha256 written', fs.existsSync(path.join(outDir, 'checksums.sha256'))));

  console.log('\nStep 3 — real production license inventory (pnpm licenses list --prod)...');
  const components = getRealLicenseInventory();
  const disallowed = components.filter((c) => !licenseIsAllowed(c.license));
  results.push(check(`all ${components.length} resolved production dependencies carry an allowed license`, disallowed.length === 0));
  if (disallowed.length > 0) {
    console.error('  Disallowed/unknown licenses found:');
    for (const d of disallowed) console.error(`    ${d.name}@${d.version} — "${d.license}"`);
  }
  const licensesOut = { generated_at: new Date().toISOString(), scope: 'production dependencies of @agentgate/protocol, @agentgate/policy, @agentgate/gateway', allowed_license_pattern: ALLOWED_LICENSE_PATTERN.source, dependency_count: components.length, dependencies: components };
  fs.writeFileSync(path.join(outDir, 'licenses.json'), JSON.stringify(licensesOut, null, 2) + '\n');
  results.push(check('licenses.json written', fs.existsSync(path.join(outDir, 'licenses.json'))));

  console.log('\nStep 4 — CycloneDX SBOM from the same real dependency data...');
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8', shell: SHELL }).trim();
  } catch {
    commit = null; // not fatal — e.g. running outside a git checkout
  }
  const sbom = buildSbom(components, commit);
  fs.writeFileSync(path.join(outDir, 'sbom.cyclonedx.json'), JSON.stringify(sbom, null, 2) + '\n');
  results.push(check(`sbom.cyclonedx.json written (${sbom.components.length} components)`, sbom.components.length === components.length));
  // No local paths/usernames in the SBOM — verified directly on the written bytes.
  const sbomText = fs.readFileSync(path.join(outDir, 'sbom.cyclonedx.json'), 'utf-8');
  results.push(check('sbom.cyclonedx.json contains no local filesystem path', !/[A-Za-z]:[\\/]Users[\\/]|\/home\//.test(sbomText)));

  console.log('\nStep 5 — machine-readable release manifest...');
  let nodeVersion, npmVersion, pnpmVersion;
  try { nodeVersion = process.version; } catch { nodeVersion = null; }
  try { npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf-8', shell: SHELL }).trim(); } catch { npmVersion = null; }
  try { pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf-8', shell: SHELL }).trim(); } catch { pnpmVersion = null; }

  const releaseManifest = {
    generated_at: new Date().toISOString(),
    commit,
    packages: tarballs.map(({ pkg }) => {
      const pkgDir = pkg.split('/')[1];
      const manifestPath = path.join(ROOT, 'packages', pkgDir, 'package.json');
      const version = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).version;
      return { name: pkg, version };
    }),
    tarballs: tarballEntries,
    sbom: { format: 'CycloneDX', specVersion: '1.5', filename: 'sbom.cyclonedx.json', componentCount: sbom.components.length },
    build_toolchain: { node: nodeVersion, npm: npmVersion, pnpm: pnpmVersion },
    // Populated only when actually running inside GitHub Actions — null locally, never fabricated.
    workflow: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null,
      run_id: process.env.GITHUB_RUN_ID ?? null,
      ref: process.env.GITHUB_REF ?? null,
      sha: process.env.GITHUB_SHA ?? null,
    },
    notes: [
      'These checksums/SBOM/license-inventory describe build and dependency-graph origin only — they are not a claim that the packaged code is free of vulnerabilities or malicious behavior.',
      'No npm publish, tag, or GitHub Release has been created from this manifest unless a separate, explicit, owner-approved release step says so.',
    ],
  };
  fs.writeFileSync(path.join(outDir, 'release-manifest.json'), JSON.stringify(releaseManifest, null, 2) + '\n');
  results.push(check('release-manifest.json written', fs.existsSync(path.join(outDir, 'release-manifest.json'))));
  const manifestText = fs.readFileSync(path.join(outDir, 'release-manifest.json'), 'utf-8');
  results.push(check('release-manifest.json contains no local filesystem path', !/[A-Za-z]:[\\/]Users[\\/]|\/home\//.test(manifestText)));

  console.log(`\nArtifacts written to: ${path.relative(ROOT, outDir) || '.'}`);
  console.log('  - checksums.sha256');
  console.log('  - licenses.json');
  console.log('  - sbom.cyclonedx.json');
  console.log('  - release-manifest.json');
  console.log('  - (tarballs) ' + tarballEntries.map((t) => t.filename).join(', '));

  const allPassed = results.every(Boolean);
  console.log('');
  if (allPassed) {
    console.log('🎉 ALL CHECKS PASSED.');
  } else {
    console.error('❌ One or more checks failed — see FAIL lines above.');
  }
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
