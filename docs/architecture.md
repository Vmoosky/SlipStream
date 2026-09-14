# Slipstream architecture

How the system is put together, what each part is responsible for, and how to
turn each piece on.

This is the implementation reference. For step-by-step install instructions see
the [README](../README.md); for the compressors themselves see
[compressors.md](compressors.md).

---

## 1. What the system actually does

Slipstream sits at the **tool-output boundary**. When a tool produces text that
would otherwise be pasted into the model's context window, Slipstream rewrites
that text to be smaller and hands back a pointer to the original.

```
tool runs  ->  raw output  ->  [Slipstream]  ->  smaller output  ->  model
                                    |
                                    +--> original bytes kept on disk
                                         (retrievable, byte-exact)
```

Everything else follows from where that boundary sits:

- It sees **tool output**, not prompts, not system messages, not images the user
  attached. Those never pass through it.
- It reports savings as `tokens(raw) - tokens(returned)`, measured at that
  boundary and nowhere else. The full Copilot request is not observable, and the
  ledger does not claim otherwise (`savingsLedger.ts:20-25`).

## 2. Invariants

Four rules constrain every design decision in the codebase. Most of the
surprising code exists to hold one of them.

**Nothing is lost.** Every omission emits a marker pointing at a line range of
stored content, and `retrieve_artifact` returns those bytes exactly
(`artifactStore.ts:54-59`). This is why lossy techniques — reformatting,
summarising, downscaling images — are rejected regardless of ratio.

**Compression must pay for itself.** A marker costs roughly 30-40 tokens. If a
plan does not beat the raw text by at least 10%, the engine discards the plan
and sends the original, recording it as `passthrough:not-worth-it`
(`engine.ts:136`, `engine.ts:928-945`). A "compression" that inflates the payload
is worse than doing nothing.

**Untrusted bytes never carry marker syntax.** File and command output is run
through `sanitizeUntrusted` before anything else, so content cannot forge a
marker and induce the model to request an artifact we never produced
(`markers.ts:64-73`).

**Telemetry must never break a tool call.** Ledger writes, eviction, and
observation recording are all wrapped so a failure is swallowed rather than
propagated (`savingsLedger.ts:56-59`).

## 3. Package map

```
packages/core            the engine. Everything below depends on this.
packages/extension       VS Code extension
packages/hook-runtime    Copilot CLI hook + local daemon
packages/copilot-plugin  packaged CLI plugin (bundles hook-runtime + mcp-server)
packages/mcp-server      stdio MCP server
```

`core` has no knowledge of its hosts. The three surfaces are thin adapters that
construct a `CompressionEngine` and feed it text, which is why their savings
numbers are directly comparable (`engine.ts:186-190`).

| Module | Responsibility |
| --- | --- |
| `engine.ts` | Orchestration. Owns the pipeline, the pay-for-itself rule, ledger writes. |
| `artifactStore.ts` | Content-addressed store of original bytes; retention and eviction. |
| `savingsLedger.ts` | Append-only JSONL record of every event; aggregation. |
| `contentRouter.ts` | Cheap content sniffing — picks which compressor family applies. |
| `compressors/` | The strategies themselves, plus the registry that orders them. |
| `markers.ts` | Marker rendering, parsing, and sanitisation of untrusted input. |
| `dashboard.ts` / `dashboardServer.ts` | Payload construction and the local HTTP server. |
| `modelTelemetry.ts` | OTLP receiver, observation parsing, source labelling. |
| `pricing*.ts`, `costPolicy.ts`, `taskUsage.ts` | Cost estimation and policy. |
| `ownedPolicy.ts`, `adaptiveCompression.ts` | Owned-task model/profile guards and the bounded outcome-driven compression feedback loop. |
| `health.ts` | The checks behind `doctor` and the VS Code health command. |
| `security/paths.ts` | Workspace-root enforcement for file reads. |

## 4. Lifecycle of one tool call

The path every compression takes, in `compressBlob` (`engine.ts:701-826`):

1. **Sanitise** — strip marker-shaped text from the untrusted payload.
2. **Normalise** — strip ANSI escapes. Done before routing so every downstream
   compressor sees clean lines. `tokensBefore` is measured on the *raw* text, so
   removing escape codes counts as a real saving rather than being hidden.
3. **Measure the baseline** — `tokensBefore` / `bytesBefore`. For command output
   the baseline includes the echoed command header, because a terminal would
   have printed it anyway; charging it to compression would make passthrough
   look like a loss.
