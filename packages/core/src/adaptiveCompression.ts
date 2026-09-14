import { COMPRESSION_PROFILES, isCompressionProfile, type CompressionProfile } from './compressionProfiles.js';

/**
 * Bounded outcome-driven compression feedback (HC-07).
 *
 * The pressure guard in `ownedPolicy.ts` reacts to the *current* call; this
 * module reacts to *past verified outcomes*. It never invents a profile: it
 * only moves between the profiles the policy already permits, it only increases
 * compression through an explicitly bounded trial, and it restores the safest
 * permitted profile the moment recovery fails.
 */

export const COMPRESSION_FEEDBACK_ACTIONS = ['disabled', 'hold', 'reduce', 'trial', 'rollback', 'restore-safe'] as const;
export type CompressionFeedbackAction = typeof COMPRESSION_FEEDBACK_ACTIONS[number];

export const COMPRESSION_FEEDBACK_REASONS = ['kill-switch', 'recovery-failure', 'insufficient-samples', 'cooldown',
  'excessive-retrieval', 'verified-regression', 'overhead-regression', 'negative-benefit', 'sustained-benefit',
  'trial-pending', 'trial-confirmed', 'trial-guardrail', 'no-safer-profile', 'no-additional-profile', 'stable'] as const;
export type CompressionFeedbackReason = typeof COMPRESSION_FEEDBACK_REASONS[number];

export interface CompressionFeedbackPolicy {
  version: 1;
  /** Kill switch. When false the profile only follows static configuration and the pressure guard. */
  enabled: boolean;
  /** Verified tasks required for a profile before its evidence can justify any change. */
  minSamples: number;
  /** Retrievals per compression sample, 0-1, above which compression is reduced. */
  maxRetrievalRate: number;
  /** Slipstream decision/compression overhead per sample, in milliseconds. */
  maxOverheadMs: number;
  /** Net tokens saved divided by raw tool-output tokens, 0-1, required to justify a trial. */
  minNetBenefitRatio: number;
  /** Extra net-benefit margin required to increase compression. Prevents oscillation on noise. */
  hysteresis: number;
  /** Quiet period after any change, in milliseconds. Doubles for each earlier rollback of a profile. */
  cooldownMs: number;
  /** Verified tasks a trial runs for before it is confirmed or rolled back. */
  trialTasks: number;
}

export const DEFAULT_COMPRESSION_FEEDBACK_POLICY: Readonly<CompressionFeedbackPolicy> = Object.freeze({
  version: 1, enabled: false, minSamples: 5, maxRetrievalRate: 0.2, maxOverheadMs: 250,
  minNetBenefitRatio: 0.2, hysteresis: 0.05, cooldownMs: 60 * 60 * 1000, trialTasks: 5,
});

const RATIOS = ['maxRetrievalRate', 'minNetBenefitRatio', 'hysteresis'] as const;

export function validateCompressionFeedbackPolicy(value: unknown): CompressionFeedbackPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid compression feedback policy');
  const raw = value as Record<string, unknown>;
  const keys: (keyof CompressionFeedbackPolicy)[] = ['version', 'enabled', 'minSamples', 'maxRetrievalRate', 'maxOverheadMs',
    'minNetBenefitRatio', 'hysteresis', 'cooldownMs', 'trialTasks'];
  if (Object.keys(raw).some((key) => !keys.includes(key as keyof CompressionFeedbackPolicy))) throw new Error('Unknown compression feedback setting');
  if (raw.version !== 1) throw new Error('Unsupported compression feedback policy version');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error('Invalid compression feedback kill switch');
  const policy = { ...DEFAULT_COMPRESSION_FEEDBACK_POLICY, ...(raw.enabled === undefined ? {} : { enabled: raw.enabled }) } as CompressionFeedbackPolicy;
  for (const key of ['minSamples', 'trialTasks'] as const) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 1 || (raw[key] as number) > 1000) throw new Error(`Invalid compression feedback ${key}`);
    policy[key] = raw[key] as number;
  }
  for (const key of RATIOS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (raw[key] as number) < 0 || (raw[key] as number) > 1) throw new Error(`Invalid compression feedback ${key}`);
    policy[key] = raw[key] as number;
  }
  for (const key of ['maxOverheadMs', 'cooldownMs'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || (raw[key] as number) < 0 || (raw[key] as number) > 24 * 60 * 60 * 1000) throw new Error(`Invalid compression feedback ${key}`);
    policy[key] = raw[key] as number;
  }
  if (policy.minNetBenefitRatio + policy.hysteresis > 1) throw new Error('Compression feedback benefit and hysteresis cannot exceed the whole output');
  return policy;
}

