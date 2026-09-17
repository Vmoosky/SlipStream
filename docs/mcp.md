# MCP Integration

## Canonical Metadata

The root [server.json](../server.json) follows the official MCP Registry
2025-12-11 server schema. It describes this source checkout, not a published
package or hosted endpoint. `local.slipstream/slipstream` is a local placeholder,
not an ownership-verified registry identity. No npm package or remote MCP service
is advertised. Publication requires a confirmed namespace and release artifact.

Checkout-specific launch metadata lives under
`_meta["io.modelcontextprotocol.registry/publisher-provided"].localInstall`.
This is Slipstream-specific metadata, not an MCP client configuration format.
Consumers must resolve `{repoRoot}` and `{workspaceRoot}` to absolute paths,
pass arguments separately, and obtain user approval before installing dependencies
or running commands. Generic clients need the configuration shown below.

[llms.txt](../llms.txt) is the short agent-readable documentation index.

## Local Installation

Prerequisite: Node.js 20 or newer with npm. From the Slipstream checkout:

```sh
npm install
npm run build
```

For VS Code, add a server entry to its MCP configuration, replacing both paths:

```json
{
  "servers": {
    "slipstream": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/slipstream/packages/mcp-server/dist/index.js",
        "--root",
        "/absolute/path/to/workspace"
      ]
    }
  }
}
```

On Windows use absolute drive paths, with forward slashes or JSON-escaped
backslashes. Other clients may use `mcpServers` instead of `servers`; use the same
command and argument array in the client's documented format. No API key is
required. Protocol traffic uses stdout; diagnostics use stderr.

## Modes and Tool Discovery

| Mode | Tools | Purpose |
| --- | --- | --- |
| Standalone (default) | `run_command`, `read_file`, `retrieve_artifact`, `get_savings` | Explicitly route commands and reads through compression. |
| `--retrieval-only` | `retrieve_artifact`, `get_savings` | Recover artifacts and inspect savings when a hook already compresses output. |

