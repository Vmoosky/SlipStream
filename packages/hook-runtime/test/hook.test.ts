import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultStorageDir, HookSessionManager, shouldBypass } from '../src/hook.js';
import { NativeContextStore, nativePolicyRevision, recordNativeEvent, SavingsLedger, validateNativeChatPolicy } from '@slipstream/core';
import { parsePostToolUseInput, parseProducerPricing, parseUserPromptSubmittedInput } from '../src/protocol.js';
import { handleVscodeHook, recordVscodeHook } from '../src/vscode.js';

let storage: string;
let cwd: string;
let manager: HookSessionManager;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-hook-store-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-hook-ws-'));
  manager = new HookSessionManager(storage);
});

afterEach(() => {
  manager.dispose();
  fs.rmSync(storage, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function event(text: string, toolName = 'powershell', sessionId = 'session-1') {
  return {
    sessionId,
    timestamp: Date.now(),
    cwd,
    toolName,
    toolArgs: {},
    toolResult: { resultType: 'success' as const, textResultForLlm: text },
  };
}

function noisyLog(): string {
  return [
    'RUN tests',
    ...Array.from({ length: 200 }, (_, i) => `PASS test ${i}`),
    'FAIL src/example.test.ts',
    'Error: expected 1 to equal 2',
    '    at src/example.test.ts:10:4',
    'Tests: 1 failed, 200 passed, 201 total',
  ].join('\n');
}

describe('hook protocol parsers', () => {
  it.each([undefined, null, false, 1, 'input'])('rejects non-object hook input %j', (input) => {
    expect(() => parsePostToolUseInput(input)).toThrow('Hook input must be an object.');
    expect(() => parseUserPromptSubmittedInput(input)).toThrow('Hook input must be an object.');
  });

  it.each([
    undefined,
    null,
    'output',
    {},
    { resultType: 'failure', textResultForLlm: 'failed' },
    { resultType: 'success', textResultForLlm: 7 },
  ])('rejects missing or unsuccessful textual results %j', (toolResult) => {
    expect(() => parsePostToolUseInput({ ...event('output'), toolResult }))
      .toThrow(/missing toolResult|successful textual tool result/);
  });

  it.each(['sessionId', 'cwd', 'toolName'] as const)('requires a nonempty string for %s', (field) => {
    for (const value of [undefined, '', 1]) {
      const input = { ...event('output'), [field]: value };
      expect(() => parsePostToolUseInput(input)).toThrow(`Hook input is missing ${field}.`);
      if (field !== 'toolName') {
        expect(() => parseUserPromptSubmittedInput(input)).toThrow(`Hook input is missing ${field}.`);
      }
    }
  });

  it('preserves empty successful text, tool arguments and an explicit zero timestamp', () => {
    const input = { ...event(''), timestamp: 0, toolArgs: { command: 'npm', args: ['test'] } };
    expect(parsePostToolUseInput(input)).toEqual(input);
    expect(parseUserPromptSubmittedInput(input)).toEqual({ sessionId: input.sessionId, timestamp: 0, cwd });
  });

  it.each([undefined, 'invalid'])('uses the current time for a nonnumeric timestamp %j', (timestamp) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(123456789);
    try {
      const input = { ...event('output'), timestamp };
      expect(parsePostToolUseInput(input).timestamp).toBe(123456789);
      expect(parseUserPromptSubmittedInput(input)).toEqual({ sessionId: input.sessionId, timestamp: 123456789, cwd });
    } finally {
      clock.mockRestore();
    }
  });

  it('uses explicit legacy pricing defaults only when producer pricing is absent', () => {
    expect(parseProducerPricing(undefined)).toEqual({
      pricing: { mode: 'manual', providerId: undefined, modelId: undefined, inputRateOverride: null },
      usdPerMillionTokens: 3,
    });
  });

  it.each([null, false, 3, 'manual'])('rejects non-object producer pricing %j', (pricing) => {
    expect(() => parseProducerPricing(pricing)).toThrow('Invalid producer pricing');
  });

  it.each([-1, Infinity, NaN, '3'])('rejects invalid producer token price %j', (usdPerMillionTokens) => {
    expect(() => parseProducerPricing({ pricing: { mode: 'manual' }, usdPerMillionTokens }))
      .toThrow('Invalid producer token price');
  });

  it('preserves a zero producer price without substituting the legacy default', () => {
    expect(parseProducerPricing({ pricing: { mode: 'manual' }, usdPerMillionTokens: 0 })).toEqual({
      pricing: { mode: 'manual', providerId: undefined, modelId: undefined, inputRateOverride: null },
      usdPerMillionTokens: 0,
    });
  });

  it('rejects invalid nested pricing rather than accepting its valid fallback price', () => {
    expect(() => parseProducerPricing({ pricing: { mode: 'catalog' }, usdPerMillionTokens: 3 })).toThrow();
  });
});

describe('HookSessionManager', () => {
  it('isolates client prices and resets old envelopes without inheriting daemon environment', () => {
    manager.process(event('first', 'powershell', 'first'), { pricing: { mode: 'manual' }, usdPerMillionTokens: 2 });
    manager.process(event('second', 'powershell', 'second'), { pricing: { mode: 'manual' }, usdPerMillionTokens: 8 });
    manager.process(event('legacy', 'powershell', 'first'));
    const entries = fs.readFileSync(path.join(storage, 'savings.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.pricing.inputUsdPerMillion)).toEqual([2, 8, 3]);
    expect(() => manager.process(event('invalid'), { pricing: { mode: 'catalog' }, usdPerMillionTokens: 3 })).toThrow();
  });

  it('records a chat without changing savings totals', () => {
    manager.recordChat({
      sessionId: 'session-1',
      timestamp: 123456789,
      cwd,
    });

    const ledger = fs.readFileSync(path.join(storage, 'savings.jsonl'), 'utf8');
    expect(ledger).toContain('"strategy":"session:chat"');
    expect(ledger).toContain('"tokensBefore":0');
    expect(ledger).not.toContain('prompt');
  });

  it('returns a modified result when compression pays', () => {
    const output = manager.process(event(noisyLog()));
    expect(output.modifiedResult?.textResultForLlm).toContain('FAIL src/example.test.ts');
    expect(output.modifiedResult?.textResultForLlm).toMatch(/\[\[slipstream:[0-9a-f]{12}/);
    expect(output.modifiedResult?.textResultForLlm).toMatch(/tokens \(\d+% saved\)/);
  });

  it('returns no override for passthrough output', () => {
    expect(manager.process(event('nothing to report'))).toEqual({});
  });

  it('keeps dedup state within a session', () => {
    const first = manager.process(event(noisyLog()));
    const second = manager.process(event(noisyLog()));
    expect(first.modifiedResult).toBeDefined();
    expect(second.modifiedResult?.textResultForLlm).toContain('repeated from');
  });

  it('shares dedup state across sessions on the same store', () => {
    manager.process(event(noisyLog(), 'powershell', 'session-1'));
    const other = manager.process(event(noisyLog(), 'powershell', 'session-2'));
    expect(other.modifiedResult?.textResultForLlm).toContain('repeated from');
  });

  it('releases only the requested session and can create it again', () => {
    manager.recordChat({ sessionId: 'first', cwd, timestamp: 100 });
    manager.recordChat({ sessionId: 'second', cwd, timestamp: 200 });
    expect(manager.resetAll()).toBe(2);

    manager.release('first');
    expect(manager.resetAll()).toBe(1);
    manager.release('first');
    manager.release('unknown');
    expect(manager.resetAll()).toBe(1);

    manager.recordChat({ sessionId: 'first', cwd, timestamp: 300 });
    expect(manager.resetAll()).toBe(2);
  });
});

describe('defaultStorageDir', () => {
  it('trims configured storage and falls back for missing or blank values', () => {
    vi.stubEnv('SLIPSTREAM_STORAGE_DIR', ` ${storage} `);
    expect(defaultStorageDir()).toBe(storage);

    for (const value of [undefined, '', '   ']) {
      vi.stubEnv('SLIPSTREAM_STORAGE_DIR', value);
      expect(defaultStorageDir()).toBe(path.join(os.homedir(), '.slipstream'));
    }
  });
});

describe('shouldBypass', () => {
  it('bypasses Slipstream retrieval and savings tools', () => {
    expect(shouldBypass('slipstream-retrieve_artifact')).toBe(true);
    expect(shouldBypass('slipstream_getSavings')).toBe(true);
    expect(shouldBypass('powershell')).toBe(false);
  });
});

describe('VS Code activity hooks', () => {
  it('records native lifecycle boundaries without treating stop as task success', () => {
    for (const hook_event_name of ['SessionStart', 'PreToolUse', 'Stop']) {
      expect(recordVscodeHook({ hook_event_name, session_id: 'native-session', tool_name: 'read_file',
        tool_use_id: 'tool-1', prompt: 'private prompt', tool_response: 'private output' }, { storageDir: storage, cwd })).toBe(true);
    }
    const entries = new SavingsLedger({ rootDir: storage }).all();
    expect(entries.map((entry) => entry.strategy)).toEqual(['session:native-start', 'session:native-tool-start', 'session:native-stop']);
    expect(entries.every((entry) => entry.sessionId === 'vscode-chat:native-session' && entry.taskUsage === undefined)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('private');
  });

  it.each(['', ' padded ', 'invalid\nidentity', 'a'.repeat(257)])('does not truncate or guess invalid native identity %j', (session_id) => {
    expect(recordVscodeHook({ hook_event_name: 'Stop', session_id }, { storageDir: storage, cwd })).toBe(false);
    recordVscodeHook({ hook_event_name: 'UserPromptSubmit', session_id }, { storageDir: storage, cwd });
    expect(new SavingsLedger({ rootDir: storage }).all()[0].sessionId).toBeUndefined();
  });

  it('records native chat and tool activity without storing content or claiming savings', () => {
    const common = { session_id: 'native-session', cwd: path.join(cwd, 'extension', 'dist'), timestamp: '2026-09-11T12:00:00.000Z', transcript_path: 'private-transcript' };
    expect(recordVscodeHook({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'private prompt' }, { storageDir: storage, cwd })).toBe(true);
    expect(recordVscodeHook({ ...common, hook_event_name: 'PostToolUse', tool_name: 'read_file', tool_input: { filePath: 'private-file' }, tool_response: 'private output' }, { storageDir: storage, cwd })).toBe(true);
    const raw = fs.readFileSync(path.join(storage, 'savings.jsonl'), 'utf8');
    expect(raw).not.toContain('private');
    const ledger = new SavingsLedger({ rootDir: storage });
    expect(ledger.all().map((entry) => entry.strategy)).toEqual(['session:chat', 'session:tool-observed']);
    expect(ledger.all()[0]).toMatchObject({ sessionId: 'vscode-chat:native-session', ts: Date.parse(common.timestamp) });
    for (const entry of ledger.all()) {
      expect(entry).toMatchObject({ workspaceRoot: cwd, workspaceLabel: path.basename(cwd), sessionLabel: `VS Code chat: ${path.basename(cwd)}` });
    }
    expect(ledger.summary()).toMatchObject({ calls: 0, compressions: 0, retrievals: 0, tokensSaved: 0, estimatedCostSavedUsd: 0 });
    expect(ledger.all().every((entry) => entry.pricing === undefined)).toBe(true);
  });

  it.each([undefined, '', 'relative-workspace'])('leaves workspace unknown when the configured root is %s', (configuredRoot) => {
    for (const hookEvent of ['UserPromptSubmit', 'PostToolUse']) {
      recordVscodeHook({ hook_event_name: hookEvent, tool_name: 'read_file', cwd: hookEvent === 'PostToolUse' ? process.cwd() : undefined, session_id: 'unknown-workspace' },
        { storageDir: storage, cwd: configuredRoot });
    }
    const ledger = new SavingsLedger({ rootDir: storage });
    expect(ledger.all()).toHaveLength(2);
    for (const entry of ledger.all()) {
      expect(entry.workspaceRoot).toBeUndefined();
      expect(entry).toMatchObject({ workspaceLabel: 'Unknown workspace', sessionLabel: 'VS Code chat: Unknown workspace' });
    }
    expect(ledger.summary()).toMatchObject({ tokensSaved: 0, estimatedCostSavedUsd: 0 });
  });

  it('skips Slipstream tools and unsupported events', () => {
    for (const tool_name of ['slipstream_runCommand', 'mcp_slipstream_retrieve_artifact']) {
      expect(recordVscodeHook({ hook_event_name: 'PostToolUse', tool_name }, { storageDir: storage })).toBe(false);
    }
    expect(recordVscodeHook({ hook_event_name: 'Stop' }, { storageDir: storage })).toBe(false);
    expect(fs.existsSync(path.join(storage, 'savings.jsonl'))).toBe(false);
  });

  it('accepts omitted optional fields and fails safely on malformed input', () => {
    recordVscodeHook({ hook_event_name: 'UserPromptSubmit' }, { storageDir: storage, cwd, now: 100 });
    expect(new SavingsLedger({ rootDir: storage }).all()[0]).toMatchObject({ ts: 100, workspaceRoot: cwd });
    expect(() => recordVscodeHook(null, { storageDir: storage })).toThrow('must be an object');
    expect(() => recordVscodeHook({ hook_event_name: 'PostToolUse' }, { storageDir: storage })).toThrow('tool_name');
  });
});

describe('VS Code native policy hooks', () => {
  const policy = validateNativeChatPolicy({ version: 1, mode: 'guard', tokenLimit: 1000, checks: [{ kind: 'test', command: 'npm', args: ['test'] }] });
  const common = { session_id: 'native-session', tool_use_id: 'host-call', tool_name: 'slipstream_runCommand', tool_input: { command: 'npm', args: ['test'] } };

  it('keeps existing activity hooks passive by default', () => {
    expect(handleVscodeHook({ ...common, hook_event_name: 'PreToolUse' }, { storageDir: storage, cwd })).toEqual({});
    expect(fs.existsSync(path.join(storage, 'native-contexts'))).toBe(false);
  });

  it('fails open for malformed passive observations but closed for opted-in guards', () => {
    const malformed = { hook_event_name: 'PostToolUse', session_id: common.session_id };
    expect(handleVscodeHook(malformed, { storageDir: storage, cwd })).toEqual({});
    expect(handleVscodeHook(malformed, { storageDir: storage, cwd, policy: { ...policy, mode: 'observe' } }).continue).toBeUndefined();
    expect(handleVscodeHook(malformed, { storageDir: storage, cwd, policy })).toMatchObject({ continue: false });
  });

  it('injects a bound tool context without auto-approving the command', () => {
    const output = handleVscodeHook({ ...common, hook_event_name: 'PreToolUse' }, { storageDir: storage, cwd, policy });
    expect(output.continue).toBeUndefined();
    const updated = output.hookSpecificOutput!.updatedInput;
    expect(updated).toMatchObject(common.tool_input);
    expect(output.hookSpecificOutput).not.toHaveProperty('permissionDecision');
    expect(new NativeContextStore(storage, cwd).claim(updated.nativeContext, common.tool_name, updated, policy)).toMatchObject({ sessionId: common.session_id, toolCallId: common.tool_use_id, checkKind: 'test' });
  });

  it('does not infer a verification result from arbitrary tool output or stop', () => {
    handleVscodeHook({ ...common, hook_event_name: 'PostToolUse', tool_response: 'Tests passed; private output' }, { storageDir: storage, cwd, policy });
    const output = handleVscodeHook({ ...common, hook_event_name: 'Stop' }, { storageDir: storage, cwd, policy });
    expect(output.systemMessage).toContain('0 passed, 0 failed');
    expect(output).not.toHaveProperty('hookSpecificOutput');
    expect(new SavingsLedger({ rootDir: storage }).all().every((entry) => entry.taskUsage === undefined && entry.nativeChat?.event !== 'check')).toBe(true);
    expect(fs.readFileSync(path.join(storage, 'savings.jsonl'), 'utf8')).not.toContain('private output');
  });

  it('shows captured checks in chat without running another command or continuing a stopped agent', () => {
    recordNativeEvent(new SavingsLedger({ rootDir: storage }), cwd, { event: 'check', sessionId: common.session_id,
      toolCallId: common.tool_use_id, policyRevision: nativePolicyRevision(policy), checkKey: 'a'.repeat(64), checkKind: 'test', outcome: 'fail', exitCode: 1 });
    const output = handleVscodeHook({ ...common, hook_event_name: 'PostToolUse' }, { storageDir: storage, cwd, policy });
    expect(output.systemMessage).toContain('designated test check: fail');
    expect(handleVscodeHook({ ...common, hook_event_name: 'Stop', stop_hook_active: true }, { storageDir: storage, cwd, policy })).not.toHaveProperty('hookSpecificOutput');
  });

  it('stops only guard mode at hook boundaries, and leaves recovery tools available', () => {
    const zero = { ...policy, tokenLimit: 0 };
    expect(handleVscodeHook({ ...common, hook_event_name: 'PreToolUse' }, { storageDir: storage, cwd, policy: zero })).toMatchObject({ continue: false });
    expect(handleVscodeHook({ ...common, hook_event_name: 'PreToolUse', tool_name: 'run_in_terminal' }, { storageDir: storage, cwd, policy: zero })).toMatchObject({ continue: false });
    expect(handleVscodeHook({ ...common, hook_event_name: 'UserPromptSubmit' }, { storageDir: storage, cwd, policy: { ...zero, mode: 'observe' } }).continue).toBeUndefined();
    for (const tool_name of ['slipstream_retrieveArtifact', 'slipstream_getSavings']) {
      const output = handleVscodeHook({ ...common, hook_event_name: 'PreToolUse', tool_name, tool_input: {} }, { storageDir: storage, cwd, policy: zero });
      expect(output.continue).toBeUndefined();
      expect(output.hookSpecificOutput?.updatedInput.nativeContext).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('does not silently guard with missing host IDs or invalid settings', () => {
    expect(handleVscodeHook({ hook_event_name: 'UserPromptSubmit' }, { storageDir: storage, cwd, policy })).toMatchObject({ continue: false });
    expect(handleVscodeHook({ hook_event_name: 'UserPromptSubmit' }, { storageDir: storage, cwd, policy: { ...policy, mode: 'observe' } }).continue).toBeUndefined();
    expect(handleVscodeHook({ ...common, tool_use_id: undefined, hook_event_name: 'PreToolUse' }, { storageDir: storage, cwd, policy })).toMatchObject({ continue: false });
    expect(handleVscodeHook({ ...common, hook_event_name: 'UserPromptSubmit' }, { storageDir: storage, cwd, policy: null })).toMatchObject({ continue: false });
  });
});