4. **Route and plan** — the registry picks the first compressor whose `detect`
   matches and whose `compress` returns a plan (`compressorRegistry.ts:129-145`).
   A plan is a list of `kept` / `omitted` line ranges, plus optionally a
   rewritten `artifactText` that those ranges index into.
5. **Refine against the tokenizer** — compressors decide in *lines*, but markers
   cost *tokens*. `refineSegmentsByTokens` reverts any omitted run too cheap to
   pay for its own marker (`tokenBudget.ts:58`). Purely additive to fidelity.
6. **Store** — the artifact text is written and content-addressed. Identical
   content deduplicates to the same id (`artifactStore.ts:83-106`).
7. **Render** — kept ranges become verbatim text, omitted ranges become markers,
   and surviving lines are run through cross-turn dedup (`engine.ts:828-859`).
8. **Decide whether it paid** — if the result is not at least 10% smaller, throw
   it away and send the raw text instead (`engine.ts:928-945`).
9. **Record** — write a ledger entry including the markers *actually* present in
   the returned payload, and store the rendered output so the dashboard can show
   input and output side by side.

File reads take a parallel path (`compressFileRead`, `engine.ts:418-520`) that
adds read-lifecycle handling: an unchanged file is replaced by a one-line note,
a modified file by a unified diff — but only if the diff is smaller than 90% of
the file, since a wholesale rewrite produces a diff containing both versions
(`engine.ts:475`).

## 5. What lands on disk

One shared directory, `~/.slipstream` by default, overridable per surface
(`SLIPSTREAM_STORAGE_DIR` / `SLIPSTREAM_HOME` / the `storageDir` setting). Every
producer writes to the same place, which is what makes the dashboard a single
view across VS Code and the CLI.

```
~/.slipstream/
  artifacts/            original bytes, one file per artifact id (mode 0600)
  index.json            artifact metadata: label, kind, size, access times
  savings.jsonl         append-only ledger, rotated at 5 MiB
  savings.jsonl.1       previous ledger generation, included in dashboard totals
  dedup-index.json      cross-session dedup seeds
  baseline.json         comparison baseline
  pricing-cache.json    cached model pricing catalogue
  model-tracking.json   CLI consent + receiver port + token (mode 0600)
  update-check.json     last update check
  native-contexts/      single-use handoff tokens for VS Code native hooks
```

Retention is enforced on every write: idle TTL (60 min), max entries (2000), and
max total bytes (256 MiB) (`engine.ts:101-126`, `artifactStore.ts:268`). Evicted
ids are reported so the dashboard can mark their markers expired rather than
silently losing them.

Two consequences worth knowing:

- **Artifacts expire.** A marker older than the TTL cannot be expanded; the
  engine returns an explanatory error telling the model to re-run the command
  (`engine.ts:535-540`).
- **The ledger rotates at 5 MiB**, retaining one previous generation. Dashboard
  totals and history read both files, including after restart; rollover no longer
  hides the archived savings. Older generations are still discarded, so these
  are retained-history totals, not permanent all-time counters. Clearing the
  ledger removes both files. Active owned-task locks defer rotation.

## 6. Delivery surfaces and how to activate them

All three build the same engine. They differ in how they intercept output and
whether they capture model telemetry.

| | Interception | Engine lifetime | Model telemetry |
| --- | --- | --- | --- |
| VS Code | `vscode.lm` tools | one root + per-request children | yes |
| Copilot CLI | `postToolUse` hook rewrites the result | per-session, in the daemon | yes, opt-in |
| MCP server | MCP tools over stdio | one per process | no |

### 6.1 VS Code extension

**Activate:** install the VSIX (`npm run package:extension`). Activation events
are `onStartupFinished` and `onUri`, so it comes up with the window.

`activate()` (`extension.ts:33-190`) constructs the root engine, then registers
in order: language-model tools, the chat participant, model tracking, the status
bar, the MCP provider, chat hooks, and the dashboard server.

There are four interception paths, and all are live — they serve different
hosts:

- **Language-model tools** (`tools.ts:250-257`) — the everyday path.
  `slipstream_runCommand`, `slipstream_readFile`, `slipstream_retrieveArtifact`,
  `slipstream_getSavings`, all referenceable in prompts. Compression happens
  in-process.
