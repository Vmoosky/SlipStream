#!/usr/bin/env node
import { spawn } from 'node:child_process';

import { runDaemon, sendRequest } from './daemon.js';
import { formatDoctorReport, runDoctor } from './doctor.js';
import { defaultStorageDir, HookSessionManager } from './hook.js';
import { disableTracking, enableTracking, formatEnv, readConnection, type Shell } from './modelTracking.js';
import { handleVscodeHook } from './vscode.js';
import type { DaemonRequest, DaemonResponse } from './protocol.js';
import { parsePostToolUseInput, parseUserPromptSubmittedInput } from './protocol.js';

import { formatUpdateNotice, isCompressionProfile, maybeCheckForUpdate, pricingFromEnvironment } from '@slipstream/core';

declare const __SLIPSTREAM_VERSION__: string | undefined;

const SLIPSTREAM_VERSION =
  typeof __SLIPSTREAM_VERSION__ !== 'undefined' ? __SLIPSTREAM_VERSION__ : '0.0.0';

const MAX_STDIN_BYTES = 64 * 1024 * 1024;

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'post-tool-use';
  if (mode === 'daemon') {
    await runDaemon();
    return;
  }

  if (mode === 'doctor') {
    const report = await runDoctor();
    process.stdout.write(formatDoctorReport(report));
    const notice = await maybeCheckForUpdate({
      currentVersion: SLIPSTREAM_VERSION,
      stateDir: defaultStorageDir(),
    });
    if (notice) {
      process.stdout.write(`\n${formatUpdateNotice(notice)}\n`);
    }
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (mode === 'model-tracking') {
    await runModelTracking(process.argv.slice(3));
    return;
  }

  if (mode === 'reset' || mode === 'purge') {
    await runMaintenance(mode);
    return;
  }

  const raw = await readStdin();
  const parsed = JSON.parse(raw || '{}') as unknown;
  if (mode === 'vscode') {
    let policy: unknown;
    try { policy = process.env.SLIPSTREAM_NATIVE_POLICY ? JSON.parse(process.env.SLIPSTREAM_NATIVE_POLICY) : undefined; }
    catch { policy = null; }
    const profile = process.env.SLIPSTREAM_NATIVE_PROFILE;
    process.stdout.write(JSON.stringify(handleVscodeHook(parsed, { storageDir: defaultStorageDir(), cwd: process.env.SLIPSTREAM_WORKSPACE_ROOT,
      policy, profile: isCompressionProfile(profile) ? profile : undefined })));
    return;
  }
  const request: DaemonRequest =
    mode === 'session-end'
      ? {
          type: 'release',
          sessionId: String((parsed as Record<string, unknown>)['sessionId'] ?? ''),
        }
      : mode === 'user-prompt-submitted'
        ? { type: 'chat', input: parseUserPromptSubmittedInput(parsed), producerPricing: pricingFromEnvironment(process.env) }
      : { type: 'compress', input: parsePostToolUseInput(parsed), producerPricing: pricingFromEnvironment(process.env) };

  const response = await sendWithStartup(request);
  if (!response.ok) {
    throw new Error(response.error);
  }
  process.stdout.write(JSON.stringify('output' in response ? response.output : {}));
}

/**
 * Poll budget for a cold daemon start: 70 × 50 ms = 3.5 s.
 *
 * The daemon now binds the telemetry receiver before it accepts on the pipe, so
 * a cold start costs ~1 s (node startup, ledger load, port bind). The budget
 * must clear that comfortably while staying inside the 5 s `userPromptSubmitted`
 * hook timeout declared in `hooks.json`.
 */
const DAEMON_START_ATTEMPTS = 70;
const DAEMON_START_POLL_MS = 50;

async function sendWithStartup(request: DaemonRequest): Promise<DaemonResponse> {
  try {
    return await sendRequest(request);
  } catch {
    startDaemon();
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < DAEMON_START_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, DAEMON_START_POLL_MS));
    try {
      return await sendRequest(request);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Slipstream hook daemon did not start.');
}

