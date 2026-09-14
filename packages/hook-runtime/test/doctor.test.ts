import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SavingsLedger } from '@slipstream/core';

import { formatDoctorReport, runDoctor } from '../src/doctor.js';

let storage: string;
let runtimeDir: string;

/** Build a fake installed-plugin layout: <root>/dist/{hook.js,mcp-server.js} + manifests in <root>. */
function makeInstall(withManifests = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-doctor-install-'));
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'hook.js'), '// hook');
  fs.writeFileSync(path.join(dist, 'mcp-server.js'), '// mcp');
  if (withManifests) {
    fs.writeFileSync(path.join(root, 'hooks.json'), '{}');
    fs.writeFileSync(path.join(root, 'plugin.json'), '{}');
  }
  return dist;
}

function find(report: { checks: { name: string; status: string; detail: string }[] }, name: string) {
  const check = report.checks.find((c) => c.name === name);
  if (!check) throw new Error(`missing check: ${name}`);
  return check;
}

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-doctor-store-'));
  runtimeDir = makeInstall();
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
  fs.rmSync(path.dirname(runtimeDir), { recursive: true, force: true });
});

describe('runDoctor', () => {
  it('passes every critical check on a healthy setup', async () => {
    const report = await runDoctor({
      storageDir: storage,
      runtimeDir,
      probeDaemon: async () => true,
    });
    expect(report.ok).toBe(true);
    expect(find(report, 'runtime install').status).toBe('pass');
    expect(find(report, 'hook daemon').status).toBe('pass');
    expect(find(report, 'storage writable').status).toBe('pass');
    expect(find(report, 'compress→retrieve round-trip').status).toBe('pass');
  });

  it('proves the round-trip is lossless', async () => {
    const report = await runDoctor({ storageDir: storage, runtimeDir, probeDaemon: async () => true });
    const roundTrip = find(report, 'compress→retrieve round-trip');
    expect(roundTrip.status).toBe('pass');
    expect(roundTrip.detail).toMatch(/lossless/);
  });

  it('fails when the runtime bundle is missing', async () => {
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-doctor-broken-'));
    const brokenDist = path.join(brokenRoot, 'dist');
    fs.mkdirSync(brokenDist);
    try {
      const report = await runDoctor({
        storageDir: storage,
        runtimeDir: brokenDist,
        probeDaemon: async () => true,
      });
      expect(report.ok).toBe(false);
      const install = find(report, 'runtime install');
      expect(install.status).toBe('fail');
      expect(install.detail).toMatch(/hook\.js/);
    } finally {
      fs.rmSync(brokenRoot, { recursive: true, force: true });
    }
  });

  it('warns (does not fail) when the runtime is present but manifests are missing', async () => {
    const noManifest = makeInstall(false);
    try {
      const report = await runDoctor({
        storageDir: storage,
        runtimeDir: noManifest,
        probeDaemon: async () => true,
      });
      const install = find(report, 'runtime install');
      expect(install.status).toBe('warn');
      expect(report.ok).toBe(true);
    } finally {
      fs.rmSync(path.dirname(noManifest), { recursive: true, force: true });
    }
  });

  it('warns (does not fail) when the daemon is unreachable', async () => {
    const report = await runDoctor({ storageDir: storage, runtimeDir, probeDaemon: async () => false });
    expect(find(report, 'hook daemon').status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('warns about traffic when the ledger is empty', async () => {
    const report = await runDoctor({ storageDir: storage, runtimeDir, probeDaemon: async () => true });
    expect(find(report, 'recent traffic').status).toBe('warn');
  });

  it('reports recent traffic when the ledger has fresh activity', async () => {
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
    const report = await runDoctor({
      storageDir: storage,
      runtimeDir,
      probeDaemon: async () => true,
      now,
    });
    const traffic = find(report, 'recent traffic');
    expect(traffic.status).toBe('pass');
    expect(traffic.detail).toMatch(/1 compressions/);
  });

  it('flags stale traffic older than 24h as a warning', async () => {
    const now = 1_000_000_000_000;
    const ledger = new SavingsLedger({ rootDir: storage });
    ledger.record({
      ts: now - 48 * 60 * 60 * 1000,
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
    const report = await runDoctor({
      storageDir: storage,
      runtimeDir,
      probeDaemon: async () => true,
      now,
    });
    expect(find(report, 'recent traffic').status).toBe('warn');
  });
});

describe('formatDoctorReport', () => {
  it('renders each check and an overall verdict', async () => {
    const report = await runDoctor({ storageDir: storage, runtimeDir, probeDaemon: async () => true });
    const text = formatDoctorReport(report);
    expect(text).toMatch(/slipstream doctor/);
    expect(text).toMatch(/runtime install/);
    expect(text).toMatch(/All critical checks passed\./);
  });

  it('renders a failure verdict when a check fails', () => {
    const text = formatDoctorReport({
      ok: false,
      checks: [{ name: 'storage writable', status: 'fail', detail: 'nope' }],
    });
    expect(text).toMatch(/FAILED/);
  });
});
