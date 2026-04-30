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
      pedantic: 'error',
      perf: 'error',
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
      reportUnusedDisableDirectives: 'error',
      typeAware: true,
      typeCheck: true,
    },
    plugins: ['typescript', 'import', 'node', 'vitest'],
    rules: {
      // Project-specific options for category-enabled rules.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // `import/no-cycle` currently reports 15 cycles across package barrels,
      // eval serialization, and Node SDK config/bootstrap modules. Keep it as
      // an audited follow-up rather than enabling a permanently failing rule.
      'new-cap': ['error', { capIsNew: false, newIsCap: true, properties: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'no-use-before-define': ['error', { classes: false, functions: false, variables: false }],
      'prefer-const': ['error', { destructuring: 'all' }],
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
      'use-isnan': ['error', { enforceForIndexOf: true, enforceForSwitchCase: true }],
      'valid-typeof': ['error', { requireStringLiterals: true }],

      // Selected high-signal rules from categories that remain too broad for
      // this package's public API style.
      curly: 'error',
      'default-case': 'error',
      'default-case-last': 'error',
      'default-param-last': 'error',
      'guard-for-in': 'error',
      'import/consistent-type-specifier-style': 'error',
      'import/first': 'error',
      'import/no-duplicates': 'error',
      'no-empty-function': 'error',
      'no-extra-label': 'error',
      'no-label-var': 'error',
      'no-labels': 'error',
      'no-lone-blocks': 'error',
      'no-multi-assign': 'error',
      'no-multi-str': 'error',
      'no-new-func': 'error',
      'no-return-assign': 'error',
      'no-script-url': 'error',
      'no-template-curly-in-string': 'error',
      'no-useless-computed-key': 'error',
      'no-void': 'error',
      'object-shorthand': 'error',
      'operator-assignment': 'error',
      'prefer-promise-reject-errors': 'error',
      'prefer-exponentiation-operator': 'error',
      'prefer-numeric-literals': 'error',
      'prefer-object-has-own': 'error',
      'prefer-object-spread': 'error',
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'typescript/array-type': 'error',
      'typescript/consistent-generic-constructors': 'error',
      'typescript/consistent-indexed-object-style': 'error',
      'typescript/consistent-type-assertions': 'error',
      'typescript/consistent-type-exports': 'error',
      'typescript/consistent-type-imports': 'error',
      'typescript/dot-notation': 'error',
      'typescript/explicit-module-boundary-types': 'error',
      'typescript/no-dynamic-delete': 'error',
      'typescript/no-empty-object-type': 'error',
      'typescript/no-explicit-any': 'error',
      'typescript/no-non-null-assertion': 'error',
      'typescript/no-require-imports': 'error',
      'typescript/prefer-function-type': 'error',
      'typescript/prefer-readonly': 'error',
      'typescript/prefer-return-this-type': 'error',
      'typescript/prefer-string-starts-ends-with': 'error',
      'typescript/promise-function-async': 'error',
      'typescript/unified-signatures': 'error',
      'no-useless-assignment': 'error',
      'typescript/no-unnecessary-condition': 'error',
      'typescript/prefer-optional-chain': 'error',

      // Policy exceptions and noisy rules that do not fit this package API.
      'import/max-dependencies': 'off',
      'jest/no-conditional-in-test': 'off',
      'max-classes-per-file': 'off',
      'max-depth': 'off',
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'no-else-return': 'off',
      'no-inline-comments': 'off',
      'no-negated-condition': 'off',
      'no-shadow': 'off',
      'no-unsafe-optional-chaining': 'off',
      'no-warning-comments': 'off',
      'require-await': 'off',
      'typescript/no-deprecated': 'off',
      'typescript/no-unsafe-type-assertion': 'off',
      'typescript/prefer-readonly-parameter-types': 'off',
      'typescript/require-array-sort-compare': 'off',
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
