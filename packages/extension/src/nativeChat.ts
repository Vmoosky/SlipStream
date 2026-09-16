import * as path from 'node:path';
import * as vscode from 'vscode';
import { CompressionEngine, NativeContextStore, nativeChatMessage, nativeChatStatus, nativeCommandKey, nativePolicyRevision, recordNativeCheck,
  recordNativeEvent, renderCommandLine, validateCommand, validateNativeChatPolicy, type CompressionProfile, type NativeChatPolicy, type NativeToolContext } from '@slipstream/core';
import { readSettings } from './config.js';

export interface NativeCommandOutcome {
  exitCode: number | null;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
  error?: boolean;
}

export interface NativeToolCallbacks {
  commandComplete: (outcome: NativeCommandOutcome) => void;
  retrievalComplete: (success: boolean) => void;
}

export function readNativeChatPolicy(workspaceRoot: string): NativeChatPolicy {
  return validateNativeChatPolicy(vscode.workspace.getConfiguration('slipstream', vscode.Uri.file(workspaceRoot)).get<unknown>('nativeChatPolicy'));
}

const nativePolicySaves = new Set<string>();

export async function saveNativeChatPolicy(workspaceRoot: string, value: unknown, expectedRevision: string): Promise<void> {
  const policy = validateNativeChatPolicy(value);
  const available = () => vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === 'file' && folder.uri.fsPath === workspaceRoot);
  if (!available()) throw new Error('Trust and open the workspace before saving native chat policy.');
  if (nativePolicySaves.has(workspaceRoot)) throw new Error('A native policy save is already in progress.');
  if (nativePolicyRevision(readNativeChatPolicy(workspaceRoot)) !== expectedRevision) throw new Error('Native policy changed during setup. Open setup again to review the current values.');
  nativePolicySaves.add(workspaceRoot);
  try {
    await vscode.workspace.getConfiguration('slipstream', vscode.Uri.file(workspaceRoot)).update('nativeChatPolicy', policy, vscode.ConfigurationTarget.WorkspaceFolder);
    if (!available() || nativePolicyRevision(readNativeChatPolicy(workspaceRoot)) !== nativePolicyRevision(policy)) throw new Error('Native policy did not become the effective workspace setting. Review the current settings.');
  } finally {
    nativePolicySaves.delete(workspaceRoot);
  }
}

