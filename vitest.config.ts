import { defineConfig } from 'vitest/config';
import { alias } from './vitest.shared.js';

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    testTimeout: 60000,
  },
});
