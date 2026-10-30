import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const TYPED_FILES = ['**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'local-md-instructions/**',
      '.task-data/**',
      'coverage/**',
    ],
  },
  {
    // Suppression comments are not allowed: fix the code or change the rule here with a documented reason.
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  {
    files: TYPED_FILES,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: ['./tsconfig.check.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    rules: {
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'max-statements-per-line': ['error', { max: 1 }],
      'no-empty': 'error',
      'no-console': 'error',
    },
  },
  {
    // Console output is the interface of the CLI, scripts and test process protocols; services use pino.
    files: ['apps/cli/**', 'scripts/**', 'tests/**', '**/*.test.ts', '**/fixtures/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
