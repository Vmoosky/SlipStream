import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'dashboard.smoke.spec.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  outputDir: 'test-results/browser/artifacts',
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/browser/report.json' }],
    ['html', { outputFolder: 'test-results/browser/html', open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
