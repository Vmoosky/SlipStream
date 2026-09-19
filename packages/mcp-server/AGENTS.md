# MCP Server Agent Guide

This package exposes the core engine over stdio MCP. Keep its tool schema,
transport, and error behavior compatible with existing clients.

- Stdout is reserved for MCP protocol messages; send diagnostics to stderr.
- Validate every tool input and keep filesystem access within configured
  workspace roots.
- Keep retrieval-only mode free of tools that it does not actually provide.
- Do not move compression or artifact semantics out of `@slipstream/core`.

Run focused checks from the repository root with:

```sh
npm run build --workspace @slipstream/mcp-server
npm run test --workspace @slipstream/mcp-server
```
