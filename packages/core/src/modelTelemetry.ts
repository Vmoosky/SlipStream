import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import type { CompressionEngine } from './engine.js';
import type { ModelObservation, ToolObservation } from './types.js';

export type { ModelObservation, ToolObservation } from './types.js';

const MODEL_ATTRIBUTES = new Set([
  'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.response.model',
  'gen_ai.conversation.id', 'copilot_chat.session_id', 'copilot_chat.chat_session_id',
  'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.output.messages', 'gen_ai.tool.call.id', 'gen_ai.tool.name',
]);

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, limit = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value)
    ? value : undefined;
}

function identifier(value: unknown, length: number): string | undefined {
  return typeof value === 'string' && value.length === length && /^[a-f\d]+$/i.test(value) && /[1-9a-f]/i.test(value)
    ? value.toLowerCase() : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{16,20}$/.test(value)) return undefined;
  const milliseconds = Number(BigInt(value) / 1_000_000n);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function responseToolCalls(value: unknown): ModelObservation['responseToolCalls'] {
  if (typeof value !== 'string' || value.length > 65_536) return undefined;
  try {
    const messages: unknown = JSON.parse(value);
    if (!Array.isArray(messages) || messages.length > 128) return undefined;
    const calls: NonNullable<ModelObservation['responseToolCalls']> = [];
    const ids = new Set<string>();
    for (const message of messages) {
      const { role, parts } = object(message);
      if (role !== 'assistant' || !Array.isArray(parts) || parts.length > 128) return undefined;
      for (const part of parts) {
        const call = object(part);
        if (call.type !== 'tool_call') continue;
        const id = text(call.id);
        const name = text(call.name);
        if (!id || !name || ids.has(id) || calls.length === 128) return undefined;
        ids.add(id);
        calls.push({ id, name });
      }
    }
    return calls.length ? calls : undefined;
  } catch {
    return undefined;
  }
}

function parseTelemetry(payload: unknown): { models: ModelObservation[]; tools: ToolObservation[] } {
  const observations: { models: ModelObservation[]; tools: ToolObservation[] } = { models: [], tools: [] };
  let visited = 0;
  for (const resource of items(object(payload).resourceSpans)) {
    for (const scope of items(object(resource).scopeSpans)) {
      for (const value of items(object(scope).spans)) {
        if (++visited > 1024) return observations;
        const span = object(value);
        const attributes = new Map<string, unknown>();
        for (const attribute of items(span.attributes).slice(0, 256)) {
          const entry = object(attribute);
          if (typeof entry.key !== 'string' || !MODEL_ATTRIBUTES.has(entry.key)) continue;
          const data = object(entry.value);
          attributes.set(entry.key, data.stringValue ?? data.intValue);
        }
        const operation = attributes.get('gen_ai.operation.name');
        if (operation !== 'chat' && operation !== 'execute_tool') continue;
        const traceId = identifier(span.traceId, 32);
        const spanId = identifier(span.spanId, 16);
        const startedAt = timestamp(span.startTimeUnixNano);
        const endedAt = timestamp(span.endTimeUnixNano);
        if (!traceId || !spanId || startedAt === undefined || endedAt === undefined || endedAt < startedAt) continue;
        const identity = {
          traceId, spanId,
          parentSpanId: identifier(span.parentSpanId, 16),
          conversationId: text(attributes.get('gen_ai.conversation.id')) ?? text(attributes.get('copilot_chat.session_id')),
          chatSessionId: text(attributes.get('copilot_chat.chat_session_id')),
          startedAt, endedAt,
        };
        if (operation === 'execute_tool') {
          const toolCallId = text(attributes.get('gen_ai.tool.call.id'));
          const toolName = text(attributes.get('gen_ai.tool.name'));
          if (toolCallId && toolName) observations.tools.push({
            ...identity, toolCallId, toolName, success: object(span.status).code === 1,
          });
          continue;
        }
        const provider = text(attributes.get('gen_ai.provider.name'));
        const requestModel = text(attributes.get('gen_ai.request.model'));
        if (!provider || !requestModel) continue;
        const tokens = (key: string): number | undefined => {
          const raw = attributes.get(key);
          if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d{1,12}$/.test(raw))) return undefined;
          const count = Number(raw);
          return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
        };
        observations.models.push({
          ...identity,
          provider, requestModel,
          responseModel: text(attributes.get('gen_ai.response.model')),
          responseToolCalls: responseToolCalls(attributes.get('gen_ai.output.messages')),
          inputTokens: tokens('gen_ai.usage.input_tokens'),
          outputTokens: tokens('gen_ai.usage.output_tokens'),
          cacheReadInputTokens: tokens('gen_ai.usage.cache_read.input_tokens'),
          cacheCreationInputTokens: tokens('gen_ai.usage.cache_creation.input_tokens'),
        });
      }
    }
  }
  return observations;
}

