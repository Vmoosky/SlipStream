import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeContextStore, nativeChatMessage, nativeChatStatus, nativePolicyRevision, recordNativeCheck, recordNativeEvent, validateNativeChatPolicy } from '../src/nativeChat.js';
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

describe('native chat policy', () => {
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

describe('native invocation handoff', () => {
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