/**
 * Aggregated evidence for one compression profile. Only verified owned tasks
 * that stayed on a single profile and a single model contribute, so a change
 * is never attributed to the wrong cause.
 */
export interface CompressionProfileEvidence {
  profile: CompressionProfile;
  tasks: number;
  verifiedPasses: number;
  verifiedFailures: number;
  samples: number;
  tokensBefore: number;
  tokensAfter: number;
  retrievedTokens: number;
  retryTokens: number;
  retrievals: number;
  recoveryFailures: number;
  overheadMs: number;
}

export interface CompressionFeedbackSignal {
  profile: CompressionProfile;
  tasks: number;
  verifiedPasses: number;
  verifiedFailures: number;
  samples: number;
  /** Gross saving minus retrieved, retried and re-sent tokens. May be negative. */
  netTokensSaved: number;
  /** Net tokens saved as a share of raw tool output, 0-1 when positive. */
  netBenefitRatio: number;
  retrievalRate: number;
  recoveryFailures: number;
  overheadMsPerSample: number;
}

export interface CompressionTrialState {
  profile: CompressionProfile;
  baseline: CompressionProfile;
  startedAt: number;
  rollbacks: Partial<Record<CompressionProfile, number>>;
  lastChangeAt: number;
}

export interface CompressionFeedbackDecision {
  version: 1;
  action: CompressionFeedbackAction;
  reason: CompressionFeedbackReason;
  profile: CompressionProfile;
  signal: CompressionFeedbackSignal | null;
  trial: CompressionTrialState | null;
}

export function emptyProfileEvidence(profile: CompressionProfile): CompressionProfileEvidence {
  return { profile, tasks: 0, verifiedPasses: 0, verifiedFailures: 0, samples: 0, tokensBefore: 0, tokensAfter: 0,
    retrievedTokens: 0, retryTokens: 0, retrievals: 0, recoveryFailures: 0, overheadMs: 0 };
}

export function compressionFeedbackSignal(evidence: CompressionProfileEvidence): CompressionFeedbackSignal {
  const netTokensSaved = evidence.tokensBefore - evidence.tokensAfter - evidence.retrievedTokens - evidence.retryTokens;
  return {
    profile: evidence.profile, tasks: evidence.tasks, verifiedPasses: evidence.verifiedPasses,
    verifiedFailures: evidence.verifiedFailures, samples: evidence.samples, netTokensSaved,
    netBenefitRatio: evidence.tokensBefore > 0 ? netTokensSaved / evidence.tokensBefore : 0,
    retrievalRate: evidence.samples > 0 ? evidence.retrievals / evidence.samples : 0,
    recoveryFailures: evidence.recoveryFailures,
    overheadMsPerSample: evidence.samples > 0 ? evidence.overheadMs / evidence.samples : 0,
  };
}

export interface CompressionFeedbackInput {
  policy: CompressionFeedbackPolicy;
  permitted: readonly CompressionProfile[];
  current: CompressionProfile;
  evidence: readonly CompressionProfileEvidence[];
  trial?: CompressionTrialState | null;
  recoveryFailed?: boolean;
  now?: number;
}

