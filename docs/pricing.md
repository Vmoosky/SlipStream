# Automatic Model Pricing

Normal local Copilot Agent chat can report its model through an opt-in local
OpenTelemetry connection. Slipstream automatically offers consent once in a
supported trusted workspace. No command is needed: if Copilot becomes available
after startup, the offer appears then. Click **Allow** to approve the connection.
Previous declines and disconnects are respected. Reopen consent with
**Dashboard > Model tracking > Connect** or
**Slipstream: Connect Local Model Tracking**. No GitHub login, personal access token, or new model-use
authorization is required; this is permission to receive local telemetry.

In a standalone dashboard, **Connect to VS Code** checks the extension's running
dashboard and switches the same browser tab to its tracking controls. It does not
open another VS Code page or grant telemetry consent. The extension dashboard must
be enabled; the default port is 7331. For a custom `slipstream.dashboardPort`, set
`SLIPSTREAM_VSCODE_DASHBOARD_PORT` to the same port when starting the standalone
dashboard. An unavailable runtime produces a visible error and can be retried.

Installing a VSIX does not replace the extension code already running in a window.
Run **Developer: Reload Window** after an update and after first enabling Copilot
telemetry. A ready local receiver alone does not mean any model has been observed.

For tool-event pricing with an exact request identity, **Slipstream: Start Chat**
opens Ask mode with `@slipstream`. Slipstream reads `ChatRequest.model` for every
owned request and binds that model's ID,
vendor, and name to the request's tool events. Changing the model picker takes
effect on the next request. Concurrent chats cannot change each other's rates.
The selected model handles the response; pricing never selects a different model.

Native Slipstream tools can also use a recorded model rate when a complete model
response export explicitly identifies the tool call and the local execution
metadata confirms the same call. Unmatched events continue to use the fallback;
the latest observed model is not used as a substitute for this link.

