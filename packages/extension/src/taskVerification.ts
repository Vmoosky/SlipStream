import { createHash } from 'node:crypto';

import { buildTaskUsage, recordTaskOutcome, runCommand, taskWorkspaceKey, validateCommand, type CompressionEngine, type TaskOutcomeEvidence } from '@slipstream/core';
import * as vscode from 'vscode';

import { readSettings } from './config.js';

export const VERIFY_TASK_COMMAND = 'slipstream.verifyTask';

type VerificationAction = 'test' | 'build' | 'custom' | 'user-pass' | 'user-fail';

export function createTaskVerifier(engine: CompressionEngine): (taskId?: unknown) => Promise<void> {
  const active = new Set<string>();
  return async (taskId) => {
    let selectedId: string | undefined;
    let ownsLock = false;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before recording task outcomes.');
      const roots = [...engine.getWorkspaceRoots()];
      const workspaceKey = taskWorkspaceKey(roots);
      const eligible = () => buildTaskUsage(engine.ledger.all()).filter((task) => task.workspaceKey === workspaceKey && task.endedAt !== null && task.pendingCalls === 0);
      const tasks = eligible();
      if (taskId !== undefined && (typeof taskId !== 'string' || !tasks.some((task) => task.taskId === taskId))) {
        throw new Error('Select a completed owned task from this workspace.');
      }
      if (!roots.length || !tasks.length) {
        await vscode.window.showInformationMessage('No completed owned tasks in this workspace.');
        return;
      }
      const selected = taskId === undefined ? await vscode.window.showQuickPick(tasks.map((task) => ({
        label: task.taskId.slice(0, 8), description: new Date(task.startedAt).toLocaleString() + ' | ' + task.state,
        taskId: task.taskId,
      })), { title: 'Verify Task Outcome', placeHolder: 'Owned task' }) : { taskId: taskId as string };
      if (!selected) return;
      selectedId = selected.taskId;
      if (active.has(selectedId)) throw new Error('Verification is already open for this task.');
      active.add(selectedId);
      ownsLock = true;
      const lifecycle = tasks.find((task) => task.taskId === selectedId)!;
      const ensureCurrent = () => {
        if (!vscode.workspace.isTrusted || taskWorkspaceKey(engine.getWorkspaceRoots()) !== workspaceKey ||
          !eligible().some((task) => task.taskId === selectedId && task.resumes === lifecycle.resumes && task.endedAt === lifecycle.endedAt)) {
          throw new Error('The task or trusted workspace is no longer available.');
        }
      };
      const actions: (vscode.QuickPickItem & { action: VerificationAction })[] = [
        { label: 'Run a test check', action: 'test' },
        { label: 'Run a build check', action: 'build' },
        { label: 'Run another command check', action: 'custom' },
        { label: 'Report successful', description: 'User-reported, not verified', action: 'user-pass' },
        { label: 'Report unsuccessful', description: 'User-reported, not verified', action: 'user-fail' },
      ];
      const choice = await vscode.window.showQuickPick(actions, { title: 'Task ' + selectedId.slice(0, 8), placeHolder: 'Outcome evidence' });
      if (!choice) return;
      if (choice.action === 'user-pass' || choice.action === 'user-fail') {
        const result = choice.action === 'user-pass' ? 'pass' : 'fail';
        const confirmed = await vscode.window.showWarningMessage('Record a user-reported ' + result + '?', {
          modal: true, detail: 'Task ' + selectedId + '. This is your assessment, not an independently verified result.',
        }, 'Record report');
        if (confirmed !== 'Record report') return;
        ensureCurrent();
        recordTaskOutcome(engine.ledger, selectedId, { source: 'user', result }, lifecycle);
        await vscode.window.showInformationMessage('User-reported ' + result + ' recorded.');
        return;
      }
      const cwd = await vscode.window.showInputBox({ title: 'Verification working directory', value: roots[0], ignoreFocusOut: true });
      if (cwd === undefined) return;
      const input = await vscode.window.showInputBox({
        title: 'Verification command (JSON argument array)', placeHolder: '["npm", "test"]', ignoreFocusOut: true,
        validateInput: (value) => {
          try { validateCommand({ ...parseCommand(value), cwd, workspaceRoots: roots, allowedCommands: readSettings().allowedCommands }); return undefined; }
          catch (error) { return error instanceof Error ? error.message : 'Invalid command'; }
        },
      });
      if (input === undefined) return;
      const command = validateCommand({ ...parseCommand(input), cwd, workspaceRoots: roots, allowedCommands: readSettings().allowedCommands });
      const check = choice.action;
      const approved = await vscode.window.showWarningMessage('Run verification check?', {
        modal: true,
        detail: 'Task ' + selectedId + '\n\n' + JSON.stringify([command.command, ...command.args]) + '\nDirectory: ' + command.cwd +
          '\n\nUse this command\'s exit code as the ' + check + ' success check for the current workspace. Zero means pass; nonzero means fail.',
      }, 'Run check');
      if (approved !== 'Run check') return;
      ensureCurrent();
      const checkKey = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const evidence = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Verifying task ' + selectedId.slice(0, 8), cancellable: true,
      }, async (_progress, token): Promise<TaskOutcomeEvidence> => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        const startedAt = Date.now();
        try {
          if (token.isCancellationRequested) return { source: 'command', check, checkKey, execution: 'cancelled', exitCode: null, durationMs: 0 };
          ensureCurrent();
          const settings = readSettings();
          const outcome = await runCommand({
            ...command, workspaceRoots: roots, allowedCommands: settings.allowedCommands,
            timeoutMs: settings.commandTimeoutSeconds * 1000, signal: controller.signal,
          });
          const execution = token.isCancellationRequested ? 'cancelled' : outcome.timedOut || outcome.exitCode === null ? 'error' : 'completed';
          return { source: 'command', check, checkKey, execution, exitCode: execution === 'completed' ? outcome.exitCode : null, durationMs: outcome.durationMs };
        } catch {
          return { source: 'command', check, checkKey, execution: token.isCancellationRequested ? 'cancelled' : 'error', exitCode: null, durationMs: Math.max(0, Date.now() - startedAt) };
        } finally { subscription.dispose(); }
      });
      ensureCurrent();
      recordTaskOutcome(engine.ledger, selectedId, evidence, lifecycle);
      if (evidence.source === 'command') {
        const message = evidence.execution === 'completed' ? (evidence.exitCode === 0 ? 'Check passed' : 'Check failed') + ' (exit ' + evidence.exitCode + ').' :
          evidence.execution === 'cancelled' ? 'Verification cancelled. No verified result recorded.' : 'Verification could not complete. The outcome remains unverified.';
        await vscode.window.showInformationMessage(message);
      }
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Task verification failed.');
    } finally {
      if (selectedId && ownsLock) active.delete(selectedId);
    }
  };
}

function parseCommand(value: string): { command: string; args: string[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Enter a JSON array containing the executable and each argument.'); }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((argument) => typeof argument === 'string')) {
    throw new Error('Enter a nonempty JSON array of strings.');
  }
  return { command: parsed[0] as string, args: parsed.slice(1) as string[] };
}