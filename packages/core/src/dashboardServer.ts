import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import {
  buildCurrentBaseline,
  buildDetailPayload,
  buildModelPayload,
  buildSummaryPayload,
  renderDashboardHtml,
  renderDashboardReportCsv,
  renderDashboardReportJson,
  renderDashboardReportMarkdown,
  type DashboardCostPolicyControls,
  type DashboardModelTrackingControls,
  type DashboardServerStatus,
} from './dashboard.js';
import type { CompressionEngine, EngineConfig } from './engine.js';
import { isCompressionProfile } from './compressionProfiles.js';
import { runHealthReport } from './health.js';
import { validRate } from './pricing.js';
import { validateCostPolicy, type CostPolicy } from './costPolicy.js';
import { parsePolicyRecommendationRequest, type PolicyRecommendationRequest } from './ownedPolicy.js';

export interface DashboardServerOptions {
  /** Preferred port. Falls back to an ephemeral port if it stays taken. */
  port?: number;
  /**
   * How long to keep retrying the preferred port before giving up on it. A
   * reloading extension host holds the old port for a moment, and silently
   * moving to a random port breaks the readable URL people have open.
   */
  portRetryMs?: number;
  /** Optional access token. Defaults off so the local demo URL stays readable. */
  token?: string;
  /** Persist or mirror validated config changes made from the dashboard. */
  onConfigChanged?: (config: EngineConfig, overrides: Partial<EngineConfig>) => void | Promise<void>;
  modelTracking?: DashboardModelTrackingControls;
  costPolicy?: DashboardCostPolicyControls;
  onManageModelTracking?: () => string | Promise<string>;
}

export interface DashboardServerHandle {
  /** Full local URL. Readable by default, tokenized only when one is configured. */
  url: string;
  port: number;
  token?: string;
  /** False when the preferred port stayed taken and a random one was used. */
  usedPreferredPort: boolean;
  notify(): void;
  close(): Promise<void>;
}

interface DashboardEventHub {
  connect(request: http.IncomingMessage, response: http.ServerResponse): void;
  notify(): void;
  status(): DashboardServerStatus;
  close(): void;
}

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7331;

