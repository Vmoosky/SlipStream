# Contributing

## Bootstrap

Run commands from the repository root. Use the Node version in
[.node-version](.node-version) for development; compatibility CI also covers the
Node 20 and 22 release lines. Install once at the root, not inside a package.

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm run format:check
npm run check:docs
```

The workspace order builds core before its consumers. On Windows the Vitest
configs select `vmThreads`; do not pass that flag through the root `npm test`,
which also runs Node's test runner. See the [package map](docs/architecture.md).

Install Chromium once with `npm exec -- playwright install chromium` (CI Linux
uses `--with-deps`), then run the remaining local gates:

```sh
npm run test:dashboard
npm run outcome-proof -- --runs 5
npm run package:extension
```

Browser tests start temporary loopback servers and cover desktop/mobile layouts.
They do not need a running dashboard or the user's savings store. The
[offline workload](tests/fixtures/outcome-workload) deliberately fails before the
proof applies its known fix in a scratch copy. Do not repair the original fixture
or run a separate install there. The policy arm is simulated, not live-provider
quality, billing, routing, or budget-enforcement evidence.

## Checks And Evidence

`lint` checks a small correctness baseline across maintained JS/TS and applies
the full recommended JS rules to new readiness tooling. Formatting currently
covers that tooling and workflows, not the entire historical source tree.
Expand these scopes deliberately; avoid unrelated formatting churn.

`check:docs` validates manifest reference blocks, local Markdown links, JSON/JSONC
examples, and cost-policy examples against the public validator. After changing a
documented manifest, run `npm run docs:write`, review the generated sections, and
rerun `check:docs`. A second write must be a no-op. Prose, external links, and
live-provider outcomes still need review.

CI retains allowlisted test reports and failure screenshots/traces for seven
days. Evidence includes the tested revision, PR head/base revisions, workflow,
run ID, and attempt. Failed, cancelled, skipped-required, missing, or mismatched
evidence must fail the final gate. Do not add `continue-on-error` or retry-to-green.
Rerun all jobs together when repeating CI so reports share the same attempt.
Fixtures must contain synthetic data, never credentials or personal ledgers.

## Publication And Activation

The workflow files prepare `ci-required` and `security-required`; their presence
does not activate branch protection. The reviewed source snapshot was published
as `4dd1559` on 2026-09-14. Future pushes, releases, and GitHub administration
require the owner's separate approval; publication does not prove CI success or
merge enforcement.

Before publication, review the exact candidate inventory, redacted secret scan,
large/binary files, dependency licenses, and VSIX contents. Manifests declare MIT,
but ownership and a root license text still require confirmation. Do not invent a
copyright holder or publish source, packages, or releases before that review.

The owner must observe real successful and failed PR checks, and then require
PRs with up-to-date `ci-required` and
`security-required` results on `main`. Disable force pushes, branch deletion,
and routine bypasses. Keep merges manual. CODEOWNERS routes review to Vmoosky;
solo-maintainer mode does not claim an independent approval.

Enable secret scanning/push protection and private vulnerability reporting where
available. CodeQL completion means analysis ran, not that all alerts are resolved;
configure and verify alert-blocking rules separately. Dependency review blocks
new moderate-or-higher advisories. Confirm fork PRs work without write secrets.
See [SECURITY.md](SECURITY.md) for the current reporting gap.

Maintenance activation, bot-created changes, and releases remain gated on
required checks actually being enforced. The
[readiness reassessment](docs/readiness-assessment.md) records the local progress,
verified snapshot, evaluator limitations, and outstanding activation steps.

## Bounded Maintenance

The [maintenance workflow](.github/workflows/maintenance.yml) is prepared but
disabled by default. Only after the owner verifies the protections above may
they set the repository variable `SLIPSTREAM_MAINTENANCE_ENABLED` to `true`.
Manual execution must target the default branch. The schedule is Monday at
07:00 UTC; a configured schedule or skipped job is not proof of an operational
run. Disable the variable to pause it again.

The workflow uses a read-only token, pinned actions and Node version, one
concurrent job, a 20-minute deadline, and no retries. It runs focused tests,
dependency audit, the existing five-sample offline proof, and
[deterministic documentation maintenance](scripts/maintenance.mjs). Independent
failures remain failures; a docs patch is uploaded only if every check and its
evidence pass. It never commits, pushes, creates PRs, merges, installs a VSIX,
or accesses the user's runtime store.

After the root install/build, a clean local checkout can produce docs-only
evidence with `npm run maintenance:docs -- --revision <full-commit-sha>`.
This does not run the workflow's independent audit or proof. The runner creates
a disposable checkout of that exact revision, performs one generation pass,
check-only validation, and one idempotence pass, then removes the scratch copy.
Each child command has a 60-second deadline. Dirty or mismatched source revisions
are rejected without altering uncommitted work. Cancellation terminates the
active child and cleans its scratch checkout before reporting failure. A hard
process/host termination cannot guarantee cleanup; missing evidence is not a
successful run, and GitHub-hosted runners discard that temporary filesystem.

Only existing generated blocks in [architecture](docs/architecture.md), the
[extension reference](packages/extension/README.md), and [MCP reference](docs/mcp.md)
may change. Authored prose, new/deleted files, symlinks, binary content, more than
200 added-plus-deleted lines, or more than 64 KiB of patch data block a proposal.
Reports and any validated patch go into a fresh `test-results/maintenance/run-*`
directory. A no-op is valid; blocked or failed generation publishes no patch.

GitHub retains only maintenance reports and the fully verified patch for seven
days. Reports bind the revision, event, workflow, run ID, and attempt to check
outcomes, report digests, and patch hashes. Keep attempts separate. Missing/expired artifacts,
cancelled runs, or absent review links mean unverified or insufficient evidence,
not success. Review the patch against its source revision, open an ordinary PR,
and record the run, PR, actual review, and merge links in the readiness assessment
when observed. Full required CI and a manual merge still apply. A local fixture
run does not establish scheduler operation, independent review, agent-authored
throughput, or live-provider outcomes.

The [Dependabot configuration](.github/dependabot.yml) also starts paused with
zero ordinary version-update PRs. After enforcement is verified, enable it in a
reviewed change by setting the npm limit to **2** and the Actions limit to **1**.
It covers the root workspace lockfile and pinned Actions weekly. Major upgrades
are held for separate manual PRs; preserve declared Node compatibility and action
SHA pins. These caps do not control separately enabled security-update PRs,
which can exceed ordinary version-update limits. Dependabot is maintenance
automation, not evidence of AI engineering throughput.