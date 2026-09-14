import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compareVersions,
  formatUpdateNotice,
  isNewerVersion,
  isUpdateCheckDisabled,
  maybeCheckForUpdate,
} from '../src/updateCheck.js';

let stateDir: string;
const STATE_FILE = 'update-check.json';

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-update-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function readState(): { lastCheckMs: number; latestVersion: string | null } {
  return JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE), 'utf8'));
}

describe('version comparison', () => {
  it('orders dotted versions numerically, not lexically', () => {
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
  });

  it('ignores a leading v and pre-release suffix', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true);
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(0);
  });
});

describe('isUpdateCheckDisabled', () => {
  it('is off when explicitly opted out', () => {
    expect(isUpdateCheckDisabled({ SLIPSTREAM_UPDATE_CHECK: 'off' })).toBe(true);
    expect(isUpdateCheckDisabled({ SLIPSTREAM_UPDATE_CHECK: 'false' })).toBe(true);
  });

  it('is off in CI', () => {
    expect(isUpdateCheckDisabled({ CI: 'true' })).toBe(true);
  });

  it('is on by default', () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
    expect(isUpdateCheckDisabled({ CI: 'false' })).toBe(false);
  });
});

describe('maybeCheckForUpdate', () => {
  it('returns a notice when a newer version is published', async () => {
    const notice = await maybeCheckForUpdate({
      currentVersion: '0.1.0',
      stateDir,
      env: {},
      fetchLatest: async () => '0.2.0',
    });
    expect(notice).toEqual({ currentVersion: '0.1.0', latestVersion: '0.2.0' });
  });

  it('returns undefined when already up to date', async () => {
    const notice = await maybeCheckForUpdate({
      currentVersion: '0.2.0',
      stateDir,
      env: {},
      fetchLatest: async () => '0.2.0',
    });
    expect(notice).toBeUndefined();
  });

  it('does not fetch again within the interval, using the cached version', async () => {
    let calls = 0;
    const fetchLatest = async () => {
      calls += 1;
      return '0.5.0';
    };
    const base = { currentVersion: '0.1.0', stateDir, env: {}, fetchLatest, minIntervalMs: 1000 };

    const first = await maybeCheckForUpdate({ ...base, now: 10_000 });
    const second = await maybeCheckForUpdate({ ...base, now: 10_500 });

    expect(calls).toBe(1);
    expect(first).toEqual({ currentVersion: '0.1.0', latestVersion: '0.5.0' });
    expect(second).toEqual(first);
  });

  it('fetches again once the interval has elapsed', async () => {
    let calls = 0;
    const fetchLatest = async () => {
      calls += 1;
      return '0.5.0';
    };
    const base = { currentVersion: '0.1.0', stateDir, env: {}, fetchLatest, minIntervalMs: 1000 };

    await maybeCheckForUpdate({ ...base, now: 10_000 });
    await maybeCheckForUpdate({ ...base, now: 20_000 });

    expect(calls).toBe(2);
  });

  it('is disabled by opt-out and never writes state or fetches', async () => {
    let calls = 0;
    const notice = await maybeCheckForUpdate({
      currentVersion: '0.1.0',
      stateDir,
      env: { SLIPSTREAM_UPDATE_CHECK: 'off' },
      fetchLatest: async () => {
        calls += 1;
        return '9.9.9';
      },
    });
    expect(notice).toBeUndefined();
    expect(calls).toBe(0);
    expect(fs.existsSync(path.join(stateDir, STATE_FILE))).toBe(false);
  });

  it('swallows fetch failures and records the attempt', async () => {
    const notice = await maybeCheckForUpdate({
      currentVersion: '0.1.0',
      stateDir,
      env: {},
      now: 42,
      fetchLatest: async () => {
        throw new Error('network down');
      },
    });
    expect(notice).toBeUndefined();
    // The attempt is still recorded so we honour the once-a-day budget.
    expect(readState()).toEqual({ lastCheckMs: 42, latestVersion: null });
  });
});

describe('formatUpdateNotice', () => {
  it('renders a single opt-out line', () => {
    const line = formatUpdateNotice({ currentVersion: '0.1.0', latestVersion: '0.2.0' });
    expect(line).toContain('0.1.0');
    expect(line).toContain('0.2.0');
    expect(line).toContain('SLIPSTREAM_UPDATE_CHECK=off');
    expect(line).not.toContain('\n');
  });
});
