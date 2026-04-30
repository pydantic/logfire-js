import { defineConfig } from 'vite-plus'

const generatedFiles = ['**/dist/**', '**/.next/**', '**/next-env.d.ts', '**/worker-configuration.d.ts']

const generatedAndExternalFiles = ['node_modules/**', '.pnpm-store/**', 'pnpm-lock.yaml', '*.tgz', '**/.turbo/**', ...generatedFiles]

export default defineConfig({
  fmt: {
    ignorePatterns: ['CHANGELOG.md', '.changeset/*.md', ...generatedAndExternalFiles],
    overrides: [
      {
        files: ['examples/cf-worker/**', 'examples/cf-producer-worker/**', 'examples/cf-tail-worker/**'],
        options: {
          printWidth: 140,
          semi: true,
          singleQuote: true,
          useTabs: true,
        },
      },
    ],
    printWidth: 140,
    semi: false,
    singleQuote: true,
    sortPackageJson: false,
    trailingComma: 'es5',
  },
  lint: {
    categories: {
      correctness: 'error',
      suspicious: 'error',
    },
    env: {
      browser: true,
      builtin: true,
      es2024: true,
      node: true,
    },
    ignorePatterns: [
      'coverage/**',
      '.changeset/**',
      // The previous root lint only covered packages. Keep examples/scripts as
      // follow-up work because several are Next, Wrangler, or Deno projects
      // with their own runtime-specific globals and generated files.
      'examples/**',
      'scripts/**',
      ...generatedAndExternalFiles,
    ],
    options: {
      reportUnusedDisableDirectives: 'off',
      typeAware: true,
      typeCheck: true,
    },
    plugins: ['typescript', 'import', 'node'],
    rules: {
      'array-callback-return': 'error',
      'default-case-last': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'import/first': 'error',
      'import/no-duplicates': 'error',
      'new-cap': ['error', { capIsNew: false, newIsCap: true, properties: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-empty-function': 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-shadow': 'off',
      'no-throw-literal': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'no-unsafe-optional-chaining': 'off',
      'no-use-before-define': ['error', { classes: false, functions: false, variables: false }],
      'no-useless-return': 'error',
      'no-void': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'prefer-promise-reject-errors': 'error',
      'typescript/await-thenable': 'error',
      'typescript/consistent-return': 'off',
      'typescript/no-array-delete': 'error',
      'typescript/no-base-to-string': 'error',
      'typescript/no-confusing-void-expression': 'error',
      'typescript/no-deprecated': 'off',
      'typescript/no-duplicate-enum-values': 'error',
      'typescript/no-duplicate-type-constituents': 'error',
      'typescript/no-dynamic-delete': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-extra-non-null-assertion': 'error',
      'typescript/no-floating-promises': 'error',
      'typescript/no-for-in-array': 'error',
      'typescript/no-implied-eval': 'error',
      'typescript/no-misused-promises': 'error',
      'typescript/no-non-null-assertion': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/no-unnecessary-condition': 'error',
      'typescript/no-unnecessary-template-expression': 'error',
      'typescript/no-unnecessary-type-assertion': 'error',
      'typescript/no-unsafe-argument': 'error',
      'typescript/no-unsafe-assignment': 'error',
      'typescript/no-unsafe-call': 'error',
      'typescript/no-unsafe-member-access': 'error',
      'typescript/no-unsafe-return': 'error',
      'typescript/no-unsafe-type-assertion': 'off',
      'typescript/only-throw-error': 'error',
      'typescript/prefer-as-const': 'error',
      'typescript/prefer-promise-reject-errors': 'error',
      'typescript/require-array-sort-compare': 'off',
      'typescript/require-await': 'error',
      'typescript/restrict-plus-operands': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumberAndString: false,
          allowRegExp: false,
        },
      ],
      'typescript/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: false,
          allowRegExp: false,
        },
      ],
      'typescript/return-await': ['error', 'error-handling-correctness-only'],
      'typescript/unbound-method': 'error',
      'typescript/unified-signatures': 'error',
      'use-isnan': ['error', { enforceForIndexOf: true, enforceForSwitchCase: true }],
      'valid-typeof': ['error', { requireStringLiterals: true }],
    },
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
  },
  staged: {
    '*.{js,ts,tsx,mjs,mts,json,md,yaml,yml}': 'vp check --fix',
  },
})
