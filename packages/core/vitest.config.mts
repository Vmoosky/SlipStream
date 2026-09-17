import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: process.platform === 'win32' ? 'vmThreads' : 'forks',
    reporters: ['default', 'json'],
    outputFile: { json: '../../test-results/unit-core.json' },
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'json', 'lcov'],
      reportsDirectory: '../../test-results/coverage/core',
      thresholds: { statements: 95, branches: 82, functions: 94, lines: 95 },
    },
  },
});
