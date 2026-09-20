# Documentation Agent Guide

This directory holds authored product documentation plus two of the repository's
three generated reference blocks, in [architecture](architecture.md) and the
[MCP reference](mcp.md).

- Generated blocks sit between `slipstream-reference` markers. Regenerate them
  with `npm run docs:write` and never hand-edit inside the markers.
- `npm run check:docs` is check-only. It validates generated blocks, local links
  and anchors, JSON examples, and npm commands across maintained Markdown.
- Authored prose outside the markers is ordinary reviewed documentation.
  Maintenance and remediation automation may only change generated blocks.
- Architecture decisions live under `adr/`. Supersede a merged decision with a
  new record rather than rewriting its history.
- Describe what the repository actually does. A configured workflow, a fixture,
  or a local run is not evidence of a verified production outcome.

Run focused checks from the repository root with:

```sh
npm run check:docs
npm run docs:write
```
