# Hook Runtime Agent Guide

This package is the Copilot CLI hook and local daemon adapter around
`@slipstream/core`. Its stdin/stdout protocol and timeout behavior are part of
the CLI integration contract.

- Keep hook payload parsing defensive and bounded.
- Do not write diagnostics to stdout when stdout carries a hook response.
- Preserve daemon startup, session release, cancellation, and fail-open
  behavior; a hook failure must not block the host tool call.
- Model tracking is local and opt-in. Do not weaken its consent boundary.

Run focused checks from the repository root with:

```sh
npm run build --workspace @slipstream/hook-runtime
npm run test --workspace @slipstream/hook-runtime
```
