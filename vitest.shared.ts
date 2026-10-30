import { fileURLToPath } from 'node:url';

const src = (p: string, file = 'index.ts') =>
  fileURLToPath(new URL(`./packages/${p}/src/${file}`, import.meta.url));

export const alias = [
  { find: /^@platform\/contracts\/node$/, replacement: src('contracts', 'node.ts') },
  { find: /^@platform\/contracts$/, replacement: src('contracts') },
  { find: /^@platform\/agents$/, replacement: src('agents') },
  { find: /^@platform\/integrations$/, replacement: src('integrations') },
  { find: /^@platform\/persistence$/, replacement: src('persistence') },
];