/** Constant-time compare so the token cannot be recovered by timing requests. */
function tokenMatches(expected: string, received: string | null): boolean {
  if (received === null) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Reject requests whose Host header is not loopback.
 *
 * Without this a page on any website could point a hostname it controls at
 * 127.0.0.1 and read this server's responses from the browser, since to the
 * browser they would be same-origin. The token alone would not stop that,
 * because the attacker only needs the victim to have the URL open once.
 */
function hostIsLoopback(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const allowed = [
    `${HOST}:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    HOST,
    'localhost',
    '[::1]',
  ];
  return allowed.includes(host.toLowerCase());
}

function originIsLoopback(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && Number(parsed.port || port) === port;
  } catch {
    return false;
  }
}

function send(
  response: http.ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: http.OutgoingHttpHeaders = {},
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    // The dashboard shows tool output; none of it should be cached or leaked.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Deliberately no access-control-allow-origin: nothing may read this
    // cross-origin, so a hostile page cannot exfiltrate command output.
    ...extraHeaders,
  });
  response.end(body);
}

/**
 * Serve the savings dashboard on loopback.
 *
 * The dashboard exposes raw command output and file contents, so access is
 * restricted by binding to 127.0.0.1 only, validating the Host header is
 * loopback, and refusing cross-origin reads. A token can be configured by a
 * caller that wants a hardened URL, but the default demo URL is readable.
 */
export async function startDashboardServer(
  engine: CompressionEngine,
  options: DashboardServerOptions = {},
): Promise<DashboardServerHandle> {
  const token = options.token;
  const events = createDashboardEventHub(engine, options);

  const server = http.createServer((request, response) => {
    void handleRequest(engine, options, events, server, request, response).catch((error: unknown) => {
      send(
        response,
        500,
        'application/json',
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
    });
  });

  // Idle sockets should not keep the process alive.
  server.unref?.();

  const preferred = options.port ?? DEFAULT_PORT;
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = Date.now() + (options.portRetryMs ?? 4000);
    let retry: NodeJS.Timeout | undefined;

    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE' && preferred !== 0) {
        // Usually the previous extension host still holds the port for a
        // moment. Keep retrying so the readable URL survives a reload, and
        // only take a random port once it is clear someone else owns it.
        if (Date.now() < deadline) {
          retry = setTimeout(() => server.listen(preferred, HOST), 150);
          retry.unref?.();
          return;
        }
        server.listen(0, HOST);
        return;
      }
      reject(error);
    };

    server.on('error', onError);
    server.on('listening', () => {
      server.off('error', onError);
      if (retry) clearTimeout(retry);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : preferred);
    });
    server.listen(preferred, HOST);
  });

  return {
    url: token ? `http://localhost:${port}/?t=${token}` : `http://localhost:${port}/`,
    port,
    token,
    usedPreferredPort: port === preferred,
    notify: events.notify,
    close: () =>
      new Promise<void>((resolve) => {
        events.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function createDashboardEventHub(engine: CompressionEngine, options: DashboardServerOptions): DashboardEventHub {
  const clients = new Set<http.ServerResponse>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let lastPayload = '';

  const sendEvent = (response: http.ServerResponse, event: string, data: string): void => {
    response.write(`event: ${event}\n`);
    response.write(`data: ${data.replace(/\n/g, '\\n')}\n\n`);
  };

  const status = (): DashboardServerStatus => ({
    viewerConnections: clients.size,
    modelTracking: options.modelTracking?.status(),
    canManageModelTracking: !!options.onManageModelTracking,
    canEditCostPolicy: options.costPolicy?.canEdit() === true,
    canRecommendModels: options.costPolicy?.canEdit() === true && !!options.costPolicy.recommend,
    canListPolicyModels: options.costPolicy?.canEdit() === true && !!options.costPolicy.listModels,
  });
  const snapshot = (): string => JSON.stringify(buildSummaryPayload(engine, status()));

  const broadcast = (): void => {
    if (closed || clients.size === 0) return;
    const next = snapshot();
    if (next === lastPayload) return;
    lastPayload = next;
    for (const client of clients) {
      sendEvent(client, 'summary', next);
    }
  };

  const schedule = (): void => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      broadcast();
    }, 50);
    timer.unref?.();
  };

  const unlisten = engine.ledger.onRecord(schedule);
  const unprice = engine.pricing.onChange(schedule);
  const unwatch = watchLedgerChanges(engine.ledger.path(), schedule);
  heartbeat = setInterval(() => {
    if (closed) return;
    for (const client of clients) {
      sendEvent(client, 'heartbeat', JSON.stringify({ ts: Date.now() }));
    }
  }, 10_000);
  heartbeat.unref?.();

  return {
    connect(request, response) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-accel-buffering': 'no',
      });
      clients.add(response);
      const initial = snapshot();
      lastPayload = initial;
      sendEvent(response, 'summary', initial);

      request.on('close', () => {
        clients.delete(response);
      });
    },
    notify: schedule,
    status,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      unlisten();
      unprice();
      unwatch();
      for (const client of clients) {
        client.end();
      }
      clients.clear();
    },
  };
}

export function watchLedgerChanges(filePath: string, onChange: () => void): () => void {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, (_event, changed) => {
      if (!changed || changed.toString() === fileName) {
        onChange();
      }
    });
    watcher.on('error', () => watcher.close());
    watcher.unref?.();
    return () => watcher.close();
  } catch {
    return () => undefined;
  }
}

