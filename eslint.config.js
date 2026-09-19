import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'data/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // stdout belongs to the MCP protocol: log through the Logger port (stderr)
      'no-console': 'error',
      // testability: time and randomness come from the injected Clock and Random
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use the injected Clock.' },
        { object: 'Math', property: 'random', message: 'Use the injected Random.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use the injected Clock.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: 'Use the injected Scheduler.' },
        { name: 'setInterval', message: 'Use the injected Scheduler.' },
        { name: 'setImmediate', message: 'Use the injected Scheduler.' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Mineflayer types and APIs must not leak past the adapter layer.
    files: ['src/**/*.ts'],
    ignores: ['src/bot/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(mineflayer|mineflayer-[^/]*|prismarine-[^/]*|minecraft-protocol)(/.*)?$',
              message: 'Only src/bot may import Mineflayer.',
            },
          ],
        },
      ],
    },
  },
  {
    // The only places allowed to touch the real clock, randomness, and stdio.
    files: ['src/infra/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    // Plain JS helpers (Jest global setup) are linted without type information.
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: 'readonly', globalThis: 'readonly' } },
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // Tests may use the real clock and randomness to assert the system sources.
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
    },
  },
  prettier,
)
