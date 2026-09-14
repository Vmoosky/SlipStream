import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  class LanguageModelTextPart { constructor(public value: string) {} }
  class LanguageModelToolResult { constructor(public content: unknown[]) {} }
  class MarkdownString {
    value = '';
    appendMarkdown(value: string) { this.value += value; return this; }
    appendCodeblock(value: string) { this.value += value; return this; }
  }
  const settings: Record<string, unknown> = {};
  const update = vi.fn(async (key: string, value: unknown, _target?: unknown) => { settings[key] = value; });
  return { settings, update, runCommand: vi.fn(), api: { LanguageModelTextPart, LanguageModelToolResult, MarkdownString,
    ConfigurationTarget: { WorkspaceFolder: 3 },
    Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
    workspace: { isTrusted: true, workspaceFolders: [] as { uri: { fsPath: string; scheme: string } }[],
      getConfiguration: () => ({ get: (key: string, fallback?: unknown) => settings[key] ?? fallback, inspect: () => undefined, update }) },
    window: { showWarningMessage: vi.fn(), showQuickPick: vi.fn(), showInputBox: vi.fn() },
  } };
});

vi.mock('vscode', () => mocks.api);
vi.mock('@slipstream/core', async (original) => ({ ...await original<object>(), runCommand: mocks.runCommand }));

import { CompressionEngine, NativeContextStore, nativeChatStatus, nativePolicyRevision, validateNativeChatPolicy } from '@slipstream/core';
import { configureNativeChatPolicy, NativeToolController, saveNativeChatPolicy } from '../src/nativeChat.js';
import { GetSavingsTool, RetrieveArtifactTool, RunCommandTool } from '../src/tools.js';

let storage: string;
let root: string;
let engine: CompressionEngine;
let controller: NativeToolController;
const input = { command: 'npm', args: ['test'] };
const policy = validateNativeChatPolicy({ version: 1, mode: 'guard', tokenLimit: 1000, checks: [{ kind: 'test', ...input }] });
let token: vscode.CancellationToken;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.settings)) delete mocks.settings[key];
  mocks.settings.nativeChatPolicy = policy;
  mocks.update.mockImplementation(async (key: string, value: unknown) => { mocks.settings[key] = value; });
  mocks.api.window.showQuickPick.mockReset();
  mocks.api.window.showInputBox.mockReset();
  mocks.api.window.showWarningMessage.mockReset();
  mocks.api.workspace.isTrusted = true;
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-native-tools-'));
  root = path.join(storage, 'workspace');
  fs.mkdirSync(root);
  mocks.api.workspace.workspaceFolders = [{ uri: { fsPath: root, scheme: 'file' } }];
  engine = new CompressionEngine({ rootDir: storage, workspaceRoots: [root], config: { pricing: { mode: 'manual' }, profile: 'conservative' } });
  controller = new NativeToolController(engine);
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  mocks.runCommand.mockResolvedValue({ ...input, cwd: root, exitCode: 0, stdout: 'Tests passed', stderr: '', durationMs: 1, timedOut: false });
});

afterEach(() => { controller.dispose(); engine.dispose(); fs.rmSync(storage, { recursive: true, force: true }); });