async function handleRequest(
  engine: CompressionEngine,
  options: DashboardServerOptions,
  events: DashboardEventHub,
  server: http.Server,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const token = options.token;
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!hostIsLoopback(request.headers.host, port)) {
    send(response, 403, 'text/plain; charset=utf-8', 'Forbidden');
    return;
  }

  const url = new URL(request.url ?? '/', `http://${HOST}:${port}`);
  if (token && !tokenMatches(token, url.searchParams.get('t'))) {
    send(response, 401, 'text/plain; charset=utf-8', 'Missing or invalid token');
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/model-tracking') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    let action: unknown;
    try { action = (JSON.parse(await readRequestBody(request)) as { action?: unknown }).action; } catch { action = undefined; }
    if (action === 'manage') {
      if (!options.onManageModelTracking) {
        send(response, 501, 'application/json', JSON.stringify({ error: 'Open Slipstream: Show Savings Dashboard from the VS Code Command Palette.' }));
        return;
      }
      const dashboardUrl = new URL(await options.onManageModelTracking());
      if (dashboardUrl.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(dashboardUrl.hostname)
        || dashboardUrl.username || dashboardUrl.password || dashboardUrl.pathname !== '/' || dashboardUrl.hash) {
        throw new Error('Model tracking requires a local HTTP dashboard URL.');
      }
      send(response, 200, 'application/json', JSON.stringify({ dashboardUrl: dashboardUrl.href }));
      return;
    }
    if (action !== 'connect' && action !== 'disconnect') {
      send(response, 400, 'application/json', JSON.stringify({ error: 'Invalid model tracking action.' }));
      return;
    }
    if (!options.modelTracking) {
      send(response, 501, 'application/json', JSON.stringify({ error: 'Model tracking is managed in VS Code.' }));
      return;
    }
    await options.modelTracking[action]();
    send(response, 200, 'application/json', JSON.stringify(buildSummaryPayload(engine, events.status())));
    events.notify();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/pricing/refresh') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    request.resume();
    await engine.pricing.refresh(true);
    send(response, 200, 'application/json', JSON.stringify(buildSummaryPayload(engine, events.status())));
    events.notify();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/model-recommendation') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    if (!options.costPolicy?.canEdit() || !options.costPolicy.recommend) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Model recommendations require an available, trusted VS Code host.' }));
      return;
    }
    let query: ReturnType<typeof parseModelRecommendationRequest>;
    try { query = parseModelRecommendationRequest(JSON.parse(await readRequestBody(request))); }
    catch {
      send(response, 400, 'application/json', JSON.stringify({ error: 'Invalid recommendation inputs or policy revision.' }));
      return;
    }
    if (query.expectedRevision !== engine.getCostPolicyAssessment().policyRevision) {
      send(response, 409, 'application/json', JSON.stringify({ error: 'Cost policy changed. Compare against the saved policy again.' }));
      return;
    }
    try {
      const result = await options.costPolicy.recommend(query.request, query.expectedRevision);
      if (!options.costPolicy.canEdit() || query.expectedRevision !== engine.getCostPolicyAssessment().policyRevision) throw new Error('Policy changed.');
      send(response, 200, 'application/json', JSON.stringify({ result, policyRevision: query.expectedRevision }));
    } catch {
      send(response, 409, 'application/json', JSON.stringify({ error: 'Recommendation unavailable. Check workspace access and the saved policy.' }));
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/cost-policy') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    if (!options.costPolicy?.canEdit()) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Policy editing requires an open, trusted VS Code workspace.' }));
      return;
    }
    let change: ReturnType<typeof parseCostPolicyPatch>;
    try {
      change = parseCostPolicyPatch(JSON.parse(await readRequestBody(request)));
    } catch (error) {
      send(response, 400, 'application/json', JSON.stringify({ error: String(error) }));
      return;
    }
    if (change.expectedRevision !== engine.getCostPolicyAssessment().policyRevision) {
      send(response, 409, 'application/json', JSON.stringify({ error: 'Cost policy changed. Reload the saved settings before applying.' }));
      return;
    }
    try {
      await options.costPolicy.save(change.policy, change.expectedRevision);
    } catch {
      send(response, 409, 'application/json', JSON.stringify({ error: 'Policy could not be applied. Check workspace settings and reload the saved policy.' }));
      return;
    }
    send(response, 200, 'application/json', JSON.stringify(buildSummaryPayload(engine, events.status())));
    events.notify();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/config') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    let patch: Partial<EngineConfig>;
    try {
      patch = parseConfigPatch(JSON.parse(await readRequestBody(request)));
      engine.updateConfig(patch);
    } catch (error) {
      send(response, 400, 'application/json', JSON.stringify({ error: String(error) }));
      return;
    }
    await options.onConfigChanged?.(engine.getConfig(), engine.getConfigOverrides());
    const payload = buildSummaryPayload(engine, events.status());
    send(response, 200, 'application/json', JSON.stringify(payload));
    events.notify();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/baseline') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    engine.baseline.save(
      buildCurrentBaseline(engine, engine.ledger.all(), `Baseline ${new Date().toLocaleString()}`),
    );
    send(response, 200, 'application/json', JSON.stringify(buildSummaryPayload(engine, events.status())));
    events.notify();
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/health') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    const report = runHealthReport({ storageDir: engine.getStorageDir() });
    send(response, 200, 'application/json', JSON.stringify({ type: 'health', ...report }));
    return;
  }

  if (request.method !== 'GET') {
    send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const nonce = crypto.randomBytes(16).toString('base64');
    send(response, 200, 'text/html; charset=utf-8', renderDashboardHtml(nonce));
    return;
  }

  if (url.pathname === '/api/summary') {
    send(response, 200, 'application/json', JSON.stringify(buildSummaryPayload(engine, events.status())));
    return;
  }

  if (url.pathname === '/api/policy-models') {
    if (!originIsLoopback(request.headers.origin, port)) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Forbidden origin' }));
      return;
    }
    if (!options.costPolicy?.canEdit() || !options.costPolicy.listModels) {
      send(response, 403, 'application/json', JSON.stringify({ error: 'Model discovery requires an available, trusted VS Code host.' }));
      return;
    }
    try {
      const models = await options.costPolicy.listModels();
      if (!options.costPolicy.canEdit()) throw new Error('Workspace access changed.');
      send(response, 200, 'application/json', JSON.stringify({ models }));
    } catch {
      send(response, 503, 'application/json', JSON.stringify({ error: 'Model list unavailable. Retry from the trusted VS Code workspace.' }));
    }
    return;
  }

  if (url.pathname === '/api/events') {
    events.connect(request, response);
    return;
  }

  if (url.pathname === '/api/report.md') {
    send(response, 200, 'text/markdown; charset=utf-8', renderDashboardReportMarkdown(engine, new Date(), events.status()), {
      'content-disposition': 'attachment; filename="slipstream-savings-snapshot.md"',
    });
    return;
  }

  if (url.pathname === '/api/report.json') {
    send(response, 200, 'application/json', renderDashboardReportJson(engine, new Date(), events.status()), {
      'content-disposition': 'attachment; filename="slipstream-savings-snapshot.json"',
    });
    return;
  }

  if (url.pathname === '/api/report.csv') {
    send(response, 200, 'text/csv; charset=utf-8', renderDashboardReportCsv(engine, new Date(), events.status()), {
      'content-disposition': 'attachment; filename="slipstream-savings-snapshot.csv"',
    });
    return;
  }

  if (url.pathname === '/api/detail') {
    const ts = Number(url.searchParams.get('ts'));
    const eventId = url.searchParams.get('eventId') ?? undefined;
    const payload = Number.isFinite(ts) ? buildDetailPayload(engine, ts, eventId) : undefined;
    if (!payload) {
      send(response, 404, 'application/json', JSON.stringify({ error: 'No such event' }));
      return;
    }
    send(response, 200, 'application/json', JSON.stringify(payload));
    return;
  }

  if (url.pathname === '/api/model-payload') {
    const ts = Number(url.searchParams.get('ts'));
    const eventId = url.searchParams.get('eventId') ?? undefined;
    const payload = Number.isFinite(ts) ? buildModelPayload(engine, ts, eventId) : undefined;
    if (payload === undefined) {
      send(response, 404, 'text/plain; charset=utf-8', 'No such event');
      return;
    }
    send(response, 200, 'text/plain; charset=utf-8', payload);
    return;
  }

  send(response, 404, 'text/plain; charset=utf-8', 'Not found');
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 16_384) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body || '{}'));
    request.on('error', reject);
  });
}

