import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The committed build output at the repository root is generated, not source.
    ignores: ['assets/**', 'sw.js', 'index.html', 'playwright-report/**', 'test-results/**'],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    // The simulation is the deterministic heart of the game: given a seed and a
    // command log it must always produce the same result. Anything that reads
    // ambient state would break replays, saves and the golden tests.
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'The simulation must stay deterministic — no wall-clock reads.' },
        { name: 'performance', message: 'The simulation must stay deterministic.' },
        { name: 'document', message: 'The simulation must not touch the DOM.' },
        { name: 'window', message: 'The simulation must not touch the DOM.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the seeded Rng from src/sim/core/rng.ts instead.',
        },
      ],
    },
  },

  {
    files: ['src/render/**/*.ts', 'src/ui/**/*.ts', 'src/platform/**/*.ts', 'src/game/**/*.ts', 'src/main.ts'],
    languageOptions: { globals: globals.browser },
  },

  {
    files: ['build/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },

  {
    // Plain JavaScript files sit outside the TypeScript project, so the
    // type-aware rules have nothing to work from.
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
