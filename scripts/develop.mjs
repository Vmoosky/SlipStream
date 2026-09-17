import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function developmentPlan(root, mode, nodeVersion = process.versions.node) {
  if (!['setup', 'validate', 'precommit'].includes(mode)) {
    throw new Error('Expected setup, validate, or precommit');
  }
  const pinned = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) throw new Error('Invalid .node-version pin');
  if (nodeVersion !== pinned) {
    throw new Error(`Use Node.js ${pinned} from .node-version; current version is ${nodeVersion}`);
  }
  if (mode === 'precommit')
    return [
      ['run', 'lint'],
      ['run', 'format:check'],
    ];
  return mode === 'setup'
    ? [['ci'], ['run', 'build'], ['exec', '--', 'playwright', 'install', 'chromium']]
    : [
        ['run', 'build'],
        ['run', 'typecheck'],
        ['test'],
        ['run', 'lint'],
        ['run', 'format:check'],
        ['run', 'check:docs', '--', '--report', 'test-results/docs.json'],
        ['run', 'test:e2e'],
        [
          'run',
          'outcome-proof',
          '--',
          '--runs',
          '5',
          '--json',
          '--out',
          'test-results/outcome-proof.json',
        ],
        ['run', 'package:extension'],
      ];
}

export function runDevelopmentCommand(command, args, { cwd, signal, timeoutMs = 600_000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    return Promise.reject(new Error('Development command timeout must be between 1 and 600000 ms'));
  }
  if (signal?.aborted) return Promise.reject(new Error('Development command cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let failure;
    const stop = (message, exitCode) => {
      if (failure) return;
      failure = Object.assign(new Error(message), { exitCode });
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const stopped = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5_000,
        });
        if (stopped.status !== 0) child.kill('SIGKILL');
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const abort = () => stop('Development command cancelled', 130);
    const deadline = setTimeout(() => stop('Development command timed out', 1), timeoutMs);
    deadline.unref();
    const cleanup = () => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, terminatedBy) => {
      cleanup();
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else {
        reject(
          Object.assign(new Error(`Development command failed (${terminatedBy ?? code})`), {
            exitCode: code || 1,
          }),
        );
      }
    });
    if (signal?.aborted) abort();
  });
}

export async function runDevelopment(
  root,
  mode,
  {
    nodeVersion = process.versions.node,
    npmCli = process.env.npm_execpath,
    signal,
    runCommand = runDevelopmentCommand,
    log = console.log,
  } = {},
) {
  const commands = developmentPlan(root, mode, nodeVersion);
  if (!npmCli || !path.isAbsolute(npmCli) || !fs.existsSync(npmCli)) {
    throw new Error(
      'Invoke this runner with npm run setup, npm run validate, or npm run precommit',
    );
  }
  if (signal?.aborted) throw new Error('Development command cancelled');
  await runCommand('git', ['--version'], { cwd: root, signal, timeoutMs: 10_000 });
  await runCommand(process.execPath, [npmCli, '--version'], {
    cwd: root,
    signal,
    timeoutMs: 10_000,
  });
  for (const args of commands) {
    if (signal?.aborted) throw new Error('Development command cancelled');
    log(`\n> npm ${args.join(' ')}`);
    await runCommand(process.execPath, [npmCli, ...args], { cwd: root, signal });
  }
  return { mode, nodeVersion, commands: commands.length };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('Usage: npm run setup | npm run validate | npm run precommit');
    return;
  }
  if (positionals.length !== 1) {
    throw new Error('Expected exactly one mode: setup, validate, or precommit');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const result = await runDevelopment(ROOT, positionals[0], { signal: controller.signal });
    console.log(`\n${result.mode}: all ${result.commands} commands passed`);
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
