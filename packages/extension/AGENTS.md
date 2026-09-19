# VS Code Extension Agent Guide

This package adapts `@slipstream/core` to VS Code. Keep compression, artifact,
and policy semantics in `core`; this package owns VS Code registration, host
lifecycles, and UI integration.

- Do not access user storage outside the established core and extension helpers.
- Preserve request/model identity, cancellation, and explicit user consent for
  telemetry-related features.
- Keep webview messages and command inputs validated at the extension boundary.
- Exercise both host behavior and webview behavior when changing their contract.

Run focused checks from the repository root with:

```sh
npm run build --workspace slipstream-vscode
npm run test --workspace slipstream-vscode
```
