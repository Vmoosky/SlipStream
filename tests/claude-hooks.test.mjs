import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const blocker = resolve(root, '.claude/hooks/block-dangerous-command.mjs');

function runBlocker(command) {
  return spawnSync(process.execPath, [blocker], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify({ tool_input: { command } }),
  });
}

test('dangerous-command hook denies destructive shell commands', () => {
  for (const command of [
    'rm -rf build',
    'Remove-Item -Recurse -Force build',
    'git clean -fd',
    'git reset --hard HEAD',
    'git push origin main --force-with-lease',
  ]) {
    const result = runBlocker(command);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('dangerous-command hook leaves safe shell commands to normal permissions', () => {
  const result = runBlocker('npm test');

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('Claude settings register command blocking and edit formatting hooks', () => {
  const settings = JSON.parse(readFileSync(resolve(root, '.claude/settings.json'), 'utf8'));

  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
  assert.equal(settings.hooks.PostToolUse[0].matcher, 'Edit|Write');
});
