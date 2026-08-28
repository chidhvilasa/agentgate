// Secret / local-path scan for release artifacts (Milestone 8 / ADR-0014,
// Phase 7/9/12). Deterministic, dependency-free, offline — reuses the exact
// credential-pattern/allowlist convention already established in
// .github/workflows/security.yml's tracked-file secret scan, applied here
// to a DIFFERENT surface: the generated release-artifacts/ directory
// (tarballs' extracted contents, checksums.sha256, sbom.cyclonedx.json,
// release-manifest.json, licenses.json) — the exact bytes that would ship
// to a consumer or get attested, not the source tree.
//
// Usage: node scripts/scan-release-artifacts.mjs <dir>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_PATTERN = /AKIA[0-9A-Z]{16}|sk-ant-api[0-9A-Za-z_-]{20,}|sk-[a-zA-Z0-9]{32,}|gh[pousr]_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{60,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE|DSA) KEY-----/g;
// --force-local is GNU-tar-only and needed only on Windows (see the same
// note in verify-packed-install.mjs) — macOS's BSD tar rejects it outright.
const TAR_LOCAL_FLAGS = process.platform === 'win32' ? ['--force-local'] : [];
const ALLOWED_LITERALS = [
  'AKIAIOSFODNN7EXAMPLE',
  'AKIA1234567890ABCDEF',
  'sk-abc123xyz456abc123xyz456abc123xyz456abc',
  'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890',
  'sk-test1234567890abcdefghijklmnopqrstuvwxyz',
];

// Windows ("C:\Users\name\..." or "C:/Users/name/...") and Unix
// ("/home/name/..." or macOS "/Users/name/...") absolute local paths, and
// any OS temp-directory reference — none of these should ever appear in a
// generated release artifact.
const LOCAL_PATH_PATTERN = /[A-Za-z]:[\\/]Users[\\/][^\s"'\\/]+|\/home\/[^\s"'\\/]+|\/Users\/[^\s"'\\/]+/g;

function isAllowed(match) {
  return ALLOWED_LITERALS.includes(match);
}

function scanText(text, sourceLabel, findings) {
  for (const m of text.matchAll(CREDENTIAL_PATTERN)) {
    if (!isAllowed(m[0])) findings.push({ type: 'credential-shaped-string', source: sourceLabel, snippet: m[0].slice(0, 12) + '…' });
  }
  for (const m of text.matchAll(LOCAL_PATH_PATTERN)) {
    findings.push({ type: 'local-filesystem-path', source: sourceLabel, snippet: m[0] });
  }
  // The OS temp-dir prefix itself (covers non-Users-shaped temp roots, e.g. Linux /tmp/agentgate-*).
  const tmp = os.tmpdir();
  if (tmp.length > 3 && text.includes(tmp)) {
    findings.push({ type: 'temp-directory-reference', source: sourceLabel, snippet: tmp });
  }
}

function scanDirRecursive(dir, findings, relBase = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDirRecursive(full, findings, relBase);
      continue;
    }
    const rel = path.relative(relBase, full);
    if (entry.name.endsWith('.tgz')) {
      // Inspect the tarball's own text-ish content (package.json, etc.) via its file listing and, for
      // safety, its raw bytes too — a credential embedded as binary-adjacent text would still match.
      const listing = execFileSync('tar', [...TAR_LOCAL_FLAGS, '-tzf', full], { encoding: 'utf-8' });
      scanText(listing, `${rel} (entry listing)`, findings);
      const raw = fs.readFileSync(full, 'latin1'); // latin1 preserves byte values 1:1 for a substring/regex scan of a gzip binary
      scanText(raw, `${rel} (raw bytes)`, findings);
      continue;
    }
    // JSON/text artifacts (checksums.sha256, *.json).
    const text = fs.readFileSync(full, 'utf-8');
    scanText(text, rel, findings);
  }
}

export function scanReleaseArtifacts(dir) {
  const findings = [];
  if (fs.existsSync(dir)) {
    scanDirRecursive(dir, findings);
  }
  return { ok: findings.length === 0, findings };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const targetDir = process.argv[2];
  if (!targetDir) {
    console.error('Usage: node scripts/scan-release-artifacts.mjs <dir>');
    process.exitCode = 2;
  } else {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  AgentGate — Release Artifact Secret / Local-Path Scan     ');
    console.log('═══════════════════════════════════════════════════════════\n');
    const { ok, findings } = scanReleaseArtifacts(targetDir);
    if (ok) {
      console.log(`✅ PASS — no credential-shaped strings or local filesystem paths found under "${targetDir}".`);
    } else {
      console.error(`❌ FAIL — ${findings.length} finding(s):`);
      for (const f of findings) console.error(`  [${f.type}] ${f.source}: ${f.snippet}`);
    }
    process.exitCode = ok ? 0 : 1;
  }
}