function options(toolName: string, toolInput: object = input, sessionId = 'native-session', toolCallId = 'call-1') {
  const active = validateNativeChatPolicy(mocks.settings.nativeChatPolicy);
  const nativeContext = new NativeContextStore(storage, root).issue(sessionId, toolCallId, toolName, toolInput, active);
  return { input: { ...toolInput, nativeContext }, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<typeof input & { nativeContext: string }>;
}

function commandTool() { return controller.wrap('slipstream_runCommand', (scoped, callbacks) => new RunCommandTool(scoped, callbacks?.commandComplete)); }
function text(result: vscode.LanguageModelToolResult) { return result.content.map((part) => (part as vscode.LanguageModelTextPart).value).join('\n'); }

describe('native registered tools', () => {
  it('preserves normal command approval and captures the actual designated result without an owned task', async () => {
    const invocation = options('slipstream_runCommand');
    const tool = commandTool();
    const prepared = await tool.prepareInvocation!(invocation, token);
    expect(prepared?.confirmationMessages?.title).toBe('Run a command');
    await tool.invoke(invocation, token);
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    const checks = engine.ledger.all().filter((entry) => entry.nativeChat?.event === 'check');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ sessionId: 'vscode-chat:native-session', nativeChat: { toolCallId: 'call-1', outcome: 'pass' } });
    expect(engine.ledger.all().every((entry) => entry.taskUsage === undefined)).toBe(true);
    expect(engine.getConfig().profile).toBe('conservative');
  });

  it.each(['timeout', 'cancelled', 'failed', 'error'])('does not promote a %s command into a passing check', async (failure) => {
    const invocation = options('slipstream_runCommand');
    if (failure === 'error') mocks.runCommand.mockRejectedValue(new Error('Command failed before completion'));
    else mocks.runCommand.mockImplementation(async () => {
      if (failure === 'cancelled') (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
      return { ...input, cwd: root, exitCode: failure === 'failed' ? 1 : 0, stdout: '', stderr: '', durationMs: 1, timedOut: failure === 'timeout' };
    });
    await commandTool().invoke(invocation, token);
    const check = engine.ledger.all().find((entry) => entry.nativeChat?.event === 'check')!.nativeChat!;
    expect(check.outcome).toBe(failure === 'failed' ? 'fail' : failure);
  });

  it('does not record ordinary successful commands as verification', async () => {
    await commandTool().invoke(options('slipstream_runCommand', { command: 'npm', args: ['--version'] }), token);
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(engine.ledger.all().filter((entry) => entry.nativeChat?.event === 'check')).toHaveLength(0);
  });

  it('rejects reused contexts and configuration changes without replaying a command', async () => {
    const invocation = options('slipstream_runCommand');
    const tool = commandTool();
    await tool.invoke(invocation, token);
    expect(text(await tool.invoke(invocation, token))).toContain('already used');
    const second = options('slipstream_runCommand', input, 'native-session', 'call-2');
    mocks.settings.nativeChatPolicy = { ...policy, tokenLimit: 2000 };
    expect(text(await tool.invoke(second, token))).toContain('changed');
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
  });

  it('respects trust, cancellation, and missing native hook support', async () => {
    const tool = commandTool();
    mocks.api.workspace.isTrusted = false;
    expect(text(await tool.invoke(options('slipstream_runCommand'), token))).toContain('Trust');
    mocks.api.workspace.isTrusted = true;
    (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    expect(text(await tool.invoke(options('slipstream_runCommand'), token))).toContain('cancelled');
    (token as { isCancellationRequested: boolean }).isCancellationRequested = false;
    expect(text(await tool.invoke({ input, toolInvocationToken: undefined }, token))).toContain('hook-provided');
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it('keeps legacy native tools unchanged when the policy is off', async () => {
    mocks.settings.nativeChatPolicy = validateNativeChatPolicy();
    await commandTool().invoke({ input, toolInvocationToken: undefined }, token);
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(engine.ledger.all().every((entry) => !entry.nativeChat)).toBe(true);
  });

  it('rechecks observed limits after approval while keeping retrieval and status available', async () => {
    const invocation = options('slipstream_runCommand');
    engine.ledger.record({ ts: 1, tool: 'session', label: 'Model', strategy: 'session:model', tokensBefore: 0, tokensAfter: 0,
      bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
      modelObservation: { traceId: 'trace', spanId: 'span', chatSessionId: 'native-session', provider: 'copilot', requestModel: 'model', inputTokens: 900, outputTokens: 200, startedAt: 1, endedAt: 2 } });
    expect(text(await commandTool().invoke(invocation, token))).toContain('Observed token limit');
    expect(mocks.runCommand).not.toHaveBeenCalled();
    const savings = controller.wrap('slipstream_getSavings', (scoped) => new GetSavingsTool(scoped));
    expect(text(await savings.invoke(options('slipstream_getSavings', {}, 'native-session', 'stats'), token))).toContain('native chat: paused');
    const retrieve = controller.wrap('slipstream_retrieveArtifact', (scoped, callbacks) => new RetrieveArtifactTool(scoped, callbacks?.retrievalComplete));
    await retrieve.invoke(options('slipstream_retrieveArtifact', { id: 'a'.repeat(12) }, 'native-session', 'retrieve') as never, token);
    expect(engine.ledger.all().some((entry) => entry.nativeChat?.event === 'recovery')).toBe(true);
  });

  it('isolates compression profiles between concurrent native conversations', async () => {
    engine.ledger.record({ ts: 1, tool: 'session', label: 'Model', strategy: 'session:model', tokensBefore: 0, tokensAfter: 0,
      bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
      modelObservation: { traceId: 'trace', spanId: 'span', chatSessionId: 'busy', provider: 'copilot', requestModel: 'model', inputTokens: 850, outputTokens: 0, startedAt: 1, endedAt: 2 } });
    const profiles: string[] = [];
    const probe = controller.wrap('slipstream_readFile', (scoped) => ({ invoke: async () => {
      profiles.push(scoped.getConfig().profile);
      return new mocks.api.LanguageModelToolResult([]) as vscode.LanguageModelToolResult;
    } }));
    await Promise.all([probe.invoke(options('slipstream_readFile', { path: 'file' }, 'busy'), token),
      probe.invoke(options('slipstream_readFile', { path: 'file' }, 'quiet'), token)]);
    expect(profiles).toEqual(['aggressive', 'conservative']);
    expect(engine.getConfig().profile).toBe('conservative');
    expect(nativeChatStatus(engine.ledger.all(), root, 'quiet', policy, 'conservative').observedTokens).toBeNull();
  });
});

describe('native policy setup', () => {
  it('saves only the confirmed native policy at workspace-folder scope', async () => {
    mocks.api.window.showQuickPick.mockResolvedValueOnce({ mode: 'observe' }).mockResolvedValueOnce({ action: 'done' });
    mocks.api.window.showInputBox.mockResolvedValueOnce('2000');
    mocks.api.window.showWarningMessage.mockResolvedValueOnce('Save policy');
    expect(await configureNativeChatPolicy(root)).toBe(true);
    expect(mocks.update).toHaveBeenCalledWith('nativeChatPolicy', { ...policy, mode: 'observe', tokenLimit: 2000 }, 3);
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.update.mock.calls.every(([key]) => key === 'nativeChatPolicy')).toBe(true);
  });

  it('designates an exact command during setup without executing it', async () => {
    mocks.settings.nativeChatPolicy = validateNativeChatPolicy();
    mocks.api.window.showQuickPick.mockResolvedValueOnce({ mode: 'observe' }).mockResolvedValueOnce({ action: 'test' }).mockResolvedValueOnce({ action: 'done' });
    mocks.api.window.showInputBox.mockResolvedValueOnce('').mockResolvedValueOnce('npm').mockResolvedValueOnce('["test"]').mockResolvedValueOnce('.');
    mocks.api.window.showWarningMessage.mockResolvedValueOnce('Save policy');
    expect(await configureNativeChatPolicy(root)).toBe(true);
    expect(validateNativeChatPolicy(mocks.settings.nativeChatPolicy).checks).toEqual([{ kind: 'test', command: 'npm', args: ['test'], cwd: '.' }]);
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it.each(['mode', 'limit', 'confirmation'])('leaves saved values unchanged when %s is cancelled', async (step) => {
    mocks.api.window.showQuickPick.mockResolvedValueOnce(step === 'mode' ? undefined : { mode: 'observe' }).mockResolvedValueOnce({ action: 'done' });
    mocks.api.window.showInputBox.mockResolvedValueOnce(step === 'limit' ? undefined : '1000');
    mocks.api.window.showWarningMessage.mockResolvedValueOnce(undefined);
    expect(await configureNativeChatPolicy(root)).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.settings.nativeChatPolicy).toEqual(policy);
  });

  it('rejects stale settings and revoked trust instead of overwriting them', async () => {
    const revision = nativePolicyRevision(policy);
    mocks.settings.nativeChatPolicy = { ...policy, tokenLimit: 2500 };
    await expect(saveNativeChatPolicy(root, policy, revision)).rejects.toThrow('changed');
    mocks.api.workspace.isTrusted = false;
    await expect(saveNativeChatPolicy(root, policy, revision)).rejects.toThrow('Trust');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('reports persistence failures and effective-setting conflicts', async () => {
    const revision = nativePolicyRevision(policy);
    mocks.update.mockRejectedValueOnce(new Error('Settings are read-only'));
    await expect(saveNativeChatPolicy(root, { ...policy, mode: 'observe' }, revision)).rejects.toThrow('read-only');
    mocks.update.mockImplementationOnce(async () => {});
    await expect(saveNativeChatPolicy(root, { ...policy, mode: 'observe' }, revision)).rejects.toThrow('effective');
  });

  it('rejects overlapping saves while the first write is in progress', async () => {
    let release!: () => void;
    mocks.update.mockImplementationOnce(async (key, value) => { await new Promise<void>((resolve) => { release = resolve; }); mocks.settings[key] = value; });
    const revision = nativePolicyRevision(policy);
    const first = saveNativeChatPolicy(root, { ...policy, mode: 'observe' }, revision);
    await expect(saveNativeChatPolicy(root, policy, revision)).rejects.toThrow('in progress');
    release();
    await first;
  });
});