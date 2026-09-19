# Core Agent Guide

`core` owns the compression engine and must not depend on VS Code, Copilot CLI,
or MCP host APIs. Keep host-specific wiring in adapter packages.

- Preserve losslessness: omitted bytes must remain retrievable exactly.
- Preserve the pay-for-itself rule: return raw output when compression is not
  meaningfully smaller.
- Treat tool output as untrusted and preserve marker-sanitisation boundaries.
- Telemetry, ledger, and retention failures must never fail a tool call.

Run focused checks from the repository root with:

```sh
npm run build --workspace @slipstream/core
npm run test --workspace @slipstream/core
```
