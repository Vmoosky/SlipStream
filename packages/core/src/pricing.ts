import type { ModelObservation, ToolObservation, ToolCallContext } from './types.js';

export const PRICING_SOURCE = 'https://models.dev/api.json';
export const PRICING_FRESH_MS = 24 * 60 * 60 * 1000;
export const PRICING_MAX_AGE_MS = 7 * PRICING_FRESH_MS;

export interface PricingConfig {
  mode: 'automatic' | 'manual' | 'catalog';
  providerId?: string;
  modelId?: string;
  inputRateOverride?: number | null;
}

export interface DetectedModel {
  id: string;
  vendor: string;
  name: string;
}

export interface ModelRate {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  input: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  toolCalling?: boolean;
}

export interface PricingCatalog {
  version: 1;
  fetchedAt: number;
  revision: string;
  models: ModelRate[];
}

export interface PricingSnapshot {
  basis: 'public-api-reference';
  mode: PricingConfig['mode'];
  providerId?: string;
  modelId?: string;
  detectedModel?: DetectedModel;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion?: number | null;
  cacheReadUsdPerMillion?: number | null;
  cacheWriteUsdPerMillion?: number | null;
  toolCalling?: boolean;
  source: string;
  fetchedAt: number | null;
  revision: string | null;
  stale: boolean;
  status: 'priced' | 'unavailable';
  reason?: string;
  assumption: 'standard-uncached-input';
}

export function validRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validatePricing(value: unknown): PricingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pricing configuration');
  const config = value as PricingConfig;
  if (!['automatic', 'manual', 'catalog'].includes(config.mode)) throw new Error('Unknown pricing mode');
  if (config.mode === 'automatic' && Object.keys(config).some((key) => key !== 'mode')) throw new Error('Automatic pricing does not accept a model or rate override');
  for (const key of ['providerId', 'modelId'] as const) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || !config[key]!.trim() || config[key]!.length > 300)) {
      throw new Error(`Invalid pricing ${key}`);
    }
  }
  if (config.mode === 'catalog' && (!config.providerId || !config.modelId)) throw new Error('Select a pricing provider and model');
  if (config.inputRateOverride != null && !validRate(config.inputRateOverride)) throw new Error('Invalid input rate override');
  if (Object.keys(config).some((key) => !['mode', 'providerId', 'modelId', 'inputRateOverride'].includes(key))) throw new Error('Unknown pricing setting');
  return { ...config };
}

export function pricingFromEnvironment(env: NodeJS.ProcessEnv): { pricing: PricingConfig; usdPerMillionTokens: number } {
  const readRate = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    if (!raw.trim() || !validRate(Number(raw))) throw new Error(`Invalid ${name}`);
    return Number(raw);
  };
  if (env.SLIPSTREAM_PRICING_MODE === 'automatic') {
    return { pricing: { mode: 'automatic' }, usdPerMillionTokens: readRate('SLIPSTREAM_USD_PER_MILLION') ?? 3 };
  }
  return {
    pricing: validatePricing({
      mode: env.SLIPSTREAM_PRICING_MODE ?? 'manual',
      ...(env.SLIPSTREAM_PRICING_PROVIDER ? { providerId: env.SLIPSTREAM_PRICING_PROVIDER } : {}),
      ...(env.SLIPSTREAM_PRICING_MODEL ? { modelId: env.SLIPSTREAM_PRICING_MODEL } : {}),
      ...(env.SLIPSTREAM_PRICING_INPUT_OVERRIDE?.trim() ? { inputRateOverride: readRate('SLIPSTREAM_PRICING_INPUT_OVERRIDE') } : {}),
    }),
    usdPerMillionTokens: readRate('SLIPSTREAM_USD_PER_MILLION') ?? 3,
  };
}

