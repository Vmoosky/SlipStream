import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PRICING_SOURCE, PRICING_FRESH_MS, PRICING_MAX_AGE_MS, resolvePricing, validRate, type DetectedModel, type ModelRate, type PricingCatalog, type PricingConfig } from './pricing.js';

const MAX_BYTES = 32 * 1024 * 1024;
const EXCLUDED_PROVIDERS = /copilot|subscription|(^|-)coding(-|$)|opencode-zen|opencode-go/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseModelRates(value: unknown): ModelRate[] {
  const providers = object(value);
  if (!providers) throw new Error('Invalid pricing catalog');
  const models: ModelRate[] = [];
  for (const [providerId, rawProvider] of Object.entries(providers)) {
    if (EXCLUDED_PROVIDERS.test(providerId)) continue;
    const provider = object(rawProvider);
    const entries = object(provider?.models);
    if (!provider || !entries || typeof provider.name !== 'string') continue;
    for (const [modelId, rawModel] of Object.entries(entries)) {
      const model = object(rawModel);
      const cost = object(model?.cost);
      const modalities = object(model?.modalities);
      if (!model || !cost || !validRate(cost.input) || !Array.isArray(modalities?.input) || !modalities.input.includes('text')) continue;
      if (model.status === 'deprecated' || providerId.length > 300 || modelId.length > 300) continue;
      const entry: ModelRate = { providerId, providerName: provider.name.slice(0, 300), modelId,
        modelName: typeof model.name === 'string' ? model.name.slice(0, 300) : modelId, input: cost.input };
      if (validRate(cost.output)) entry.output = cost.output;
      if (validRate(cost.cache_read)) entry.cacheRead = cost.cache_read;
      if (validRate(cost.cache_write)) entry.cacheWrite = cost.cache_write;
      if (typeof model.tool_call === 'boolean') entry.toolCalling = model.tool_call;
      models.push(entry);
    }
  }
  if (!models.length) throw new Error('No valid text input prices in catalog');
  return models.sort((left, right) => left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId));
}

export class PricingService {
  private catalog?: PricingCatalog;
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<() => void>();
  private nextAttempt = 0;
  private disposed = false;
  private error?: string;
  private readonly cachePath: string;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;

  constructor(rootDir: string, options: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.cachePath = path.join(rootDir, 'pricing-cache.json');
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.load();
  }

  snapshot(config: PricingConfig, manualRate: number, model?: DetectedModel) {
    return resolvePricing(config, manualRate, this.catalog, this.now(), model);
  }

  status() {
    const age = this.catalog ? this.now() - this.catalog.fetchedAt : null;
    const freshness: 'missing' | 'fresh' | 'stale' | 'expired' = age === null ? 'missing'
      : age < 0 || age > PRICING_MAX_AGE_MS ? 'expired' : age > PRICING_FRESH_MS ? 'stale' : 'fresh';
    return { loading: !!this.pending, error: this.error ?? null, fetchedAt: this.catalog?.fetchedAt ?? null,
      source: PRICING_SOURCE, modelCount: this.catalog?.models.length ?? 0, freshness };
  }

  choices() { return structuredClone(this.catalog?.models ?? []); }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(enabled: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!enabled || this.disposed) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 60_000);
    this.timer.unref();
  }

  refresh(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!force && this.now() < this.nextAttempt) return Promise.resolve();
    this.load();
    if (!force && this.catalog && this.now() - this.catalog.fetchedAt < PRICING_FRESH_MS) return Promise.resolve();
    this.pending = this.download().catch((error: unknown) => {
      const message = object(error)?.message;
      this.error = typeof message === 'string' ? message : 'Pricing refresh failed';
      this.nextAttempt = this.now() + 60 * 60 * 1000;
    }).finally(() => {
      this.pending = undefined;
      this.emit();
    });
    this.emit();
    return this.pending;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.listeners.clear();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { }
    }
  }

  private load(): void {
    try {
      if (fs.statSync(this.cachePath).size > MAX_BYTES) return;
      const cached = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as PricingCatalog;
      if (cached.version !== 1 || !Number.isFinite(cached.fetchedAt) || cached.fetchedAt > this.now() || typeof cached.revision !== 'string' || !Array.isArray(cached.models) || !cached.models.length) return;
      if (!cached.models.every((model) => model && validRate(model.input) && ['providerId', 'providerName', 'modelId', 'modelName'].every((key) => typeof model[key as keyof ModelRate] === 'string'))) return;
      if (!this.catalog || cached.fetchedAt > this.catalog.fetchedAt) this.catalog = cached;
    } catch { }
  }

  private async download(): Promise<void> {
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const lockPath = `${this.cachePath}.lock`;
    try {
      if (this.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.unlinkSync(lockPath);
    } catch { }
    let lock: number;
    try { lock = fs.openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      this.error = 'Another process is refreshing prices; retry shortly';
      this.nextAttempt = this.now() + 1000;
      return;
    }
    const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
    try {
      const before = this.catalog?.fetchedAt;
      this.load();
      if (this.catalog && this.catalog.fetchedAt !== before && this.now() - this.catalog.fetchedAt < PRICING_FRESH_MS) {
        this.error = undefined;
        this.nextAttempt = 0;
        return;
      }
      const response = await this.fetcher(PRICING_SOURCE, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error(`Pricing source returned HTTP ${response.status}`);
      if (!response.body) throw new Error('Empty pricing response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_BYTES) throw new Error('Pricing response exceeds 32 MiB');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const models = parseModelRates(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const catalog: PricingCatalog = { version: 1, fetchedAt: this.now(),
        revision: createHash('sha256').update(JSON.stringify(models)).digest('hex'), models };
      if (this.disposed) return;
      fs.writeFileSync(temporary, JSON.stringify(catalog), { mode: 0o600 });
      fs.renameSync(temporary, this.cachePath);
      this.catalog = catalog;
      this.error = undefined;
      this.nextAttempt = 0;
    } finally {
      fs.closeSync(lock);
      fs.rmSync(lockPath, { force: true });
      fs.rmSync(temporary, { force: true });
    }
  }
}