import * as os from 'node:os';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { isCompressionProfile, validateCostPolicy, type CostPolicy, type EngineConfig } from '@slipstream/core';

export interface ExtensionSettings extends Partial<EngineConfig> {
  storageDir: string;
  allowedCommands: string[] | undefined;
  commandTimeoutSeconds: number;
  provideMcpServer: boolean;
  dashboardServer: boolean;
  dashboardPort: number;
}

export function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('slipstream');
  const allowed = config.get<string[]>('allowedCommands', []);
  const profile = config.get<string>('profile', 'balanced');
  const fileLimit = config.inspect<number>('maxFileLines');
  return {
    profile: isCompressionProfile(profile) ? profile : 'balanced',
    storageDir: resolveStorageDir(config.get<string>('storageDir', '')),
    enabled: config.get<boolean>('enabled', true),
    compressLogs: config.get<boolean>('compressLogs', true),
    crossTurnDedup: config.get<boolean>('crossTurnDedup', true),
    readLifecycle: config.get<boolean>('readLifecycle', true),
    maxFileLines: fileLimit?.workspaceFolderValue ?? fileLimit?.workspaceValue ?? fileLimit?.globalValue,
    pricing: { mode: 'automatic' },
    costPolicy: readCostPolicy(config),
    usdPerMillionTokens: config.get<number>('usdPerMillionTokens', 3),
    artifactIdleTtlMinutes: config.get<number>('artifactIdleTtlMinutes', 60),
    artifactMaxEntries: config.get<number>('artifactMaxEntries', 2000),
    artifactMaxTotalMiB: config.get<number>('artifactMaxTotalMiB', 256),
    allowedCommands: allowed.length > 0 ? allowed : undefined,
    commandTimeoutSeconds: config.get<number>('commandTimeoutSeconds', 120),
    provideMcpServer: config.get<boolean>('provideMcpServer', false),
    dashboardServer: config.get<boolean>('dashboardServer', true),
    dashboardPort: config.get<number>('dashboardPort', 7331),
  };
}

let warnedInvalidPolicy = false;

function readCostPolicy(config: vscode.WorkspaceConfiguration): CostPolicy {
  try {
    const policy = validateCostPolicy(config.get<unknown>('costPolicy'));
    warnedInvalidPolicy = false;
    return policy;
  } catch {
    if (!warnedInvalidPolicy) {
      void vscode.window.showWarningMessage('Invalid slipstream.costPolicy setting. New policy automation is off; existing compression settings are unchanged.');
      warnedInvalidPolicy = true;
    }
    return validateCostPolicy();
  }
}

export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
}

function resolveStorageDir(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return path.join(os.homedir(), '.slipstream');
  }
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}
