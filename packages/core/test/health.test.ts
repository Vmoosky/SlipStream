import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkCompressRoundTrip,
  checkRecentTraffic,
  checkStorageWritable,
  runHealthReport,
} from '../src/health.js';
import { SavingsLedger } from '../src/savingsLedger.js';

let storage: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-health-'));
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

describe('health checks', () => {
  it('passes storage writable on a fresh directory', () => {
    const check = checkStorageWritable(storage);
    expect(check.status).toBe('pass');
    expect(check.detail).toBe(storage);
  });

  it('fails storage writable when the path is a file', () => {
    const asFile = path.join(storage, 'not-a-dir');
    fs.writeFileSync(asFile, 'x');
    const check = checkStorageWritable(asFile);
    expect(check.status).toBe('fail');
  });

  it('proves the compress round-trip is lossless', () => {
    const check = checkCompressRoundTrip();
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/lossless/);
  });

  it('warns about traffic when the ledger is empty', () => {
    const check = checkRecentTraffic(storage, Date.now());
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/no compressions recorded/);
  });

  it('reports fresh traffic as a pass', () => {
    const now = 1_000_000_000_000;
    const ledger = new SavingsLedger({ rootDir: storage });
    ledger.record({
      ts: now - 1000,
      tool: 'powershell',
      label: 'probe',
      strategy: 'log',
      tokensBefore: 100,
      tokensAfter: 40,
      bytesBefore: 500,
      bytesAfter: 200,
      linesBefore: 20,
      linesAfter: 6,
    });
    const check = checkRecentTraffic(storage, now);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/1 compressions/);
  });

  it('runHealthReport is ok when nothing failed', () => {
    const report = runHealthReport({ storageDir: storage });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'storage writable',
      'compress→retrieve round-trip',
      'recent traffic',
    ]);
  });
});
