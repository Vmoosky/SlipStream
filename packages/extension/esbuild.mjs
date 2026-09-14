import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');

// Bundle the core from source, not from its compiled dist. Resolving through
// the package main would silently ship whatever was last compiled, so a build
// that skipped `npm run build` would package stale engine code.
const here = path.dirname(fileURLToPath(import.meta.url));
const coreSource = path.join(here, '..', 'core', 'src', 'index.ts');

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  alias: { '@slipstream/core': coreSource },
};

const builds = [
  {
    ...shared,
    entryPoints: ['../hook-runtime/src/index.ts'],
    outfile: 'dist/chat-hook.js',
  },
  // The extension host loads this. `vscode` is provided by the host.
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  },
  // Shipped alongside so the extension can offer the same tools over MCP.
  {
    ...shared,
    entryPoints: ['../mcp-server/src/index.ts'],
    outfile: 'dist/mcp-server.js',
    external: [],
    banner: { js: '#!/usr/bin/env node' },
  },
];

if (watch) {
  await Promise.all(
    builds.map(async (options) => {
      const context = await esbuild.context(options);
      await context.watch();
    }),
  );
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
