# Release Runbook

Operator instructions for publishing AgentGate's npm packages, verifying a real release, and responding to a
partial or failed publish. This document describes a **process the owner performs**; nothing in this repository
executes any of it automatically. See [ADR-0014 and ADR-0015](AI_DECISIONS.md) for the design rationale, and the
Milestone 9 first-publication preflight report for the exact evidence behind every claim below.

**As of this document's last update, no AgentGate package has ever been published.** Everything below describes
what publishing will require, verified by direct inspection of this repository's release tooling and of current
official npm/GitHub documentation — not by an actual successful publish.

## 0. The critical fact that shapes everything below

**npm trusted publishing cannot be configured for a package that has never been published.** The trusted-publisher
configuration UI lives on a package's own settings page on npmjs.com, which does not exist until the package
exists. This means:

- The automated `.github/workflows/release.yml` workflow **cannot perform the first publish** of
  `@chidhvilasa/protocol`, `@chidhvilasa/policy`, or `@chidhvilasa/gateway` — all three are brand-new, never-published
  packages. Attempting it will fail with an authentication error (no trusted publisher recognizes the workflow
  yet, and this repository deliberately carries no long-lived `NPM_TOKEN` secret).
- **The owner must publish the first version of each package manually**, from an authenticated local terminal,
  before the automated workflow becomes usable at all — see Section 2.
- Once each package exists, the owner configures its trusted publisher (Section 3) and protects the release
  Environment (Section 4). From the SECOND release of each package onward, the automated workflow (Section 5) can
  be used.

## 1. Final pre-publish commit verification

Before publishing anything, from a clean checkout of the exact commit intended for release:

```sh
git fetch origin main
git log --oneline -1 origin/main   # confirm this is the commit you intend to release
pnpm install --frozen-lockfile
pnpm run build
pnpm run lint
pnpm run test
pnpm run test:release
node scripts/verify-packed-install.mjs
node scripts/check-release-consistency.mjs
node scripts/generate-release-manifest.mjs --out-dir release-artifacts
node scripts/scan-release-artifacts.mjs release-artifacts
git status --short   # must be empty except pre-existing local-only files (.claude/, CLAUDE.md)
```

All of the above must pass. Confirm the GitHub Actions CI and Security workflows are green for this exact commit
(`gh run list --commit <sha>`). `release-artifacts/checksums.sha256` now holds the exact SHA-256 of each tarball
you are about to publish — record these hashes; they are your independent evidence of what was actually released.

## 2. First publish of each package (manual, one-time per package)

Do this from your own machine, logged in as the npm identity `chidhvilasa`, which already owns the
`@chidhvilasa` user scope, with 2FA enabled on that
account (npm strongly recommends, and increasingly requires, 2FA for publish operations).

```sh
npm login                       # interactive; confirms/creates your session, prompts for 2FA if enabled
npm whoami                      # confirm the identity that will own the packages

cd release-artifacts             # the exact tarballs generated and hashed in Section 1
npm publish chidhvilasa-protocol-<version>.tgz --access public
npm publish chidhvilasa-policy-<version>.tgz   --access public
npm publish chidhvilasa-gateway-<version>.tgz  --access public
```

Publish in this exact order — `policy` and `gateway` depend on `protocol`. After each publish, verify:

```sh
npm view @chidhvilasa/protocol version   # should print the version you just published
```

**This is the only point in the entire process where a package's public identity is created.** ADR-0016 records
why the unavailable `@agentgate` organization scope was replaced before publication by the already-owned,
zero-cost `@chidhvilasa` user scope. Verify `npm whoami` prints `chidhvilasa`; an identity mismatch must stop the
release rather than trigger a blind retry.

## 3. Configure npm trusted publishing (per package, after Section 2)

For each of the three packages, on npmjs.com: open the package's page → **Settings** → **Trusted Publisher** →
**Add trusted publisher**, and enter exactly:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| GitHub organization or user | `chidhvilasa` |
| Repository | `agentgate` |
| Workflow filename | `release.yml` |
| Environment name | `npm-publish` (optional field — set it to match Section 4) |

Repeat for all three packages. This step cannot be automated by this repository; it is an npmjs.com account
action only the package owner can perform.

## 4. Create and protect the GitHub Environment

**Do this before ever running `workflow_dispatch` with `publish: true`.** As of the Milestone 9 preflight, this
repository has zero GitHub Environments — if the `publish` job's `environment: npm-publish` reference is ever hit
before the Environment exists, GitHub Actions is very likely to auto-create it with **no protection**, silently
skipping the intended human-approval gate.

In the GitHub repository → **Settings** → **Environments** → **New environment**, name it exactly `npm-publish`,
then:

- Add yourself (or the intended approver) under **Required reviewers**.
- Optionally add a **deployment branch/tag rule** restricting it to `v*` tags.
- No environment secrets are needed — OIDC trusted publishing requires no stored npm token.

## 5. Using the automated workflow (second release and later)

