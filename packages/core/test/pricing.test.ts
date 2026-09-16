import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SavingsLedger } from '../src/savingsLedger.js';
import { CompressionEngine } from '../src/engine.js';
import { buildDetailPayload, buildSummaryPayload, renderDashboardReportCsv, renderDashboardReportJson, renderDashboardReportMarkdown } from '../src/dashboard.js';
import { aggregateCost, priceReportedInput, priceReportedUsage, pricingFromEnvironment, resolvePricing, validatePricing, PRICING_MAX_AGE_MS, type PricingCatalog } from '../src/pricing.js';

const catalog: PricingCatalog = { version: 1, fetchedAt: 100, revision: 'fixture', models: [
  { providerId: 'vendor', providerName: 'Vendor', modelId: 'model', modelName: 'Model', input: 5 },
] };
const selection = { mode: 'catalog' as const, providerId: 'vendor', modelId: 'model' };

function attributedRequest() {
  const pricing = resolvePricing({ mode: 'automatic' }, 3, catalog, 101, { id: 'model', vendor: 'vendor', name: 'Model' });
  const output = { ts: 105, tool: 'read_file', label: 'output', strategy: 'code', tokensBefore: 100_000, tokensAfter: 10_000,
    bytesBefore: 100, bytesAfter: 10, linesBefore: 10, linesAfter: 1,
    pricing: resolvePricing({ mode: 'automatic' }, 3),
    toolCall: { source: 'vscode' as const, sessionId: 'native-session', toolCallId: 'call-one__vscode-123', toolName: 'slipstream_readFile' } };
  const model = { ...output, tool: 'session', toolCall: undefined, tokensBefore: 0, tokensAfter: 0, pricing,
    telemetrySource: 'vscode' as const,
    modelObservation: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'f'.repeat(16),
      conversationId: 'native-session', chatSessionId: 'host-session', provider: 'vendor', requestModel: 'model',
      startedAt: 101, endedAt: 103, responseToolCalls: [{ id: 'call-one', name: 'slipstream_readFile' }] } };
  const tool = { ...model, modelObservation: undefined, pricing: undefined,
    toolObservation: { traceId: 'a'.repeat(32), spanId: 'c'.repeat(16),
    parentSpanId: 'f'.repeat(16), conversationId: 'host-session', chatSessionId: 'host-session', startedAt: 104, endedAt: 106,
    success: true, toolCallId: 'call-one', toolName: 'slipstream_readFile' } };
  const nextModel = { ...model, pricing: { ...pricing, inputUsdPerMillion: 9 }, modelObservation: {
    ...model.modelObservation, responseToolCalls: undefined, spanId: 'd'.repeat(16), startedAt: 107, endedAt: 109 } };
  return { output, model, tool, nextModel };
}

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

  it('attributes exact tool calls using the calling request rate without changing events', () => {
    const { output, model, tool, nextModel } = attributedRequest();
    const entries = [output, model, tool, nextModel];
    const original = JSON.stringify(entries);
    expect(aggregateCost(entries, 'gross', 3)).toMatchObject({ usd: 0.45, knownUsd: 0.45, fallbackUsd: 0,
      pricedEvents: 1, unpricedEvents: 0, pricedTokens: 90_000, coverage: 'complete' });
    expect(aggregateCost([...entries].reverse(), 'gross', 99).usd).toBe(0.45);
    expect(aggregateCost([...entries, model, tool], 'gross', 99).usd).toBe(0.45);
    expect(JSON.stringify(entries)).toBe(original);
    expect(aggregateCost([{ ...output, pricing: resolvePricing({ mode: 'manual' }, 7) }, model, tool, nextModel], 'gross', 3).usd).toBe(0.63);
  });

  it('reconciles late attribution across dashboard groups and reports without changing event identities or history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-attributed-pricing-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' }, usdPerMillionTokens: 3 } });
    try {
      const { output, model, tool, nextModel } = attributedRequest();
      engine.ledger.record(output);
      const pending = buildSummaryPayload(engine);
      const originalId = pending.events[0]!.eventId;
      expect(pending.summary.cost.fallbackUsd).toBe(0.27);
      engine.ledger.record(tool);
      engine.ledger.record(model);
      engine.ledger.record({ ...output, label: 'unmatched', toolCall: undefined, tokensBefore: 20_000 });
      engine.ledger.record({ ...output, ts: 110, tool: 'retrieve_artifact', label: 'retrieval', tokensBefore: 0,
        toolCall: { ...output.toolCall, toolCallId: 'retrieve-one__vscode-124', toolName: 'slipstream_retrieveArtifact' } });
      engine.ledger.record({ ...nextModel, modelObservation: { ...nextModel.modelObservation,
        responseToolCalls: [{ id: 'retrieve-one', name: 'slipstream_retrieveArtifact' }] } });
      engine.ledger.record({ ...tool, toolObservation: { ...tool.toolObservation, spanId: 'e'.repeat(16),
        toolCallId: 'retrieve-one', toolName: 'slipstream_retrieveArtifact', startedAt: 109, endedAt: 111 } });
      const recorded = fs.readFileSync(engine.ledger.path(), 'utf8');
      const payload = buildSummaryPayload(engine);
      expect(payload.summary.estimatedCostSavedUsd).toBeCloseTo(0.48);
      expect(payload.costAttribution.grossUsd).toBeCloseTo(0.48);
      expect(payload.costAttribution.retrievalUsd).toBeCloseTo(0.09);
      expect(payload.costAttribution.netUsd).toBeCloseTo(0.39);
      expect(payload.costAttribution.cost).toMatchObject({ pricedEvents: 2, unpricedEvents: 1, fallbackUsd: 0.03 });
      expect(payload.costAttribution.buckets.reduce((total, bucket) => total + (bucket.usd ?? 0), 0)).toBeCloseTo(0.48);
      expect(payload.costAttribution.models.reduce((total, group) => total + (group.cost.usd ?? 0), 0)).toBeCloseTo(0.39);
      expect(payload.events.find((entry) => entry.tool === 'read_file' && entry.label === 'output')?.eventId).toBe(originalId);
      expect(renderDashboardReportMarkdown(engine)).toContain('| Default-rate estimate | $0.03 |');
      expect(renderDashboardReportCsv(engine)).toContain('"fallbackEstimatedSubtotalUsd","0.03"');
      engine.ledger.updateTokenPrice(7);
      const updated = buildSummaryPayload(engine);
      expect(updated.summary.estimatedCostSavedUsd).toBeCloseTo(0.52);
      expect(updated.summary.cost.knownUsd).toBe(0.45);
      expect(updated.events.find((entry) => entry.tool === 'read_file' && entry.label === 'output')?.eventId).toBe(originalId);
      const reopened = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' }, usdPerMillionTokens: 3 } });
      try {
        expect(buildSummaryPayload(reopened).costAttribution).toEqual(payload.costAttribution);
      } finally { reopened.dispose(); }
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(recorded);
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps fallback for incomplete, conflicting, or unrelated request evidence', () => {
    const { output, model, tool, nextModel } = attributedRequest();
    const variants = [
      [output, tool, nextModel],
      [output, model, nextModel],
      [output, { ...model, modelObservation: { ...model.modelObservation, responseToolCalls: undefined } }, tool],
      [output, { ...model, pricing: undefined }, tool],
      [output, { ...model, modelObservation: { ...model.modelObservation, responseModel: 'other-model' } }, tool],
      [output, model, { ...tool, telemetrySource: 'cli' as const }],
      [output, model, { ...tool, toolObservation: { ...tool.toolObservation, parentSpanId: 'e'.repeat(16) } }],
      [output, model, { ...tool, toolObservation: { ...tool.toolObservation, chatSessionId: 'another-session' } }],
      [output, model, { ...tool, toolObservation: { ...tool.toolObservation, toolCallId: 'another-call' } }],
      [output, model, { ...tool, toolObservation: { ...tool.toolObservation, success: false } }],
      [{ ...output, ts: 200 }, model, tool],
      [output, { ...output, toolCall: { ...output.toolCall, toolCallId: 'call-one__vscode-456' } }, model, tool],
      [output, model, { ...model, modelObservation: { ...model.modelObservation, spanId: 'e'.repeat(16) } }, tool],
      [output, model, { ...model, modelObservation: { ...model.modelObservation, spanId: 'e'.repeat(16), conversationId: 'another-session' } }, tool],
      [output, model, tool, { ...tool, toolObservation: { ...tool.toolObservation, spanId: 'e'.repeat(16) } }],
      [output, model, { ...tool, toolObservation: { ...tool.toolObservation, spanId: model.modelObservation.spanId } }],
    ];
    for (const entries of variants) {
      const cost = aggregateCost(entries, 'gross', 3);
      expect(cost.knownUsd).toBe(0);
      expect(cost.fallbackUsd).toBeGreaterThan(0);
      expect(cost.coverage).toBe('unpriced');
    }
  });

  it('separates concurrent conversations with reused tool IDs and retains recorded zero rates', () => {
    const { output, model, tool } = attributedRequest();
    const otherOutput = { ...output, toolCall: { ...output.toolCall, sessionId: 'another-session', toolCallId: 'call-one__vscode-456' } };
    const otherModel = { ...model, pricing: { ...model.pricing, inputUsdPerMillion: 0 }, modelObservation: {
      ...model.modelObservation, traceId: 'e'.repeat(32), conversationId: 'another-session', chatSessionId: 'another-host',
    } };
    const otherTool = { ...tool, toolObservation: { ...tool.toolObservation, traceId: 'e'.repeat(32),
      conversationId: 'another-host', chatSessionId: 'another-host' } };
    expect(aggregateCost([otherTool, output, otherModel, tool, otherOutput, model], 'gross', 99)).toMatchObject({
      knownUsd: 0.45, fallbackUsd: 0, pricedEvents: 2, pricedTokens: 180_000, unpricedEvents: 0,
    });
  });

  it('keeps request correlation metadata out of dashboard payloads and share reports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-pricing-privacy-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } } });
    try {
      const { output, model, tool } = attributedRequest();
      engine.ledger.record(output);
      const originalId = buildSummaryPayload(engine).events[0]!.eventId;
      engine.ledger.record({ ...model, sessionId: 'copilot-otel:native-session' });
      engine.ledger.record({ ...tool, sessionId: 'copilot-otel:native-session' });
      const payload = buildSummaryPayload(engine);
      const event = payload.events.find((entry) => entry.tool === 'read_file')!;
      expect(event.eventId).toBe(originalId);
      expect(event.pricing?.inputUsdPerMillion).toBe(5);
      expect(buildDetailPayload(engine, event.ts, originalId)?.eventId).toBe(originalId);
      expect(payload.modelObservation).toMatchObject({ provider: 'vendor', requestModel: 'model', endedAt: 103 });
      for (const report of [JSON.stringify(payload), renderDashboardReportJson(engine), renderDashboardReportCsv(engine), renderDashboardReportMarkdown(engine)]) {
        for (const identity of ['native-session', 'host-session', 'call-one', 'a'.repeat(32), 'b'.repeat(16), 'f'.repeat(16)]) {
          expect(report).not.toContain(identity);
        }
      }
      const recorded = fs.readFileSync(engine.ledger.path(), 'utf8');
      expect(recorded).toContain('native-session');
      expect(recorded).toContain('call-one__vscode-123');
      expect(engine.ledger.all()[0]!.pricing?.inputUsdPerMillion).toBeNull();
    } finally {
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
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