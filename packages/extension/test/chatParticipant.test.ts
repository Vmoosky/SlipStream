import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AdHocChatTool, ChatHandlerOptions } from '@vscode/chat-extension-utils';

const mocks = vi.hoisted(() => {
  class CancellationTokenSource {
    listeners = new Set<() => void>();
    token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      },
    };
    cancel() { this.token.isCancellationRequested = true; for (const listener of this.listeners) listener(); }
    dispose() { this.listeners.clear(); }
  }
  class MarkdownString {
    value = '';
    appendMarkdown(text: string) { this.value += text; return this; }
    appendCodeblock(text: string) { this.value += text; return this; }
  }
  class LanguageModelTextPart { constructor(public value: string) {} }
  class LanguageModelToolResult { constructor(public content: unknown[]) {} }
  class LanguageModelToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
  class LanguageModelToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
  class ChatResponseTurn { constructor(public participant: string, public result: object) {} }
  const settings: Record<string, unknown> = {};
  return {
    send: vi.fn(), runCommand: vi.fn(), settings,
    api: {
      CancellationTokenSource, CancellationError: class extends Error {}, MarkdownString,
      LanguageModelTextPart, LanguageModelToolResult, LanguageModelToolCallPart, LanguageModelToolResultPart, ChatResponseTurn,
      ThemeIcon: class { constructor(public id: string) {} },
      chat: { createChatParticipant: vi.fn() },
      commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
      ProgressLocation: { Notification: 15 },
      workspace: { isTrusted: true, name: 'Test workspace', getConfiguration: () => ({
        get: (key: string, fallback: unknown) => settings[key] ?? fallback, inspect: () => undefined,
      }) },
      window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showQuickPick: vi.fn(), showInputBox: vi.fn(), withProgress: vi.fn() },
      lm: { tools: [] as { name: string; description: string; inputSchema: object; tags: string[] }[], invokeTool: vi.fn(), selectChatModels: vi.fn() },
    },
  };
});

vi.mock('vscode', () => mocks.api);
vi.mock('@slipstream/core', async (original) => ({ ...await original<object>(), runCommand: mocks.runCommand }));

import { buildTaskUsage, CompressionEngine, OwnedTaskUsage, recordTaskOutcome, taskWorkspaceKey, validateCostPolicy } from '@slipstream/core';
import { CHAT_PARTICIPANT_ID, createChatHandler, registerChatParticipant, RESUME_TASK_COMMAND } from '../src/chatParticipant.js';
import { readSettings } from '../src/config.js';
import { TOOL_NAMES } from '../src/tools.js';
import { createTaskVerifier, VERIFY_TASK_COMMAND } from '../src/taskVerification.js';

let root: string;
let parent: CompressionEngine;
let source: InstanceType<typeof mocks.api.CancellationTokenSource>;
let handler: vscode.ChatRequestHandler;
const stream = { progress: vi.fn(), markdown: vi.fn(), button: vi.fn() } as unknown as vscode.ChatResponseStream;

function request(id = 'first', extra: Partial<vscode.ChatRequest> = {}): vscode.ChatRequest {
  return { prompt: 'Inspect the workspace', references: [], toolReferences: [],
    model: { id, vendor: 'vendor', name: id, family: id, version: '1', maxInputTokens: 8000,
      countTokens: vi.fn(async () => 1), sendRequest: vi.fn(async () => ({
        stream: (async function* () { yield new mocks.api.LanguageModelTextPart('Response'); })(),
        text: (async function* () { yield 'Response'; })(),
      })),
    }, ...extra,
  } as vscode.ChatRequest;
}

function run(work: (options: ChatHandlerOptions, token: vscode.CancellationToken) => Promise<vscode.ChatResult>) {
  mocks.send.mockImplementation((_request: unknown, _context: unknown, options: ChatHandlerOptions, token: vscode.CancellationToken) => ({ result: work(options, token) }));
}

function tool(options: ChatHandlerOptions, name: string): AdHocChatTool<object> {
  return options.tools!.find((entry) => entry.name === name) as AdHocChatTool<object>;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.settings)) delete mocks.settings[key];
  mocks.api.workspace.isTrusted = true;
  mocks.api.lm.tools = [...Object.values(TOOL_NAMES), 'attached_tool'].map((name) => ({ name, description: name, inputSchema: {}, tags: [] }));
  mocks.api.window.showWarningMessage.mockReset().mockResolvedValue(undefined);
  mocks.api.window.showQuickPick.mockReset();
  mocks.api.window.showInputBox.mockReset();
  mocks.api.lm.selectChatModels.mockReset().mockResolvedValue([]);
  mocks.api.window.withProgress.mockImplementation(async (_options, work) => work({ report: vi.fn() }, source.token));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-chat-'));
  fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), revision: 'fixture', models: [
    { providerId: 'vendor', providerName: 'Vendor', modelId: 'first', modelName: 'First', input: 2, output: 4, toolCalling: true },
    { providerId: 'vendor', providerName: 'Vendor', modelId: 'second', modelName: 'Second', input: 8, output: 16, toolCalling: true },
  ] }));
  fs.writeFileSync(path.join(root, 'source.txt'), 'workspace content\n');
  parent = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'manual' }, usdPerMillionTokens: 99 } });
  handler = createChatHandler(parent, mocks.send);
  source = new mocks.api.CancellationTokenSource();
  mocks.runCommand.mockResolvedValue({ command: 'node', args: ['--version'], cwd: root, exitCode: 0, stdout: 'v24.0.0', stderr: '', durationMs: 1 });
  run(async () => ({ metadata: { preserved: true } }));
});

