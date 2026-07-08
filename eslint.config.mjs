// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/*.config.*', 'docs/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Guardrail: apps must not call the network directly — go through core providers.
    files: ['apps/**/*.ts', 'apps/**/*.tsx'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'apps/* must not fetch directly — call a core service.' },
      ],
    },
  },
  {
    // The SPA (#16) is the documented fetch-based API consumer (AX-PRD §1) — only the backend apps
    // (api/worker) must route network through core. Lift the no-fetch guardrail for apps/web.
    files: ['apps/web/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-globals': 'off' },
  },
);
