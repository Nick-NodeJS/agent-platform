import { defineConfig } from 'vitest/config';
import { alias } from './vitest.shared.js';

// Needs `pnpm infra:up` (Temporal + Postgres). Creates and drops its own temporary database.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