export function evaluateCompressionFeedback(input: CompressionFeedbackInput): CompressionFeedbackDecision {
  const policy = validateCompressionFeedbackPolicy(input.policy);
  const ordered = COMPRESSION_PROFILES.filter((profile) => input.permitted.includes(profile));
  if (!ordered.length) throw new Error('Compression feedback requires at least one permitted profile');
  if (!isCompressionProfile(input.current)) throw new Error('Invalid current compression profile');
  const now = input.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Invalid compression feedback clock');
  const safest = ordered[0]!;
  const current = ordered.includes(input.current) ? input.current : safest;
  const trial = normalizeTrial(input.trial, ordered);
  const signalFor = (profile: CompressionProfile) => compressionFeedbackSignal(
    input.evidence.find((item) => item.profile === profile) ?? emptyProfileEvidence(profile));
  const decide = (action: CompressionFeedbackAction, reason: CompressionFeedbackReason,
    profile: CompressionProfile, signal: CompressionFeedbackSignal | null, next: CompressionTrialState | null): CompressionFeedbackDecision =>
    ({ version: 1, action, reason, profile, signal, trial: next });

  if (!policy.enabled) return decide('disabled', 'kill-switch', current, null, trial);
  if (input.recoveryFailed === true) {
    return decide('restore-safe', 'recovery-failure', safest, null,
      safest === current && !trial ? trial : rolledBack(trial, current, safest, now));
  }

  const running = activeCompressionTrial(trial);
  if (running) {
    const signal = signalFor(running.profile);
    if (breached(signal, policy)) {
      return decide('rollback', breachReason(signal, policy), running.baseline, signal, rolledBack(running, running.profile, running.baseline, now));
    }
    if (signal.tasks < policy.trialTasks) return decide('hold', 'trial-pending', running.profile, signal, running);
    return sustained(signal, policy)
      ? decide('hold', 'trial-confirmed', running.profile, signal, { ...running, baseline: running.profile, lastChangeAt: now })
      : decide('rollback', 'trial-guardrail', running.baseline, signal, rolledBack(running, running.profile, running.baseline, now));
  }

  const signal = signalFor(current);
  if (signal.tasks >= policy.minSamples && breached(signal, policy)) {
    const safer = ordered[Math.max(0, ordered.indexOf(current) - 1)]!;
    return safer === current
      ? decide('hold', 'no-safer-profile', current, signal, trial)
      : decide('reduce', breachReason(signal, policy), safer, signal, rolledBack(trial, current, safer, now));
  }
  if (signal.tasks < policy.minSamples) return decide('hold', 'insufficient-samples', current, signal, trial);
  const next = ordered[ordered.indexOf(current) + 1];
  if (!next) return decide('hold', 'no-additional-profile', current, signal, trial);
  if (!sustained(signal, policy)) return decide('hold', 'stable', current, signal, trial);
  if (cooling(trial, next, policy, now)) return decide('hold', 'cooldown', current, signal, trial);
  return decide('trial', 'sustained-benefit', next, signal,
    { profile: next, baseline: current, startedAt: now, lastChangeAt: now, rollbacks: { ...trial?.rollbacks } });
}

function breached(signal: CompressionFeedbackSignal, policy: CompressionFeedbackPolicy): boolean {
  return signal.verifiedFailures > 0 || signal.recoveryFailures > 0 || signal.retrievalRate > policy.maxRetrievalRate ||
    signal.overheadMsPerSample > policy.maxOverheadMs || signal.netTokensSaved < 0;
}

function breachReason(signal: CompressionFeedbackSignal, policy: CompressionFeedbackPolicy): CompressionFeedbackReason {
  if (signal.verifiedFailures > 0) return 'verified-regression';
  if (signal.recoveryFailures > 0 || signal.retrievalRate > policy.maxRetrievalRate) return 'excessive-retrieval';
  if (signal.overheadMsPerSample > policy.maxOverheadMs) return 'overhead-regression';
  return 'negative-benefit';
}

function sustained(signal: CompressionFeedbackSignal, policy: CompressionFeedbackPolicy): boolean {
  return !breached(signal, policy) && signal.verifiedPasses >= policy.minSamples && signal.samples > 0 &&
    signal.netBenefitRatio >= policy.minNetBenefitRatio + policy.hysteresis;
}

function cooling(trial: CompressionTrialState | null, target: CompressionProfile, policy: CompressionFeedbackPolicy, now: number): boolean {
  if (!trial) return false;
  const attempts = trial.rollbacks[target] ?? 0;
  const wait = policy.cooldownMs * 2 ** Math.min(attempts, 10);
  return now - trial.lastChangeAt < wait;
}

function rolledBack(trial: CompressionTrialState | null, from: CompressionProfile, to: CompressionProfile, now: number): CompressionTrialState {
  const rollbacks = { ...trial?.rollbacks };
  rollbacks[from] = (rollbacks[from] ?? 0) + 1;
  return { profile: to, baseline: to, startedAt: trial?.startedAt ?? now, lastChangeAt: now, rollbacks };
}

/** A trial only survives while its profile and baseline are still permitted. */
function normalizeTrial(value: CompressionTrialState | null | undefined, ordered: readonly CompressionProfile[]): CompressionTrialState | null {
  if (!value) return null;
  if (!isCompressionProfile(value.profile) || !isCompressionProfile(value.baseline) ||
    !Number.isFinite(value.startedAt) || !Number.isFinite(value.lastChangeAt)) throw new Error('Invalid compression trial state');
  const rollbacks: Partial<Record<CompressionProfile, number>> = {};
  for (const profile of COMPRESSION_PROFILES) {
    const count = value.rollbacks?.[profile];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid compression trial state');
    rollbacks[profile] = count;
  }
  const state = { ...value, rollbacks };
  return ordered.includes(value.profile) && ordered.includes(value.baseline) ? state
    : { ...state, profile: ordered[0]!, baseline: ordered[0]! };
}

/** A trial is only an active trial while its profile differs from its baseline. */
export function activeCompressionTrial(trial: CompressionTrialState | null | undefined): CompressionTrialState | null {
  return trial && trial.profile !== trial.baseline ? trial : null;
}
