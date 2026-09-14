import type { EngineConfig } from './engine.js';
import { validateCostPolicy } from './costPolicy.js';

export const COMPRESSION_PROFILES = ['conservative', 'balanced', 'aggressive'] as const;
export type CompressionProfile = typeof COMPRESSION_PROFILES[number];

type ProfileConfig = Pick<EngineConfig, 'maxFileLines' | 'log' | 'json' | 'code' | 'search' | 'tokenBudget'>;

const PRESETS: Record<CompressionProfile, Partial<ProfileConfig>> = {
  balanced: {},
  conservative: {
    maxFileLines: 2400,
    log: { headLines: 12, tailLines: 60, duplicateThreshold: 5, minRunToOmit: 10 },
    json: { minItems: 16, headItems: 4, tailItems: 2, minOmitted: 8 },
    code: { minLines: 120, minBlockLines: 12, minOmitted: 24 },
    search: { minMatches: 40, headPerFile: 4, tailPerFile: 2, minRunToOmit: 12, minOmitted: 24 },
    // Note: `minNetTokenGain` is a safety net, not an aggressiveness dial — see
    // DEFAULT_TOKEN_BUDGET_CONFIG. What actually makes this profile
    // conservative are the per-compressor thresholds above.
    tokenBudget: { minNetTokenGain: 16 },
  },
  aggressive: {
    maxFileLines: 600,
    log: { headLines: 3, tailLines: 15, duplicateThreshold: 2, minRunToOmit: 3 },
    json: { minItems: 6, headItems: 1, tailItems: 1, minOmitted: 3 },
    code: { minLines: 40, minBlockLines: 4, minOmitted: 8 },
    search: { minMatches: 12, headPerFile: 1, tailPerFile: 1, minRunToOmit: 4, minOmitted: 8 },
    tokenBudget: { minNetTokenGain: 4 },
  },
};

export function isCompressionProfile(value: unknown): value is CompressionProfile {
  return COMPRESSION_PROFILES.some((profile) => profile === value);
}

export function mergeConfigOverrides(
  current: Partial<EngineConfig>,
  patch: Partial<EngineConfig>,
): Partial<EngineConfig> {
  const merged = structuredClone(current);
  for (const key of Object.keys(patch) as (keyof EngineConfig)[]) {
    const value = patch[key];
    if (value === undefined) {
      delete merged[key];
    } else if (key === 'costPolicy') {
      merged.costPolicy = validateCostPolicy(value);
    } else {
      Object.assign(merged, { [key]: typeof value === 'object' ? { ...merged[key] as object, ...value } : value });
    }
  }
  return merged;
}

export function resolveCompressionConfig(defaults: EngineConfig, overrides: Partial<EngineConfig>): EngineConfig {
  const profile = overrides.profile ?? 'balanced';
  if (!isCompressionProfile(profile)) throw new Error('Unknown compression profile');
  const preset = mergeConfigOverrides(defaults, PRESETS[profile]);
  return mergeConfigOverrides(preset, { ...overrides, profile }) as EngineConfig;
}