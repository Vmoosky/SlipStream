import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectionEndpoint,
  disableTracking,
  enableTracking,
  formatEnv,
  persistBoundPort,
  readConnection,
} from '../src/modelTracking.js';

let storage: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-model-tracking-'));
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

describe('standalone model tracking connection', () => {
  it('records consent with a fresh credential and no bound port', () => {
    const connection = enableTracking(storage);
    expect(connection.consented).toBe(true);
    expect(connection.port).toBe(0);
    expect(connection.token).toMatch(/^[a-f\d]{64}$/);
    expect(readConnection(storage)).toEqual(connection);
    expect(connectionEndpoint(connection)).toBeUndefined();
  });

  it('preserves the credential and bound port across re-enable', () => {
    const first = enableTracking(storage);
    persistBoundPort(storage, 7350);
    const second = enableTracking(storage);
    expect(second.token).toBe(first.token);
    expect(second.port).toBe(7350);
    expect(connectionEndpoint(second)).toBe('http://127.0.0.1:7350');
  });

  it('only persists a bound port for a consented connection', () => {
    persistBoundPort(storage, 7350);
    expect(readConnection(storage)).toBeUndefined();
    enableTracking(storage);
    persistBoundPort(storage, 0);
    expect(readConnection(storage)?.port).toBe(0);
    persistBoundPort(storage, 70000);
    expect(readConnection(storage)?.port).toBe(0);
  });

  it('forgets consent and the credential on disable but tolerates absence', () => {
    enableTracking(storage);
    disableTracking(storage);
    expect(readConnection(storage)).toBeUndefined();
    expect(() => disableTracking(storage)).not.toThrow();
  });

  it('rejects malformed or tampered connection files', () => {
    fs.writeFileSync(path.join(storage, 'model-tracking.json'), '{ not json');
    expect(readConnection(storage)).toBeUndefined();
    fs.writeFileSync(path.join(storage, 'model-tracking.json'), JSON.stringify({ version: 1, consented: true, port: 7350, token: 'short' }));
    expect(readConnection(storage)).toBeUndefined();
  });

  it('formats the exporter environment for the bound endpoint and hides no credential elsewhere', () => {
    const connection = enableTracking(storage);
    expect(formatEnv(connection, 'bash')).toBeUndefined();
    persistBoundPort(storage, 7350);
    const bound = readConnection(storage)!;
    const bash = formatEnv(bound, 'bash')!;
    const powershell = formatEnv(bound, 'powershell')!;
    expect(bash).toContain(`export COPILOT_OTEL_ENDPOINT='http://127.0.0.1:7350'`);
    expect(bash).toContain(`export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer ${bound.token}'`);
    expect(bash).toContain(`export COPILOT_OTEL_CAPTURE_CONTENT='false'`);
    expect(powershell).toContain(`$env:COPILOT_OTEL_ENDPOINT = 'http://127.0.0.1:7350'`);
    expect(powershell).toContain(`$env:OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Bearer ${bound.token}'`);
  });

  it('writes the credential file with owner-only permissions on POSIX', () => {
    enableTracking(storage);
    const mode = fs.statSync(path.join(storage, 'model-tracking.json')).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
    // The token is a local receiver credential, never a GitHub token.
    expect(createHash('sha256').update(readConnection(storage)!.token).digest('hex')).toMatch(/^[a-f\d]{64}$/);
  });
});
