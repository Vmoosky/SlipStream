import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: process.platform === 'win32' ? 'vmThreads' : 'forks',
    reporters: ['default', 'json'],
    outputFile: { json: '../../test-results/unit-hook-runtime.json' },
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'json', 'lcov'],
      reportsDirectory: '../../test-results/coverage/hook-runtime',
      thresholds: { statements: 46, branches: 51, functions: 48, lines: 45 },
    },
  },
});
