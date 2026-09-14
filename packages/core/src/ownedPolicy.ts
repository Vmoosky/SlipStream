import type { CompressionProfile } from './compressionProfiles.js';
import { DEFAULT_PRESSURE_THRESHOLDS, validateCostPolicy, validatePressureThresholds, type CostPolicy, type PolicyModel, type PolicyPressureThresholds } from './costPolicy.js';
import { isTokenCount, PRICING_SOURCE, validRate, type PricingSnapshot } from './pricing.js';

export const OWNED_TASK_CATEGORIES = ['code', 'triage', 'summarize'] as const;
export type OwnedTaskCategory = typeof OWNED_TASK_CATEGORIES[number];
export const OWNED_POLICY_REASONS = ['pinned', 'current-retained', 'lower-reference-cost', 'insufficient-evidence',
  'no-compatible-model', 'unknown-input', 'context-limit', 'unknown-price', 'budget-limit', 'budget-required',
  'output-limit', 'policy-changed', 'recovery-failure'] as const;
export type OwnedPolicyReason = typeof OWNED_POLICY_REASONS[number];

export interface OwnedPolicyDecision {
  state: 'active' | 'paused';
  reason: OwnedPolicyReason;
  requestedModel?: PolicyModel;
  selectedModel?: PolicyModel;
  profile?: CompressionProfile;
}

export interface PolicyCandidate {
  model: PolicyModel;
  inputTokens: number | null;
  maxInputTokens: number;
  toolCalling: boolean;
  rates: PricingSnapshot;
  verifiedPasses: number;
  verifiedFailures: number;
}

export class PolicyPauseError extends Error {
  constructor(readonly reason: OwnedPolicyReason, message: string) {
    super(message);
    this.name = 'PolicyPauseError';
  }
}

export function guardedInputTokens(inputTokens: number | null): number {
  if (!isTokenCount(inputTokens)) throw new PolicyPauseError('unknown-input', 'Automatic task paused: input token count is unavailable.');
  const estimate = Math.ceil(inputTokens * 1.15) + 256;
  if (!isTokenCount(estimate)) throw new PolicyPauseError('unknown-input', 'Automatic task paused: input token allowance is invalid.');
  return estimate;
}

export function referenceAllowance(rates: PricingSnapshot, inputTokens: number, outputTokens: number): number | null {
  if (rates.status !== 'priced' || rates.stale || rates.mode !== 'automatic' || rates.source !== PRICING_SOURCE ||
    rates.revision === null || rates.fetchedAt === null || !validRate(rates.inputUsdPerMillion) || !validRate(rates.outputUsdPerMillion)) return null;
  const inputRate = Math.max(rates.inputUsdPerMillion, validRate(rates.cacheWriteUsdPerMillion) ? rates.cacheWriteUsdPerMillion : rates.inputUsdPerMillion);
  const total = (inputTokens * inputRate + outputTokens * rates.outputUsdPerMillion) / 1_000_000;
  return validRate(total) && total <= Number.MAX_SAFE_INTEGER ? total : null;
}

export function selectPolicyModel(candidates: readonly PolicyCandidate[], requested: PolicyModel, outputTokens: number, canSelect: boolean) {
  const compatible = candidates.filter((candidate) => {
    if (!candidate.toolCalling || !isTokenCount(candidate.maxInputTokens) || candidate.maxInputTokens === 0 || !isTokenCount(candidate.inputTokens)) return false;
    return guardedInputTokens(candidate.inputTokens) <= candidate.maxInputTokens;
  });
  const current = compatible.find((candidate) => candidate.model.vendor === requested.vendor && candidate.model.id === requested.id);
  if (!current) throw new PolicyPauseError('no-compatible-model', 'Automatic task paused: the selected model is not permitted, available, tool-capable, or large enough. No substitute was sent.');
  if (!canSelect) return { candidate: current, reason: 'pinned' as const };
  const proven = (candidate: PolicyCandidate) => candidate.verifiedPasses >= 3 && candidate.verifiedFailures === 0;
  const currentCost = referenceAllowance(current.rates, guardedInputTokens(current.inputTokens), outputTokens);
  if (!proven(current) || currentCost === null) return { candidate: current, reason: 'insufficient-evidence' as const };
  const ranked = compatible.filter((candidate) => proven(candidate) && candidate.rates.revision === current.rates.revision &&
    candidate.rates.fetchedAt === current.rates.fetchedAt).map((candidate) => ({ candidate,
    cost: referenceAllowance(candidate.rates, guardedInputTokens(candidate.inputTokens), outputTokens),
  })).filter((item): item is { candidate: PolicyCandidate; cost: number } => item.cost !== null)
    .sort((left, right) => left.cost - right.cost || left.candidate.model.vendor.localeCompare(right.candidate.model.vendor) || left.candidate.model.id.localeCompare(right.candidate.model.id));
  const best = ranked[0];
  return best && best.cost < currentCost
    ? { candidate: best.candidate, reason: 'lower-reference-cost' as const }
    : { candidate: current, reason: 'current-retained' as const };
}

