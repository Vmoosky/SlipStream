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
coverage thresholds, lint, formatting, documentation contracts, browser tests, the five-run offline
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

The repository-local [VS Code MCP configuration](.vscode/mcp.json) starts the
standalone Slipstream server after setup, bounds its workspace root to the open
repository, and supplies no credentials. Run `npm run setup` before using it so
the referenced `packages/mcp-server/dist/index.js` bundle exists.

Shared agent controls are intentionally restrictive. Claude Code reads
[project settings](.claude/settings.json) that deny environment-file reads and
destructive or forced Git commands, while requiring confirmation for commits and
pushes. GitHub Copilot CLI reads the bounded
[session-start hook](.github/hooks/slipstream.json), which checks the Node pin,
locked manifest, and repository-scoped working directory without writing files or
logging hook input. These controls do not grant publication, merge, secret, or
user-store access, and they do not replace `npm run validate` or human review.

Browser tests start temporary loopback servers and cover desktop/mobile layouts.
They do not need a running dashboard or the user's savings store. The
[offline workload](tests/fixtures/outcome-workload) deliberately fails before the
proof applies its known fix in a scratch copy. Do not repair the original fixture
or run a separate install there. The policy arm is simulated, not live-provider
quality, billing, routing, or budget-enforcement evidence.

## Local MCP Environment

For standalone MCP development, [.env.example](.env.example) provides a
credential-free preset using the server's existing environment settings. After
setup, use this command in an MCP client with the repository root as its working
directory:

```sh
node --env-file=.env.example packages/mcp-server/dist/index.js
```

The preset stores development artifacts and history under the ignored
`.slipstream/dev` directory, bounds workspace roots to the current checkout, and
limits commands to `node`, `npm`, and `git`. The dashboard is off; adding
`--dashboard` enables it on a free loopback port instead of the normal dashboard
port. The server uses stdin/stdout for MCP, not an interactive terminal interface.

Loading is opt-in: setup, validation, extension, and plugin commands do not read
this file automatically. Node gives inherited environment variables precedence
over the file, so check inherited `SLIPSTREAM_HOME` and `SLIPSTREAM_WORKSPACE_ROOTS`
before relying on the preset's local paths. For personal settings, use an ignored
`.env.local` file and pass `--env-file=.env.local` instead. Keep credentials and
machine-specific paths out of the committed template.

## Development Container

With Docker running in Linux-container mode and the VS Code Dev Containers
extension installed, open the Slipstream repository folder and select
**Dev Containers: Reopen in Container**. The
[container configuration](.devcontainer/devcontainer.json) uses a
[Node image](.devcontainer/Dockerfile) pinned to [.node-version](.node-version).
It provisions Chromium's system libraries with the locked Playwright version at
image build time, then runs `npm run setup` as the non-root `node` user during
container creation. VS Code waits for setup to finish before attaching.

Root and workspace `node_modules` directories use separate, per-checkout Docker
volumes without copying host dependencies. A narrowly scoped, noninteractive sudo
command grants `node` ownership of only those volumes before setup. Source files
and build/test outputs remain shared with the host; use a separate checkout for
simultaneous host and container builds. No Docker socket or extra credential
directories are mounted, and Git hooks remain opt-in.

Run `npm run validate` in the container after setup. Reopening an existing container
does not reinstall dependencies automatically; rerun setup after lockfile changes.
When the Node pin or locked Playwright version changes, update the Dockerfile and
select **Dev Containers: Rebuild Container**. The readiness tests check these pins,
dependency mounts, and lifecycle commands for drift.

The shared [EditorConfig](.editorconfig) supplies UTF-8, LF, and two-space defaults
consistent with Prettier, preserving Markdown trailing-space line breaks. The
container includes EditorConfig, ESLint, and Prettier editor extensions and uses
the repository's TypeScript installation. It does not enable format-on-save.

## Pre-Commit Checks

After setup, opt in to the repository's Git hook explicitly:

```sh
npm run hooks:install
```

This command installs Husky's generated hook files under `.husky/_` and sets
repository-local `core.hooksPath` to `.husky/_`. Neither `npm ci` nor `setup`
activates hooks. Installation is repeatable and refuses to replace an existing
hook path or bypass existing default Git hooks. If you already use a hook manager,
integrate `npm run lint:staged` with it manually instead of replacing it. For linked
worktrees, opt in from the primary checkout first, then run setup and
`npm run hooks:install` in each worktree to generate its own ignored hook files.

The tracked [pre-commit hook](.husky/pre-commit) runs `lint:staged`, which invokes
`precommit` through lint-staged. This reuses the repository's `lint` and
`format:check` scopes in order, stopping on the first failure without fixing files.
Builds, typechecking, tests, and packaging stay in `validate` and required CI.
Git, including commits from an editor, must be able to find the pinned Node version
and its bundled npm on `PATH`.

Lint-staged temporarily hides unstaged changes to tracked files and restores them
after the checks, including on failure, using its normal backup stash. Partially
staged files are checked as staged; unstaged edits are not added to the commit.
Untracked files remain in place and may still be inspected by repository-wide lint.
The hook checks commits with staged additions, copies, modifications, or renames;
empty and deletion-only commits do not trigger lint-staged tasks. Hooks are a local,
bypassable guard, not a replacement for `npm run validate` or required CI gates.

## Test Coverage

Run the instrumented suites from the repository root:

```sh
npm run test:coverage
```

