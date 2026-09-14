# VS Code Chat Activity Hooks

The extension can observe native VS Code Agent chat prompts and successful tool
events, even when the agent does not call a Slipstream tool. This requires a VS
Code release with agent hooks enabled, a trusted file-backed workspace, and
Node.js 20 or later on the extension host's PATH. Organization policy can disable
hooks. Older VS Code releases can still use Slipstream tools without observation.

## Automatic Setup

1. Build and run the updated extension with F5, or install the VSIX produced by
   `npm run package:extension` and reload the extension host.
2. Open a trusted workspace. Slipstream configures hooks automatically for each
  local workspace folder when Node.js and VS Code hook support are available.
  No enable command is required.
3. Submit a prompt in a native VS Code Agent chat. **Chats observed** updates in
   the dashboard. Successful built-in tool calls increment **Tool events
   observed** and appear as **Observed** in the activity timeline.

Automatic setup is controlled by `slipstream.chatHooks`, which defaults to `true`
and can be changed globally or per workspace folder. Setup also runs when a
workspace becomes trusted, folders are added, or relevant settings change.
Untrusted workspaces are never modified and do not launch the hook runtime check.
Unavailable prerequisites are reported in the **Slipstream** output channel.

Setup writes only `.github/hooks/slipstream-activity.json` in each workspace
folder. VS Code discovers that directory by default. It contains the
`UserPromptSubmit` and `PostToolUse` events, a command invoking the bundled
`dist/chat-hook.js`, and the resolved storage directory. Paths are passed through
configuration fields rather than interpolated into shell commands. In SSH, WSL,
or container sessions, Node and the bundle must be available on the extension
host, not merely the local desktop.

Hook configuration is machine-local because it points to the installed extension
and storage directories. Do not commit the generated file as a portable team
configuration. Slipstream creates or refreshes its unedited manifest to the
current bundle path on activation, unless `slipstream.chatHooks` is `false`.

The browser dashboard, VS Code webview, and status bar watch the shared ledger
for writes from the external hook process. They do not require a subsequent
Slipstream tool call to refresh. A dashboard using an isolated demo directory
does not show these events; it must use the same store as the extension.

## What Is Recorded

- A prompt event records its timestamp, session identifier when supplied, and
  workspace attribution. It does not record the prompt or transcript path.
- A tool event records the same metadata and the tool name. It does not record
  tool arguments, file contents, or tool output.
- Slipstream-named tool events are skipped by the observer because their normal
  compression or retrieval events are already recorded by Slipstream.
- Observation entries carry zero tokens and no pricing snapshot. They never
  increase compression, retrieval, savings, or reference-cost totals.

Workspace attribution comes from the absolute workspace root in the generated
hook's `SLIPSTREAM_WORKSPACE_ROOT` setting. The hook runs from the extension's
runtime directory, so neither the payload's `cwd` nor the process working
directory is used as a workspace. Missing, empty, or relative workspace settings
produce an explicit **Unknown workspace** label and no workspace path. Each hook
invocation uses its own configured root; no workspace is inferred from another
session or event. This applies to new observations only. Existing ledger records
and historical labels are not rewritten.

This adapter is independent of the CLI daemon. It accepts VS Code's snake_case
hook fields and returns `{}` without changing the tool response, adding context,
blocking a tool, or preventing the agent from stopping. Malformed input or a
hook failure preserves the original result and reports a diagnostic on stderr.

## Limits

These hooks observe activity; they do not transparently compress native tool
results. VS Code's documented `PostToolUse` contract supports additional context
and blocking, not replacing the original result with compressed output.
Compression savings still require Slipstream's native tools or MCP tools.

The documented hooks do not expose the selected language model. The separate
`@slipstream` chat participant reads its own request's model and resolves pricing
automatically; it does not infer model identity for native hook events. See
[automatic pricing](pricing.md). Observation applies to agent sessions where
VS Code executes hooks, not every chat surface or mode.

## Diagnose or Disable

Use **Chat: Configure Hooks** to inspect discovery, or **Developer: Show Agent
Debug Logs** to check which hooks loaded. Hook stderr appears in the **GitHub
Copilot Chat Hooks** output channel. Verify `.github/hooks` is enabled in
`chat.hookFilesLocations` and hooks are not disabled by your settings or policy.

Set `slipstream.chatHooks` to `false`, or run **Slipstream: Disable VS Code Chat
Hooks**, before uninstalling the extension. The command persists that setting
for the selected workspace folder, so activation does not re-enable it. Only the
generated activity manifest is removed; unrelated hooks and ledger history
remain. Set the setting back to `true` to resume automatic setup; **Slipstream:
Enable VS Code Chat Hooks** remains an optional convenience command.

If the generated file was edited, Slipstream leaves it intact and reports the
conflict instead of overwriting or deleting it. Review such a file manually
before re-enabling or removing it.

References: [VS Code agent hooks](https://code.visualstudio.com/docs/agent-customization/hooks)
and [hook schemas](https://code.visualstudio.com/docs/agents/reference/hooks-reference).