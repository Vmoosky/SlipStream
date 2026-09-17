# Slipstream

Slipstream compresses noisy build, test, and file-read output before it reaches GitHub Copilot's context window. It keeps failures, stack traces, summaries, and changed source visible, while replacing low-signal repeated or passing output with reversible retrieval markers.

## Model-Aware Chat

Normal local Agent chat can now report models through an opt-in OpenTelemetry
connection, without switching to `@slipstream`. Slipstream automatically opens
the one-time consent prompt when Copilot is ready in a supported trusted
workspace, including when it becomes available after startup. No setup command
is needed; click **Allow** to approve. Previous declines and disconnects are
respected. Use **Dashboard > Model tracking > Connect**
or **Slipstream: Connect Local Model Tracking** to reopen the prompt. The main dashboard
shows connection status, last observed model, cached input rate, and reported
input/output/cache token counts. No GitHub token or additional login is needed.

**Privacy:** Copilot telemetry can include prompts, code, tool results, and hook
data even with content capture off. Slipstream receives it only on an authenticated
localhost endpoint and discards content in memory before logging or storage.
Only model identity, correlation IDs, timing, and token counts are retained;
raw telemetry is not forwarded or written to disk. The generated local exporter
credential is stored in VS Code secret storage and Copilot's profile settings.

Consent applies to this VS Code profile's local windows. Existing custom, managed,
workspace, or environment telemetry configuration is not replaced. Remote hosts
and the separate Agent Host pipeline are not supported. **Disconnect** restores
only settings still owned by Slipstream, keeps later user edits, and prevents
another automatic consent prompt. Disconnect before uninstalling. Reload VS Code
after either action, including other local windows using the same profile, so
running Copilot exporters adopt the new settings. Observations remain in history.

Run **Slipstream: Start Chat** to open Ask mode with `@slipstream` selected.
Alternatively, switch Chat to **Ask** and address `@slipstream`. Each request
uses the model selected in VS Code by default and detects its identity from `ChatRequest.model`.
Slipstream's tools return compressed output; command execution still requires
approval and respects workspace trust, path restrictions, and cancellation.
Other tools are available when explicitly attached to the request.

Input rates refresh and cache in the background. Price lookup remains
automatic. **Dashboard > Model tracking** shows the last detected model and rate.
**Est. saved** retains recorded prices and estimates missing rates using
`slipstream.usdPerMillionTokens`, default **$3 per million tokens**. The same value
is editable under **Dashboard settings > Runtime config > Fallback input rate**;
zero is allowed. Changing it updates only the fallback portion, without rewriting
event snapshots. Unknown model IDs and unresolved Auto selections do not acquire
a model-specific price from this default.
Dollar values estimate uncached public API usage, not actual Copilot bills.

Exact compression-event attribution still requires an owned `@slipstream`
request. Native tools and hooks do not supply the matching request identity;
their savings cannot inherit a model from the latest telemetry observation.
Telemetry usage is separate from savings and appears after completed model
calls, not idle picker changes. Before an observation or owned request, the
model panel shows **Not detected** and **Unavailable**, even with a healthy cache.
Saved-dollar estimates remain available using the configured fallback.

## Owned Cost Policy

**Cost policy > Workspace policy** offers Off, Recommend only, and
**Automatic (@slipstream)**. Automatic mode requires a task budget and at least
one permitted model. Select models from the searchable VS Code model list;
exact IDs are saved automatically. Discovery shows existing access status without
sending model requests or granting access, and retains unavailable saved models.
**Keep picker model** is the default; **Policy chooses**
explicitly allows qualified cheaper alternatives. The output allowance defaults
to 2048 tokens per call. Balanced/aggressive pressure defaults to 50%/80%; the
optional threshold pair must be ordered between 0% and 100%. Task overrides can
only lower workspace thresholds. Apply saves workspace settings without
submitting a task or changing telemetry consent.

Use `@slipstream /code`, `/triage`, or `/summarize` for an explicit task category.
Switching requires available, authorized, tool-capable models, enough context,
fresh comparable prices, and at least three verified passes with no verified
failures for both candidates in recent same-category workspace tasks. Without
that evidence, the eligible picker model stays selected. Verification remains
user-approved through **Slipstream: Verify Task Outcome**.