- **`@slipstream` chat participant** (`chatParticipant.ts:239-240`) — the
  opt-in *owned-task* path. Builds a fresh per-request engine with
  `host: 'owned-chat'`, meters tokens against a policy, and caps at 40 tool calls
  / 20 model rounds. This is the only path that can enforce a cost policy,
  because it is the only one that owns the request.
- **Native chat hooks** (`chatHooks.ts:14-32`) — writes a managed
  `.github/hooks/slipstream-activity.json` so ordinary Copilot Agent chat can be
  observed. Default policy is `off`, recording metadata only. Note it does
  **not** compress native tool output.
- **MCP provider** (`extension.ts:454-489`) — off by default
  (`provideMcpServer: false`), because the contributed tools already cover it and
  running both would duplicate every tool.

Routing is the practical constraint: the extension only sees traffic that goes
through its tools, which is why the workspace ships
`.github/copilot-instructions.md` telling the agent to prefer them.

### 6.2 Copilot CLI plugin

**Activate:**

```bash
npm run install:copilot-plugin            # compression only
npm run install:copilot-plugin:tracking   # and enable model tracking
```

Installation goes through a *local marketplace* rather than a directory install,
because Copilot CLI 1.0.x will not accept a local path in `plugin install`
(`scripts/registerCopilotCli.mjs:5-8`).

The plugin registers three hooks (`copilot-plugin/hooks.json`):

| Event | Timeout | What it does |
| --- | --- | --- |
| `userPromptSubmitted` | 5 s | records a chat event; warms the daemon |
| `postToolUse` | 30 s | compresses and **rewrites** the tool result |
| `sessionEnd` | 5 s | releases that session's engine |

`postToolUse` returns `{ modifiedResult: { textResultForLlm } }` to replace the
tool's output (`hook.ts:29-45`). On any failure the hook writes `{}` so the
original result passes through untouched.

It also ships a **retrieval-only** MCP server (`.mcp.json`) exposing just
`retrieve_artifact` and `get_savings` — the hook already does the compressing, so
re-exposing `run_command` and `read_file` would double up.

#### The daemon

Hooks are separate short-lived processes, so state would die between calls. A
daemon holds the per-session engines, which is what makes cross-turn dedup and
read-lifecycle tracking work across a CLI session, and it hosts the telemetry
receiver.

- **Transport:** newline-delimited JSON over a named pipe
  (`\\.\pipe\slipstream-hook-<owner>`) or a unix socket, keyed by a hash of the
  home directory (`daemon.ts:74-80`).
- **Startup:** the hook client tries to connect; on failure it spawns a detached
  daemon and polls for up to 3.5 s (`index.ts:80-105`).
- **Ordering matters:** the daemon binds the telemetry receiver *before* it
  accepts on the pipe. Doing it the other way round let the first hook return
  before the receiver existed, so a cold session's opening model calls were
  exported to an unbound port and lost (`daemon.ts:175-189`).
- **Lifetime:** idle timeout is 10 minutes. The receiver is `unref`'d and never
  holds the daemon open. It restarts on the next tool call and rebinds the same
  port.

> **Known sharp edge.** If that port is taken at restart, the daemon falls back
> to an ephemeral one and persists it. Shell variables exported from a previous
> `model-tracking env` then point at a dead endpoint, and telemetry stops with no
> warning. Re-run `model-tracking env` to recover.

#### Diagnosing

```bash
node packages/copilot-plugin/dist/hook.js doctor
```

Six checks (`doctor.ts:103-130`): runtime install, daemon reachability, storage
writable, a **byte-exact compress→retrieve round trip**, recent traffic, and
model-tracking state. Warnings are tolerated; only failures are fatal.

Note that `doctor` reports the *configured* tracking endpoint rather than
probing it, so it can read green while nothing is listening.

### 6.3 MCP server

**Activate:** point any MCP client at `node packages/mcp-server/dist/index.js`.

Exposes `run_command`, `read_file`, `retrieve_artifact`, `get_savings`
(`mcp-server/src/index.ts:76-262`). With `--retrieval-only` the first two are not
registered at all and the server advertises different instructions
(`index.ts:34-71`).

Configured by flags (`--root`, `--storage`, `--label`, `--dashboard`,
`--retrieval-only`) and `SLIPSTREAM_*` environment variables
(`mcp-server/src/config.ts:38-104`). This surface records **no** model telemetry.

`run_command` takes the executable and its arguments separately and refuses
shell operators — there is no shell to interpret them, and accepting them would
imply one.

