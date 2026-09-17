import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CompressionEngine } from '@slipstream/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  const values: Record<string, unknown> = {};
  const commands = new Map<string, () => unknown>();
  const disposable = () => ({ dispose: vi.fn() });
  const configuration = {
    get: vi.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    inspect: vi.fn(),
    update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
  };
  const log = { appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() };
  return {
    values, commands, configuration, log,
    registerTools: vi.fn<(context: unknown, engine: CompressionEngine) => void>(),
    registerChatParticipant: vi.fn(),
    registerModelTracking: vi.fn(() => ({ dispose: vi.fn() })),
    createStatusBar: vi.fn(),
    dashboardShow: vi.fn(),
    dashboardRefresh: vi.fn(),
    synchronizeChatHooks: vi.fn(),
    configureNativeChatPolicy: vi.fn(),
    maybeCheckForUpdate: vi.fn(async () => undefined),
    startDashboardServer: vi.fn(),
    runCommand: vi.fn(),
    api: {
      workspace: {
        isTrusted: true,
        workspaceFolders: [] as vscode.WorkspaceFolder[],
        name: 'activation-test',
        getConfiguration: vi.fn(() => configuration),
        onDidGrantWorkspaceTrust: vi.fn(disposable),
        onDidChangeConfiguration: vi.fn(disposable),
        onDidChangeWorkspaceFolders: vi.fn(disposable),
      },
      window: {
        activeTextEditor: undefined,
        createOutputChannel: vi.fn(() => log),
        onDidChangeActiveTextEditor: vi.fn(disposable),
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
      },
      commands: {
        registerCommand: vi.fn((name: string, command: () => unknown) => {
          commands.set(name, command);
          return { dispose: () => commands.delete(name) };
        }),
        executeCommand: vi.fn(),
      },
      env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
      lm: {},
      ConfigurationTarget: { Global: 1, WorkspaceFolder: 3 },
    },
  };
});

vi.mock('vscode', () => mocks.api);
vi.mock('@slipstream/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@slipstream/core')>(),
  maybeCheckForUpdate: mocks.maybeCheckForUpdate,
  startDashboardServer: mocks.startDashboardServer,
  runCommand: mocks.runCommand,
}));
vi.mock('../src/tools.js', () => ({ registerTools: mocks.registerTools }));
vi.mock('../src/chatParticipant.js', () => ({ registerChatParticipant: mocks.registerChatParticipant }));
vi.mock('../src/modelTracking.js', () => ({ registerModelTracking: mocks.registerModelTracking }));
vi.mock('../src/statusBar.js', () => ({ createStatusBar: mocks.createStatusBar }));
vi.mock('../src/chatHooks.js', () => ({
  synchronizeChatHooks: mocks.synchronizeChatHooks,
  chatHookPath: vi.fn(),
}));
vi.mock('../src/nativeChat.js', () => ({
  configureNativeChatPolicy: mocks.configureNativeChatPolicy,
  readNativeChatPolicy: vi.fn(),
}));
vi.mock('../src/dashboard.js', () => ({
  DashboardPanel: { show: mocks.dashboardShow, refresh: mocks.dashboardRefresh },
  listWorkspaceModels: vi.fn(),
  recommendWorkspaceModels: vi.fn(),
  saveWorkspaceCostPolicy: vi.fn(),
}));

import { activate, dashboardUrl } from '../src/extension.js';

let root: string;
let context: vscode.ExtensionContext;
let engine: CompressionEngine;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.commands.clear();
  for (const key of Object.keys(mocks.values)) delete mocks.values[key];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-activation-'));
  Object.assign(mocks.values, { storageDir: root, dashboardServer: false, provideMcpServer: false });
  mocks.api.workspace.isTrusted = true;
  mocks.api.workspace.workspaceFolders = [];
  mocks.api.window.showWarningMessage.mockReset().mockResolvedValue(undefined);
  context = {
    subscriptions: [],
    extension: { packageJSON: { version: '0.1.0' } },
    asAbsolutePath: (relative: string) => path.join(root, relative),
    languageModelAccessInformation: { canSendRequest: vi.fn(() => true) },
  } as unknown as vscode.ExtensionContext;
  activate(context);
  engine = mocks.registerTools.mock.calls[0]![1];
  await Promise.resolve();
});

