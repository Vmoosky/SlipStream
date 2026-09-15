import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CompressionEngine } from '../src/engine.js';
import { validateCostPolicy } from '../src/costPolicy.js';
import { startDashboardServer, type DashboardServerHandle } from '../src/dashboardServer.js';
import type { DashboardModelTrackingStatus } from '../src/dashboard.js';
import { jestFailureLog } from './fixtures.js';

let engine: CompressionEngine;
let server: DashboardServerHandle;
let storage: string;
let base: string;

beforeAll(async () => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-dash-'));
  engine = new CompressionEngine({ rootDir: storage, workspaceRoots: [storage] });
  engine.compressCommandOutput({
    command: 'npx vitest run',
    cwd: storage,
    exitCode: 1,
    stdout: jestFailureLog(40),
    stderr: '',
    durationMs: 1200,
  });
  // Port 0 so the suite never fights with a real dashboard on the default port.
  server = await startDashboardServer(engine, { port: 0 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(storage, { recursive: true, force: true });
});

/**
 * `fetch` refuses to send a caller-supplied Host header, so a rebinding attempt
 * has to be made with a raw request.
 */
function requestWithHost(pathname: string, host: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: server.port, path: pathname, method, headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('dashboard server access control', () => {
  it('binds to loopback only', () => {
    expect(server.url.startsWith('http://localhost:')).toBe(true);
  });

  it('uses a readable local URL by default', async () => {
    expect(server.token).toBeUndefined();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
  });

  it('can enforce an optional token', async () => {
    const tokenServer = await startDashboardServer(engine, { port: 0, token: 'dashboard-test-token' });
    const tokenBase = `http://127.0.0.1:${tokenServer.port}`;
    const response = await fetch(`${tokenBase}/api/summary?t=wrong`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('tokensSaved');
    expect((await fetch(`${tokenBase}/api/summary?t=dashboard-test-token`)).status).toBe(200);
    await tokenServer.close();
  });

  it('refuses a non-loopback Host header, blocking DNS rebinding', async () => {
    expect(await requestWithHost('/', 'evil.example.com')).toBe(403);
    // Sanity check: the same request with a loopback Host is allowed, so the
    // assertion above is really about the header and not something else.
    expect(await requestWithHost('/', `localhost:${server.port}`)).toBe(200);
  });

  it('refuses methods other than GET', async () => {
    const response = await fetch(`${base}/api/summary`, { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('never allows cross-origin reads', async () => {
    const response = await fetch(`${base}/api/summary`);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('dashboard server content', () => {
  it('lists models only through an authorized trusted host without changing policy or history', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-model-list-server-'));
    const local = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let trusted = true;
    const models = [{ vendor: 'copilot', id: 'test', name: 'Test model', authorized: false }];
    const listModels = vi.fn(async () => models);
    const save = vi.fn();
    const hosted = await startDashboardServer(local, { port: 0, token: 'model-list-token', costPolicy: { canEdit: () => trusted, save, listModels } });
    const origin = new URL(hosted.url).origin;
    const endpoint = origin + '/api/policy-models?t=model-list-token';
    try {
      const config = local.getConfig();
      const history = local.ledger.all();
      expect((await (await fetch(origin + '/api/summary?t=model-list-token')).json()).canListPolicyModels).toBe(true);
      expect((await fetch(origin + '/api/policy-models')).status).toBe(401);
      expect((await fetch(endpoint, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
      expect(await requestWithHost('/api/policy-models', 'untrusted.example')).toBe(403);
      expect((await fetch(base + '/api/policy-models')).status).toBe(403);
      expect((await fetch(endpoint, { method: 'POST' })).status).toBe(405);
      expect(listModels).not.toHaveBeenCalled();
      expect(await (await fetch(endpoint)).json()).toEqual({ models });
      expect(listModels).toHaveBeenCalledTimes(1);
      listModels.mockRejectedValueOnce(new Error('PRIVATE'));
      const failure = await fetch(endpoint);
      expect(failure.status).toBe(503);
      expect(await failure.text()).not.toContain('PRIVATE');
      trusted = false;
      expect((await fetch(endpoint)).status).toBe(403);
      expect((await (await fetch(origin + '/api/summary?t=model-list-token')).json()).canListPolicyModels).toBe(false);
      trusted = true;
      listModels.mockImplementationOnce(async () => { trusted = false; return models; });
      expect((await fetch(endpoint)).status).toBe(503);
      expect(save).not.toHaveBeenCalled();
      expect(local.getConfig()).toEqual(config);
      expect(local.ledger.all()).toEqual(history);
    } finally {
      await hosted.close();
      local.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves read-only recommendations with strict inputs, access checks, and revision guards', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-recommendation-api-'));
    const local = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let trusted = true;
    const save = vi.fn();
    const recommend = vi.fn(async () => ({ state: 'unavailable' as const, reason: 'no-permitted-models' as const, candidates: [] }));
    const hosted = await startDashboardServer(local, { port: 0, token: 'recommendation-token', costPolicy: { canEdit: () => trusted, save, recommend } });
    const origin = new URL(hosted.url).origin;
    const endpoint = origin + '/api/model-recommendation?t=recommendation-token';
    const post = (value: unknown) => fetch(endpoint, { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(value) });
    const expectedRevision = local.getCostPolicyAssessment().policyRevision;
    const request = { category: 'code', requestedModel: { vendor: 'vendor', id: 'baseline' }, inputTokens: 0, outputTokens: 512, pinned: false };
    const query = { request, expectedRevision };
    const history = local.ledger.all();
    const config = local.getConfig();
    try {
      expect((await (await fetch(hosted.url.replace('/?t=', '/api/summary?t='))).json()).canRecommendModels).toBe(true);
      expect((await fetch(origin + '/api/model-recommendation', { method: 'POST', body: JSON.stringify(query) })).status).toBe(401);
      expect((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: JSON.stringify(query) })).status).toBe(403);
      expect(await requestWithHost('/api/model-recommendation', 'untrusted.example', 'POST')).toBe(403);
      expect((await fetch(base + '/api/model-recommendation', { method: 'POST', body: JSON.stringify(query) })).status).toBe(403);
      for (const invalid of [null, [], {}, { request }, { ...query, extra: true }, { ...query, expectedRevision: 'wrong' },
        ...[null, [], { category: ['code'] }, { category: 'invented' }, { inputTokens: -1 }, { inputTokens: '100' },
          { outputTokens: 0 }, { outputTokens: 32769 }, { pinned: 'yes' }, { prompt: 'PRIVATE' }, { requestedModel: { vendor: 'vendor', id: 'x', extra: true } }]
          .map((invalidRequest) => ({ ...query, request: invalidRequest }))]) expect((await post(invalid)).status).toBe(400);
      expect((await post({ ...query, expectedRevision: 'f'.repeat(64) })).status).toBe(409);
      trusted = false;
      expect((await post(query)).status).toBe(403);
      trusted = true;
      expect(recommend).not.toHaveBeenCalled();
      const response = await post(query);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: { state: 'unavailable', reason: 'no-permitted-models', candidates: [] }, policyRevision: expectedRevision });
      expect(recommend).toHaveBeenLastCalledWith(request, expectedRevision);
      recommend.mockRejectedValueOnce(new Error('PRIVATE model failure'));
      const failed = await post(query);
      expect(failed.status).toBe(409);
      expect(await failed.text()).not.toContain('PRIVATE');
      expect(save).not.toHaveBeenCalled();
      expect(local.ledger.all()).toEqual(history);
      expect(local.getConfig()).toEqual(config);
      recommend.mockImplementationOnce(async () => { trusted = false; return { state: 'unavailable', reason: 'no-permitted-models', candidates: [] }; });
      expect((await post(query)).status).toBe(409);
    } finally {
      await hosted.close();
      local.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['recommend-only', 'automatic-owned-request'] as const)('saves %s policy only through a validated, authorized host handler with a current revision', async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-policy-api-'));
    const local = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    let editable = true;
    const save = vi.fn(async (policy: ReturnType<typeof validateCostPolicy>) => { local.updateConfig({ costPolicy: policy }); });
    const writable = await startDashboardServer(local, { port: 0, token: 'policy-token', costPolicy: { canEdit: () => editable, save } });
    const readOnly = await startDashboardServer(local, { port: 0 });
    const origin = new URL(writable.url).origin;
    const endpoint = origin + '/api/cost-policy?t=policy-token';
    const post = (value: unknown) => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value) });
    try {
      const revision = local.getCostPolicyAssessment().policyRevision;
      const policy = { version: 1, mode, taskBudget: 0, budgetUnit: 'tokens', modelSelection: 'policy', outputTokenAllowance: 256 };
      const change = { policy, expectedRevision: revision };
      const history = local.ledger.all();
      const totals = local.summary();
      expect((await fetch(origin + '/api/cost-policy', { method: 'POST', body: JSON.stringify(change) })).status).toBe(401);
      expect((await fetch(endpoint, { method: 'POST', headers: { Origin: 'https://untrusted.example' }, body: JSON.stringify(change) })).status).toBe(403);
      expect((await fetch(readOnly.url + 'api/cost-policy', { method: 'POST', body: JSON.stringify(change) })).status).toBe(403);
      for (const value of [null, [], {}, { policy }, { ...change, expectedRevision: 0 }, { ...change, extra: true },
        { ...change, policy: { ...policy, taskBudget: -1 } }, { ...change, policy: { ...policy, outputTokenAllowance: 0 } }]) {
        expect((await post(value)).status).toBe(400);
      }
      expect((await post({ ...change, expectedRevision: 'f'.repeat(64) })).status).toBe(409);
      editable = false;
      expect((await post(change)).status).toBe(403);
      editable = true;
      expect(save).not.toHaveBeenCalled();
      save.mockRejectedValueOnce(new Error('PRIVATE write failure'));
      const rejected = await post(change);
      expect(rejected.status).toBe(409);
      expect(await rejected.text()).not.toContain('PRIVATE');
      expect(local.ledger.all()).toEqual(history);
      expect(local.getConfig().costPolicy.mode).toBe('off');
      const applied = await post(change);
      expect(applied.status).toBe(200);
      const payload = await applied.json();
      expect(payload.costPolicySettings).toEqual({ value: validateCostPolicy(policy), editable: true });
      expect(payload.costPolicy).toMatchObject({ effectiveMode: 'recommend-only', taskBudget: 0 });
      expect(save).toHaveBeenLastCalledWith(validateCostPolicy(policy), revision);
      expect(local.summary()).toEqual(totals);
      expect((await post(change)).status).toBe(409);
      expect((await fetch(origin + '/api/config?t=policy-token', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify({ costPolicy: policy }) })).status).toBe(400);
      expect(local.ledger.all().filter((entry) => entry.costPolicyAssessment)).toHaveLength(1);
    } finally {
      await writable.close();
      await readOnly.close();
      local.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('guards on-demand catalog refresh without accepting a source or changing history', async () => {
    const refresh = vi.spyOn(engine.pricing, 'refresh').mockResolvedValue();
    const guarded = await startDashboardServer(engine, { port: 0, token: 'refresh-token' });
    const before = fs.readFileSync(engine.ledger.path(), 'utf8');
    const summary = engine.summary();
    const request = (token = 'refresh-token', origin = new URL(guarded.url).origin) => fetch(
      new URL(`/api/pricing/refresh?t=${token}`, guarded.url),
      { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ source: 'https://untrusted.example' }) },
    );
    try {
      expect((await request('wrong')).status).toBe(401);
      expect((await request('refresh-token', 'https://untrusted.example')).status).toBe(403);
      expect(await requestWithHost('/api/pricing/refresh', 'untrusted.example', 'POST')).toBe(403);
      expect((await fetch(new URL('/api/pricing/refresh?t=refresh-token', guarded.url))).status).toBe(404);
      expect(refresh).not.toHaveBeenCalled();
      const response = await request();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: 'summary', pricingStatus: { loading: false } });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(true);
      expect(engine.summary()).toEqual(summary);
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(before);
      refresh.mockRejectedValueOnce(new Error('Refresh failed'));
      expect((await request()).status).toBe(500);
    } finally {
      refresh.mockRestore();
      await guarded.close();
    }
  });

  it('guards standalone runtime connections and only returns local dashboard URLs', async () => {
    let launches = 0;
    let launchFails = false;
    let target = 'http://localhost:7331/';
    const standalone = await startDashboardServer(engine, { port: 0, token: 'manage-token', onManageModelTracking: async () => {
      launches += 1;
      if (launchFails) throw new Error('Launcher unavailable');
      return target;
    } });
    const manage = (action: unknown, token = 'manage-token', origin = new URL(standalone.url).origin) => fetch(
      new URL(`/api/model-tracking?t=${token}`, standalone.url),
      { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ action }) },
    );
    try {
      expect((await manage('manage', '')).status).toBe(401);
      expect((await manage('manage', 'manage-token', 'https://example.invalid')).status).toBe(403);
      expect((await manage('open')).status).toBe(400);
      expect(launches).toBe(0);
      const opened = await manage('manage');
      expect(opened.status).toBe(200);
      expect(await opened.json()).toEqual({ dashboardUrl: target });
      expect(launches).toBe(1);
      for (target of ['https://example.invalid/', 'vscode://slipstream.slipstream-vscode/model-tracking', 'http://localhost:7331/api/config']) {
        expect((await manage('manage')).status).toBe(500);
      }
      launchFails = true;
      const failed = await manage('manage');
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: 'Internal server error.' });
    } finally {
      await standalone.close();
    }
  });

  it.each([
    new Error('EACCES C:\\synthetic-private-store\\savings.jsonl'),
    'synthetic-private-token',
  ])('does not expose unexpected configuration errors: %j', async (failure) => {
    const update = vi.spyOn(engine, 'updateConfig').mockImplementationOnce(() => { throw failure; });
    try {
      const response = await fetch(`${base}/api/config`, {
        method: 'POST', body: JSON.stringify({ enabled: true }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error.' });
      expect(update).toHaveBeenCalledOnce();
    } finally {
      update.mockRestore();
    }
  });

  it('does not expose filesystem error details from baseline persistence', async () => {
    const save = vi.spyOn(engine.baseline, 'save').mockImplementationOnce(() => {
      throw new Error('EACCES C:\\synthetic-private-store\\baseline.json');
    });
    try {
      const response = await fetch(`${base}/api/baseline`, { method: 'POST' });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error.' });
      expect(save).toHaveBeenCalledOnce();
    } finally {
      save.mockRestore();
    }
  });

  it('does not echo malformed JSON in configuration or policy responses', async () => {
    const save = vi.fn(async () => {});
    const writable = await startDashboardServer(engine, { port: 0, costPolicy: { canEdit: () => true, save } });
    try {
      for (const [endpoint, message] of [
        ['/api/config', 'Invalid configuration request.'],
        ['/api/cost-policy', 'Invalid cost policy request.'],
      ]) {
        const response = await fetch(new URL(endpoint!, writable.url), {
          method: 'POST', body: '{"synthetic-private-token": invalid}',
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: message });
      }
      expect(save).not.toHaveBeenCalled();
    } finally {
      await writable.close();
    }
  });

  it.each([
    [{ profile: 'synthetic-private-token' }, 'Unknown compression profile'],
    [{ enabled: 'synthetic-private-token' }, 'enabled must be a boolean'],
    [{ maxFileLines: -1 }, 'maxFileLines must be between 50 and 20000'],
    [{ usdPerMillionTokens: -1 }, 'Fallback input rate must be a non-negative finite number'],
  ])('keeps known configuration validation useful without echoing values: %j', async (patch, message) => {
    const response = await fetch(`${base}/api/config`, { method: 'POST', body: JSON.stringify(patch) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
  });

  it('restricts model tracking actions and reports sanitized connection status', async () => {
    let tracking: DashboardModelTrackingStatus = { state: 'disconnected', detail: 'Off', canConnect: true, canDisconnect: false };
    let connects = 0;
    const managed = await startDashboardServer(engine, { port: 0, modelTracking: {
      status: () => tracking,
      connect: async () => { connects++; tracking = { state: 'connected', detail: 'Ready', canConnect: false, canDisconnect: true }; },
      disconnect: async () => { tracking = { state: 'disconnected', detail: 'Off', canConnect: true, canDisconnect: false }; },
    } });
    try {
      const endpoint = `${managed.url}api/model-tracking`;
      const headers = { 'content-type': 'application/json' };
      expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, origin: 'https://external.example' }, body: '{"action":"connect"}' })).status).toBe(403);
      expect((await fetch(endpoint, { method: 'POST', headers, body: '{"action":"unknown"}' })).status).toBe(400);
      expect(connects).toBe(0);
      const connected = await fetch(endpoint, { method: 'POST', headers, body: '{"action":"connect"}' });
      expect((await connected.json()).modelTracking).toEqual({ state: 'connected', detail: 'Ready', canConnect: false, canDisconnect: true });
      expect(connects).toBe(1);
      const disconnected = await fetch(endpoint, { method: 'POST', headers, body: '{"action":"disconnect"}' });
      expect((await disconnected.json()).modelTracking.state).toBe('disconnected');
      expect((await fetch(`${base}/api/model-tracking`, { method: 'POST', headers, body: '{"action":"connect"}' })).status).toBe(501);
    } finally { await managed.close(); }
  });

  it('rejects model selection edits and exposes background model status', async () => {
    for (const patch of [{ pricing: { mode: 'manual' } }, { pricing: { mode: 'catalog', providerId: 'vendor', modelId: 'model' } }]) {
      const invalid = await fetch(`${base}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain('managed automatically');
    }
    expect(engine.getConfig().pricing.mode).toBe('manual');
    const removed = await fetch(`${base}/api/pricing`, { method: 'POST', body: '{}' });
    expect(removed.status).toBe(405);
    const summary = await (await fetch(`${base}/api/summary`)).json();
    expect(summary.pricingSnapshot).toMatchObject({ mode: 'automatic', inputUsdPerMillion: null });
    expect(summary.pricingStatus.loading).toBe(false);
  });

  it('accepts fallback rate edits without changing model pricing and rejects invalid rates', async () => {
    const headers = { 'content-type': 'application/json' };
    for (const rate of [7.125, 0]) {
      const response = await fetch(`${base}/api/config`, { method: 'POST', headers, body: JSON.stringify({ usdPerMillionTokens: rate }) });
      expect(response.status).toBe(200);
      const summary = await response.json();
      expect(summary.config.usdPerMillionTokens).toBe(rate);
      expect(summary.pricingSnapshot).toMatchObject({ mode: 'automatic', inputUsdPerMillion: null });
    }
    for (const rate of [-1, null, '3']) {
      const response = await fetch(`${base}/api/config`, { method: 'POST', headers, body: JSON.stringify({ usdPerMillionTokens: rate }) });
      expect(response.status).toBe(400);
    }
    expect(engine.getConfig().usdPerMillionTokens).toBe(0);
  });

  it('applies profiles and preserves explicitly overridden knobs', async () => {
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'aggressive', maxFileLines: 900 }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.config.profile).toBe('aggressive');
    expect(payload.config.maxFileLines).toBe(900);
    expect(engine.getConfig().log.tailLines).toBe(15);
    const switched = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'conservative' }),
    });
    expect((await switched.json()).config.maxFileLines).toBe(900);
    expect(engine.getConfig().log.tailLines).toBe(60);
    engine.updateConfig({ profile: 'balanced', maxFileLines: undefined });
  });

  it('rejects unknown profile names without applying the patch', async () => {
    const response = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'invalid', maxFileLines: 900 }),
    });
    expect(response.status).toBe(400);
    expect(engine.getConfig().profile).toBe('balanced');
    expect(engine.getConfig().maxFileLines).toBe(1200);
  });

  it('serves the page with a nonce-based CSP', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(html).not.toContain('unsafe-inline');
  });

  it('reports the savings summary', async () => {
    const response = await fetch(`${base}/api/summary`);
    const body = (await response.json()) as {
      type: string;
      summary: { tokensSaved: number };
      events: { ts: number }[];
    };
    expect(body.type).toBe('summary');
    expect(body.summary.tokensSaved).toBeGreaterThan(0);
    expect(body.events.length).toBe(1);
  });

  it('exports a Markdown savings report', async () => {
    const response = await fetch(`${base}/api/report.md`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="slipstream-savings-snapshot.md"',
    );
    const report = await response.text();
    expect(report).toContain('# Slipstream Savings Snapshot');
    expect(report).toContain('## By strategy');
    expect(report).toContain('| Tokens saved |');
  });

  it('returns the before/after detail for an event', async () => {
    const summary = (await (await fetch(`${base}/api/summary`)).json()) as {
      events: { ts: number }[];
    };
    const ts = summary.events[0]!.ts;
    const response = await fetch(`${base}/api/detail?ts=${ts}`);
    const body = (await response.json()) as {
      before: string;
      after: string;
      omitted: { startLine: number; endLine: number }[];
    };

    expect(body.before.length).toBeGreaterThan(body.after.length);
    expect(body.omitted.length).toBeGreaterThan(0);
    // Every omitted range must be inside the raw output it refers to.
    const lineCount = body.before.split('\n').length;
    for (const range of body.omitted) {
      expect(range.startLine).toBeGreaterThanOrEqual(1);
      expect(range.endLine).toBeLessThanOrEqual(lineCount);
    }
  });

  it('404s an unknown event rather than leaking anything', async () => {
    const response = await fetch(`${base}/api/detail?ts=1`);
    expect(response.status).toBe(404);
  });

  it('404s an unknown path', async () => {
    const response = await fetch(`${base}/../secrets`);
    expect(response.status).toBe(404);
  });
});
