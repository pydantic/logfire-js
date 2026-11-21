// Use the supported command runner: Vite+ owns this repository's Vitest runtime.
export default {
  testRunner: 'command',
  commandRunner: {
    command:
      'pnpm --filter @pydantic/logfire-browser test --run src/interactionFrustration.test.ts src/interactionFrustration.model.test.ts',
  },
  coverageAnalysis: 'off',
  concurrency: 2,
  mutate: ['packages/logfire-browser/src/interactionFrustration.ts'],
  mutator: { excludedMutations: ['StringLiteral'] },
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/frustration-mutation.json' },
  tempDirName: '.stryker-tmp',
  // Exclude generated artifacts from mutation sandboxes.
  ignorePatterns: ['**/dist/**', 'test-results/**', 'reports/**', '.git/**'],
  timeoutMS: 10000,
  thresholds: { high: 100, low: 95, break: 95 },
}
