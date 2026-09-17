# MCP Artifact Retrieval v1

Contract ID: `slipstream.mcp.artifact-retrieval`. Contract version: **1**.
Status: implemented behavior, verified by executable examples.

This contract covers the MCP transport, not the similarly named native VS Code
tools. Runtime input schemas remain owned by the
[MCP server](../../../packages/mcp-server/src/index.ts). Examples below are test
data, not another runtime schema. The
[MCP smoke suite](../../../packages/mcp-server/test/smoke.test.ts) reads this
document and executes every example against both server modes.

## Requirements

### MCP-MODES

Standalone mode exposes command execution, file reading, artifact retrieval, and
savings. Retrieval-only mode exposes only retrieval and savings; it must not
advertise command execution or file reading. The
[Copilot plugin](../../../packages/copilot-plugin/.mcp.json) stays retrieval-only.
Tool annotations are hints, not authorization or a security sandbox.

### MCP-RANGE

Line ranges are 1-based and inclusive. Successful unfiltered results contain a
header followed by selected lines of the stored representation joined with LF.
This is not an unconditional raw-byte guarantee; see
[recovery boundaries](../../../docs/mcp.md#recovery-and-security). The header is
metadata, not part of the stored content. `maxLines` bounds the returned body;
the header explicitly reports truncation when matching lines remain. Its default
is 400 and its maximum is 5000.

### MCP-FILTER

`grep` filters the selected line range before applying `maxLines`. Literal
matching is case-insensitive. Slash-delimited regular expressions are also
supported. Each matching line is prefixed by its original 1-based line number
and `: `. No matches is a successful empty body, not a missing artifact.

### MCP-INPUT

`id` is required. Supplied line bounds and `maxLines` must be positive integers;
`maxLines` above 5000 is rejected. Protocol schema rejection is distinct from a
validly shaped request that fails during retrieval. Clients must inspect the
error result, not treat it as recovered content.

### MCP-UNAVAILABLE

Malformed artifact IDs and unavailable artifacts return errors. Availability is
bounded by retention, eviction, and explicit purge; this contract does not promise
indefinite recovery. Retrieval itself does not re-execute a command or re-read a
source file. Regeneration is a separate action requiring the usual authorization.

## Executable Examples

The test creates a temporary retained artifact with 300 lines. Source line 1 is
`needle-0 filler filler filler`, and source line 300 is
`needle-299 filler filler filler`. Only an argument whose `id` is exactly
`$artifact` is replaced with that fixture's actual ID. No command, module path,
or executable expression is read from this document.

```json slipstream-mcp-contract
{
  "contractId": "slipstream.mcp.artifact-retrieval",
  "version": 1,
  "modeRequirement": "MCP-MODES",
  "modes": {
    "standalone": ["get_savings", "read_file", "retrieve_artifact", "run_command"],
    "retrieval-only": ["get_savings", "retrieve_artifact"]
  },
  "examples": [
    {
      "id": "inclusive-range",
      "requirement": "MCP-RANGE",
      "arguments": { "id": "$artifact", "startLine": 149, "endLine": 151 },
      "expected": {
        "body": "needle-148 filler filler filler\nneedle-149 filler filler filler\nneedle-150 filler filler filler",
        "truncated": false
      }
    },
    {
      "id": "bounded-range",
      "requirement": "MCP-RANGE",
      "arguments": { "id": "$artifact", "startLine": 149, "endLine": 151, "maxLines": 1 },
      "expected": { "body": "needle-148 filler filler filler", "truncated": true }
    },
    {
      "id": "literal-filter",
      "requirement": "MCP-FILTER",
      "arguments": { "id": "$artifact", "grep": "NEEDLE-150 " },
      "expected": { "body": "151: needle-150 filler filler filler", "truncated": false }
    },
    {
      "id": "regex-filter",
      "requirement": "MCP-FILTER",
      "arguments": { "id": "$artifact", "grep": "/^needle-15[01] /" },
      "expected": {
        "body": "151: needle-150 filler filler filler\n152: needle-151 filler filler filler",
        "truncated": false
      }
    },
    {
      "id": "empty-filter",
      "requirement": "MCP-FILTER",
      "arguments": { "id": "$artifact", "grep": "absent-spec-sentinel" },
      "expected": { "body": "", "truncated": false }
    },
    {
      "id": "missing-id",
      "requirement": "MCP-INPUT",
      "arguments": {},
      "expected": { "error": "id" }
    },
    {
      "id": "zero-start",
      "requirement": "MCP-INPUT",
      "arguments": { "id": "$artifact", "startLine": 0 },
      "expected": { "error": "startLine" }
    },
    {
      "id": "fractional-end",
      "requirement": "MCP-INPUT",
      "arguments": { "id": "$artifact", "endLine": 3.5 },
      "expected": { "error": "endLine" }
    },
    {
      "id": "excessive-limit",
      "requirement": "MCP-INPUT",
      "arguments": { "id": "$artifact", "maxLines": 5001 },
      "expected": { "error": "maxLines" }
    },
    {
      "id": "malformed-id",
      "requirement": "MCP-UNAVAILABLE",
      "arguments": { "id": "../invalid" },
      "expected": { "error": "not a valid artifact id" }
    },
    {
      "id": "unavailable-id",
      "requirement": "MCP-UNAVAILABLE",
      "arguments": { "id": "000000000000" },
      "expected": { "error": "no longer available" }
    }
  ]
}
```

## Change Policy

Keep requirement IDs stable. Correct a demonstrated mismatch with a regression
test and an explicitly reviewed specification change. Do not regenerate expected
results from the implementation to make failures disappear. A deliberate breaking
contract needs a new version and an explicit compatibility decision; a package
release does not automatically change this contract's version.

Use `npm run check:docs` for document validation and
`npm run test --workspace @slipstream/mcp-server` for executable conformance after
building. `npm run docs:write` only updates designated generated references; it
must not rewrite these normative examples. Passing these local tests is not
evidence of live-provider quality, billing accuracy, or an autonomous repair loop.
