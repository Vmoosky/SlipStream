# Governed Improvement Loops

Status: accepted for implementation; operational proof and scoring are separate.

## Context

Slipstream already compares CI symptoms, verifies registered named regressions,
and links accepted advisory findings to independently reviewed repairs. Those
results do not by themselves feed a reusable lesson into later reviews. The
bounded reviewer must retain its no-tools, no-publication, first-attempt weekly
schedule and explicit model/billing authorization. Automatic model selection
requires separate owner confirmation, and retained usage evidence must bind it
to one concrete resolved model.

## Decision

Use optional `learnedRules` in the existing
[regression registry](../../.github/improvement-regressions.json), not a second
scanner-oriented configuration. Share validation, canonical payload hashing,
and scope selection through
[check-improvement-rules.mjs](../../scripts/check-improvement-rules.mjs).
The collector and model never write this corpus. No real entries are created
without genuine source evidence.

The corpus is bounded to 64 KiB, 16 versions, and four active rules. Each version
has an ID, positive integer version, proposed/active/retired state, exact generated
document scope, nonblank criterion, typed source finding, prevention-test reference,
and lifecycle reason. Criteria are capped at 1,000 UTF-8 bytes, reasons at 2,000,
and test names at 300. Control characters, extra fields, commands as configuration,
globs, and symlink/junction registry paths are rejected. Test references are
repository-relative JavaScript/TypeScript test files under tests, e2e, or packages.
The [contributor procedure](../../CONTRIBUTING.md#governed-learned-rules) is the
field and command reference.

## Lifecycle

Introduce a version as proposed. A human-reviewed PR can activate or retire it;
active versions can only stay active or retire, and retirement is terminal.
Keep historical versions. ID, version, sorted files, criterion, typed source,
and prevention-test reference form the immutable canonical payload. A payload
change requires a new, increasing version, not borrowed approval. Lifecycle
reason, status, and later promotion references are outside the payload digest.

An optional promotion identifies the actual activation PR, its final head SHA,
and the later successful merge-commit CI run. Record that reference in a subsequent
ordinary reviewed change, after the identities exist. Verification reads bounded,
authenticated Git blobs at the PR base, final head, and merge. It requires a
proposed-to-active transition and identical active payload at head and merge,
complete PR inventories, merge ancestry, independent non-author human final-head
approval before merge, no outstanding changes request, and exact first-attempt
default-branch merge CI. Self, bot, stale, dismissed, and post-merge approval do
not qualify. Compare the individual payload, not the entire mutable registry.

Active is a configuration state, not an approval claim. Without verified
promotion it remains configured-only. Missing, expired, incomplete, or tampered
evidence is unresolved. Requested unresolved source or promotion evidence fails
the existing reporting gate; omission is never invented approval.

## Review Boundary

Only active rules whose exact file scope intersects a verified proposal enter
the existing untrusted JSON input. Criteria are advisory reference data, not
instructions, permissions, executable checks, or a custom-instruction channel.
The fixed prompt and tool denial remain controlling. The full prompt still has
its 96 KiB ceiling before runtime preparation and model invocation.

No applicable rules preserves legacy input bytes. Optional report metadata binds
registry bytes, ruleset, and supplied ID/version/payload hashes; the input digest
already binds criteria. Keep the three maintenance evidence hashes, model response
schema, finding-ID algorithm, and legacy version-1 dispositions unchanged.
Disabled, manual, rerun, invalid-evidence, and no-op paths still make no model call.

## Proof Levels

- Configuration: a rule version and its declared state exist.
- Source: a correctly typed registered CI regression or agent-review repair link
  is independently verified. Review IDs are not CI symptom fingerprints.
- Regression: the existing supported workspace Vitest report proves the same
  named test failed then passed. Root Node tests, newly added tests absent from
  the failing report, and PR-only failures do not acquire that proof automatically.
- Governance: the actual activation payload has independently verified review,
  merge, and exact CI evidence. Source repair review remains a separate result.
- Reuse: a genuine later eligible model invocation reports that payload supplied.
  Supplying a criterion does not prove compliance or prevention.

A test reference or passing aggregate proves neither test execution nor semantic
resolution. Keep `resolutionVerified` false and do not infer repeated use from
configuration, synthetic fixtures, or a no-op run.

## Retention And Rollback

Reuse the byte-preserving readiness exporter for authenticated improvement
reports, including insufficient-evidence statuses. Local input comparisons remain
unverified and unexported. Keep reports transient and ignored, not committed proof.
Request 90 days for compact improvement, maintenance/review, and aggregate CI
reports. Bulk CI and proposal artifacts stay at seven days. Existing registered
regressions still require timely capture of their unit originals; their bounded
recovery does not recover review artifacts or renew capture time.

Repository policy may shorten retention, and extending retention cannot revive
expired artifacts. Recheck live evidence; an old success boolean is not permanent
proof. Pause review using its existing opt-in control. Retire a problematic rule
with a reason in an ordinary reviewed PR, or propose a corrected new version.
Do not rewrite historical reports, IDs, or dispositions. Product rollback and
publication require their own reviewed changes and required checks.

## Consequences

The implementation adds a bounded learning path without automatic source repair,
new model calls, schedule changes, or additional publication rights. Independent
operational review, a genuine finding and repair, and observed later reuse remain
necessary evidence. The unchanged readiness evaluator may still miss guarded
Node-delegated review. Report delivery and this ADR are not a promised score uplift.
