// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        // `test/**` is intentionally NOT in tsconfig.json's `include`
        // (build excludes it, type-check does too — see tsconfig.build.json).
        // The TypeScript project service therefore can't resolve those
        // files. `allowDefaultProject` lets ESLint still lint them with
        // a synthetic project, which is the documented escape hatch.
        // The trade-off: type-aware rules on test files use the default
        // project's program, not a per-file one. Acceptable for a test
        // suite that already runs through ts-jest at full strictness.
        allowDefaultProject: true,
      },
    },
  },
  {
    rules: {
      // Convention: `_`-prefixed parameters are intentionally unused
      // (e.g. callback placeholders that need a name to satisfy a
      // structural type but the body doesn't need them).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Rationale for the `no-unsafe-*` family:
      // - `no-explicit-any` is already off. The four `no-unsafe-*` rules
      //   below are the noisy companions that complain whenever `any`
      //   leaks into a typed context. The test suite relies on
      //   `supertest` (returns `any`), `bcrypt` (native module, no
      //   usable types), and `fetch`-based SSE consumers — silencing
      //   these rules is the conventional compromise for test code.
      //   Production code (src/) should still hold the line via code
      //   review; we don't disable the rules on src/ specifically to
      //   keep the config readable.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
);
