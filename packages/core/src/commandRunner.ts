import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isWithinRoots } from './security/paths.js';

/**
 * Executables the model is allowed to run. Anything not on this list is
 * refused, so a hostile instruction embedded in a file cannot reach, say,
 * `curl` or `powershell`.
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'jest', 'vitest', 'eslint',
  'cargo', 'rustc', 'go', 'python', 'python3', 'pytest', 'uv',
  'dotnet', 'mvn', 'gradle', 'make', 'git', 'rg', 'ruff', 'black',
];

/** Characters that would change meaning if the shell ever sees them. */
const SHELL_METACHARACTERS = /[&|;<>^`$(){}[\]!\n\r"'\\]/;
const EXECUTABLE_NAME = /^[A-Za-z0-9._-]+$/;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface RunCommandOptions {
  /** Bare executable name, e.g. `npm`. Never a path. */
  command: string;
  args?: readonly string[];
  cwd: string;
  workspaceRoots: readonly string[];
  allowedCommands?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Abort the command early, e.g. when the model's request is cancelled. */
  signal?: AbortSignal;
}

export interface RunCommandResult {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export class CommandRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandRejectedError';
  }
}

/**
 * Validate a model-proposed command without running it.
 * Returns the argv that would be executed.
 */
export function validateCommand(options: RunCommandOptions): { command: string; args: string[]; cwd: string } {
  const allowed = options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
  const command = String(options.command ?? '').trim();

  if (!EXECUTABLE_NAME.test(command)) {
    throw new CommandRejectedError(
      `"${command}" is not a bare executable name. Pass the program in "command" ` +
        `(for example "npm") and every argument separately in "args".`,
    );
  }
  if (!allowed.some((entry) => entry.toLowerCase() === command.toLowerCase())) {
    throw new CommandRejectedError(
      `"${command}" is not in the allowed command list. Allowed: ${allowed.join(', ')}. ` +
        `Use the built-in terminal tool if you genuinely need another program.`,
    );
  }

  const args = (options.args ?? []).map((arg, index) => {
    const value = String(arg);
    if (value.includes('\0')) {
      throw new CommandRejectedError(`Argument ${index} contains a null byte.`);
    }
    return value;
  });

  const cwd = path.resolve(options.cwd);
  if (!isWithinRoots(cwd, options.workspaceRoots)) {
    throw new CommandRejectedError(
      `Refusing to run in "${cwd}": it is outside the open workspace folders.`,
    );
  }
  if (!fs.existsSync(cwd)) {
    throw new CommandRejectedError(`Working directory "${cwd}" does not exist.`);
  }

  return { command, args, cwd };
}

export function renderCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

/**
 * Reject arguments that would change meaning once a shell parses them.
 *
 * Only needed on the Windows `.cmd`/`.bat` path. When `shell: false` the argv
 * array is handed to the OS unparsed, so metacharacters are inert there and
 * filtering them would only break legitimate arguments such as
 * `--testPathPattern=a|b`.
 */
export function assertShellSafeArgs(args: readonly string[]): void {
  args.forEach((value, index) => {
    if (SHELL_METACHARACTERS.test(value)) {
      throw new CommandRejectedError(
        `Argument ${index} (${JSON.stringify(value)}) contains shell metacharacters and this ` +
          `program runs through a Windows shell wrapper. Remove the metacharacters, or run the ` +
          `underlying executable directly.`,
      );
    }
  });
}

/**
 * Run an allowlisted command and capture its output.
 *
 * Arguments are passed as an array with `shell: false`, so nothing is ever
 * re-parsed by a shell. The one exception is Windows `.cmd`/`.bat` shims
 * (`npm`, `yarn`, ...), which Node refuses to spawn without a shell; those
 * still go through the metacharacter validation above, so the argv cannot
 * introduce new shell syntax.
 */
export async function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const { command, args, cwd } = validateCommand(options);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const resolved = resolveExecutable(command);
  if (!resolved) {
    throw new CommandRejectedError(
      `"${command}" was not found on PATH. Make sure it is installed and available.`,
    );
  }
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
  if (needsShell) {
    assertShellSafeArgs(args);
  }

  const started = Date.now();
  return await new Promise<RunCommandResult>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(needsShell ? command : resolved, args, {
        cwd,
        shell: needsShell,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(new CommandRejectedError(`Failed to start "${command}": ${message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    const capture = (chunk: Buffer, sink: 'out' | 'err'): void => {
      if (bytes >= maxOutputBytes) {
        truncated = true;
        return;
      }
      bytes += chunk.length;
      const text = chunk.toString('utf8');
      if (sink === 'out') {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const onAbort = (): void => {
      cancelled = true;
      killTree(child.pid);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new CommandRejectedError(`Failed to start "${command}": ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (timedOut) {
        stderr += `\n--- slipstream: killed after ${timeoutMs / 1000}s timeout ---`;
      } else if (cancelled) {
        stderr += `\n--- slipstream: cancelled ---`;
      }
      resolve({
        command,
        args,
        cwd,
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    });
  });
}

/** Locate an executable on PATH, honouring PATHEXT on Windows. */
export function resolveExecutable(name: string): string | undefined {
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

function killTree(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
