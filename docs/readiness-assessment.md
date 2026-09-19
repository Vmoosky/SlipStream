# Readiness Reassessment

## Current Status

CodeBlend completed again on 2026-09-19 at merge commit
`5ec8594c7e60655764be7e2513f4d03209f134b1`. The current result is **80.6/100**:
Substrate is **89.6, L5 Autonomous**, and Operation is **72.5, Agent-Enabled**.
The repository is not AI-ready because both axes must reach 80.

The assessment used reported repository and GitHub API evidence. It found the
root `pull_request_target` workflow but could not correlate the custom
JavaScript implementation into its supported static LLM-review capability
model. More importantly, static workflow inspection cannot prove successful
execution. Two fresh runs on PR 50 proved preparation and model evaluation
completed for each exact PR head, but finalization failed with the sanitized
phase `pr-agent-review-response-json-failed`. A bounded local reproduction found
that Copilot ignores piped standard input when `--prompt` is also supplied and
that text output can hard-wrap JSON. The PR now supplies the complete prompt on
standard input, captures machine-readable JSONL, extracts exactly one successful
no-tools assistant response, and deletes the raw event stream before secret-free
finalization. For pull requests targeting `main`, `pull_request_target` executes
the trusted workflow version from that base branch, so success remains unverified
until a subsequent pull request completes against the post-fix `main` branch.

A runtime success claim therefore requires a fresh pull request against the
post-fix default branch and all of the following bound evidence:

- a completed `PR Agent Review` run for the pull request's exact head commit;
- a successful workflow conclusion and successful evaluation, finalization,
  publication, and artifact-upload steps;
- one retained `pr-agent-review-<pr>-<run>-<attempt>` artifact containing a
  schema-valid report bound to the same repository, pull request, base, head,
  input digest, concrete resolved model, one invocation, and zero retries; and
- the owned advisory PR comment for that head, while required CI, security, and
  independent human approval remain separate controls.

Until that evidence exists, the reviewer is configured but not operationally
verified. The evaluator's static limitation should not be bypassed with dummy
configuration or inferred from filenames.

The remainder of this document preserves the original 2026-09-14 reassessment
record and should be read as historical context.

## Result

CodeBlend completed successfully on 2026-09-14. The headline improved by
**23.4 points**, from **24.8 to 48.2/100**. The repository is **not AI-ready**:
the evaluator requires both substrate and operation scores to reach 80.

| Measure | Before | After |
| --- | --- | --- |
| Headline | 24.8 | 48.2 |
| Substrate | 45.6, L3 Collaborative | 65.8, L4 Delegated |
| Operation | 13.50, Manual | 35.25, Scripted |
| Composite rung | R1 Manual | R2 Legible |
| Documentation drift | Documented only | Partial |
| Continuous cleanup | 35/100, Capability only | 35/100, Capability only |

The operation value is copied from the evaluator's JSON; its Markdown overview
rounds it to 35.2. Scores above are the evaluator's results, not a manual rescore.

## Scope And Provenance

- Target: `Vmoosky/SlipStream`, branch `main`.
- Base commit: `158abef8e5d652bb85e1cdc293b1e6157ee3077e`.
- The assessment ran before the local source commit, with 203 uncommitted paths.
  It is not an assessment of a clean committed or published source tree.
- The candidate exactly matched the previously verified 203-file inventory:
  SHA-256 `fc8e68aea89f62ab654a217b95ce2a799dd9b5600b2cc11d8098d6136dcacec7`.
  This hashes the ordered path/size/content-hash inventory, not a Git tree object.
- Started: `2026-09-14T21:48:01.0528299Z`.
  Finished: `2026-09-14T21:50:28.3687385Z`. Status: `succeeded`.
- All seven evaluator stages executed, including authenticated GitHub API
  evidence and the Copilot judge ensemble. No degraded-evidence flags were used.
- The bundled Windows X64 evaluator used an isolated official Copilot CLI
  `1.0.78`, with child-only PATH and auto-update disabled. Global installations,
  accounts, and Git authentication were unchanged.
- Judges: `claude-opus-5`, `gpt-6-astra`, and `grok-4.6`.
- GitHub still contained the README-only baseline during evaluation. No required
  status checks, active rulesets, or merged PR evidence were found.

Original JSON, Markdown, judge reports, and CSV exports remain unchanged under:

```text
%USERPROFILE%/.ai-readiness-eval/github-com-vmoosky-slipstream-1538b61c6359/runs/
  20260915-040600+0800/   previous assessment
  20260915-054801+0800/   reassessment
```