afterEach(() => {
  source.cancel();
  source.dispose();
  parent.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('model-aware chat participant', () => {
  it('records exact retrieval results for an opted-in task without declaring success', async () => {
    parent.updateConfig({ costPolicy: validateCostPolicy({ version: 1, mode: 'recommend-only' }) });
    run(async (options) => {
      await tool(options, TOOL_NAMES.read).invoke({ input: { path: path.join(root, 'source.txt') }, toolInvocationToken: undefined });
      const artifactId = parent.ledger.all().find((entry) => entry.tool === 'read_file')?.artifactId;
      expect(artifactId).toBeTruthy();
      await tool(options, TOOL_NAMES.retrieve).invoke({ input: { id: artifactId }, toolInvocationToken: undefined });
      await tool(options, TOOL_NAMES.retrieve).invoke({ input: { id: '000000000000' }, toolInvocationToken: undefined });
      return {};
    });
    const response = await handler(request(), { history: [] }, stream, source.token);
    expect(response?.errorDetails).toBeUndefined();
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({
      workspaceKey: taskWorkspaceKey(parent.getWorkspaceRoots()), retrievals: 1, recoveryFailures: 1, modelRetries: null,
      outcome: { status: 'unverified' },
    });
    expect(stream.button).toHaveBeenCalledWith({ command: VERIFY_TASK_COMMAND, title: 'Verify task outcome', arguments: [response?.metadata?.slipstreamTaskId] });
  });

  it('loads a versioned default-off policy from settings without changing host configuration', () => {
    expect(readSettings().costPolicy).toEqual(validateCostPolicy());
    mocks.settings.costPolicy = new Proxy(Object.freeze({ version: 1, mode: 'recommend-only' }), {});
    expect(readSettings().costPolicy?.mode).toBe('recommend-only');
    expect(() => structuredClone(readSettings().costPolicy)).not.toThrow();
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const setting = manifest.contributes.configuration.properties['slipstream.costPolicy'];
    expect(setting).toMatchObject({ scope: 'window', additionalProperties: false, required: ['version', 'mode'] });
    expect(validateCostPolicy(setting.default).mode).toBe('off');
    expect(setting.properties.mode.enum).toEqual(['off', 'recommend-only', 'automatic-owned-request']);
    expect(setting.properties.taskBudget).toMatchObject({ type: 'number', minimum: 0 });
    expect(setting.properties.modelSelection).toMatchObject({ enum: ['pinned', 'policy'], default: 'pinned' });
    expect(setting.properties.outputTokenAllowance).toMatchObject({ type: 'integer', minimum: 1, maximum: 32768, default: 2048 });
    expect(setting.properties.pressureThresholds).toMatchObject({ additionalProperties: false, required: ['balanced', 'aggressive'], default: { balanced: 0.5, aggressive: 0.8 } });
    expect(manifest.contributes.chatParticipants[0].commands.map((command: { name: string }) => command.name)).toEqual(['code', 'triage', 'summarize', 'resume']);
    mocks.settings.costPolicy = { version: 1, mode: 'recommend-only', taskBudget: 4000 };
    expect(readSettings().costPolicy?.taskBudget).toBe(4000);
  });

  it('starts separate tasks per request and deduplicates stream consumers without treating estimates as reported usage', async () => {
    parent.updateConfig({ costPolicy: validateCostPolicy({ version: 1, mode: 'recommend-only', taskBudget: 4000 }) });
    const before = parent.summary();
    run(async (options, token) => {
      const messages = [{ role: 1, content: [new mocks.api.LanguageModelTextPart('PRIVATE-PROMPT')] }] as vscode.LanguageModelChatMessage[];
      for (let round = 0; round < 2; round++) {
        const response = await options.model!.sendRequest(messages, {}, token);
        for await (const part of response.stream) void part;
        for await (const text of response.text) void text;
      }
      return {};
    });
    const first = await handler(request(), { history: [] }, stream, source.token);
    const history = [new mocks.api.ChatResponseTurn(CHAT_PARTICIPANT_ID, first!)] as unknown as vscode.ChatContext['history'];
    const second = await handler(request('second'), { history }, stream, source.token);
    expect(first?.metadata?.slipstreamTaskId).not.toBe(second?.metadata?.slipstreamTaskId);
    expect(first?.metadata?.slipstreamSessionId).toBe(second?.metadata?.slipstreamSessionId);
    const tasks = buildTaskUsage(parent.ledger.all());
    expect(tasks).toHaveLength(2);
    for (const task of tasks) expect(task).toMatchObject({
      state: 'finished', calls: 2, pendingCalls: 0, totalTokens: null, estimatedTokens: 2,
      limit: 4000, remaining: null, referenceUsd: null, budgetStatus: 'unknown', enforcement: 'not-enforced',
    });
    const events = parent.ledger.all().flatMap((entry) => entry.taskUsage ? [entry.taskUsage] : []);
    const starts = events.filter((event) => event.kind === 'call-start');
    expect(new Set(starts.map((event) => event.callId)).size).toBe(4);
    expect(starts.map((event) => event.rates.inputUsdPerMillion)).toEqual([2, 2, 8, 8]);
    expect(events.filter((event) => event.kind === 'call-end')).toHaveLength(4);
    expect(events.filter((event) => event.kind === 'call-usage')).toHaveLength(0);
    expect(parent.summary()).toEqual(before);
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).not.toContain('PRIVATE-PROMPT');
  });

  it('keeps unavailable input estimates unknown and does not block a request at an advisory zero budget', async () => {
    parent.updateConfig({ costPolicy: validateCostPolicy({ version: 1, mode: 'recommend-only', taskBudget: 0 }) });
    const selected = request();
    vi.mocked(selected.model.countTokens).mockRejectedValue(new Error('Unsupported counter'));
    run(async (options, token) => {
      const messages = [{ role: 1, content: [new mocks.api.LanguageModelTextPart('Input')] }] as vscode.LanguageModelChatMessage[];
      const response = await options.model!.sendRequest(messages, {}, token);
      for await (const part of response.stream) void part;
      return {};
    });
    expect((await handler(selected, { history: [] }, stream, source.token))?.errorDetails).toBeUndefined();
    expect(selected.model.sendRequest).toHaveBeenCalledOnce();
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ limit: 0, estimatedTokens: null, totalTokens: null, budgetStatus: 'unknown' });
  });

  it.each(['failed', 'cancelled'] as const)('records %s sends without assuming that the call was free', async (state) => {
    parent.updateConfig({ costPolicy: validateCostPolicy({ version: 1, mode: 'recommend-only', taskBudget: 1000 }) });
    const selected = request();
    vi.mocked(selected.model.sendRequest).mockImplementation(async () => {
      if (state === 'cancelled') source.cancel();
      throw new Error('Send failed');
    });
    run(async (options, token) => { await options.model!.sendRequest([], {}, token); return {}; });
    await handler(selected, { history: [] }, stream, source.token);
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state, calls: 1, pendingCalls: 0, totalTokens: null, referenceUsd: null });
    expect(parent.ledger.all().find((entry) => entry.taskUsage?.kind === 'call-end')?.taskUsage).toMatchObject({ state });
  });

  it('rejects malformed policy settings with one warning and leaves compression settings alone', () => {
    readSettings();
    mocks.settings.costPolicy = { version: 99, mode: 'automatic-owned-request' };
    mocks.settings.enabled = false;
    expect(readSettings()).toMatchObject({ costPolicy: validateCostPolicy(), enabled: false });
    readSettings();
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Invalid slipstream.costPolicy'));
    expect(mocks.settings.costPolicy).toEqual({ version: 99, mode: 'automatic-owned-request' });
    delete mocks.settings.costPolicy;
    readSettings();
  });

  it.each(['first', 'second'])('records advisory decisions without changing the pinned %s model or command approvals', async (id) => {
    parent.updateConfig({ costPolicy: validateCostPolicy({
      version: 1, mode: 'recommend-only', allowedModels: [{ vendor: 'vendor', id: 'first' }],
    }) });
    const before = parent.summary();
    const selected = request(id);
    run(async (options, token) => {
      await options.model!.sendRequest([], {}, token);
      await tool(options, TOOL_NAMES.run).invoke({ input: { command: 'node', args: ['--version'], cwd: root }, toolInvocationToken: undefined });
      return {};
    });
    const response = await handler(selected, { history: [] }, stream, source.token);
    expect(selected.model.sendRequest).toHaveBeenCalledOnce();
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledWith('Run a command', expect.anything(), 'Run');
    const assessment = response?.metadata?.slipstreamCostPolicy;
    expect(assessment).toMatchObject({ host: 'owned-chat', scope: 'task', effectiveMode: 'recommend-only', coverage: 'not-measured' });
    expect(assessment.decisions[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining(id === 'first' ? 'retained' : 'conflicts') });
    const audit = parent.ledger.all().filter((entry) => entry.costPolicyAssessment?.scope === 'task');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.pricing).toBeUndefined();
    expect(parent.summary()).toEqual(before);
    expect(stream.progress).toHaveBeenCalledWith(expect.stringContaining('advisory only'));
  });

  it('opens Slipstream in Ask mode without selecting a model or sending a request', async () => {
    const participant = { dispose: vi.fn() };
    const command = { dispose: vi.fn() };
    mocks.api.chat.createChatParticipant.mockReturnValue(participant);
    mocks.api.commands.registerCommand.mockReturnValue(command);
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

    registerChatParticipant(context, parent);
    expect(mocks.api.chat.createChatParticipant).toHaveBeenCalledWith(CHAT_PARTICIPANT_ID, expect.any(Function));
    expect(context.subscriptions).toEqual([participant, command, command, command]);
    expect(mocks.api.commands.registerCommand).toHaveBeenCalledWith(VERIFY_TASK_COMMAND, expect.any(Function));
    expect(mocks.api.commands.registerCommand).toHaveBeenCalledWith(RESUME_TASK_COMMAND, expect.any(Function));
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.contributes.commands).toContainEqual(expect.objectContaining({ command: VERIFY_TASK_COMMAND, enablement: 'isWorkspaceTrusted' }));
    const [commandId, startChat] = mocks.api.commands.registerCommand.mock.calls[0];
    expect(commandId).toBe('slipstream.startChat');
    await startChat();

    expect(mocks.api.commands.executeCommand).toHaveBeenCalledExactlyOnceWith('workbench.action.chat.open', {
      mode: 'ask', query: '@slipstream ', isPartialQuery: true,
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(parent.ledger.all()).toEqual([]);
  });

  it('prices simultaneous tool calls with their own detected models, ignoring the parent manual rate', async () => {
    run(async (options) => {
      await tool(options, TOOL_NAMES.read).invoke({ input: { path: path.join(root, 'source.txt') }, toolInvocationToken: undefined });
      return { metadata: { preserved: true } };
    });
    const responses = await Promise.all(['first', 'second', 'unknown'].map((id) => handler(request(id), { history: [] }, stream, source.token)));
    const events = parent.ledger.recent(20).filter((entry) => entry.tool === 'read_file');
    expect(Object.fromEntries(events.map((entry) => [entry.pricing?.detectedModel?.id, entry.pricing?.inputUsdPerMillion]))).toEqual({ first: 2, second: 8, unknown: null });
    expect(responses[0]?.metadata).toMatchObject({ preserved: true, slipstreamModel: { id: 'first', vendor: 'vendor' } });
    expect(parent.getConfig().pricing.mode).toBe('manual');
  });

  it('uses the selected model and preserves conversation context, references and streaming', async () => {
    const selected = request();
    const context = { history: [] };
    run(async (options, token) => {
      const response = await options.model!.sendRequest([], {}, token);
      for await (const part of response.stream) expect(part).toBeInstanceOf(mocks.api.LanguageModelTextPart);
      return { metadata: { preserved: true } };
    });
    await handler(selected, context, stream, source.token);
    expect(selected.model.sendRequest).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith(selected, context, expect.objectContaining({
      model: expect.objectContaining({ id: selected.model.id }),
      responseStreamOptions: { stream, references: true, responseText: true },
    }), expect.anything());
    expect(parent.ledger.recent(1)[0]).toMatchObject({ strategy: 'session:model', detectedModel: { id: 'first' }, tokensBefore: 0, tokensAfter: 0 });
    expect(parent.summary().compressions).toBe(0);
    expect(selected.model.countTokens).not.toHaveBeenCalled();
    expect(buildTaskUsage(parent.ledger.all())).toEqual([]);
    expect(stream.button).not.toHaveBeenCalled();
  });

  it('keeps the same conversation ID when the selected model changes', async () => {
    const first = await handler(request(), { history: [] }, stream, source.token);
    const history = [new mocks.api.ChatResponseTurn(CHAT_PARTICIPANT_ID, first!)] as unknown as vscode.ChatContext['history'];
    const second = await handler(request('second'), { history }, stream, source.token);
    expect(second?.metadata?.slipstreamSessionId).toBe(first?.metadata?.slipstreamSessionId);
    expect(second?.metadata?.slipstreamModel.id).toBe('second');
  });

  it.each([undefined, 'Run'])('requires command confirmation (%s)', async (approval) => {
    mocks.api.window.showWarningMessage.mockResolvedValue(approval);
    run(async (options) => {
      await tool(options, TOOL_NAMES.run).invoke({ input: { command: 'node', args: ['--version'], cwd: root }, toolInvocationToken: undefined });
      return {};
    });
    await handler(request(), { history: [] }, stream, source.token);
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledWith('Run a command', expect.objectContaining({ modal: true, detail: expect.stringContaining('node --version') }), 'Run');
    expect(mocks.runCommand).toHaveBeenCalledTimes(approval ? 1 : 0);
    if (approval) expect(parent.ledger.recent(1)[0].pricing).toMatchObject({ inputUsdPerMillion: 2, detectedModel: { id: 'first' } });
  });

  it('does not execute a command when cancelled during confirmation', async () => {
    mocks.api.window.showWarningMessage.mockImplementation(async () => { source.cancel(); return 'Run'; });
    run(async (options) => {
      await tool(options, TOOL_NAMES.run).invoke({ input: { command: 'node' }, toolInvocationToken: undefined });
      return {};
    });
    expect(await handler(request(), { history: [] }, stream, source.token)).toBeUndefined();
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it('refuses untrusted workspaces and does nothing for already-cancelled requests', async () => {
    mocks.api.workspace.isTrusted = false;
    expect(await handler(request(), { history: [] }, stream, source.token)).toMatchObject({ errorDetails: { message: expect.stringContaining('Trust') } });
    mocks.api.workspace.isTrusted = true;
    source.cancel();
    expect(await handler(request(), { history: [] }, stream, source.token)).toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(parent.ledger.recent()).toHaveLength(0);
  });

  it('does not allow the library to silently substitute its legacy fallback model', async () => {
    const selected = request();
    Object.assign(selected.model, { vendor: 'copilot', family: 'o1' });
    expect(await handler(selected, { history: [] }, stream, source.token)).toMatchObject({ errorDetails: { message: expect.stringContaining('will not switch') } });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('blocks model-invented tool names before the library can invoke a global tool', async () => {
    const selected = request();
    vi.mocked(selected.model.sendRequest).mockResolvedValue({
      text: (async function* () {})(),
      stream: (async function* () { yield new mocks.api.LanguageModelToolCallPart('call', 'attached_tool', {}); })(),
    });
    run(async (options, token) => {
      const response = await options.model!.sendRequest([], {}, token);
      for await (const part of response.stream) void part;
      return {};
    });
    expect(await handler(selected, { history: [] }, stream, source.token)).toMatchObject({ errorDetails: { message: expect.stringContaining('unavailable tool') } });
    expect(mocks.api.lm.invokeTool).not.toHaveBeenCalled();
  });

  it('routes explicitly attached native tools through VS Code with cancellation', async () => {
    mocks.api.lm.invokeTool.mockResolvedValue(new mocks.api.LanguageModelToolResult([]));
    run(async (options, token) => {
      await tool(options, 'attached_tool').invoke({ input: {}, toolInvocationToken: undefined });
      expect(mocks.api.lm.invokeTool).toHaveBeenCalledWith('attached_tool', expect.anything(), token);
      return {};
    });
    expect((await handler(request('first', { toolReferences: [{ name: 'attached_tool' }] }), { history: [] }, stream, source.token))?.errorDetails).toBeUndefined();
  });

  it('bounds repeated tool calls and disposes request resources on failure', async () => {
    const dispose = vi.spyOn(CompressionEngine.prototype, 'dispose');
    run(async (options) => {
      for (let count = 0; count < 41; count++) await tool(options, TOOL_NAMES.savings).invoke({ input: {}, toolInvocationToken: undefined });
      return {};
    });
    expect(await handler(request(), { history: [] }, stream, source.token)).toMatchObject({ errorDetails: { message: expect.stringContaining('40 tool calls') } });
    expect(dispose).toHaveBeenCalledOnce();
    expect(source.listeners.size).toBe(0);
  });

  it.each([undefined, 0, 7.125, 99])('uses fallback %s while ignoring persisted model selections', (rate) => {
    Object.assign(mocks.settings, { pricing: { mode: 'manual' }, usdPerMillionTokens: rate });
    if (rate === undefined) Reflect.deleteProperty(mocks.settings, 'usdPerMillionTokens');
    expect(readSettings().pricing).toEqual({ mode: 'automatic' });
    expect(readSettings().usdPerMillionTokens).toBe(rate ?? 3);
    const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.contributes.configuration.properties).not.toHaveProperty('slipstream.pricing');
    expect(manifest.contributes.configuration.properties['slipstream.usdPerMillionTokens']).toMatchObject({ type: 'number', default: 3, minimum: 0 });
    expect(manifest.contributes.chatParticipants).toContainEqual(expect.objectContaining({ id: CHAT_PARTICIPANT_ID, name: 'slipstream', isSticky: true }));
  });
});

describe('automatic owned task policy', () => {
  function enable(extra: Record<string, unknown> = {}) {
    parent.updateConfig({ costPolicy: validateCostPolicy({ version: 1, mode: 'automatic-owned-request', taskBudget: 1200, outputTokenAllowance: 512,
      allowedModels: [{ vendor: 'vendor', id: 'first' }, { vendor: 'vendor', id: 'second' }], ...extra }) });
  }

  function prove(model: vscode.LanguageModelChat) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const task = new OwnedTaskUsage(parent.ledger, { sessionId: 'evidence', policyRevision: 'a'.repeat(64), unit: 'tokens', category: 'code', workspaceKey: taskWorkspaceKey(parent.getWorkspaceRoots()) });
      const callId = task.startCall({ vendor: model.vendor, id: model.id }, parent.pricing.snapshot({ mode: 'automatic' }, 0, { vendor: model.vendor, id: model.id, name: model.name }));
      task.finishCall(callId, 'finished');
      task.finish('finished');
      recordTaskOutcome(parent.ledger, task.taskId, { source: 'command', check: 'test', execution: 'completed', exitCode: 0, durationMs: 1 });
    }
  }

  function sendRounds(count = 1) {
    run(async (options, token) => {
      for (let round = 0; round < count; round++) {
        const response = await options.model!.sendRequest([{ role: 1, content: [new mocks.api.LanguageModelTextPart('PRIVATE-INPUT')] }] as vscode.LanguageModelChatMessage[], {}, token);
        for await (const part of response.stream) void part;
      }
      return {};
    });
  }

  it.each([false, true])('resumes the exact task and fixed model without replaying history or resetting its budget (routed=%s)', async (routed) => {
    enable({ taskBudget: 3000, modelSelection: 'policy' });
    const original = request('second', { command: 'code' });
    const cheaper = request('first').model;
    if (routed) {
      prove(original.model);
      prove(cheaper);
      mocks.api.lm.selectChatModels.mockResolvedValue([cheaper]);
      handler = createChatHandler(parent, mocks.send, { canSendRequest: () => true } as unknown as vscode.LanguageModelAccessInformation);
    }
    run(async (options, token) => {
      const response = await options.model!.sendRequest([], {}, token);
      for await (const part of response.stream) void part;
      throw new Error('Interrupted fixture');
    });
    const first = await handler(original, { history: [] }, stream, source.token);
    const taskId = first?.metadata?.slipstreamTaskId;
    expect(typeof taskId).toBe('string');
    const before = buildTaskUsage(parent.ledger.all()).find((task) => task.taskId === taskId)!;
    prove(original.model);
    prove(cheaper);
    mocks.api.lm.selectChatModels.mockClear();
    mocks.api.lm.selectChatModels.mockResolvedValue([cheaper]);
    handler = createChatHandler(parent, mocks.send, { canSendRequest: () => true } as unknown as vscode.LanguageModelAccessInformation);
    sendRounds();
    const next = request(routed ? 'first' : 'second', { command: 'resume', prompt: `${taskId} Inspect the current file` });
    const previous = new mocks.api.ChatResponseTurn(CHAT_PARTICIPANT_ID, first!);
    const response = await handler(next, { history: [previous as unknown as vscode.ChatResponseTurn] }, stream, source.token);
    expect(response?.errorDetails).toBeUndefined();
    expect(response?.metadata?.slipstreamTaskId).toBe(taskId);
    expect(response?.metadata?.slipstreamSessionId).toBe(first?.metadata?.slipstreamSessionId);
    expect(next.model.sendRequest).toHaveBeenCalledTimes(1);
    expect(cheaper.sendRequest).toHaveBeenCalledTimes(routed ? 1 : 0);
    expect(mocks.api.lm.selectChatModels).not.toHaveBeenCalled();
    expect(mocks.send.mock.lastCall?.[0]).toMatchObject({ command: 'code', prompt: 'Inspect the current file' });
    expect(mocks.send.mock.lastCall?.[1]).toEqual({ history: [] });
    expect(buildTaskUsage(parent.ledger.all()).find((task) => task.taskId === taskId)).toMatchObject({
      state: 'finished', resumes: 1, calls: 2, category: 'code', allowanceUsed: before.allowanceUsed! + 770,
    });
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).not.toContain('Inspect the current file');
  });

  it.each(['exhausted', 'model', 'policy', 'disabled', 'missing-step'] as const)('does not send or create a fresh task when resume is %s', async (failure) => {
    enable({ taskBudget: 900 });
    sendRounds(2);
    const first = await handler(request(), { history: [] }, stream, source.token);
    const taskId = first?.metadata?.slipstreamTaskId;
    expect(taskId).toBeTruthy();
    if (failure === 'policy') enable({ taskBudget: 3000 });
    if (failure === 'disabled') parent.updateConfig({ costPolicy: validateCostPolicy({ version: 1, mode: 'off' }) });
    const next = request(failure === 'model' ? 'second' : 'first', { command: 'resume', prompt: `${taskId}${failure === 'missing-step' ? '' : ' Next step'}` });
    const response = await handler(next, { history: [] }, stream, source.token);
    expect(response?.errorDetails).toBeDefined();
    expect(next.model.sendRequest).not.toHaveBeenCalled();
    expect(buildTaskUsage(parent.ledger.all())).toHaveLength(1);
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ taskId, allowanceUsed: 770 });
  });

  it('opens a partial resume draft without sending a model request', async () => {
    enable({ taskBudget: 900 });
    sendRounds(2);
    const first = await handler(request(), { history: [] }, stream, source.token);
    const taskId = first?.metadata?.slipstreamTaskId;
    mocks.api.chat.createChatParticipant.mockReturnValue({ dispose: vi.fn() });
    registerChatParticipant({ subscriptions: [] } as unknown as vscode.ExtensionContext, parent);
    const resume = mocks.api.commands.registerCommand.mock.calls.find(([name]) => name === RESUME_TASK_COMMAND)![1];
    await resume(taskId);
    expect(mocks.api.commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', {
      mode: 'ask', query: `@slipstream /resume ${taskId} `, isPartialQuery: true,
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.settings).toEqual({});
  });

  it('preserves recovery backoff and command approvals across resume', async () => {
    enable({ taskBudget: 3000 });
    run(async (options, token) => {
      const response = await options.model!.sendRequest([], {}, token);
      for await (const part of response.stream) void part;
      await tool(options, TOOL_NAMES.retrieve).invoke({ input: { id: '000000000000' }, toolInvocationToken: undefined });
      throw new Error('Interrupted fixture');
    });
    const first = await handler(request(), { history: [] }, stream, source.token);
    run(async (options, token) => {
      await tool(options, TOOL_NAMES.run).invoke({ input: { command: 'node', args: ['--version'], cwd: root }, toolInvocationToken: undefined });
      await tool(options, TOOL_NAMES.retrieve).invoke({ input: { id: '000000000000' }, toolInvocationToken: undefined });
      await options.model!.sendRequest([], {}, token);
      return {};
    });
    const next = request('first', { command: 'resume', prompt: `${first?.metadata?.slipstreamTaskId} Recover the original content` });
    const response = await createChatHandler(parent, mocks.send)(next, { history: [] }, stream, source.token);
    expect(response?.errorDetails?.message).toContain('recovery failures');
    expect(next.model.sendRequest).not.toHaveBeenCalled();
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalled();
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'paused', resumes: 1, recoveryFailures: 2, calls: 1, policyDecision: { profile: 'conservative' } });
  });

  it('sends to the cheaper permitted authorized model only with explicit routing and verified task evidence', async () => {
    enable({ modelSelection: 'policy' });
    const selected = request('second', { command: 'code' });
    const cheaper = request('first').model;
    prove(selected.model);
    prove(cheaper);
    mocks.api.lm.selectChatModels.mockResolvedValue([cheaper, selected.model]);
    handler = createChatHandler(parent, mocks.send, { canSendRequest: () => true } as unknown as vscode.LanguageModelAccessInformation);
    sendRounds();
    const response = await handler(selected, { history: [] }, stream, source.token);
    expect(response?.errorDetails).toBeUndefined();
    expect(cheaper.sendRequest).toHaveBeenCalledTimes(1);
    expect(selected.model.sendRequest).not.toHaveBeenCalled();
    expect(response?.metadata?.slipstreamModel).toMatchObject({ id: 'first' });
    const task = buildTaskUsage(parent.ledger.all()).find((task) => task.taskId === response?.metadata?.slipstreamTaskId)!;
    expect(task).toMatchObject({ enforcement: 'local-allowance', totalTokens: null, estimatedTokens: 2, allowanceUsed: 770,
      policyDecision: { requestedModel: { id: 'second' }, selectedModel: { id: 'first' }, reason: 'lower-reference-cost' } });
    const call = parent.ledger.all().find((entry) => entry.taskUsage?.taskId === task.taskId && entry.taskUsage.kind === 'call-start')?.taskUsage;
    expect(call).toMatchObject({ model: { id: 'first' }, rates: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } });
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).not.toContain('PRIVATE-INPUT');
  });

  it.each(['pinned', 'unverified', 'unauthorized'] as const)('retains the selected model when %s', async (reason) => {
    enable({ modelSelection: reason === 'pinned' ? 'pinned' : 'policy' });
    const selected = request('second', { command: 'code' });
    const cheaper = request('first').model;
    if (reason !== 'unverified') { prove(selected.model); prove(cheaper); }
    mocks.api.lm.selectChatModels.mockResolvedValue([cheaper]);
    handler = createChatHandler(parent, mocks.send, { canSendRequest: (model: vscode.LanguageModelChat) => model.id === 'second' || reason !== 'unauthorized' } as unknown as vscode.LanguageModelAccessInformation);
    sendRounds();
    expect((await handler(selected, { history: [] }, stream, source.token))?.errorDetails).toBeUndefined();
    expect(selected.model.sendRequest).toHaveBeenCalledTimes(1);
    expect(cheaper.sendRequest).not.toHaveBeenCalled();
  });

  it('applies configured pressure thresholds only to the owned task', async () => {
    enable({ pressureThresholds: { balanced: 0.3, aggressive: 0.6 } });
    const before = parent.getConfig();
    sendRounds();
    const response = await handler(request(), { history: [] }, stream, source.token);
    expect(response?.errorDetails).toBeUndefined();
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({
      allowanceUsed: 770, policyDecision: { state: 'active', profile: 'aggressive' },
    });
    expect(parent.getConfig()).toEqual(before);
    expect(mocks.settings).toEqual({});
  });

  it('pauses before a second call and leaves parent compression and workspace settings untouched', async () => {
    enable({ taskBudget: 900 });
    const selected = request();
    const before = parent.getConfig();
    sendRounds(2);
    const response = await handler(selected, { history: [] }, stream, source.token);
    expect(response?.errorDetails?.message).toContain('remaining local allowance');
    expect(selected.model.sendRequest).toHaveBeenCalledTimes(1);
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'paused', enforcement: 'local-allowance', allowanceUsed: 770, allowanceRemaining: 130,
      totalTokens: null, policyDecision: { reason: 'budget-limit', profile: 'aggressive' } });
    expect(parent.getConfig()).toEqual(before);
    expect(mocks.settings).toEqual({});
  });

  it.each(['empty-models', 'zero-budget', 'missing-budget', 'unknown-input', 'unknown-model', 'context', 'unpriced-dollars'] as const)('does not send when %s prevents admission', async (failure) => {
    enable(failure === 'empty-models' ? { allowedModels: [] } : failure === 'zero-budget' ? { taskBudget: 0 }
      : failure === 'missing-budget' ? { taskBudget: undefined } : failure === 'unpriced-dollars' ? { budgetUnit: 'reference-usd', taskBudget: 1 } : {});
    const selected = request(failure === 'unknown-model' || failure === 'unpriced-dollars' ? 'unknown' : 'first');
    if (failure === 'unknown-input') vi.mocked(selected.model.countTokens).mockRejectedValue(new Error('Unavailable'));
    if (failure === 'context') Object.assign(selected.model, { maxInputTokens: 10 });
    sendRounds();
    expect((await handler(selected, { history: [] }, stream, source.token))?.errorDetails?.message).toContain('paused');
    expect(selected.model.sendRequest).not.toHaveBeenCalled();
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'paused', calls: 0 });
  });

  it('cancels oversized streamed output before tools can consume it without claiming reported usage', async () => {
    enable({ outputTokenAllowance: 1 });
    const selected = request();
    vi.mocked(selected.model.countTokens).mockResolvedValue(2);
    sendRounds();
    const response = await handler(selected, { history: [] }, stream, source.token);
    expect(response?.errorDetails?.message).toContain('output allowance');
    expect(vi.mocked(selected.model.sendRequest).mock.calls[0]?.[2]?.isCancellationRequested).toBe(true);
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'paused', reportedCalls: 0, totalTokens: null,
      policyDecision: { reason: 'output-limit' }, pendingCalls: 0 });
  });

  it('does not turn a failed send into a complete zero-output estimate or refund its allowance', async () => {
    enable();
    const selected = request();
    vi.mocked(selected.model.sendRequest).mockRejectedValue(new Error('Model unavailable'));
    sendRounds();
    expect((await handler(selected, { history: [] }, stream, source.token))?.errorDetails?.message).toContain('Model unavailable');
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'failed', calls: 1, estimatedTokens: 1, estimateCoverage: 'partial',
      outputTokens: null, reportedCalls: 0, allowanceUsed: 770 });
  });

  it.each(['output', 'toolCalling'] as const)('does not send a permitted model when cached %s coverage is missing', async (field) => {
    const cachePath = path.join(root, 'pricing-cache.json');
    const catalog = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    delete catalog.models[0][field];
    fs.writeFileSync(cachePath, JSON.stringify(catalog));
    parent.dispose();
    parent = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    handler = createChatHandler(parent, mocks.send);
    enable({ budgetUnit: 'reference-usd', taskBudget: 1 });
    const selected = request();
    sendRounds();
    const response = await handler(selected, { history: [] }, stream, source.token);
    expect(response?.errorDetails?.message).toContain(field === 'output' ? 'fresh input and output reference prices' : 'tool-capable');
    expect(selected.model.sendRequest).not.toHaveBeenCalled();
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'paused', calls: 0,
      policyDecision: { reason: field === 'output' ? 'unknown-price' : 'no-compatible-model' } });
  });

  it('stops when policy changes during counting instead of sending under stale permissions', async () => {
    enable();
    const selected = request();
    vi.mocked(selected.model.countTokens).mockImplementation(async () => {
      parent.updateConfig({ costPolicy: validateCostPolicy() });
      return 1;
    });
    sendRounds();
    expect((await handler(selected, { history: [] }, stream, source.token))?.errorDetails?.message).toContain('policy changed');
    expect(selected.model.sendRequest).not.toHaveBeenCalled();
  });

  it('admits at most one of two concurrent calls when only one allowance fits', async () => {
    enable({ taskBudget: 900 });
    const selected = request();
    run(async (options, token) => {
      const attempts = await Promise.allSettled([0, 1].map(async () => options.model!.sendRequest([], {}, token)));
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
      return {};
    });
    const response = await handler(selected, { history: [] }, stream, source.token);
    expect(response?.errorDetails?.message).toContain('allowance');
    expect(selected.model.sendRequest).toHaveBeenCalledTimes(1);
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'paused', calls: 1, pendingCalls: 0, allowanceUsed: 768 });
  });

  it('keeps command approval explicit and never replays the command after a budget pause', async () => {
    enable({ taskBudget: 900 });
    const selected = request();
    mocks.api.window.showWarningMessage.mockResolvedValue('Run');
    run(async (options, token) => {
      const response = await options.model!.sendRequest([], {}, token);
      for await (const part of response.stream) void part;
      await tool(options, TOOL_NAMES.run).invoke({ input: { command: 'node', args: ['--version'], cwd: root }, toolInvocationToken: undefined });
      await options.model!.sendRequest([], {}, token);
      return {};
    });
    expect((await handler(selected, { history: [] }, stream, source.token))?.errorDetails?.message).toContain('allowance');
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledExactlyOnceWith('Run a command', expect.anything(), 'Run');
    expect(mocks.runCommand).toHaveBeenCalledTimes(1);
    expect(selected.model.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('preserves command denial and recovers omitted artifacts with a task-local conservative profile', async () => {
    enable({ taskBudget: 900 });
    const profiles: unknown[] = [];
    const update = CompressionEngine.prototype.updateConfig;
    vi.spyOn(CompressionEngine.prototype, 'updateConfig').mockImplementation(function (patch) {
      if (this !== parent && patch.profile) profiles.push(patch.profile);
      return update.call(this, patch);
    });
    run(async (options, token) => {
      const response = await options.model!.sendRequest([], {}, token);
      for await (const part of response.stream) void part;
      await tool(options, TOOL_NAMES.run).invoke({ input: { command: 'node', args: ['--version'], cwd: root }, toolInvocationToken: undefined });
      await tool(options, TOOL_NAMES.read).invoke({ input: { path: path.join(root, 'source.txt') }, toolInvocationToken: undefined });
      const artifactId = parent.ledger.all().find((entry) => entry.tool === 'read_file')!.artifactId;
      await tool(options, TOOL_NAMES.retrieve).invoke({ input: { id: artifactId }, toolInvocationToken: undefined });
      await tool(options, TOOL_NAMES.retrieve).invoke({ input: { id: '000000000000' }, toolInvocationToken: undefined });
      return {};
    });
    expect((await handler(request(), { history: [] }, stream, source.token))?.errorDetails).toBeUndefined();
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(profiles).toEqual(['aggressive', 'conservative']);
    expect(parent.getConfig().profile).toBe('balanced');
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ retrievals: 1, recoveryFailures: 1, policyDecision: { profile: 'conservative' } });
  });

  it('attributes compressed tool output and retrieved tokens to the owned task and records feedback', async () => {
    enable({ taskBudget: 5000, compressionFeedback: { version: 1, enabled: true } });
    run(async (options, token) => {
      const response = await options.model!.sendRequest([], {}, token);
      for await (const part of response.stream) void part;
      await tool(options, TOOL_NAMES.read).invoke({ input: { path: path.join(root, 'source.txt') }, toolInvocationToken: undefined });
      const artifactId = parent.ledger.all().find((entry) => entry.tool === 'read_file')!.artifactId;
      await tool(options, TOOL_NAMES.retrieve).invoke({ input: { id: artifactId }, toolInvocationToken: undefined });
      return {};
    });
    expect((await handler(request(), { history: [] }, stream, source.token))?.errorDetails).toBeUndefined();
    const task = buildTaskUsage(parent.ledger.all())[0]!;
    expect(task.compression).toEqual([expect.objectContaining({ profile: 'balanced', samples: 1 })]);
    expect(task.compression![0]!.tokensAfter).toBeLessThanOrEqual(task.compression![0]!.tokensBefore);
    expect(task.retrievals).toBe(1);
    expect(task.retrievedTokens).toBeGreaterThan(0);
    // No verified history exists yet, so sparse evidence cannot raise compression.
    expect(task.compressionFeedback).toMatchObject({ action: 'hold', reason: 'insufficient-samples', profile: 'balanced' });
    expect(parent.getConfig().profile).toBe('balanced');
  });

  it('honors cancellation while input tokens are being counted', async () => {    enable();
    const selected = request();
    vi.mocked(selected.model.countTokens).mockImplementation(async () => { source.cancel(); return 1; });
    sendRounds();
    expect(await handler(selected, { history: [] }, stream, source.token)).toBeUndefined();
    expect(selected.model.sendRequest).not.toHaveBeenCalled();
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ state: 'cancelled', calls: 0 });
  });
});