export interface PolicyRecommendationRequest {
  category?: OwnedTaskCategory;
  requestedModel?: PolicyModel;
  inputTokens?: number;
  outputTokens?: number;
  pinned?: boolean;
}

export function parsePolicyRecommendationRequest(raw: unknown): PolicyRecommendationRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Recommendation inputs are required.');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['category', 'requestedModel', 'inputTokens', 'outputTokens', 'pinned'].includes(key))) throw new Error('Unknown recommendation input.');
  const request: PolicyRecommendationRequest = {};
  if (input.category !== undefined) {
    if (!OWNED_TASK_CATEGORIES.includes(input.category as OwnedTaskCategory)) throw new Error('Choose a supported task category.');
    request.category = input.category as OwnedTaskCategory;
  }
  if (input.requestedModel !== undefined) {
    if (!input.requestedModel || typeof input.requestedModel !== 'object' || Array.isArray(input.requestedModel) ||
      Object.keys(input.requestedModel).some((key) => key !== 'vendor' && key !== 'id')) throw new Error('Choose a baseline model.');
    request.requestedModel = validateCostPolicy({ version: 1, mode: 'recommend-only', allowedModels: [input.requestedModel] }).allowedModels[0];
  }
  if (input.inputTokens !== undefined) {
    if (!isTokenCount(input.inputTokens)) throw new Error('Input estimate must be a nonnegative whole number.');
    request.inputTokens = input.inputTokens;
  }
  if (input.outputTokens !== undefined) {
    if (!isTokenCount(input.outputTokens) || input.outputTokens === 0 || input.outputTokens > 32768) throw new Error('Output estimate must be between 1 and 32768 tokens.');
    request.outputTokens = input.outputTokens;
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== 'boolean') throw new Error('Baseline pin must be a boolean.');
    request.pinned = input.pinned;
  }
  return request;
}

export interface PolicyRecommendationCandidate {
  model: PolicyModel;
  available: boolean;
  inputTokens: number | null;
  maxInputTokens: number | null;
  toolCalling: boolean | null;
  referenceUsd: number | null;
  verifiedPasses: number | null;
  verifiedFailures: number | null;
  gaps: ('unavailable' | 'unknown-input' | 'context-limit' | 'tool-unsupported' | 'unknown-price' | 'incomparable-price' | 'insufficient-evidence' | 'verified-failure')[];
}

export interface PolicyRecommendation {
  state: 'off' | 'needs-input' | 'unavailable' | 'retain' | 'recommend';
  reason: OwnedPolicyReason | 'policy-off' | 'no-permitted-models' | 'task-details-required' | 'model-required';
  selectedModel?: PolicyModel;
  candidates: PolicyRecommendationCandidate[];
  timings?: { discoveryMs: number; evaluationMs: number };
}

