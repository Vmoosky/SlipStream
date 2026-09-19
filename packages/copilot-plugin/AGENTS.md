# Copilot Plugin Agent Guide

This package builds the installable Copilot CLI plugin that bundles the hook
runtime and MCP entry points.

- Keep plugin manifests and bundled entry points aligned with the built output.
- Preserve the retrieval-only contract: the plugin must not advertise tools it
  does not register.
- Treat packaging changes as compatibility-sensitive because they affect
  installed users outside this checkout.
- Validate the package manifest after changing plugin metadata or build inputs.

Run focused checks from the repository root with:

```sh
npm run build --workspace @slipstream/copilot-plugin
npm run test --workspace @slipstream/copilot-plugin
```
