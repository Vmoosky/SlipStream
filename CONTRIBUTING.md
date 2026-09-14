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

Scheduled maintenance, bot-created changes, and releases remain separate work
after the required gates are actually enforced. The
[readiness reassessment](docs/readiness-assessment.md) records the local progress,
verified snapshot, evaluator limitations, and outstanding activation steps.