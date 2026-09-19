---
description: Run Slipstream's existing full validation gate and report failures without repairing files.
disable-model-invocation: true
---

# Validate Slipstream

Validate the current checkout without changing source to make a check pass.
Read [CONTRIBUTING.md](../../CONTRIBUTING.md#bootstrap) and the
[validation runner](../../scripts/develop.mjs).

1. Confirm the Slipstream repository root, inspect `git status --short`, and
   preserve existing changes. Check the exact version in
   [.node-version](../../.node-version), Git, npm, and setup prerequisites.
   If dependencies or browser prerequisites are missing, report the blocker and
   recommend `/slipstream-setup` instead of silently installing them.
2. Run `npm run validate` from the repository root. Reuse the runner's build,
   types, tests, coverage, lint, formatting, documentation, browser, offline-proof,
   and packaging sequence; do not replace it with a smaller success-shaped check.
   The runner owns its per-command deadlines and cancellation behavior.
3. Stop on failure or cancellation. Identify the first failing command, relevant
   diagnostics, and checks that did not run. Do not retry to green, weaken
   assertions or thresholds, regenerate documentation, or edit source files.
4. Use only reports produced by this invocation. Do not treat old files under
   `test-results/` as evidence that an unexecuted check passed.
5. Summarize passed, failed, and unexecuted checks and report any unexpected
   source changes. A successful local run is not hosted CI success, independent
   review, or authorization to merge.

Keep [.claude/settings.json](../settings.json) restrictions in force. Do not read
environment files, stop the user's running dashboard, repair the original
offline-proof fixture, install the packaged extension, modify user stores,
change GitHub settings, commit, or push. Build and test outputs are expected;
publishing or applying repairs requires a separate request.