## 7. Model telemetry

An independent subsystem. Compression works whether or not it is on, and it is
**off until consented**.

Copilot reads OpenTelemetry exporter settings from environment variables at
process start. Slipstream runs a loopback OTLP receiver and points Copilot at it:

```
Copilot (VS Code or CLI)
    |  OTLP/HTTP + bearer token
    v
127.0.0.1:<port>/v1/traces     <- receiver, hosted in-process
    |
    v
recordModelObservation(engine, observation, source)
    |
    v
savings.jsonl   (entries carrying a `modelObservation`)
```

The receiver rejects anything that is not an authorised POST to
`/v1/traces|metrics|logs` from the expected host, counting rejections by reason
so failures are diagnosable rather than silent (`modelTelemetry.ts:243-310`).

**VS Code:** `Slipstream: Connect Model Tracking` shows a consent modal, then
writes Copilot's `github.copilot.chat.otel` settings for you.

**CLI:** consent is recorded in `model-tracking.json`; the exporter variables
must be exported in the shell *before* `copilot` starts:

```bash
node packages/copilot-plugin/dist/hook.js model-tracking enable
node packages/copilot-plugin/dist/hook.js model-tracking env powershell
```

Observations are labelled by producer — `Copilot Chat` vs `Copilot CLI`
(`modelTelemetry.ts:97-102`). This is passed in by the caller rather than
inferred at the receiver, because both surfaces emit identical OTLP.

Two labels that are easy to conflate:

- **`source`** is the producer: VS Code or CLI.
- **`scope`** is `Conversation` or `Background`, derived from whether the
  observation carries a conversation id (`dashboard.ts:835`). Background calls
  are auxiliary model traffic — title generation, intent detection — which can
  dominate call *counts* while being a rounding error in *tokens*.

## 8. Dashboard

A local HTTP server on loopback (`dashboardServer.ts:134`) that reads the ledger
and serves a single-page UI. It watches the ledger file for changes
(`dashboardServer.ts:288`), so every producer's events appear in one view.

```bash
npm run dashboard          # or: --demo, --fresh, --clear
```

The VS Code extension starts one automatically when `dashboardServer` is enabled
(port 7331 by default).

Because the dashboard reads the shared ledger rather than talking to producers,
it works when nothing else is running — and, conversely, an empty dashboard
means nothing *wrote*, not that the dashboard is broken.

## 9. Configuration

`EngineConfig` (`engine.ts:71-99`) is the single config surface; each host maps
its own settings onto it. Resolution order is
**defaults → profile preset → explicit overrides** (`compressionProfiles.ts:54`).

Three profiles (`compressionProfiles.ts:9-30`):

| | `conservative` | `balanced` (default) | `aggressive` |
| --- | --- | --- | --- |
| `maxFileLines` | 2400 | 1200 | 600 |
| log head/tail | 12 / 60 | 6 / 30 | 3 / 15 |
| code `minLines` | 120 | 60 | 40 |

What makes a profile more or less aggressive is the **per-compressor
thresholds**, not the token-budget setting — `minNetTokenGain` is a safety net
against marker overhead, not an aggressiveness dial.

Master switches: `enabled` (everything becomes passthrough), `compressLogs`
(tool output), `readLifecycle` (file reads), `crossTurnDedup`.

## 10. Extension points

**Adding a compressor.** Implement `Compressor` — a `name`, a `detect`
predicate, and a `compress` returning a plan or `null` — and add it to
`DEFAULT_COMPRESSORS` (`compressorRegistry.ts:41`). Order is significant: the
first match wins, so specific detectors must precede general ones. Add its config
to `EngineConfig` and a default to `DEFAULT_ENGINE_CONFIG`. You do not need to
touch the engine; storage, markers, the pay-for-itself check, and ledger
accounting are all handled for you.

**Adding a surface.** Construct a `CompressionEngine` with a `rootDir`,
`workspaceRoots`, and a `sessionLabel`, then call `compressToolResult`,
`compressCommandOutput`, or `compressFileRead` and expose `retrieve`. Use the
shared storage dir and your events join the same dashboard.

## 11. Build, test, verify

```bash
npm run build         # all workspaces
npm run typecheck
npm test              # scripts + unit + integration
npm run test:dashboard    # Playwright browser smoke
npm run proof-table       # regenerate the measured savings table
npm run outcome-proof     # paired baseline/compression/policy outcome proof
```

