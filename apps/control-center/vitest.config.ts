import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Minimal component-testing harness (ADR-0009 Milestone 3) — kept as a
// separate config from vite.config.ts (the production build config) so the
// build pipeline never depends on test-only packages (jsdom, testing-library).
//
// jsdom is pinned to ^29.1.1, not latest (30.x), because jsdom@30 declares
// engines.node: "^22.22.2 || ^24.15.0 || >=26.0.0" — it does not support
// Node 20 at all. This project's minimum supported/CI-tested Node version is
// 20 (.nvmrc, every package.json's engines field), and jsdom@30's bundled
// undici throws `webidl.util.markAsUncloneable is not a function` there
// (confirmed failing in CI's ubuntu/node-20 job, passing on node-22/windows).
// jsdom@29.1.1 declares engines.node: "^20.19.0 || ^22.13.0 || >=24.0.0",
// which covers Node 20. Revisit this pin only alongside dropping Node 20
// support, not opportunistically.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
  },
});