export function resolvePricing(config: PricingConfig, manualRate: number, catalog?: PricingCatalog, now = Date.now(), detectedModel?: DetectedModel): PricingSnapshot {
  const base: PricingSnapshot = {
    basis: 'public-api-reference', mode: config.mode,
    ...(config.mode === 'catalog' ? { providerId: config.providerId, modelId: config.modelId } : {}),
    ...(config.mode === 'automatic' && detectedModel ? { detectedModel: { ...detectedModel } } : {}),
    inputUsdPerMillion: null, source: 'manual', fetchedAt: null, revision: null,
    stale: false, status: 'unavailable', assumption: 'standard-uncached-input',
  };
  if (config.mode !== 'automatic' && (config.mode === 'manual' || config.inputRateOverride != null)) {
    const rate = config.mode === 'manual' ? manualRate : config.inputRateOverride;
    return { ...base, inputUsdPerMillion: validRate(rate) ? rate : null,
      source: config.mode === 'manual' ? 'manual' : 'manual-override',
      status: validRate(rate) ? 'priced' : 'unavailable' };
  }
  base.source = PRICING_SOURCE;
  if (config.mode === 'automatic' && !detectedModel) return { ...base, reason: 'The host did not supply a request model' };
  if (!catalog) return { ...base, reason: 'Catalog not loaded' };
  base.fetchedAt = catalog.fetchedAt;
  base.revision = catalog.revision;
  base.stale = now - catalog.fetchedAt > PRICING_FRESH_MS;
  if (now - catalog.fetchedAt > PRICING_MAX_AGE_MS || catalog.fetchedAt > now) return { ...base, reason: 'Catalog expired' };
  const match = config.mode === 'automatic'
    ? findDetectedRate(detectedModel!, catalog.models)
    : { rate: catalog.models.find((entry) => entry.providerId === config.providerId && entry.modelId === config.modelId) };
  if (!match.rate) return { ...base, reason: match.reason ?? 'Model not in catalog' };
  const model = match.rate;
  if (!validRate(model.input)) return { ...base, reason: 'Model input price unavailable' };
  return {
    ...base, providerId: model.providerId, modelId: model.modelId, inputUsdPerMillion: model.input, status: 'priced',
    outputUsdPerMillion: validRate(model.output) ? model.output : null,
    cacheReadUsdPerMillion: validRate(model.cacheRead) ? model.cacheRead : null,
    cacheWriteUsdPerMillion: validRate(model.cacheWrite) ? model.cacheWrite : null,
    ...(typeof model.toolCalling === 'boolean' ? { toolCalling: model.toolCalling } : {}),
  };
}

export interface ReportedModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface ModelUsageCost {
  usd: number | null;
  knownUsd: number;
  coverage: 'complete' | 'partial' | 'unavailable';
  reason: string | null;
}

