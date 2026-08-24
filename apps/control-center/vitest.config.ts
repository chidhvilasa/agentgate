import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Minimal component-testing harness (ADR-0009 Milestone 3) — kept as a
// separate config from vite.config.ts (the production build config) so the
// build pipeline never depends on test-only packages (jsdom, testing-library).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
  },
});
