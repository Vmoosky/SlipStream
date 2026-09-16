import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CompressionEngine } from '@slipstream/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const mocks = vi.hoisted(() => {
  const defaults: Record<string, unknown> = { enabled: false, captureContent: false, exporterType: 'otlp-http', protocol: '', otlpEndpoint: 'http://localhost:4318', headers: {}, outfile: '', 'dbSpanExporter.enabled': false, maxAttributeSizeChars: 0 };
  const values: Record<string, unknown> = {};
  const workspace: Record<string, unknown> = {};
  const policies: Record<string, unknown> = {};
  const configuration = {
    get: vi.fn((key: string) => policies[key] ?? workspace[key] ?? values[key] ?? defaults[key]),
    inspect: vi.fn((key: string) => ({ defaultValue: defaults[key], globalValue: values[key], workspaceValue: workspace[key], policyValue: policies[key] })),
    update: vi.fn(async (key: string, value: unknown) => { if (value === undefined) delete values[key]; else values[key] = value; }),
  };
  return { defaults, values, workspace, policies, configuration, api: {
    workspace: { isTrusted: true, getConfiguration: vi.fn(() => configuration), onDidGrantWorkspaceTrust: vi.fn(() => ({ dispose() {} })), onDidChangeConfiguration: vi.fn(() => ({ dispose() {} })) },
    extensions: { onDidChange: vi.fn(() => ({ dispose() {} })) },
    env: { remoteName: undefined as string | undefined },
    window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), registerUriHandler: vi.fn(() => ({ dispose() {} })) },
    commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose() {} })) }, ConfigurationTarget: { Global: 1 },
  } };
});
vi.mock('vscode', () => mocks.api);

import { ModelTrackingController, registerModelTracking } from '../src/modelTracking.js';

let root: string;
let engine: CompressionEngine;
let context: vscode.ExtensionContext;
let controller: ModelTrackingController;
let state: Map<string, unknown>;
let secrets: Map<string, string>;
const controllers: ModelTrackingController[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  for (const object of [mocks.values, mocks.workspace, mocks.policies]) for (const key of Object.keys(object)) delete object[key];
  mocks.api.workspace.isTrusted = true;
  mocks.api.env.remoteName = undefined;
  mocks.api.window.showWarningMessage.mockResolvedValue('Allow');
  mocks.api.window.showInformationMessage.mockResolvedValue('Later');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-tracking-'));
  engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
  state = new Map();
  secrets = new Map();
  context = {
    subscriptions: [],
    globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value); } },
    secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } },
    globalStorageUri: { fsPath: path.join(root, 'extension') },
  } as unknown as vscode.ExtensionContext;
  controller = new ModelTrackingController(context, engine, () => undefined, {});
  controllers.push(controller);
});

