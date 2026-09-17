import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: realpathSync.native(fileURLToPath(new URL('.', import.meta.url))),
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: process.platform === 'win32' ? 'vmThreads' : 'forks',
    reporters: ['default', 'json'],
    outputFile: { json: '../../test-results/unit-mcp-server.json' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The server is spawned as a real subprocess; running suites in parallel
    // would contend on the shared storage directory.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'json', 'lcov'],
      reportsDirectory: '../../test-results/coverage/mcp-server',
      thresholds: { statements: 33, branches: 48, functions: 18, lines: 32 },
    },
  },
});
