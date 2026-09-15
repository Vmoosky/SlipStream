# Contributing

## Bootstrap

Install Git and the exact Node version in [.node-version](.node-version), including
its bundled npm. Run these commands from the repository root on Windows or Linux:

```sh
npm run setup
npm run validate
```

The dependency-free [runner](scripts/develop.mjs) checks the Node pin, Git, and npm
before running any setup or validation commands. `setup` runs `npm ci`, builds the
workspaces in dependency order, and downloads Playwright Chromium. Repeating it
reinstalls locked dependencies; do not install separately inside a package.

On a minimal Linux host, Chromium also needs system libraries. After setup, install
them with the following command, which may require administrator privileges. The
runner does not elevate privileges automatically; CI provisions these libraries
explicitly with Playwright's `--with-deps` option.

```sh
npm exec -- playwright install-deps chromium
```

`validate` rebuilds before typechecking and running the script and workspace tests,
lint, formatting, documentation contracts, browser tests, the five-run offline
proof, and extension packaging. It writes the documentation, browser, and proof
reports under `test-results/`. It does not install the VSIX, register plugins, or
change user stores. Each command stops on failure or cancellation without retries
and has a ten-minute deadline (ten seconds for prerequisite checks).

The Linux and Windows browser-proof CI jobs run these same commands from a fresh
checkout and require both successful commands and valid report contents. Node 20
and 22 compatibility jobs retain the individual `npm ci`, `build`, `typecheck`,
`test`, `lint`, and `format:check` commands; only the developer runner enforces the
exact Node pin. On Windows the Vitest configs select `vmThreads`; do not pass that
flag through the mixed-runner root `npm test`. See the
[package map](docs/architecture.md).

`npm run test:e2e` runs the [browser E2E suite](e2e/dashboard.smoke.spec.ts) after
setup. `test:dashboard` remains a compatibility alias, including forwarded
Playwright arguments. Both browser-proof PR jobs run E2E once through `validate`;
`ci-required` rejects missing, failed, or skipped browser evidence.

In VS Code, open the Slipstream repository itself as a workspace folder; opening
only its parent folder does not load these repository-local configurations.
**Tasks: Run Task** offers `Slipstream: Setup`, `Slipstream: Build`,
`Slipstream: Validate`, and `Slipstream: E2E` from the
[task definitions](.vscode/tasks.json). Setup is explicit; no task runs on folder
open. **Tasks: Run Build Task** selects the root build, and **Tasks: Run Test Task**
selects full validation. After setup, the **Run Slipstream Extension** debug
configuration builds all workspaces before starting the Extension Development Host.

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

`check:docs` scans maintained `.md`, `.markdown`, and root `llms.txt` documents for
manifest reference drift, broken local links and anchors, invalid JSON/JSONC and
cost-policy examples, and missing npm scripts. Static `npm run`/`run-script`
examples start at the repository root and support explicit workspace names or
paths, `--prefix`, and simple relative `cd` commands. Arguments after `--` belong
to the script. No documentation commands are executed; dynamic or unsupported
examples appear in `manualExamples` and still require review.

Every PR runs repository-wide validation, including unchanged documents affected
by deleted files or changed manifests. CI uses all Git-tracked documents, without
directory exclusions, and binds the inventory and base-to-tested-revision changes
to the exact PR head/base, tested commit, workflow, run, and attempt. Both report
collection and `ci-required` independently recompute this Git evidence; missing
history, dirty tracked files, incomplete inventories, and mismatched reports fail.
Local checks also include new maintained documents but omit installed/generated
directories and do not claim CI provenance. After changing a documented manifest,
run `npm run docs:write`, review the generated sections, and rerun `check:docs`.
A second write must be a no-op. Narrative behavior, external links, and
live-provider outcomes remain outside these deterministic checks.

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

## Continuous Improvement

The [improvement workflow](.github/workflows/improvement.yml) is prepared but
disabled by default. After reviewing the change and verifying required checks,
the owner may enable `SLIPSTREAM_IMPROVEMENT_ENABLED=true`. It runs daily at
08:00 UTC or by manual dispatch on the default branch. Disable that variable to
pause it. This change does not activate the workflow or alter required gates.

The read-only collector compares the two newest completed default-branch push
runs for CI and Security, inspecting at most ten recent runs per workflow.
It fingerprints fixed gate and artifact failures as `new`, `recurring`, `cleared`,
or `unverified`. Recurrence is at the gate/artifact level, not proof of a common
root cause. A cleared finding requires valid success evidence on a different
revision; reruns, cancellation, missing history, expired artifacts, and invalid
provenance cannot clear a finding. PR and fork artifacts are not consumed.