export async function configureNativeChatPolicy(workspaceRoot: string): Promise<boolean> {
  if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before configuring native chat policy.');
  const current = readNativeChatPolicy(workspaceRoot);
  const expectedRevision = nativePolicyRevision(current);
  const mode = await vscode.window.showQuickPick([
    { label: 'Off', mode: 'off' as const, description: 'Keep existing activity tracking and tool compression' },
    { label: 'Observe', mode: 'observe' as const, description: 'Record approved designated checks and show native status' },
    { label: 'Guard', mode: 'guard' as const, description: 'Also adapt compression and stop at observed-usage hook boundaries' },
  ], { title: 'Slipstream native chat policy', placeHolder: `Current mode: ${current.mode}` });
  if (!mode) return false;
  const next: NativeChatPolicy = { ...current, mode: mode.mode, checks: [...current.checks] };
  if (next.mode !== 'off') {
    const limit = await vscode.window.showInputBox({ title: 'Native conversation reported-token limit',
      prompt: 'Blank means no threshold. Reported input plus output tokens; not a billing cap.', value: current.tokenLimit?.toString() ?? '',
      validateInput: (value) => value.trim() === '' || /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? undefined : 'Enter a nonnegative whole number or leave blank.' });
    if (limit === undefined) return false;
    if (limit.trim() === '') delete next.tokenLimit;
    else next.tokenLimit = Number(limit);
    if (next.mode === 'guard') {
      const profiles = await vscode.window.showQuickPick((['conservative', 'balanced', 'aggressive'] as const).map((profile) => ({ label: profile, profile,
        picked: current.compressionProfiles.includes(profile) })), { title: 'Permitted native compression profiles', canPickMany: true });
      if (!profiles) return false;
      next.compressionProfiles = profiles.map((item) => item.profile) as CompressionProfile[];
    }
    while (true) {
      const action = await vscode.window.showQuickPick([
        { label: `Keep ${next.checks.length} designated check(s)`, action: 'done', index: -1 },
        { label: 'Add a test check', action: 'test', index: -1 },
        { label: 'Add a build check', action: 'build', index: -1 },
        ...next.checks.map((check, index) => ({ label: `Remove ${check.kind}: ${renderCommandLine(check.command, check.args)}`, action: 'remove', index })),
      ], { title: 'Native verification checks', placeHolder: 'Only exact configured commands count; execution still requires approval' });
      if (!action) return false;
      if (action.action === 'done') break;
      if (action.action === 'remove') { next.checks.splice(action.index, 1); continue; }
      const command = await vscode.window.showInputBox({ title: 'Check executable', value: 'npm', prompt: 'Bare executable, not a shell command.' });
      if (command === undefined) return false;
      const argsText = await vscode.window.showInputBox({ title: 'Check arguments as a JSON array', value: action.action === 'test' ? '["test"]' : '["run","build"]',
        validateInput: (value) => {
          try { const args = JSON.parse(value); return Array.isArray(args) && args.every((arg) => typeof arg === 'string') ? undefined : 'Use a JSON array of strings.'; }
          catch { return 'Use a JSON array of strings.'; }
        } });
      if (argsText === undefined) return false;
      const cwd = await vscode.window.showInputBox({ title: 'Check working directory', value: '.', prompt: 'Absolute path or path relative to this workspace folder.' });
      if (cwd === undefined) return false;
      const check = { kind: action.action as 'test' | 'build', command, args: JSON.parse(argsText) as string[], cwd };
      validateNativeChatPolicy({ ...next, checks: [...next.checks, check] });
      validateCommand({ command, args: check.args, cwd: path.resolve(workspaceRoot, cwd), workspaceRoots: [workspaceRoot], allowedCommands: readSettings().allowedCommands });
      if (next.checks.some((existing) => nativeCommandKey(existing, workspaceRoot) === nativeCommandKey(check, workspaceRoot))) throw new Error('This command is already a designated native check.');
      next.checks.push(check);
    }
  }
  const validated = validateNativeChatPolicy(next);
  const saved = await vscode.window.showWarningMessage('Save native chat policy?', { modal: true,
    detail: `Workspace: ${workspaceRoot}\nMode: ${validated.mode}\nReported-token limit: ${validated.tokenLimit ?? 'none'}\nCompression profiles: ${validated.compressionProfiles.join(', ')}\n`
      + `Designated checks: ${validated.checks.length}\n\nNo commands run during setup. Command approvals remain required. Copilot controls model selection. Native limits are not billing caps.`,
  }, 'Save policy');
  if (saved !== 'Save policy') return false;
  await saveNativeChatPolicy(workspaceRoot, validated, expectedRevision);
  return true;
}

interface CachedEngine {
  engine: CompressionEngine;
  active: number;
}

export class NativeToolController implements vscode.Disposable {
  private readonly engines = new Map<string, CachedEngine>();

  constructor(private readonly parent: CompressionEngine) {}

