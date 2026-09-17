import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeContextStore, nativeChatMessage, nativeChatStatus, nativeCommandKey, nativePolicyRevision, recordNativeCheck, recordNativeEvent, validateNativeChatPolicy } from '../src/nativeChat.js';
import { SavingsLedger } from '../src/savingsLedger.js';
import type { LedgerEntry } from '../src/types.js';

let storage: string;
let workspace: string;
let ledger: SavingsLedger;
const input = { command: 'npm', args: ['test'] };
const policy = validateNativeChatPolicy({ version: 1, mode: 'guard', tokenLimit: 1000, checks: [{ kind: 'test', ...input }] });

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-native-'));
  workspace = path.join(storage, 'workspace');
  fs.mkdirSync(workspace);
  ledger = new SavingsLedger({ rootDir: storage });
});

afterEach(() => fs.rmSync(storage, { recursive: true, force: true }));

function observation(sessionId: string, inputTokens?: number, outputTokens?: number, spanId = 'span-1'): LedgerEntry {
  return { ts: 100, tool: 'session', label: 'Model', strategy: 'session:model', tokensBefore: 0, tokensAfter: 0,
    bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
    modelObservation: { provider: 'copilot', requestModel: 'model', traceId: 'trace-1', spanId, chatSessionId: sessionId,
      startedAt: 1, endedAt: 2, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) } };
}

function contextDirectory(): string {
  const parent = path.join(storage, 'native-contexts');
  const directories = fs.readdirSync(parent);
  expect(directories).toHaveLength(1);
  return path.join(parent, directories[0]!);
}

describe('native chat policy', () => {
  it('rejects non-object policies and policies whose serialized content exceeds the size limit', () => {
    for (const value of [null, [], true, 'guard']) {
      expect(() => validateNativeChatPolicy(value)).toThrow('object');
    }
    expect(() => validateNativeChatPolicy({
      version: 1, mode: 'guard',
      checks: [{ kind: 'test', command: 'npm', args: Array.from({ length: 5 }, () => 'x'.repeat(2048)) }],
    })).toThrow('8 KiB');
  });

  it('defaults off without changing the owned policy contract', () => {
    expect(validateNativeChatPolicy()).toMatchObject({ version: 1, mode: 'off', checks: [] });
    expect(nativeChatStatus([], workspace, 'session', validateNativeChatPolicy(), 'balanced')).toMatchObject({ state: 'off', observedTokens: null, usage: 'unknown' });
  });

  it.each([
    { version: 2, mode: 'guard' }, { version: 1, mode: 'automatic-owned-request' }, { version: 1, mode: 'guard', tokenLimit: -1 },
    { version: 1, mode: ['guard'] }, { version: 1, mode: 'guard', compressionProfiles: null },
    { version: 1, mode: 'guard', checks: null }, { version: 1, mode: 'guard', checks: [{ kind: 'test', command: 'npm', args: null }] },
    { version: 1, mode: 'guard', tokenLimit: NaN }, { version: 1, mode: 'guard', compressionProfiles: [] },
    { version: 1, mode: 'observe', modelSelection: 'policy' }, { version: 1, mode: 'observe', checks: [{ kind: 'test', command: 'npm test' }] },
    { version: 1, mode: 'observe', checks: [{ kind: 'test', command: 'npm', args: 'test' }] },
    { version: 1, mode: 'guard', checks: [{ kind: 'lint', command: 'npm' }] },
    { version: 1, mode: 'guard', checks: [{ kind: 'test', command: 'npm', cwd: '' }] },
    { version: 1, mode: 'guard', checks: [{ kind: 'build', command: 'npm', cwd: 0 }] },
  ])('rejects invalid settings %j', (value) => expect(() => validateNativeChatPolicy(value)).toThrow());

  it('uses exact session IDs and deduplicates model spans without counting cached input twice', () => {
    const entry = observation('session', 400, 100);
    entry.modelObservation!.cacheReadInputTokens = 300;
    const other = observation('other-session', 10000, 1000);
    const status = nativeChatStatus([entry, entry, other], workspace, 'session', policy, 'conservative');
    expect(status).toMatchObject({ observedTokens: 500, usage: 'reported', state: 'active', profile: 'balanced' });
  });

  it('does not join a turn ID when a different chat session ID is present', () => {
    const entry = observation('other-session', 10000, 1000);
    entry.modelObservation!.conversationId = 'session';
    expect(nativeChatStatus([entry], workspace, 'session', policy, 'balanced')).toMatchObject({ observedTokens: null, state: 'active' });
  });

  it('keeps unknown and partial usage distinct from zero', () => {
    expect(nativeChatStatus([observation('session')], workspace, 'session', policy, 'balanced')).toMatchObject({ observedTokens: null, usage: 'unknown' });
    expect(nativeChatStatus([observation('session', 0)], workspace, 'session', policy, 'balanced')).toMatchObject({ observedTokens: 0, usage: 'partial' });
    expect(nativeChatStatus([observation('session', 0, 0)], workspace, 'session', policy, 'balanced')).toMatchObject({ observedTokens: 0, usage: 'reported' });
  });

  it('warns in observe mode and pauses only opted-in guards after reported usage crosses the limit', () => {
    const entries = [observation('session', 900, 200)];
    expect(nativeChatStatus(entries, workspace, 'session', { ...policy, mode: 'observe' }, 'conservative')).toMatchObject({ state: 'observing', reason: 'observed-limit', profile: 'conservative' });
    const guarded = nativeChatStatus(entries, workspace, 'session', policy, 'conservative');
    expect(guarded).toMatchObject({ state: 'paused', reason: 'observed-limit', profile: 'aggressive' });
    expect(nativeChatMessage(guarded, policy)).toContain('not a billing cap');
  });

  it('allows an explicit zero limit to stop before any observed model usage', () => {
    expect(nativeChatStatus([], workspace, 'session', { ...policy, tokenLimit: 0 }, 'balanced')).toMatchObject({ state: 'paused', reason: 'observed-limit' });
  });

  it('latches pauses and recovery only for the same workspace, session and policy revision', () => {
    const policyRevision = nativePolicyRevision(policy);
    recordNativeEvent(ledger, workspace, { event: 'policy', sessionId: 'session', policyRevision, state: 'paused', reason: 'observed-limit' });
    expect(nativeChatStatus(ledger.all(), workspace, 'session', policy, 'balanced').state).toBe('paused');
    expect(nativeChatStatus(ledger.all(), workspace, 'other', policy, 'balanced').state).toBe('active');
    expect(nativeChatStatus(ledger.all(), workspace, 'session', { ...policy, tokenLimit: 2000 }, 'balanced').state).toBe('active');
    recordNativeEvent(ledger, workspace, { event: 'recovery', sessionId: 'other', toolCallId: 'call-1', policyRevision, outcome: 'fail' });
    expect(nativeChatStatus(ledger.all(), workspace, 'other', policy, 'aggressive')).toMatchObject({ state: 'active', profile: 'conservative' });
    recordNativeEvent(ledger, workspace, { event: 'recovery', sessionId: 'other', toolCallId: 'call-2', policyRevision, outcome: 'fail' });
    expect(nativeChatStatus(ledger.all(), workspace, 'other', policy, 'aggressive')).toMatchObject({ state: 'paused', reason: 'recovery-failure' });
  });
});

