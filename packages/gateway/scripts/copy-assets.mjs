// Copies non-TypeScript runtime assets that `tsc` does not touch into
// dist/, mirroring their src/ location exactly. Run as the second half of
// `pnpm run build` (see package.json). Currently just the smoke-test
// fixture server — see src/onboarding/smokeFixtureServer.mjs for why it is
// plain JS rather than compiled TypeScript.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  { from: 'src/onboarding/smokeFixtureServer.mjs', to: 'dist/onboarding/smokeFixtureServer.mjs' },
];

for (const asset of ASSETS) {
  const from = path.join(packageRoot, asset.from);
  const to = path.join(packageRoot, asset.to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`[copy-assets] ${asset.from} -> ${asset.to}`);
}