export function parseConfigPatch(raw: unknown): Partial<EngineConfig> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config patch must be an object');
  }
  const input = raw as Record<string, unknown>;
  const patch: Partial<EngineConfig> = {};
  if (input.pricing !== undefined) {
    throw new Error('Pricing is managed automatically from request models');
  }
  if (input.costPolicy !== undefined) {
    throw new Error('Cost policy is managed by the host configuration');
  }
  if (input.usdPerMillionTokens !== undefined) {
    if (!validRate(input.usdPerMillionTokens)) throw new Error('Fallback input rate must be a non-negative finite number');
    patch.usdPerMillionTokens = input.usdPerMillionTokens;
  }
  if (input.profile !== undefined) {
    if (!isCompressionProfile(input.profile)) throw new Error('Unknown compression profile');
    patch.profile = input.profile;
  }
  readBoolean(input, patch, 'enabled');
  readBoolean(input, patch, 'compressLogs');
  readBoolean(input, patch, 'readLifecycle');
  readBoolean(input, patch, 'crossTurnDedup');
  readNumber(input, patch, 'maxFileLines', 50, 20_000, 1);
  readNumber(input, patch, 'artifactIdleTtlMinutes', 1, 24 * 60, 1);
  readNumber(input, patch, 'artifactMaxEntries', 1, 100_000, 1);
  readNumber(input, patch, 'artifactMaxTotalMiB', 1, 10_240, 1);
  return patch;
}

