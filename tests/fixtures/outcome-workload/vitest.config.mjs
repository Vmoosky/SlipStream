import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    pool: process.platform === 'win32' ? 'vmThreads' : 'forks',
  },
});