export function parseModelTelemetry(payload: unknown): ModelObservation[] {
  return parseTelemetry(payload).models;
}

export function parseToolTelemetry(payload: unknown): ToolObservation[] {
  return parseTelemetry(payload).tools;
}

/**
 * Which Copilot surface produced an observation. The receiver cannot infer this
 * from the export itself — VS Code and the CLI speak the same OTLP contract — so
 * the host that owns the receiver declares it. Defaults to `'Copilot Chat'` so
 * existing VS Code behaviour and history are unchanged.
 */
export const MODEL_OBSERVATION_SOURCE_LABELS = {
  vscode: 'Copilot Chat',
  cli: 'Copilot CLI',
} as const;

export type ModelObservationSource = keyof typeof MODEL_OBSERVATION_SOURCE_LABELS;

function alreadyRecorded(
  engine: CompressionEngine,
  observation: ModelObservation | ToolObservation,
  source: ModelObservationSource,
  kind: 'modelObservation' | 'toolObservation',
): boolean {
  const entries = engine.ledger.all();
  const previous = entries.find((entry) => {
    const recorded = entry.modelObservation ?? entry.toolObservation;
    const recordedSource = entry.telemetrySource ?? (entry.sessionLabel === MODEL_OBSERVATION_SOURCE_LABELS.cli ? 'cli' : 'vscode');
    return recordedSource === source && recorded?.traceId === observation.traceId && recorded.spanId === observation.spanId;
  });
  if (!previous) return false;
  if (JSON.stringify(previous[kind]) !== JSON.stringify(observation) && !entries.some((entry) => entry.telemetrySource === source
    && entry.telemetryConflict?.traceId === observation.traceId && entry.telemetryConflict.spanId === observation.spanId)) {
    engine.ledger.record({
      ts: observation.endedAt, sessionId: `copilot-otel:${observation.traceId}`,
      sessionLabel: MODEL_OBSERVATION_SOURCE_LABELS[source], telemetrySource: source,
      telemetryConflict: { traceId: observation.traceId, spanId: observation.spanId },
      tool: 'session', strategy: 'session:telemetry-conflict', outcomeReason: 'Session event', label: 'Conflicting telemetry',
      tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0, durationMs: 0,
    });
  }
  return true;
}

export function recordModelObservation(
  engine: CompressionEngine,
  observation: ModelObservation,
  source: ModelObservationSource = 'vscode',
): boolean {
  const id = observation.responseModel ?? observation.requestModel;
  const detectedModel = { id, vendor: observation.provider === 'github' ? 'copilot' : observation.provider, name: id };
  const modelObservation: ModelObservation = {
    traceId: observation.traceId, spanId: observation.spanId, parentSpanId: observation.parentSpanId,
    conversationId: observation.conversationId, chatSessionId: observation.chatSessionId,
    provider: observation.provider, requestModel: observation.requestModel, responseModel: observation.responseModel,
    responseToolCalls: observation.responseToolCalls?.map(({ id, name }) => ({ id, name })),
    startedAt: observation.startedAt, endedAt: observation.endedAt,
    inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
    cacheReadInputTokens: observation.cacheReadInputTokens, cacheCreationInputTokens: observation.cacheCreationInputTokens,
  };
  if (alreadyRecorded(engine, modelObservation, source, 'modelObservation')) return false;
  engine.ledger.record({
    ts: observation.endedAt,
    sessionId: `copilot-otel:${observation.conversationId ?? observation.chatSessionId ?? observation.traceId}`,
    sessionLabel: MODEL_OBSERVATION_SOURCE_LABELS[source],
    tool: 'session', strategy: 'session:model', outcomeReason: 'Session event',
    label: detectedModel.name, detectedModel, modelObservation, telemetrySource: source,
    pricing: engine.pricing.snapshot({ mode: 'automatic' }, 0, detectedModel),
    tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0, durationMs: 0,
  });
  return true;
}

