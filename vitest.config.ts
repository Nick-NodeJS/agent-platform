import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@platform/contracts': src('contracts'),
      '@platform/agents': src('agents'),
      '@platform/integrations': src('integrations'),
      '@platform/persistence': src('persistence'),
    },
  },
  test: { include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'] },
});
