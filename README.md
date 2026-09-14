# Slipstream

Copilot burns most of its context window on output nobody reads: 2,000 lines of
passing tests to find two failures, the same file sent four times because it was
read four times, a build log that is 95% progress bars.

Slipstream compresses that output **before it reaches the model**, and makes
everything it removes retrievable on demand.

```
$ npx vitest run --reporter=verbose
(exit 1, 1.4s, cwd C:\...\demo)
--- slipstream: 185 -> 63 lines; omissions recoverable via retrieve_artifact ---
 ✓ test/cart.test.js (12 tests)
[[slipstream:4f1a9c02be71 L14-119 | 106 lines omitted (passing suites) | retrieve_artifact]]
 FAIL  test/pricing.test.js > pricing > takes 15% off an odd price
AssertionError: expected 1704 to be 1699 // Object.is equality
 ❯ test/pricing.test.js:14:44
...
 Test Files  2 failed | 10 passed (12)
--- slipstream: 3,031 -> 979 tokens (68% saved) ---
```

The model still sees every failure, every stack trace and the summary. It just
doesn't see the 106 lines telling it things passed.

## Quick start: GitHub Copilot CLI

### Prerequisites

- Node.js 20 or later
- npm
- GitHub Copilot CLI, signed in with `copilot login`

From the Slipstream repository root, install dependencies and the local Copilot
CLI plugin:

```bash
npm install
npm run install:copilot-plugin
```