export function recommendPolicyModel(policy: CostPolicy, candidates: readonly PolicyCandidate[], request: PolicyRecommendationRequest = {}): PolicyRecommendation {
  const sameModel = (left: PolicyModel, right: PolicyModel) => left.vendor === right.vendor && left.id === right.id;
  const permitted = candidates.filter((candidate) => policy.allowedModels.some((model) => sameModel(model, candidate.model)));
  const current = permitted.find((candidate) => request.requestedModel && sameModel(candidate.model, request.requestedModel));
  const outputTokens = request.outputTokens ?? policy.outputTokenAllowance ?? 2048;
  const hasCategory = OWNED_TASK_CATEGORIES.includes(request.category as OwnedTaskCategory);
  const hasOutput = isTokenCount(outputTokens) && outputTokens > 0 && outputTokens <= 32768;
  const rows = policy.allowedModels.map((model): PolicyRecommendationCandidate => {
    const candidate = permitted.find((item) => sameModel(item.model, model));
    if (!candidate) return { model, available: false, inputTokens: null, maxInputTokens: null, toolCalling: null,
      referenceUsd: null, verifiedPasses: null, verifiedFailures: null, gaps: ['unavailable'] };
    const gaps: PolicyRecommendationCandidate['gaps'] = [];
    let inputAllowance: number | null = null;
    try { inputAllowance = guardedInputTokens(candidate.inputTokens); } catch { gaps.push('unknown-input'); }
    if (!isTokenCount(candidate.maxInputTokens) || candidate.maxInputTokens === 0 || inputAllowance !== null && inputAllowance > candidate.maxInputTokens) gaps.push('context-limit');
    if (!candidate.toolCalling) gaps.push('tool-unsupported');
    const referenceUsd = inputAllowance !== null && hasOutput ? referenceAllowance(candidate.rates, inputAllowance, outputTokens) : null;
    if (referenceUsd === null) gaps.push('unknown-price');
    else if (current && (candidate.rates.revision !== current.rates.revision || candidate.rates.fetchedAt !== current.rates.fetchedAt)) gaps.push('incomparable-price');
    const verifiedPasses = hasCategory && isTokenCount(candidate.verifiedPasses) ? candidate.verifiedPasses : null;
    const verifiedFailures = hasCategory && isTokenCount(candidate.verifiedFailures) ? candidate.verifiedFailures : null;
    if (verifiedFailures !== null && verifiedFailures > 0) gaps.push('verified-failure');
    if (verifiedPasses === null || verifiedPasses < 3 || verifiedFailures === null) gaps.push('insufficient-evidence');
    return { model, available: true, inputTokens: isTokenCount(candidate.inputTokens) ? candidate.inputTokens : null,
      maxInputTokens: isTokenCount(candidate.maxInputTokens) ? candidate.maxInputTokens : null, toolCalling: candidate.toolCalling,
      referenceUsd, verifiedPasses, verifiedFailures, gaps };
  });
  const result = (state: PolicyRecommendation['state'], reason: PolicyRecommendation['reason'], selectedModel?: PolicyModel): PolicyRecommendation =>
    ({ state, reason, ...(selectedModel ? { selectedModel } : {}), candidates: rows });
  if (policy.mode === 'off') return result('off', 'policy-off');
  if (!policy.allowedModels.length) return result('unavailable', 'no-permitted-models');
  if (!hasCategory || !hasOutput) return result('needs-input', 'task-details-required');
  if (!request.requestedModel) return result('needs-input', 'model-required');
  const baseline = rows.find((row) => sameModel(row.model, request.requestedModel!));
  if (!current || !baseline || baseline.gaps.some((gap) => ['unavailable', 'context-limit', 'tool-unsupported'].includes(gap))) return result('unavailable', 'no-compatible-model');
  if (baseline.gaps.includes('unknown-input')) return result('needs-input', 'unknown-input');
  if (request.pinned) return result('retain', 'pinned', current.model);
  if (baseline.referenceUsd === null) return result('retain', 'unknown-price', current.model);
  const safeCandidates = permitted.filter((candidate) => rows.some((row) => sameModel(row.model, candidate.model) && row.gaps.length === 0));
  const selection = selectPolicyModel([current, ...safeCandidates.filter((candidate) => candidate !== current)], current.model, outputTokens, true);
  return result(selection.reason === 'lower-reference-cost' ? 'recommend' : 'retain', selection.reason, selection.candidate.model);
}

export function planOwnedCall(candidate: PolicyCandidate, unit: CostPolicy['budgetUnit'], limit: number | null, used: number, outputTokens: number) {
  if (!isTokenCount(outputTokens) || outputTokens === 0 || outputTokens > 32768) throw new PolicyPauseError('output-limit', 'Automatic task paused: the output allowance is invalid.');
  if (limit === null) throw new PolicyPauseError('budget-required', 'Automatic task paused: configure a task budget before starting owned calls.');
  const inputTokens = guardedInputTokens(candidate.inputTokens);
  if (inputTokens > candidate.maxInputTokens) throw new PolicyPauseError('context-limit', 'Automatic task paused: the next input exceeds the model context allowance.');
  const reservation = unit === 'tokens' ? inputTokens + outputTokens : referenceAllowance(candidate.rates, inputTokens, outputTokens);
  if (reservation === null) throw new PolicyPauseError('unknown-price', 'Automatic task paused: fresh input and output reference prices are required for a dollar budget.');
  if (!validRate(limit) || !validRate(used) || !validRate(reservation) || used + reservation > limit || !Number.isFinite(used + reservation)) {
    throw new PolicyPauseError('budget-limit', 'Automatic task paused: the next call does not fit the remaining local allowance. No additional model call was sent.');
  }
  return { reservation, pressure: limit > 0 ? (used + reservation) / limit : 1 };
}

export function choosePolicyProfile(current: CompressionProfile, permitted: readonly CompressionProfile[], pressure: number, recoveryFailed: boolean,
  thresholds: PolicyPressureThresholds = DEFAULT_PRESSURE_THRESHOLDS): CompressionProfile {
  const limits = validatePressureThresholds(thresholds);
  const ordered = (['conservative', 'balanced', 'aggressive'] as const).filter((profile) => permitted.includes(profile));
  if (!ordered.length) throw new PolicyPauseError('no-compatible-model', 'Automatic task paused: no compression profile is permitted.');
  if (recoveryFailed) return ordered[0]!;
  const target = pressure >= limits.aggressive ? 'aggressive' : pressure >= limits.balanced ? 'balanced' : current;
  return ordered.includes(target) ? target : permitted.includes(current) ? current : ordered[0]!;
}