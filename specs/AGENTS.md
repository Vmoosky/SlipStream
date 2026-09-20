# Specifications Agent Guide

This directory holds versioned, executable contracts. The
[MCP artifact retrieval contract](mcp/v1/artifact-retrieval.md) is read and run
by the MCP smoke suite, so its examples are test data rather than prose.

- Examples are normative and are never regenerated from observed runtime
  behavior. When the implementation and a contract disagree, change one of them
  deliberately under review.
- Keep example identifiers unique and their declared requirements and expected
  results unambiguous. Drift fails the checker instead of rewriting the
  document.
- Advertised mode inventories must match the server. Adding or removing a tool
  requires the contract change in the same change set.
- Release a breaking contract change as a new version directory. Do not edit a
  published version in place.

Run focused checks from the repository root with:

```sh
npm run check:docs
npm run test --workspace @slipstream/mcp-server
```
