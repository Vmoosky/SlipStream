# Native and Owned-Model Live Validation

Date: 2026-09-14. Live snapshots were collected around 14:57-15:02 UTC.

Status: **partial validation, not a completed live-model evaluation**. Native
transport and recommendation preflight were exercised against the running VS
Code host. No additional model-evaluation requests were sent, no passing task
evidence was seeded, and no workspace policy or model-picker setting was changed.
Normal Copilot chat telemetry continued during the checks.

## Results

| Area | Evidence | Result |
| --- | --- | --- |
| Native hook-to-tool transport | Real recovery events with hook-supplied session/tool IDs; native status reported Observe | Confirmed for sampled traffic |
| Native telemetry association | Four unique model spans matched native-event session IDs exactly in a retained 40-event window | Partial coverage confirmed; not every request or owned task |
| Native artifact recovery | Three recovery events in that window, all with actual passing outcomes | Confirmed for those recoveries |
| Designated native test/build results | No designated checks or check results in the sampled live state | Not exercised |
| HC-04 live recommendation preflight | Twelve post-refresh cases against the running recommendation endpoint | Passed; no unqualified switch |
| HC-04 model quality | Zero owned tasks and zero verified task outcomes | Not evaluated |
| HC-05 actual model selection/send | Production-adapter regressions pass with model doubles; no live evaluation sends | Not demonstrated with real providers |

The native snapshot contained 10 native events, three successful recoveries, and
eight observed spans. Four unique spans shared an exact session ID with native
events. This is a sample of retained metadata, not a completeness claim, a
time-window attribution rule, or proof of task-level quality. IDs and payloads
are deliberately excluded from this report. Receiver health at that snapshot
showed 136 accepted observations and zero rejected exports in every reported
category; those counters are scoped to the running window.

## Runtime Preconditions

- The workspace cost policy remained Recommend-only with a 500-token task
  allowance. Fixed permitted models were `copilot/claude-opus-5` and
  `copilot/gpt-6-astra`; `copilot/auto` was also permitted but has no resolved
  downstream identity for this comparison.
- Native status remained Observe with zero designated checks. No Guard threshold
  or temporary check was enabled.
- The 500-token allowance is insufficient for the owned adapter's default
  2,048-token output reservation, before input headroom. It does not cap native
  Copilot chat. Automatic mode was not enabled to bypass this precondition.
- Discovery listed the models, but host-reported access is not proof that an
  actual send will pass authorization. VS Code model-use consent remains required.
- The installed cache-cost update was not active in the running host: the live
  summary still lacked `inputCost` fields. These live results describe that
  running host, not a claim that the latest VSIX was activated. A user-triggered
  window reload and dashboard refresh remain necessary before final rehearsal.

## Catalog Preflight Issue Resolved

Initially the cached pricing snapshot was fresh by age but lacked `toolCalling`
metadata. Both fixed models consequently returned `tool-unsupported`, making
the recommendation unavailable despite having published reference prices.

The normal dashboard catalog-refresh endpoint was used once. It fetched public
catalog metadata only, returned HTTP 200 with no error, and populated tool
capability for both fixed models. Subsequent comparisons passed compatibility
and retained the requested model for `insufficient-evidence`.

The policy and owned-task count were unchanged. All 25 overlapping displayed
historical observation rows were identical before and after the refresh. No
historical rate was backfilled or overwritten. A fresh catalog age alone is not
sufficient evidence that an older cache includes newly supported metadata.

## Live Recommendation Matrix

Each ordinary comparison used an explicit input estimate of 1,000 tokens and
output estimate of 512 tokens. These were local recommendation inputs, not
model requests or token-counting calls. Prices were cached public API reference
estimates, not Copilot charges.

| Cases | Expected and observed result |
| --- | --- |
| Each fixed model in code, triage, and summarize: six cases | HTTP 200, `retain`, `insufficient-evidence`, requested model unchanged |
| Hold baseline | HTTP 200, `retain`, `pinned`, baseline unchanged |
| Missing task details | HTTP 200, `needs-input`, `task-details-required` |
| Input beyond context capacity | HTTP 200, `unavailable`, `no-compatible-model` |
| Unresolved Auto baseline | HTTP 200, `unavailable`, `no-compatible-model` |
| Negative input estimate | HTTP 400 |
| Stale policy revision | HTTP 409 |