This rebuilds the workspaces, then runs the four Vitest suites with the matching
V8 coverage provider. Every `src/**/*.ts` file is included, even when no test
imports it. Each workspace writes its own `coverage-summary.json`,
`coverage-final.json`, LCOV/HTML reports, and `unit.json` under
`test-results/coverage/<workspace>/`. Ordinary `unit-*.json` reports are not
overwritten. Reports are generated evidence, not committed source.

Each Vitest configuration resolves its root through `fs.realpathSync.native`.
Keep this canonicalization: on Windows, different drive-letter casing can cause
V8 coverage to credit the wrong source locations even when test results match.
The readiness tests verify the actual configurations across drive-letter casings.

The fixed floors below apply to the complete source set within each workspace,
not just the files touched by a test. Threshold failures exit nonzero; thresholds
do not automatically decrease or update themselves. The floors are unchanged
after correcting the path-sensitive local coverage measurements.

| Workspace | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| core | 95% | 82% | 94% | 95% |
| hook-runtime | 46% | 51% | 48% | 45% |
| mcp-server | 33% | 48% | 18% | 32% |
| extension | 72% | 65% | 71% | 72% |

`npm run validate` includes the coverage gate. The Node 24 Linux and Windows unit
CI jobs also require it, retain the coverage files, and verify both test receipts
and consistent coverage counters before the aggregate can pass. Node 20/22
compatibility jobs retain their existing uninstrumented test commands.

These are **in-process source-coverage measurements**, not whole-product coverage
or proof of assertion quality. Child-process execution is not captured by this
provider, so the hook and MCP smoke tests exercise behavior that appears uncovered
here. Browser E2E, the Node-based script/plugin tests, bundled webview execution,
and the offline outcome proof remain separate required checks; their execution
must not be represented as covered source without instrumentation. Do not exclude
uncovered entry points or lower thresholds merely to make CI pass.

Use the JSON or HTML report to find meaningful untested branches, add focused
regressions, then rerun the complete workspace coverage suite. Run focused tests
without `--coverage` when only part of the suite is selected: full-source
thresholds intentionally reject partial-suite coverage. Changes to coverage
configuration, source scope, or floors need explicit review and new measured
evidence. No CodeBlend score increase is implied by these reports.

## Checks And Evidence

`lint` checks a small correctness baseline across maintained JS/TS and applies
the full recommended JS rules to new readiness tooling. Formatting currently
covers that tooling and workflows, not the entire historical source tree.
Expand these scopes deliberately; avoid unrelated formatting churn.

The [ESLint policy](eslint.config.mjs) also enforces these workspace dependency
directions in the existing required CI lint gate:

| Importing Workspace           | Allowed Workspace Dependencies       |
| ----------------------------- | ------------------------------------ |
| `core`                        | None                                 |
| `hook-runtime`, `mcp-server`  | `core`                               |
| `copilot-plugin`, `extension` | `core`, `hook-runtime`, `mcp-server` |

Cross-workspace imports must use the public package name, such as
`@slipstream/core`, not a package subpath or another workspace's source, build,
relative, or absolute path. Same-workspace internals remain available to local
source and tests. The explicit allowlist does not widen when a manifest changes;
new workspaces or dependency directions require a policy and regression review.

The rule covers static imports, re-exports, TypeScript type imports, and literal
`import()`/`require()` calls in workspace JS/TS, including CommonJS modules and
tests. Computed module names and bundler configuration require review. Existing
source bundle entries and aliases are unchanged; root integration scripts and
E2E fixtures may still exercise compiled workspace internals. Boundary regressions
run in `test:scripts` using the real ESLint configuration without executing imports.

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

## Readiness Reports

The review, observability, and authenticated improvement producers use the
[report writer](scripts/check-readiness-reports.mjs) to emit byte-identical,
normalized JSON at `reports/agent-review.json`, `reports/pr-observability.json`,
and `reports/improvement.json`. Separate `readiness-agent-review-RUN-ATTEMPT`,
`readiness-pr-observability-PR-RUN-ATTEMPT`, and `readiness-improvement-RUN-ATTEMPT`
artifacts request 90, 30, and 90 days of retention, respectively, subject to
repository policy. Uploads require an emitted report path, not a successful
decision; failure and unavailable states remain visible. Local improvement
`--input` comparisons are unverified and do not produce a readiness export.
Verification contracts and runtime safeguards are unchanged.
Raw sessions, credentials, runtime archives, and additional source text are not uploaded.

These files are transient evaluation inputs, not committed source or proof that
an operation succeeded. For a local evaluation, select explicit retained producer
runs and verify the repository, workflow, run, attempt, source revision, artifact
size and SHA-256 digest against GitHub metadata. Match the source snapshot to the
report's collector or review revision; the observed PR head and base remain separate
identities. Extract only the expected JSON into `reports/` in a disposable checkout,
preserving its bytes and original status. Do not copy reports into the primary
worktree, stage them, select them by file timestamp, or relabel historical reports
as current execution.

The installed extractor discovers actual, nonignored files in `reports/`, but not
an upload declaration alone, ignored files, or reports under `test-results/`.
Evaluate the prepared local checkout; a fresh URL-based checkout will not contain
downloaded runtime artifacts. Its static agentic-workflow detector still misses
the guarded Node review runner, including local composite-action and timeout-wrapper
forms. Report discovery does not change that flag, replace independent approval,
or establish a successful review, repair, or score increase. No review artifact
exists until an eligible real run produces one.

### Prepare Authenticated Assessment Evidence

Use the existing [report script](scripts/check-readiness-reports.mjs) to automate
the provenance checks and prepare a new detached checkout. Select a full commit
SHA already available locally and explicit producer run IDs and attempts. All
selected reports must bind their collector or review revision to that same SHA,
not the observed PR head. The repository must match `origin`, and the branch must
match GitHub's current default branch.

