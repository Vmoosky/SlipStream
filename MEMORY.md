# Repository Memory

Keep this file for durable facts that help an agent resume work safely. Read it
alongside `.github/copilot-instructions.md`, `CONTRIBUTING.md`, and the relevant
module `AGENTS.md` before changing code. Those documents remain authoritative
when they disagree with this memory.

## System Boundaries

- `packages/core` owns lossless compression, artifact retrieval, token-saving
  decisions, and durable local state. Host adapters must not reimplement those
  semantics.
- `packages/extension`, `packages/hook-runtime`, and `packages/mcp-server` are
  adapters over core for VS Code, Copilot CLI hooks, and stdio MCP.
- `packages/copilot-plugin` packages the hook and MCP entry points for Copilot
  CLI. Packaging metadata and built entry points are compatibility surfaces.
- `scripts/` contains trusted validation, documentation, maintenance, and
  governance automation. Changes there can affect required CI evidence.

## Non-Negotiable Invariants

- Omitted content remains byte-exact and retrievable; never replace it with an
  irreversible summary.
- Compression must pay for itself. Pass through output when compression does
  not make a meaningful saving.
- Treat tool output as untrusted. Preserve marker sanitisation and workspace
  path boundaries.
- Telemetry and retention failures must not break a tool call. Model tracking
  is local and opt-in.
- Preserve approval, provenance, cancellation, review, CI, and rollback
  safeguards. Do not weaken a control merely to make a check pass.

## Working Conventions

- Use the Node version pinned in `.node-version`.
- Run `npm run setup` for a fresh checkout and `npm run validate` for the full
  local gate. Use focused workspace tests while iterating.
- `npm run check:docs` checks generated documentation without modifying it;
  `npm run docs:write` updates only designated generated blocks.
- Browser tests start their own temporary loopback servers. Do not reuse or
  reset a user's running dashboard or local savings store.

## Memory Maintenance

- Record stable architecture decisions, safety constraints, and verified
  workflows that apply across sessions.
- Update or remove a memory entry when its source-of-truth contract changes.
- Do not record credentials, personal data, machine-specific paths, temporary
  task status, or unverified production outcomes.