export function recordToolObservation(
  engine: CompressionEngine,
  observation: ToolObservation,
  source: ModelObservationSource = 'vscode',
): boolean {
  const toolObservation: ToolObservation = {
    traceId: observation.traceId, spanId: observation.spanId, parentSpanId: observation.parentSpanId,
    conversationId: observation.conversationId, chatSessionId: observation.chatSessionId,
    startedAt: observation.startedAt, endedAt: observation.endedAt, success: observation.success,
    toolCallId: observation.toolCallId, toolName: observation.toolName,
  };
  if (alreadyRecorded(engine, toolObservation, source, 'toolObservation')) return false;
  engine.ledger.record({
    ts: observation.endedAt,
    sessionId: `copilot-otel:${observation.conversationId ?? observation.chatSessionId ?? observation.traceId}`,
    sessionLabel: MODEL_OBSERVATION_SOURCE_LABELS[source],
    tool: 'session', strategy: 'session:tool', outcomeReason: 'Session event',
    label: observation.toolName, toolObservation, telemetrySource: source,
    tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0, durationMs: 0,
  });
  return true;
}

/**
 * Privacy-preserving OpenTelemetry exporter settings that point a Copilot
 * process at a local Slipstream receiver.
 *
 * VS Code applies the equivalent values through `github.copilot.chat.otel.*`
 * profile settings (see the extension's model tracking controller). A CLI-only
 * install has no such settings, so the same contract is expressed as environment
 * variables that Copilot reads at process start. Both `COPILOT_OTEL_*` and the
 * standard `OTEL_EXPORTER_OTLP_*` names are emitted so whichever the running
 * Copilot build honours takes effect; the receiver only accepts exports carrying
 * the bearer credential, so unrelated exporters cannot reach it.
 *
 * Keep content capture off and the attribute cap small: even so, upstream may
 * still include prompt/tool material, which the receiver discards in memory
 * before recording only the allowlisted model, correlation, timing, and token
 * fields.
 */
export function managedTelemetryEnv(connection: { endpoint: string; token: string }): Record<string, string> {
  const header = `Authorization=Bearer ${connection.token}`;
  return {
    COPILOT_OTEL_ENABLED: 'true',
    COPILOT_OTEL_EXPORTER_TYPE: 'otlp-http',
    COPILOT_OTEL_PROTOCOL: 'http/json',
    COPILOT_OTEL_ENDPOINT: connection.endpoint,
    COPILOT_OTEL_HEADERS: header,
    COPILOT_OTEL_CAPTURE_CONTENT: 'false',
    COPILOT_OTEL_MAX_ATTRIBUTE_SIZE_CHARS: '256',
    OTEL_EXPORTER_OTLP_ENDPOINT: connection.endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_HEADERS: header,
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
  };
}

/**
 * Consent state for standalone (CLI-only) model tracking, read from the
 * `model-tracking.json` that `slipstream model-tracking` manages.
 *
 * `@slipstream/hook-runtime` owns the authoritative file shape; core depends on
 * core, not the other way round, so this reader deliberately extracts only the
 * two fields the dashboard needs. The bearer credential is **never** returned:
 * the dashboard runs in a browser, and the token is the only thing standing
 * between a local port and anything else on the machine. Users get the real
 * exporter block from `slipstream model-tracking env` in a terminal instead.
 */
export interface CliModelTrackingState {
  /** True once the user has explicitly opted in. Nothing is captured until then. */
  consented: boolean;
  /** Loopback port the daemon last bound the receiver to; 0 until first bind. */
  port: number;
}

export function readCliModelTrackingState(storageDir: string): CliModelTrackingState | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(storageDir, 'model-tracking.json'), 'utf8'),
    ) as Record<string, unknown> | null;
    if (!parsed || typeof parsed.consented !== 'boolean') return undefined;
    const port = typeof parsed.port === 'number' && Number.isInteger(parsed.port) ? parsed.port : 0;
    return { consented: parsed.consented, port };
  } catch {
    return undefined;
  }
}

export type ModelTelemetryRejectionReason = 'authorization' | 'origin' | 'host' | 'route' | 'protocol' | 'tooLarge' | 'malformed' | 'processing';
export interface ModelTelemetryHealth {
  startedAt: number;
  receivedExports: number;
  acceptedObservations: number;
  lastReceivedAt: number | null;
  lastAcceptedAt: number | null;
  rejectedExports: Record<ModelTelemetryRejectionReason, number>;
}

export interface ModelTelemetryReceiver {
  endpoint: string;
  token: string;
  getHealth(): ModelTelemetryHealth;
  close(): Promise<void>;
}