This does not enable model tracking, so the dashboard will show compression
savings but not which model ran or how many tokens it used. Use
`npm run install:copilot-plugin:tracking` instead to enable both, or see
[fresh setup from scratch](#fresh-setup-from-scratch) for every path.

Confirm that Copilot can see the plugin:

```bash
copilot plugin list
```

The output should include `slipstream@slipstream-local`. Start Copilot normally
from any project:

```bash
copilot
```

No API key, custom model provider, prompt convention, or `--excluded-tools`
flag is required. Slipstream works with whichever model is selected in Copilot
CLI.

To watch the savings counter, start the dashboard in a second terminal:

```bash
npm run dashboard
```

Then open [http://127.0.0.1:7331/](http://127.0.0.1:7331/). The compression and
token-savings counters update when a chat produces tool output that Slipstream
can compress. The separate **Chats observed** counter increments for every
submitted prompt, including text-only chats and chats whose tool output is too
small to compress. Slipstream records only the chat timestamp and session
metadata for this counter; it does not store the prompt text.

After changing Slipstream source code, rebuild the live local plugin with:

```bash
npm run install:copilot-plugin
```

To uninstall it:

```bash
copilot plugin uninstall slipstream
copilot plugin marketplace remove slipstream-local
```

## Fresh setup from scratch

Everything below starts from a clean machine and a fresh clone. Steps 1 and 2
are shared; after that, follow only the path you actually use. Model tracking is
**opt-in on every path** — skip it and compression still works, but the
dashboard cannot show which model or how many tokens were used.

### 1. Prerequisites

- Node.js 20 or later, and npm
- For the CLI path: GitHub Copilot CLI, signed in via `copilot login`
- For the extension path: VS Code 1.101 or later with GitHub Copilot

### 2. Install dependencies and build

```bash
git clone <this-repo>
cd slipstream
npm install
npm run build
```

`npm run build` builds all five workspaces. The CLI installer builds the plugin
itself, but the MCP and extension paths need this step.

### Path A — GitHub Copilot CLI (no VS Code)

```bash
npm run install:copilot-plugin:tracking
```

Use the `:tracking` variant to install **and** approve model tracking in one
step. Plain `npm run install:copilot-plugin` prompts in an interactive terminal
and defaults to **off**; if you skip the prompt or run it non-interactively, no
CLI model or token usage will ever reach the dashboard.

Then confirm the plugin is registered, and add the exporter variables to the
shell profile that launches Copilot:

```bash
copilot plugin list          # expect slipstream@slipstream-local

# bash/zsh — append to ~/.bashrc or ~/.zshrc:
node packages/copilot-plugin/dist/hook.js model-tracking env

# PowerShell — append to $PROFILE:
node packages/copilot-plugin/dist/hook.js model-tracking env powershell
```

Open a **new** terminal so the profile is applied, then start `copilot`. Copilot
reads exporter configuration once at process start, so a session that was
already running can never be captured — see
[when model tracking is live](#when-model-tracking-is-live).

### Path B — VS Code extension

```bash
npm run build
```

Press <kbd>F5</kbd> to launch the Extension Development Host, or package and
install it permanently:

```bash
npm run package:extension     # writes packages/extension/slipstream-vscode-<version>.vsix
code --install-extension packages/extension/slipstream-vscode-0.1.0.vsix
```

Model tracking needs no setup here: the extension opens a one-time consent
prompt automatically when Copilot is ready in a trusted workspace. Click
**Allow**. If you dismissed it, reopen it from **Dashboard > Model tracking >
Connect**.

### Path C — Both CLI and VS Code

Run Path B, then Path A. They share one storage directory
(`~/.slipstream`), one ledger, and one OTLP receiver, so the dashboard shows
combined totals with each producer listed separately. The two consent
mechanisms are independent — approving in VS Code does not enable the CLI, and
vice versa.

### Path D — MCP server for another client

```bash
npm run build
```

Point the client at the built server, labelling the session so it is
distinguishable in the dashboard:

```json
{
  "servers": {
    "slipstream": {
      "command": "node",
      "args": [
        "packages/mcp-server/dist/index.js",
        "--root", "/path/to/your/repo",
        "--label", "MCP: my-repo"
      ]
    }
  }
}
```

This path has no model tracking of its own; it records compression only.

### 3. Start the dashboard

```bash
npm run dashboard
```

Open [http://127.0.0.1:7331/](http://127.0.0.1:7331/). If model tracking is not
yet enabled for the CLI, the **Model tracking** panel shows the exact commands
to enable it, so you can complete setup from the dashboard rather than from
this file.

### 4. Verify the install

```bash
node packages/copilot-plugin/dist/hook.js doctor
```

A healthy install reports all six checks, including a lossless
compress→retrieve round-trip:

```
  ✔ runtime install: runtime + manifests present in ...
  ✔ hook daemon: reachable
  ✔ storage writable: C:\Users\you\.slipstream
  ✔ compress→retrieve round-trip: lossless via neardup; 1 marker(s), 87% saved
  ✔ recent traffic: 1124 compressions, 537,054 tokens saved
  ✔ model tracking: consented; http://127.0.0.1:52969
```

Note the limits of the last line: it reports what is **configured**, not what is
listening. It shows `consented` even when the receiver is down.

### When model tracking is live

Three separate things must all hold before a CLI model call is recorded, and
they fail independently:

1. **Consent** — `model-tracking status` says `consented`.
2. **Exporter variables present in the shell before `copilot` starts.** They are
   read once at process start. Adding them to your profile does nothing for a
   session that is already running; start a new one.
3. **The hook daemon is running** — it hosts the receiver in-process.

The third is the one that surprises people. The receiver does not keep the
daemon alive (it is `unref`'d), and the daemon exits roughly ten minutes after
the last tool call. It restarts automatically on the next tool call and rebinds
the same port, so compression is unaffected and your profile stays valid.

Start-of-session calls used to be lost here: the daemon accepted hook requests
before it had bound the receiver, so the `userPromptSubmitted` hook returned,
Copilot began exporting, and the opening model calls went to a port nothing was
listening on. On a short session that was every call it made. The daemon now
binds the receiver *before* it accepts on the pipe, so the first hook does not
return until the receiver is ready and a cold session is captured from its first
call. Cold start costs about a second, well inside the hook's five-second
timeout.

One caveat worth knowing: if that port is already taken when the daemon
restarts, it falls back to a different one and persists it. The variables in
your profile then point at a dead endpoint and telemetry stops silently. Re-run
`model-tracking env` to get the current values.

### Uninstall

```bash
copilot plugin uninstall slipstream
copilot plugin marketplace remove slipstream-local
node packages/copilot-plugin/dist/hook.js model-tracking disable
```

Also remove the exporter variables from your shell profile. To delete recorded
data, run `npm run dashboard:clear`; to remove everything, delete
`~/.slipstream`.

## Results

Measured on a real failing test suite in [`demo/`](demo), via
`node scripts/benchmark.mjs`. The benchmark re-expands every marker and asserts
the original bytes come back exactly, so a ratio can never be bought with lost
information.

| Scenario | Tokens in | Forwarded | Saved |
|---|---:|---:|---:|
| `vitest run` — 12 suites, 2 failing | 3,031 | 1,054 | **65.2%** |
| `npm run build` — chatty build | 488 | 429 | 12.1% |
| `vitest run` again — cross-turn dedup | 3,031 | 619 | **79.6%** |
| Read a 600-line module (first time) | 7,325 | 7,325 | 0.0% |
| Read it again, unchanged | 7,325 | 101 | **98.6%** |
| Read it after a one-line edit | 7,327 | 254 | **96.5%** |
| **Total** | **28,527** | **9,782** | **65.7%** |

The first read of a file saves nothing — that is the point. Slipstream never
withholds information the model has not already been given.

### Outcome proof

The table above measures savings. `npm run outcome-proof` asks the harder
question: does compression still pay once you charge for retrieval, and does the
task still succeed?

It captures one real workload from [`demo/`](demo) — a failing `npm test`, two
source reads, a passing `npm test`, a build — then replays **those identical
bytes** through three arms: baseline (off), static compression, and a policy arm.
Fixed bytes are essential: two live agent runs issue different tool calls, so a
delta between them would measure the agent's choices, not compression. Ground
truth is the demo's two seeded defects — the known-correct fix must turn the
suite green. Every marker is expanded and asserted byte-exact, and the recovered
tokens are charged back as overhead.

```
arm         raw    -ansi  normalized  -compress  forwarded  total%  retr  net@30%
baseline    18232  0      18232       0          18232      0%      0     0
compressed  18232  12088  6144        4188       1956       89.27%  10    14913
policy      18232  12088  6144        4572       1572       91.38%  7     15207
```

That split matters. **ANSI stripping is normalization, not compression** — and on
this workload ~66% of the total saving is terminal colour codes, because vitest
emits ~1,490 escape sequences even with no TTY attached. Quoting the 89% as a
compression figure would be misleading, so the gate scores the compressors
against *normalized* input (~71% here) and a regression test makes an ANSI-only
win fail.

The export also states what it does **not** prove — per-arm agent success rate,
end-to-end latency including model time, and the live policy behaviours — rather
than simulating them. See [docs/architecture.md](docs/architecture.md#12-outcome-proof)
for the gate thresholds and limits.

## How it works

Slipstream cannot see Copilot's outgoing prompt; no extension or MCP server can.
So it works at the boundary it *can* control: **the tool output boundary.** It
compresses what tools return. The Copilot CLI plugin does this transparently
with a `postToolUse` hook; the VS Code extension and general MCP server also
provide explicit compressed command and file tools.

That makes the measurement unusually honest — savings are exactly
`tokens(raw output) − tokens(returned output)`, with no modelling of what the
prompt "would have been".

Four compression strategies:

| Strategy | What it does |
|---|---|
| **Log compression** | Detects the format (jest, vitest, tsc, eslint, cargo, pytest, …) and keeps errors, their stack frames, surrounding context and the summary. Repeated errors collapse to a template after the third occurrence. |
| **Read lifecycle** | A file read twice returns a one-line marker. A file that changed returns a unified diff. Only a first read sends the whole file. |
| **Cross-turn dedup** | Text already returned earlier in the session is replaced by a pointer to it. |
| **Reversible retrieval** | Everything omitted is stored content-addressed and recoverable by id and line range, or by grep. |

### Nothing is lost

Every omission is rendered as a marker carrying the artifact id and the exact
line range, so the model can get the content back with one call:

```
[[slipstream:4f1a9c02be71 L14-119 | 106 lines omitted (passing suites) | retrieve_artifact]]
```

In practice the model almost never needs to. The dashboard reports the retrieval
rate so you can check that claim rather than trust it.

### Compression must pay

A marker costs about 30 tokens. On small or dense output that can exceed what the
omitted lines were worth. If a compressed result would not be at least 10%
smaller, Slipstream discards it and returns the original — so a Slipstream tool
never returns more tokens than it was given.

## Using it

### VS Code extension

```bash
npm install
npm run build
```

Then press <kbd>F5</kbd>. A second VS Code window opens on `demo/` with the tools
registered. Ask Copilot:

> Run the tests and fix the failures.

Four tools are contributed to Copilot Chat, and can be referenced explicitly:

| Tool | Reference | Purpose |
|---|---|---|
| `slipstream_runCommand` | `#hrRun` | Run a build/test/lint command, compressed |
| `slipstream_readFile` | `#hrRead` | Lifecycle-aware file read |
| `slipstream_retrieveArtifact` | `#hrGet` | Expand an omitted range |
| `slipstream_getSavings` | `#hrStats` | Session savings report |

The status bar shows live savings; click it for the dashboard.

For model detection in ordinary local Agent chat, Slipstream opens a one-time
local telemetry consent prompt automatically when Copilot is ready in a trusted
workspace. No command is needed; click **Allow** to approve. Previous declines
and disconnects are respected. **Dashboard > Model tracking > Connect**
reopens consent when needed.
It needs no GitHub token or extra login. The main dashboard shows the observed model,
cached input rate, and reported input/output/cache usage after model calls.
**Privacy:** Copilot exports may contain prompts, code, and tool content even
with content capture off. Slipstream receives exports on an authenticated
localhost endpoint and discards content before logging or storage; only model,
correlation, timing, and usage metadata remains. Nothing is forwarded. Existing
custom or managed telemetry configuration is not replaced. **Disconnect** restores
only owned settings. Reload VS Code after either action. See
[consent, scope, and limitations](docs/pricing.md#local-telemetry-consent).

Use **Slipstream: Start Chat** or address `@slipstream` to run these tools with
per-request model detection. The participant uses the selected VS Code model
and resolves its input rate from a background cache. No price or reference-model
selection is needed. **Dashboard > Model tracking** shows the last
detected request model and cached rate. **Est. saved** retains recorded rates and
uses a fallback for missing rates: **$3 per million tokens** by default. Change
**Dashboard settings > Runtime config > Fallback input rate** or the VS Code
setting `slipstream.usdPerMillionTokens`. Zero is allowed. Dollar values are
estimates, not Copilot bills. Native tools and hooks do not
provide an exact request-to-compression identity; they cannot inherit the latest
model seen in telemetry. See [automatic pricing](docs/pricing.md).

Native VS Code Agent chat activity is observed automatically in trusted
workspaces when VS Code hooks are available. No enable command is required.
Prompts and built-in tool events update the dashboard without using Slipstream
tools. These are observation counts, not compression savings; prompts and tool
output are not stored.

Users can still opt out by setting `slipstream.chatHooks` to `false`. See
[VS Code chat hooks](docs/vscode-chat-hooks.md) for requirements and removal.

### The dashboard

Inside VS Code, `Slipstream: Show Savings Dashboard` opens the live savings
dashboard. For the standalone MCP server, the browser dashboard can serve the
shared real store at `%USERPROFILE%\.slipstream`:

```bash
npm run dashboard
```

The browser dashboard uses a local event stream instead of polling. It watches
the shared ledger, so events written by multiple VS Code windows or standalone
MCP sessions update every open dashboard tab.

In dashboard terms, a **dashboard viewer** is an open dashboard tab connected to
the event stream. A **producer session** is a VS Code window, extension MCP
server, or standalone MCP process that writes Slipstream events. Route traffic
through a producer with `slipstream_runCommand` / `#hrRun`,
`slipstream_readFile` / `#hrRead`, or the MCP `run_command` / `read_file` tools;
the dashboard observes that traffic rather than receiving it directly.

For a browser-only sample with seeded activity, use the isolated demo store:

```bash
npm run dashboard:demo
```

Use `npm run dashboard:clear` only when you want to delete the configured real
store. Use `npm run dashboard:demo:fresh` when you want to reset and reseed the
isolated demo store.

It prints a readable local URL, usually:

```text
http://localhost:7331/
```

The normal dashboard refreshes the ledger and artifact index from disk, so a
separate Slipstream MCP process can write savings while the browser page is
open. Demo mode stays under `.slipstream-demo` and does not overwrite real
session history.

The VS Code extension, the extension-provided MCP server, the standalone MCP
server, and `npm run dashboard` all default to the same real store:
`%USERPROFILE%\.slipstream`. Override it with the `slipstream.storageDir`
setting or `SLIPSTREAM_STORAGE_DIR` for the dashboard script.

The dashboard is the hackathon proof surface. It shows:

| Panel | What it proves |
|---|---|
| **Hero metrics** | Total tokens removed, forwarded tokens, percent saved and estimated cost saved. |
| **Traffic** | Connected dashboard viewers, producer sessions, global outputs and this producer's current session label. |
| **Grouped tabs** | Overview, evidence, storage and activity views keep related details together. |
| **Workspace attribution** | Savings grouped by workspace root, sorted by tokens saved. |
| **Runtime config** | Enabled strategies, max file-read size, token price and artifact retention caps. |
| **Retrieval audit** | Which omitted markers were later expanded, and which stayed compressed because the model never needed them. |
| **By strategy** | Savings split across log compression, read lifecycle, cross-turn dedup, passthrough guard and retrieval. |
| **Session timeline** | The sequence of compressions, reads, retrievals, resets and purges in the current session. |
| **Recent activity** | Every inspectable tool call, with lines/tokens before and after compression. |

The **Runtime config** panel is editable. In the browser dashboard it writes a
local `.slipstream.config.json`; in the VS Code dashboard it mirrors changes to
the corresponding `slipstream.*` settings.

**History > Compare** shows live lifetime totals, a saved baseline, and a
**Synthetic benchmark** reference. The reference uses six seeded scenarios with
the balanced profile, independent of the current runtime profile. Its token
savings exclude recovery probes and are not a prediction for your workload.
Retrieval rate and timing show N/A; changes are calculated only against the
saved baseline. Viewing the reference never runs benchmarks or adds live events.

To regenerate the bundled reference after changing compression behavior:

```sh
npm run build --workspace @slipstream/core
node scripts/proof-table.mjs --dashboard-reference
npm run build --workspace @slipstream/core
```

The proof-table test reproduces the reference offline and detects stale values.

Select any row in **Recent activity** to see exactly what changed. The inspector
has two modes:

- **Side by side** shows raw tool output beside the exact payload the model
  received. Removed blocks are shaded and expandable on click; retrieval markers
  are highlighted in the model payload.
- **Diff mode** renders a single raw-vs-compressed view: kept lines, removed
  lines, and then the exact compressed payload.

The inspector also has **Copy model payload** and **Open exact payload** controls,
so the demo can show the real bytes that would have entered the context window.
That makes the dashboard the fastest way to sanity-check the compressor on your
own repo: if it ever cut something that mattered, you will see it immediately.

For judging or async sharing, click **Export snapshot**, **Export JSON**, or
**Export CSV**. The same data is also available at `/api/report.md`,
`/api/report.json`, and `/api/report.csv`.

The dashboard stays focused on live savings evidence. The demo walkthrough lives
in [`docs/hackathon-demo.md`](docs/hackathon-demo.md) and the safety rationale in
the registration packet and Security section.

See [`docs/backlog.md`](docs/backlog.md) for the Headroom-inspired backlog,
including the next dashboard evidence upgrades and the proxy features that stay
out of scope for Slipstream.

### MCP server

The canonical [server manifest](server.json) describes local-source installation
and both MCP modes. See the [MCP integration guide](docs/mcp.md) for launch
configuration, live tool discovery, and recovery limits, or [llms.txt](llms.txt)
for the agent-readable index. The manifest is not a public registry listing.

The same four tools are available over stdio for any MCP client:

```json
{
  "servers": {
    "slipstream": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js", "--root", "/path/to/your/repo"]
    }
  }
}
```

Inside VS Code this is off by default — the contributed tools already cover it,
and running both would show the model two copies of every tool. Enable
`slipstream.provideMcpServer` to share one instance with another client.

### GitHub Copilot CLI

Follow the [quick start](#quick-start-github-copilot-cli) to install and run the
plugin. The installer registers this working tree as the `slipstream-local`
marketplace and installs `slipstream@slipstream-local`.

The plugin's `postToolUse` hook compresses successful tool results before the
next model request, regardless of which Copilot CLI model is selected. Built-in
tools remain available.

The plugin MCP server exposes only `retrieve_artifact` and `get_savings`.
Retrieval results bypass compression so omitted bytes can be restored exactly.
The `#hrRun` style references remain VS Code chat only.

#### Model tracking (no VS Code required)

Copilot CLI can report the model it used through the same local OpenTelemetry
receiver the VS Code extension uses. Because the CLI has no settings UI, Copilot
reads its exporter configuration from environment variables at process start, so
model tracking is opt-in and printed for your shell.

`npm run install:copilot-plugin` offers to enable it: in an interactive terminal
it prompts (default off), or pass `--enable-model-tracking` / `--skip-model-tracking`
(or set `SLIPSTREAM_MODEL_TRACKING=1|0`) for a non-interactive choice. To install
and enable in one step, use `npm run install:copilot-plugin:tracking`. You can
also manage it any time:

```bash
# Approve local telemetry and start the receiver (hosted in the hook daemon):
node packages/copilot-plugin/dist/hook.js model-tracking enable

# Print the exporter variables for the shell that launches Copilot:
node packages/copilot-plugin/dist/hook.js model-tracking env         # bash/zsh
node packages/copilot-plugin/dist/hook.js model-tracking env powershell
```

Add the printed `COPILOT_OTEL_*` / `OTEL_EXPORTER_OTLP_*` variables to the shell
profile that starts `copilot`, then start a **new** Copilot session — the
variables are read once at process start, so an already-running session is never
captured. Observed models appear in the dashboard's **Model tracking** section.
Use `model-tracking status` to check consent and `model-tracking disable` to
stop it (remove the variables from your profile as well).
`node packages/copilot-plugin/dist/hook.js doctor` also reports the current
state, though it reports the *configured* endpoint rather than probing it.

Capture is only live while the hook daemon is running, and the daemon exits
about ten minutes after the last tool call; see
[when model tracking is live](#when-model-tracking-is-live) for what that means
in practice.

**Privacy:** exports may contain prompts, code, and tool content even with
content capture off. The receiver binds to `127.0.0.1`, requires a local bearer
credential, discards content in memory, and records only model, correlation,
timing, and token metadata. Nothing is forwarded. Consent is stored in a
mode-0600 file in the shared storage directory; the credential is not a GitHub
token. See [consent, scope, and limitations](docs/pricing.md#local-telemetry-consent).

#### Reset and purge (no VS Code required)

The CLI has the same session-maintenance commands as the VS Code extension.
`reset` forgets what the model has already been shown, so the next read of each
file is full again; stored artifacts are kept. `purge` additionally deletes
every stored artifact and clears the shared dedup index — content the model has
not expanded yet becomes unretrievable.

```bash
# Forget seen state; keep artifacts (VS Code: "Slipstream: Reset Session"):
node packages/copilot-plugin/dist/hook.js reset
npm run reset:copilot

# Delete all stored artifacts (VS Code: "Slipstream: Purge Artifacts"):
node packages/copilot-plugin/dist/hook.js purge
npm run purge:copilot
```

When the hook daemon is running the command is routed to it so every live
Copilot session stays consistent; otherwise it is applied directly to the shared
storage directory. Both actions are recorded in the dashboard History as
`Session reset` / `Purged` events.

For development without persistent installation:

```bash
npm run copilot:plugin
```

A plugin installed from the local marketplace reads from this working tree in
new sessions.

Because Copilot CLI writes to the same shared store as the VS Code extension,
its traffic shows up in the dashboard as a separate producer session while the
totals stay combined. Any MCP host can do the same by passing `--label`:

```bash
node packages/mcp-server/dist/index.js --root /path/to/repo --label "Copilot CLI: repo"
```

Without a label, the server falls back to `SLIPSTREAM_SESSION_LABEL` and then to
`MCP: <workspace>`.

## Settings

| Setting | Default | |
|---|---|---|
| `slipstream.enabled` | `true` | Master switch |
| `slipstream.compressLogs` | `true` | Strip build/test noise |
| `slipstream.crossTurnDedup` | `true` | Replace already-sent text with a pointer |
| `slipstream.readLifecycle` | `true` | Markers and diffs for repeat reads |
| `slipstream.maxFileLines` | `1200` | Truncate long first reads |
| `slipstream.allowedCommands` | built-in list | Executables the model may run |
| `slipstream.commandTimeoutSeconds` | `120` | Kill long commands |
| `slipstream.artifactIdleTtlMinutes` | `60` | Evict retrievable artifacts after this many idle minutes |
| `slipstream.artifactMaxEntries` | `2000` | Maximum number of retrievable artifacts to keep locally |
| `slipstream.artifactMaxTotalMiB` | `256` | Maximum total artifact-store size |

## Security

This project gives a language model the ability to run commands and read files,
so the boundaries are deliberate:

- **Commands are allowlisted by bare executable name.** No paths, no shell.
  Arguments are passed as argv with `shell: false`, so `&&`, `|`, `$()` and
  friends are inert — there is a test that proves an injected `&&` never
  executes. The one exception is Windows `.cmd`/`.bat` shims (`npm`, `npx`),
  which cannot be spawned without a shell; on that path only, arguments
  containing shell metacharacters are rejected.
- **Reads are confined to open workspace folders**, and a denylist blocks
  secrets regardless: `.env*`, `.git/`, `.npmrc`, `.netrc`, SSH keys, `*.pem`,
  `*.p12`, `.aws/`, `.azure/`, `credentials`, `secrets.*`.
- **Tool output is untrusted input.** Text that looks like a Slipstream marker is
  stripped before storage, so command output cannot forge a retrieval handle or
  smuggle instructions to the model.
- **The dashboard renders nothing as HTML.** It runs under a strict CSP with a
  per-load nonce, no local resource roots, and writes every ledger-derived
  string with `textContent`. Because that script lives in a template literal
  where the compiler cannot check it, tests parse it and assert it contains no
  interpolation, no `innerHTML` and no `eval`.
- **Artifacts are written mode `0600`** under the extension's global storage,
  evicted after 60 idle minutes, and capped at 2,000 entries / 256 MiB.
  `Slipstream: Purge Stored Artifacts` deletes them all.

### Known advisory

`npm audit` reports two moderate advisories against `qs`, reached via
`@modelcontextprotocol/sdk → express → body-parser`. Both concern HTTP query
string parsing. Slipstream uses **only the stdio transport** and never starts a
listener or parses a query string, so neither is reachable. The advisory names
`qs@6.16.0` as the fix, but that version is not published yet; an `overrides`
entry will be added when it ships.

## Layout

```
packages/core         compression engine, artifact store, ledger, security
packages/mcp-server   stdio MCP server (4 tools)
packages/hook-runtime stateful Copilot CLI hook and local daemon
packages/copilot-plugin installable hooks plus retrieval-only MCP server
packages/extension    VS Code extension: LM tools, status bar, dashboard
demo/                 sample project with two real bugs
docs/                 architecture reference, demo flow, packaging notes
scripts/benchmark.mjs measures savings and verifies recoverability
scripts/outcome-proof.mjs paired baseline/compression/policy outcome proof
```

```bash
npm test                      # all script, unit, and integration tests
npm run test:dashboard        # browser smoke for the dashboard
node scripts/benchmark.mjs    # regenerate the results table
npm run benchmark:snapshot    # write test-results/slipstream-benchmark-snapshot.md
npm run outcome-proof         # paired arm comparison over the demo workload
npm run package:extension     # build a VSIX from packages/extension
npm run registration:packet   # write docs/project-registration.md with screenshots
```

See [docs/architecture.md](docs/architecture.md) for how the system is put
together and how each surface is activated,
[docs/compressors.md](docs/compressors.md) for the compression strategies and
their thresholds, [docs/hackathon-demo.md](docs/hackathon-demo.md) for the short
judging flow, and [docs/packaging.md](docs/packaging.md) for VS Code extension
and MCP server packaging notes.
