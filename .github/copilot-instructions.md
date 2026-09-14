# Copilot instructions for this workspace

Slipstream compresses tool output before it reaches the context window. It only
sees traffic that is routed through its own tools, so prefer them over the
built-in equivalents.

## Tool routing

- To run a build, test, lint or install command, use `slipstream_runCommand`
  (`#hrRun`) instead of the built-in terminal tool.
- To read a workspace file, use `slipstream_readFile` (`#hrRead`) instead of the
  built-in file reader.
- To expand content hidden behind a `[[slipstream:<id> L<start>-<end> ...]]`
  marker, use `slipstream_retrieveArtifact` (`#hrGet`). Nothing is lost, so
  expand instead of re-running a command.
- To report savings, use `slipstream_getSavings` (`#hrStats`).

## Calling `slipstream_runCommand`

Pass the bare executable in `command` and every argument separately in `args`.
Shell operators such as `&&`, `|`, `>` and `$()` are not supported, so run one
program per call.

Correct:

```json
{ "command": "npm", "args": ["test"] }
```

Incorrect:

```json
{ "command": "npm test" }
```

If a command is refused, read the returned message: it explains the rule that
was violated rather than failing silently.

## Development

Use the repository root: `npm ci`, `npm run build`, `npm run typecheck`, then
`npm test`. Keep core before its consumers in the workspace build order. Windows
Vitest pools are configured per workspace; do not forward Vitest flags through
the mixed-runner root test command.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for the full validation gates and
publication boundaries, and the [architecture map](../docs/architecture.md) for
package ownership. `npm run check:docs` is check-only; `npm run docs:write` updates
designated generated manifest references.

The [offline workload](../tests/fixtures/outcome-workload) is deliberately broken
test data. Only repair its scratch copy through `npm run outcome-proof`. Browser
tests create temporary servers; never use or reset the user's running dashboard.

Preserve workspace trust, approvals, cancellation, exact request/model identity,
and historical rate snapshots. Unknown usage is not zero. Offline measurements
and simulated policy decisions are not live-provider quality or billing evidence.
Do not publish source, change GitHub settings, install releases, or modify user
stores without explicit authorization.