afterEach(async () => {
  for (const subscription of context.subscriptions.splice(0).reverse()) await subscription.dispose();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function invoke(name: string): Promise<unknown> {
  const command = mocks.commands.get(name);
  expect(command, name).toBeDefined();
  return await command!();
}

describe('extension activation commands', () => {
  it('registers integrations without the optional MCP API and disposes the engine', async () => {
    expect(mocks.registerTools).toHaveBeenCalledWith(context, engine);
    expect(mocks.registerChatParticipant).toHaveBeenCalledWith(context, engine);
    expect(mocks.createStatusBar).toHaveBeenCalledWith(context, engine);
    expect(mocks.registerModelTracking).toHaveBeenCalledWith(context, engine, expect.any(Function));
    expect(mocks.startDashboardServer).not.toHaveBeenCalled();
    expect(mocks.runCommand).not.toHaveBeenCalled();
    const dispose = vi.spyOn(engine, 'dispose');
    for (const subscription of context.subscriptions.splice(0).reverse()) await subscription.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.commands.size).toBe(0);
  });

  it.each(['configureNativeChatPolicy', 'enableChatHooks', 'disableChatHooks'])(
    'refuses %s in an untrusted workspace',
    async (name) => {
      mocks.api.workspace.isTrusted = false;
      await invoke(`slipstream.${name}`);
      expect(mocks.api.window.showWarningMessage).toHaveBeenCalledWith(
        'Trust this workspace before managing executable chat hooks.',
      );
      expect(mocks.configuration.update).not.toHaveBeenCalled();
      expect(mocks.synchronizeChatHooks).not.toHaveBeenCalled();
      expect(mocks.configureNativeChatPolicy).not.toHaveBeenCalled();
    },
  );

  it('purges only after explicit confirmation', async () => {
    const purge = vi.spyOn(engine, 'purge');
    await invoke('slipstream.purgeArtifacts');
    expect(purge).not.toHaveBeenCalled();
    expect(mocks.dashboardRefresh).not.toHaveBeenCalled();

    mocks.api.window.showWarningMessage.mockResolvedValueOnce('Delete');
    await invoke('slipstream.purgeArtifacts');
    expect(purge).toHaveBeenCalledOnce();
    expect(mocks.dashboardRefresh).toHaveBeenCalledOnce();
  });

  it('toggles the global setting in both directions', async () => {
    await invoke('slipstream.toggle');
    expect(mocks.configuration.update).toHaveBeenLastCalledWith('enabled', false, 1);
    await invoke('slipstream.toggle');
    expect(mocks.configuration.update).toHaveBeenLastCalledWith('enabled', true, 1);
  });

  it('resets session state without purging artifacts or changing configuration', async () => {
    const reset = vi.spyOn(engine, 'resetSession');
    const purge = vi.spyOn(engine, 'purge');
    await invoke('slipstream.resetSession');
    expect(reset).toHaveBeenCalledOnce();
    expect(purge).not.toHaveBeenCalled();
    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(mocks.dashboardRefresh).toHaveBeenCalledOnce();
  });

  it('offers settings without opening or copying a URL when the dashboard server is disabled', async () => {
    expect(dashboardUrl()).toBeUndefined();
    mocks.api.window.showWarningMessage.mockResolvedValueOnce('Open Settings');
    await invoke('slipstream.openDashboardInBrowser');
    expect(mocks.api.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.openSettings', 'slipstream.dashboardServer',
    );
    await invoke('slipstream.copyDashboardUrl');
    expect(mocks.api.env.openExternal).not.toHaveBeenCalled();
    expect(mocks.api.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('opens the embedded dashboard with the active engine and policy controls', async () => {
    await invoke('slipstream.showDashboard');
    expect(mocks.dashboardShow).toHaveBeenCalledWith(
      context, engine, mocks.registerModelTracking.mock.results[0]!.value,
      expect.objectContaining({ canEdit: expect.any(Function), save: expect.any(Function) }),
    );
  });
});