import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/test-results/**',
      '.agents/skills/codeblend-ai-composite/**',
      '.outcome-proof-*/**',
      '.slipstream*/**',
      'tests/fixtures/outcome-workload/src/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,ts,mts}'],
    languageOptions: {
      parser: tseslint.parser,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-sparse-arrays': 'error',
      'no-unsafe-finally': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: [
      'scripts/check-*.mjs',
      'scripts/maintenance.mjs',
      'tests/check-docs.test.mjs',
      'tests/readiness.test.mjs',
      'eslint.config.mjs',
      'playwright.config.ts',
    ],
    rules: js.configs.recommended.rules,
  },
];