Once Sections 2-4 are done for a package, its future releases can go through `.github/workflows/release.yml`:

1. Bump all three package versions together (lockstep — ADR-0014) and land that on `main` through the normal
   commit process.
2. `git tag v<version> && git push origin v<version>` — this triggers `verify` and a `publish --dry-run` only.
   Watch it: `gh run watch --exit-status` (get the run id from `gh run list --commit <tag-commit-sha>`).
3. Once that run is green, trigger the real publish explicitly: `gh workflow run release.yml --ref v<version> -f publish=true`
   — **the `--ref` must be the tag**, not a branch; the `publish` job structurally refuses to run otherwise
   (`github.ref_type == 'tag'`, ADR-0015).
4. Approve the run in the `npm-publish` Environment when prompted (Section 4's required reviewers).
5. Watch the run to completion. The `publish` job publishes from the EXACT tarballs `verify` already built and
   checksummed — not a separate rebuild (ADR-0015) — so what gets published is exactly what was hashed.
6. The `attest` job runs only after a successful publish, attesting the same exact tarballs/checksums/SBOM/manifest.

## 6. Verifying a real release after publishing

- **Package + provenance**: `npm view @chidhvilasa/gateway` (or `protocol`/`policy`) shows the new version;
  `npm view @chidhvilasa/gateway --json | grep -i provenance` or the npmjs.com package page's "Provenance" badge
  confirms trusted-publishing provenance was attached automatically.
- **Installed CLI from the real registry**, in a throwaway directory with no relation to this repo:
  ```sh
  mkdir /tmp/agentgate-release-check && cd /tmp/agentgate-release-check
  npm init -y && npm install @chidhvilasa/gateway
  ./node_modules/.bin/agentgate --version
  ./node_modules/.bin/agentgate smoke-test
  ```
- **GitHub artifact attestations**:
  ```sh
  gh attestation verify release-artifacts/chidhvilasa-gateway-<version>.tgz -R chidhvilasa/agentgate
  ```
  This proves the tarball was built by this exact workflow run at this exact commit — **build/origin linkage,
  not a guarantee the code is free of vulnerabilities or malicious behavior**, and a genuinely different trust
  path from npm's own trusted-publishing provenance (which attests the published package via npm's own registry
  metadata) — check both, neither substitutes for the other.
- **Checksums**: compare `sha256sum` of a freshly-downloaded tarball (`npm pack @chidhvilasa/gateway@<version>`)
  against `release-artifacts/checksums.sha256` from Section 1.

## 7. If only one or two packages publish (partial release)

Because npm versions are immutable, a package that already published successfully at a given version can never be
"un-published" cleanly to retry the same version (`npm unpublish` is heavily restricted and generally the wrong
tool). The automated workflow's `publish` job (ADR-0015) already handles this safely: **rerunning the same
dispatch skips any package already published at that exact version and only attempts the remaining ones** — so
for a workflow-driven release, simply re-run `gh workflow run release.yml --ref v<version> -f publish=true` after
diagnosing and fixing whatever caused the failure (e.g. a transient registry error).

For the **manual first publish** (Section 2), if `protocol` succeeds but `policy` fails: fix the underlying
problem, then just re-run `npm publish chidhvilasa-policy-<version>.tgz --access public` — `protocol` does not need
to be touched again.

**Never** attempt to work around a partial failure by publishing a different package's tarball under a name it
doesn't belong to, by force-overwriting a published version, or by deleting/rewriting release evidence
(checksums, SBOM, the git tag, or this runbook) to make the partial state look cleaner than it was. If the
partial state needs to be visible to users (e.g. `protocol` is public but `gateway` is not yet installable),
say so plainly wherever the release is announced.

## 8. Corrective release vs. deprecation

- **A version that never fully published** (e.g. only `protocol` went out): finish publishing the remaining
  packages at the SAME version once the blocker is fixed — do not bump the version just because publication was
  interrupted; the already-published package(s) are correct and complete at that version.
- **A version that fully published but is later found to be broken**: publish a new corrective version
  (increment the beta counter, e.g. `0.1.0-beta.2`) — never attempt to overwrite or unpublish the broken version.
  Use `npm deprecate "@chidhvilasa/<pkg>@<broken-version>" "<clear reason and the fixed version to use instead>"`
  to mark it, which is reversible and non-destructive, unlike unpublishing.
- **A version that must never be installed at all** (e.g. it leaked a secret): deprecate it immediately with an
  explicit, non-vague reason, and treat `npm unpublish` (only possible within a short window and with
  restrictions) as a last resort, documented in the ledger with exactly why it was necessary.

## 9. Evidence discipline

Never delete `release-artifacts/checksums.sha256`, the SBOM, or the release manifest generated for a release that
actually shipped, even a partial one — they are the evidence trail. Do not fabricate or backdate any of them to
match a "clean" narrative after the fact. Record what actually happened — including a partial or failed
publish — truthfully in `docs/AI_DECISIONS.md` or wherever release history is tracked.
