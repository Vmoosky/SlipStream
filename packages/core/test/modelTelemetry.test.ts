import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CompressionEngine } from '../src/engine.js';
import { buildSummaryPayload } from '../src/dashboard.js';
import { managedTelemetryEnv, parseModelTelemetry, recordModelObservation, startModelTelemetryReceiver, type ModelObservation, type ModelTelemetryReceiver } from '../src/modelTelemetry.js';

function span(attributes: Record<string, string | number> = {}, overrides: Record<string, unknown> = {}) {
  return {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
    startTimeUnixNano: '1789202408000000000', endTimeUnixNano: '1789202409000000000',
    attributes: Object.entries({
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
      'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'gpt-5.4',
      'gen_ai.conversation.id': 'conversation-one',
      'copilot_chat.chat_session_id': 'chat-one',
      'gen_ai.usage.input_tokens': '1000', 'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 500,
      ...attributes,
    }).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: value } : { stringValue: value } })),
    ...overrides,
  };
}

function batch(...spans: unknown[]) {
  return { resourceSpans: [{ resource: { attributes: [{ key: 'authorization', value: { stringValue: 'PRIVATE' } }] }, scopeSpans: [{ spans }] }] };
}

describe('model telemetry metadata boundary', () => {
  it('retains exact per-call model, session, timing, and usage without content', () => {
    const result = parseModelTelemetry(batch(span({
      'gen_ai.input.messages': 'PRIVATE', 'gen_ai.output.messages': 'PRIVATE',
      'gen_ai.tool.call.arguments': 'PRIVATE', 'gen_ai.tool.call.result': 'PRIVATE',
      'copilot_chat.hook_input': 'PRIVATE', 'github.copilot.git.repository': 'PRIVATE',
    }, { name: 'PRIVATE', events: [{ body: 'PRIVATE' }], status: { message: 'PRIVATE' } })));
    expect(result).toEqual([{
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
      conversationId: 'conversation-one', chatSessionId: 'chat-one',
      provider: 'github', requestModel: 'auto', responseModel: 'gpt-5.4',
      startedAt: 1789202408000, endedAt: 1789202409000,
      inputTokens: 1000, outputTokens: 20, cacheReadInputTokens: 500, cacheCreationInputTokens: undefined,
    }]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('ignores agent, tool, hook, and log payloads', () => {
    expect(parseModelTelemetry(batch(
      span({ 'gen_ai.operation.name': 'invoke_agent' }),
      span({ 'gen_ai.operation.name': 'execute_tool' }),
      span({ 'gen_ai.operation.name': 'execute_hook' }),
    ))).toEqual([]);
    expect(parseModelTelemetry({ resourceLogs: [{ body: 'PRIVATE' }] })).toEqual([]);
  });

  it('rejects invalid identities and incomplete spans without throwing', () => {
    for (const value of [null, {}, [], 'PRIVATE', { resourceSpans: [null, 1, {}] }]) expect(parseModelTelemetry(value)).toEqual([]);
    expect(parseModelTelemetry(batch(
      span({}, { traceId: '0'.repeat(32) }), span({}, { spanId: 'invalid' }),
      span({}, { endTimeUnixNano: undefined }), span({}, { endTimeUnixNano: '1789202407000000000' }),
      span({ 'gen_ai.request.model': 'model\nPRIVATE' }), span({ 'gen_ai.provider.name': '' }),
    ))).toEqual([]);
  });

  it('does not coerce invalid usage into zero or allow negative counts', () => {
    const [result] = parseModelTelemetry(batch(span({
      'gen_ai.usage.input_tokens': '', 'gen_ai.usage.output_tokens': -1,
      'gen_ai.usage.cache_read.input_tokens': '1.5', 'gen_ai.usage.cache_creation.input_tokens': '0',
    })));
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.cacheReadInputTokens).toBeUndefined();
    expect(result.cacheCreationInputTokens).toBe(0);
  });

  it('bounds batch processing', () => {
    expect(parseModelTelemetry(batch(...Array.from({ length: 1100 }, () => span())))).toHaveLength(1024);
  });
});

describe('managed telemetry environment', () => {
  it('exposes content-off exporter variables carrying the loopback endpoint and credential', () => {
    const token = 'a'.repeat(64);
    const env = managedTelemetryEnv({ endpoint: 'http://127.0.0.1:7350', token });
    expect(env.COPILOT_OTEL_ENABLED).toBe('true');
    expect(env.COPILOT_OTEL_ENDPOINT).toBe('http://127.0.0.1:7350');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://127.0.0.1:7350');
    expect(env.COPILOT_OTEL_HEADERS).toBe(`Authorization=Bearer ${token}`);
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Bearer ${token}`);
    expect(env.COPILOT_OTEL_CAPTURE_CONTENT).toBe('false');
    expect(env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT).toBe('false');
    expect(env.COPILOT_OTEL_MAX_ATTRIBUTE_SIZE_CHARS).toBe('256');
  });
});

describe('local telemetry receiver', () => {
  let receiver: ModelTelemetryReceiver | undefined;
  afterEach(async () => { await receiver?.close(); receiver = undefined; });

  it('accepts authenticated loopback exports and suppresses retried spans', async () => {
    const received: ModelObservation[] = [];
    const before = Date.now();
    receiver = await startModelTelemetryReceiver({ onObservation: (observation) => received.push(observation) });
    expect(receiver.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(receiver.getHealth()).toMatchObject({ receivedExports: 0, acceptedObservations: 0, lastReceivedAt: null, lastAcceptedAt: null });
    const body = JSON.stringify(batch(span({ 'gen_ai.input.messages': 'PRIVATE' })));
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${receiver.endpoint}/v1/traces`, {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${receiver.token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    }
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received)).not.toContain('PRIVATE');
    const health = receiver.getHealth();
    expect(health).toMatchObject({ receivedExports: 2, acceptedObservations: 1 });
    expect(health.lastAcceptedAt).toBeGreaterThanOrEqual(before);
    expect(health.lastAcceptedAt).not.toBe(received[0].endedAt);
    expect(JSON.stringify(health)).not.toContain('PRIVATE');
    expect(JSON.stringify(health)).not.toContain(receiver.token);
    health.rejectedExports.authorization = 99;
    expect(receiver.getHealth().rejectedExports.authorization).toBe(0);
  });

  it('rejects unauthenticated, cross-origin, and wrong-host requests', async () => {
    const received: ModelObservation[] = [];
    receiver = await startModelTelemetryReceiver({ onObservation: (observation) => received.push(observation) });
    for (const headers of [
      {}, { authorization: 'Bearer wrong' },
      { authorization: `Bearer ${receiver.token}`, origin: 'https://example.com' },
    ]) {
      const response = await fetch(`${receiver.endpoint}/v1/traces`, { method: 'POST', body: JSON.stringify(batch(span())), headers });
      expect(response.status).toBe(403);
    }
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.request(`${receiver!.endpoint}/v1/traces`, {
        method: 'POST', headers: { authorization: `Bearer ${receiver!.token}`, host: 'example.com' },
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    expect(wrongHostStatus).toBe(403);
    expect(received).toEqual([]);
    expect(receiver.getHealth()).toMatchObject({
      receivedExports: 0, acceptedObservations: 0, lastReceivedAt: null, lastAcceptedAt: null,
      rejectedExports: { authorization: 2, origin: 1, host: 1 },
    });
  });

  it('bounds bodies, rejects malformed JSON, and drops metrics and logs', async () => {
    const received: ModelObservation[] = [];
    receiver = await startModelTelemetryReceiver({ onObservation: (observation) => received.push(observation), maxBodyBytes: 64 });
    const headers = { authorization: `Bearer ${receiver.token}`, 'content-type': 'application/json' };
    expect((await fetch(`${receiver.endpoint}/v1/traces`, { method: 'POST', headers, body: 'x'.repeat(65) })).status).toBe(413);
    expect((await fetch(`${receiver.endpoint}/v1/traces`, { method: 'POST', headers, body: '{PRIVATE' })).status).toBe(400);
    for (const kind of ['logs', 'metrics']) {
      expect((await fetch(`${receiver.endpoint}/v1/${kind}`, { method: 'POST', headers, body: '{"body":"PRIVATE"}' })).status).toBe(200);
    }
    expect(received).toEqual([]);
    expect(receiver.getHealth()).toMatchObject({
      receivedExports: 4, acceptedObservations: 0, lastAcceptedAt: null,
      rejectedExports: { tooLarge: 1, malformed: 1 },
    });
  });

  it('reports authenticated health and rejects other wire protocols', async () => {
    receiver = await startModelTelemetryReceiver({ onObservation: () => undefined });
    const headers = { authorization: `Bearer ${receiver.token}` };
    expect(await (await fetch(`${receiver.endpoint}/health`, { headers })).json()).toEqual({ service: 'slipstream-model-telemetry', version: 1 });
    expect(receiver.getHealth()).toMatchObject({ receivedExports: 0, lastReceivedAt: null });
    expect((await fetch(`${receiver.endpoint}/v1/traces`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-protobuf' }, body: 'PRIVATE' })).status).toBe(415);
    expect((await fetch(`${receiver.endpoint}/other`, { method: 'POST', headers, body: 'PRIVATE' })).status).toBe(404);
    expect(receiver.getHealth()).toMatchObject({ receivedExports: 1, acceptedObservations: 0, rejectedExports: { protocol: 1, route: 1 } });
  });

  it('publishes count-only health when an export is interrupted', async () => {
    let updates = 0;
    receiver = await startModelTelemetryReceiver({ onObservation: () => undefined, onHealthChange: () => { updates++; } });
    const request = http.request(`${receiver.endpoint}/v1/traces`, {
      method: 'POST', headers: { authorization: `Bearer ${receiver.token}`, 'content-type': 'application/json', 'content-length': 1024 },
    });
    request.on('error', () => undefined);
    request.write('{PRIVATE');
    await expect.poll(() => receiver!.getHealth().receivedExports).toBe(1);
    request.destroy();
    await expect.poll(() => updates).toBe(1);
    expect(receiver.getHealth()).toMatchObject({ receivedExports: 1, acceptedObservations: 0, lastAcceptedAt: null, rejectedExports: { processing: 1 } });
    expect(JSON.stringify(receiver.getHealth())).not.toContain('PRIVATE');
  });

  it('does not count observations declined by the host as accepted', async () => {
    let accept = false;
    receiver = await startModelTelemetryReceiver({ onObservation: () => accept });
    const send = () => fetch(`${receiver!.endpoint}/v1/traces`, {
      method: 'POST', body: JSON.stringify(batch(span())),
      headers: { authorization: `Bearer ${receiver!.token}`, 'content-type': 'application/json' },
    });
    expect((await send()).status).toBe(200);
    expect(receiver.getHealth()).toMatchObject({ receivedExports: 1, acceptedObservations: 0, lastAcceptedAt: null });
    accept = true;
    expect((await send()).status).toBe(200);
    expect(receiver.getHealth()).toMatchObject({ receivedExports: 2, acceptedObservations: 1 });
  });

  it('preserves health across receiver restarts and isolates health listeners', async () => {
    receiver = await startModelTelemetryReceiver({ onObservation: () => { throw new Error('PRIVATE'); } });
    const response = await fetch(`${receiver.endpoint}/v1/traces`, {
      method: 'POST', body: JSON.stringify(batch(span())),
      headers: { authorization: `Bearer ${receiver.token}`, 'content-type': 'application/json' },
    });
    expect(response.status).toBe(503);
    const initialHealth = receiver.getHealth();
    expect(initialHealth).toMatchObject({ receivedExports: 1, acceptedObservations: 0, lastAcceptedAt: null, rejectedExports: { processing: 1 } });
    await receiver.close();
    receiver = await startModelTelemetryReceiver({
      initialHealth, onObservation: () => undefined,
      onHealthChange: (health) => { health.rejectedExports.processing = 99; throw new Error('PRIVATE'); },
    });
    expect(receiver.getHealth()).toEqual(initialHealth);
    expect((await fetch(`${receiver.endpoint}/v1/traces`, {
      method: 'POST', body: JSON.stringify(batch(span())),
      headers: { authorization: `Bearer ${receiver.token}`, 'content-type': 'application/json' },
    })).status).toBe(200);
    expect(receiver.getHealth()).toMatchObject({ receivedExports: 2, acceptedObservations: 1, rejectedExports: { processing: 1 } });
    expect(initialHealth.acceptedObservations).toBe(0);
    expect(JSON.stringify(receiver.getHealth())).not.toContain('PRIVATE');
  });
});

describe('observed model accounting', () => {
  it('preserves history, separates concurrent conversations, and never prices unrelated compressions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-telemetry-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } } });
    try {
      engine.ledger.record({ ts: 1, tool: 'read_file', label: 'existing', strategy: 'code', tokensBefore: 100, tokensAfter: 20, bytesBefore: 100, bytesAfter: 20, linesBefore: 10, linesAfter: 2 });
      const before = engine.summary();
      const originalEntry = engine.ledger.all()[0];
      const [first] = parseModelTelemetry(batch(span({ 'gen_ai.input.messages': 'PRIVATE' })));
      const [second] = parseModelTelemetry(batch(span({ 'gen_ai.conversation.id': 'conversation-two', 'gen_ai.response.model': 'claude-opus-4-6' }, { spanId: 'd'.repeat(16) })));
      expect(recordModelObservation(engine, Object.assign(first, { unexpected: 'PRIVATE' }))).toBe(true);
      expect(recordModelObservation(engine, second)).toBe(true);
      expect(recordModelObservation(engine, first)).toBe(false);
      const entries = engine.ledger.all();
      expect(entries).toHaveLength(3);
      expect(entries[1].detectedModel).toEqual({ id: 'gpt-5.4', name: 'gpt-5.4', vendor: 'copilot' });
      expect(entries[2].sessionId).toBe('copilot-otel:conversation-two');
      expect(entries[0]).toEqual(originalEntry);
      expect(engine.summary()).toEqual(before);
      expect(JSON.stringify(engine.getPricingSnapshot())).not.toContain('gpt-5.4');
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).not.toContain('PRIVATE');
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let a small background call hijack the headline model', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-headline-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } } });
    try {
      // A real turn carrying a full context, then Copilot's internal
      // housekeeping call. The background call lands *last* and carries the
      // same conversation id, so scope alone cannot separate them.
      const [real] = parseModelTelemetry(batch(span({
        'gen_ai.response.model': 'gpt-6-astra',
        'gen_ai.usage.input_tokens': '140000',
      })));
      const [background] = parseModelTelemetry(batch(span({
        'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
        'gen_ai.usage.input_tokens': '1500',
      }, { spanId: 'e'.repeat(16), endTimeUnixNano: '1789202410000000000' })));
      expect(recordModelObservation(engine, real)).toBe(true);
      expect(recordModelObservation(engine, background)).toBe(true);

      // Both are chat-scoped and the mini call is the most recent, so a
      // recency-only pick would report it.
      const entries = engine.ledger.all();
      expect(entries[entries.length - 1].detectedModel?.id).toBe('gpt-4o-mini-2024-07-18');

      expect(buildSummaryPayload(engine).pricingSnapshot.detectedModel?.id).toBe('gpt-6-astra');
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still reports a small model when the whole conversation is small', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-headline-small-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } } });
    try {
      // Nothing here establishes a large context, so the guard must not invent
      // one and suppress a genuinely short session's model.
      const [only] = parseModelTelemetry(batch(span({
        'gen_ai.response.model': 'gpt-4o-mini-2024-07-18',
        'gen_ai.usage.input_tokens': '1500',
      })));
      expect(recordModelObservation(engine, only)).toBe(true);
      expect(buildSummaryPayload(engine).pricingSnapshot.detectedModel?.id).toBe('gpt-4o-mini-2024-07-18');
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('attributes observations to the surface that produced them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-source-label-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } } });
    try {
      // VS Code and the CLI export the same OTLP payload, so the receiver
      // cannot infer the surface — the host must declare it. Without this the
      // dashboard shows CLI traffic as "Copilot Chat" and the two producers
      // are indistinguishable.
      const [fromVscode] = parseModelTelemetry(batch(span()));
      const [fromCli] = parseModelTelemetry(batch(span({}, { spanId: 'f'.repeat(16) })));

      expect(recordModelObservation(engine, fromVscode)).toBe(true);
      expect(recordModelObservation(engine, fromCli, 'cli')).toBe(true);

      const labels = engine.ledger.all().map((entry) => entry.sessionLabel);
      expect(labels).toEqual(['Copilot Chat', 'Copilot CLI']);

      // The label must also reach the dashboard, otherwise the two producers
      // are still indistinguishable in the one table that lists model calls.
      // Observations are returned most-recent-first.
      const observations = buildSummaryPayload(engine).modelObservations;
      expect(observations.map((item) => item.source)).toEqual(['cli', 'vscode']);
      expect(observations.every((item) => item.scope === 'chat')).toBe(true);
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('tells a CLI-only dashboard how to switch tracking on', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-tracking-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      // A first-time CLI user has no state file at all. That is precisely the
      // case that must still report "off" rather than falling through to the
      // VS Code copy, which is a dead end without the extension.
      expect(buildSummaryPayload(engine).cliModelTracking).toEqual({ consented: false, port: 0 });

      fs.writeFileSync(
        path.join(root, 'model-tracking.json'),
        JSON.stringify({ version: 1, consented: true, port: 52969, token: 'a'.repeat(64) }),
      );
      const enabled = buildSummaryPayload(engine).cliModelTracking;
      expect(enabled).toEqual({ consented: true, port: 52969 });
      // The credential guards a loopback port; it must never reach the browser.
      expect(JSON.stringify(enabled)).not.toContain('a'.repeat(64));
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('defers to VS Code when the extension is driving tracking', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-vscode-tracking-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      fs.writeFileSync(
        path.join(root, 'model-tracking.json'),
        JSON.stringify({ version: 1, consented: true, port: 52969, token: 'a'.repeat(64) }),
      );
      const payload = buildSummaryPayload(engine, {
        viewerConnections: 0,
        modelTracking: { state: 'connected', detail: 'Connected', canConnect: false, canDisconnect: true },
      });
      expect(payload.cliModelTracking).toBeUndefined();
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
