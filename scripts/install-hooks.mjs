import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import husky from 'husky';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HOOKS_PATH = '.husky/_';

function git(root, args, optional = false) {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  if (optional && result.status === 1 && !result.stdout) return '';
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? (result.stderr.trim() || 'Git hook setup failed'));
  }
  return result.stdout;
}

function configuredHooks(root, local = false) {
  const output = git(
    root,
    ['config', '--null', ...(local ? ['--local'] : []), '--get-all', 'core.hooksPath'],
    true,
  );
  return output === '' ? [] : output.slice(0, -1).split('\0');
}

export function installHooks(root = ROOT) {
  if (process.env.HUSKY === '0') throw new Error('HUSKY=0 disables hook installation');
  const topLevel = git(root, ['rev-parse', '--show-toplevel']).trim();
  const resolvedRoot = fs.realpathSync.native(root);
  if (path.relative(resolvedRoot, fs.realpathSync.native(topLevel)) !== '') {
    throw new Error(
      'Run npm run hooks:install from the repository root; Git resolved a different root',
    );
  }
  if (path.relative(resolvedRoot, fs.realpathSync.native(process.cwd())) !== '') {
    throw new Error(
      'Run npm run hooks:install from the repository root; npm changed its working directory',
    );
  }
  const configured = configuredHooks(root);
  const local = configuredHooks(root, true);
  if (configured.some((value) => value !== HOOKS_PATH)) {
    throw new Error('Existing core.hooksPath is not managed by Slipstream; leave it unchanged');
  }
  const optedIn = local.length === 1 && local[0] === HOOKS_PATH;
  if (configured.length > 0 && !optedIn) {
    throw new Error('Existing inherited core.hooksPath is not managed by Slipstream');
  }
  const gitDirectory = git(root, ['rev-parse', '--absolute-git-dir']).trim();
  const commonDirectory = git(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim();
  if (
    path.relative(fs.realpathSync.native(gitDirectory), fs.realpathSync.native(commonDirectory)) !==
      '' &&
    !optedIn
  ) {
    throw new Error(
      'Install from the primary checkout first; core.hooksPath is shared by worktrees',
    );
  }
  const nativeHooks = path.join(commonDirectory, 'hooks');
  if (
    fs.existsSync(nativeHooks) &&
    fs.readdirSync(nativeHooks).some((name) => !name.endsWith('.sample'))
  ) {
    throw new Error('Existing native Git hooks must be retained; leave them unchanged');
  }
  const generatedHooks = path.join(root, HOOKS_PATH);
  if (fs.existsSync(generatedHooks) && !optedIn) {
    throw new Error('Existing generated hooks are not managed by this installation');
  }
  const result = husky('.husky');
  if (result) throw new Error(result);
  if (
    configuredHooks(root, true).join('\0') !== HOOKS_PATH ||
    !fs.existsSync(path.join(generatedHooks, 'pre-commit'))
  ) {
    throw new Error('Git hook installation did not complete');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    installHooks();
    console.log('Slipstream pre-commit checks installed for this checkout');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