Model rates come from [Models.dev](https://models.dev) in the background. There is
no provider or reference-model picker; the old `slipstream.pricing` setting is
ignored. **Est. saved** combines recorded event rates with a configurable fallback
for missing rates, rather than hiding recorded savings behind `N/A`.

Set **Dashboard settings > Runtime config > Fallback input rate** or
`slipstream.usdPerMillionTokens` in VS Code. The default is **$3 per million tokens**;
zero is allowed. Changing the fallback updates only estimates for events without
recorded rates. It does not overwrite event prices or assign a model to them.
Compression profiles do not change the fallback.

The main dashboard's **Model tracking** section shows the last detected chat model and
its current cached input rate, with the source and last observed call's input,
output, and cached-input token counts when supplied. The recorded model and cached
rate are restored on page load and reconnect, without waiting for another call.
Native telemetry must include a conversation or chat-session ID to update this
display; unscoped background/helper calls remain in history but cannot replace
the chat model. Connection state is shown separately from historical observations.
This is activity status, not a global active-model
selection and not a rate applied to other producers. Existing event costs are
never recalculated from this display.

Connect and Disconnect are available directly in this section. **Connected** means
the local receiver is ready. While connected, fallback pricing, an unavailable
rate, or a pending first model observation appears as a neutral information note,
not a tracking error. Warning styling is reserved for tracking that is not
connected. Connecting cannot reconstruct identities missing from older tool
outputs. Late exports can resolve outputs that already retained their tool-call
identity, without rewriting those events.

**Models > Receiver health** distinguishes a ready receiver from one that has
actually received telemetry. It shows the last locally accepted observation's
timestamp and live age, authenticated export requests, accepted model observations,
and rejected requests by fixed reason. Authenticated exports include traces,
metrics, and logs, even when no usable model observation is present. Health probes,
retried spans, and host-declined observations do not inflate accepted counts.
The acceptance timestamp is local receipt/processing time, not the exported
span's completion time or a measurement of export latency.

Health counters are memory-only, survive receiver restarts within the same VS Code
window, and reset when that window reloads. Historical model rows are separate
and remain visible after reload. When another window hosts the receiver, local
health is explicitly unavailable. Rejection diagnostics contain only reason
counts, never payloads, credentials, endpoints, or model/session identifiers.
Health-only updates do not change the ledger, pricing, or savings.

**Models > Per-model usage** aggregates all recorded model observations, including
chat-associated and background calls, by provider and exact model ID. The response
model takes precedence over the request model. It shows call counts, reported
input/output/cached-input tokens, first and last observed completion times, and
the current cached catalog input rate. Rows are ordered by call count and are not
limited to the separate 25-call recent history.

Missing token metadata appears as **Not reported**. A sum from only some calls is
labelled **Partial** with its reported-call count; an explicit zero remains zero.
Cached-input tokens are part of the input total, not extra tokens. Missing rates
show their current lookup reason: **Catalog not loaded**, **Model not in catalog**,
**Ambiguous model match**, or **Catalog expired**. None means a zero price, and an
ambiguous match never selects an arbitrary price or a less-specific alias.
Refreshing the catalog can change this rate column without changing the rate
stored with any earlier observation. The aggregate is read-only and does not
attribute model usage to tool outputs, recalculate savings, or expose
conversation identifiers.

Tool-output savings remain **standard uncached public API estimates**, not
Copilot billing, credits, actual invoice savings, or a prediction of your bill.

## Cache-Aware Input Costs

**Models > Observed model calls** shows separate input-cost components for the
latest 25 recorded observations: uncached input, cache reads, and cache writes.
Each estimate uses only the rates stored with that observation, never the current
catalog, another call's model, or the configurable fallback savings rate.

- **Uncached** prices total input minus reported cache-read and cache-creation
	tokens at the recorded standard input rate.
- **Cache read** and **Cache write** use their respective recorded rates.
	These tokens are part of total input, not additional input charges.
- **Cache-aware input** combines the three components. **Complete** means all
	required counts and rates are available. **Partial subtotal** shows only known
	component costs; it is not an estimate of the missing components or the full call.
- **Standard uncached** is the labelled default comparison: all reported input
	at the recorded standard input rate. It is not an additional charge, a cached
	usage claim, or a cache-savings attribution.

Missing cache counts remain unknown, including an unreported cache-creation
count. The uncached remainder then remains unknown too. Zero input and explicit
zero rates remain valid; tiny nonzero costs display as less than the smallest
displayed unit rather than zero. Invalid counts or cache counts exceeding total
input make the estimate unavailable. Component tooltips include token counts;
the cache-aware total's tooltip identifies missing usage or rates.

All of these amounts are **input-only public API reference estimates**. They
exclude output charges and do not measure Copilot subscription billing or
Slipstream's compression savings. Cache-write premiums can make the adjusted
estimate higher than the standard-uncached comparison.

Catalog refreshes, configuration changes, page reloads, and restarts do not
reprice an existing observation. Older records without cache rates retain their
partial or unavailable coverage; no rates are backfilled. The ledger, recorded
tool-event prices, and existing savings totals are unchanged. New observations
can use newly available catalog rates in their own snapshots.

## Context Growth

**Models > Context growth versus savings** aligns three independent measurements:
reported input tokens for each model call, the reported cached-input share of
that call, and net tokens saved by Slipstream in five-minute intervals. It covers
all producers sharing the ledger, including chat-associated and background model
calls. Completion timestamps position model calls; ledger timestamps position
tool outputs. This is time alignment, not an exact session, turn, or model-call
join, a counterfactual prompt size, or a billing calculation.

The displayed 60-minute window ends at the next five-minute boundary after the
latest recorded model call or tool output. Its explicit start and end times stay
visible, and an idle dashboard retains that window. Chat, observed-tool, reset,
and other session-only markers do not move the window or contribute savings.
Each interval includes its start time and excludes its end time.

The chart and expandable model-call table show at most the latest 200 calls in
the window, in completion order, with the full call count and shown count when
limited. Input and cache-share coverage refer to those shown samples. Missing
usage stays **Not reported**; zero input remains zero but has no defined cache
percentage. A cached-input count larger than input is **Inconsistent counts**
and is not plotted as a percentage. Late observations update their original
time position rather than appearing at their arrival time.

Savings intervals always include every tool-output event in the window, even
when the displayed model samples are limited. The interval table separates
signed saved tokens (input minus output), retrieved tokens, and net saved tokens
(saved minus retrieved). Expansions and retrievals can make net savings negative.
Observation markers never add savings, and this view does not change recorded
prices, fallback estimates, or historical ledger entries.

## Native Chat Policy

Ordinary Copilot Agent chat can use native policy feedback without creating an
`@slipstream` task. Run **Slipstream: Configure Native Chat Policy** to select a
workspace folder, mode, optional reported-token threshold, permitted compression
profiles, and designated test/build commands. Confirming saves only
`slipstream.nativeChatPolicy` at workspace-folder scope. Cancelling leaves it
unchanged; concurrent edits, persistence failures, and changed workspace trust
are reported rather than silently overwritten.

The setting defaults to `{ "version": 1, "mode": "off" }`. **Observe** captures
approved designated check results and shows native status. **Guard** additionally
adjusts compression inside each native conversation and can stop processing at
supported hooks after recorded usage reaches the threshold. It does not change
the model picker, `slipstream.costPolicy`, the saved profile, telemetry consent,
or command approvals. Select **Auto** in Copilot's picker for Copilot-managed
model selection; native policy does not implement its own model routing.

For example, a native observation policy for commands run in the workspace root:

```json
{
	"slipstream.nativeChatPolicy": {
		"version": 1,
		"mode": "observe",
		"tokenLimit": 20000,
		"compressionProfiles": ["conservative", "balanced", "aggressive"],
		"checks": [
			{ "kind": "test", "command": "npm", "args": ["test"], "cwd": "." },
			{ "kind": "build", "command": "npm", "args": ["run", "build"], "cwd": "." }
		]
	}
}
```

No preliminary task or additional verification click is needed. A configured
check is matched by exact executable, argument array, and resolved working
directory when it runs through the extension-contributed `slipstream_runCommand`
tool. It still uses the ordinary command approval, allowlist, timeout, path, and
cancellation controls. Successful process completion with exit code zero records
a passing check; nonzero is failing, while timeout, cancellation, and execution
errors remain incomplete. Ordinary commands, arbitrary terminal output, and
`Stop` events never become passing checks. Nothing is rerun to collect evidence.

The native hooks supply session and tool-invocation IDs. A short-lived, single-use
context binds those IDs to the actual tool input, workspace, and policy revision.
Expired, replayed, or changed contexts cannot execute a guarded tool. Missing
host identity remains unattributed; it is not guessed from timestamps or the
last observed model. Check metadata contains IDs, a command fingerprint, check
kind, result, exit code, and duration, not raw arguments or output. Native checks
do not qualify models for the owned-task selection rule.

Usage is the sum of available input/output counts for exact matching native
conversation IDs, with duplicate spans removed and cached input counted only
as part of input. Unknown and partial usage remain distinct from zero. It is
reported history, not a reservation before every model request: reports can be
late or missing, and only retained observations are available. **This is not a
provider billing cap, daily quota, or complete model-request interceptor.** A
zero threshold deliberately pauses Guard mode before any reported usage.

Guard prefers balanced compression at 50% recorded-token pressure and aggressive
at 80%, within the permitted profiles. Retrieval backs off to the least aggressive
permitted profile; repeated failed retrievals can pause processing. Native
conversation engines are separate and never mutate the saved profile. Retrieval
and savings/status tools remain permitted at tool boundaries after a pause.
Review or change the native policy to continue; there is no automatic command
replay or stop-hook repair loop.

Native status appears in hook messages and the contextual `#hrStats` result.
These hooks require a supporting VS Code host, Node.js 20+, enabled
`slipstream.chatHooks`, and enabled hook discovery/organization policy. The
generated hook adds `SessionStart`, `PreToolUse`, and `Stop` only after native
policy opt-in. Default-off hooks remain activity-only. Built-in tool output is
not replaced, and CLI/MCP-only tools do not gain this invocation context.

## Cost Policy

The versioned policy covers advisory checks, owned-task accounting, and opt-in
automatic controls on the `@slipstream` request path. Under this owned-request
contract, native Copilot and external tools remain advisory; Slipstream does not
own their model requests. The separate native policy above operates at hooks
and Slipstream tool boundaries, not at the native model-send boundary.
The `slipstream.costPolicy` VS Code setting defaults to
`{ "version": 1, "mode": "off" }`. Existing compression, model selection, command
approvals, and telemetry consent are unchanged.

Use **Cost policy > Workspace policy** to configure the policy without editing
JSON. This dashboard tab also contains capability checks and owned-task accounting.

1. Choose **Off**, **Recommend only**, or **Automatic (@slipstream)**.
2. Enter a task budget and choose **Tokens** or **Reference USD**. A budget is
	required for automatic requests and optional for advisory accounting.
	A blank budget means not configured; zero is valid. Token budgets require
	whole numbers, while reference-USD budgets may be fractional.
3. Keep **Model choice** at **Keep picker model** to pin the selected model, or
	explicitly choose **Policy chooses** to allow qualified alternatives. The
	**Output allowance (tokens)** defaults to 2048 per automatic call.
4. Expand **Permitted models and profiles** and select models from the searchable
	VS Code model list, then choose permitted compression profiles. Model names,
	vendors, exact IDs, and existing access status are shown; exact IDs are saved
	automatically. Discovery and refresh do not send model requests or grant access.
	Saved models that are temporarily unavailable remain selected until removed.
	Automatic requests require at least one
	permitted model, including the current picker model. These settings do not
	change the native model picker or the saved compression profile.
5. Select **Apply** to persist the policy in this workspace's VS Code settings.
	New tasks use the new policy. An automatic task already in progress pauses at
	its next control check if policy, trust, or workspace roots change; it does not
	continue under stale permissions. **Off** preserves historical records.

Drafts are not saved automatically and survive live dashboard updates and tab
changes. The **Reload saved policy** control discards a draft and restores saved values. If
the policy changes elsewhere, reload before applying instead of overwriting
another edit. Failed saves remain visible and retain the draft.

The editor requires an open, trusted VS Code workspace and a host save handler;
other dashboards show read-only settings. Writes target the workspace, not user
settings. Applying a policy does not authorize test commands, change telemetry
consent, or submit a model request. Start an owned task explicitly after applying.

An example workspace setting for advisory checks:

```json
{
	"slipstream.costPolicy": {
		"version": 1,
		"mode": "recommend-only",
		"allowedModels": [],
		"allowedCompressionProfiles": ["conservative", "balanced"],
		"budgetUnit": "tokens",
		"taskBudget": 4000
	}
}
```

Modes are `off`, `recommend-only`, and `automatic-owned-request`. Automatic mode
requires the equipped owned-chat adapter; unsupported hosts still resolve to
**recommend only**. Recommend-only records checks and accounting without routing
or enforcing an allowlist. Budget units are `tokens` and `reference-usd`; reference
USD is not a Copilot subscription bill. An optional `taskBudget` applies to each
new owned task, not a shared workspace balance. Token budgets must be nonnegative
safe integers; reference-USD budgets may be fractional. Zero is valid. The policy
assessment does not itself measure usage; task accounting reports coverage
separately, and estimates never become measured spend.

Allowed models use exact `{ "vendor": "...", "id": "..." }` identities, not display
names or inferred aliases. An empty list pauses automatic requests. Permitted
profiles constrain task-local automatic choices, not saved compression settings.
Removing the setting restores off. Unknown fields,
versions, modes, units, invalid model identities, and invalid profile lists are
rejected. A malformed VS Code value triggers one warning per invalid period and
uses off without rewriting the setting or disabling existing compression.

An optional `compressionFeedback` block enables the bounded outcome-driven loop
described under [Bounded Compression Feedback](#bounded-compression-feedback).
It is off by default, has no editor control yet, and is edited in JSON; applying
a policy from the editor preserves an existing block rather than dropping or
re-enabling it. The capability report lists it separately from the always-present
pressure guard, so an enabled-but-unequipped host is never shown as adapting.

The **Cost policy** tab's capability report shows requested/effective mode, host,
scope, unit, coverage, and each prospective action's capability, status, and reason. Native
Copilot and external-tool hosts do not own model requests. The owned Slipstream
chat path has explicit automatic executors. The workspace dashboard still shows
its native-host limitations; actual owned decisions appear with each task. A
blocked pin prevents substitution; incompatible automatic requests pause before
sending. Advisory decisions do not restrict native requests. The report is
read-only. The settings editor uses a dedicated validated policy save path;
generic dashboard runtime-config endpoints still reject policy writes.

Embedding hosts can pass validated `config.costPolicy` and a `policyContext` to
`CompressionEngine`. A task-scoped `taskPolicy` can narrow workspace permissions,
but cannot opt in an off workspace, widen model/profile sets, or raise an existing
workspace task budget. Conflicting task/workspace budget units block the budget
decision. Host-supplied
`constraints` intersect with those sets and can prohibit automation. User-pinned
models are never substituted; conflicts are explicit. This interface does not
discover or distribute enterprise policies; existing host authorization remains
authoritative, and fleet management is HC-09.

### Automatic Owned Tasks

Use **Slipstream: Start Chat** in Ask mode. `/code`, `/triage`, and `/summarize`
give an explicit task category, for example `@slipstream /code ...`. A request
without a category can use guards and task-local compression, but cannot justify
an automatic model switch. There is no classifier model call.

Model choice is made once, before the first send, and held for that task. It uses
the host's actual available model objects and cached Models.dev tool-call support.
Input counting includes assembled messages and tool definitions. Non-text input
with unknown compatibility, missing counters, inadequate context, or a conflicting
pin pauses the request. Old caches without tool metadata require a catalog refresh.
No synchronous catalog download is added to model selection.

**Policy chooses** only switches when both the picker model and a cheaper allowed
alternative have at least three verified passes and no verified failures in their
latest 20 verified tasks for the same category and workspace, within 30 days.
The alternative must already be authorized by VS Code. Prices must include input
and output, be fresh, and come from the same catalog revision. Missing evidence,
incomparable prices, equal cost, or provider-specific request options retain the
eligible picker model; a disallowed or incompatible picker pauses instead. User
reports and model success claims never qualify a candidate. These checks are a
limited local qualification rule, not a general quality guarantee. Verification
commands remain explicitly user-approved.

Before every automatic call, admission reserves counted input plus 15% and 256
tokens of headroom, plus the configured output allowance (1-32768 tokens).
Reference-dollar admission uses fresh input/output rates, conservatively allowing
for a higher cache-write rate. Missing rates are not replaced by the savings
fallback. Reservations are synchronous and atomic within the task, and are
flushed to disk before an actual send; write failures stop admission. Failed sends retain their allowance; complete
reports above it increase the amount consumed, while smaller reports do not
replenish this conservative local budget.

Responses are counted during streaming and cancelled at the local output cutoff.
This is **not** a portable provider-enforced output cap: VS Code exposes neither
complete billed usage nor a guaranteed output-limit option. Provider overhead,
reasoning, retries, buffering, and unreported output can exceed local estimates.
An unaffordable next call pauses instead of silently continuing. Paused tasks do
not auto-resume or replay commands. **Slipstream: Resume Task** opens an unsent
draft; select the recorded model and enter a next step, then submit
`@slipstream /resume <task-id> <next step>`. This restores the same task ID, session,
category, immutable call rates, consumed allowance, and recovery backoff. The
original policy revision, budget, and workspace must still match. Changing the
policy does not top up an existing task. An ordinary new request still starts a
new task allowance, not a daily spending cap.

Resume starts a fresh tool loop using only the new instructions and attachments.
It does not restore prompts from disk, replay conversation/tool history, rerun
an in-flight request, or reuse a previous command approval. Abandoned model calls
are marked interrupted and keep their full reservations. Exact late reports can
fill missing fields once without repricing old calls or refunding allowances.
Recovery failures cannot be reset by resuming. Verification is bound to the
selected resume count and completion time, so an older check cannot qualify a
newer run of the task.

Exclusive process-owned locks prevent simultaneous resumes. A live or uncertain
owner blocks resume; only a proven exited process can be reclaimed. Rotation is
postponed while these locks exist to preserve active accounting through a crash.
Resume requires complete retained records from a newly created guarded task;
cleared, rotated-out, incomplete, legacy, finished, or already-reviewed tasks are
not resumable. Failed, cancelled, paused, and interrupted active tasks can resume
when eligible. No automatic request or tool action is triggered on host restart.

Compression uses only permitted profiles in the task-local engine. At 50% budget
or context pressure it prefers balanced, and at 80% it prefers aggressive by
default. **Balanced pressure (%)** and **Aggressive pressure (%)** configure this
pair in the policy editor, with explicit Apply. The optional JSON field is
`pressureThresholds: { "balanced": 0.5, "aggressive": 0.8 }`, requiring
`0 <= balanced < aggressive <= 1`. Omission preserves existing defaults and saved
policy revisions. Task overrides may lower, but never postpone, workspace
thresholds. The native chat policy is separate and unchanged.
Artifact recovery backs off to the least aggressive permitted
profile for the rest of the task; repeated failed recoveries pause further calls.
Existing diagnostic preservation and retrieval remain available. The parent
engine and saved profile are never changed.

### Bounded Compression Feedback

Pressure feedback reacts to the call about to be sent. A second, separate loop
reacts to **past verified outcomes**: it adapts the permitted profile using the
verified result, net token benefit, retrieval rate, recovery failures, and
Slipstream overhead of earlier owned tasks in the same workspace and category.

It is off by default. The versioned JSON field is
`compressionFeedback: { "version": 1, "enabled": true }`, with optional
`minSamples` (default 5 verified tasks), `maxRetrievalRate` (0.2 retrievals per
compression sample), `maxOverheadMs` (250 ms per sample), `minNetBenefitRatio`
(0.2), `hysteresis` (0.05), `cooldownMs` (1 hour) and `trialTasks` (5). Setting
`enabled` to false is a kill switch that restores static behavior; task policies
and managed constraints may only tighten these limits, never loosen them.

Evidence comes only from owned tasks that ended with verified command evidence,
stayed on a single compression profile, and used a single model, in this
workspace and category, within the last 30 days and the latest 20 tasks per
profile. Activity that cannot be attributed to one task, one profile, and one
model never drives adaptation, and a compression trial never changes the model,
so a result is not credited to the wrong change. Net benefit is the raw tool
output minus the forwarded output, minus tokens returned by retrievals and
tokens spent on reported retries.

A verified failure, a retrieval rate or overhead above the configured limit, a
recovery failure, or a negative net benefit reduces compression by one permitted
step. Sustained verified benefit above `minNetBenefitRatio + hysteresis`, with
enough samples, opens a **bounded trial** of the next permitted profile; the
trial is confirmed only after `trialTasks` verified tasks still satisfy every
guardrail, and is otherwise rolled back to its baseline. Each change starts a
cooldown that doubles for every earlier rollback of the same profile, so noisy
data cannot oscillate. Sparse or unverified data can never increase compression,
and a recovery failure immediately restores the safest permitted profile.

The pressure guard still wins whenever it asks for more compression than the
current profile, so a quality signal cannot exceed the headroom of the call being
sent. Every decision appends an append-only `compression-feedback` task event
with its action, fixed reason, chosen profile, trial state, and the numeric
signal behind it — counts, ratios and milliseconds only, never prompts, tool
content, or generated responses. Earlier records, savings history, and saved user
profiles are left unchanged. This loop bounds and explains profile changes; it is
not evidence of a cost-per-successful-task improvement, which remains HC-08 work.

The owned-task table separates reported balances from **Local guardrails**, the
remaining local allowance, selected model/profile, fixed pause reason, resume
count, and interrupted calls.
Requested and selected model identities are retained separately in metadata.
The stable response API supplies no separate reported response-model identity;
none is inferred from native telemetry. No raw prompts, tool arguments, command
output, or generated responses are stored in these decisions.

Policy changes and opted-in owned chat requests append `session:cost-policy`
events containing a schema version, deterministic policy revision, scope,
capabilities, fixed decision reasons, and coverage. These records contain no
prompt, tool content, credential, or model allowlist. They add zero tokens and no
price. Reading a report adds no events, and policy rollback leaves earlier
audits and all historical pricing and savings unchanged.

## Model Recommendations

The **Cost policy > Model recommendations** panel previews the deterministic
selection rules against the saved `slipstream.costPolicy`. It works in
Recommend-only mode without a task budget or an automatic executor. The separate
native Observe/Guard setting does not configure model eligibility.

Comparison inputs are an explicit task category (`code`, `triage`, or
`summarize`), a baseline from the saved permitted-model list, and nonnegative
estimated input tokens plus 1-32768 estimated output tokens. Input counts are
user estimates, not tokenizer measurements. The baseline is not inferred from
the last observed model or the native picker. **Hold baseline** prevents an
alternative suggestion for that preview. Existing execution settings, host pins,
workspace constraints, and the real model picker are not changed or bypassed.

The VS Code adapter discovers model metadata and includes only permitted models
whose request authorization is already known to be granted. It makes no model
request, triggers no new authorization, and performs no synchronous price refresh.
The panel is unavailable without a supported, open, trusted VS Code host.

Each permitted candidate has explicit availability, context capacity, tool
support, quality evidence, reference estimate, and eligibility gaps. A lower-cost
suggestion requires compatible capabilities and fresh input/output prices from
the same catalog revision and fetch. Both baseline and alternative need at least
three verified passes and zero verified failures in the latest 20 verified tasks
for the same workspace/category within 30 days. These are conservative local
qualification rules, not a guarantee of future quality. Native checks, model
observations, user reports, and unverified tasks do not supply qualifying evidence.

Reference estimates use the existing input headroom (15% plus 256 tokens) and the
supplied output estimate, with cached public API rates. Unknown prices are not
zero; the savings fallback rate is never used for ranking. This preview neither
enforces a budget nor reports measured usage, savings, or subscription charges.

Comparisons use a revision-checked read-only HTTP/webview route, not the policy
save API. Inputs remain in the page, not settings or the ledger. Changed inputs,
saved policy, price snapshots, evidence, or host access invalidate the displayed
result, and late responses cannot restore it. Ordinary traffic and refresh-start
events do not discard an otherwise current comparison. Policy drafts survive.

### Local Rule Benchmark

Run `npm run build --workspace=@slipstream/core` followed by
`npm run benchmark:recommendations`. The existing benchmark script exits before
running its compression demo and emits JSON with hardware, Node/OS versions,
sample counts, p50/p95/p99, exclusions, and the 5 ms p95 gate.

Measured on 2026-09-14 with Node 24.14.1, Windows x64 build 10.0.26200, and
Intel Xeon Platinum 8370C at 2.80 GHz: 200 warmups and 2000 samples per scenario.
The 64-qualified-model case measured p95 0.0951 ms; the 64-model mixed-gap case
0.1097 ms; the empty policy 0.0014 ms. These are fixture-based local-rule timings.
Host discovery, input estimation, evidence aggregation, price snapshot assembly,
network, and model execution are excluded. The panel reports host discovery and
rule evaluation separately. Broad model-quality and cost-per-success evaluation
remain outstanding; these timings do not establish either claim.

## Owned Task Accounting

With cost policy enabled, each `@slipstream` request starts a new owned task.
Conversation IDs can persist across turns, but task IDs do not. Every model send
gets a generated call ID and the selected model's immutable pricing snapshot.
Policy off preserves existing behavior without task records or added counters.

**Cost policy > Owned tasks** shows the latest 25 tasks across producers, including
completed, failed, cancelled, and paused requests. Reported tokens, payload estimates,
public API reference cost, budget, provisional allowances, and remaining balance
are separate columns. Partial reports show only the known portion. An unknown
amount is not zero. Reported balances are separate from automatic local admission
allowances and are not guaranteed billing caps.

The stable VS Code `LanguageModelChatResponse` API provides response streams but
no reported usage counters or reliable telemetry join key. Slipstream therefore
uses the selected model's `countTokens` API for input payload estimates in
Recommend-only, and input plus successfully completed streamed output estimates
in Automatic mode. Interrupted or uncounted output remains partial/unknown.
These estimates exclude provider overhead and never reduce a measured budget
balance. Failed counters remain unknown. No
prompts, response text, or tool contents are added to accounting records, and no
native observation is assigned to an owned call by timing or model identity.

Embedding adapters with actual usage can use `OwnedTaskUsage.startCall` and
`reportUsage` with that exact call ID. Reports may fill missing fields but cannot
silently replace conflicting counts. Duplicate reports and repeated observation
identities are counted once; optional external observation IDs are hashed before
storage. `finishCall` and `finish` record lifecycle state, not zero usage. A late
report can reconcile an allowance after the call has finished or been cancelled.

Token spend is input plus output across model calls. Reported cache reads and
cache creation are subsets of input, never additional input tokens. Reference
cost uses uncached input, cache reads, cache creation, and output at their
respective recorded rates. Missing positive-use rates or token counts leave the
total partial or unavailable; explicit zero tokens need no rate. Invalid,
conflicting, and inconsistent counts are rejected. Each call keeps its original
rates even if the catalog or selected model later changes.

Retrieved tool content is counted when included in model input, not charged
again from the retrieval ledger. Tool-output savings are unchanged. Provisionalallowances are separate from reported usage and stay unresolved until sufficient
usage and, for reference USD, rates are available. Automatic admission maintains
a separate conservative allowance balance; reconstruction preserves those
reservations and decisions without treating them as measured spend.
The dashboard's fallback savings rate is never a model-spend rate or a bound.

An instrumented owned task also records its own compression evidence: one
metadata-only sample per compressed tool output, carrying the active profile,
tokens before and after, and Slipstream's processing time, plus the tokens and
time returned by each retrieval. Reported retries contribute their own token
totals. These are per-task compression counters for the feedback loop, not model
spend: they are never added to reported usage, reference cost, or the local
allowance balance, and they are only recorded by an engine scoped to that task.

## Task Outcomes

Request completion is not verified success. HC-03 keeps the task's lifecycle
state separate from its latest outcome: **verified pass**, **verified fail**,
**user-reported**, **cancelled**, or **unverified**. A model's success claim, a
successful ordinary tool command, low retrieval rates, or exact artifact recovery
does not automatically verify the task.

To record an outcome in a trusted workspace:

1. Set **Cost policy > Workspace policy > Mode** to **Recommend only** and
	select **Apply** (see [cost policy](#cost-policy)), then run a task through
	**Slipstream: Start Chat** (`@slipstream`). Ordinary Copilot Agent requests are
	not owned tasks.
2. Select **Verify task outcome** on the response, or run
	**Slipstream: Verify Task Outcome** and choose a completed task. Failed and
	cancelled requests are also selectable from the command palette.
3. Choose a test, build, or custom command check. Enter its working directory and
	a JSON argument array, for example `["npm", "test"]`. Review and approve the
	exact command. No check is run merely by viewing the dashboard or finishing
	a chat request.
4. Alternatively, choose **Report successful** or **Report unsuccessful** and
	confirm your assessment. This is always labelled user-reported, not verified.

An approved check uses its actual exit code: zero passes and nonzero fails.
Timeouts, interrupted execution, and startup errors remain unverified or
cancelled, even if output says "success". This verifies the user-chosen check
against the workspace at execution time; it does not prove every requirement or
reconstruct the workspace's state when the original task ended. Checks preserve
the existing command allowlist, workspace-root restrictions, configured timeout,
and cancellation controls. Verification itself triggers no automatic repair loop,
model call, or model switch.

**Cost policy > Owned tasks** shows outcome evidence beside usage and budgets. Expand
**Evidence** for its source, check type, exit code, duration, timestamp, fingerprint,
and verification-attempt count. Counts above the table cover all recorded tasks,
not just the latest 25 rows. They use the latest recorded outcome per task and
never count a user report or an unknown outcome as a verified pass. A later check
or report appends evidence; earlier records, rates, and savings are unchanged.

Task duration measures request start to end, independently of later verification
duration. Retrieval and recovery-failure counters cover the instrumented owned
retrieval tool only. Model rounds are not retries: the VS Code API does not report
provider-internal retries, so that counter remains unknown. Embedding adapters
with complete retry instrumentation can opt into `retryTracking` and supply an
exact failed/cancelled `retryOfCallId` when starting the retry. Verification
attempts are shown separately from model retries.

Outcome records contain metadata only, never prompts, command text, arguments,
output, or source code. Workspace roots and approved commands are fingerprinted.
The VS Code verifier selects only ended tasks with a matching recorded workspace
identity and no pending model calls. Older tasks without that identity remain
unverified in this workflow; native history is never joined by time or model.
Removing the policy setting stops new task accounting without deleting history.

## Detection Limits

VS Code exposes `ChatRequest.model` only to the participant handling a request.
Ordinary native Copilot tools, MCP calls, and observation hooks do not expose it.
The local telemetry connection instead observes completed `chat` spans with
`gen_ai.request.model`, `gen_ai.response.model`, conversation IDs, trace/span IDs,
timing, and available token usage. The response model takes precedence, including
resolved Auto requests. Models appear after export, not when the idle model picker
changes. If no chat model has been observed yet, the dashboard waits rather than
guessing from helper traffic. Delayed spans cannot overwrite a newer chat
observation; retried spans do not create duplicate ledger entries. A subsequent
chat-associated call can update the cached model, including after a model change.

Native tool invocations do not expose `ChatRequest.model`. Instead, validated
native context retains the full tool-call identity on each Slipstream output.
For attribution, the receiver extracts only tool-call IDs and names from complete,
valid `gen_ai.output.messages` assistant responses. A unique response reference
must match a successful `execute_tool` span by tool name, raw call ID, trace,
parent span, source, and session. The output must occur within that execution;
timestamps alone never establish a match. Only the known numeric VS Code ID suffix
is removed for comparison; the original identity stays in the ledger.

Matched savings use the **calling model request's recorded standard input rate**.
This is a reference valuation, not proof of the model that later consumed the
output, cache savings, or Copilot charges. Another turn's rate, the agent's initial
model, and the current catalog are not substitutes. Existing priced event
snapshots remain authoritative, including explicit zero rates.

Missing or truncated response metadata, absent rates, reused or ambiguous IDs,
failed tool executions, and unsupported producer paths remain on fallback.
Contradictory retries append a metadata-only conflict marker and invalidate the
trace's derived attribution without duplicating model usage. Exact duplicate
exports do not add records. Model, tool, and conflict observations are zero-savings
session events, not additional compressions or billable token deltas. Managed MCP
and CLI outputs without the complete identity chain remain unmatched.

Model matching is exact. Known Copilot aliases map to exact original-provider
catalog IDs; an ambiguous match, an unknown ID, or an unresolved Auto selection
has no model-specific rate. There is no fuzzy model-family match or substitution
of a previous model. Unknown model rates appear as unavailable, not zero; saved
dollar totals still include the separately identified default-rate estimate.
The chat helper does not support the selected Copilot o1 family without changing
models, so Slipstream reports that limitation instead of silently substituting.

## Local Telemetry Consent

**Privacy warning:** Copilot exports can contain user messages, code, tool
arguments/results, and hook input/output even with `captureContent: false`.
Consent explicitly covers receiving this material locally. Slipstream discards
content in memory before logging or storage and retains only the allowlisted
model, correlation, timing, and token-count fields, including tool-call IDs and
names but not message text or tool arguments. Telemetry is never forwarded;
raw exports are not written to a file. The local ledger retains correlation IDs.
Dashboard payloads and Markdown, CSV, and JSON reports omit those trace, span,
conversation, and tool-call IDs; telemetry producer groups use hashed identifiers.

The receiver binds only to `127.0.0.1`, requires a randomly generated local bearer
credential, rejects browser-origin requests, and bounds request size, duration,
connections, and processed spans. The credential is stored in VS Code secret
storage and in Copilot's exporter headers in profile settings, never in the
ledger or dashboard. It is not a GitHub credential. Content capture stays off,
content attributes are limited to 256 characters upstream, and log/metric export
bodies are discarded. These limits reduce exposure; they do not make the inbound
payload metadata-only. The attribute limit is not increased for attribution:
truncated response lists stay unmatched rather than being partially recovered.

Consent changes `github.copilot.chat.otel.*` in the current VS Code profile,
including its other local windows. Existing custom exporters, environment
overrides, workspace overrides, and exposed managed settings are left untouched;
effective values are also checked during setup. Settings changes pause tracking
instead of being overwritten. Copilot's internal `os.devNull` exporter placeholder
(`NUL` on Windows) is not treated as a custom destination. After consent, Copilot
may copy the configured local connection into the extension host's environment;
only exact matches to the owned endpoint and privacy settings are accepted.
Slipstream never changes environment variables. Other conflicting overrides
remain blocked, with their variable names, not values, shown in the status.
Remote extension hosts and the separate
`chat.agentHost.otel.*` pipeline are not supported by this connection.

Use **Disconnect** in the extension dashboard or **Slipstream: Disconnect Local
Model Tracking** to stop observation and restore only settings still owned by
Slipstream. Later user edits and unrelated headers survive. Declining consent or
disconnecting prevents repeated automatic prompts. Existing observations remain
in the ledger. Disconnect before uninstalling to restore Copilot settings.

Reload VS Code after connecting or disconnecting so already-running Copilot
exporters pick up the change. Reload other open local windows using that profile
as well. Slipstream offers a reload button but does not reload without approval.
Local windows share the receiver, with takeover when its owning window closes;
different Slipstream storage directories are not silently combined.

See the [Copilot monitoring documentation](https://github.com/microsoft/vscode/blob/main/extensions/copilot/docs/monitoring/agent_monitoring.md)
for the upstream export contract and content-capture warning.

## Standalone CLI Model Tracking

A GitHub Copilot CLI install with no VS Code uses the same receiver, parser, and
metadata boundary. The difference is configuration: the CLI has no settings, so
Copilot reads its exporter configuration from environment variables at process
start rather than from `github.copilot.chat.otel.*`. Tracking is therefore an
explicit, printed opt-in instead of an automatic consent modal.

`slipstream model-tracking enable` records consent, ensures the receiver is
running inside the shared hook daemon, and reserves a local bearer credential.
`model-tracking env [bash|powershell]` prints the `COPILOT_OTEL_*` and standard
`OTEL_EXPORTER_OTLP_*` variables — content capture off, attribute cap 256, the
loopback endpoint, and the credential — to add to the shell that launches
`copilot`. Both variable families are emitted so whichever the running Copilot
build honours takes effect; the receiver only accepts exports carrying the
credential. `model-tracking status` shows the endpoint, `model-tracking disable`
removes consent and the credential (existing observations are kept), and
`slipstream doctor` reports the current state.

Consent and the credential are stored in a mode-0600 `model-tracking.json` in the
shared storage directory (VS Code's secret storage has no CLI equivalent); the
credential is a local receiver token, not a GitHub token. The daemon reuses the
persisted port across restarts so already-exported environments keep working. The
receiver lives with the daemon, which stops after an idle period and restarts on
the next tool call. Remote and agent-host telemetry pipelines are still out of
scope, and the [detection limits](#detection-limits) above apply unchanged: CLI
telemetry identifies the model but cannot be bound to a specific compression.

## Compression Opportunities

Observed input size, cache usage, model identity, and call duration make better
evaluation possible without retaining prompt content:

- Compare tokenizer estimates with reported request usage, allowing for all other
	prompt/context content. The difference is not automatically attributable to a
	compressor.
- Measure whether a compression policy preserves prompt-cache reuse rather than
	optimizing only the number of removed tokens.
- Evaluate model-specific compression presets and context-budget thresholds once
	exact request-to-tool correlation is available.
- Compare latency and retrieval overhead in controlled experiments; fewer tokens
	alone do not prove lower latency, cost, or unchanged answer quality.

This release exposes the measurements but does not change compression policies
automatically. Telemetry is observational: it cannot replace or transparently
compress native Copilot tool responses.

## Refresh and Privacy

Automatic pricing performs a background GET of `https://models.dev/api.json`. No
prompts, source code, identity, API keys, or selected model are transmitted.
Downloads use a five-second timeout, reject redirects, and are capped at 32 MiB
of decoded response data. Only text-input models with an explicit, finite,
nonnegative input price are eligible; known subscription surfaces such as GitHub
Copilot are excluded. Output and cache rates are retained as catalog metadata,
but are not used to price tool-output savings.

The validated catalog is cached as `pricing-cache.json` beside the ledger.
Prices refresh after 24 hours while an automatic-pricing producer is running.
Failed refreshes retain the last valid data and its timestamp. Stale prices are
usable for at most seven days, then unavailable. Background failures back off
for an hour.

**Models > Price catalog** shows the source, eligible model count, cache age,
freshness (not cached, fresh, stale, or expired), and refresh status. Cache age
updates even when no new model calls arrive. The refresh icon starts an on-demand
fetch in both the browser dashboard and the VS Code webview, bypassing the fresh
cache check and background retry delay. Concurrent requests share one download;
the button is disabled while it is pending. Failures and shared-process lock
contention remain visible and can be retried. Refresh always uses the fixed
public catalog URL and never changes model-tracking consent or historical prices.

Processes share only the catalog cache, using a short refresh lock and atomic
replacement, not their detected model. Compression never waits for a download.
Cold-start events can therefore lack a recorded rate. Those events use the
fallback in totals, including after later catalog refreshes.

## Historical Accounting

Every new compression, passthrough, and retrieval event records an independent
pricing snapshot: detected request model, matched provider/model, effective input rate, source, fetch time,
catalog revision, stale status, and standard uncached-input assumption. A
retrieval uses the retrieving producer's current rate, not the original event's.
Refreshing prices affects future event snapshots only. Changing the default rate
changes the fallback estimate for missing-rate entries, without rewriting the ledger.

For a matched native tool event, the effective rate is a read-only projection of
the calling model observation's stored snapshot. Model and tool exports may arrive
out of order or after the output. Summaries resolve the full retained evidence
before grouping or filtering, including after restart. Original events, recorded
rates, and dashboard event selectors remain unchanged. If required evidence is
missing or no longer retained, the event remains unmatched and uses fallback.

- Gross saving estimate: signed removed tokens times each recorded input rate,
  or the configured fallback when that rate is missing.
- Retrieval estimate: returned retrieval tokens times its own recorded rate,
  or the fallback when missing.
- Net saving estimate: gross minus retrieval, including negative results.

Existing token counters, tokenization, compression decisions, baselines and the
synthetic benchmark are unchanged. No cache-hit, context-tier, discount, or
invoice behavior is inferred from tool output size.

Older ledger entries without snapshots keep their missing-rate provenance, but
contribute to the fallback estimate. Reports include recorded-rate coverage
(`complete`, `partial`, or `unpriced`), the recorded subtotal, fallback subtotal,
fallback rate, and model/basis groups. Zero-contribution events do not make
coverage incomplete. Missing snapshots are never backfilled after a refresh.

`SavingsSummary.estimatedCostSavedUsd` and dashboard totals include recorded plus
fallback amounts. `summary.cost.knownUsd` preserves the recorded-rate subtotal;
`fallbackUsd` and `fallbackUsdPerMillion` expose the estimated portion and default.
Coverage describes recorded rates, not whether a total estimate is available.
Markdown, CSV, and JSON use the same calculation. The existing nullable API types
remain compatible; direct `aggregateCost` callers that omit its optional fallback
rate retain strict `null` totals when any nonzero contribution has no recorded rate.

## Legacy Producers

Standalone MCP and CLI integrations retain the core manual/catalog API for
compatibility; they cannot infer the host's selected model. Their configuration
is separate from the VS Code participant and the standalone dashboard's local fallback.
`SLIPSTREAM_PRICING_MODE=automatic` ignores inherited model selections and input
overrides, but honors `SLIPSTREAM_USD_PER_MILLION` as the fallback (default 3).
Events without request model metadata retain unavailable model-rate snapshots.

Legacy `manual` mode defaults to $3 per million input tokens, configurable with
`SLIPSTREAM_USD_PER_MILLION`, and performs no pricing downloads. Legacy `catalog`
mode requires exact `SLIPSTREAM_PRICING_PROVIDER` and `SLIPSTREAM_PRICING_MODEL`
values. `SLIPSTREAM_PRICING_INPUT_OVERRIDE` accepts a nonnegative rate, including
zero; unset or empty restores the catalog rate. Catalog mode uses the same cache;
its unknown event rates use the default only in aggregate estimates.

Each CLI request carries its own pricing configuration to the shared daemon;
older requests without it retain the legacy manual default. Dashboard edits do
not configure unmanaged CLI or MCP producers. The dashboard's default rate is
persisted locally; saved reference-model selections are ignored. VS Code-managed
MCP servers receive the VS Code fallback setting. Retrieval keeps its own
event-time snapshot, with missing rates estimated using the active fallback.