The directory names use UTC+08:00; both runs occurred on September 14 in UTC.
The reassessment's `composite.json` SHA-256 is
`510f25b7558c42b57abab254de38392dfdd52eb6742290f17c432e2ae9958fe3`.

## Confirmed Local Changes

- Dependency-ordered builds, pinned development/packaging tools, and
  platform-specific Vitest configuration.
- Linux Node 20/22/24 and Windows Node 24 unit CI; Linux/Windows browser-proof
  jobs; required aggregates that reject missing, failed, cancelled, skipped,
  duplicate, or mismatched evidence.
- Pinned security workflows and redacted Gitleaks checks. Contributor and
  ownership guidance documents the private-reporting activation gap.
- Check-only documentation contracts with explicit generation, manifest
  references, local Markdown and agent-index links, and JSON/cost-policy checks.
- Removed obsolete backlog, demo, and registration presentation material. The
  required [offline workload](../tests/fixtures/outcome-workload) remains test data.

The candidate was verified from an isolated root-only install on Windows X64,
Node 24.14.1: **854 tests passed** (555 core, 49 hook-runtime, 20 MCP, 154
extension, 2 plugin, 42 scripts, and 32 desktop/mobile browser tests). Build,
types, scoped lint/format, documentation checks, the five-run offline proof,
benchmark, actionlint, and VSIX packaging passed. The dependency audit reported
zero advisories after updating `qs` to 6.16.0; candidate/history secret scans
found no leaks. The reassessment confirmed the source hashes had not changed
since those checks. It did not rerun or independently certify those tests.

After the assessment, commit preparation added this record and its contribution
guide link, pinned LF checkout for formatter-managed paths in
[.gitattributes](../.gitattributes), and removed trailing blank lines from two
source/test files. No executable statements changed. The staged whitespace check
and an actual `core.autocrlf=true` checkout with Prettier both passed. These
post-assessment changes are outside the evaluated 203-file snapshot.

## Remaining Gaps

These gaps describe the assessment-time state. The source was subsequently
published as `4dd1559b1331a6c45e17ae3afaebcafbc9a8d752` with owner approval; the
local and remote revision were verified equal. During the next implementation
step, an authenticated Actions lookup for that commit returned HTTP 404. This
does not establish whether workflows failed, are disabled, or are inaccessible.
Remote run conclusions and current protections remain unverified through that
session; use an authorized owner session to inspect the existing runs before
dispatching another one.

The next local change requires the exact generated-document contract paths at
collection and aggregation. Wrong names, duplicate/missing paths, non-array
values, and extra contracts must fail; ordering alone is harmless. Generator
tests also compare their emitted contract set with CI's expectation. The
[coverage table](architecture.md#documentation-contracts) records what is checked
and what still needs review. These changes do not constitute another CodeBlend
evaluation or prove GitHub enforcement.

1. Obtain owner approval for source ownership, complete license text, bundled
   attribution, and the exact publication inventory. The extension license is
   only a placeholder. The local commit does not authorize a push or release.
2. Publish approved source, observe real successful and failing PR runs, and
   activate and verify required `ci-required` and `security-required` checks.
   Enable private vulnerability reporting and available push protection. Local
   workflow files and static security scores do not establish enforcement.
3. Confirm the full Linux/Node 20/22 matrix and GitHub security jobs remotely.
   The local verification was Windows/Node 24 only.
4. Introduce bounded maintenance with human review after the required gates are
   enforced. Cleanup remains capability-only: no bounded driver or scheduler
   enrollment was found. No automatic repair or merge is enabled.
5. Collect attributable workflow and review outcomes before claiming operational
   maturity. There is no meaningful PR-throughput sample or independent-review
   evidence, and offline proof is not live-provider quality or billing evidence.

For documentation drift, the evaluator's residual action is: "Extend the existing
deterministic documentation check from targeted paths to repository-wide affected
PR validation." Locally, the checker already scans maintained Markdown plus
`llms.txt`, and CI has no source-path filter. Its semantic contracts remain
limited, and no required merge rule is active. Verify the complete affected-PR
path and extend contract mappings as public surfaces grow. Semantic review is
advisory; automatic repair is a backstop, not a substitute for a deterministic
blocking PR gate.

## Detector Limitations

The evaluator missed the existing Playwright suite and scoped Prettier command.
It also inferred an LLM PR auditor partly from the locally installed evaluator
skill and product code; this is not evidence of an enrolled review workflow.
Its coarse `packages` grouping and one-commit history limit modularity and change
trend conclusions. These limitations are recorded without changing its score or
adding dummy tooling to satisfy detection heuristics.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for validation and activation steps and
[SECURITY.md](../SECURITY.md) for the current reporting boundary.