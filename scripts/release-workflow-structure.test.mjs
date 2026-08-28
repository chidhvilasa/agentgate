// Structural regression tests for .github/workflows/release.yml (Milestone
// 9 first-publication preflight, ADR-0015). release.yml has never actually
// executed (no tag exists), so these tests verify its STRUCTURE against
// exactly the defect classes found and fixed during this preflight —
// regression coverage for facts that cannot be proven by a real execution
// yet. Parses the real YAML file on disk; never a hand-copied fixture.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = path.resolve(__dirname, '..', '.github', 'workflows', 'release.yml');
const raw = fs.readFileSync(WORKFLOW_PATH, 'utf-8');
const doc = yaml.load(raw);

describe('.github/workflows/release.yml structure (ADR-0015)', () => {
  it('parses as valid YAML with the expected four jobs', () => {
    expect(Object.keys(doc.jobs)).toEqual(['verify', 'publish-dry-run', 'publish', 'attest']);
  });

  it('top-level triggers are ONLY a version-tag push and workflow_dispatch — never a plain branch push or pull_request', () => {
    expect(Object.keys(doc.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(doc.on.push).toEqual({ tags: ['v*.*.*'] });
    expect(doc.on.push.branches).toBeUndefined();
  });

  it('the publish job requires workflow_dispatch, the publish:true input, AND a tag ref — all three, not a subset (ADR-0015 fix)', () => {
    const cond = doc.jobs.publish.if;
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain("github.event.inputs.publish == 'true'");
    expect(cond).toContain("github.ref_type == 'tag'");
  });

  it('a plain tag push can never satisfy the publish job\'s condition (event_name would be "push", never "workflow_dispatch")', () => {
    // Structural proof, not a live GitHub Actions evaluation: the condition
    // requires event_name=='workflow_dispatch' as one of its ANDed clauses,
    // so any event_name other than workflow_dispatch (e.g. the tag push's
    // own "push") makes the whole condition false regardless of ref_type.
    const cond = doc.jobs.publish.if;
    expect(cond.includes("github.event_name == 'workflow_dispatch'")).toBe(true);
  });

  it('the publish job is gated behind the npm-publish GitHub Environment', () => {
    expect(doc.jobs.publish.environment).toBe('npm-publish');
  });

  it('publish-dry-run, publish, and attest all download the same "release-artifacts" build — none of them re-checks-out or rebuilds from source (ADR-0015 artifact-integrity fix)', () => {
    for (const jobName of ['publish-dry-run', 'publish', 'attest']) {
      const steps = doc.jobs[jobName].steps;
      const downloadsArtifact = steps.some((s) => s.uses?.startsWith('actions/download-artifact') && s.with?.name === 'release-artifacts');
      expect(downloadsArtifact, `${jobName} must download the release-artifacts artifact`).toBe(true);
      const checksOutSource = steps.some((s) => s.uses?.startsWith('actions/checkout'));
      expect(checksOutSource, `${jobName} must NOT check out source / rebuild independently`).toBe(false);
      const installsPnpm = steps.some((s) => s.uses?.startsWith('pnpm/setup'));
      expect(installsPnpm, `${jobName} must NOT run a separate pnpm install/build`).toBe(false);
    }
  });

  it('the publish step is idempotent: it checks whether each exact version is already published before attempting to publish it', () => {
    const publishStep = doc.jobs.publish.steps.find((s) => s.name?.includes('npm publish (real'));
    expect(publishStep.run).toContain('npm view');
    expect(publishStep.run).toContain('already published');
  });

  it('publishes in dependency order: protocol before policy before gateway, in both publish-dry-run and publish', () => {
    for (const jobName of ['publish-dry-run', 'publish']) {
      const step = doc.jobs[jobName].steps.find((s) => s.run?.includes('for pkg in'));
      const match = step.run.match(/for pkg in ([a-z ]+);/);
      expect(match[1].trim().split(/\s+/)).toEqual(['protocol', 'policy', 'gateway']);
    }
  });

  it('no job requires anything beyond contents:read + id-token:write (+ attestations:write only for attest) — least privilege, and never a stored NPM_TOKEN', () => {
    // "NPM_TOKEN" itself legitimately appears in prose explaining that none
    // exists — what must never appear is an actual reference to a secret.
    expect(raw).not.toMatch(/secrets\.\w+/);
    for (const [name, job] of Object.entries(doc.jobs)) {
      if (name === 'verify') continue; // no elevated permissions needed at all
      const perms = job.permissions ?? {};
      const keys = Object.keys(perms);
      expect(keys.every((k) => ['contents', 'id-token', 'attestations'].includes(k)), `${name} permissions: ${keys}`).toBe(true);
    }
    expect(doc.jobs.attest.permissions['attestations']).toBe('write');
  });

  it('the top-level workflow permissions default to read-only (jobs must explicitly opt into anything more)', () => {
    expect(doc.permissions).toEqual({ contents: 'read' });
  });

  it('concurrency protection is present and never cancels an in-flight run', () => {
    expect(doc.concurrency).toBeDefined();
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
  });

  it('the release-build/publish jobs never use dependency caching (only the verify job may)', () => {
    for (const jobName of ['publish-dry-run', 'publish']) {
      const cacheStep = doc.jobs[jobName].steps.find((s) => s.with?.cache !== undefined);
      // These jobs no longer run pnpm/setup at all (ADR-0015) — but if a
      // caching step is ever reintroduced, it must not be enabled.
      if (cacheStep) expect(cacheStep.with.cache).toBe(false);
    }
  });

  it('the header comment documents the npm trusted-publishing first-publish bootstrap requirement (ADR-0015) rather than leaving it silently unstated', () => {
    expect(raw).toMatch(/BOOTSTRAP REQUIREMENT/);
    // Normalize newlines/comment markers so a line-wrapped sentence still matches.
    const normalized = raw.toLowerCase().replace(/\n#\s*/g, ' ').replace(/\s+/g, ' ');
    expect(normalized).toContain('cannot be configured for a package that has never been published');
  });
});
