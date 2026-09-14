import { validatePricing, validRate, type PricingConfig } from '@slipstream/core';

export interface ProducerPricing {
  pricing: PricingConfig;
  usdPerMillionTokens: number;
}

export function parseProducerPricing(value: unknown): ProducerPricing {
  if (value === undefined) return { pricing: { mode: 'manual', providerId: undefined, modelId: undefined, inputRateOverride: null }, usdPerMillionTokens: 3 };
  if (!value || typeof value !== 'object') throw new Error('Invalid producer pricing');
  const input = value as ProducerPricing;
  if (!validRate(input.usdPerMillionTokens)) throw new Error('Invalid producer token price');
  return { pricing: { providerId: undefined, modelId: undefined, inputRateOverride: null, ...validatePricing(input.pricing) }, usdPerMillionTokens: input.usdPerMillionTokens };
}

export interface PostToolUseInput {
  sessionId: string;
  timestamp: number;
  cwd: string;
  toolName: string;
  toolArgs: unknown;
  toolResult: {
    resultType: 'success';
    textResultForLlm: string;
  };
}

export interface PostToolUseOutput {
  modifiedResult?: {
    resultType: 'success';
    textResultForLlm: string;
  };
}

export interface UserPromptSubmittedInput {
  sessionId: string;
  timestamp: number;
  cwd: string;
}

export type DaemonRequest =
  | { type: 'compress'; input: PostToolUseInput; producerPricing?: ProducerPricing }
  | { type: 'chat'; input: UserPromptSubmittedInput; producerPricing?: ProducerPricing }
  | { type: 'release'; sessionId: string }
  | { type: 'sync-model-tracking' }
  | { type: 'reset' }
  | { type: 'purge' };

export type DaemonResponse =
  | { ok: true; output: PostToolUseOutput }
  | { ok: true; modelTracking: { port: number } }
  | { ok: true; reset: { sessions: number } }
  | { ok: true; purge: { artifacts: number } }
  | { ok: false; error: string };

export function parsePostToolUseInput(value: unknown): PostToolUseInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Hook input must be an object.');
  }
  const input = value as Record<string, unknown>;
  const toolResult = input['toolResult'];
  if (!toolResult || typeof toolResult !== 'object') {
    throw new Error('Hook input is missing toolResult.');
  }
  const result = toolResult as Record<string, unknown>;
  if (result['resultType'] !== 'success' || typeof result['textResultForLlm'] !== 'string') {
    throw new Error('Hook input must contain a successful textual tool result.');
  }
  for (const key of ['sessionId', 'cwd', 'toolName'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      throw new Error(`Hook input is missing ${key}.`);
    }
  }
  return {
    sessionId: input['sessionId'] as string,
    timestamp: typeof input['timestamp'] === 'number' ? input['timestamp'] : Date.now(),
    cwd: input['cwd'] as string,
    toolName: input['toolName'] as string,
    toolArgs: input['toolArgs'],
    toolResult: {
      resultType: 'success',
      textResultForLlm: result['textResultForLlm'],
    },
  };
}

export function parseUserPromptSubmittedInput(value: unknown): UserPromptSubmittedInput {
  if (!value || typeof value !== 'object') {
    throw new Error('Hook input must be an object.');
  }
  const input = value as Record<string, unknown>;
  for (const key of ['sessionId', 'cwd'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      throw new Error(`Hook input is missing ${key}.`);
    }
  }
  return {
    sessionId: input['sessionId'] as string,
    timestamp: typeof input['timestamp'] === 'number' ? input['timestamp'] : Date.now(),
    cwd: input['cwd'] as string,
  };
}