  wrap<Input extends object>(toolName: string,
    factory: (engine: CompressionEngine, callbacks?: NativeToolCallbacks) => vscode.LanguageModelTool<Input>): vscode.LanguageModelTool<Input & { nativeContext?: string }> {
    const fallback = factory(this.parent);
    return {
      prepareInvocation: (options, token) => fallback.prepareInvocation?.(options, token),
      invoke: async (options, token) => {
        let cached: CachedEngine | undefined;
        try {
          if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using Slipstream tools.');
          if (token.isCancellationRequested) throw new Error('Tool invocation cancelled.');
          const recoveryTool = toolName === 'slipstream_retrieveArtifact' || toolName === 'slipstream_getSavings';
          const roots = this.parent.getWorkspaceRoots();
          if (!options.input.nativeContext) {
            if (!recoveryTool && roots.some((root) => readNativeChatPolicy(root).mode === 'guard')) throw new Error('Native policy requires hook-provided conversation context. Review Chat: Configure Hooks before retrying.');
            return await fallback.invoke(options, token);
          }
          const invocation = this.claimContext(options.input.nativeContext, toolName, options.input);
          const { context, root, policy } = invocation;
          const status = nativeChatStatus(this.parent.ledger.all(), root, context.sessionId, policy, this.parent.getConfig().profile);
          if (status.state === 'paused' && !recoveryTool) {
            recordNativeEvent(this.parent.ledger, root, { event: 'policy', sessionId: context.sessionId, policyRevision: context.policyRevision,
              state: 'paused', reason: status.reason, profile: status.profile, observedTokens: status.observedTokens });
            throw new Error(nativeChatMessage(status, policy));
          }
          const overrides = this.parent.getConfigOverrides();
          const key = JSON.stringify([root, context.sessionId, context.policyRevision, status.profile, overrides]);
          cached = this.engines.get(key);
          if (!cached) {
            cached = { active: 0, engine: new CompressionEngine({ rootDir: this.parent.getStorageDir(), workspaceRoots: [root],
              sessionId: `vscode-chat:${context.sessionId}`, sessionLabel: `VS Code chat: ${path.basename(root)}`,
              policyContext: { host: 'native-copilot', scope: 'workspace' }, config: { ...overrides, profile: status.profile } }) };
            this.engines.set(key, cached);
          }
          cached.active++;
          const callbacks: NativeToolCallbacks = {
            commandComplete: (outcome) => { recordNativeCheck(this.parent.ledger, root, context, outcome); },
            retrievalComplete: (success) => recordNativeEvent(this.parent.ledger, root, { event: 'recovery', sessionId: context.sessionId,
              toolCallId: context.toolCallId, policyRevision: context.policyRevision, outcome: success ? 'pass' : 'fail' }),
          };
          const { nativeContext: _nativeContext, ...input } = options.input;
          const scoped = cached.engine;
          const output = await scoped.ledger.withToolCallContext({ source: 'vscode', sessionId: context.sessionId,
            toolCallId: context.toolCallId, toolName }, () => factory(scoped, callbacks).invoke({ ...options, input: input as Input }, token));
          if (!output || toolName !== 'slipstream_getSavings') return output;
          const current = nativeChatStatus(this.parent.ledger.all(), root, context.sessionId, policy, this.parent.getConfig().profile);
          return new vscode.LanguageModelToolResult([...output.content, new vscode.LanguageModelTextPart(nativeChatMessage(current, policy))]);
        } catch (error) {
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(error instanceof Error ? error.message : 'Native chat policy could not be evaluated.')]);
        } finally {
          if (cached) cached.active--;
          this.prune();
        }
      },
    };
  }

  dispose(): void {
    for (const cached of this.engines.values()) cached.engine.dispose();
    this.engines.clear();
  }

  private claimContext(token: string, toolName: string, input: object): { context: NativeToolContext; root: string; policy: NativeChatPolicy } {
    for (const root of this.parent.getWorkspaceRoots()) {
      try {
        const policy = readNativeChatPolicy(root);
        const context = new NativeContextStore(this.parent.getStorageDir(), root).claim(token, toolName, input, policy);
        if (context.policyRevision !== nativePolicyRevision(readNativeChatPolicy(root))) throw new Error('Native policy changed.');
        return { context, root, policy };
      } catch {}
    }
    throw new Error('Native chat context is expired, changed, or already used. Retry the tool with native hooks enabled.');
  }

  private prune(): void {
    for (const [key, cached] of this.engines) {
      if (this.engines.size <= 32) break;
      if (!cached.active) { cached.engine.dispose(); this.engines.delete(key); }
    }
  }
}