Automatic tasks use bounded task-local compression and pause new calls when
input/output allowances cannot fit or required coverage is missing. Artifact
recovery backs compression off; commands keep their approval checks and are not
replayed. The Owned tasks table shows local allowance and pause reasons separately
from reported usage. These guards are **not guaranteed provider billing caps**;
VS Code does not expose complete billed usage or a portable output-limit guarantee.
This owned policy does not control native Copilot, and the saved compression
profile is unchanged. Native chat has a separate opt-in policy below.

**Slipstream: Resume Task** opens an unsent draft. Select the task's recorded model
and submit `@slipstream /resume <task-id> <next step>` to continue with the original
workspace, policy, category, allowance, and recovery state. The fresh tool loop
does not replay prompts, model calls, tools, or prior approvals. Interrupted calls
keep their reservations. Exclusive process ownership prevents simultaneous
resumes; only a proven dead owner can be reclaimed after a crash. Resume requires
complete retained records from a guarded task; finished, reviewed, legacy, or
missing-history tasks are unavailable. Verification from an earlier run cannot
qualify a resumed task. Ordinary new requests still start a new task budget.

## Model Recommendations

**Cost policy > Model recommendations** compares models permitted by the saved
Cost Policy without changing that policy or Copilot's model picker. Choose a task
category and baseline model, enter input/output token estimates, and use the
comparison button. **Hold baseline** pins the advisory comparison; execution
settings and known host pins remain unchanged. No budget or automatic mode is
required. Native Observe configuration is independent of this preview.

The candidate table shows availability/authorization, context capacity, tool
support, verified quality evidence, and a one-call public API reference estimate.
Only already-authorized models and cached prices are used: comparison sends no
model request, requests no new consent, and writes no task or savings records.
Missing permitted models, stale prices, or insufficient evidence remain explicit
gaps. Native observations and native check results do not qualify a model.

Changing inputs, the saved policy, cached prices, or task evidence expires the
previous comparison. Unsaved policy drafts and comparison inputs remain separate.
Suggestions are advisory, not measured savings or Copilot billing reductions.

## Native Chat Activity

Native Agent chat activity is observed automatically in trusted workspaces when
Node.js 20+ and VS Code hooks are available. No enable command is required.
Slipstream manages `.github/hooks/slipstream-activity.json` and records prompt
and tool-event metadata, not their contents. These activity counts are separate
from compression savings; native tool output is not replaced.

Set `slipstream.chatHooks` to `false`, or use **Slipstream: Disable VS Code Chat
Hooks**, to persistently opt out. User-edited hook files are left unchanged.

## Native Chat Policy

Run **Slipstream: Configure Native Chat Policy** once in a trusted workspace.
Choose **Observe** for automatic check records and chat feedback, or **Guard**
to also adapt compression and stop at supported hook boundaries after the
conversation's reported-token threshold is reached. Setup asks for an optional
threshold, permitted profiles, and exact test/build commands, then confirms the
workspace-folder save. It does not run commands or change model selection.

Continue using ordinary Copilot Agent chat with Slipstream's tools enabled. No
`@slipstream` task, task category, or separate **Verify** action is required.
Choose **Auto** in Copilot's model picker when you want Copilot-managed routing;
Slipstream does not select or intercept that model.

When an approved, designated command runs through `#hrRun`, its actual result
is attached to the native conversation automatically. Chat hook messages and
`#hrStats` show check results, reported tokens, profile, and pause reasons.
Unrelated commands, tool-result text, and an agent stopping never imply success.
These are command checks, not owned-task quality evidence.

The `slipstream.nativeChatPolicy` setting defaults to **Off** and is independent
of `slipstream.costPolicy`. Native hooks must be supported and enabled on the
extension host. Unknown or late telemetry prevents a billing guarantee: **Guard
is not a spending cap**. Retrieval and status tools remain available at tool
boundaries. Compression only affects Slipstream tool output, not arbitrary
built-in results. Existing command approvals and the saved profile are preserved.

