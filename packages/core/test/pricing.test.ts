import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SavingsLedger } from '../src/savingsLedger.js';
import { CompressionEngine } from '../src/engine.js';
import { buildSummaryPayload, renderDashboardReportCsv, renderDashboardReportMarkdown } from '../src/dashboard.js';
import { aggregateCost, priceReportedInput, priceReportedUsage, pricingFromEnvironment, resolvePricing, validatePricing, PRICING_MAX_AGE_MS, type PricingCatalog } from '../src/pricing.js';

const catalog: PricingCatalog = { version: 1, fetchedAt: 100, revision: 'fixture', models: [
  { providerId: 'vendor', providerName: 'Vendor', modelId: 'model', modelName: 'Model', input: 5 },
] };
const selection = { mode: 'catalog' as const, providerId: 'vendor', modelId: 'model' };

describe('pricing', () => {
  it('splits observed input costs using only recorded rates and excludes output', () => {
    const rates = { ...catalog, models: [{ ...catalog.models[0]!, output: 10, cacheRead: 1, cacheWrite: 6 }] };
    const snapshot = Object.freeze(resolvePricing(selection, 99, rates, 100));
    const usage = Object.freeze({ inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 600, cacheCreationInputTokens: 100 });
    const cost = priceReportedInput(snapshot, usage);
    expect(cost).toMatchObject({ coverage: 'complete', reason: null, uncachedInputTokens: 300, standardUncachedUsd: 0.005 });
    expect(cost.uncachedUsd).toBeCloseTo(0.0015, 10);
    expect(cost.cacheReadUsd).toBeCloseTo(0.0006, 10);
    expect(cost.cacheWriteUsd).toBeCloseTo(0.0006, 10);
    expect(cost.usd).toBeCloseTo(0.0027, 10);
    expect(cost.knownUsd).toBe(cost.usd);
    rates.models[0]!.input = 500;
    rates.models[0]!.cacheRead = 100;
    expect(priceReportedInput(snapshot, usage)).toEqual(cost);
    expect(priceReportedInput(snapshot, { ...usage, outputTokens: undefined })).toEqual(cost);
  });

  it('keeps missing cache usage unknown alongside a labelled uncached reference estimate', () => {
    const snapshot = { ...resolvePricing(selection, 99, catalog, 100), cacheReadUsdPerMillion: 1 };
    expect(priceReportedInput(snapshot, { inputTokens: 1000, cacheReadInputTokens: 600 })).toMatchObject({
      usd: null, coverage: 'partial', reason: 'Missing token usage', uncachedInputTokens: null,
      uncachedUsd: null, cacheWriteUsd: null, standardUncachedUsd: 0.005,
    });
    expect(priceReportedInput(snapshot, { inputTokens: 1000, cacheReadInputTokens: 600 }).knownUsd).toBeCloseTo(0.0006, 10);
    expect(priceReportedInput(snapshot, { inputTokens: 1000 })).toMatchObject({
      usd: null, knownUsd: 0, coverage: 'unavailable', standardUncachedUsd: 0.005,
    });
  });

  it('does not invent missing historical cache rates or a fallback snapshot', () => {
    const snapshot = resolvePricing(selection, 99, catalog, 100);
    const usage = { inputTokens: 1000, cacheReadInputTokens: 600, cacheCreationInputTokens: 100 };
    expect(priceReportedInput(snapshot, usage)).toMatchObject({
      usd: null, coverage: 'partial', reason: 'Missing model rates', uncachedInputTokens: 300,
      cacheReadUsd: null, cacheWriteUsd: null, standardUncachedUsd: 0.005,
    });
    expect(priceReportedInput(undefined, usage)).toMatchObject({
      usd: null, knownUsd: 0, coverage: 'unavailable', reason: 'Missing model rates', standardUncachedUsd: null,
    });
    expect(priceReportedInput(snapshot, {})).toMatchObject({ usd: null, coverage: 'unavailable', standardUncachedUsd: null });
  });

  it('preserves zero rates and zero-token components without requiring unused rates', () => {
    const snapshot = { ...resolvePricing(selection, 99, catalog, 100), cacheReadUsdPerMillion: 0 };
    expect(priceReportedInput(undefined, { inputTokens: 0 })).toMatchObject({
      usd: 0, knownUsd: 0, coverage: 'complete', uncachedInputTokens: 0, uncachedUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, standardUncachedUsd: 0,
    });
    expect(priceReportedInput(snapshot, { inputTokens: 1000, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0 })).toMatchObject({
      usd: 0, coverage: 'complete', uncachedUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, standardUncachedUsd: 0.005,
    });
    expect(priceReportedInput(snapshot, { inputTokens: 1000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })).toMatchObject({
      usd: 0.005, coverage: 'complete', uncachedInputTokens: 1000,
    });
  });

  it('rejects invalid input counts and overlapping cache counts without a plausible-looking total', () => {
    const snapshot = resolvePricing(selection, 99, catalog, 100);
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const field of ['inputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
        expect(priceReportedInput(snapshot, { inputTokens: 1000, [field]: value })).toMatchObject({
          usd: null, coverage: 'unavailable', reason: 'Invalid token usage', standardUncachedUsd: null,
        });
      }
    }
    expect(priceReportedInput(snapshot, { inputTokens: 5, cacheReadInputTokens: 4, cacheCreationInputTokens: 2 })).toMatchObject({
      usd: null, coverage: 'unavailable', reason: 'Inconsistent cached-input counts', uncachedInputTokens: null, standardUncachedUsd: null,
    });
  });

  it('only exposes known tool capability from a resolved, nonexpired catalog match', () => {
    const capable = { ...catalog, models: [{ ...catalog.models[0]!, toolCalling: true }] };
    expect(resolvePricing(selection, 99, capable, 100).toolCalling).toBe(true);
    expect(resolvePricing(selection, 99, catalog, 100).toolCalling).toBeUndefined();
    expect(resolvePricing(selection, 99, capable, 101 + PRICING_MAX_AGE_MS).toolCalling).toBeUndefined();
  });
  it('snapshots all published rates and prices reported cache tokens as part of input', () => {
    const rates = { ...catalog, models: [{ ...catalog.models[0]!, output: 10, cacheRead: 1, cacheWrite: 6 }] };
    const snapshot = resolvePricing(selection, 99, rates, 100);
    const usage = { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 600, cacheCreationInputTokens: 100 };
    expect(snapshot).toMatchObject({ inputUsdPerMillion: 5, outputUsdPerMillion: 10, cacheReadUsdPerMillion: 1, cacheWriteUsdPerMillion: 6 });
    const before = JSON.stringify(snapshot);
    expect(priceReportedUsage(snapshot, usage)).toMatchObject({ coverage: 'complete', reason: null });
    expect(priceReportedUsage(snapshot, usage).usd).toBeCloseTo(0.0037, 10);
    rates.models[0]!.output = 100;
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(priceReportedUsage(snapshot, usage).usd).toBeCloseTo(0.0037, 10);
  });

  it('keeps missing rates and missing usage distinct from free or zero-token usage', () => {
    const snapshot = resolvePricing(selection, 99, catalog, 100);
    expect(priceReportedUsage(snapshot, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })).toEqual({
      usd: null, knownUsd: 0.0005, coverage: 'partial', reason: 'Missing model rates',
    });
    expect(priceReportedUsage(snapshot, {})).toEqual({ usd: null, knownUsd: 0, coverage: 'unavailable', reason: 'Missing token usage' });
    expect(priceReportedUsage(snapshot, { inputTokens: 0, outputTokens: 0 })).toEqual({ usd: 0, knownUsd: 0, coverage: 'complete', reason: null });
    expect(priceReportedUsage(snapshot, { inputTokens: 100, outputTokens: 0 }).usd).toBeNull();
    expect(priceReportedUsage({ ...snapshot, outputUsdPerMillion: 0 }, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }).usd).toBe(0.0005);
  });

  it('does not price invalid or inconsistent usage as an ordinary call', () => {
    const snapshot = resolvePricing(selection, 99, catalog, 100);
    for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(priceReportedUsage(snapshot, { inputTokens: value })).toMatchObject({ usd: null, coverage: 'unavailable', reason: 'Invalid token usage' });
    }
    expect(priceReportedUsage(snapshot, { inputTokens: 5, cacheReadInputTokens: 4, cacheCreationInputTokens: 2 })).toMatchObject({ usd: null, reason: 'Inconsistent cached-input counts' });
  });

  it('preserves recorded savings and estimates missing rates with the configured fallback', () => {
    const entries = [
      { tool: 'read_file', tokensBefore: 1_000_000, tokensAfter: 500_000, pricing: resolvePricing(selection, 3, catalog, 101) },
      { tool: 'read_file', tokensBefore: 500_000, tokensAfter: 200_000 },
      { tool: 'retrieve_artifact', tokensBefore: 0, tokensAfter: 100_000 },
      { tool: 'session', tokensBefore: 1_000_000, tokensAfter: 0 },
    ];
    const total = aggregateCost(entries, 'net', 3);
    expect(total.usd).toBeCloseTo(3.1);
    expect(total.knownUsd).toBe(2.5);
    expect(total.fallbackUsd).toBeCloseTo(0.6);
    expect(total.fallbackUsdPerMillion).toBe(3);
    expect(total.coverage).toBe('partial');
    expect(aggregateCost(entries, 'gross', 3).usd).toBeCloseTo(3.4);
    expect(aggregateCost(entries, 'retrieval', 3).usd).toBeCloseTo(0.3);
    expect(aggregateCost(entries, 'net', 0).usd).toBe(2.5);
    expect(aggregateCost(entries, 'net').usd).toBeNull();
    expect(entries[1]).not.toHaveProperty('pricing');
  });

  it('isolates detected models across interleaved engines sharing a ledger and cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-request-pricing-'));
    const engines: CompressionEngine[] = [];
    try {
      fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({ ...catalog, fetchedAt: Date.now(), models: [
        ...catalog.models, { ...catalog.models[0], modelId: 'second', input: 9 },
      ] }));
      const firstModel = { id: 'model', vendor: 'vendor', name: 'First' };
      for (const model of [firstModel, { id: 'second', vendor: 'vendor', name: 'Second' }, undefined]) {
        engines.push(new CompressionEngine({ rootDir: root, workspaceRoots: [root], detectedModel: model, config: { pricing: { mode: 'automatic' } } }));
      }
      firstModel.id = 'second';
      for (const index of [0, 1, 2, 0]) {
        engines[index].compressToolResult({ toolName: 'test', text: 'status ok' });
      }
      expect(engines[0].ledger.recent(10).reverse().map((entry) => entry.pricing?.inputUsdPerMillion)).toEqual([5, 9, null, 5]);
      const before = engines[0].summary();
      engines[0].recordModelDetected();
      expect(engines[0].ledger.recent(1)[0]).toMatchObject({ tool: 'session', strategy: 'session:model', detectedModel: { id: 'model', name: 'First' } });
      expect(engines[0].ledger.recent(1)[0].pricing).toBeUndefined();
      expect(engines[0].summary()).toEqual(before);
    } finally {
      for (const engine of engines) engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('prices each detected model independently and never falls back to a manual rate', () => {
    const automatic = { mode: 'automatic' as const };
    const first = { id: 'model', vendor: 'vendor', name: 'First model' };
    const second = { id: 'second', vendor: 'vendor', name: 'Second model' };
    const rates = { ...catalog, models: [...catalog.models, { ...catalog.models[0], modelId: 'second', input: 9 }] };
    expect(resolvePricing(automatic, 99, rates, 101, first)).toMatchObject({ inputUsdPerMillion: 5, detectedModel: first });
    expect(resolvePricing(automatic, 99, rates, 101, second)).toMatchObject({ inputUsdPerMillion: 9, detectedModel: second });
    expect(resolvePricing(automatic, 99, rates, 101).inputUsdPerMillion).toBeNull();
    expect(resolvePricing(automatic, 99, rates, 101, { ...second, id: 'unknown' }).inputUsdPerMillion).toBeNull();
    expect(resolvePricing(automatic, 99, rates, 101, { ...second, vendor: 'other' }).inputUsdPerMillion).toBeNull();
  });
  it('matches Copilot model IDs to origin rates without treating a display name or Auto as identity', () => {
    const model = { id: 'claude-sonnet-4.6', vendor: 'copilot', name: 'Claude Sonnet 4.6' };
    const rate = { providerId: 'anthropic', providerName: 'Anthropic', modelId: 'claude-sonnet-4-6', modelName: model.name, input: 3 };
    const rates = { ...catalog, models: [rate] };
    const snapshot = resolvePricing({ mode: 'automatic' }, 99, rates, 101, model);
    expect(snapshot).toMatchObject({ mode: 'automatic', providerId: 'anthropic', modelId: rate.modelId, detectedModel: model, inputUsdPerMillion: 3 });
    expect(snapshot.detectedModel).not.toBe(model);
    expect(resolvePricing({ mode: 'automatic' }, 99, rates, 101, { ...model, id: 'auto' }).inputUsdPerMillion).toBeNull();
    expect(resolvePricing({ mode: 'automatic' }, 99, { ...rates, models: [rate, { ...rate, providerId: 'openai' }] }, 101, model).inputUsdPerMillion).toBeNull();
    expect(resolvePricing({ mode: 'automatic' }, 99, rates, PRICING_MAX_AGE_MS + 101, model).inputUsdPerMillion).toBeNull();
  });
  it('falls back to the undated catalog id for OpenAI-style dated snapshot models', () => {
    const model = { id: 'gpt-4o-mini-2024-07-18', vendor: 'copilot', name: 'gpt-4o-mini-2024-07-18' };
    const undatedRate = { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o-mini', modelName: 'GPT-4o mini', input: 0.15 };
    // A reseller entry that happens to carry the exact dated id must not win: it
    // is outside the Copilot-allowed provider list and must not confuse the fallback.
    const resellerRate = { providerId: 'openrouter', providerName: 'OpenRouter', modelId: 'gpt-4o-mini-2024-07-18', modelName: 'GPT-4o-mini (2024-07-18)', input: 0.2 };
    const rates = { ...catalog, models: [undatedRate, resellerRate] };
    expect(resolvePricing({ mode: 'automatic' }, 99, rates, 101, model)).toMatchObject({ providerId: 'openai', modelId: 'gpt-4o-mini', inputUsdPerMillion: 0.15 });
    // An exact dated match under an allowed provider still wins outright, no fallback needed.
    const exactRate = { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-4o-mini-2024-07-18', modelName: 'GPT-4o-mini (2024-07-18)', input: 0.18 };
    expect(resolvePricing({ mode: 'automatic' }, 99, { ...catalog, models: [exactRate, undatedRate] }, 101, model).inputUsdPerMillion).toBe(0.18);
    // No undated fallback for ids without a trailing date suffix.
    const undatedModel = { ...model, id: 'gpt-4o-mini' };
    expect(resolvePricing({ mode: 'automatic' }, 99, { ...catalog, models: [resellerRate] }, 101, undatedModel).inputUsdPerMillion).toBeNull();
  });
  it('distinguishes missing, ambiguous, and expired catalog rates without choosing a price', () => {
    const automatic = { mode: 'automatic' as const };
    const model = { id: 'gpt-4o-mini-2024-07-18', vendor: 'copilot', name: 'Mini' };
    const exact = { providerId: 'openai', providerName: 'OpenAI', modelId: model.id, modelName: model.name, input: 0.15 };
    const rates = { ...catalog, models: [exact] };
    expect(resolvePricing(automatic, 99, undefined, 101, model)).toMatchObject({ inputUsdPerMillion: null, reason: 'Catalog not loaded' });
    expect(resolvePricing(automatic, 99, catalog, 101, model)).toMatchObject({ inputUsdPerMillion: null, reason: 'Model not in catalog' });
    expect(resolvePricing(automatic, 99, rates, PRICING_MAX_AGE_MS + 101, model)).toMatchObject({ inputUsdPerMillion: null, reason: 'Catalog expired' });
    expect(resolvePricing(automatic, 99, { ...rates, models: [
      exact, { ...exact, providerId: 'google' }, { ...exact, modelId: 'gpt-4o-mini' },
    ] }, 101, model)).toMatchObject({ inputUsdPerMillion: null, reason: 'Ambiguous model match' });
    expect(resolvePricing(automatic, 99, { ...rates, models: [{ ...exact, input: NaN }] }, 101, model)).toMatchObject({
      inputUsdPerMillion: null, reason: 'Model input price unavailable',
    });
    expect(resolvePricing(automatic, 99, { ...rates, models: [{ ...exact, input: 0 }] }, 101, model)).toMatchObject({
      status: 'priced', inputUsdPerMillion: 0,
    });
    expect(resolvePricing(selection, 99, { ...catalog, models: [] }, 101).reason).toBe('Model not in catalog');
  });

  it('keeps automatic pricing configuration free of manual model and rate selections', () => {
    expect(validatePricing({ mode: 'automatic' })).toEqual({ mode: 'automatic' });
    for (const field of [{ modelId: 'model' }, { providerId: 'vendor' }, { inputRateOverride: 3 }]) {
      expect(() => validatePricing({ mode: 'automatic', ...field })).toThrow();
    }
  });
  it('estimates missing historical rates without changing recorded prices or rewriting history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-pricing-history-'));
    try {
      const entry = { ts: 1, tool: 'read_file', label: 'legacy', strategy: 'passthrough', tokensBefore: 100_000, tokensAfter: 10_000, bytesBefore: 100, bytesAfter: 10, linesBefore: 10, linesAfter: 1 };
      fs.writeFileSync(path.join(root, 'savings.jsonl'), JSON.stringify(entry) + '\n');
      const ledger = new SavingsLedger({ rootDir: root });
      ledger.record({ ...entry, ts: 2 });
      const recorded = fs.readFileSync(ledger.path(), 'utf8');
      ledger.updateTokenPrice(9);
      expect(ledger.summary().estimatedCostSavedUsd).toBeCloseTo(1.08);
      expect(ledger.summary().cost).toMatchObject({ coverage: 'partial', knownUsd: 0.27, fallbackUsdPerMillion: 9 });
      expect(ledger.summary().cost.fallbackUsd).toBeCloseTo(0.81);
      const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { usdPerMillionTokens: 9 } });
      const payload = buildSummaryPayload(engine);
      expect(payload.costAttribution.netUsd).toBeCloseTo(1.08);
      expect(payload.costAttribution.cost.unpricedEvents).toBe(1);
      expect(renderDashboardReportMarkdown(engine)).toContain('$1.08');
      expect(renderDashboardReportMarkdown(engine)).toContain('| Default-rate estimate | $0.81 |');
      expect(renderDashboardReportCsv(engine)).toContain('"priceCoverage","partial"');
      expect(renderDashboardReportCsv(engine)).toContain('"fallbackEstimatedSubtotalUsd","0.81"');
      expect(renderDashboardReportCsv(engine)).toContain('"fallbackUsdPerMillionTokens","9"');
      expect(ledger.recent()[0].pricing?.inputUsdPerMillion).toBe(3);
      expect(fs.readFileSync(ledger.path(), 'utf8')).toBe(recorded);
      engine.dispose();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves exact USD/M prices without using the manual default', () => {
    expect(resolvePricing(selection, 3, catalog, 101).inputUsdPerMillion).toBe(5);
    expect(resolvePricing({ ...selection, providerId: 'other' }, 3, catalog, 101).inputUsdPerMillion).toBeNull();
    expect(resolvePricing(selection, 3).inputUsdPerMillion).toBeNull();
  });
  it('supports explicit zero, override removal and manual mode', () => {
    expect(resolvePricing({ ...selection, inputRateOverride: 0 }, 3).inputUsdPerMillion).toBe(0);
    expect(resolvePricing({ ...selection, inputRateOverride: null }, 3, catalog, 101).inputUsdPerMillion).toBe(5);
    expect(resolvePricing({ mode: 'manual' }, 0).inputUsdPerMillion).toBe(0);
  });
  it('expires rates without losing provenance', () => {
    expect(resolvePricing(selection, 3, catalog, PRICING_MAX_AGE_MS + 101)).toMatchObject({ inputUsdPerMillion: null, revision: 'fixture', stale: true });
  });
  it('validates settings and environment rates', () => {
    for (const rate of [-1, NaN, Infinity, '3']) expect(() => validatePricing({ ...selection, inputRateOverride: rate })).toThrow();
    expect(() => validatePricing({ mode: 'catalog' })).toThrow();
    expect(() => pricingFromEnvironment({ SLIPSTREAM_USD_PER_MILLION: '' })).toThrow();
    expect(pricingFromEnvironment({ SLIPSTREAM_USD_PER_MILLION: '0' }).usdPerMillionTokens).toBe(0);
    expect(pricingFromEnvironment({}).pricing).toEqual({ mode: 'manual' });
  });
  it('honors the fallback rate while ignoring model overrides in automatic mode', () => {
    const config = pricingFromEnvironment({
      SLIPSTREAM_PRICING_MODE: 'automatic',
      SLIPSTREAM_PRICING_PROVIDER: 'previous-provider',
      SLIPSTREAM_PRICING_MODEL: 'previous-model',
      SLIPSTREAM_PRICING_INPUT_OVERRIDE: 'invalid-old-rate',
      SLIPSTREAM_USD_PER_MILLION: '7.125',
    });
    expect(config).toEqual({ pricing: { mode: 'automatic' }, usdPerMillionTokens: 7.125 });
    expect(resolvePricing(config.pricing, config.usdPerMillionTokens, catalog, 101).inputUsdPerMillion).toBeNull();
    expect(pricingFromEnvironment({ SLIPSTREAM_PRICING_MODE: 'automatic' }).usdPerMillionTokens).toBe(3);
    expect(pricingFromEnvironment({ SLIPSTREAM_PRICING_MODE: 'automatic', SLIPSTREAM_USD_PER_MILLION: '0' }).usdPerMillionTokens).toBe(0);
    expect(() => pricingFromEnvironment({ SLIPSTREAM_PRICING_MODE: 'automatic', SLIPSTREAM_USD_PER_MILLION: '-1' })).toThrow();
  });
  it.each([
    { mode: 'manual' as const },
    { ...selection, inputRateOverride: 0 },
  ])('normalizes proxied $mode settings into cloneable data', (value) => {
    const settings = new Proxy(Object.freeze(value), {});
    expect(() => structuredClone(settings)).toThrow();
    const normalized = validatePricing(settings);
    expect(normalized).toEqual(value);
    expect(normalized).not.toBe(settings);
    expect(() => structuredClone(normalized)).not.toThrow();
  });
  it('uses each event snapshot and keeps negative net and unknown subtotals', () => {
    const entries = [
      { tool: 'read_file', tokensBefore: 1000, tokensAfter: 0, pricing: resolvePricing({ mode: 'manual' }, 3) },
      { tool: 'retrieve_artifact', tokensBefore: 0, tokensAfter: 1000, pricing: resolvePricing({ mode: 'manual' }, 5) },
    ];
    expect(aggregateCost(entries).usd).toBe(0.003);
    expect(aggregateCost(entries, 'net').usd).toBeCloseTo(-0.002);
    expect(aggregateCost([...entries, { tool: 'read_file', tokensBefore: 10, tokensAfter: 0 }])).toMatchObject({ usd: null, knownUsd: 0.003, coverage: 'partial', unpricedTokens: 10 });
    expect(aggregateCost([{ tool: 'session', tokensBefore: 10, tokensAfter: 0 }]).usd).toBe(0);
    expect(aggregateCost([{ tool: 'read_file', tokensBefore: 10, tokensAfter: 0 }]).coverage).toBe('unpriced');
  });
});