import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CompressionEngine, DashboardModelTrackingStatus, ModelTelemetryHealth } from '@slipstream/core';
import * as vscode from 'vscode';

import { recordModelObservation, startModelTelemetryReceiver, type ModelTelemetryReceiver } from './modelTelemetry.js';

const CONNECTION_KEY = 'modelTracking.connection.v1';
const OFFER_KEY = 'modelTracking.offered.v1';
const SECRET_KEY = 'slipstream.modelTracking.credential.v1';
const SECTION = 'github.copilot.chat.otel';
const SETTING_KEYS = ['captureContent', 'exporterType', 'protocol', 'otlpEndpoint', 'headers', 'outfile', 'dbSpanExporter.enabled', 'maxAttributeSizeChars', 'enabled'] as const;
type SettingKey = typeof SETTING_KEYS[number];

interface PreviousSetting {
  key: SettingKey;
  value?: unknown;
}

interface Connection {
  version: 1;
  phase: 'installing' | 'connected';
  updatedAt: number;
  endpoint: string;
  tokenHash: string;
  storageDir: string;
  previous: PreviousSetting[];
}

export type ModelTrackingStatus = DashboardModelTrackingStatus;

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

function installedSettings(connection: Connection, token: string): Record<SettingKey, unknown> {
  return {
    captureContent: false, exporterType: 'otlp-http', protocol: 'http/json',
    otlpEndpoint: connection.endpoint, headers: { Authorization: `Bearer ${token}` },
    outfile: '', 'dbSpanExporter.enabled': false, maxAttributeSizeChars: 256, enabled: true,
  };
}

export class ModelTrackingController {
  private receiver?: ModelTelemetryReceiver;
  private receiverHealth?: ModelTelemetryHealth;
  private busy?: Promise<void>;
  private heartbeat?: NodeJS.Timeout;
  private disposed = false;
  private readonly hostStartedAt = Date.now() - process.uptime() * 1000;
  private current: ModelTrackingStatus = { state: 'disconnected', detail: 'Local Copilot model tracking is off.', canConnect: true, canDisconnect: false };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly engine: CompressionEngine,
    private readonly onChange: () => void = () => undefined,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  status(): ModelTrackingStatus {
    const shared = this.current.state === 'connected' && !this.receiver;
    const health = shared ? undefined : this.receiverHealth;
    return {
      ...this.current,
      receiverHealthScope: shared ? 'shared' : 'window',
      receiverHealth: health ? { ...health, rejectedExports: { ...health.rejectedExports } } : undefined,
    };
  }

  async initialize(): Promise<void> {
    await this.refresh();
    if (this.disposed || this.heartbeat) return;
    this.heartbeat = setInterval(() => void this.refresh(), 15_000);
    this.heartbeat.unref();
  }

