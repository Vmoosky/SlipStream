# Packaging notes

## VS Code extension

Build the extension bundle with `npm run build`. The extension package lives in `packages/extension` and contributes four Copilot Chat tools plus the savings dashboard command.

The package also includes `dist/chat-hook.js` for automatic native Agent chat
observation in trusted workspaces. `slipstream.chatHooks` defaults to `true`;
the enable/disable commands are optional controls. See
[chat hook setup](vscode-chat-hooks.md). The bundle must remain in the VSIX;
it is not supplied by the CLI plugin.

For a distributable VSIX, run `npm run package:extension` from the repo root. The command builds the extension and invokes `@vscode/vsce package --no-dependencies` from `packages/extension`.

Keep `.slipstream/`, `.slipstream-demo/`, `test-results/`, `node_modules/`, and generated build output out of the package unless a release process explicitly includes them.

## MCP server

The stdio server entry point is `packages/mcp-server/dist/index.js`. Build first, then configure an MCP client with a `node` command pointing at that file and a `--root` argument for the workspace to confine reads and commands.

## Local Evidence

Use `npm run dashboard` for the real standalone MCP store and
`npm run benchmark:snapshot` for a static Markdown benchmark receipt.
`npm run outcome-proof` verifies the isolated test fixture and writes its paired
comparison to `test-results/outcome-proof.json`. These commands do not upload
artifacts. The fixture is test data and must not be packaged with the extension.

The retired demo app and registration packet are no longer maintained. Existing
`.slipstream-demo` data is left untouched and remains excluded from publication.