With `$revision` and `$runId` set to those reviewed values in PowerShell:

```powershell
node scripts/check-readiness-reports.mjs --prepare --repository Vmoosky/SlipStream --revision $revision --report "pr-observability:${runId}:1" --out test-results/readiness-review
```

Repeat `--report KIND:RUN_ID:ATTEMPT` for different kinds at the same revision.
Supported kinds are `pr-observability`, `bounded-agent-review`, and
`continuous-improvement-review`; `--branch` defaults to `main`. `--help` explains
the arguments without authentication or network access. Authentication uses an
existing `GITHUB_TOKEN`, `GH_TOKEN`, or the selected `gh` login, respecting
`GH_CONFIG_DIR`. Never put a credential in an argument or committed file.

The command makes only read-only GitHub requests. It verifies repository and
workflow identities, the completed run and exact attempt, artifact name, size,
SHA-256, retention age and expiry, bounded ZIP contents, and report provenance.
It rechecks run and artifact metadata after download. Expired, rerun, forked,
ambiguous, mismatched, and local-unverified evidence is rejected. Failure and
unavailable outcomes remain unchanged; authentication is not proof of success.

The output path must be new and under `test-results/`, with no linked ancestors.
Git hooks are disabled for checkout creation. Original report bytes are written
exclusively under the new checkout's `reports/` and must not be ignored by Git;
the provenance receipt is
`test-results/readiness-evidence.json` inside that checkout. The primary checkout,
existing reports, and credentials are not changed. No fetch, dependency install,
workflow dispatch, evaluation, model request, or publication is performed. A
nonzero exit or absent `prepared` receipt means preparation did not finish;
inspect any newly created checkout rather than treating partial output as ready.

Evaluate the reported checkout separately while the selected evidence remains
current. Keep the original statuses and receipt with the assessment. Discovery
of reports still does not repair the static guarded-review detector or establish
closed-loop operation.

The maintenance evidence bridge records a genuine empty proposal as
`not-applicable` with reason `no-proposal`. A nonempty proposal without review
requires a successful, source-matched maintenance summary explicitly recording
review disabled; old summaries without that policy evidence fail closed. Missing
an expected review remains a failure. Bridge verification and download failures
retain a sanitized failure report and a failing check, not a success claim.

## PR Observability

The [observability workflow](.github/workflows/pr-observability.yml) is opt-in via
`SLIPSTREAM_OBSERVABILITY_ENABLED=true`, after review and merge to the default
branch. It runs on default-branch PR lifecycle events, including head/body edits
and closure, and on completed `CI` or `Security` PR runs. A manual dispatch with a
PR number refreshes review and validation links without rerunning CI. Approval
and dismissal events alone do not refresh the snapshot; use the manual refresh
when an immediate review update is needed.
This change does not enable the variable or change required checks.

Completion observations require exactly one API-associated PR targeting the
default branch. The collector binds the workflow path and ID, run ID and current
attempt, terminal conclusion, source repository IDs, and exact head/base commits
to fresh GitHub API data. Fork PRs can supply a verified read-only run association;
their code is never checked out or executed by the observer. Missing associations,
stale heads or attempts, changed workflow identities, and unavailable evidence
cannot publish a completion observation. Push runs and unrelated workflows do
not qualify. The run and PR are checked again before metadata publication.

The JSON report and marked comment record the triggering workflow's actual
terminal outcome, including failure, cancellation, timeout, or skipped execution.
`verified-completion` verifies that individual run's identity and outcome, not
aggregate required-check success, agent authorship, or a verified repair. Reruns
are observations of their actual attempts, never regression or first-attempt
proof. A later PR/manual observation can replace the completion snapshot; the
30-day artifacts retain earlier observations. No workflow is retried or repaired
by this refresh.

The [collector](scripts/check-pr-observability.mjs) manages `area:core`,
`area:extension`, `area:mcp`, `area:hooks`, `area:plugin`, `area:tooling`, and
`area:docs` from a complete, bounded PR file inventory. These are area labels,
not claims of automation origin. Other labels and human comments are preserved.
Area rules come from the conventional [label configuration](.github/labeler.yml),
which is consumed by the collector rather than a second labeling workflow. Its
supported subset is one `changed-files` group per allowed area label, using
`any-glob-to-any-file` or `all-globs-to-any-file`. Dotfiles and previous paths of
renamed files are included; unsupported configuration fails closed. File rules
cannot grant `automation:maintenance`, which still requires the provenance below.

It maintains one marked GitHub Actions comment linking the exact PR head, current
PR checks, maintenance source and artifacts where verified, human review snapshot,
and observation run. JSON and Markdown observations are retained for 30 days,
subject to repository policy. They contain no PR body, review body, or source text.

When opening a PR from a verified maintenance proposal, add one body line using
the actual same-repository run and attempt URL:

```text
Maintenance-Run: https://github.com/OWNER/REPOSITORY/actions/runs/RUN_ID/attempts/1
```

Omit the line, or use `Maintenance-Run: none`, for ordinary changes. A link alone
does not earn `automation:maintenance`. The collector requires a successful
first-attempt scheduled/manual maintenance run on the default branch; API-bound
artifact identities, sizes and SHA-256 digests; matching report and validation
summary; and the exact permitted generated-document changes at the PR head.
The maintenance source must be an ancestor of the PR base, with unchanged base
document bytes. No-op proposals, fork-origin claims, extra edits, symlinks,
expired/missing artifacts, source reruns, and incomplete lists remain unverified.

