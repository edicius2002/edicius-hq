import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.venv/**',
      '**/venv/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'services/api/.local-data/**',
      '.local-data/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    /*
     * Type-aware, which `recommended` alone is not: without `projectService`
     * the rules that need a type checker are registered and can never fire.
     * `no-floating-promises` was one of them, which is why this codebase is
     * full of hand-written `void` prefixes that nothing was enforcing.
     */
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    /*
     * Tests build fakes, and a fake is allowed to be loose where the product
     * is not. `String(init?.body)` on a `BodyInit` and spreading a
     * `Float64Array` into an assertion are both fine in a stub and neither
     * tells us anything about the shipped code — which is the only place these
     * rules are worth their noise.
     */
    files: ['**/*.test.{ts,tsx}', 'apps/web/src/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  eslintConfigPrettier,
);