The Copilot CLI plugin already selects retrieval-only mode in its
[MCP configuration](../packages/copilot-plugin/.mcp.json). Install it using
`npm run install:copilot-plugin` as described in the
[quick start](../README.md#quick-start-github-copilot-cli); do not add a duplicate
standalone server for the same workflow.

MCP `initialize` supplies runtime server identity/version. Call `tools/list` on
that server for authoritative descriptions, input schemas, and annotations.
The manifest records only tool names per mode; it does not duplicate schemas.

- `run_command`: bare executable plus an argument array, optional working directory
  and timeout. This executes real commands and is not read-only.
- `read_file`: an absolute workspace file path; subsequent reads may return a diff
  or unchanged-content marker.
- `retrieve_artifact`: artifact ID plus optional line range, grep filter, and page
  limit. Follow the ID/range in an emitted marker rather than guessing handles.
- `get_savings`: no parameters; reports measured savings from the shared ledger.

## Configuration

| Input | Behavior |
| --- | --- |
| `--root PATH` | Repeat for each allowed workspace. Defaults to process cwd when no roots are provided. |
| `SLIPSTREAM_WORKSPACE_ROOTS` | Additional roots separated by the platform path delimiter (`;` on Windows, `:` on Unix). |
| `--storage PATH` | Artifact/ledger directory; overrides `SLIPSTREAM_HOME`, then defaults to `~/.slipstream`. |
| `--label TEXT` | Producer label; otherwise `SLIPSTREAM_SESSION_LABEL`, then a workspace-derived label. |
| `--retrieval-only` | Expose only recovery and savings tools. |
| `--dashboard [PORT]` | Optional loopback dashboard; also enabled by `SLIPSTREAM_DASHBOARD=1`. Default port 7331 or `SLIPSTREAM_DASHBOARD_PORT`. This is not an MCP HTTP transport. |
| `SLIPSTREAM_ALLOWED_COMMANDS` | Comma-separated executable allowlist; otherwise built-in policy. |
| `SLIPSTREAM_ENABLED=0` | Disable compression. |
| `SLIPSTREAM_USD_PER_MILLION` | Default input rate in USD per million tokens, used in manual mode or for estimates with missing recorded rates. Default 3; zero is allowed. |
| `SLIPSTREAM_PRICING_MODE` | `automatic`, `manual` (standalone default), or `catalog`. Automatic/catalog modes cache Models.dev rates in the background. MCP events without request identity retain unavailable model-rate snapshots, while totals use the configured fallback. |
| `SLIPSTREAM_PRICING_PROVIDER`, `SLIPSTREAM_PRICING_MODEL` | Exact provider/model pair required in catalog mode. |
| `SLIPSTREAM_PRICING_INPUT_OVERRIDE` | Optional nonnegative input rate override; unset or empty restores catalog pricing. |

The VS Code-managed MCP server uses automatic mode, ignores inherited model
selections, and receives the `slipstream.usdPerMillionTokens` fallback setting.
For dynamic request-model detection, use the separate
`@slipstream` participant. See [automatic pricing](pricing.md) for cache behavior,
producer scope, and recorded/fallback estimate breakdowns. Prices are not Copilot billing.

CLI plugin and standalone clients must use the same storage directory to recover
each other's artifacts. Dashboard-local config is not a global configuration
channel for every MCP producer. Compression profiles are available through the
engine API and dashboard; no standalone `--profile` flag is currently supported.

## Recovery and Security

Retrieval returns ranges of the stored representation, while it remains available.
Default retention is 60 idle minutes, at most 2,000 entries and 256 MiB; eviction
or explicit purge can remove artifacts sooner. Regenerate unavailable content by
rerunning its command or rereading its file.

Line omissions are recoverable as stored text. Do not promise unconditional raw
byte recovery: JSON is pretty-printed, ANSI escapes are removed, forged markers
are sanitized, and folded paths use a legend. JSON preserves data semantics;
path folding can be expanded using the legend or the core `expandPrefixFold`
helper. File reads are UTF-8 text, not arbitrary binary-file retrieval.

Reads are workspace-scoped and subject to secret-path restrictions. Commands use
an executable allowlist and argument validation, but can still change files or
perform other real operations. Treat tool annotations as hints, not a sandbox.
Artifacts contain tool output; use an appropriate local storage location and
permissions. See [Security](../README.md#security) for implementation boundaries.

## Validation

After building, run the MCP smoke suite to compare live discovery with the
manifest and package version, and to validate metadata and documentation links:

The [artifact retrieval v1 specification](../specs/mcp/v1/artifact-retrieval.md)
defines stable requirement IDs and data-only conformance examples. The smoke
suite executes those examples against both standalone and retrieval-only servers
using temporary storage. Runtime schemas remain authoritative; examples assert
observable compatibility rather than defining a second schema.

For a contract change, select the manually invoked
[Spec Maintainer](../.github/agents/spec-maintainer.agent.md) in Copilot's agent
picker with the Slipstream folder open as a workspace and its VS Code extension
available. It uses the existing compressing tools, does not select a model or
delegate work, and stops if its tools are missing. Opening only a parent folder
may not discover repository-local agents. No installation or settings change is
performed by this workflow. The CLI plugin remains retrieval-only.

`npm run check:docs` checks spec identity, requirement/example coverage, mode
inventory, agent frontmatter, and extension tool references. Missing specs,
uncovered requirements, invalid configuration, and renamed tools fail the gate.
This validates repository configuration, not editor runtime discovery or model
availability. Normative examples are reviewed edits, never `docs:write` output.

Schema validation uses AJV and the unmodified, pinned official schema fixture
`packages/mcp-server/test/fixtures/mcp-server-2025-12-11.schema.json`, downloaded
from the manifest's `$schema` URL. Tests do not fetch schemas over the network.

```sh
npm test --workspace @slipstream/mcp-server
```

On the Windows environment where the default Vitest pool fails to initialize,
append `-- --pool=vmThreads`.

<!-- slipstream-reference:mcp:start -->
## MCP Launch Reference

Generated from the public manifests by `npm run docs:write`. Check with `npm run check:docs`.

Registry identity: local.slipstream/slipstream. Distribution: local-source-only.

| Surface | Command | Arguments |
| --- | --- | --- |
| Local source | node | {repoRoot}/packages/mcp-server/dist/index.js --root {workspaceRoot} |
| Plugin: slipstream | node | ${PLUGIN_ROOT}/dist/mcp-server.js --retrieval-only --label Copilot CLI hook |

| Mode | Additional Arguments | Tools |
| --- | --- | --- |
| standalone |  | get_savings, read_file, retrieve_artifact, run_command |
| retrieval-only | --retrieval-only | get_savings, retrieve_artifact |

<!-- source-sha256: 50e353f3e7dd04f0984ba0a0e3c2ccea4d35d994bebebe7d3761bd0458e9b381 -->
<!-- slipstream-reference:mcp:end -->