  connect(): Promise<void> {
    return this.run(async () => {
      if (this.context.globalState.get(CONNECTION_KEY)) {
        await this.refreshInternal();
        return;
      }
      const blocked = this.blockedReason();
      if (blocked) {
        this.setStatus('blocked', blocked);
        return;
      }
      await this.context.globalState.update(OFFER_KEY, true);
      const choice = await vscode.window.showWarningMessage('Allow local Copilot model tracking?', {
        modal: true,
        detail: 'Copilot telemetry can include prompts, code, tool results, and hook data even with content capture off. Slipstream will receive it on this computer, discard content in memory before logging or storage, and retain only model identity, trace/session IDs, timing, and token usage. Telemetry is not forwarded. No GitHub token is requested.\n\nThis changes Copilot telemetry settings for this VS Code profile, including other local windows. Existing custom or managed exporters are not replaced. Disconnect restores settings that Slipstream still owns.',
      }, 'Allow', 'Not Now');
      if (choice !== 'Allow' || this.disposed) return;
      await this.withConfigurationLock(async () => {
        if (this.context.globalState.get(CONNECTION_KEY)) {
          await this.refreshInternal();
          return;
        }
        const reason = this.blockedReason();
        if (reason) { this.setStatus('blocked', reason); return; }
        this.setStatus('connecting', 'Connecting the local telemetry receiver.');
        const receiver = await this.startReceiver();
        this.receiver = receiver;
        const configuration = vscode.workspace.getConfiguration(SECTION);
        const connection: Connection = {
          version: 1, phase: 'installing', updatedAt: Date.now(), endpoint: receiver.endpoint,
          tokenHash: createHash('sha256').update(receiver.token).digest('hex'),
          storageDir: this.engine.getStorageDir(),
          previous: SETTING_KEYS.map((key) => ({ key, value: configuration.inspect(key)?.globalValue })),
        };
        try {
          await this.context.secrets.store(SECRET_KEY, receiver.token);
          await this.context.globalState.update(CONNECTION_KEY, connection);
          const settings = installedSettings(connection, receiver.token);
          for (const key of SETTING_KEYS) {
            if (this.disposed || !vscode.workspace.isTrusted) throw new Error('Model tracking was cancelled.');
            await configuration.update(key, settings[key], vscode.ConfigurationTarget.Global);
            if (!equal(vscode.workspace.getConfiguration(SECTION).get(key), settings[key])) throw new Error('Copilot telemetry settings are overridden.');
          }
          connection.phase = 'connected';
          connection.updatedAt = Date.now();
          await this.context.globalState.update(CONNECTION_KEY, connection);
          this.setConnectedStatus(connection);
        } catch {
          await this.restore(connection, receiver.token);
          await this.stopReceiver();
          throw new Error('Could not configure local model tracking.');
        }
      });
      if (this.current.state === 'connected') {
        const choice = await vscode.window.showInformationMessage('Local receiver ready. Copilot requires a window reload before it can report models to Slipstream.', 'Reload Window', 'Later');
        if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  }

  disconnect(): Promise<void> {
    return this.run(async () => {
      await this.withConfigurationLock(async () => {
        const connection = this.connection();
        if (connection) await this.restore(connection, await this.readToken(connection));
        await this.stopReceiver();
        await this.context.globalState.update(OFFER_KEY, true);
        this.setStatus('disconnected', 'Local Copilot model tracking is off.');
      });
      const choice = await vscode.window.showInformationMessage('Model tracking disconnected. Existing observations were kept. Reload VS Code to stop Copilot using its previous exporter.', 'Reload Window', 'Later');
      if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  }

  async refresh(): Promise<void> {
    await this.run(() => this.refreshInternal());
    if (!this.disposed && !this.context.globalState.get(CONNECTION_KEY) && !this.context.globalState.get(OFFER_KEY) && !this.blockedReason()) {
      await this.connect();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.stopReceiver();
  }

  private run(work: () => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = work().catch(async () => {
      await this.stopReceiver();
      this.setStatus('error', 'Local model tracking could not start. Check VS Code settings permissions or disconnect and reconnect.');
    }).finally(() => { this.busy = undefined; });
    return this.busy;
  }

  private connection(): Connection | undefined {
    const value = this.context.globalState.get<Connection>(CONNECTION_KEY);
    if (!value) return undefined;
    const endpoint = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(value.endpoint ?? '');
    if (value.version !== 1 || !endpoint || Number(endpoint[1]) < 1 || Number(endpoint[1]) > 65535 || !/^[a-f\d]{64}$/.test(value.tokenHash) || !['installing', 'connected'].includes(value.phase) || !Number.isFinite(value.updatedAt) || typeof value.storageDir !== 'string' || !Array.isArray(value.previous) || value.previous.length !== SETTING_KEYS.length || !SETTING_KEYS.every((key) => value.previous.filter((entry) => entry.key === key).length === 1)) {
      throw new Error('Invalid model tracking connection state.');
    }
    return value;
  }

  private blockedReason(owned = false): string | undefined {
    if (!vscode.workspace.isTrusted) return 'Trust this workspace before connecting local model tracking.';
    if (vscode.env.remoteName) return 'Model tracking currently requires a local desktop extension host; remote and Agent Host sessions are not connected.';
    const connection = owned ? this.connection() : undefined;
    const managedEnvironment: Record<string, string> = connection ? {
      COPILOT_OTEL_ENABLED: 'true',
      COPILOT_OTEL_ENDPOINT: connection.endpoint,
      OTEL_EXPORTER_OTLP_ENDPOINT: connection.endpoint,
      COPILOT_OTEL_EXPORTER_TYPE: 'otlp-http',
      COPILOT_OTEL_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      COPILOT_OTEL_CAPTURE_CONTENT: 'false',
      COPILOT_OTEL_MAX_ATTRIBUTE_SIZE_CHARS: '256',
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
    } : {};
    const conflict = Object.entries(this.environment).find(([key, value]) =>
      (/^(COPILOT_OTEL_|OTEL_EXPORTER_OTLP_)/.test(key) || key === 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT') && value &&
      !(key === 'COPILOT_OTEL_FILE_EXPORTER_PATH' && value === os.devNull) &&
      managedEnvironment[key] !== value &&
      !(connection && (key === 'COPILOT_OTEL_ENDPOINT' || key === 'OTEL_EXPORTER_OTLP_ENDPOINT') && sameEndpoint(value, connection.endpoint)));
    if (conflict) return `Existing telemetry environment override (${conflict[0]}) is not changed by Slipstream.`;
    const configuration = vscode.workspace.getConfiguration(SECTION);
    if (SETTING_KEYS.some((key) => configuration.inspect(key)?.defaultValue === undefined)) return 'This Copilot version does not support the required local telemetry settings.';
    for (const key of SETTING_KEYS) {
      const inspected = configuration.inspect(key) as { workspaceValue?: unknown; workspaceFolderValue?: unknown; policyValue?: unknown; globalLanguageValue?: unknown; workspaceLanguageValue?: unknown; workspaceFolderLanguageValue?: unknown };
      if ([inspected.workspaceValue, inspected.workspaceFolderValue, inspected.policyValue, inspected.globalLanguageValue, inspected.workspaceLanguageValue, inspected.workspaceFolderLanguageValue].some((value) => value !== undefined)) return 'Workspace or managed telemetry settings must be left unchanged.';
    }
    if (!owned && SETTING_KEYS.some((key) => !equal(configuration.get(key), configuration.inspect(key)?.defaultValue))) return 'An existing custom telemetry configuration is present. Slipstream will not replace it.';
    return undefined;
  }

  private async refreshInternal(): Promise<void> {
    const connection = this.connection();
    const blocked = this.blockedReason(!!connection);
    if (blocked) {
      await this.stopReceiver();
      this.setStatus('blocked', blocked);
      return;
    }
    if (!connection) {
      await this.stopReceiver();
      this.setStatus('disconnected', 'Local Copilot model tracking is off.');
      return;
    }
    if (connection.storageDir !== this.engine.getStorageDir()) {
      await this.stopReceiver();
      this.setStatus('blocked', 'Model tracking belongs to a different Slipstream storage directory.');
      return;
    }
    const token = await this.readToken(connection);
    if (connection.phase === 'installing') {
      if (Date.now() - connection.updatedAt < 60_000) {
        this.setStatus('connecting', 'Another window is connecting local model tracking.');
      } else {
        await this.withConfigurationLock(() => this.restore(connection, token));
        this.setStatus('disconnected', 'An interrupted setup was restored. Connect again to retry.');
      }
      return;
    }
    const settings = installedSettings(connection, token);
    if (!token || SETTING_KEYS.some((key) => !equal(vscode.workspace.getConfiguration(SECTION).get(key), settings[key]))) {
      await this.stopReceiver();
      this.setStatus('blocked', 'Copilot telemetry settings changed. Tracking stopped; disconnect before reconnecting.');
      return;
    }
    if (!this.receiver) {
      try {
        this.receiver = await this.startReceiver(token, Number(new URL(connection.endpoint).port));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        const response = await fetch(`${connection.endpoint}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500), redirect: 'error' });
        const health = await response.json() as { service?: string; version?: number };
        if (!response.ok || health.service !== 'slipstream-model-telemetry' || health.version !== 1) throw new Error('Local telemetry receiver unavailable.');
      }
    }
    this.setConnectedStatus(connection);
  }

  private setConnectedStatus(connection: Connection): void {
    this.setStatus('connected', connection.updatedAt >= this.hostStartedAt
      ? 'Local receiver ready. Run Developer: Reload Window to enable Copilot telemetry, then complete a new Copilot call.'
      : 'Local receiver ready. Models appear after completed Copilot calls.');
  }

  private async startReceiver(token?: string, port?: number): Promise<ModelTelemetryReceiver> {
    const receiver = await startModelTelemetryReceiver({
      token, port, initialHealth: this.receiverHealth,
      onHealthChange: (health) => {
        this.receiverHealth = health;
        if (!this.disposed) this.onChange();
      },
      onObservation: (observation) => {
        const connection = this.connection();
        if (this.disposed || this.blockedReason(true) || !connection || connection.phase !== 'connected' || observation.endedAt > Date.now() + 60_000) return false;
        const installed = installedSettings(connection, this.receiver?.token ?? token ?? '');
        if (SETTING_KEYS.some((key) => !equal(vscode.workspace.getConfiguration(SECTION).get(key), installed[key]))) return false;
        return recordModelObservation(this.engine, observation);
      },
    });
    if (this.disposed) {
      await receiver.close();
      throw new Error('Model tracking was disposed.');
    }
    this.receiverHealth = receiver.getHealth();
    return receiver;
  }

  private async readToken(connection: Connection): Promise<string> {
    const stored = await this.context.secrets.get(SECRET_KEY);
    const configured = vscode.workspace.getConfiguration(SECTION).get<Record<string, string>>('headers')?.Authorization?.replace(/^Bearer /, '');
    return [stored, configured].find((value) => value && /^[a-f\d]{64}$/.test(value) && createHash('sha256').update(value).digest('hex') === connection.tokenHash) ?? '';
  }

  private async restore(connection: Connection, token: string): Promise<void> {
    const installed = installedSettings(connection, token);
    const configuration = vscode.workspace.getConfiguration(SECTION);
    for (const entry of [...connection.previous].reverse()) {
      const current = configuration.inspect(entry.key)?.globalValue;
      if (entry.key === 'headers' && token && current && typeof current === 'object') {
        const headers = { ...current } as Record<string, unknown>;
        if (headers.Authorization === `Bearer ${token}`) {
          delete headers.Authorization;
          await configuration.update(entry.key, Object.keys(headers).length ? headers : entry.value, vscode.ConfigurationTarget.Global);
        }
      } else if (equal(current, installed[entry.key])) {
        await configuration.update(entry.key, entry.value, vscode.ConfigurationTarget.Global);
      }
    }
    await this.context.globalState.update(CONNECTION_KEY, undefined);
    await this.context.secrets.delete(SECRET_KEY);
  }

  private async stopReceiver(): Promise<void> {
    const receiver = this.receiver;
    this.receiver = undefined;
    await receiver?.close();
  }

  private setStatus(state: ModelTrackingStatus['state'], detail: string): void {
    const connected = !!this.context.globalState.get(CONNECTION_KEY);
    const next = { state, detail, canConnect: !connected && (state === 'disconnected' || state === 'error'), canDisconnect: connected };
    if (equal(this.current, next)) return;
    this.current = next;
    this.onChange();
  }

  private async withConfigurationLock(work: () => Promise<void>): Promise<void> {
    const folder = this.context.globalStorageUri.fsPath;
    fs.mkdirSync(folder, { recursive: true });
    const lock = path.join(folder, 'model-tracking-setup.lock');
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 5 * 60_000) fs.unlinkSync(lock);
    const descriptor = fs.openSync(lock, 'wx', 0o600);
    try { await work(); } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
  }
}

export function registerModelTracking(context: vscode.ExtensionContext, engine: CompressionEngine, onChange: () => void): ModelTrackingController {
  const controller = new ModelTrackingController(context, engine, onChange);
  const initialize = () => void controller.initialize().catch(() => controller.dispose());
  context.subscriptions.push(
    { dispose: () => void controller.dispose() },
    vscode.commands.registerCommand('slipstream.connectModelTracking', () => controller.connect()),
    vscode.commands.registerCommand('slipstream.disconnectModelTracking', () => controller.disconnect()),
    vscode.window.registerUriHandler({ handleUri: async (uri) => {
      if (uri.path === '/model-tracking') await vscode.commands.executeCommand('slipstream.showDashboard');
    } }),
    vscode.workspace.onDidGrantWorkspaceTrust(initialize),
    vscode.extensions.onDidChange(() => void controller.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) void controller.refresh();
    }),
  );
  initialize();
  return controller;
}