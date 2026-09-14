import * as path from 'node:path';

import {
  CompressionEngine,
  formatUpdateNotice,
  maybeCheckForUpdate,
  renderCommandLine,
  resolveProjectLabel,
  runCommand,
  runHealthReport,
  startDashboardServer,
  type DashboardCostPolicyControls,
  type DashboardServerHandle,
} from '@slipstream/core';
import * as vscode from 'vscode';

import { readSettings, workspaceRoots } from './config.js';
import { chatHookPath, synchronizeChatHooks } from './chatHooks.js';
import { registerChatParticipant } from './chatParticipant.js';
import { DashboardPanel, listWorkspaceModels, recommendWorkspaceModels, saveWorkspaceCostPolicy } from './dashboard.js';
import { registerModelTracking } from './modelTracking.js';
import { configureNativeChatPolicy, readNativeChatPolicy } from './nativeChat.js';
import { createStatusBar } from './statusBar.js';
import { registerTools } from './tools.js';

const MCP_PROVIDER_ID = 'slipstream';

/** Resolved once the local dashboard server is listening; undefined if disabled. */
let dashboardServer: DashboardServerHandle | undefined;

export function dashboardUrl(): string | undefined {
  return dashboardServer?.url;
}

export function activate(context: vscode.ExtensionContext): void {
  const settings = readSettings();
  const log = vscode.window.createOutputChannel('Slipstream');
  context.subscriptions.push(log);

  const engine = new CompressionEngine({
    rootDir: settings.storageDir,
    workspaceRoots: workspaceRoots(),
    sessionLabel: extensionSessionLabel(),
    policyContext: { host: 'native-copilot', scope: 'workspace' },
    config: {
      profile: settings.profile,
      enabled: settings.enabled,
      compressLogs: settings.compressLogs,
      crossTurnDedup: settings.crossTurnDedup,
      readLifecycle: settings.readLifecycle,
      maxFileLines: settings.maxFileLines,
      usdPerMillionTokens: settings.usdPerMillionTokens,
      pricing: settings.pricing,
      costPolicy: settings.costPolicy,
      artifactIdleTtlMinutes: settings.artifactIdleTtlMinutes,
      artifactMaxEntries: settings.artifactMaxEntries,
      artifactMaxTotalMiB: settings.artifactMaxTotalMiB,
    },
  });

  registerTools(context, engine);
  registerChatParticipant(context, engine);
  context.subscriptions.push({ dispose: () => engine.dispose() });
  const modelTracking = registerModelTracking(context, engine, () => {
    DashboardPanel.refresh();
    dashboardServer?.notify();
  });
  const costPolicy: DashboardCostPolicyControls = {
    canEdit: () => vscode.workspace.isTrusted && !!vscode.workspace.workspaceFolders?.length,
    save: (policy, expectedRevision) => saveWorkspaceCostPolicy(engine, policy, expectedRevision),
    recommend: (request, expectedRevision) => recommendWorkspaceModels(engine, request, expectedRevision, (model) => context.languageModelAccessInformation.canSendRequest(model)),
    listModels: () => listWorkspaceModels(engine, (model) => context.languageModelAccessInformation.canSendRequest(model)),
  };
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
    DashboardPanel.refresh();
    dashboardServer?.notify();
  }));

  void maybeCheckForUpdate({
    currentVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
    stateDir: settings.storageDir,
  }).then((notice) => {
    if (notice) {
      log.appendLine(formatUpdateNotice(notice));
    }
  });
  createStatusBar(context, engine);
  registerMcpProvider(context, engine);
  const hookRuntime = context.asAbsolutePath(path.join('dist', 'chat-hook.js'));
  const synchronizeFolderHooks = async (folder: vscode.WorkspaceFolder): Promise<boolean> => {
    const readState = () => {
      const chat = vscode.workspace.getConfiguration('chat', folder.uri);
      const locations = chat.get<Record<string, boolean>>('hookFilesLocations');
      return {
        trusted: vscode.workspace.isTrusted,
        enabled: vscode.workspace.getConfiguration('slipstream', folder.uri).get<boolean>('chatHooks', true),
        available: !!locations && locations['.github/hooks'] !== false && chat.get<boolean>('useHooks') !== false,
      };
    };
    const initial = readState();
    if (!initial.trusted || folder.uri.scheme !== 'file') return false;
    if (initial.enabled && initial.available) {
      const node = await runCommand({ command: 'node', args: ['--version'], cwd: folder.uri.fsPath, workspaceRoots: [folder.uri.fsPath], allowedCommands: ['node'], timeoutMs: 5000 });
      if (node.exitCode !== 0 || Number(node.stdout.trim().match(/^v(\d+)/)?.[1] ?? 0) < 20) throw new Error('Node.js 20 or later must be available on the extension host PATH.');
    }
    if (!vscode.workspace.workspaceFolders?.some((current) => current.uri.toString() === folder.uri.toString())) return false;
    const state = readState();
    if (synchronizeChatHooks(folder.uri.fsPath, hookRuntime, engine.getStorageDir(), { ...state,
      native: state.enabled && state.available ? { policy: readNativeChatPolicy(folder.uri.fsPath), profile: engine.getConfig().profile } : undefined })) {
      log.appendLine(`Chat activity hooks ${state.enabled ? 'enabled' : 'disabled'}: ${chatHookPath(folder.uri.fsPath)}`);
    }
    if (state.enabled && !state.available) log.appendLine(`Chat hooks unavailable for ${folder.name}: VS Code agent hooks or .github/hooks discovery are disabled or unsupported.`);
    return state.trusted && state.enabled && state.available;
  };
  const refreshChatHooks = (): void => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      void synchronizeFolderHooks(folder).catch((error) => log.appendLine(`Chat hooks: ${String(error)}`));
    }
  };
  refreshChatHooks();
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(refreshChatHooks),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('slipstream.chatHooks') || event.affectsConfiguration('slipstream.nativeChatPolicy') || event.affectsConfiguration('slipstream.profile')
        || event.affectsConfiguration('chat.hookFilesLocations') || event.affectsConfiguration('chat.useHooks')) refreshChatHooks();
    }),
  );

  // The active project can change without reactivating the extension (the user
  // switches to a file in a sibling project). Keep the producer label current so
  // the dashboard attributes new events to the project actually in focus.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      engine.setSessionLabel(extensionSessionLabel());
    }),
  );

  if (settings.dashboardServer) {
    void startDashboardServer(engine, { port: settings.dashboardPort, modelTracking, costPolicy })
      .then((handle) => {
        dashboardServer = handle;
        context.subscriptions.push({ dispose: () => void handle.close() });
        log.appendLine(`Dashboard: ${handle.url}`);
        if (!handle.usedPreferredPort) {
          // The bookmarked URL will refuse until this is resolved, so say so
          // rather than leaving a dead link.
          log.appendLine(
            `Port ${settings.dashboardPort} was still in use, so the dashboard moved to ${handle.port}.`,
          );
          void vscode.window
            .showWarningMessage(
              `Slipstream dashboard could not use port ${settings.dashboardPort} and started on ${handle.port} instead.`,
              'Open Dashboard',
            )
            .then((choice) => {
              if (choice === 'Open Dashboard') {
                void vscode.env.openExternal(vscode.Uri.parse(handle.url));
              }
            });
        }
      })
      .catch((error: unknown) => {
        log.appendLine(
          `Dashboard server failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('slipstream.configureNativeChatPolicy', async () => {
      const folder = await selectHookWorkspace();
      if (!folder) return;
      try {
        if (!await configureNativeChatPolicy(folder.uri.fsPath)) return;
        const active = readNativeChatPolicy(folder.uri.fsPath).mode !== 'off';
        if (!await synchronizeFolderHooks(folder) && active) {
          void vscode.window.showWarningMessage('Native policy saved, but chat hooks are unavailable or disabled. Enable Slipstream chat hooks and review Chat: Configure Hooks before using Guard mode.');
          return;
        }
        void vscode.window.showInformationMessage('Native chat policy saved. Keep using normal Copilot chat; model selection is unchanged.');
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not configure native chat policy: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }),

    vscode.commands.registerCommand('slipstream.enableChatHooks', async () => {
      const folder = await selectHookWorkspace();
      if (!folder) return;
      try {
        await vscode.workspace.getConfiguration('slipstream', folder.uri).update('chatHooks', true, vscode.ConfigurationTarget.WorkspaceFolder);
        if (!await synchronizeFolderHooks(folder)) {
          void vscode.window.showWarningMessage('VS Code agent hooks or .github/hooks discovery are unavailable or disabled. Review Chat: Configure Hooks and your organization policy.');
          return;
        }
        void vscode.window.showInformationMessage(`Slipstream chat activity hooks enabled for ${folder.name}. Compression remains tool-based.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not enable Slipstream chat hooks: ${String(error)}`);
      }
    }),

    vscode.commands.registerCommand('slipstream.disableChatHooks', async () => {
      const folder = await selectHookWorkspace();
      if (!folder) return;
      try {
        await vscode.workspace.getConfiguration('slipstream', folder.uri).update('chatHooks', false, vscode.ConfigurationTarget.WorkspaceFolder);
        await synchronizeFolderHooks(folder);
        void vscode.window.showInformationMessage(`Slipstream chat activity hooks disabled for ${folder.name}.`);
      } catch (error) {
        void vscode.window.showErrorMessage(`Could not disable Slipstream chat hooks: ${String(error)}`);
      }
    }),

    vscode.commands.registerCommand('slipstream.showDashboard', () =>
      DashboardPanel.show(context, engine, modelTracking, costPolicy),
    ),

    vscode.commands.registerCommand('slipstream.healthCheck', () => {
      const report = runHealthReport({ storageDir: engine.getStorageDir() });
      const icon: Record<string, string> = { pass: '✔', warn: '!', fail: '✗' };
      log.appendLine('');
      log.appendLine('slipstream health check');
      for (const check of report.checks) {
        log.appendLine(`  ${icon[check.status] ?? '?'} ${check.name}: ${check.detail}`);
      }
      log.show(true);
      if (report.ok) {
        const warned = report.checks.some((c) => c.status === 'warn');
        vscode.window.showInformationMessage(
          warned
            ? 'Slipstream health check passed (with warnings). See the Slipstream output for details.'
            : 'Slipstream health check passed — all critical checks green.',
        );
      } else {
        vscode.window.showWarningMessage(
          'Slipstream health check FAILED — routing may be broken. See the Slipstream output for details.',
        );
      }
    }),

    vscode.commands.registerCommand('slipstream.openDashboardInBrowser', async () => {
      if (!dashboardServer) {
        const choice = await vscode.window.showWarningMessage(
          'The local dashboard server is not running. Enable it in settings?',
          'Open Settings',
        );
        if (choice === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'slipstream.dashboardServer',
          );
        }
        return;
      }
      // The URL carries the access token, so treat it as a secret: copy it
      // rather than printing it anywhere it might be shared.
      await vscode.env.openExternal(vscode.Uri.parse(dashboardServer.url));
    }),

    vscode.commands.registerCommand('slipstream.copyDashboardUrl', async () => {
      if (!dashboardServer) {
        vscode.window.showWarningMessage('The local dashboard server is not running.');
        return;
      }
      await vscode.env.clipboard.writeText(dashboardServer.url);
      vscode.window.showInformationMessage('Slipstream dashboard URL copied to the clipboard.');
    }),

    vscode.commands.registerCommand('slipstream.runCommand', async () => {
      const roots = [...engine.getWorkspaceRoots()];
      const cwd = roots[0];
      if (!cwd) {
        vscode.window.showWarningMessage('Open a workspace folder before running a Slipstream command.');
        return;
      }

      const entered = await vscode.window.showInputBox({
        title: 'Slipstream: Run Command',
        prompt: `Run through Slipstream in ${cwd}. Output is compressed and recorded on the dashboard.`,
        placeHolder: 'npm test',
        value: 'npm test',
      });
      const parts = splitCommandLine(entered ?? '');
      if (parts.length === 0) return;

      const settings = readSettings();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Slipstream: ${entered}`, cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() => controller.abort());
          try {
            const outcome = await runCommand({
              command: parts[0]!,
              args: parts.slice(1),
              cwd,
              workspaceRoots: roots,
              allowedCommands: settings.allowedCommands,
              timeoutMs: settings.commandTimeoutSeconds * 1000,
              signal: controller.signal,
            });
            const compressed = engine.compressCommandOutput({
              command: renderCommandLine(outcome.command, outcome.args),
              cwd: outcome.cwd,
              exitCode: outcome.exitCode,
              stdout: outcome.stdout,
              stderr: outcome.stderr,
              durationMs: outcome.durationMs,
            });
            DashboardPanel.refresh();
            const percent =
              compressed.tokensBefore > 0
                ? Math.round((compressed.tokensSaved / compressed.tokensBefore) * 100)
                : 0;
            vscode.window.showInformationMessage(
              `Slipstream: ${compressed.tokensBefore.toLocaleString()} -> ` +
                `${compressed.tokensAfter.toLocaleString()} tokens (${percent}% saved) via ${compressed.strategy}.`,
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `Slipstream command failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            subscription.dispose();
          }
        },
      );
    }),

    vscode.commands.registerCommand('slipstream.toggle', async () => {
      const config = vscode.workspace.getConfiguration('slipstream');
      const next = !config.get<boolean>('enabled', true);
      await config.update('enabled', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `Slipstream compression ${next ? 'enabled' : 'disabled'}.`,
      );
    }),

    vscode.commands.registerCommand('slipstream.resetSession', () => {
      // Forget which files the model has already seen, so the next read is full
      // again. Useful when starting a fresh chat.
      engine.resetSession();
      DashboardPanel.refresh();
      vscode.window.showInformationMessage('Slipstream session state reset.');
    }),

    vscode.commands.registerCommand('slipstream.purgeArtifacts', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Delete all stored Slipstream artifacts? Content the model has not expanded yet will no longer be retrievable.',
        { modal: true },
        'Delete',
      );
      if (choice !== 'Delete') return;
      const { artifacts } = engine.purge();
      DashboardPanel.refresh();
      vscode.window.showInformationMessage(`Slipstream removed ${artifacts} artifact(s).`);
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      engine.setWorkspaceRoots(workspaceRoots());
      refreshChatHooks();
      DashboardPanel.refresh();
      dashboardServer?.notify();
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('slipstream')) return;
      const next = readSettings();
      engine.updateConfig({
        profile: next.profile,
        enabled: next.enabled,
        compressLogs: next.compressLogs,
        crossTurnDedup: next.crossTurnDedup,
        readLifecycle: next.readLifecycle,
        maxFileLines: next.maxFileLines,
        usdPerMillionTokens: next.usdPerMillionTokens,
        pricing: next.pricing,
        costPolicy: next.costPolicy,
        artifactIdleTtlMinutes: next.artifactIdleTtlMinutes,
        artifactMaxEntries: next.artifactMaxEntries,
        artifactMaxTotalMiB: next.artifactMaxTotalMiB,
      });
      DashboardPanel.refresh();
    }),
  );
}

async function selectHookWorkspace(): Promise<vscode.WorkspaceFolder | undefined> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Trust this workspace before managing executable chat hooks.');
    return undefined;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
  if (!folders.length) {
    void vscode.window.showWarningMessage('Open a file-backed workspace folder before managing chat hooks.');
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const selected = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the workspace for Slipstream chat activity hooks' });
  return selected?.uri.scheme === 'file' ? selected : undefined;
}

function extensionSessionLabel(): string {
  return `VS Code: ${projectName()}`;
}

/**
 * Best guess at the project the user is working in. VS Code may be opened on a
 * parent folder that holds several projects, so the top-level workspace name is
 * often too coarse (for example "Repo"). Prefer the project that encloses the
 * active editor, then any workspace folder, before falling back to the window
 * name.
 */
function projectName(): string {
  const focus = vscode.window.activeTextEditor?.document.uri;
  if (focus?.scheme === 'file') {
    const label = resolveProjectLabel(focus.fsPath);
    if (label) return label;
  }
  for (const root of workspaceRoots()) {
    const label = resolveProjectLabel(root);
    if (label) return label;
  }
  const roots = workspaceRoots();
  return vscode.workspace.name || (roots[0] ? path.basename(roots[0]) : 'VS Code window');
}

/**
 * Split a typed command line into argv. Quoted segments stay together so paths
 * with spaces survive; the core validator still rejects shell metacharacters.
 */
function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input.trim())) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return parts.filter((part) => part.length > 0);
}

export function deactivate(): void {
  // Nothing to tear down: artifacts are deliberately persisted across reloads so
  // retrieval markers stay valid, and everything else is a context subscription.
}

/**
 * Offer the same four tools over MCP.
 *
 * Off by default: inside VS Code the contributed language model tools already
 * cover this, and running both would show the model two copies of every tool.
 * The provider exists so the same engine can be shared with another MCP client.
 */
function registerMcpProvider(
  context: vscode.ExtensionContext,
  engine: CompressionEngine,
): void {
  if (typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
    return; // older VS Code; the language model tools still work
  }

  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('slipstream')) changed.fire();
    }),
    vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: () => {
        const settings = readSettings();
        if (!settings.provideMcpServer) return [];

        const roots = [...engine.getWorkspaceRoots()];
        const args = [context.asAbsolutePath(path.join('dist', 'mcp-server.js'))];
        for (const root of roots) args.push('--root', root);
        args.push('--storage', settings.storageDir);

        const env: Record<string, string> = {
          SLIPSTREAM_PRICING_MODE: 'automatic',
          SLIPSTREAM_USD_PER_MILLION: String(settings.usdPerMillionTokens),
          SLIPSTREAM_ENABLED: settings.enabled ? '1' : '0',
          SLIPSTREAM_SESSION_LABEL: `VS Code MCP: ${projectName()}`,
        };
        if (settings.allowedCommands?.length) {
          env['SLIPSTREAM_ALLOWED_COMMANDS'] = settings.allowedCommands.join(',');
        }

        return [
          new vscode.McpStdioServerDefinition('Slipstream', process.execPath, args, env, '0.1.0'),
        ];
      },
    }),
  );
}