Reports include source/run identities and downloaded artifact digests. Push base
revisions are report-declared; run, attempt, workflow, and head are checked against
GitHub API metadata. Only allowlisted JSON is read in memory with size and time
limits. No artifact is extracted or executed, and credentials are never sent to
the signed download host. The collector never retries jobs, edits source,
creates issues or PRs, commits, pushes, merges, or changes the runtime store.

To connect a recurring finding to a regression, propose a reviewed entry in the
[regression registry](.github/improvement-regressions.json). Entries must refer
to genuine history; do not invent failures or seed successful-looking proof.
Each entry has exactly these fields:

- `findingId`: the full fingerprint from a CI comparison report.
- `beforeRunId` and `afterRunId`: decimal strings identifying two distinct,
  first-attempt CI push runs on the default branch, in that order.
- `job`: an existing unit matrix ID, such as `linux-node24`.
- `suite`: an existing retained unit report, such as `unit-core.json`.
- `testName`: the exact Vitest `fullName`, unique within that suite.

The registry accepts at most four entries and no commands. The collector verifies
the same named test failed before and passed afterward, on different revisions,
with matching unit-summary provenance and test counts. An unrelated test, skipped
test, same-revision rerun, or successful aggregate alone cannot verify a repair.
The resulting regression proof still requires review; it does not establish
causality, an approval, or a merge. Keep the real review and merge links with the
ordinary change record. Review replacement or removal of stale registry entries
as source changes; expired evidence becomes insufficient, never implicitly valid.

### Historical Dashboard Regression

The first proposed registry entry links a genuine Linux Node 22 failure to the
same named test passing on a later revision. It remains pending owner review.

- Before: [CI run 34957634350](https://github.com/Vmoosky/SlipStream/actions/runs/34957634350),
    revision `01ca1caaef7c573f8b4a0c45b4f17a6ca848a720`, attempt 1, `main` push.
    The core report recorded 554 passed and one failed test.
- After: [CI run 34972436653](https://github.com/Vmoosky/SlipStream/actions/runs/34972436653),
    revision `32f906f9b9c5aa954a9a5e929af598aee0e9a42e`, attempt 1, `main` push.
    The core report recorded 556 passed and no failed tests.
- Named test: `dashboard end to end supports the exact clean-URL browser API contract`
    in `unit-core.json`, matrix job `linux-node22`.
- Repair: [32f906f](https://github.com/Vmoosky/SlipStream/commit/32f906f9b9c5aa954a9a5e929af598aee0e9a42e)
    added event IDs to disambiguate dashboard entries sharing a timestamp. The
    separate same-millisecond regression was added by that change, so it is not
    claimed as a test observed failing in the earlier run.

On 2026-09-15, the existing verifier accepted the named failing-then-passing test
after both CI aggregates and both unit archives were bound to GitHub run metadata
and their SHA-256 digests. This was a local read-only verification of GitHub
evidence, not an improvement-workflow run using the proposed entry. It proves one
historical regression pair, not repeated failure, causal attribution, automatic
repair, or a completed human-reviewed loop. GitHub returned no PR associated with
the repair commit; no historical PR approval or merge is claimed.

The earliest required artifact expires at **2026-09-22 10:24:12 UTC**. Review and
retire this entry before then if no longer needed. An expired or deleted artifact
must make the collector report insufficient evidence; an archived local copy or
an unrelated successful run must not substitute for live provenance.

### Repair Review And Rollback

Before publishing an entry, the owner reviews the source diff, exact named test,
run identities, artifact digests, and any remaining evidence limitations. Record
the actual review and manual merge links with the change; do not backfill an
approval for a historical direct push.

To undo this registry addition, remove only its entry in an ordinary reviewed
change. A product rollback requires a separate reviewed fix or narrowly scoped
revert of the event-selection changes on the current branch, preserving later
security fixes. Do not revert the entire historical commit, rewrite history, or
change the user's ledger. Validate the dashboard regression suites and full
required CI and Security gates before a manual merge. No rollback has been run.

`npm run improvement:report` is the authenticated workflow command. For local
comparison without GitHub access, use
`npm run improvement:report -- --input <bundle.json>`. A local bundle has
`schemaVersion: 1` and `before`/`after` snapshots, each with an `expected` CI
identity plus `kind` and `conclusion`, and the corresponding aggregate `report`.
Local output is explicitly `local-unverified`, not observed GitHub evidence.
The [readiness tests](tests/readiness.test.mjs) contain synthetic examples.

Each invocation writes a fresh `test-results/improvement/run-*` report and
summary. The workflow also posts counts to its job summary and retains those
files for seven days. Insufficient evidence produces a nonzero exit status while
retaining the report. The existing five-sample offline outcome proof remains
evidence about its synthetic workload, not proof that an arbitrary source fix
worked. Workflow presence or local fixtures do not establish an observed
continuous-improvement loop, agent throughput, or live-provider quality.

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