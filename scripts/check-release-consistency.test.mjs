// Tests for the release version/tag consistency checker (Milestone 8 /
// ADR-0014, Phase 4/9). Runs against the REAL repository package.json
// files on disk — this script's entire job is to describe the actual
// current state of those files, so faking them would test nothing real.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseConsistency, PUBLISHABLE_PACKAGES, PRIVATE_PACKAGES } from './check-release-consistency.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readVersion(name) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', name, 'package.json'), 'utf-8'));
  return pkg.version;
}

describe('checkReleaseConsistency (ADR-0014)', () => {
  it('the real repository currently satisfies every consistency check', () => {
    const { ok, findings } = checkReleaseConsistency();
    const failed = findings.filter((f) => !f.ok);
    expect(failed).toEqual([]);
    expect(ok).toBe(true);
  });

  it('all three publishable packages actually share one identical version string on disk (not just asserted by the checker)', () => {
    const versions = PUBLISHABLE_PACKAGES.map(readVersion);
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('every private-by-design package (root, control-center) is still actually private:true on disk', () => {
    for (const { dir } of PRIVATE_PACKAGES) {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf-8'));
      expect(pkg.private).toBe(true);
    }
  });

  it('a tag matching "v<lockstep version>" passes the tag-consistency check', () => {
    const version = readVersion('gateway');
    const { ok, findings } = checkReleaseConsistency({ expectedTag: `v${version}` });
    expect(ok).toBe(true);
    const tagFinding = findings.find((f) => f.message.includes('git tag'));
    expect(tagFinding.ok).toBe(true);
  });

  it('a tag that does NOT match the lockstep version fails, with a clear, specific reason', () => {
    const { ok, findings } = checkReleaseConsistency({ expectedTag: 'v99.99.99' });
    expect(ok).toBe(false);
    const tagFinding = findings.find((f) => f.message.includes('git tag'));
    expect(tagFinding.ok).toBe(false);
    expect(tagFinding.message).toContain('v99.99.99');
  });

  it('a tag without a leading "v" is still compared correctly against the bare version', () => {
    const version = readVersion('policy');
    const { ok } = checkReleaseConsistency({ expectedTag: version }); // no "v" prefix
    expect(ok).toBe(true);
  });

  it('omitting expectedTag entirely skips the tag check without failing the rest', () => {
    const { ok, findings } = checkReleaseConsistency();
    expect(findings.some((f) => f.message.includes('git tag'))).toBe(false);
    expect(ok).toBe(true);
  });
});