function startDaemon(): void {
  const child = spawn(process.execPath, [__filename, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/**
 * `slipstream model-tracking <enable|disable|status|env>` — opt-in local model
 * tracking for a Copilot CLI install with no VS Code.
 *
 * Copilot reads its OpenTelemetry exporter configuration from environment
 * variables at process start, so this command manages consent + the local
 * receiver and prints the exporter environment for the shell that launches
 * `copilot`. Nothing is captured until `enable` records consent.
 */
async function runModelTracking(args: readonly string[]): Promise<void> {
  const storageDir = defaultStorageDir();
  const sub = args[0] ?? 'status';

  if (sub === 'enable') {
    enableTracking(storageDir);
    const port = await syncModelTrackingPort();
    process.stdout.write(ENABLE_NOTICE);
    const connection = readConnection(storageDir);
    if (port > 0 && connection) {
      process.stdout.write(`\n${renderEnvBlock(connection, defaultShell())}\n`);
    } else {
      process.stdout.write(
        '\nThe local receiver is starting. Run a Copilot tool call once, then\n' +
          '`slipstream model-tracking env` to print the exporter variables.\n',
      );
    }
    return;
  }

  if (sub === 'disable') {
    disableTracking(storageDir);
    await syncModelTrackingPort().catch(() => 0);
    process.stdout.write(
      'Local model tracking disabled. Existing observations are kept.\n' +
        'Remove the COPILOT_OTEL_* / OTEL_EXPORTER_OTLP_* exporter variables from\n' +
        'the shell that launches Copilot to stop it exporting telemetry.\n',
    );
    return;
  }

  if (sub === 'status') {
    const connection = readConnection(storageDir);
    if (!connection || !connection.consented) {
      process.stdout.write('Local model tracking is off. Enable it with `slipstream model-tracking enable`.\n');
      return;
    }
    const endpoint = connection.port > 0 ? `http://127.0.0.1:${connection.port}` : '(not yet bound)';
    process.stdout.write(`Local model tracking: consented\nReceiver endpoint: ${endpoint}\n`);
    return;
  }

  if (sub === 'env') {
    let connection = readConnection(storageDir);
    if (!connection || !connection.consented) {
      process.stderr.write('Local model tracking is not enabled. Run `slipstream model-tracking enable` first.\n');
      process.exitCode = 1;
      return;
    }
    if (connection.port === 0) {
      await syncModelTrackingPort().catch(() => 0);
      connection = readConnection(storageDir) ?? connection;
    }
    const shell = parseShell(args[1]) ?? defaultShell();
    const block = formatEnv(connection, shell);
    if (!block) {
      process.stderr.write('The local receiver has not bound a port yet. Start Copilot once, then retry.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${block}\n`);
    return;
  }

  process.stderr.write('Usage: slipstream model-tracking <enable|disable|status|env [bash|powershell]>\n');
  process.exitCode = 1;
}

/**
 * `slipstream reset` and `slipstream purge` — maintenance commands with no VS
 * Code required.
 *
 * `reset` forgets what the model has already been shown so the next read is full
 * again, keeping artifacts. `purge` additionally deletes every stored artifact
 * and clears the shared dedup index. When the daemon is running the request is
 * routed to it so live sessions stay consistent; otherwise the effect is applied
 * directly to the shared storage.
 */
async function runMaintenance(mode: 'reset' | 'purge'): Promise<void> {
  const request: DaemonRequest = mode === 'reset' ? { type: 'reset' } : { type: 'purge' };
  let response: DaemonResponse;
  try {
    response = await sendRequest(request);
    // A daemon from an older build won't understand the request; apply the
    // change directly to the shared storage rather than reporting its error.
    if (!response.ok) response = applyMaintenanceLocally(mode);
  } catch {
    response = applyMaintenanceLocally(mode);
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  if (mode === 'reset' && 'reset' in response) {
    const count = response.reset.sessions;
    process.stdout.write(
      count > 0
        ? `Slipstream session state reset (${count} active session${count === 1 ? '' : 's'}).\n` +
            'The next read of each file is full again; stored artifacts are kept.\n'
        : 'No active Slipstream sessions to reset. Stored artifacts are kept.\n',
    );
  } else if (mode === 'purge' && 'purge' in response) {
    const count = response.purge.artifacts;
    process.stdout.write(
      `Slipstream removed ${count} stored artifact${count === 1 ? '' : 's'}.\n` +
        'Content the model has not expanded yet is no longer retrievable.\n',
    );
  }
}

/** Apply reset/purge directly to the shared storage when no daemon is running. */
function applyMaintenanceLocally(mode: 'reset' | 'purge'): DaemonResponse {
  const manager = new HookSessionManager(defaultStorageDir());
  try {
    return mode === 'reset'
      ? { ok: true, reset: { sessions: manager.resetAll() } }
      : { ok: true, purge: manager.purge() };
  } finally {
    manager.dispose();
  }
}

/** Ask the daemon (starting it if needed) to (re)start the receiver and report its port. */
async function syncModelTrackingPort(): Promise<number> {  try {
    const response = await sendWithStartup({ type: 'sync-model-tracking' });
    return response.ok && 'modelTracking' in response ? response.modelTracking.port : 0;
  } catch {
    return 0;
  }
}

function renderEnvBlock(connection: NonNullable<ReturnType<typeof readConnection>>, shell: Shell): string {
  const block = formatEnv(connection, shell);
  const header = shell === 'powershell'
    ? '# Add to your PowerShell profile (the shell you start Copilot from):'
    : '# Add to your shell profile (the shell you start Copilot from):';
  return `${header}\n${block ?? ''}`;
}

function defaultShell(): Shell {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function parseShell(value: string | undefined): Shell | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (['powershell', 'pwsh', 'ps'].includes(normalized)) return 'powershell';
  if (['bash', 'sh', 'posix', 'zsh'].includes(normalized)) return 'bash';
  return undefined;
}

const ENABLE_NOTICE =
  'Local Copilot model tracking enabled.\n' +
  '\n' +
  'Copilot telemetry can include prompts, code, and tool results even with\n' +
  'content capture off. Slipstream receives it only on 127.0.0.1, discards\n' +
  'content in memory, and records only model identity, correlation IDs, timing,\n' +
  'and token counts. Telemetry is never forwarded and no GitHub token is used.\n';


function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_STDIN_BYTES) {
        reject(new Error('Hook input exceeds the maximum size.'));
        process.stdin.destroy();
        return;
      }
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

main().catch((error: unknown) => {
  if (process.argv[2] === 'vscode') {
    let mode: unknown = 'off';
    try { mode = process.env.SLIPSTREAM_NATIVE_POLICY ? JSON.parse(process.env.SLIPSTREAM_NATIVE_POLICY)?.mode : 'off'; }
    catch { mode = 'guard'; }
    process.stderr.write('[slipstream-hook] Native hook input could not be processed.\n');
    process.stdout.write(JSON.stringify(mode === 'off' || mode === 'observe' ? {}
      : { continue: false, stopReason: 'Slipstream native policy input could not be read. Review the hook configuration before retrying.' }));
    return;
  }
  process.stderr.write(
    `[slipstream-hook] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  // Hook failures must preserve the original tool result.
  process.stdout.write('{}');
});