export function parseModelRecommendationRequest(raw: unknown): { request: PolicyRecommendationRequest; expectedRevision: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A recommendation query is required.');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'request' && key !== 'expectedRevision')) throw new Error('Unknown recommendation query field.');
  if (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new Error('A saved policy revision is required.');
  return { request: parsePolicyRecommendationRequest(input.request), expectedRevision: input.expectedRevision };
}

export function parseCostPolicyPatch(raw: unknown): { policy: CostPolicy; expectedRevision: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A policy change object is required.');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'policy' && key !== 'expectedRevision')) throw new Error('Unknown policy change field.');
  if (!input.policy || typeof input.policy !== 'object' || Array.isArray(input.policy)) throw new Error('A policy object is required.');
  if (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new Error('A saved policy revision is required.');
  const policy = validateCostPolicy(input.policy);
  return { policy, expectedRevision: input.expectedRevision };
}

function readBoolean<T extends keyof EngineConfig>(
  input: Record<string, unknown>,
  patch: Partial<EngineConfig>,
  key: T,
): void {
  if (input[key] === undefined) return;
  if (typeof input[key] !== 'boolean') {
    throw new Error(`${String(key)} must be a boolean`);
  }
  patch[key] = input[key] as EngineConfig[T];
}

function readNumber<T extends keyof EngineConfig>(
  input: Record<string, unknown>,
  patch: Partial<EngineConfig>,
  key: T,
  min: number,
  max: number,
  step: number,
): void {
  if (input[key] === undefined) return;
  const value = Number(input[key]);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${String(key)} must be between ${min} and ${max}`);
  }
  const rounded = step >= 1 ? Math.round(value) : Math.round(value / step) * step;
  patch[key] = rounded as EngineConfig[T];
}
