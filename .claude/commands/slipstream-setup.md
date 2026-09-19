---
description: Bootstrap Slipstream using its pinned Node version and existing setup runner.
disable-model-invocation: true
---

# Set up Slipstream

Prepare this checkout for local development. Read
[CONTRIBUTING.md](../../CONTRIBUTING.md#bootstrap) and the
[setup runner](../../scripts/develop.mjs) before executing commands.

1. Confirm the working directory is the Slipstream repository root and
   [package.json](../../package.json) identifies `slipstream-monorepo`.
   Inspect `git status --short`; preserve staged, unstaged, and untracked work.
2. Check Git, npm, and the exact Node version in
   [.node-version](../../.node-version). If a prerequisite is unavailable or
   mismatched, stop and report it. Do not change the Node pin or install global
   tooling to bypass the requirement.
3. Explain that setup reinstalls locked dependencies, builds the workspaces, and
   downloads Playwright Chromium. Run `npm run setup` from the repository root
   using the existing permission prompts. Do not install inside individual
   packages or the deliberately broken offline-proof fixture.
4. Stop on failure or cancellation. Report the failing step and a bounded,
   credential-free diagnostic; do not retry unchanged or claim setup succeeded.
   Missing Linux browser system libraries require a separately approved action;
   do not elevate privileges automatically.
5. Report the prerequisite versions, command outcome, and any source changes
   visible in Git. Recommend `/slipstream-validate` next; setup is not validation.

Keep [.claude/settings.json](../settings.json) restrictions in force. Do not read
environment files, change user stores, install the extension or plugin, activate
Git hooks, change GitHub settings, commit, or push as part of this command.
