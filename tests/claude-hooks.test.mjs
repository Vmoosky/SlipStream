import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const settings = JSON.parse(readFileSync(resolve(root, '.claude/settings.json'), 'utf8'));
const bash =
  process.platform === 'win32'
    ? resolve(
        execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
        '../../../bin/bash.exe',
      )
    : 'bash';

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'slipstream-claude-hooks-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const project = join(directory, 'project with spaces');
  mkdirSync(join(project, '.claude/hooks'), { recursive: true });
  for (const script of ['block-dangerous-command.mjs', 'format-edited-file.mjs']) {
    copyFileSync(join(root, '.claude/hooks', script), join(project, '.claude/hooks', script));
  }
  copyFileSync(join(root, '.prettierrc.json'), join(project, '.prettierrc.json'));
  symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'junction');
  return { directory, project };
}

function runHook(event, toolInput, project, inputDirectory = project, rawInput) {
  const hook = settings.hooks[event][0].hooks[0];
  return spawnSync(bash, ['--noprofile', '--norc', '-c', hook.command], {
    cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    encoding: 'utf8',
    input:
      rawInput ??
      JSON.stringify({
        hook_event_name: event,
        tool_name: event === 'PreToolUse' ? 'Bash' : 'Write',
        cwd: inputDirectory,
        tool_input: toolInput,
      }),
    timeout: 35_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}

test('dangerous-command hook denies destructive shell commands through its configured command', (context) => {
  const { project } = fixture(context);
  for (const command of [
    'rm -rf build',
    'echo ok\nrm -rf build',
    'rm \\\n+      -rf build',
    'rm -r build',
    'rm -r -f build',
    'rm --recursive --force build',
    'Remove-Item -Recurse -Force build',
    'Remove-Item -Recurse build',
    'rm -Recurse -Force build',
    'git clean -fd',
    'git reset --hard HEAD',
    'git push origin main --force-with-lease',
    'git push -uf origin main',
  ]) {
    const result = runHook('PreToolUse', { command }, project);
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('dangerous-command hook leaves safe shell commands to normal permissions', (context) => {
  const { project } = fixture(context);
  const result = runHook('PreToolUse', { command: 'npm test' }, project);

  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  assert.equal(result.stdout, '');
});

test('dangerous-command hook denies invalid input', (context) => {
  const { project } = fixture(context);
  for (const input of ['{', '{}', '{"tool_input":{}}']) {
    const result = runHook('PreToolUse', undefined, project, project, input);
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('configured formatting hook formats an edited file in a project path with spaces', (context) => {
  const { project } = fixture(context);
  const target = join(project, 'edited file.mjs');
  writeFileSync(target, 'export const value={count:1};\n');
  const result = runHook('PostToolUse', { file_path: target }, project);
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  assert.equal(readFileSync(target, 'utf8'), 'export const value = { count: 1 };\n');
});

test('configured formatting hook leaves outside and unsupported files unchanged', (context) => {
  const { directory, project } = fixture(context);
  for (const target of [join(directory, 'outside.mjs'), join(project, 'unsupported.txt')]) {
    const source = 'export const value={count:1};\n';
    writeFileSync(target, source);
    const result = runHook('PostToolUse', { file_path: target }, project);
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
    assert.equal(readFileSync(target, 'utf8'), source);
  }
});

test('configured formatting hook rejects files reached through a symbolic link', (context) => {
  const { directory, project } = fixture(context);
  const outside = join(directory, 'outside');
  const link = join(project, 'linked');
  const source = 'export const value={count:1};\n';
  mkdirSync(outside);
  writeFileSync(join(outside, 'target.mjs'), source);
  try {
    symlinkSync(outside, link, 'junction');
  } catch (error) {
    if (error?.code === 'EPERM') context.skip('symbolic links require elevated Windows privileges');
    throw error;
  }

  const result = runHook('PostToolUse', { file_path: join(link, 'target.mjs') }, project);
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  assert.equal(readFileSync(join(outside, 'target.mjs'), 'utf8'), source);
});

test('configured formatting hook keeps the project root for nested working directories', (context) => {
  const { project } = fixture(context);
  const nested = join(project, 'nested');
  const target = join(nested, 'edited.mjs');
  mkdirSync(nested);
  writeFileSync(target, 'export const value={count:1};\n');

  const result = runHook('PostToolUse', { file_path: target }, project, nested);
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  assert.equal(readFileSync(target, 'utf8'), 'export const value = { count: 1 };\n');
});

test('configured formatting hook reports formatter failures without rewriting the file', (context) => {
  const { project } = fixture(context);
  const target = join(project, 'invalid.mjs');
  const source = 'export const = ;\n';
  writeFileSync(target, source);
  const result = runHook('PostToolUse', { file_path: target }, project);
  assert.equal(result.status, 2, `${result.error ?? ''}\n${result.stderr}`);
  assert.match(result.stderr, /Prettier failed/u);
  assert.equal(readFileSync(target, 'utf8'), source);
});

test('Claude settings register command blocking and edit formatting hooks', () => {
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'Edit|Write');
});