Managed labels are reconciled at each observation, removing stale provenance.
Head, base, body and state are rechecked before PR writes. A race aborts the
update; subsequent PR events reconcile again. Labels describe the linked snapshot,
not a merge gate or a guarantee that nothing changed afterward. Reviews distinguish
current-head independent human approvals from stale, bot, self, dismissed, or
post-merge approvals; outstanding change requests remain visible. Neither a label
nor a report establishes agent authorship, successful current PR checks, or
permission to merge.

The privileged workflow checks out only its trusted default-branch SHA, never
the PR head or a downloaded patch. Locked dependency lifecycle scripts are
disabled. PR files are read as bounded Git blobs; archives are parsed in memory,
not extracted or executed. Only pull-request metadata writes are permitted; there
are no source pushes, merges, workflow retries, or new application permissions.
At most 99 changed files, reviews, labels, and comments and fewer than ten source
artifacts are accepted as complete. Over-limit or unavailable evidence is explicit
and cannot grant maintenance provenance. Required CI and Security gates remain
independent, and live operation must be observed after activation.

## Continuous Improvement

The [improvement workflow](.github/workflows/improvement.yml) is prepared but
disabled by default. After reviewing the change and verifying required checks,
the owner may enable `SLIPSTREAM_IMPROVEMENT_ENABLED=true`. It runs daily at
08:00 UTC, by manual dispatch on the default branch, and when CI or Security
completes a first-attempt default-branch push run, including unsuccessful runs.
Disable that variable to pause it. This change does not activate the workflow or
alter required gates.

For scheduled and manual reporting, the read-only collector compares the two
newest completed default-branch push runs for CI and Security, inspecting at most
ten recent runs per workflow. Completion reporting instead queries the exact
triggering run and verifies its ID, attempt, workflow ID and path, repository,
branch, event, conclusion, and revision against live GitHub metadata. It compares
only that pipeline with its newest older run in the bounded history window.
Newer runs cannot replace the trigger; absent older history is insufficient
evidence. Separate concurrency groups prevent distinct source-run completions
from replacing one another.

PRs, forks, non-default branches, and source reruns are excluded before checkout.
The collector runs from its own default-branch revision, never from the triggering
run's checkout or downloaded code. Collector and source revisions are recorded
separately. The job keeps read-only permissions and rejects collector reruns.

It fingerprints fixed gate and artifact failures as `new`, `recurring`, `cleared`,
or `unverified`. Recurrence is at the gate/artifact level, not proof of a common
root cause. A cleared finding requires valid success evidence on a different
revision; reruns, cancellation, missing history, expired artifacts, and invalid
provenance cannot clear a finding. PR and fork artifacts are not consumed. A
registered historical pair may instead use authenticated retained originals as
described below; unregistered comparisons still require live artifacts.

Reports include source/run identities and downloaded artifact digests. Push base
revisions are report-declared; run, attempt, workflow, and head are checked against
GitHub API metadata. Only allowlisted JSON is read in memory with size and time
limits. No artifact is extracted or executed, and credentials are never sent to
the signed download host. The collector never retries jobs, edits source,
creates issues or PRs, commits, pushes, merges, or changes the runtime store.

To connect a recurring finding to a regression, propose a reviewed entry in the
[regression registry](.github/improvement-regressions.json). Entries must refer
to genuine history; do not invent failures or seed successful-looking proof.
Each entry requires these fields:

- `findingId`: the full fingerprint from a CI comparison report.
- `beforeRunId` and `afterRunId`: decimal strings identifying two distinct,
  first-attempt CI push runs on the default branch, in that order.
- `job`: an existing unit matrix ID, such as `linux-node24`.
- `suite`: an existing retained unit report, such as `unit-core.json`.
- `testName`: the exact Vitest `fullName`, unique within that suite.

An optional `repair` object has exactly `fixCommit` (a full commit SHA) and
`pullRequest` (a positive integer). It must name a real repair, not the later PR
that merely registers its evidence. Read-only GitHub queries check that the fix
belongs to that same-repository PR, its merge commit is the passing run's
revision, and the failing revision is an ancestor of the merge. A non-author
human owner, member, or collaborator must approve the final PR head before merge,
with no unresolved request for changes. Stale, dismissed, bot, self, or post-merge
approval does not qualify. Lists with 100 or more commits or reviews are
conservatively incomplete. Later successful revisions do not substitute for
GitHub's exact PR merge SHA.

`repairHistoryStatus` is separate from the named regression result. An omitted
reference is explicitly `insufficient-evidence`, even if regression collection
succeeds. A configured but invalid repair reference also fails the report.
Verified history supplies canonical PR and review links plus fix and merge
identities. It does not establish causality, agent authorship, automatic repair,
or remove the need to review the evidence. No historical approval is inferred
for direct pushes.

The registry accepts at most four regression entries and no commands. The collector verifies
the same named test failed before and passed afterward, on different revisions,
with matching unit-summary provenance and test counts. An unrelated test, skipped
test, same-revision rerun, or successful aggregate alone cannot verify a repair.
The named regression proof still requires review; review and merge history are
verified separately through the optional reference. Review replacement or removal
of stale entries as source changes. Insufficient evidence is never implicitly valid.

### Governed Learned Rules

The same registry optionally accepts `learnedRules`; omission means no rules and
no extra evidence requests. Do not seed synthetic findings or approval records.
The [governance decision](docs/adr/0001-governed-improvement-loops.md) defines the
contract and proof boundaries implemented by the
[shared validator](scripts/check-improvement-rules.mjs).

