// AgentGate — single root ESLint configuration for the whole monorepo.
//
// One flat config covers packages/protocol, packages/policy,
// packages/gateway, apps/control-center, and the JS example scripts, so
// there is exactly one place to change lint rules. Run it with
// `pnpm run lint` from the repo root.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'graphify-out/**',
    ],
  },

  // ── Type-aware TypeScript linting for every workspace package ───────────
  // `project` (rather than `projectService`) is used explicitly because
  // the gateway/policy `tests/` directories live outside their package's
  // build `include`, and control-center splits app/node/test tsconfigs — an
  // explicit project list resolves every source file unambiguously.
  // control-center's tsconfig.test.json is intentionally separate from
  // tsconfig.app.json (rather than widening tsconfig.app.json's `include`):
  // importing `vitest` pulls in `@types/node`'s ambient globals, and once
  // pulled into the SAME TypeScript program as App.tsx, that silently
  // changed which global `setInterval` overload App.tsx resolved to (Node's
  // stricter one vs. DOM's loose `Function`-typed one), producing incorrect
  // `no-misused-promises` errors on unrelated, unchanged production code.
  // Test files (and only test files) are type-checked under their own
  // program instead — same pattern as gateway/policy's `tests/` +
  // `tsconfig.eslint.json`, and likewise never part of `tsc -b`'s build.
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './packages/protocol/tsconfig.json',
          './packages/policy/tsconfig.eslint.json',
          './packages/gateway/tsconfig.eslint.json',
          './apps/control-center/tsconfig.app.json',
          './apps/control-center/tsconfig.node.json',
          './apps/control-center/tsconfig.test.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Untrusted/agent-identity data flows through `unknown`/`any` at
      // protocol boundaries by design — keep that visible, not silenced.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Kept ON: these catch real correctness bugs (unhandled rejections,
      // async handlers passed where a sync return is expected) and are
      // cheap to satisfy.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // Turned OFF: the SQLite rows, JSON.parse'd audit payloads, and the
      // protocol package's zod-inferred types cross too many untyped
      // boundaries for the full "unsafe-*" family to be signal here — on
      // this codebase they fire near-uniformly on legitimate code (e.g.
      // JSX children of a `string` field flagged as "not stringifiable"),
      // not on the untrusted-input paths the project actually needs to
      // gate (those are enforced at runtime in packages/policy instead).
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Control Center runs in the browser.
    files: ['apps/control-center/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // ── Plain JS: example scripts and this config file itself ───────────────
  // None of these are part of a tsconfig `project`, so type-aware rules
  // (which need real type information) are turned off for them, per
  // typescript-eslint's documented mixed TS/JS pattern.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  }
);