describe('native command identity', () => {
  it.each([
    { name: 'null', value: null },
    { name: 'array', value: [] },
    { name: 'missing executable', value: {} },
    { name: 'shell command', value: { command: 'npm test' } },
    { name: 'non-array arguments', value: { command: 'npm', args: 'test' } },
    { name: 'non-string argument', value: { command: 'npm', args: [1] } },
    { name: 'invalid working directory', value: { command: 'npm', cwd: 1 } },
  ])('does not create a key for $name', ({ value }) => {
    expect(nativeCommandKey(value, workspace)).toBeUndefined();
  });

  it('normalizes default arguments and equivalent working directories', () => {
    const key = nativeCommandKey({ command: 'npm' }, workspace);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeCommandKey({ command: 'npm', args: [], cwd: '.' }, workspace)).toBe(key);
    expect(nativeCommandKey({ command: 'npm', args: [], cwd: workspace }, workspace)).toBe(key);
    expect(nativeCommandKey({ command: 'npm', args: ['test'] }, workspace)).not.toBe(key);
  });
});

describe('native invocation handoff', () => {
  it('does not write an approval for oversized tool input', () => {
    const store = new NativeContextStore(storage, workspace);
    expect(() => store.issue('session', 'call', 'slipstream_readFile', {
      path: 'x'.repeat(65_536),
    }, policy)).toThrow('too large');
    expect(fs.readdirSync(contextDirectory())).toEqual([]);
  });

  it('cleans expired pending approvals without deleting a fresh approval', () => {
    const store = new NativeContextStore(storage, workspace);
    const expired = store.issue('session', 'expired-call', 'slipstream_runCommand', input, policy);
    const directory = contextDirectory();
    const fresh = store.issue('session', 'fresh-call', 'slipstream_runCommand', input, policy);
    fs.utimesSync(path.join(directory, `${expired}.json`), 0, 0);
    const newest = store.issue('session', 'new-call', 'slipstream_runCommand', input, policy);

    expect(fs.existsSync(path.join(directory, `${expired}.json`))).toBe(false);
    expect(fs.readdirSync(directory).sort()).toEqual([`${fresh}.json`, `${newest}.json`].sort());
    expect(store.claim(fresh, 'slipstream_runCommand', input, policy).toolCallId).toBe('fresh-call');
  });

  it('refuses excess pending approvals instead of evicting fresh tokens', () => {
    const store = new NativeContextStore(storage, workspace);
    const token = store.issue('session', 'first-call', 'slipstream_runCommand', input, policy);
    const directory = contextDirectory();
    for (let index = 0; index < 255; index++) {
      fs.writeFileSync(path.join(directory, `${index.toString(16).padStart(64, '0')}.json`), '{}', { flag: 'wx' });
    }
    expect(() => store.issue('session', 'extra-call', 'slipstream_runCommand', input, policy)).toThrow('Too many pending');
    expect(fs.readdirSync(directory)).toHaveLength(256);
    expect(fs.existsSync(path.join(directory, `${token}.json`))).toBe(true);
  });

  it('consumes an oversized persisted context without accepting or retaining it', () => {
    const store = new NativeContextStore(storage, workspace);
    const token = store.issue('session', 'call', 'slipstream_runCommand', input, policy);
    const directory = contextDirectory();
    fs.writeFileSync(path.join(directory, `${token}.json`), ' '.repeat(4097));

    expect(() => store.claim(token, 'slipstream_runCommand', input, policy)).toThrow('context');
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('binds a single-use context to the actual host IDs, input, workspace and policy', () => {
    const store = new NativeContextStore(storage, workspace);
    const token = store.issue('session', 'tool-call', 'slipstream_runCommand', input, policy);
    const context = store.claim(token, 'slipstream_runCommand', { nativeContext: token, args: ['test'], command: 'npm' }, policy);
    expect(context).toMatchObject({ sessionId: 'session', toolCallId: 'tool-call', checkKind: 'test' });
    expect(() => store.claim(token, 'slipstream_runCommand', input, policy)).toThrow('already used');
  });

  it.each(['input', 'tool', 'policy', 'workspace', 'expired'])('rejects a mismatched or stale %s', (mismatch) => {
    let now = Date.now();
    const store = new NativeContextStore(storage, workspace, () => now);
    const token = store.issue('session', 'tool-call', 'slipstream_runCommand', input, policy);
    if (mismatch === 'expired') now += 16 * 60_000;
    const claimant = mismatch === 'workspace' ? new NativeContextStore(storage, path.join(workspace, 'other')) : store;
    expect(() => claimant.claim(token, mismatch === 'tool' ? 'slipstream_readFile' : 'slipstream_runCommand',
      mismatch === 'input' ? { command: 'npm', args: ['run', 'build'] } : input,
      mismatch === 'policy' ? { ...policy, tokenLimit: 2000 } : policy)).toThrow('context');
  });

  it('requires host IDs and does not infer identity for ordinary tool calls', () => {
    const store = new NativeContextStore(storage, workspace);
    expect(() => store.issue('', 'call', 'slipstream_runCommand', input, policy)).toThrow('identifiers');
    expect(() => store.issue('session', 'call', 'run_in_terminal', input, policy)).toThrow('identifiers');
    expect(() => store.issue('session', 'call', 'slipstream_runCommand', input, validateNativeChatPolicy())).toThrow('enabled');
    expect(() => store.claim('../file', 'slipstream_runCommand', input, policy)).toThrow('context');
  });

  it.each([
    [{ exitCode: 0, durationMs: 10 }, 'pass'], [{ exitCode: 1, durationMs: 10 }, 'fail'],
    [{ exitCode: 0, durationMs: 10, cancelled: true }, 'cancelled'], [{ exitCode: 0, durationMs: 10, timedOut: true }, 'timeout'],
    [{ exitCode: null, durationMs: 10 }, 'error'],
  ] as const)('records designated command result %j as %s, not owned-task quality evidence', (result, outcome) => {
    const store = new NativeContextStore(storage, workspace);
    const token = store.issue('session', 'tool-call', 'slipstream_runCommand', input, policy);
    const context = store.claim(token, 'slipstream_runCommand', input, policy);
    expect(recordNativeCheck(ledger, workspace, context, result)).toBe(true);
    recordNativeCheck(ledger, workspace, context, result);
    expect(ledger.all()).toHaveLength(1);
    expect(ledger.all()[0].nativeChat).toMatchObject({ event: 'check', outcome, checkKind: 'test', toolCallId: 'tool-call' });
    expect(nativeChatStatus(ledger.all(), workspace, 'session', policy, 'balanced')).toMatchObject({
      passed: outcome === 'pass' ? 1 : 0,
      failed: outcome === 'fail' ? 1 : 0,
      incomplete: outcome !== 'pass' && outcome !== 'fail' ? 1 : 0,
    });
    expect(ledger.all()[0].taskUsage).toBeUndefined();
    expect(ledger.summary()).toMatchObject({ calls: 0, tokensSaved: 0 });
    const serialized = JSON.stringify(ledger.all());
    expect(serialized).not.toContain('"command"');
    expect(serialized).not.toContain('"args"');
    expect(serialized).not.toContain('"pricing"');
  });

  it('does not treat an arbitrary successful command as verification', () => {
    const store = new NativeContextStore(storage, workspace);
    const ordinary = { command: 'npm', args: ['--version'] };
    const token = store.issue('session', 'tool-call', 'slipstream_runCommand', ordinary, policy);
    const context = store.claim(token, 'slipstream_runCommand', ordinary, policy);
    expect(recordNativeCheck(ledger, workspace, context, { exitCode: 0, durationMs: 1 })).toBe(false);
    expect(ledger.all()).toHaveLength(0);
  });
});