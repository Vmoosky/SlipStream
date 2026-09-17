import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_INPUT_BYTES = 16 * 1024;

function withinRoot(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function checkAgentSession({ root = ROOT, cwd, nodeVersion = process.versions.node }) {
  const repositoryRoot = fs.realpathSync.native(root);
  const workingDirectory = fs.realpathSync.native(cwd);
  if (!withinRoot(repositoryRoot, workingDirectory)) {
    throw new Error('Agent session working directory is outside the repository');
  }
  const pinnedNode = fs.readFileSync(path.join(repositoryRoot, '.node-version'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(pinnedNode)) throw new Error('Invalid .node-version pin');
  if (!fs.statSync(path.join(repositoryRoot, 'package-lock.json')).isFile()) {
    throw new Error('Missing package-lock.json');
  }
  const passed = nodeVersion === pinnedNode;
  return {
    schemaVersion: 1,
    kind: 'agent-session-check',
    passed,
    node: { current: nodeVersion, required: pinnedNode },
    workingDirectory: path.relative(repositoryRoot, workingDirectory).replaceAll('\\', '/') || '.',
  };
}

export function agentSessionContext(report) {
  return report.passed
    ? `Slipstream environment check: Node.js ${report.node.current} matches .node-version and the locked dependency manifest is present. Use npm ci for a clean install and npm run validate for full verification.`
    : `Slipstream environment check: Node.js ${report.node.current} does not match required ${report.node.required}. Select the pinned runtime before installing dependencies or validating changes.`;
}

export async function readHookInput(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('Agent hook input exceeds 16 KiB');
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.cwd !== 'string'
  ) {
    throw new Error('Invalid agent session hook input');
  }
  return input;
}

async function main() {
  try {
    const input = await readHookInput();
    const report = checkAgentSession({ cwd: input.cwd });
    console.log(JSON.stringify({ additionalContext: agentSessionContext(report) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
