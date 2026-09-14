import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CompressionEngine } from './engine.js';
import { reconstructFromArtifacts, verifyMarkerFidelity } from './fidelity.js';
import { SavingsLedger } from './savingsLedger.js';

/**
 * Portable health checks shared by `slipstream doctor` (CLI), the VS Code
 * command palette, and the dashboard "Health check" section.
 *
 * These are the checks that depend only on `@slipstream/core` and a storage
 * directory — is the store writable, is a real compress→retrieve round-trip
 * byte-exact, and has traffic flowed recently. Front-end-specific checks (the
 * CLI runtime install, the hook daemon socket) live with their front-end.
 */

export type HealthStatus = 'pass' | 'warn' | 'fail';

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthReport {
  /** True when no check failed (warnings are tolerated). */
  ok: boolean;
  checks: HealthCheck[];
}

/** How recent ledger activity must be to count as "traffic is flowing". */
const RECENT_ACTIVITY_MS = 24 * 60 * 60 * 1000;

/** Verify the storage directory is writable and readable. */
export function checkStorageWritable(storageDir: string): HealthCheck {
  const probe = path.join(storageDir, '.doctor-probe');
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    const token = `slipstream-doctor-${Date.now()}`;
    fs.writeFileSync(probe, token, { encoding: 'utf8' });
    const readBack = fs.readFileSync(probe, 'utf8');
    fs.rmSync(probe, { force: true });
    if (readBack !== token) {
      return { name: 'storage writable', status: 'fail', detail: `read-back mismatch in ${storageDir}` };
    }
    return { name: 'storage writable', status: 'pass', detail: storageDir };
  } catch (error) {
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      /* best effort */
    }
    return {
      name: 'storage writable',
      status: 'fail',
      detail: `${storageDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Run a real compress→retrieve round-trip through a throwaway engine and prove
 * it is lossless with the fidelity guard. Uses a temp store so it never writes
 * to the user's real ledger.
 */
export function checkCompressRoundTrip(): HealthCheck {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-doctor-'));
  try {
    const engine = new CompressionEngine({ rootDir: tempRoot, workspaceRoots: [tempRoot] });
    const input = Array.from({ length: 60 }, (_, i) => `Processed record ${1000 + i} in ${i} ms`).join('\n');
    const output = engine.compressToolResult({ toolName: 'shell', cwd: tempRoot, text: input });

    if (output.strategy.startsWith('passthrough')) {
      return { name: 'compress→retrieve round-trip', status: 'fail', detail: 'synthetic payload did not compress' };
    }
    const report = verifyMarkerFidelity(output.text, engine.store);
    if (!report.ok) {
      return {
        name: 'compress→retrieve round-trip',
        status: 'fail',
        detail: `${report.failures.length} marker(s) failed fidelity (${report.failures[0]?.reason ?? 'unknown'})`,
      };
    }
    const restored = reconstructFromArtifacts(output.text, engine.store);
    if (restored !== input) {
      return { name: 'compress→retrieve round-trip', status: 'fail', detail: 'reconstruction did not match the original' };
    }
    const percent = output.tokensBefore > 0 ? Math.round((output.tokensSaved / output.tokensBefore) * 100) : 0;
    return {
      name: 'compress→retrieve round-trip',
      status: 'pass',
      detail: `lossless via ${output.strategy}; ${report.markersChecked} marker(s), ${percent}% saved on the probe`,
    };
  } catch (error) {
    return {
      name: 'compress→retrieve round-trip',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** Report whether compression traffic has flowed recently through the ledger. */
export function checkRecentTraffic(storageDir: string, now: number = Date.now()): HealthCheck {
  try {
    const ledger = new SavingsLedger({ rootDir: storageDir });
    const summary = ledger.summary();
    if (summary.compressions === 0) {
      return {
        name: 'recent traffic',
        status: 'warn',
        detail: 'no compressions recorded yet — run a tool through Copilot to confirm routing',
      };
    }
    const last = ledger.recent(1)[0];
    const ageMs = last ? now - last.ts : Number.POSITIVE_INFINITY;
    const saved = summary.tokensSaved.toLocaleString();
    if (ageMs > RECENT_ACTIVITY_MS) {
      return {
        name: 'recent traffic',
        status: 'warn',
        detail: `${summary.compressions} lifetime compressions (${saved} tokens saved), but none in the last 24h`,
      };
    }
    return {
      name: 'recent traffic',
      status: 'pass',
      detail: `${summary.compressions} compressions, ${saved} tokens saved (last activity ${formatAge(ageMs)} ago)`,
    };
  } catch (error) {
    return {
      name: 'recent traffic',
      status: 'warn',
      detail: `could not read ledger: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/**
 * The core checks, in display order. Any front-end can prepend its own checks
 * (e.g. runtime install) and reuse these for the parts that only need storage.
 */
export function runCoreHealthChecks(opts: { storageDir: string; now?: number }): HealthCheck[] {
  return [
    checkStorageWritable(opts.storageDir),
    checkCompressRoundTrip(),
    checkRecentTraffic(opts.storageDir, opts.now),
  ];
}

/** Run the core checks and wrap them in a report with an overall verdict. */
export function runHealthReport(opts: { storageDir: string; now?: number }): HealthReport {
  const checks = runCoreHealthChecks(opts);
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
