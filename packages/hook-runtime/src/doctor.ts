import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

import {
  checkCompressRoundTrip,
  checkRecentTraffic,
  checkStorageWritable,
  type HealthCheck,
  type HealthStatus,
} from '@slipstream/core';

import { socketPath } from './daemon.js';
import { defaultStorageDir } from './hook.js';
import { readConnection } from './modelTracking.js';

/**
 * `slipstream doctor` — routing and health check.
 *
 * The #1 adoption risk for a transparent proxy like Slipstream is a silent
 * no-op: everything looks installed but tool output never actually flows through
 * compression. This command turns "is it even on?" into a concrete, inspectable
 * report — verifying the runtime is installed, the daemon is reachable, the
 * artifact store is writable, a real compress→retrieve round-trip is byte-exact
 * (reusing the retrieval fidelity guard), and whether recent traffic is flowing.
 *
 * The storage/round-trip/traffic checks are shared with the VS Code command and
 * the dashboard via `@slipstream/core`'s health module; the runtime-install and
 * daemon-socket checks below are specific to the CLI front-end.
 */

export type CheckStatus = HealthStatus;

export type DoctorCheck = HealthCheck;

export interface DoctorReport {
  /** True when no check failed (warnings are tolerated). */
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** Where artifacts and the ledger live (defaults to the real storage dir). */
  storageDir?: string;
  /** Directory holding the built runtime (hook.js / mcp-server.js). */
  runtimeDir?: string;
  /** Injected for tests; defaults to a short socket connectivity probe. */
  probeDaemon?: () => Promise<boolean>;
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
}

/** Try to connect to the daemon socket/pipe; resolve reachable without side effects. */
function probeDaemonDefault(): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.createConnection(socketPath());
    const done = (reachable: boolean) => {
      connection.destroy();
      resolve(reachable);
    };
    connection.once('connect', () => done(true));
    connection.once('error', () => done(false));
    connection.setTimeout(500, () => done(false));
  });
}

/** Confirm the runtime bundle is present and its plugin manifests are intact. */
function checkInstall(runtimeDir: string): DoctorCheck {
  const required = ['hook.js', 'mcp-server.js'];
  const missing = required.filter((f) => !fs.existsSync(path.join(runtimeDir, f)));
  if (missing.length > 0) {
    return {
      name: 'runtime install',
      status: 'fail',
      detail: `missing ${missing.join(', ')} in ${runtimeDir}`,
    };
  }
  const pluginRoot = path.dirname(runtimeDir);
  const manifests = ['hooks.json', 'plugin.json'].filter(
    (f) => !fs.existsSync(path.join(pluginRoot, f)),
  );
  if (manifests.length > 0) {
    return {
      name: 'runtime install',
      status: 'warn',
      detail: `runtime present; plugin manifest(s) not found: ${manifests.join(', ')}`,
    };
  }
  return { name: 'runtime install', status: 'pass', detail: `runtime + manifests present in ${pluginRoot}` };
}

/** Report opt-in local model tracking state (never fails; it is optional). */
function checkModelTracking(storageDir: string): DoctorCheck {
  const connection = readConnection(storageDir);
  if (!connection || !connection.consented) {
    return { name: 'model tracking', status: 'pass', detail: 'off (enable with `slipstream model-tracking enable`)' };
  }
  const endpoint = connection.port > 0 ? `http://127.0.0.1:${connection.port}` : 'receiver not yet bound';
  return { name: 'model tracking', status: 'pass', detail: `consented; ${endpoint}` };
}

/** Run every health check and return a structured report. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const storageDir = options.storageDir ?? defaultStorageDir();
  const runtimeDir = options.runtimeDir ?? __dirname;
  const now = options.now ?? Date.now();
  const probeDaemon = options.probeDaemon ?? probeDaemonDefault;

  const reachable = await probeDaemon();
  const daemonCheck: DoctorCheck = reachable
    ? { name: 'hook daemon', status: 'pass', detail: 'reachable' }
    : {
        name: 'hook daemon',
        status: 'warn',
        detail: 'not running — it starts automatically on the next tool call',
      };

  const checks: DoctorCheck[] = [
    checkInstall(runtimeDir),
    daemonCheck,
    checkStorageWritable(storageDir),
    checkCompressRoundTrip(),
    checkRecentTraffic(storageDir, now),
    checkModelTracking(storageDir),
  ];

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

/** Render a report for the terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { pass: '✔', warn: '!', fail: 'x' };
  const lines = ['slipstream doctor', ''];
  for (const check of report.checks) {
    lines.push(`  ${icon[check.status]} ${check.name}: ${check.detail}`);
  }
  lines.push('');
  lines.push(report.ok ? 'All critical checks passed.' : 'One or more checks FAILED — routing may be broken.');
  return `${lines.join('\n')}\n`;
}
