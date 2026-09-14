import { defineConfig } from 'vitest/config';

export default defineConfig({
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
  },
});