Two things to know before trusting a local run:

- **Dependent workspaces typecheck against `core`'s built `dist`, not its
  source.** Change a signature in `core` and dependents report a stale error
  until you rebuild. Run `npm run build` first.
- **Some extension tests spawn the bundled hook executable** and run close to
  their 5 s timeout. Under parallel load they can flake; re-run before treating a
  failure as real.

Compression claims are verified by measurement, not assertion:
`scripts/proof-table.mjs` regenerates the savings table and
`checkCompressRoundTrip` (`health.ts:68`) proves retrieval is byte-exact.
`scripts/outcome-proof.mjs` adds the paired arm comparison described in §12.

> A warning from experience: a fixture built from repeated characters compresses
> ~99% via the duplicate path no matter what you are testing, which makes a
> broken compressor look excellent. Use high-entropy fixtures.

## 12. Outcome proof

`npm run outcome-proof` (`scripts/outcome-proof.mjs`) answers "does compression
actually help, and what does it cost?" over a real workload rather than seeded
fixtures. `tests/outcome-proof.test.mjs` pins the gate logic.

It captures the [offline workload](../tests/fixtures/outcome-workload) once:
failing tests, two source reads, repaired tests, and a build. It then replays
**those identical bytes**
through three arms: baseline (off), static compression (balanced), and a policy
arm (aggressive). Ground truth is the workload's two seeded defects: the
known-correct fix is applied to a scratch copy and both tests and build must pass.

Replaying fixed bytes is the whole point. Two live agent runs issue different
tool calls, so any token delta between them measures the agent's choices, not
compression. That is also why per-arm agent success rate is reported as *not
covered* rather than estimated.

Every emitted marker is expanded and asserted byte-exact, and the recovered
tokens are charged back as retrieval overhead.

### Reading the table

```
arm         raw    -ansi  normalized  -compress  forwarded  total%  retr  net@30%  worst
compressed  18232  12088  6144        4188       1956       89.27%  10    14913    11732
```

The split is not decoration. **ANSI stripping is normalization, not
compression**: the engine strips escape codes before routing (`engine.ts:712`)
and measures `tokensBefore` on the raw text, so colour codes land inside the
headline saving. On this workload ~66% of the total saving is colour codes —
vitest emits ~1,490 escape sequences even under `spawnSync` with no TTY. A single
"89% saved" figure would therefore be mostly terminal colour.

So the gate scores compressors against **normalized** input (~71% here), which is
the honest claim, and a regression test asserts that an ANSI-only win *fails*.

### Gate

| Check | Bar |
| --- | --- |
| Ground-truth task verified | workload tests and build green with the fix applied |
| Compression vs normalized input | ≥ 10% |
| Still ahead after retrieval | net > 0 at a declared 30% expansion rate |
| Added latency | p95 ≤ 250 ms |
| Reproducibility | forwarded-token stdDev = 0 across runs |

Worst-case retrieval (`worst`) is reported but deliberately **not** gated:
expanding every marker is break-even minus marker overhead by construction, so
gating on it would mean gating on "compression never helps".

### Limits, stated in the export