afterEach(async () => {
  for (const item of controllers.splice(0)) await item.dispose();
  engine.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('local model tracking consent and ownership', () => {
  it('requires existing consent, trust, and exporter ownership for tool correlation metadata', async () => {
    await controller.connect();
    const connection = state.get('modelTracking.connection.v1') as { phase: string };
    const send = (endedAt = Date.now()) => fetch(`${mocks.values.otlpEndpoint}/v1/traces`, {
      method: 'POST',
      headers: { ...(mocks.values.headers as Record<string, string>), 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
        traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
        startTimeUnixNano: String(BigInt(endedAt - 1000) * 1_000_000n),
        endTimeUnixNano: String(BigInt(endedAt) * 1_000_000n), status: { code: 1 },
        attributes: Object.entries({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.id': 'call-one',
          'gen_ai.tool.name': 'slipstream_readFile', 'gen_ai.tool.call.result': 'PRIVATE' })
          .map(([key, stringValue]) => ({ key, value: { stringValue } })),
      }] }] }] }),
    });
    mocks.api.workspace.isTrusted = false;
    expect((await send()).status).toBe(200);
    mocks.api.workspace.isTrusted = true;
    mocks.values.captureContent = true;
    expect((await send()).status).toBe(200);
    mocks.values.captureContent = false;
    connection.phase = 'installing';
    expect((await send()).status).toBe(200);
    connection.phase = 'connected';
    expect((await send(Date.now() + 120_000)).status).toBe(200);
    expect(engine.ledger.all()).toEqual([]);
    expect((await send()).status).toBe(200);
    expect(engine.ledger.all()).toHaveLength(1);
    expect(engine.ledger.all()[0]).toMatchObject({ tool: 'session', strategy: 'session:tool', telemetrySource: 'vscode',
      toolObservation: { toolCallId: 'call-one', toolName: 'slipstream_readFile' } });
    expect(controller.status().receiverHealth).toMatchObject({ receivedExports: 5, acceptedObservations: 0 });
    expect(JSON.stringify(engine.ledger.all())).not.toContain('PRIVATE');
  });

  it('publishes local health without recording rejected content or changing savings', async () => {
    const onChange = vi.fn();
    const monitored = new ModelTrackingController(context, engine, onChange, {});
    controllers.push(monitored);
    await monitored.connect();
    expect(monitored.status()).toMatchObject({
      receiverHealthScope: 'window', receiverHealth: { receivedExports: 0, acceptedObservations: 0, lastAcceptedAt: null },
    });
    const before = engine.summary();
    onChange.mockClear();
    const response = await fetch(`${mocks.values.otlpEndpoint}/v1/traces`, {
      method: 'POST', body: '{PRIVATE',
      headers: { ...(mocks.values.headers as Record<string, string>), 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(monitored.status().receiverHealth).toMatchObject({
      receivedExports: 1, acceptedObservations: 0, lastAcceptedAt: null, rejectedExports: { malformed: 1 },
    });
    expect(engine.summary()).toEqual(before);
    expect(engine.ledger.all()).toEqual([]);
    expect(JSON.stringify(monitored.status())).not.toContain('PRIVATE');
    expect(JSON.stringify(monitored.status())).not.toContain(String(mocks.values.otlpEndpoint));
    const snapshot = monitored.status();
    snapshot.receiverHealth!.rejectedExports.malformed = 99;
    expect(monitored.status().receiverHealth!.rejectedExports.malformed).toBe(1);
  });

  it('retains health across local receiver restarts without borrowing another window counts', async () => {
    await controller.connect();
    await fetch(`${mocks.values.otlpEndpoint}/v1/traces`, {
      method: 'POST', body: '{}',
      headers: { ...(mocks.values.headers as Record<string, string>), 'content-type': 'application/json' },
    });
    const health = controller.status().receiverHealth;
    expect(health?.receivedExports).toBe(1);
    mocks.api.workspace.isTrusted = false;
    await controller.refresh();
    mocks.api.workspace.isTrusted = true;
    await controller.refresh();
    expect(controller.status().receiverHealth).toEqual(health);
    const otherWindow = new ModelTrackingController(context, engine, () => undefined, {});
    controllers.push(otherWindow);
    await otherWindow.refresh();
    expect(otherWindow.status().receiverHealthScope).toBe('shared');
    expect(otherWindow.status().receiverHealth).toBeUndefined();
    await controller.dispose();
    await otherWindow.refresh();
    expect(otherWindow.status()).toMatchObject({
      receiverHealthScope: 'window', receiverHealth: { receivedExports: 0, acceptedObservations: 0, lastReceivedAt: null, lastAcceptedAt: null },
    });
  });

  it('keeps the reload requirement visible after consent and refresh', async () => {
    await controller.connect();
    expect(controller.status().state).toBe('connected');
    expect(controller.status().detail).toContain('Reload Window');
    await controller.refresh();
    expect(controller.status().detail).toContain('Reload Window');
  });

  it('waits for a completed call once the connection predates this host', async () => {
    await controller.connect();
    const connection = state.get('modelTracking.connection.v1') as Record<string, unknown>;
    state.set('modelTracking.connection.v1', {
      ...connection,
      updatedAt: Date.now() - process.uptime() * 1000 - 10_000,
    });
    const reloaded = new ModelTrackingController(context, engine, () => undefined, {});
    controllers.push(reloaded);
    await reloaded.refresh();
    expect(reloaded.status().state).toBe('connected');
    expect(reloaded.status().detail).not.toContain('Reload Window');
    expect(reloaded.status().detail).toContain('completed Copilot calls');
  });

  it('automatically offers consent despite Copilot internal null-device export', async () => {
    mocks.api.window.showWarningMessage.mockResolvedValue('Not Now');
    const environment = { COPILOT_OTEL_FILE_EXPORTER_PATH: os.devNull };
    const injected = new ModelTrackingController(context, engine, () => undefined, environment);
    controllers.push(injected);
    await injected.initialize();
    expect(injected.status().state).toBe('disconnected');
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(environment).toEqual({ COPILOT_OTEL_FILE_EXPORTER_PATH: os.devNull });
  });

  it.each(['verbatim', 'url-normalized'])('reconnects with a %s endpoint derived from the consented settings', async (format) => {
    await controller.connect();
    await controller.dispose();
    const environment = {
      COPILOT_OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: format === 'url-normalized' ? new URL(String(mocks.values.otlpEndpoint)).href : String(mocks.values.otlpEndpoint),
      COPILOT_OTEL_ENDPOINT: String(mocks.values.otlpEndpoint),
      COPILOT_OTEL_CAPTURE_CONTENT: 'false',
      COPILOT_OTEL_MAX_ATTRIBUTE_SIZE_CHARS: '256',
    };
    const originalEnvironment = { ...environment };
    mocks.configuration.update.mockClear();
    const restored = new ModelTrackingController(context, engine, () => undefined, environment);
    controllers.push(restored);
    await restored.refresh();
    expect(restored.status().state).toBe('connected');
    expect(environment).toEqual(originalEnvironment);
    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
    environment.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://another-exporter.example';
    await restored.refresh();
    expect(restored.status().state).toBe('blocked');
    expect(environment.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://another-exporter.example');
  });

  it.each(['COPILOT_OTEL_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT'])('blocks non-equivalent %s values without disclosing them', async (key) => {
    await controller.connect();
    const environment = { [key]: '' };
    const guarded = new ModelTrackingController(context, engine, () => undefined, environment);
    controllers.push(guarded);
    mocks.configuration.update.mockClear();
    const values = [
      { protocol: 'https:' }, { hostname: 'localhost' }, { port: '1' },
      { pathname: '/v1/traces' }, { search: '?key=PRIVATE' }, { hash: '#PRIVATE' }, { username: 'PRIVATE' },
    ].map((changes) => Object.assign(new URL(String(mocks.values.otlpEndpoint)), changes).href);
    for (const value of [...values, 'PRIVATE-not-a-url']) {
      environment[key] = value;
      await guarded.refresh();
      expect(guarded.status().state).toBe('blocked');
      expect(guarded.status().detail).toContain(key);
      expect(guarded.status().detail).not.toContain('PRIVATE');
      expect(environment[key]).toBe(value);
    }
    expect(mocks.configuration.update).not.toHaveBeenCalled();
  });

  it('still blocks real file exporters without disclosing their paths', async () => {
    const environment = { COPILOT_OTEL_FILE_EXPORTER_PATH: path.join(root, 'private-export.jsonl') };
    const external = new ModelTrackingController(context, engine, () => undefined, environment);
    controllers.push(external);
    await external.initialize();
    expect(external.status().state).toBe('blocked');
    expect(external.status().detail).not.toContain('private-export');
    expect(mocks.api.window.showWarningMessage).not.toHaveBeenCalled();
    expect(mocks.configuration.update).not.toHaveBeenCalled();
  });

  it.each([
    ['COPILOT_OTEL_CAPTURE_CONTENT', 'true'],
    ['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true'],
    ['COPILOT_OTEL_ENABLED', 'false'],
    ['OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=PRIVATE'],
  ])('blocks conflicting %s after consent without disclosing its value', async (key, value) => {
    await controller.connect();
    const guarded = new ModelTrackingController(context, engine, () => undefined, { [key]: value });
    controllers.push(guarded);
    await guarded.refresh();
    expect(guarded.status().state).toBe('blocked');
    expect(guarded.status().detail).toContain(key);
    expect(guarded.status().detail).not.toContain('PRIVATE');
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('automatically opens one startup prompt and waits for Allow before changing settings', async () => {
    let answer!: (choice: string) => void;
    let opened!: () => void;
    const shown = new Promise<void>((resolve) => { opened = resolve; });
    mocks.api.window.showWarningMessage.mockImplementationOnce(() => new Promise<string>((resolve) => {
      answer = resolve;
      opened();
    }));
    const initialized = controller.initialize();
    await shown;
    const refreshed = controller.refresh();
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(secrets.size).toBe(0);
    answer('Allow');
    await Promise.all([initialized, refreshed]);
    expect(controller.status().state).toBe('connected');
    expect(mocks.values.enabled).toBe(true);
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('automatically offers consent when Copilot becomes available after startup', async () => {
    const protocol = mocks.defaults.protocol;
    mocks.defaults.protocol = undefined;
    mocks.api.window.showWarningMessage.mockResolvedValue('Not Now');
    try {
      await controller.initialize();
      expect(controller.status().state).toBe('blocked');
      expect(mocks.api.window.showWarningMessage).not.toHaveBeenCalled();
      mocks.defaults.protocol = protocol;
      await controller.refresh();
      expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(mocks.api.window.showWarningMessage).toHaveBeenCalledWith('Allow local Copilot model tracking?', expect.objectContaining({ modal: true }), 'Allow', 'Not Now');
      expect(mocks.configuration.update).not.toHaveBeenCalled();
      await controller.refresh();
      expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
    } finally { mocks.defaults.protocol = protocol; }
  });

  it('registers connection commands and a URI that opens the dashboard without granting consent', async () => {
    mocks.api.window.showWarningMessage.mockResolvedValue('Not Now');
    state.set('modelTracking.offered.v1', true);
    const registered = registerModelTracking(context, engine, () => undefined);
    controllers.push(registered);
    await registered.refresh();
    expect(mocks.api.extensions.onDidChange).toHaveBeenCalledTimes(1);
    expect(mocks.api.commands.registerCommand.mock.calls.map((entry) => entry[0])).toEqual(['slipstream.connectModelTracking', 'slipstream.disconnectModelTracking']);
    const handler = mocks.api.window.registerUriHandler.mock.calls[0][0] as vscode.UriHandler;
    await handler.handleUri({ path: '/model-tracking' } as vscode.Uri);
    expect(mocks.api.commands.executeCommand).toHaveBeenCalledWith('slipstream.showDashboard');
    expect(mocks.configuration.update).not.toHaveBeenCalled();
  });

  it('requires explicit consent and never changes settings on decline', async () => {
    mocks.api.window.showWarningMessage.mockResolvedValue('Not Now');
    await controller.connect();
    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(secrets.size).toBe(0);
    expect(controller.status().state).toBe('disconnected');
    expect(mocks.api.window.showWarningMessage.mock.calls[0][1].detail).toContain('even with content capture off');
    await controller.initialize();
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('connects only to loopback with a generated credential and no automatic reload', async () => {
    await controller.connect();
    expect(controller.status().state).toBe('connected');
    expect(mocks.values.enabled).toBe(true);
    expect(mocks.values.otlpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(mocks.values.protocol).toBe('http/json');
    expect(mocks.values.captureContent).toBe(false);
    expect(mocks.values.maxAttributeSizeChars).toBe(256);
    expect((mocks.values.headers as Record<string, string>).Authorization).toMatch(/^Bearer [a-f\d]{64}$/);
    expect(JSON.stringify([...state.values()])).not.toContain((mocks.values.headers as Record<string, string>).Authorization);
    expect(mocks.api.commands.executeCommand).not.toHaveBeenCalled();
    expect(mocks.configuration.update.mock.calls.at(-1)?.[0]).toBe('enabled');
  });

  it('restores original settings and deletes its credential on disconnect', async () => {
    mocks.values.enabled = false;
    await controller.connect();
    await controller.disconnect();
    expect(mocks.values).toEqual({ enabled: false });
    expect(secrets.size).toBe(0);
    expect(state.has('modelTracking.connection.v1')).toBe(false);
    expect(controller.status().state).toBe('disconnected');
    await controller.refresh();
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('preserves later user edits and removes only its own authorization header', async () => {
    await controller.connect();
    mocks.values.otlpEndpoint = 'https://user.example/otel';
    (mocks.values.headers as Record<string, string>).Custom = 'user-value';
    await controller.refresh();
    expect(controller.status().state).toBe('blocked');
    await controller.disconnect();
    expect(mocks.values).toEqual({ otlpEndpoint: 'https://user.example/otel', headers: { Custom: 'user-value' } });
  });

  it('does not replace existing exporters, workspace overrides, or managed settings', async () => {
    for (const settings of [mocks.values, mocks.workspace, mocks.policies]) {
      settings.enabled = true;
      await controller.connect();
      expect(controller.status().state).toBe('blocked');
      delete settings.enabled;
    }
    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(mocks.api.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('refuses untrusted workspaces, remote hosts, and environment overrides', async () => {
    mocks.api.workspace.isTrusted = false;
    await controller.connect();
    mocks.api.workspace.isTrusted = true;
    mocks.api.env.remoteName = 'ssh-remote';
    await controller.connect();
    mocks.api.env.remoteName = undefined;
    const configured = new ModelTrackingController(context, engine, () => undefined, { COPILOT_OTEL_ENDPOINT: 'https://managed.example' });
    controllers.push(configured);
    await configured.connect();
    expect(configured.status().state).toBe('blocked');
    expect(mocks.configuration.update).not.toHaveBeenCalled();
    expect(mocks.api.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('rolls back a partial setup when settings updates fail', async () => {
    mocks.configuration.update.mockRejectedValueOnce(new Error('Cannot update settings'));
    await controller.connect();
    expect(controller.status().state).toBe('error');
    expect(mocks.values).toEqual({});
    expect(state.has('modelTracking.connection.v1')).toBe(false);
    expect(secrets.size).toBe(0);
  });

  it('shares a receiver across windows and takes over after the owning window closes', async () => {
    await controller.connect();
    const endpoint = mocks.values.otlpEndpoint;
    const other = new ModelTrackingController(context, engine, () => undefined, {});
    controllers.push(other);
    await other.refresh();
    expect(other.status().state).toBe('connected');
    await controller.dispose();
    await other.refresh();
    expect(other.status().state).toBe('connected');
    expect(mocks.values.otlpEndpoint).toBe(endpoint);
    expect(mocks.api.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('recovers the owned local credential for cleanup if secret storage was cleared', async () => {
    await controller.connect();
    secrets.clear();
    await controller.disconnect();
    expect(mocks.values).toEqual({});
    expect(controller.status().state).toBe('disconnected');
  });

  it('does not send credentials to an invalid saved endpoint', async () => {
    await controller.connect();
    const saved = state.get('modelTracking.connection.v1') as { endpoint: string };
    saved.endpoint = 'https://external.example';
    await controller.refresh();
    expect(controller.status().state).toBe('error');
  });
});