describe('explicit task outcome verification', () => {
  function completedTask(workspaceKey = taskWorkspaceKey(parent.getWorkspaceRoots())) {
    const task = new OwnedTaskUsage(parent.ledger, { sessionId: 'verification-fixture', policyRevision: 'a'.repeat(64), unit: 'tokens', workspaceKey });
    task.finish('finished');
    return task;
  }

  function selectCheck(command = '["npm", "test", "--", "PRIVATE-ARG"]', cwd = root) {
    mocks.api.window.showQuickPick.mockImplementation(async (items) => items.find((item: { action: string }) => item.action === 'test'));
    mocks.api.window.showInputBox.mockResolvedValueOnce(cwd).mockResolvedValueOnce(command);
    mocks.api.window.showWarningMessage.mockResolvedValue('Run check');
  }

  it.each(['approval', 'execution'] as const)('rejects verification if a task resumes during %s', async (stage) => {
    const settings = { sessionId: 'verification-fixture', policyRevision: 'a'.repeat(64), unit: 'tokens' as const, limit: 2000,
      workspaceKey: taskWorkspaceKey(parent.getWorkspaceRoots()), guardrails: true };
    const model = request().model;
    const identity = { vendor: model.vendor, id: model.id };
    const task = new OwnedTaskUsage(parent.ledger, settings);
    const callId = task.startCall(identity, parent.pricing.snapshot({ mode: 'automatic' }, 0, { ...identity, name: model.name }), { reserved: 700 });
    task.finishCall(callId, 'failed');
    task.finish('failed');
    const resume = () => OwnedTaskUsage.resume(parent.ledger, task.taskId, settings, identity).finish('failed');
    selectCheck();
    if (stage === 'approval') mocks.api.window.showWarningMessage.mockImplementation(async () => { resume(); return 'Run check'; });
    else mocks.runCommand.mockImplementation(async () => { resume(); return { exitCode: 0, durationMs: 1 }; });
    await createTaskVerifier(parent)(task.taskId);
    expect(buildTaskUsage(parent.ledger.all())[0]).toMatchObject({ resumes: 1, outcome: { status: 'unverified', evidence: null } });
    expect(mocks.api.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('no longer available'));
    if (stage === 'approval') expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it.each([0, 1])('records approved exit %s as evidence without trusting output text or storing command contents', async (exitCode) => {
    const task = completedTask();
    selectCheck();
    mocks.settings.commandTimeoutSeconds = 20;
    mocks.runCommand.mockResolvedValue({ exitCode, durationMs: 125, timedOut: false, stdout: 'PRIVATE-OUTPUT: passed', stderr: '' });
    const before = parent.summary();
    const history = fs.readFileSync(parent.ledger.path(), 'utf8');
    await createTaskVerifier(parent)(task.taskId);
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledWith('Run verification check?', expect.objectContaining({ modal: true, detail: expect.stringContaining('PRIVATE-ARG') }), 'Run check');
    expect(mocks.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'npm', args: ['test', '--', 'PRIVATE-ARG'], cwd: root, workspaceRoots: parent.getWorkspaceRoots(), timeoutMs: 20_000, signal: expect.any(AbortSignal),
    }));
    expect(buildTaskUsage(parent.ledger.all())[0]?.outcome).toMatchObject({
      status: exitCode === 0 ? 'verified-pass' : 'verified-fail',
      evidence: { detail: { source: 'command', check: 'test', exitCode, durationMs: 125, checkKey: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    });
    expect(parent.summary()).toEqual(before);
    const after = fs.readFileSync(parent.ledger.path(), 'utf8');
    expect(after.startsWith(history)).toBe(true);
    expect(after).not.toContain('PRIVATE-');
    expect(source.listeners.size).toBe(0);
  });

  it.each(['pass', 'fail'])('records an explicit user %s as user-reported, never verified', async (result) => {
    const task = completedTask();
    mocks.api.window.showQuickPick.mockImplementation(async (items) => items.find((item: { action: string }) => item.action === 'user-' + result));
    mocks.api.window.showWarningMessage.mockResolvedValue('Record report');
    await createTaskVerifier(parent)(task.taskId);
    expect(buildTaskUsage(parent.ledger.all())[0]?.outcome).toMatchObject({ status: 'user-reported', result, verificationAttempts: 0 });
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it.each([0, 3])('uses a real approved process exit %s, not its printed success claim', async (exitCode) => {
    const actual = await vi.importActual<typeof import('@slipstream/core')>('@slipstream/core');
    mocks.runCommand.mockImplementation(actual.runCommand);
    const task = completedTask();
    selectCheck(JSON.stringify(['node', '-e', `process.stdout.write('PRIVATE: success'); process.exit(${exitCode});`]));
    await createTaskVerifier(parent)(task.taskId);
    expect(buildTaskUsage(parent.ledger.all())[0]?.outcome).toMatchObject({
      status: exitCode === 0 ? 'verified-pass' : 'verified-fail', evidence: { detail: { exitCode, execution: 'completed' } },
    });
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).not.toContain('PRIVATE');
  });

  it('offers only completed tasks in the current workspace from the command palette', async () => {
    const task = completedTask();
    completedTask(taskWorkspaceKey([os.tmpdir()]));
    new OwnedTaskUsage(parent.ledger, { sessionId: 'running', policyRevision: 'a'.repeat(64), unit: 'tokens', workspaceKey: taskWorkspaceKey(parent.getWorkspaceRoots()) });
    mocks.api.window.showQuickPick.mockImplementationOnce(async (items) => {
      expect(items).toHaveLength(1);
      expect(items[0].taskId).toBe(task.taskId);
      return items[0];
    }).mockResolvedValueOnce({ action: 'user-pass' });
    mocks.api.window.showWarningMessage.mockResolvedValue('Record report');
    await createTaskVerifier(parent)();
    expect(buildTaskUsage(parent.ledger.all()).find((item) => item.taskId === task.taskId)?.outcome.status).toBe('user-reported');
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it('rechecks workspace trust after command approval', async () => {
    const task = completedTask();
    selectCheck();
    mocks.api.window.showWarningMessage.mockImplementation(async () => { mocks.api.workspace.isTrusted = false; return 'Run check'; });
    const before = fs.readFileSync(parent.ledger.path(), 'utf8');
    await createTaskVerifier(parent)(task.taskId);
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.api.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('trusted workspace'));
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).toBe(before);
  });

  it('does nothing when approval is declined', async () => {
    const task = completedTask();
    selectCheck();
    mocks.api.window.showWarningMessage.mockResolvedValue(undefined);
    const before = fs.readFileSync(parent.ledger.path(), 'utf8');
    await createTaskVerifier(parent)(task.taskId);
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).toBe(before);
  });

  it('does not let a second invocation release the first verification dialog lock', async () => {
    const task = completedTask();
    let closeDialog: (value: undefined) => void = () => {};
    mocks.api.window.showQuickPick.mockImplementationOnce(() => new Promise((resolve) => { closeDialog = resolve; }));
    const verify = createTaskVerifier(parent);
    const first = verify(task.taskId);
    await verify(task.taskId);
    await verify(task.taskId);
    expect(mocks.api.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(mocks.api.window.showErrorMessage).toHaveBeenCalledTimes(2);
    closeDialog(undefined);
    await first;
    await verify(task.taskId);
    expect(mocks.api.window.showQuickPick).toHaveBeenCalledTimes(2);
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it.each(['outside', 'disallowed', 'malformed', 'different-workspace', 'untrusted'])('preserves the %s execution boundary', async (boundary) => {
    const task = completedTask(boundary === 'different-workspace' ? taskWorkspaceKey([os.tmpdir()]) : undefined);
    selectCheck(boundary === 'disallowed' ? '["powershell", "-Command", "anything"]' : boundary === 'malformed' ? 'npm test' : '["npm", "test"]', boundary === 'outside' ? os.tmpdir() : root);
    if (boundary === 'untrusted') mocks.api.workspace.isTrusted = false;
    const before = fs.readFileSync(parent.ledger.path(), 'utf8');
    await createTaskVerifier(parent)(task.taskId);
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(mocks.api.window.showErrorMessage).toHaveBeenCalled();
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).toBe(before);
  });

  it.each(['cancelled', 'timed-out', 'error'])('never turns a %s check into a verified result', async (state) => {
    const task = completedTask();
    selectCheck();
    mocks.runCommand.mockImplementation(async (options) => {
      if (state === 'cancelled') { source.cancel(); expect(options.signal.aborted).toBe(true); }
      if (state === 'error') throw new Error('PRIVATE-FAILURE');
      return { exitCode: 0, durationMs: 10, timedOut: state === 'timed-out' };
    });
    await createTaskVerifier(parent)(task.taskId);
    expect(buildTaskUsage(parent.ledger.all())[0]?.outcome).toMatchObject({ status: state === 'cancelled' ? 'cancelled' : 'unverified', result: null });
    expect(fs.readFileSync(parent.ledger.path(), 'utf8')).not.toContain('PRIVATE-');
    expect(source.listeners.size).toBe(0);
  });
});