export async function startModelTelemetryReceiver(options: {
  onObservation: (observation: ModelObservation) => unknown;
  onToolObservation?: (observation: ToolObservation) => unknown;
  onHealthChange?: (health: ModelTelemetryHealth) => void;
  initialHealth?: ModelTelemetryHealth;
  token?: string;
  port?: number;
  maxBodyBytes?: number;
}): Promise<ModelTelemetryReceiver> {
  const token = options.token ?? randomBytes(32).toString('hex');
  if (!/^[a-f\d]{64}$/.test(token)) throw new Error('Invalid local telemetry credential.');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
  const seen = new Map<string, string>();
  const health: ModelTelemetryHealth = options.initialHealth
    ? { ...options.initialHealth, rejectedExports: { ...options.initialHealth.rejectedExports } }
    : {
      startedAt: Date.now(), receivedExports: 0, acceptedObservations: 0,
      lastReceivedAt: null, lastAcceptedAt: null,
      rejectedExports: { authorization: 0, origin: 0, host: 0, route: 0, protocol: 0, tooLarge: 0, malformed: 0, processing: 0 },
    };
  const getHealth = (): ModelTelemetryHealth => ({ ...health, rejectedExports: { ...health.rejectedExports } });
  const notifyHealth = (): void => {
    try { options.onHealthChange?.(getHealth()); } catch {}
  };
  let endpoint = '';
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    let healthChanged = false;
    const reply = (status: number, body = '{}', reason?: ModelTelemetryRejectionReason): void => {
      if (reason) {
        health.rejectedExports[reason]++;
        healthChanged = true;
      }
      response.writeHead(status);
      response.end(body);
      if (healthChanged) notifyHealth();
    };
    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (request.headers.origin !== undefined) {
      reply(403, '{}', 'origin');
      request.resume();
      return;
    }
    if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
      reply(403, '{}', 'authorization');
      request.resume();
      return;
    }
    if (request.headers.host !== new URL(endpoint).host) {
      reply(403, '{}', 'host');
      request.resume();
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      reply(200, '{"service":"slipstream-model-telemetry","version":1}');
      return;
    }
    if (request.method !== 'POST' || !['/v1/traces', '/v1/metrics', '/v1/logs'].includes(request.url ?? '')) {
      reply(404, '{}', 'route');
      request.resume();
      return;
    }
    health.receivedExports++;
    health.lastReceivedAt = Date.now();
    healthChanged = true;
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json' || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
      reply(415, '{}', 'protocol');
      request.resume();
      return;
    }
    let bytes = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        chunks.length = 0;
        if (!rejected) reply(413, '{}', 'tooLarge');
        rejected = true;
        return;
      }
      if (!rejected && request.url === '/v1/traces') chunks.push(chunk);
    });
    request.on('error', () => {
      chunks.length = 0;
      if (!rejected && !response.writableEnded) {
        rejected = true;
        health.rejectedExports.processing++;
        notifyHealth();
      }
    });
    request.on('end', () => {
      if (rejected) return;
      if (request.url !== '/v1/traces') {
        reply(200);
        return;
      }
      let observations: ReturnType<typeof parseTelemetry>;
      try {
        observations = parseTelemetry(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reply(400, '{}', 'malformed');
        return;
      } finally {
        chunks.length = 0;
      }
      try {
        for (const observation of observations.models) {
          const key = `${observation.traceId}:${observation.spanId}`;
          const fingerprint = JSON.stringify(observation);
          if (seen.get(key) === fingerprint) continue;
          if (options.onObservation(observation) === false) continue;
          if (!seen.has(key)) {
            health.acceptedObservations++;
            health.lastAcceptedAt = Date.now();
          }
          seen.set(key, fingerprint);
          if (seen.size > 4096) seen.delete(seen.keys().next().value!);
        }
        if (options.onToolObservation) for (const observation of observations.tools) {
          const key = `${observation.traceId}:${observation.spanId}`;
          const fingerprint = JSON.stringify(observation);
          if (seen.get(key) === fingerprint || options.onToolObservation(observation) === false) continue;
          seen.set(key, fingerprint);
          if (seen.size > 4096) seen.delete(seen.keys().next().value!);
        }
        reply(200);
      } catch {
        reply(503, '{}', 'processing');
      }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  server.maxConnections = 8;
  server.setTimeout(10_000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as { port: number };
      endpoint = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  server.unref();
  return {
    endpoint, token, getHealth,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
