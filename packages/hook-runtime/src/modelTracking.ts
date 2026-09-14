import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { managedTelemetryEnv } from '@slipstream/core';

/**
 * Standalone (CLI-only) model tracking state.
 *
 * VS Code stores the receiver credential in secret storage and the connection in
 * extension globalState. A Copilot CLI install has neither, so consent, the
 * loopback port, and the bearer token are persisted to a mode-0600 JSON file in
 * the shared storage directory. The daemon reads it to decide whether to run the
 * receiver; `slipstream model-tracking` reads it to print the exporter
 * environment a user adds to the shell that launches `copilot`.
 *
 * Nothing is captured until the user runs `model-tracking enable`, which records
 * explicit consent. This is the CLI equivalent of the VS Code consent modal.
 */
export interface CliModelTrackingConnection {
  version: 1;
  consented: boolean;
  /** Loopback port the daemon last bound the receiver to; 0 until first bind. */
  port: number;
  /** 64-hex local bearer credential (not a GitHub token). */
  token: string;
}

export type Shell = 'bash' | 'powershell';

function connectionPath(storageDir: string): string {
  return path.join(storageDir, 'model-tracking.json');
}

function validPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535;
}

function isConnection(value: unknown): value is CliModelTrackingConnection {
  const record = value as Record<string, unknown> | null;
  return !!record && record.version === 1 && typeof record.consented === 'boolean'
    && validPort(record.port) && typeof record.token === 'string' && /^[a-f\d]{64}$/.test(record.token);
}

/** Read and validate the persisted connection, or undefined when absent/invalid. */
export function readConnection(storageDir: string): CliModelTrackingConnection | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(connectionPath(storageDir), 'utf8')) as unknown;
    return isConnection(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeConnection(storageDir: string, connection: CliModelTrackingConnection): void {
  fs.mkdirSync(storageDir, { recursive: true });
  const file = connectionPath(storageDir);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(connection), { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
}

/** Record consent and ensure a credential exists, preserving any bound port. */
export function enableTracking(storageDir: string): CliModelTrackingConnection {
  const existing = readConnection(storageDir);
  const connection: CliModelTrackingConnection = {
    version: 1,
    consented: true,
    port: existing?.port ?? 0,
    token: existing?.token ?? randomBytes(32).toString('hex'),
  };
  writeConnection(storageDir, connection);
  return connection;
}

/** Remove consent and the stored credential. Existing observations are kept. */
export function disableTracking(storageDir: string): void {
  fs.rmSync(connectionPath(storageDir), { force: true });
}

/**
 * Record the port the daemon actually bound so already-exported environments
 * keep working across restarts. Only persists when consent is present.
 */
export function persistBoundPort(storageDir: string, port: number): void {
  if (!validPort(port) || port === 0) return;
  const existing = readConnection(storageDir);
  if (!existing || !existing.consented || existing.port === port) return;
  writeConnection(storageDir, { ...existing, port });
}

/** Loopback endpoint for a bound connection, or undefined before the first bind. */
export function connectionEndpoint(connection: CliModelTrackingConnection): string | undefined {
  return connection.port > 0 ? `http://127.0.0.1:${connection.port}` : undefined;
}

/**
 * The exporter environment for a bound connection, expressed for the given
 * shell. The daemon must have bound a port first (start Copilot once with the
 * plugin installed, or run `model-tracking enable`, then re-read).
 */
export function formatEnv(connection: CliModelTrackingConnection, shell: Shell): string | undefined {
  const endpoint = connectionEndpoint(connection);
  if (!endpoint) return undefined;
  const env = managedTelemetryEnv({ endpoint, token: connection.token });
  const entries = Object.entries(env);
  if (shell === 'powershell') {
    return entries.map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`).join('\n');
  }
  return entries.map(([key, value]) => `export ${key}=${quotePosix(value)}`).join('\n');
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`;
}
