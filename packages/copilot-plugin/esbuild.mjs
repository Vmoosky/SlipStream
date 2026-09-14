import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  define: {
    __SLIPSTREAM_VERSION__: JSON.stringify(pkg.version),
  },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(here, '..', 'hook-runtime', 'src', 'index.ts')],
    outfile: path.join(dist, 'hook.js'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(here, '..', 'mcp-server', 'src', 'index.ts')],
    outfile: path.join(dist, 'mcp-server.js'),
  }),
]);