All 12 post-refresh cases met these expectations. The initial 12-case pass
before refresh validated refusal behavior only; it did not establish compatible
model availability. Neither batch created an owned task or changed policy.
Zero verified outcomes correctly prevented a cheaper recommendation. This is
evidence about conservative admission, not recommendation quality on real tasks.

## Focused Automated Checks

Run from the repository root:

```text
npm test --workspace @slipstream/core -- --pool=vmThreads test/nativeChat.test.ts test/modelTelemetry.test.ts test/costPolicy.test.ts
npm test --workspace slipstream-vscode -- --pool=vmThreads test/chatHooks.test.ts test/nativeChat.test.ts test/chatParticipant.test.ts
npm run benchmark:recommendations
```

The two test commands passed 197 tests: 101 core and 96 extension. Coverage
includes the bundled hook executable, context replay/staleness, workspace trust,
approval and cancellation, actual command exit-code handling in fixtures,
exact telemetry IDs, and selected-object sends through the production owned
adapter with model doubles. Fixture stores are isolated from live task evidence.
These counts are this validation run, not a new full-suite result.

The local selector benchmark passed its 5 ms p95 target. Each scenario used
2,000 samples after 200 warmups on Windows 10.0.26200 x64, Node 24.14.1, Intel
Xeon Platinum 8370C at 2.80 GHz:

| Scenario | p95 |
| --- | --- |
| 64 qualified candidates | 0.0725 ms |
| 64 candidates with mixed eligibility gaps | 0.0792 ms |
| Empty policy | 0.0009 ms |

This excludes discovery, token estimation, evidence aggregation, price snapshot
assembly, network, and model inference. It is not end-to-end task latency or a
quality benchmark.

## Remaining Live Gates

1. Activate the tested extension with a user-triggered reload, then check the
   running version and exact workspace before an evaluation.
2. Obtain explicit approval for the model pair and evaluation ceiling. The
   proposed maximum of eight sends, 2,000 estimated input tokens and 512 output
   tokens per send was not approved or installed as an executable cap. A live
   driver must enforce limits at the actual send boundary, stop on cancellation
   or failed preflight, and avoid retries. Local limits are not a billed-spend cap.
3. Use isolated validation storage and task-scoped test policy, preserving saved
   settings, actual model consent, command approvals, and exact task/call IDs.
   Do not work around missing APIs or credentials through private endpoints.
4. Collect three real, independently verified tasks per model in one declared
   category, using identical public synthetic fixtures for the paired runs.
   Check the actual returned result against a predetermined expected answer.
   An unrelated passing repository test or a model's success claim cannot verify
   the task. Do not weaken or seed the qualification rule.
5. On a held-out fixture, request the more expensive qualified model with policy
   selection enabled and verify that the selected real model receives the send.
   Record the requested and selected identities separately; unavailable reported
   response identity, billed usage, and provider-internal retries remain unknown.
   A pinned control must keep its model. This small trial cannot establish broad
   quality equivalence or financial savings.
6. With approval, designate one exact read-only test command in the existing
   Observe policy, execute it through the native Slipstream tool, and confirm
   its real exit code is captured against the exact invocation. Remove only the
   temporary entry afterward, preserving concurrent edits. Do not forge a native
   context, replay commands, or promote native results into owned-model evidence.
7. For bounded compression feedback, enable `compressionFeedback` in an isolated
   task-scoped test policy only, and collect enough independently verified tasks
   per profile to reach the configured sample count. Confirm on live traffic that
   an excessive-retrieval or verified-failure history reduces the profile, that a
   trial rolls back on a guardrail breach, and that the kill switch restores
   static behavior. Hold the model fixed for the whole trial. Fixture evidence
   and manually edited profiles are not live proof, and these decisions establish
   no cost-per-successful-task benefit.

Router/provider work, global Automatic-mode enablement, workspace-wide adaptive
enablement, and a claim of complete HC-08 evidence remain outside this validation.
Bounded compression feedback is implemented and covered by fixtures, but no live
adaptation, rollback, or paired trial has been observed.