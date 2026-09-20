import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { buildSummaryPayload, CompressionEngine, OwnedTaskUsage, recordTaskOutcome, taskWorkspaceKey, type CostPolicy } from '@slipstream/core';

/**
 * The dashboard's script and markup live inside a template literal in
 * `@slipstream/core`, so neither the TypeScript compiler nor the bundler ever
 * checks them. These tests read the real source and assert the two things that
 * would otherwise fail silently at runtime: that the script parses, and that the
 * CSP posture is intact.
 */
const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'core', 'src', 'dashboardPage.ts'),
  'utf8',
);

function inlineScript(): string {
  const open = '<script nonce="${nonce}">';
  const start = source.indexOf(open);
  const end = source.indexOf('</script>', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  // Inside a template literal a backslash is escaped, so `\\n` in the source is
  // the two characters the browser sees. Undo that one level of escaping.
  // The script deliberately contains no ${} interpolation, so nothing else needs undoing.
  return source.slice(start + open.length, end).replace(/\\\\/g, '\\');
}

describe('dashboard webview', () => {
  it('routes exact inspect selectors and rejects invalid selectors without timestamp fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-inspect-webview-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    engine.ledger.record({
      ts: Date.now(), tool: 'run_command', label: 'Command', strategy: 'log:jest',
      tokensBefore: 10, tokensAfter: 5, bytesBefore: 100, bytesAfter: 50, linesBefore: 10, linesAfter: 5,
    });
    engine.ledger.record({ ...engine.recentEvents(1)[0]!, tool: 'retrieve_artifact', strategy: 'retrieve' });
    const events = buildSummaryPayload(engine).events;
    let receive!: (message: Record<string, unknown>) => void;
    let disposePanel: (() => void) | undefined;
    const postMessage = vi.fn().mockResolvedValue(true);
    const panel = { webview: { html: '', postMessage, onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; } },
      onDidDispose: (handler: () => void) => { disposePanel = handler; return { dispose() {} }; } };
    vi.resetModules();
    vi.doMock('vscode', () => ({ window: { createWebviewPanel: () => panel }, ViewColumn: { Beside: 2 }, ThemeIcon: class {} }));
    try {
      const { DashboardPanel } = await import('../src/dashboard.js');
      DashboardPanel.show({ subscriptions: [] } as unknown as import('vscode').ExtensionContext, engine);
      for (const event of events) {
        postMessage.mockClear();
        receive({ type: 'inspect', ts: event.ts, eventId: event.eventId });
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'detail', eventId: event.eventId, strategy: event.strategy }));
      }
      for (const eventId of ['unknown', '', 123, null, {}]) {
        postMessage.mockClear();
        receive({ type: 'inspect', ts: events[0]!.ts, eventId });
        expect(postMessage).not.toHaveBeenCalled();
      }
      receive({ type: 'inspect', ts: events[0]!.ts });
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'detail', eventId: events[0]!.eventId }));
    } finally {
      disposePanel?.();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
      vi.resetModules();
    }
  });

  it('routes read-only model-list messages without saving and rejects unavailable access', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-model-list-webview-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let receive!: (message: Record<string, unknown>) => void;
    let disposePanel: (() => void) | undefined;
    let trusted = true;
    const models = [{ vendor: 'copilot', id: 'test', name: 'Test model', authorized: true }];
    const listModels = vi.fn(async () => models);
    const save = vi.fn();
    const postMessage = vi.fn().mockResolvedValue(true);
    const panel = { webview: { html: '', postMessage, onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; } },
      onDidDispose: (handler: () => void) => { disposePanel = handler; return { dispose() {} }; } };
    vi.resetModules();
    vi.doMock('vscode', () => ({ window: { createWebviewPanel: () => panel }, ViewColumn: { Beside: 2 }, ThemeIcon: class {} }));
    try {
      const { DashboardPanel } = await import('../src/dashboard.js');
      DashboardPanel.show({ subscriptions: [] } as unknown as import('vscode').ExtensionContext, engine, undefined, { canEdit: () => trusted, save, listModels });
      receive({ type: 'ready' });
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ canListPolicyModels: true }));
      const history = engine.ledger.all();
      const config = engine.getConfig();
      receive({ type: 'policyModels', requestId: 'invalid' });
      expect(listModels).not.toHaveBeenCalled();
      receive({ type: 'policyModels', requestId: 1 });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'policyModelsResult', requestId: 1, models }));
      trusted = false;
      receive({ type: 'policyModels', requestId: 2 });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'policyModelsResult', requestId: 2, error: expect.any(String) })));
      expect(listModels).toHaveBeenCalledTimes(1);
      trusted = true;
      listModels.mockImplementationOnce(async () => { trusted = false; throw new Error('PRIVATE'); });
      receive({ type: 'policyModels', requestId: 3 });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'policyModelsResult', requestId: 3, error: expect.any(String) })));
      expect(save).not.toHaveBeenCalled();
      expect(engine.ledger.all()).toEqual(history);
      expect(engine.getConfig()).toEqual(config);
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain('PRIVATE');
    } finally {
      disposePanel?.();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
      vi.resetModules();
    }
  });

  it('discovers exact model choices without requests or policy changes and rejects workspace changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-model-picker-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const sendRequest = vi.fn();
    const countTokens = vi.fn();
    const baseline = { vendor: 'copilot', id: 'baseline', name: 'Baseline', sendRequest, countTokens };
    const alternate = { ...baseline, id: 'alternate', name: 'Alternate' };
    const workspace = { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] };
    const selectChatModels = vi.fn().mockResolvedValue([baseline, alternate, baseline, { ...baseline, vendor: 'other' }, { ...baseline, id: '' }]);
    const canSendRequest = vi.fn((model: { id: string; vendor: string }) => model.id === 'alternate' ? undefined : model.vendor === 'other' ? false : true);
    const refresh = vi.spyOn(engine.pricing, 'refresh');
    vi.resetModules();
    vi.doMock('vscode', () => ({ workspace, lm: { selectChatModels } }));
    try {
      const { listWorkspaceModels } = await import('../src/dashboard.js');
      const config = engine.getConfig();
      const history = engine.ledger.all();
      expect(await listWorkspaceModels(engine, canSendRequest)).toEqual([
        { vendor: 'copilot', id: 'alternate', name: 'Alternate', authorized: false },
        { vendor: 'copilot', id: 'baseline', name: 'Baseline', authorized: true },
        { vendor: 'other', id: 'baseline', name: 'Baseline', authorized: false },
      ]);
      expect(canSendRequest).toHaveBeenCalledTimes(3);
      workspace.isTrusted = false;
      await expect(listWorkspaceModels(engine, canSendRequest)).rejects.toThrow('trusted');
      workspace.isTrusted = true;
      selectChatModels.mockImplementationOnce(async () => { workspace.workspaceFolders = []; return [baseline]; });
      await expect(listWorkspaceModels(engine, canSendRequest)).rejects.toThrow('trusted');
      expect(selectChatModels).toHaveBeenCalledTimes(2);
      expect(sendRequest).not.toHaveBeenCalled();
      expect(countTokens).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(engine.getConfig()).toEqual(config);
      expect(engine.ledger.all()).toEqual(history);
    } finally {
      refresh.mockRestore();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
      vi.resetModules();
    }
  });

  it('routes read-only recommendation messages and rejects stale or malformed requests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-recommendation-webview-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let receive!: (message: Record<string, unknown>) => void;
    let disposePanel: (() => void) | undefined;
    let trusted = true;
    const save = vi.fn();
    const result = { state: 'unavailable' as const, reason: 'no-permitted-models' as const, candidates: [] };
    const recommend = vi.fn(async () => result);
    const postMessage = vi.fn().mockResolvedValue(true);
    const panel = { webview: { html: '', postMessage, onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; } },
      onDidDispose: (handler: () => void) => { disposePanel = handler; return { dispose() {} }; } };
    vi.resetModules();
    vi.doMock('vscode', () => ({ window: { createWebviewPanel: () => panel }, ViewColumn: { Beside: 2 }, ThemeIcon: class {} }));
    try {
      const { DashboardPanel } = await import('../src/dashboard.js');
      DashboardPanel.show({ subscriptions: [] } as unknown as import('vscode').ExtensionContext, engine, undefined, { canEdit: () => trusted, save, recommend });
      receive({ type: 'ready' });
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ canRecommendModels: true }));
      const history = engine.ledger.all();
      const config = engine.getConfig();
      const message = { type: 'modelRecommendation', requestId: 1, request: { category: 'code', inputTokens: 100 }, expectedRevision: engine.getCostPolicyAssessment().policyRevision };
      receive(message);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'modelRecommendationResult', requestId: 1, policyRevision: message.expectedRevision, result }));
      expect(recommend).toHaveBeenCalledExactlyOnceWith(message.request, message.expectedRevision);
      for (const change of [{ request: { prompt: 'PRIVATE' } }, { expectedRevision: 'f'.repeat(64) }]) {
        postMessage.mockClear();
        receive({ ...message, ...change });
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'modelRecommendationResult', error: expect.any(String) })));
      }
      trusted = false;
      postMessage.mockClear();
      receive(message);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'modelRecommendationResult', error: expect.any(String) })));
      expect(recommend).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      expect(engine.ledger.all()).toEqual(history);
      expect(engine.getConfig()).toEqual(config);
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain('PRIVATE');
    } finally {
      disposePanel?.();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
      vi.resetModules();
    }
  });

  it('compares only permitted authorized models using cached prices and verified evidence without sending requests', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-recommendation-host-'));
    const baseline = { vendor: 'vendor', id: 'baseline', name: 'Baseline', family: 'test', maxInputTokens: 8000, sendRequest: vi.fn() };
    const alternate = { ...baseline, id: 'alternate', name: 'Alternate' };
    const unauthorized = { ...baseline, id: 'unauthorized' };
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { costPolicy: {
      version: 1, mode: 'recommend-only', allowedModels: [baseline, alternate, unauthorized].map(({ vendor, id }) => ({ vendor, id })),
    } as CostPolicy } });
    const workspace = { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: root } }] };
    const selectChatModels = vi.fn().mockResolvedValue([baseline, alternate, unauthorized, { ...baseline, id: 'not-permitted' }]);
    const snapshot = vi.spyOn(engine.pricing, 'snapshot').mockImplementation((_config, _tokens, model) => ({
      basis: 'public-api-reference', mode: 'automatic', inputUsdPerMillion: model?.id === 'alternate' ? 1 : 10, outputUsdPerMillion: 1,
      source: 'https://models.dev/api.json', fetchedAt: 100, revision: 'fixture', stale: false, status: 'priced', assumption: 'standard-uncached-input', toolCalling: true,
    }));
    const refresh = vi.spyOn(engine.pricing, 'refresh');
    vi.resetModules();
    vi.doMock('vscode', () => ({ workspace, lm: { selectChatModels } }));
    try {
      const { recommendWorkspaceModels } = await import('../src/dashboard.js');
      const revision = engine.getCostPolicyAssessment().policyRevision;
      const request = { category: 'code', requestedModel: { vendor: baseline.vendor, id: baseline.id }, inputTokens: 100, outputTokens: 512 };
      const authorized = (model: { id: string }) => model.id === 'unauthorized' ? undefined : true;
      const config = engine.getConfig();
      const history = engine.ledger.all();
      const result = await recommendWorkspaceModels(engine, request, revision, authorized);
      expect(result).toMatchObject({ state: 'retain', reason: 'insufficient-evidence', selectedModel: request.requestedModel });
      expect(result.candidates.map((candidate) => candidate.available)).toEqual([true, true, false]);
      expect(result.candidates[1].verifiedPasses).toBe(0);
      expect(result.timings?.evaluationMs).toBeGreaterThanOrEqual(0);
      expect((await recommendWorkspaceModels(engine, { ...request, pinned: true }, revision, authorized)).reason).toBe('pinned');
      expect((await recommendWorkspaceModels(engine, { ...request, inputTokens: undefined }, revision, authorized)).reason).toBe('unknown-input');
      await expect(recommendWorkspaceModels(engine, request, 'stale', authorized)).rejects.toThrow('changed');
      workspace.isTrusted = false;
      await expect(recommendWorkspaceModels(engine, request, revision, authorized)).rejects.toThrow('trusted');
      workspace.isTrusted = true;
      selectChatModels.mockImplementationOnce(async () => { workspace.workspaceFolders = []; return [baseline]; });
      await expect(recommendWorkspaceModels(engine, request, revision, authorized)).rejects.toThrow('trusted');
      workspace.workspaceFolders = [{ uri: { scheme: 'file', fsPath: root } }];
      expect(baseline.sendRequest).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(engine.getConfig()).toEqual(config);
      expect(engine.ledger.all()).toEqual(history);
      const verify = (model: typeof baseline, exitCode: number) => {
        const task = new OwnedTaskUsage(engine.ledger, { sessionId: 'fixture', policyRevision: revision, unit: 'tokens', limit: 4000,
          workspaceKey: taskWorkspaceKey([root]), category: 'code' });
        const call = task.startCall({ vendor: model.vendor, id: model.id }, engine.pricing.snapshot({ mode: 'automatic' }, 0, model));
        task.finishCall(call, 'finished');
        task.finish('finished');
        recordTaskOutcome(engine.ledger, task.taskId, { source: 'command', check: 'test', execution: 'completed', exitCode, durationMs: 1, checkKey: 'b'.repeat(64) });
      };
      for (const model of [baseline, alternate]) for (let sample = 0; sample < 3; sample++) verify(model, 0);
      const verifiedHistory = engine.ledger.all();
      expect(await recommendWorkspaceModels(engine, request, revision, authorized)).toMatchObject({ state: 'recommend', selectedModel: { vendor: alternate.vendor, id: alternate.id } });
      expect((await recommendWorkspaceModels(engine, { ...request, category: 'triage' }, revision, authorized)).reason).toBe('insufficient-evidence');
      expect(engine.ledger.all()).toEqual(verifiedHistory);
      verify(alternate, 1);
      const rejected = await recommendWorkspaceModels(engine, request, revision, authorized);
      expect(rejected.selectedModel).toEqual(request.requestedModel);
      expect(rejected.candidates[1].gaps).toContain('verified-failure');
      expect(baseline.sendRequest).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      engine.updateConfig({ costPolicy: { ...config.costPolicy, allowedModels: [] } });
      selectChatModels.mockClear();
      expect((await recommendWorkspaceModels(engine, request, engine.getCostPolicyAssessment().policyRevision, authorized)).reason).toBe('no-permitted-models');
      expect(selectChatModels).not.toHaveBeenCalled();
    } finally {
      snapshot.mockRestore();
      refresh.mockRestore();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
      vi.resetModules();
    }
  });

  it.each(['recommend-only', 'automatic-owned-request'] as const)('routes %s policy edits through the host and acknowledges saved or rejected changes', async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-policy-webview-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let receive!: (message: { type: string; policy?: unknown; expectedRevision?: unknown }) => void;
    let disposePanel: (() => void) | undefined;
    let editable = true;
    const save = vi.fn(async (policy: CostPolicy) => { engine.updateConfig({ costPolicy: policy }); });
    const postMessage = vi.fn().mockResolvedValue(true);
    const panel = {
      webview: { html: '', postMessage, onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; } },
      onDidDispose: (handler: () => void) => { disposePanel = handler; return { dispose() {} }; },
    };
    vi.resetModules();
    vi.doMock('vscode', () => ({ window: { createWebviewPanel: () => panel }, ViewColumn: { Beside: 2 }, ThemeIcon: class {} }));
    try {
      const { DashboardPanel } = await import('../src/dashboard.js');
      DashboardPanel.show({ subscriptions: [] } as unknown as import('vscode').ExtensionContext, engine, undefined, { canEdit: () => editable, save });
      receive({ type: 'ready' });
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ costPolicySettings: { editable: true, value: engine.getConfig().costPolicy } }));
      const before = engine.summary();
      const message = { type: 'costPolicy', policy: { version: 1, mode, taskBudget: 10, modelSelection: 'policy', outputTokenAllowance: 256 }, expectedRevision: engine.getCostPolicyAssessment().policyRevision };
      receive(message);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'costPolicyResult' }));
      expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(message.policy), message.expectedRevision);
      expect(engine.getConfig().costPolicy.mode).toBe(mode);
      const failure = { type: 'costPolicyResult', error: 'Policy could not be applied. Check workspace settings and reload the saved policy.' };
      postMessage.mockClear();
      receive(message);
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(failure));
      expect(save).toHaveBeenCalledTimes(1);
      for (const policy of [undefined, { version: 1, mode, outputTokenAllowance: 0 }, { version: 1, mode: 'recommend-only', taskBudget: -1 }]) {
        postMessage.mockClear();
        receive({ ...message, policy, expectedRevision: engine.getCostPolicyAssessment().policyRevision });
        await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(failure));
      }
      editable = false;
      postMessage.mockClear();
      receive({ ...message, expectedRevision: engine.getCostPolicyAssessment().policyRevision });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(failure));
      expect(save).toHaveBeenCalledTimes(1);
      expect(engine.summary()).toEqual(before);
    } finally {
      disposePanel?.();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
      vi.resetModules();
    }
  });

  it.each(['recommend-only', 'automatic-owned-request'] as const)('validates and persists %s policy to the workspace before updating the engine', async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-policy-save-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let saved: unknown = { version: 1, mode: 'off' };
    const update = vi.fn(async (_key: string, value: unknown) => { saved = value; });
    const workspace = { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }], getConfiguration: vi.fn(() => {
      const snapshot = saved;
      return { get: () => snapshot, update };
    }) };
    vi.resetModules();
    vi.doMock('vscode', () => ({ workspace, ConfigurationTarget: { Workspace: 2 } }));
    try {
      const { saveWorkspaceCostPolicy } = await import('../src/dashboard.js');
      const revision = engine.getCostPolicyAssessment().policyRevision;
      const policy = { version: 1, mode, taskBudget: 0, budgetUnit: 'tokens', modelSelection: 'policy', outputTokenAllowance: 256 };
      const before = engine.getConfig();
      const history = engine.ledger.all();
      await expect(saveWorkspaceCostPolicy(engine, undefined, revision)).rejects.toThrow('policy object');
      await expect(saveWorkspaceCostPolicy(engine, { ...policy, taskBudget: -1 }, revision)).rejects.toThrow();
      await expect(saveWorkspaceCostPolicy(engine, { ...policy, outputTokenAllowance: 0 }, revision)).rejects.toThrow('Invalid output');
      await expect(saveWorkspaceCostPolicy(engine, policy, 'stale')).rejects.toThrow('changed');
      workspace.isTrusted = false;
      await expect(saveWorkspaceCostPolicy(engine, policy, revision)).rejects.toThrow('trusted workspace');
      workspace.isTrusted = true;
      workspace.workspaceFolders = [];
      await expect(saveWorkspaceCostPolicy(engine, policy, revision)).rejects.toThrow('trusted workspace');
      workspace.workspaceFolders = [{ uri: { fsPath: root } }];
      expect(update).not.toHaveBeenCalled();
      update.mockRejectedValueOnce(new Error('Settings are read-only'));
      await expect(saveWorkspaceCostPolicy(engine, policy, revision)).rejects.toThrow('read-only');
      expect(engine.getConfig()).toEqual(before);
      expect(engine.ledger.all()).toEqual(history);
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      update.mockImplementationOnce(async (_key, value) => { expect(engine.getConfig()).toEqual(before); await pending; saved = value; });
      const applying = saveWorkspaceCostPolicy(engine, policy, revision);
      await expect(saveWorkspaceCostPolicy(engine, policy, revision)).rejects.toThrow('already in progress');
      finish();
      await applying;
      expect(update).toHaveBeenLastCalledWith('costPolicy', expect.objectContaining(policy), 2);
      expect(workspace.getConfiguration).toHaveBeenCalledWith('slipstream');
      expect(engine.getCostPolicyAssessment()).toMatchObject({ effectiveMode: 'recommend-only', taskBudget: 0 });
      expect(engine.ledger.all().filter((entry) => entry.costPolicyAssessment)).toHaveLength(1);
      expect(engine.summary().tokensSaved).toBe(0);
      await saveWorkspaceCostPolicy(engine, { version: 1, mode: 'off' }, engine.getCostPolicyAssessment().policyRevision);
      expect(engine.getCostPolicyAssessment().effectiveMode).toBe('off');
      expect(engine.ledger.all().filter((entry) => entry.costPolicyAssessment)).toHaveLength(2);
      update.mockResolvedValueOnce(undefined);
      await expect(saveWorkspaceCostPolicy(engine, policy, engine.getCostPolicyAssessment().policyRevision)).rejects.toThrow('another configuration is effective');
      expect(engine.getCostPolicyAssessment().effectiveMode).toBe('off');
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
      vi.resetModules();
    }
  });

  it('routes catalog refresh to the fixed service and acknowledges success and failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-webview-catalog-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let receive!: (message: { type: string; source?: string }) => void;
    let disposePanel: (() => void) | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const refresh = vi.spyOn(engine.pricing, 'refresh').mockReturnValueOnce(pending);
    const postMessage = vi.fn().mockResolvedValue(true);
    const panel = {
      webview: {
        html: '', postMessage,
        onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; },
      },
      onDidDispose: (handler: () => void) => { disposePanel = handler; return { dispose() {} }; },
    };
    vi.doMock('vscode', () => ({ window: { createWebviewPanel: () => panel }, ViewColumn: { Beside: 2 }, ThemeIcon: class {} }));
    try {
      const { DashboardPanel } = await import('../src/dashboard.js');
      DashboardPanel.show({ subscriptions: [] } as unknown as import('vscode').ExtensionContext, engine);
      const before = engine.summary();
      receive({ type: 'refreshCatalog', source: 'https://untrusted.example' });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
      expect(postMessage).not.toHaveBeenCalled();
      finish();
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: 'catalogRefreshResult' }));
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'summary' }));
      refresh.mockRejectedValueOnce(new Error('PRIVATE'));
      receive({ type: 'refreshCatalog' });
      await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({
        type: 'catalogRefreshResult', error: 'Catalog refresh could not be completed.',
      }));
      expect(JSON.stringify(postMessage.mock.calls)).not.toContain('PRIVATE');
      expect(engine.summary()).toEqual(before);
    } finally {
      disposePanel?.();
      refresh.mockRestore();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
      vi.doUnmock('vscode');
    }
  });

  it('keeps model rates automatic while exposing a fallback rate setting', () => {
    for (const removed of ['pricingControls', 'pricingSettings', 'pricingProvider', 'pricingOverride', 'Manual token price', 'requestPricing', 'receivePricing']) {
      expect(source).not.toContain(removed);
    }
    expect(source).toContain('id="lastDetectedModel"');
    expect(source).toContain('id="detectedInputRate"');
    expect(source).toContain('Last detected model');
    expect(source).toContain("configNumber('usdPerMillionTokens', 'Fallback input rate'");
  });

  it('shows model tracking and pricing on the main dashboard instead of inside settings', () => {
    const drawer = source.slice(source.indexOf('<dialog'), source.indexOf('</dialog>'));
    for (const id of [
      'modelTrackingStatus', 'modelTrackingDetail', 'connectModelTracking', 'disconnectModelTracking',
      'lastDetectedModel', 'detectedInputRate', 'detectedModelSource',
      'modelInputTokens', 'modelOutputTokens', 'modelCachedInputTokens', 'pricingStatus',
    ]) {
      expect(source).toContain('id="' + id + '"');
      expect(drawer).not.toContain('id="' + id + '"');
    }
    expect(source).toContain('id="modelPricingWarning"');
  });

  it('embeds a script that parses as JavaScript', () => {
    const script = inlineScript();
    expect(script.length).toBeGreaterThan(500);
    expect(() => new Function(script)).not.toThrow();
  });

  it('does not interpolate anything into the script body', () => {
    // A `${...}` here would splice ledger-derived text straight into executable
    // code, which is the one mistake this whole design exists to prevent.
    expect(inlineScript()).not.toMatch(/\$\{/);
  });

  it('locks the content security policy down', () => {
    expect(source).toContain("\"default-src 'none'\"");
    expect(source).toContain('style-src ');
    expect(source).toContain('script-src ');
    expect(source).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('grants the webview no local resource access and a fresh nonce', () => {
    const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    expect(panel).toContain('localResourceRoots: []');
    // A nonce must be generated per load rather than hard-coded.
    expect(panel).toContain('crypto.randomBytes(16)');
  });

  it('never writes untrusted text as HTML', () => {
    const script = inlineScript();
    // Match property access, so a comment mentioning innerHTML does not trip this.
    expect(script).not.toMatch(/\.(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write/);
    expect(script).not.toMatch(/\beval\s*\(/);
    expect(script).toContain('textContent');  });

  it('uses no inline style attributes', () => {
    // `style-src 'nonce-...'` blocks style="" attributes outright, so any that
    // creep back in are silently dropped by the browser.
    const markup = source.slice(source.indexOf('<body>'), source.indexOf('<script nonce'));
    expect(markup).not.toMatch(/\sstyle\s*=\s*"/);
  });

  it('renders omitted ranges and markers from the detail payload', () => {
    const script = inlineScript();
    for (const symbol of [
      'renderBefore',
      'renderAfter',
      'renderDetail',
      'renderDiff',
      'renderRetrievalAudit',
      'renderSummary',
      'renderStrategyBreakdown',
      'modelPayloadUrl',
      'reportUrl',
    ]) {
      expect(script).toContain(symbol);
    }
    expect(source).toContain('id="copyModelPayload"');
    expect(source).toContain('id="modelPayloadLink"');
    expect(source).toContain('id="shareSnapshotLink"');
    expect(source).toContain('id="shareJsonLink"');
    expect(source).toContain('id="shareCsvLink"');
    expect(source).toContain('id="configStatus"');
    expect(script).toContain("select.id = 'config-profile'");
    expect(script).toContain("updateConfig({ profile: select.value })");
    expect(source).not.toContain('id="judgeFlow"');
    expect(source).not.toContain('id="safetyClaims"');
    expect(source).toContain('id="retrievalAuditCallout"');
    expect(source).toContain('id="retrievalAudit"');
    expect(source).toContain('id="diffMode"');
    expect(source).toContain('id="diffView"');
    expect(script).toContain('navigator.clipboard.writeText');
    expect(script).toContain("type: 'inspect'");
  });
});