Each version contains `id`, positive integer `version`, `status` (`proposed`,
`active`, or `retired`), `files`, `criterion`, `source`, `preventionTest`, and
`reason`. IDs are lowercase alphanumeric/hyphen, at most 80 characters. Scope is
a nonempty exact subset of the three generated-document contracts. Criteria are
nonblank, at most 1,000 UTF-8 bytes, and contain no control characters. The source
has exactly `kind` (`ci-regression` or `agent-review`) and its real `findingId`.
`preventionTest` has a repository-relative test `file` and literal test `name`;
these are metadata, never commands or execution proof. Reasons are nonblank and
at most 2,000 UTF-8 bytes. The registry is capped at 64 KiB, 16 versions, and four
active rules, with one active version per ID. Extra fields and linked paths fail
closed; rules cannot grant tools, change models, or expand budgets or schedules.

Introduce a genuine lesson as `proposed`, then activate it in an ordinary reviewed
PR. The immutable payload is ID, version, files, criterion, source, and prevention
test. Changing any payload field requires a new version; keep old versions and
retire them with a reason. A retired version cannot be reactivated. The readiness
suite checks the contract and transition behavior offline; promotion verification
also compares the actual base and final-head registry blobs.

After the activation PR merges and exact merge CI passes, record its optional
`promotion` in a later ordinary reviewed change: `pullRequest` (positive integer),
`fixCommit` (full final PR-head SHA), and `afterRunId` (positive decimal CI run ID
string). The activation commit does not need to name its own SHA or future run.
Verification requires the proposed-to-active transition, independent non-author
human approval of the final head before merge, no outstanding changes request,
and successful first-attempt default-branch CI at that exact merge. The same
individual payload must be active in the head and merge; unrelated registry
entries and later bookkeeping do not invalidate its digest.

The improvement report separates source verification, source repair review,
named regression proof, promotion, and configured state. Active without verified
promotion is `configured-only`. Missing promotion references are explicit;
requested but unresolved source or promotion evidence fails the evidence gate.
An agent-review source is not a named red/green regression. A referenced test,
green aggregate, or reviewed promotion does not establish semantic resolution.

On an eligible later review, only active rules intersecting the proposal enter
the existing bounded input. Its digest binds their canonical payloads; optional
report metadata records the registry byte hash, ruleset hash, and supplied
ID/version/payload hashes. This proves criteria were supplied, not followed.
No applicable rules preserves legacy input bytes and finding/disposition
contracts. No-op runs remain no-ops. Pause live review with its existing opt-in
variable; roll back a criterion through a reviewed retirement or new version,
not by editing historical evidence. The collector never writes rule state.

Run the focused offline checks from the repository root:

```sh
node --test --test-name-pattern='^(improvement|bounded agent review|readiness reports)' tests/readiness.test.mjs
npm run check:docs
```

Synthetic tests do not complete a real learning cycle or change a readiness
score. Independent review, genuine source evidence, later observed reuse, and
any new assessment remain separate operational steps.

### Retained Repair Evidence

The workflow requests 90-day retention for its compact report and a separate
`evidence.json` artifact, subject to repository policy. The latter contains
bounded base64 copies of the original CI ZIPs for verified registered pairs,
their original SHA-256 digests, minimal source-run metadata, capture timestamps,
and the collector identity. At most 16 original archives totaling 4 MiB are
retained. Over-limit evidence is reported as incomplete; the collector never
truncates a proof or silently claims it was preserved. The existing CI report
allowlist and synthetic-data restrictions still apply. Retained ZIPs may contain
only the aggregate/containment JSON or the unit-summary and unit-report JSON;
unexpected filenames and malformed JSON are rejected. An over-limit collection
does not export a partial evidence bundle.

Compact `maintenance-evidence`, `readiness-agent-review`, and `ci-required`
uploads also request 90 days. Proposal and bulk unit/browser artifacts stay at
seven days, so registered named-test originals still need capture before expiry.
This does not recover expired review artifacts or add them to regression bundles.
Actual retention must be checked at rollout; after expiry, promotion and repair
proof may become unavailable rather than remain permanently verified.

After source artifacts expire or disappear, the collector inspects at most ten
recent improvement runs. Recovery requires a successful first-attempt schedule,
manual, or trusted CI-completion run on the same repository's default branch, a
live retained artifact, and its API-provided SHA-256 digest. A completion producer
must also record a valid source-trigger identity. Collector reruns are rejected
at entry.
It verifies the producer, collector identity,
original ZIP hashes and source-run identities against current API metadata. If
original artifact metadata remains available, its identity and digest must still
agree. Named-test and unit/aggregate checks run again on the original JSON;
archived success booleans alone never count. Repair, review, and merge metadata
are queried live on every collection, not copied as approvals.

Recovered copies preserve their live capture time and become ineligible after
90 days; copying them does not renew that deadline. This is bounded retention,
not permanent storage. Missing producer runs, deleted retained artifacts, reruns,
changed digests, and the bounded history window can make evidence insufficient
sooner. A local file cannot seed authenticated recovery. Only a successful
workflow run establishes retained provenance; local tests and generated bundles
are not observed GitHub retention.

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