The JSON carries a `notCovered` block rather than simulating what it cannot
measure: per-arm agent success rate, end-to-end latency including model time (so
HC-08's 10% task-latency allowance is *not* evaluated), a cheaper model actually
selected (HC-05), a budget changing an owned action (HC-06), and a
feedback-triggered rollback (HC-07). The policy arm is labelled a simulation — it
applies the profile the pressure guard would select, because in a non-owned host
the policy is advisory. Reference cost uses a declared constant rate, which
supports a token-efficiency claim only, not measured financial ROI.

Two operational notes: token counts are reproducible *within* an invocation, but
each invocation re-captures the workload and the captured output embeds test
durations, so figures move slightly between invocations by design. And the
latency check is the only non-deterministic gate — it has been observed at 187 ms
on a loaded machine, so it can flake.

The workload is not a separate npm workspace. The proof invokes the root-installed
Vitest CLI directly, with scratch copies under `.outcome-proof-*` so workload
imports resolve through the root dependencies. Scratch copies are removed on
exit. A timeout, spawn error, or failed repaired test/build is a failed proof,
not a successful task with a small captured output.

## Documentation Contracts

[check-docs.mjs](../scripts/check-docs.mjs) checks all maintained Markdown and
[llms.txt](../llms.txt), excluding generated output and the installed evaluator.
CI runs the check without source-path filters and validates the exact contract
path set at both report collection and aggregation; duplicate or substitute
paths cannot satisfy the evidence requirement merely by matching its count.

| Surface | Deterministic Coverage | Residual Review |
| --- | --- | --- |
| [Build reference](#build-and-script-reference) | Root and workspace manifest digests, scripts, runtime and workspace mapping | Build behavior is verified by CI, not by the reference text |
| [Extension reference](../packages/extension/README.md#commands-and-settings-reference) | Full manifest digest, command IDs, tool inputs and setting defaults | User-facing descriptions and runtime behavior |
| [MCP reference](mcp.md#mcp-launch-reference) | Registry, plugin and package digests; launch arguments, modes and tools | Live client/provider behavior |
| Maintained Markdown and agent index | Local links and anchors; JSON/JSONC syntax and cost-policy examples | External links, other prose and live-provider claims |

Check mode never writes. `npm run docs:write` updates only designated reference
blocks, and a second write must make no further changes. Tests compare the
generator's actual contract set with CI's expectations. New contracts require
an intentional mapping and test update; semantic review remains advisory.
Required merge enforcement must be verified separately in GitHub settings.

<!-- slipstream-reference:build:start -->
## Build And Script Reference

Generated from the public manifests by `npm run docs:write`. Check with `npm run check:docs`.

Supported Node.js: >=20. The pinned development runtime is in [.node-version](../.node-version).

| Workspace | Path | Scripts |
| --- | --- | --- |
| @slipstream/core | packages/core | build, typecheck, test, test:watch |
| @slipstream/hook-runtime | packages/hook-runtime | build, typecheck, test |
| @slipstream/mcp-server | packages/mcp-server | build, typecheck, start, test |
| @slipstream/copilot-plugin | packages/copilot-plugin | build, test |
| slipstream-vscode | packages/extension | build, watch, typecheck, package, test |

| Root npm Script | Command |
| --- | --- |
| build | npm run build --workspaces --if-present |
| test | npm run test:scripts && npm run test --workspaces --if-present |
| test:scripts | node --test tests/dashboard-cli.test.mjs tests/benchmark-report.test.mjs tests/copilot-plugin-install.test.mjs tests/outcome-proof.test.mjs tests/check-docs.test.mjs tests/readiness.test.mjs |
| test:dashboard | playwright test tests/dashboard.smoke.spec.ts |
| typecheck | npm run typecheck --workspaces --if-present |
| lint | eslint . --max-warnings 0 |
| format:check | prettier --check eslint.config.mjs playwright.config.ts scripts/check-*.mjs tests/check-docs.test.mjs tests/readiness.test.mjs .github/workflows/*.yml |
| check:docs | node scripts/check-docs.mjs |
| docs:write | node scripts/check-docs.mjs --write |
| benchmark:snapshot | node scripts/benchmark.mjs --markdown |
| benchmark:recommendations | node scripts/benchmark.mjs --model-recommendations |
| proof-table | node scripts/proof-table.mjs |
| outcome-proof | node scripts/outcome-proof.mjs |
| proof-table:snapshot | node scripts/proof-table.mjs --markdown |
| package:extension | npm run build && npm run package --workspace slipstream-vscode |
| package:copilot-plugin | npm run build --workspace @slipstream/copilot-plugin |
| install:copilot-plugin | npm run package:copilot-plugin && node scripts/registerCopilotCli.mjs |
| install:copilot-plugin:tracking | npm run package:copilot-plugin && node scripts/registerCopilotCli.mjs --enable-model-tracking |
| register:copilot-cli | npm run install:copilot-plugin |
| copilot:plugin | npm run package:copilot-plugin && copilot --plugin-dir ./packages/copilot-plugin |
| dashboard | node scripts/dashboard.mjs |
| dashboard:clear | node scripts/dashboard.mjs --clear |
| reset:copilot | node packages/copilot-plugin/dist/hook.js reset |
| purge:copilot | node packages/copilot-plugin/dist/hook.js purge |
| clean | node -e "for (const p of ['copilot-plugin','core','hook-runtime','mcp-server','extension']) require('fs').rmSync('packages/'+p+'/dist',{recursive:true,force:true})" |

<!-- source-sha256: 1306d5644608d507ca90689cb91b515c4c7939b5db1d6a9b3ae0376c101162dd -->
<!-- slipstream-reference:build:end -->
