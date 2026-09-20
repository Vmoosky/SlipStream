import { fileURLToPath } from 'node:url';
import { runNpmQuiet } from './run-quiet.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

try {
  await runNpmQuiet(['run', 'setup'], { cwd: ROOT });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