The earliest source artifact expires at **2026-09-22 10:24:12 UTC**. A successful
run of the reviewed retention workflow must capture it before expiry to preserve
this pair beyond that date; this implementation alone does not do so. Otherwise
review and retire the entry when no longer needed. A local copy or an unrelated
successful run must not substitute for authenticated provenance. This entry still
has no historical PR approval or merge evidence.

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
summary. Authenticated invocations also write the separate original-evidence
bundle. The workflow posts counts and missing repair evidence to its job summary
and requests 90-day retention. Completion summaries also link the triggering run
and show its attempt, revision, conclusion, API-identity verification, and separate
collector revision. Job outputs expose `status`, `report-path`, `evidence-path`,
`trigger-workflow`, `trigger-run-id`, `trigger-attempt`, `trigger-revision`,
`trigger-conclusion`, and `trigger-verified`; trigger outputs are empty for daily
and manual invocations. `reported` means the comparison has sufficient evidence,
not that CI succeeded or a repair was verified. Insufficient evidence produces a
nonzero exit while retaining the report and its missing-evidence details.

The existing five-sample offline outcome proof remains
evidence about its synthetic workload, not proof that an arbitrary source fix
worked. Workflow presence or local fixtures do not establish an observed
continuous-improvement loop, agent throughput, or live-provider quality.

## Documentation Remediation

The [documentation remediation workflow](.github/workflows/docs-remediation.yml)
is disabled by default. After reviewing the implementation and required checks,
the owner may enable `SLIPSTREAM_DOCS_REMEDIATION_ENABLED=true`. Setting it to
`false` pauses future proposals. This change does not activate the workflow.

It responds only to a failed, first-attempt CI push run on the default branch
whose revision is also the trusted workflow checkout. PRs, forks, other branches,
successful or cancelled runs, and source or remediation reruns are excluded.
Read-only GitHub API checks bind the workflow ID and path, run ID and attempt,
repository IDs, event, conclusion, source SHA, and current default-branch head.
Those checks run before generation and again before retaining a patch. Moved
branches, changed attempts, and unavailable evidence withhold the proposal.

The trusted checkout installs locked dependencies with lifecycle scripts disabled,
builds core, and runs the remediation regression tests. Its existing documentation
generator then performs check-only diagnosis in a disposable exact-revision
checkout. Only the three existing generated reference blocks are repairable,
with the same 200-changed-line and 64-KiB patch limits as bounded maintenance.
Repository-wide documentation validation, check-only immutability, idempotence,
scope checks, source preservation, and scratch cleanup must all succeed.
Original before/after reports, their SHA-256 hashes, and the proposal digest are
retained with the source identity for seven days, subject to repository policy.
The API credential is not passed to generator or Git subprocesses.

If documentation already passes, the result is `not-applicable` and no patch is
produced. An unrepaired documentation error blocks the proposal. Even a validated
patch proves only the local documentation postcondition: the cause and resolution
of the triggering CI failure remain unverified. The workflow never retries CI,
invokes a model, edits the source checkout, opens a PR, commits, pushes, or merges.
It cannot grant scheduled-maintenance provenance or agent authorship.

