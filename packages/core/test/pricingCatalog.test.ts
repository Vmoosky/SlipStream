import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PricingService, parseModelRates } from '../src/pricingCatalog.js';
import { PRICING_FRESH_MS, PRICING_MAX_AGE_MS } from '../src/pricing.js';

const roots: string[] = [];
const services: PricingService[] = [];
const fixture = { vendor: { name: 'Vendor', models: { model: { name: 'Model', modalities: { input: ['text'] }, cost: { input: 5, cache_read: 0.5 } } } } };
const config = { mode: 'catalog' as const, providerId: 'vendor', modelId: 'model' };
function setup(fetcher = vi.fn(async () => new Response(JSON.stringify(fixture))), now = () => Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-prices-'));
  roots.push(root);
  const service = new PricingService(root, { fetch: fetcher as typeof fetch, now });
  services.push(service);
  return { service, fetcher, root };
}
afterEach(() => { for (const service of services.splice(0)) service.dispose(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('pricing catalog', () => {
  it('retains explicit tool capability without inferring it from names or prices', () => {
    const rates = parseModelRates({ vendor: { name: 'Vendor', models: {
      capable: { modalities: { input: ['text'] }, cost: { input: 1 }, tool_call: true },
      incapable: { modalities: { input: ['text'] }, cost: { input: 1 }, tool_call: false },
      unknown: { modalities: { input: ['text'] }, cost: { input: 1 }, tool_call: 'yes' },
    } } });
    expect(rates.find((rate) => rate.modelId === 'capable')?.toolCalling).toBe(true);
    expect(rates.find((rate) => rate.modelId === 'incapable')?.toolCalling).toBe(false);
    expect(rates.find((rate) => rate.modelId === 'unknown')?.toolCalling).toBeUndefined();
  });
  it('rejects oversized, malformed and timed-out responses without creating a cache', async () => {
    const { service, fetcher, root } = setup();
    for (const response of [new Response('x'.repeat(32 * 1024 * 1024 + 1)), new Response('{}')]) {
      fetcher.mockImplementation(async () => response);
      await service.refresh(true);
      expect(service.snapshot(config, 3).inputUsdPerMillion).toBeNull();
      expect(service.status().error).not.toBeNull();
      expect(fs.existsSync(path.join(root, 'pricing-cache.json'))).toBe(false);
    }
    fetcher.mockImplementation(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
    await service.refresh(true);
    expect(service.status().error).toBe('Timed out');
  });

  it('recovers stale locks and treats a newly missing model as unavailable', async () => {
    const { service, fetcher, root } = setup();
    const lock = path.join(root, 'pricing-cache.json.lock');
    fs.writeFileSync(lock, '');
    fs.utimesSync(lock, new Date(0), new Date(0));
    await service.refresh();
    expect(service.snapshot(config, 3).inputUsdPerMillion).toBe(5);
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ other: fixture.vendor })));
    await service.refresh(true);
    expect(service.snapshot(config, 3).inputUsdPerMillion).toBeNull();
  });

  it('loads only explicit input prices and excludes subscription providers', () => {
    const parsed = parseModelRates({ ...fixture, 'github-copilot': fixture.vendor });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ input: 5, cacheRead: 0.5 });
    expect(() => parseModelRates({ vendor: { name: 'Vendor', models: { model: { modalities: { input: ['text'] }, cost: {} } } } })).toThrow();
  });
  it('never fetches in manual mode and deduplicates refreshes', async () => {
    const { service, fetcher } = setup();
    service.start(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(service.snapshot(config, 3).inputUsdPerMillion).toBeNull();
    await Promise.all([service.refresh(), service.refresh()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(service.snapshot(config, 3).inputUsdPerMillion).toBe(5);
    await service.refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains stale cache on failure and expires without repricing snapshots', async () => {
    let now = 100;
    const { service, fetcher, root } = setup(undefined, () => now);
    expect(service.status().freshness).toBe('missing');
    await service.refresh();
    expect(service.status().freshness).toBe('fresh');
    const snapshot = service.snapshot(config, 3);
    now += PRICING_FRESH_MS + 1;
    fetcher.mockImplementation(async () => new Response('', { status: 429 }));
    await service.refresh();
    expect(service.status().error).toContain('429');
    expect(service.status().freshness).toBe('stale');
    expect(service.snapshot(config, 3)).toMatchObject({ stale: true, inputUsdPerMillion: 5, fetchedAt: 100 });
    const restarted = new PricingService(root, { now: () => now });
    services.push(restarted);
    expect(restarted.snapshot(config, 3).inputUsdPerMillion).toBe(5);
    now += PRICING_MAX_AGE_MS;
    expect(service.snapshot(config, 3).inputUsdPerMillion).toBeNull();
    expect(service.status().freshness).toBe('expired');
    expect(snapshot.inputUsdPerMillion).toBe(5);
  });
  it('publishes forced refresh progress and permits a retry without repricing an earlier snapshot', async () => {
    const { service, fetcher } = setup();
    await service.refresh();
    const recorded = service.snapshot(config, 3);
    const changes = vi.fn();
    service.onChange(changes);
    let finish!: (response: Response) => void;
    fetcher.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const pending = service.refresh(true);
    expect(service.refresh(true)).toBe(pending);
    expect(service.status()).toMatchObject({ loading: true, freshness: 'fresh' });
    expect(changes).toHaveBeenCalledTimes(1);
    finish(new Response('', { status: 503 }));
    await pending;
    expect(service.status()).toMatchObject({ loading: false, error: 'Pricing source returned HTTP 503' });
    expect(changes).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => new Response(JSON.stringify(fixture)));
    await service.refresh(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(service.status()).toMatchObject({ loading: false, error: null, freshness: 'fresh' });
    expect(recorded.inputUsdPerMillion).toBe(5);
  });
  it('preserves the last cache after invalid JSON and rejects redirects with a timeout signal', async () => {
    const { service, fetcher } = setup();
    await service.refresh();
    fetcher.mockImplementation(async () => new Response('invalid'));
    await service.refresh(true);
    expect(service.status().error).not.toBeNull();
    expect(service.snapshot(config, 3).inputUsdPerMillion).toBe(5);
    expect(fetcher.mock.calls[0]).toEqual(['https://models.dev/api.json', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) })]);
  });
  it('does not block on another process lock', async () => {
    const { service, fetcher, root } = setup();
    fs.writeFileSync(path.join(root, 'pricing-cache.json.lock'), '');
    await service.refresh();
    expect(fetcher).not.toHaveBeenCalled();
    expect(service.status().error).toContain('Another process');
  });
});