export interface ModelInputCost extends ModelUsageCost {
  uncachedInputTokens: number | null;
  uncachedUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  standardUncachedUsd: number | null;
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function priceReportedUsage(snapshot: PricingSnapshot, usage: ReportedModelUsage): ModelUsageCost {
  const { usd, knownUsd, coverage, reason } = priceUsage(snapshot, usage, true);
  return { usd, knownUsd, coverage, reason };
}

export function priceReportedInput(snapshot: PricingSnapshot | undefined, usage: ReportedModelUsage): ModelInputCost {
  return priceUsage(snapshot, usage, false);
}

function priceUsage(snapshot: PricingSnapshot | undefined, usage: ReportedModelUsage, includeOutput: boolean): ModelInputCost {
  const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = usage;
  const counts = [inputTokens, cacheReadInputTokens, cacheCreationInputTokens, ...(includeOutput ? [outputTokens] : [])];
  const unavailable = (reason: string): ModelInputCost => ({
    usd: null, knownUsd: 0, coverage: 'unavailable', reason,
    uncachedInputTokens: null, uncachedUsd: null, cacheReadUsd: null, cacheWriteUsd: null, standardUncachedUsd: null,
  });
  if (counts.some((value) => value !== undefined && !isTokenCount(value))) {
    return unavailable('Invalid token usage');
  }
  if (inputTokens !== undefined && (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0) > inputTokens) {
    return unavailable('Inconsistent cached-input counts');
  }
  const uncached = inputTokens === 0 ? 0 : inputTokens !== undefined && cacheReadInputTokens !== undefined && cacheCreationInputTokens !== undefined
    ? inputTokens - cacheReadInputTokens - cacheCreationInputTokens : undefined;
  const charge = (tokens: number | undefined, rate: number | null | undefined): number | null => {
    if (tokens === 0) return 0;
    if (tokens === undefined || !validRate(rate)) return null;
    const cost = tokens / 1_000_000 * rate;
    return Number.isFinite(cost) ? cost : null;
  };
  const uncachedUsd = charge(uncached, snapshot?.inputUsdPerMillion);
  const cacheReadUsd = charge(inputTokens === 0 ? 0 : cacheReadInputTokens, snapshot?.cacheReadUsdPerMillion);
  const cacheWriteUsd = charge(inputTokens === 0 ? 0 : cacheCreationInputTokens, snapshot?.cacheWriteUsdPerMillion);
  const parts = [
    uncachedUsd, cacheReadUsd, cacheWriteUsd,
    ...(includeOutput ? [charge(outputTokens, snapshot?.outputUsdPerMillion)] : []),
  ];
  const knownUsd = parts.reduce<number>((total, part) => total + (part ?? 0), 0);
  if (!Number.isFinite(knownUsd)) return unavailable('Reference cost exceeds numeric limits');
  const complete = parts.every((part) => part !== null);
  return {
    usd: complete ? knownUsd : null, knownUsd,
    coverage: complete ? 'complete' : parts.some((part) => part !== null) ? 'partial' : 'unavailable',
    reason: complete ? null : counts.some((value) => value === undefined) ? 'Missing token usage' : 'Missing model rates',
    uncachedInputTokens: uncached ?? null, uncachedUsd, cacheReadUsd, cacheWriteUsd,
    standardUncachedUsd: charge(inputTokens, snapshot?.inputUsdPerMillion),
  };
}

function findDetectedRate(model: DetectedModel, rates: readonly ModelRate[]): { rate?: ModelRate; reason?: string } {
  const copilot = model.vendor === 'copilot' || model.vendor === 'github-copilot';
  const aliases: Record<string, string> = {
    'claude-sonnet-4.5': 'claude-sonnet-4-5',
    'claude-sonnet-4.6': 'claude-sonnet-4-6',
    'claude-opus-4.5': 'claude-opus-4-5',
    'claude-opus-4.6': 'claude-opus-4-6',
    'claude-haiku-4.5': 'claude-haiku-4-5',
  };
  const modelId = copilot ? aliases[model.id] ?? model.id : model.id;
  const providerAllowed = (rate: ModelRate): boolean => copilot
    ? ['anthropic', 'openai', 'google', 'xai'].includes(rate.providerId)
    : rate.providerId === model.vendor;
  // Copilot sometimes reports an OpenAI-style dated snapshot id (e.g.
  // "gpt-4o-mini-2024-07-18"); the catalog's canonical provider entry is
  // usually undated ("gpt-4o-mini"), with the dated id only present under
  // third-party resellers. Retry against the undated id before giving up.
  const undated = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  for (const candidate of undated === modelId ? [modelId] : [modelId, undated]) {
    const matches = rates.filter((rate) => rate.modelId === candidate && providerAllowed(rate));
    if (matches.length === 1) return { rate: matches[0] };
    if (matches.length > 1) return { reason: 'Ambiguous model match' };
  }
  return {};
}

export interface CostTotal {
  usd: number | null;
  knownUsd: number;
  fallbackUsd: number;
  fallbackUsdPerMillion: number | null;
  coverage: 'complete' | 'partial' | 'unpriced';
  pricedEvents: number;
  unpricedEvents: number;
  pricedTokens: number;
  unpricedTokens: number;
}

interface CostEntry {
  tool: string;
  tokensBefore: number;
  tokensAfter: number;
  pricing?: PricingSnapshot;
  ts?: number;
  toolCall?: ToolCallContext;
  modelObservation?: ModelObservation;
  toolObservation?: ToolObservation;
  telemetryConflict?: { traceId: string; spanId: string };
  telemetrySource?: ToolCallContext['source'];
}

export function attributeSavingsPricing<Entry extends CostEntry>(entries: readonly Entry[]): Entry[] {
  const modelSpans = new Map<string, CostEntry>();
  const toolSpans = new Map<string, CostEntry>();
  const models = new Map<string, CostEntry[]>();
  const tools = new Map<string, CostEntry[]>();
  const conflictingTraces = new Set<string>();
  const callIds = new Map<string, Set<string>>();
  const key = (...parts: unknown[]) => JSON.stringify(parts);
  const session = (value: ToolObservation | ModelObservation) => value.chatSessionId ?? value.conversationId;
  const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
  const rawCallId = (context: ToolCallContext) => context.source === 'vscode'
    ? context.toolCallId.replace(/__vscode-\d+$/, '') : context.toolCallId;
  const contextKey = (context: ToolCallContext) => key(context.source, context.sessionId, context.toolName, rawCallId(context));
  const validContext = (context: ToolCallContext | undefined): context is ToolCallContext => !!context
    && (context.source === 'vscode' || context.source === 'cli')
    && [context.sessionId, context.toolName, context.toolCallId].every(validText);
  const store = (target: Map<string, CostEntry>, identity: string, entry: CostEntry, traceId: string) => {
    const previous = target.get(identity);
    if (previous === undefined) target.set(identity, entry);
    else if (key(previous.modelObservation, previous.toolObservation, previous.pricing) !== key(entry.modelObservation, entry.toolObservation, entry.pricing)) {
      conflictingTraces.add(key(entry.telemetrySource, traceId));
    }
  };
  for (const entry of entries) {
    if (entry.tool !== 'session' && validContext(entry.toolCall)) {
      const identity = contextKey(entry.toolCall);
      const ids = callIds.get(identity) ?? new Set<string>();
      ids.add(entry.toolCall.toolCallId);
      callIds.set(identity, ids);
    }
    const source = entry.telemetrySource;
    if (entry.tool !== 'session' || (source !== 'vscode' && source !== 'cli')) continue;
    if (entry.telemetryConflict) conflictingTraces.add(key(source, entry.telemetryConflict.traceId));
    const observation = entry.modelObservation;
    if (observation) {
      store(modelSpans, key(source, observation.traceId, observation.spanId), entry, observation.traceId);
    }
    const tool = entry.toolObservation;
    if (tool) store(toolSpans, key(source, tool.traceId, tool.spanId), entry, tool.traceId);
  }
  for (const [identity, entry] of modelSpans) {
    const observation = entry.modelObservation!;
    if (toolSpans.has(identity)) conflictingTraces.add(key(entry.telemetrySource, observation.traceId));
    if (!validText(observation.parentSpanId) || !Array.isArray(observation.responseToolCalls) || observation.responseToolCalls.length > 128) continue;
    for (const call of observation.responseToolCalls) {
      if (!call || !validText(call.id) || !validText(call.name)) continue;
      const identity = key(entry.telemetrySource, observation.traceId, observation.parentSpanId, call.name, call.id);
      const group = models.get(identity) ?? [];
      group.push(entry);
      models.set(identity, group);
    }
  }
  for (const entry of toolSpans.values()) {
    const tool = entry.toolObservation!;
    const identity = key(entry.telemetrySource, tool.toolName, tool.toolCallId);
    const group = tools.get(identity) ?? [];
    group.push(entry);
    tools.set(identity, group);
  }
  return entries.map((entry) => {
    const context = entry.toolCall;
    if (entry.tool === 'session' || entry.pricing?.status === 'priced' && validRate(entry.pricing.inputUsdPerMillion)
      || entry.pricing && entry.pricing.mode !== 'automatic'
      || !validContext(context) || callIds.get(contextKey(context))?.size !== 1 || !Number.isFinite(entry.ts)) return entry;
    const group = tools.get(key(context.source, context.toolName, rawCallId(context)));
    const matches = (group ?? []).flatMap((toolEntry) => {
      const tool = toolEntry.toolObservation!;
      const candidates = models.get(key(context.source, tool.traceId, tool.parentSpanId, tool.toolName, tool.toolCallId)) ?? [];
      return candidates.filter((candidate) => {
        const observation = candidate.modelObservation!;
        return observation.conversationId === context.sessionId || observation.chatSessionId === context.sessionId;
      }).map((model) => ({ tool, model, candidateCount: candidates.length }));
    });
    if (matches.length !== 1 || matches[0]!.candidateCount !== 1) return entry;
    const { tool, model } = matches[0]!;
    const observation = model.modelObservation!;
    const pricing = model.pricing;
    const modelId = observation.responseModel ?? observation.requestModel;
    const vendor = observation.provider === 'github' ? 'copilot' : observation.provider;
    if (conflictingTraces.has(key(context.source, tool.traceId)) || !tool.success || !session(tool) || session(tool) !== session(observation)
      || !pricing || pricing.mode !== 'automatic' || pricing.status !== 'priced' || !validRate(pricing.inputUsdPerMillion)
      || pricing.detectedModel?.id !== modelId || pricing.detectedModel?.vendor !== vendor
      || ![tool.startedAt, tool.endedAt, observation.startedAt, observation.endedAt].every(Number.isFinite)
      || observation.startedAt > observation.endedAt || observation.endedAt > tool.startedAt
      || entry.ts! < tool.startedAt || entry.ts! > tool.endedAt) return entry;
    return { ...entry, pricing: { ...pricing, detectedModel: pricing.detectedModel ? { ...pricing.detectedModel } : undefined } };
  });
}

export function aggregateCost(entries: readonly CostEntry[], kind: 'gross' | 'retrieval' | 'net' = 'gross', fallbackUsdPerMillion?: number): CostTotal {
  if (fallbackUsdPerMillion !== undefined && !validRate(fallbackUsdPerMillion)) throw new Error('Invalid fallback token price');
  const result: CostTotal = { usd: 0, knownUsd: 0, fallbackUsd: 0, fallbackUsdPerMillion: fallbackUsdPerMillion ?? null,
    coverage: 'complete', pricedEvents: 0, unpricedEvents: 0, pricedTokens: 0, unpricedTokens: 0 };
  for (const entry of attributeSavingsPricing(entries)) {
    if (entry.tool === 'session') continue;
    const retrieval = entry.tool === 'retrieve_artifact';
    if ((kind === 'gross' && retrieval) || (kind === 'retrieval' && !retrieval)) continue;
    const tokens = retrieval ? entry.tokensAfter * (kind === 'net' ? -1 : 1) : entry.tokensBefore - entry.tokensAfter;
    if (tokens === 0) continue;
    const rate = entry.pricing?.inputUsdPerMillion;
    if (entry.pricing?.status === 'priced' && validRate(rate)) {
      result.knownUsd += tokens * rate / 1_000_000;
      result.pricedEvents++;
      result.pricedTokens += Math.abs(tokens);
    } else {
      result.unpricedEvents++;
      result.unpricedTokens += Math.abs(tokens);
      if (fallbackUsdPerMillion !== undefined) result.fallbackUsd += tokens * fallbackUsdPerMillion / 1_000_000;
    }
  }
  result.usd = result.unpricedEvents && fallbackUsdPerMillion === undefined ? null : result.knownUsd + result.fallbackUsd;
  result.coverage = result.unpricedEvents ? (result.pricedEvents ? 'partial' : 'unpriced') : 'complete';
  return result;
}

export function formatCost(value: number | null, digits = 2): string {
  return value === null ? 'N/A' : `$${value.toFixed(digits)}`;
}