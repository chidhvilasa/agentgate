## What changed and why

<!-- Describe the change and the motivation. Link any related issue. -->

## Security impact

<!--
Does this touch policy evaluation, secret detection/redaction, the audit hash chain, agent identity handling,
or the Control API's auth/CORS/Host checks? If yes, describe the impact and reference the relevant section of
docs/THREAT_MODEL.md. If none, say so explicitly — do not leave this blank.
-->

## Verification evidence

<!-- Paste the real output (or an accurate summary) of the commands you ran. Do not claim a check passed without running it. -->

```sh
pnpm run build
pnpm run lint
pnpm run test
node examples/secret-exfiltration/demo.mjs
git diff --check
```

## Decision ledger

- [ ] This change does not introduce a durable architectural decision, **or**
- [ ] I added a new ADR entry to `docs/AI_DECISIONS.md` (next unused sequential ID, superseded history preserved)

## Checklist

- [ ] Tests added/updated for the behavior change
- [ ] `pnpm run lint` passes with no new suppressions
- [ ] No real credentials, tokens, or unredacted audit data included in this PR
- [ ] Documentation updated if behavior, CLI, or policy fields changed
