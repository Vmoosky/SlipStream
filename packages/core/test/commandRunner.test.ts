import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertShellSafeArgs,
  CommandRejectedError,
  renderCommandLine,
  runCommand,
  validateCommand,
} from '../src/commandRunner.js';

vi.mock('node:child_process', { spy: true });

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cmd-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(childProcess.spawn).mockClear();
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
  it('renders a command label without executing or interpreting the arguments', () => {
    expect(renderCommandLine('node', ['script.js', 'value with spaces', 'a|b'])).toBe(
      'node script.js value with spaces a|b',
    );
    expect(renderCommandLine('node', [])).toBe('node');
  });

  it('rejects an allowlisted program that cannot be resolved on PATH', async () => {
    vi.stubEnv('PATH', '');
    await expect(runCommand({ ...base(), command: 'node' })).rejects.toThrow('was not found on PATH');
  });

  it('reports startup errors when the working directory is a file', async () => {
    const filename = path.join(workspace, 'not-a-directory');
    fs.writeFileSync(filename, 'temporary fixture');
    await expect(runCommand({ ...base(), cwd: filename, command: 'node', args: ['--version'] }))
      .rejects.toThrow('Failed to start "node"');
  });

  it.each([new Error('spawn ENOTDIR'), 'spawn ENOTDIR'])(
    'reports synchronous startup errors as command rejections (%#)',
    async (startupError) => {
      const spawnMock = vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
        throw startupError;
      });
      await expect(runCommand({ ...base(), command: 'node', args: ['--version'] }))
        .rejects.toMatchObject({
          name: 'CommandRejectedError',
          message: 'Failed to start "node": spawn ENOTDIR',
        });
      expect(spawnMock).toHaveBeenCalledOnce();
    },
  );

  it('reports asynchronous startup errors and removes the abort listener', async () => {
    const { ChildProcess } = await vi.importActual<typeof childProcess>('node:child_process');
    const child = new ChildProcess();
    vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = runCommand({ ...base(), command: 'node', signal: controller.signal });
    child.emit('error', new Error('spawn EACCES'));
    await expect(pending).rejects.toMatchObject({
      name: 'CommandRejectedError',
      message: 'Failed to start "node": spawn EACCES',
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('marks discarded output as truncated when the capture budget is zero', async () => {
    const result = await runCommand({
      ...base(), command: 'node', args: ['-e', 'console.log("output")'], maxOutputBytes: 0,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '', truncated: true, timedOut: false });
  });

  it('cancels an active process without reporting a timeout', async () => {
    const controller = new AbortController();
    const pending = runCommand({
      ...base(), command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('cancelled');
    expect(result.stderr).not.toContain('timeout');
  }, 20_000);

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
