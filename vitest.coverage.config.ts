import { defineConfig } from 'vitest/config';
import { alias } from './vitest.shared.js';

// Unit tests plus in-process integration tests (live Temporal + Postgres, see pnpm infra:up).
export default defineConfig({
  resolve: { alias },
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/dist/**', '**/fixtures/**'],
      thresholds: { lines: 80, branches: 80 },
    },
  },
});