Review the original evidence and exact patch before applying it on a separate
human-created branch. A resulting PR still requires full local validation,
successful required CI and Security gates, and independent human review before
manual merge. Discard an unused patch to cancel it; if a merged proposal needs
reversal, use the existing [reviewed rollback procedure](#repair-review-and-rollback).
No real CI failure, reviewed merge, or rollback is claimed by local fixture tests.

## Bounded Maintenance

The [maintenance workflow](.github/workflows/maintenance.yml) is prepared but
disabled by default. Only after the owner verifies the protections above may
they set the repository variable `SLIPSTREAM_MAINTENANCE_ENABLED` to `true`.
Manual execution must target the default branch. The schedule is Monday at
07:00 UTC; a configured schedule or skipped job is not proof of an operational
run. Disable the variable to pause it again.

The workflow uses a read-only token, pinned actions and Node version, one
concurrent job, a 30-minute deadline, and no wrapper retries. It runs focused tests,
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

Maintenance uploads request 90 days for compact reports and seven days for the
fully verified patch, subject to repository policy. Reports bind the revision,
event, workflow, run ID, and attempt to check
outcomes, report digests, and patch hashes. Keep attempts separate. Missing/expired artifacts,
cancelled runs, or absent review links mean unverified or insufficient evidence,
not success. Review the patch against its source revision, open an ordinary PR,
and record the run, PR, actual review, and merge links in the readiness assessment
when observed. Full required CI and a manual merge still apply. A local fixture
run does not establish scheduler operation, independent review, agent-authored
throughput, or live-provider outcomes.

### Advisory Agent Review

The [bounded review runner](scripts/check-agent-review.mjs) is a separate,
default-off extension of the same workflow. It reviews only a nonempty,
independently verified generated-document proposal on the first attempt of the
Monday schedule. Manual dispatch, reruns, no-ops, failed checks, and disabled
review do not start a model session. It never generates or executes a patch.

Activation requires the owner's separate authorization and configuration:

- Set `SLIPSTREAM_AGENT_REVIEW_MODEL` to a named model available to the dedicated
  account. When the account only supports Copilot's automatic model selection,
  set it to `auto` and separately set
  `SLIPSTREAM_AGENT_REVIEW_AUTO_CONFIRMED=true`. Automatic selection is an
  explicit owner choice, not a fallback: each report records both the requested
  selector and the single resolved model from the bounded CLI usage file.
- Configure the `SLIPSTREAM_AGENT_REVIEW_TOKEN` repository secret with a dedicated
  fine-grained PAT carrying **Copilot Requests** permission and no repository
  write permissions. Do not reuse the workflow token or an administrative login.
  This follows GitHub's [supported CLI authentication](https://docs.github.com/en/copilot/reference/cli-command-reference).
- Verify provider-side overage blocking for that account, then set
  `SLIPSTREAM_AGENT_REVIEW_NO_OVERAGE_CONFIRMED=true`. This is an owner attestation,
  not automatic verification of billing settings. Included allowance must be
  available; otherwise leave review disabled.
- Set `SLIPSTREAM_AGENT_REVIEW_ENABLED=true` only after those prerequisites and
  the existing maintenance protections are satisfied. Set it to `false` to pause.

The automatic PR Agent Review uses the same dedicated secret only for its bounded
model step. Diff preparation and finding publication use the workflow token and
do not receive the Copilot credential.

The runtime is the SHA-512-pinned Linux x64 Copilot CLI package `1.0.86`.
Download and integrity checks precede the credential-bearing step; extraction
uses a verified private copy and a credential-free child environment. No package
installation hooks or automatic updates run. The review process receives only
the dedicated token and fresh temporary configuration, home, and working
directories. Tools, built-in MCP servers, repository instructions, automatic
login, and continuation modes are not enabled. A nonempty sentinel tool allowlist
is intentional: this CLI treats an empty list as no filter.

The budget is one review invocation per eligible weekly run, zero wrapper
retries, a five-minute review deadline, and a **soft 30-AI-credit CLI limit**.
Thirty is the CLI minimum, not a hard charge cap: a response can exceed it, and
internal requests, retries, or compaction may consume additional credits.
Provider-side overage blocking is the spending boundary. Download and extraction
each have a one-minute deadline; the review workflow step allows seven minutes
for extraction, review, validation, and cleanup. The submitted prompt is capped
at 96 KiB, combined stdout/stderr at 64 KiB, and the usage file at 64 KiB. These
are local byte limits, not limits on the CLI's internal context or billed tokens.

Missing or malformed usage, a different observed model, invalid responses,
cancellation, and process failures fail closed without retry. Reports bind the
source, run, attempt, evidence, patch, input, response, and usage digests, retain
unknown provider request/retry counts and dollar charges as `null`, and mark
human approval as required. Findings remain untrusted advisory data. A
`changes-requested` decision fails the review step; a `no-objection` decision is
not approval. Independently verified patch artifacts remain available for human
inspection, including when the advisory review fails.

Only normalized review JSON joins the compact 90-day evidence artifact;
archives, credentials, raw sessions, and temporary configuration are not uploaded.
Normal failures and cancellation clean temporary state; hard host termination
cannot guarantee cleanup and is not successful evidence. Before publication, a
human must inspect the exact patch and report, open the PR, pass full required CI,
obtain independent human approval of its final head, and manually publish. This
automation has no commit, push, PR-creation, merge, or release path.

Offline tests use synthetic replies and child processes. They do not establish
Linux runtime behavior, model access, live usage-schema compatibility, billing
enforcement, review quality, or an observed improvement loop. Keep activation
and any first live run separately authorized; record actual evidence only after
it exists.

The [Dependabot configuration](.github/dependabot.yml) also starts paused with
zero ordinary version-update PRs. After enforcement is verified, enable it in a
reviewed change by setting the npm limit to **2** and the Actions limit to **1**.
It covers the root workspace lockfile and pinned Actions weekly. Major upgrades
are held for separate manual PRs; preserve declared Node compatibility and action
SHA pins. These caps do not control separately enabled security-update PRs,
which can exceed ordinary version-update limits. Dependabot is maintenance
automation, not evidence of AI engineering throughput.

### Offline Finding Dispositions

Successful review reports include a locally generated `findingIds` array aligned
with `response.findings`. IDs hash the versioned review identity, sorted evidence
hashes, input/patch/response digests, finding position, and finding contents. They
identify a finding in one exact review, not a recurring issue across different
runs. The model response format is unchanged. Older version-1 reports without
this array can have IDs derived offline without rewriting the original report;
present but inconsistent IDs are rejected.

These commands only read bounded local UTF-8 JSON and print JSON to stdout:

```sh
node scripts/check-agent-review.mjs --prepare-dispositions test-results/maintenance/run-EXAMPLE/agent-review.json
node scripts/check-agent-review.mjs --validate-dispositions test-results/maintenance/run-EXAMPLE/agent-review.json test-results/agent-review-dispositions.json
```

The example paths stand for an actual retained report and a separate,
human-maintained disposition record. Run from the repository root, using
forward-slash paths relative to the current directory. Absolute paths, traversal,
symlinks/junctions, nonfiles, and oversized inputs are rejected. No credentials,
workflow metadata, network access, model invocation, or writes are needed, even
when live-review environment variables are set.

Preparation prints a version-1 `agent-review-dispositions` template with exactly
`schemaVersion`, `kind`, `review`, and an empty `entries` array. Keep the generated
`review` binding unchanged. It contains the original report's byte-exact SHA-256,
source revision, run/attempt/workflow, input/patch/response digests, and
`evidenceManifestSha256`, the digest of its sorted evidence path/hash pairs.
Reformatting or replacing the source report invalidates this binding. Maintain
the template as a separate UTF-8 record; preparation makes no decisions. Checking
an empty record lists every finding ID as `untriaged`, including for older reports.

Each actual human decision adds an entry with exactly these five fields. This
illustrative entry contains placeholders, not recorded review evidence:

```json
{
  "findingId": "<locally generated finding ID>",
  "disposition": "accepted",
  "reason": "The generated reference needs correction.",
  "recordedBy": "<reviewer login>",
  "recordedAt": "<UTC timestamp at or after the report finish>"
}
```

Decisions are `accepted`, `rejected`, or `deferred`; omissions remain `untriaged`.
The reason must be nonblank and at most 2,000 UTF-8 bytes, without terminal control
characters. `recordedBy` is a GitHub-login-shaped claim of at most 39 characters,
not authenticated identity. Use a real UTC timestamp in
`YYYY-MM-DDTHH:mm:ss.sssZ` or whole-second `YYYY-MM-DDTHH:mm:ssZ` form. Duplicate or
unknown IDs, missing/extra fields, invalid timestamps, unsupported decisions,
and entries predating the report are rejected. Reports are capped at 96 KiB and
disposition records at 64 KiB, with at most ten entries. Failed, incomplete,
cancelled, rerun, manual, and no-op source reports are ineligible; a valid reviewed
`no-objection` report may have an empty record.

Validation exits nonzero on invalid input. Success means **local consistency
only**, not that every finding was triaged or resolved. The summary includes IDs,
decision counts, and input digests, but not finding text, reasons, or reviewer
claims. It leaves provenance, identity, and resolution verification explicitly
false and human approval required. Accepted, rejected, and deferred decisions
are never fixes, approvals, or publication permission. Local checks cannot
authenticate GitHub artifacts, establish the truth of claimed timestamps, or
recompute omitted raw response/usage evidence. Keep the original report and the
separate decision record for later authenticated verification; no live ledger,
resolution claim, scheduler, or automatic publication is created by this feature.

### Verified Finding-To-Fix Links

The existing read-only improvement collector can verify a repair link for an
accepted agent-review finding. This is separate from a named failing-test
regression: acceptance does not manufacture a regression or prove a fix. No new
workflow or model invocation is introduced, and no real evidence entries are
seeded. An omitted or empty `agentReviewRepairs` list makes no repair-link requests.

Propose an optional `agentReviewRepairs` list in the
[regression registry](.github/improvement-regressions.json), alongside the existing
`regressions` list. At most four unique finding IDs are accepted. Each link has
exactly these nine fields; this example is schematic, not valid historical evidence:

```json
{
  "findingId": "<full finding ID from the exact review>",
  "reviewRunId": "<original maintenance run ID>",
  "reviewReportPath": "run-EXAMPLE/agent-review.json",
  "reviewReportSha256": "<SHA-256 of the original report bytes>",
  "dispositionsPath": ".github/agent-review-dispositions/example.json",
  "dispositionsSha256": "<SHA-256 of the reviewed disposition bytes>",
  "fixCommit": "<full final repair PR head SHA>",
  "pullRequest": 123,
  "afterRunId": "<successful merge-commit CI run ID>"
}
```

Run IDs are positive safe-integer decimal strings, with `afterRunId` newer than
`reviewRunId`. Digests are full lowercase SHA-256 values; `fixCommit` is a full
lowercase commit SHA, and `pullRequest` is the actual positive integer PR number.
The report path is archive-relative: maintenance uploads preserve the
`run-<name>/` directory, not the leading `test-results/maintenance/` path. The
disposition filename must be lowercase alphanumeric/hyphen, at most 80 characters
before `.json`, under `.github/agent-review-dispositions/`.

To record a genuine link:

1. Preserve the exact original review bytes from the successful, first-attempt,
   scheduled maintenance run on the default branch. Prepare the separate
   disposition record using the offline commands above. Its review binding must
   remain unchanged, and the linked finding must have an actual `accepted` entry.
2. Include that record and a change to the finding's file in the repair PR. A
   non-author human owner, member, or collaborator must approve the final head
   before merge, at or after the recorded decision time, with no outstanding
   request for changes. `fixCommit` identifies that final head, not an earlier
   intermediate commit. The reviewed disposition and finding-file blobs must
   survive unchanged in the merge. Added or modified files qualify; deletions,
   renames, symlinks, and submodules do not.
3. Wait for successful first-attempt default-branch push CI at the exact PR merge
   commit. Its authenticated `ci-required` artifact must contain a valid passing
   `required-validation` report with matching identity. Another green revision,
   a rerun, or a success claim without matching aggregate evidence does not qualify.
4. Propose the link using the actual identities and byte digests. The offline
   disposition check supplies `review.reportSha256` and `dispositionsSha256`.
   A later registry-only PR cannot replace the original reviewed repair or add a
   missing decision record retroactively.

The existing authenticated `npm run improvement:report` workflow command consumes
these links. Its local `--input` comparison mode cannot verify them. The exported
`verifyAgentReviewRepair` verifier also accepts the existing repository-scoped
`createImprovementClient`; it performs bounded GET requests and returns a result
without writing files or executing downloaded content. Tests inject synthetic
clients and are not observed operational repair evidence.

Checks bind the original API-authenticated maintenance artifact and exact report
bytes, immutable Git tree/blob contents, complete PR inventories, independent
final-head review, merge ancestry, and successful merge CI. Truncated or oversized
inventories are insufficient evidence, including 100 or more PR files, commits,
reviews, or ancestry commits, and trees with more than 2,000 entries. Expired or
unavailable artifacts also leave the link unresolved. Compact maintenance and
aggregate CI uploads request 90-day retention, but do not recover already expired
review artifacts from the separate regression-retention bundles.

Reports expose `agentReviewRepairStatus` as `not-requested`, `verified`, or
`insufficient-evidence`, with per-link `verified-link` or `unresolved` results and
bounded missing-evidence reasons. A requested unresolved link makes the overall
report insufficient evidence. Successful results include exact IDs, digests, and
canonical PR/review links, not decision reasons or claimed logins. They verify
the recorded repair linkage, not semantic correctness, causal resolution, the
truth of claimed timestamps, or the identity behind `recordedBy`.
`resolutionVerified` and `recordedIdentityVerified` remain false. Human approval
remains required; no automatic repair, publication, or authorization is inferred.