## Commands

- `Slipstream: Connect Local Model Tracking`
- `Slipstream: Disconnect Local Model Tracking`
- `Slipstream: Configure Native Chat Policy`
- `Slipstream: Start Chat`
- `Slipstream: Resume Task`
- `Slipstream: Verify Task Outcome`
- `Slipstream: Show Savings Dashboard`
- `Slipstream: Open Dashboard in Browser`
- `Slipstream: Copy Dashboard URL`
- `Slipstream: Toggle Compression`
- `Slipstream: Reset Session State`
- `Slipstream: Purge Stored Artifacts`

## Copilot tools

- `#hrRun` runs build, test, and lint commands with compressed output.
- `#hrRead` reads workspace files with lifecycle-aware unchanged and diff handling.
- `#hrGet` retrieves omitted content from a Slipstream marker.
- `#hrStats` reports session savings.

Nothing Slipstream removes is lost; omitted ranges are stored locally and can be retrieved by marker.

<!-- slipstream-reference:extension:start -->
## Commands And Settings Reference

Generated from the public manifests by `npm run docs:write`. Check with `npm run check:docs`.

| Command ID | Title |
| --- | --- |
| slipstream.connectModelTracking | Slipstream: Connect Local Model Tracking |
| slipstream.disconnectModelTracking | Slipstream: Disconnect Local Model Tracking |
| slipstream.startChat | Slipstream: Start Chat |
| slipstream.verifyTask | Slipstream: Verify Task Outcome |
| slipstream.resumeTask | Slipstream: Resume Task |
| slipstream.enableChatHooks | Slipstream: Enable VS Code Chat Hooks |
| slipstream.configureNativeChatPolicy | Slipstream: Configure Native Chat Policy |
| slipstream.disableChatHooks | Slipstream: Disable VS Code Chat Hooks |
| slipstream.runCommand | Slipstream: Run Command (compressed output) |
| slipstream.showDashboard | Slipstream: Show Savings Dashboard |
| slipstream.healthCheck | Slipstream: Run Health Check |
| slipstream.openDashboardInBrowser | Slipstream: Open Dashboard in Browser |
| slipstream.copyDashboardUrl | Slipstream: Copy Dashboard URL |
| slipstream.toggle | Slipstream: Toggle Compression |
| slipstream.resetSession | Slipstream: Reset Session State |
| slipstream.purgeArtifacts | Slipstream: Purge Stored Artifacts |

| Tool | Required Input | Input Fields |
| --- | --- | --- |
| slipstream_runCommand | command | command, args, cwd, timeoutSeconds, nativeContext |
| slipstream_readFile | path | path, nativeContext |
| slipstream_retrieveArtifact | id | id, startLine, endLine, grep, maxLines, nativeContext |
| slipstream_getSavings |  | nativeContext |

| Setting | Type | Default |
| --- | --- | --- |
| slipstream.profile | string | balanced |
| slipstream.nativeChatPolicy | object | {"version":1,"mode":"off"} |
| slipstream.costPolicy | object | {"version":1,"mode":"off"} |
| slipstream.enabled | boolean | true |
| slipstream.chatHooks | boolean | true |
| slipstream.compressLogs | boolean | true |
| slipstream.crossTurnDedup | boolean | true |
| slipstream.readLifecycle | boolean | true |
| slipstream.maxFileLines | number | 1200 |
| slipstream.usdPerMillionTokens | number | 3 |
| slipstream.artifactIdleTtlMinutes | number | 60 |
| slipstream.artifactMaxEntries | number | 2000 |
| slipstream.artifactMaxTotalMiB | number | 256 |
| slipstream.storageDir | string |  |
| slipstream.allowedCommands | array | [] |
| slipstream.commandTimeoutSeconds | number | 120 |
| slipstream.provideMcpServer | boolean | false |
| slipstream.dashboardServer | boolean | true |
| slipstream.dashboardPort | number | 7331 |

<!-- source-sha256: a5bb764fc239bf53f5ce0d85f0d6c4389e4edcf84bdc1b4596b4a487f7978883 -->
<!-- slipstream-reference:extension:end -->
