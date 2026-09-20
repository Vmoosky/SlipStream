# Browser End-To-End Agent Guide

This directory holds the Playwright dashboard smoke specification configured by
[playwright.config.ts](../playwright.config.ts): one Chromium worker, no
retries, and a 30-second timeout.

- Browser tests create their own temporary servers. Never point a test at, or
  reset, the user's running dashboard or ledger.
- Keep retries at zero and leave `forbidOnly` enforced in CI. A flaky pass is
  not browser evidence.
- Chromium comes from `npm run setup`. Do not download or install browsers from
  inside a specification.
- Artifacts belong under `test-results/browser`. Do not commit traces,
  screenshots, or generated reports.

Run focused checks from the repository root with:

```sh
npm run test:e2e
```
