import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPRESSION_FEEDBACK_POLICY, emptyProfileEvidence, evaluateCompressionFeedback,
  validateCompressionFeedbackPolicy, type CompressionFeedbackPolicy, type CompressionProfileEvidence,
} from '../src/adaptiveCompression.js';
import { compressionProfileEvidence, compressionTrialState, buildTaskUsage, OwnedTaskUsage, recordTaskOutcome, taskWorkspaceKey } from '../src/taskUsage.js';
import { costPolicyPermissions, assessCostPolicy } from '../src/costPolicy.js';
import { SavingsLedger } from '../src/savingsLedger.js';
import { resolvePricing } from '../src/pricing.js';

const policy: CompressionFeedbackPolicy = { ...DEFAULT_COMPRESSION_FEEDBACK_POLICY, enabled: true, minSamples: 2, trialTasks: 2, cooldownMs: 1000 };
const permitted = ['conservative', 'balanced', 'aggressive'] as const;

function evidence(profile: 'conservative' | 'balanced' | 'aggressive', patch: Partial<CompressionProfileEvidence> = {}): CompressionProfileEvidence {
  return { ...emptyProfileEvidence(profile), tasks: 3, verifiedPasses: 3, samples: 10, tokensBefore: 1000, tokensAfter: 400, ...patch };
}

describe('compression feedback policy', () => {
  it('validates a versioned policy and rejects unknown or out-of-range settings', () => {
    expect(validateCompressionFeedbackPolicy({ version: 1 })).toEqual(DEFAULT_COMPRESSION_FEEDBACK_POLICY);
    expect(validateCompressionFeedbackPolicy({ version: 1, enabled: true, minSamples: 3, cooldownMs: 0 }))
      .toMatchObject({ enabled: true, minSamples: 3, cooldownMs: 0 });
    for (const invalid of [null, [], 'on', { version: 2 }, { version: 1, learned: true }, { version: 1, enabled: 'yes' },
      { version: 1, minSamples: 0 }, { version: 1, minSamples: 1.5 }, { version: 1, trialTasks: 1001 },
      { version: 1, maxRetrievalRate: 1.1 }, { version: 1, maxRetrievalRate: -0.1 }, { version: 1, hysteresis: Number.NaN },
      { version: 1, cooldownMs: -1 }, { version: 1, maxOverheadMs: Number.POSITIVE_INFINITY },
      { version: 1, minNetBenefitRatio: 0.9, hysteresis: 0.2 }]) {
      expect(() => validateCompressionFeedbackPolicy(invalid)).toThrow();
    }
  });

  it('lets a task policy and managed constraints tighten the loop but never loosen it', () => {
    const workspace = { version: 1 as const, mode: 'automatic-owned-request' as const,
      compressionFeedback: { version: 1 as const, enabled: true, minSamples: 4, maxRetrievalRate: 0.3, cooldownMs: 1000 } };
    const tightened = costPolicyPermissions(workspace, { host: 'owned-chat', scope: 'task',
      taskPolicy: { version: 1, mode: 'automatic-owned-request', compressionFeedback: { version: 1, enabled: true, minSamples: 9, maxRetrievalRate: 0.1, cooldownMs: 10 } } });
    expect(tightened.compressionFeedback).toMatchObject({ enabled: true, minSamples: 9, maxRetrievalRate: 0.1, cooldownMs: 1000 });
    const managed = costPolicyPermissions(workspace, { host: 'owned-chat', scope: 'task', constraints: { allowAutomation: false } });
    expect(managed.compressionFeedback.enabled).toBe(false);
  });

  it('reports the enabled loop as a capability only for an equipped automatic owned task', () => {
    const workspace = { version: 1 as const, mode: 'automatic-owned-request' as const,
      compressionFeedback: { version: 1 as const, enabled: true } };
    expect(assessCostPolicy(workspace, { host: 'owned-chat', scope: 'task', automaticExecutors: true })
      .capabilities).toMatchObject({ adaptiveCompression: true, adaptiveCompressionFeedback: true });
    expect(assessCostPolicy(workspace, { host: 'native-copilot', scope: 'workspace' })
      .capabilities).toMatchObject({ adaptiveCompression: false, adaptiveCompressionFeedback: false });
    expect(assessCostPolicy({ ...workspace, compressionFeedback: { version: 1, enabled: false } },
      { host: 'owned-chat', scope: 'task', automaticExecutors: true }).capabilities.adaptiveCompressionFeedback).toBe(false);
  });
});

describe('bounded compression feedback decisions', () => {
  it('keeps static behavior while the kill switch is off', () => {
    const decision = evaluateCompressionFeedback({ policy: { ...policy, enabled: false }, permitted, current: 'balanced',
      evidence: [evidence('balanced')], now: 10_000 });
    expect(decision).toMatchObject({ action: 'disabled', reason: 'kill-switch', profile: 'balanced', signal: null });
  });

  it('cannot increase compression on sparse or unverified data', () => {
    for (const sparse of [[], [evidence('balanced', { tasks: 1, verifiedPasses: 1 })]]) {
      expect(evaluateCompressionFeedback({ policy, permitted, current: 'balanced', evidence: sparse, now: 10_000 }))
        .toMatchObject({ action: 'hold', reason: 'insufficient-samples', profile: 'balanced' });
    }
    expect(evaluateCompressionFeedback({ policy, permitted, current: 'balanced',
      evidence: [evidence('balanced', { tokensAfter: 900 })], now: 10_000 }))
      .toMatchObject({ action: 'hold', reason: 'stable', profile: 'balanced' });
  });

  it('reduces compression on excessive retrieval, verified regression, overhead, or negative net benefit', () => {
    const cases = [
      [evidence('aggressive', { retrievals: 8 }), 'excessive-retrieval'],
      [evidence('aggressive', { verifiedPasses: 2, verifiedFailures: 1 }), 'verified-regression'],
      [evidence('aggressive', { overheadMs: 100_000 }), 'overhead-regression'],
      [evidence('aggressive', { retrievedTokens: 500, retryTokens: 200 }), 'negative-benefit'],
      [evidence('aggressive', { recoveryFailures: 1 }), 'excessive-retrieval'],
    ] as const;
    for (const [signal, reason] of cases) {
      expect(evaluateCompressionFeedback({ policy, permitted, current: 'aggressive', evidence: [signal], now: 10_000 }))
        .toMatchObject({ action: 'reduce', reason, profile: 'balanced' });
    }
    expect(evaluateCompressionFeedback({ policy, permitted: ['conservative'], current: 'conservative',
      evidence: [evidence('conservative', { retrievals: 8 })], now: 10_000 }))
      .toMatchObject({ action: 'hold', reason: 'no-safer-profile', profile: 'conservative' });
  });

  it('restores the safest permitted profile immediately when recovery fails', () => {
    const decision = evaluateCompressionFeedback({ policy, permitted, current: 'aggressive',
      evidence: [evidence('aggressive')], recoveryFailed: true, now: 10_000 });
    expect(decision).toMatchObject({ action: 'restore-safe', reason: 'recovery-failure', profile: 'conservative' });
    expect(decision.trial).toMatchObject({ profile: 'conservative', baseline: 'conservative', lastChangeAt: 10_000 });
  });

  it('opens a bounded trial on sustained verified benefit and confirms it only after the declared sample count', () => {
    const started = evaluateCompressionFeedback({ policy, permitted, current: 'balanced', evidence: [evidence('balanced')], now: 10_000 });
    expect(started).toMatchObject({ action: 'trial', reason: 'sustained-benefit', profile: 'aggressive' });
    expect(started.trial).toMatchObject({ profile: 'aggressive', baseline: 'balanced', startedAt: 10_000 });
    const pending = evaluateCompressionFeedback({ policy, permitted, current: 'aggressive',
      evidence: [evidence('aggressive', { tasks: 1, verifiedPasses: 1 })], trial: started.trial, now: 20_000 });
    expect(pending).toMatchObject({ action: 'hold', reason: 'trial-pending', profile: 'aggressive' });
    const confirmed = evaluateCompressionFeedback({ policy, permitted, current: 'aggressive',
      evidence: [evidence('aggressive')], trial: started.trial, now: 30_000 });
    expect(confirmed).toMatchObject({ action: 'hold', reason: 'trial-confirmed', profile: 'aggressive' });
    expect(confirmed.trial).toMatchObject({ profile: 'aggressive', baseline: 'aggressive' });
  });

  it('rolls a trial back on a guardrail breach and backs off before retrying the same profile', () => {
    const trial = { profile: 'aggressive' as const, baseline: 'balanced' as const, startedAt: 0, lastChangeAt: 0, rollbacks: {} };
    const rolled = evaluateCompressionFeedback({ policy, permitted, current: 'aggressive',
      evidence: [evidence('aggressive', { retrievals: 9 })], trial, now: 10_000 });
    expect(rolled).toMatchObject({ action: 'rollback', reason: 'excessive-retrieval', profile: 'balanced' });
    expect(rolled.trial).toMatchObject({ profile: 'balanced', baseline: 'balanced', rollbacks: { aggressive: 1 } });
    const cooling = evaluateCompressionFeedback({ policy, permitted, current: 'balanced',
      evidence: [evidence('balanced')], trial: rolled.trial, now: 11_000 });
    expect(cooling).toMatchObject({ action: 'hold', reason: 'cooldown', profile: 'balanced' });
    const retried = evaluateCompressionFeedback({ policy, permitted, current: 'balanced',
      evidence: [evidence('balanced')], trial: rolled.trial, now: 13_000 });
    expect(retried).toMatchObject({ action: 'trial', profile: 'aggressive' });
    const unproven = evaluateCompressionFeedback({ policy, permitted, current: 'aggressive',
      evidence: [evidence('aggressive', { tokensAfter: 900 })], trial, now: 10_000 });
    expect(unproven).toMatchObject({ action: 'rollback', reason: 'trial-guardrail', profile: 'balanced' });
  });

  it('never selects a profile the policy does not permit', () => {
    expect(evaluateCompressionFeedback({ policy, permitted: ['conservative', 'balanced'], current: 'balanced',
      evidence: [evidence('balanced')], now: 10_000 })).toMatchObject({ action: 'hold', reason: 'no-additional-profile' });
    expect(evaluateCompressionFeedback({ policy, permitted: ['conservative'], current: 'aggressive',
      evidence: [], now: 10_000 })).toMatchObject({ profile: 'conservative' });
    expect(() => evaluateCompressionFeedback({ policy, permitted: [], current: 'balanced', evidence: [] })).toThrow('permitted profile');
  });
});

const model = { vendor: 'vendor', id: 'model' };
const rates = resolvePricing({ mode: 'automatic' }, 99, {
  version: 1, fetchedAt: 100, revision: 'fixture', models: [{
    providerId: 'vendor', providerName: 'Vendor', modelId: 'model', modelName: 'Model', input: 5, output: 10, cacheRead: 1, cacheWrite: 6,
  }],
}, 100, { ...model, name: 'Model' });
let root: string;
let ledger: SavingsLedger;
let workspaceKey: string;

const settings = () => ({ sessionId: 'fixture', policyRevision: 'a'.repeat(64), unit: 'tokens' as const, limit: 100_000,
  workspaceKey, retrievalTracking: true, retryTracking: true, category: 'code' as const, guardrails: true });

function completedTask(options: {
  profile?: 'conservative' | 'balanced' | 'aggressive' | ('conservative' | 'balanced' | 'aggressive')[];
  pass?: boolean; samples?: number; retrievals?: number; retrievedTokens?: number; verify?: boolean; overheadMs?: number;
} = {}): string {
  const task = new OwnedTaskUsage(ledger, settings());
  const call = task.startCall(model, rates, { reserved: 1000, inputTokens: 100 });
  task.reportUsage(call, { inputTokens: 100, outputTokens: 50 });
  for (const profile of Array.isArray(options.profile) ? options.profile : [options.profile ?? 'balanced']) {
    for (let index = 0; index < (options.samples ?? 2); index++) {
      task.recordCompressionSample({ profile, tokensBefore: 1000, tokensAfter: 300, overheadMs: options.overheadMs ?? 5 });
    }
  }
  for (let index = 0; index < (options.retrievals ?? 0); index++) {
    task.recordRetrieval(true, { tokens: options.retrievedTokens ?? 100, overheadMs: 2 });
  }
  task.finishCall(call, 'finished');
  task.finish(options.pass === false ? 'failed' : 'finished');
  if (options.verify !== false) {
    recordTaskOutcome(ledger, task.taskId, { source: 'command', check: 'test', execution: 'completed',
      exitCode: options.pass === false ? 1 : 0, durationMs: 10 });
  }
  return task.taskId;
}

describe('compression evidence from owned task history', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-feedback-'));
    ledger = new SavingsLedger({ rootDir: root });
    workspaceKey = taskWorkspaceKey([root]);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('aggregates verified single-profile tasks and charges retrievals against the saving', () => {
    completedTask({ profile: 'balanced', samples: 3 });
    completedTask({ profile: 'balanced', samples: 3, retrievals: 1, retrievedTokens: 250 });
    const [aggregate] = compressionProfileEvidence(ledger.all(), workspaceKey, 'code');
    expect(aggregate).toMatchObject({ profile: 'balanced', tasks: 2, verifiedPasses: 2, verifiedFailures: 0,
      samples: 6, tokensBefore: 6000, tokensAfter: 1800, retrievals: 1, retrievedTokens: 250, recoveryFailures: 0 });
    const decision = evaluateCompressionFeedback({ policy, permitted, current: 'balanced', evidence: compressionProfileEvidence(ledger.all(), workspaceKey, 'code'), now: Date.now() });
    expect(decision.signal).toMatchObject({ netTokensSaved: 3950, samples: 6 });
    expect(decision.action).toBe('trial');
  });

  it('ignores activity that cannot be attributed to one verified task, profile, and model', () => {
    completedTask({ profile: ['balanced', 'aggressive'] });
    completedTask({ profile: 'balanced', verify: false });
    const other = new OwnedTaskUsage(ledger, { ...settings(), workspaceKey: 'b'.repeat(64) });
    other.recordCompressionSample({ profile: 'balanced', tokensBefore: 1000, tokensAfter: 10 });
    other.finish('finished');
    recordTaskOutcome(ledger, other.taskId, { source: 'user', result: 'pass' });
    expect(compressionProfileEvidence(ledger.all(), workspaceKey, 'code')).toEqual([]);
    completedTask({ profile: 'balanced' });
    expect(compressionProfileEvidence(ledger.all(), workspaceKey, 'code').map((item) => item.tasks)).toEqual([1]);
    expect(compressionProfileEvidence(ledger.all(), workspaceKey, 'triage')).toEqual([]);
  });

  it('counts a verified failure without letting it justify more compression', () => {
    completedTask({ profile: 'aggressive' });
    completedTask({ profile: 'aggressive', pass: false });
    const evidence = compressionProfileEvidence(ledger.all(), workspaceKey, 'code');
    expect(evidence[0]).toMatchObject({ verifiedPasses: 1, verifiedFailures: 1 });
    expect(evaluateCompressionFeedback({ policy, permitted, current: 'aggressive', evidence, now: Date.now() }))
      .toMatchObject({ action: 'reduce', reason: 'verified-regression', profile: 'balanced' });
  });

  it('records the signal and reason for a change and reconstructs the trial from append-only history', () => {
    completedTask({ profile: 'balanced' });
    completedTask({ profile: 'balanced' });
    const task = new OwnedTaskUsage(ledger, settings());
    const decision = evaluateCompressionFeedback({ policy, permitted, current: 'balanced',
      evidence: compressionProfileEvidence(ledger.all(), workspaceKey, 'code'), trial: compressionTrialState(ledger.all(), workspaceKey), now: Date.now() });
    task.recordCompressionFeedback(decision);
    const before = fs.readFileSync(ledger.path(), 'utf8');
    const summary = buildTaskUsage(ledger.all()).find((item) => item.taskId === task.taskId)!;
    expect(summary.compressionFeedback).toMatchObject({ action: 'trial', reason: 'sustained-benefit', profile: 'aggressive' });
    expect(summary.compressionFeedback!.signal).toMatchObject({ profile: 'balanced', verifiedPasses: 2 });
    expect(compressionTrialState(new SavingsLedger({ rootDir: root }).all(), workspaceKey))
      .toMatchObject({ profile: 'aggressive', baseline: 'balanced' });
    task.finish('finished');
    expect(fs.readFileSync(ledger.path(), 'utf8').startsWith(before)).toBe(true);
    expect(() => task.recordCompressionFeedback(decision)).toThrow('already finished');
  });

  it('rejects compression samples and feedback that are not plausible task evidence', () => {
    const task = new OwnedTaskUsage(ledger, settings());
    for (const invalid of [{ profile: 'tiny', tokensBefore: 10, tokensAfter: 1 }, { profile: 'balanced', tokensBefore: 10, tokensAfter: 20 },
      { profile: 'balanced', tokensBefore: -1, tokensAfter: 0 }, { profile: 'balanced', tokensBefore: 10, tokensAfter: 1, overheadMs: -1 }]) {
      expect(() => task.recordCompressionSample(invalid as never)).toThrow('Invalid compression sample');
    }
    for (const invalid of [{ version: 2 }, { version: 1, action: 'learn', reason: 'stable', profile: 'balanced' },
      { version: 1, action: 'hold', reason: 'made-up', profile: 'balanced' }, { version: 1, action: 'hold', reason: 'stable', profile: 'tiny' }]) {
      expect(() => task.recordCompressionFeedback(invalid as never)).toThrow('Invalid compression');
    }
    const untracked = new OwnedTaskUsage(ledger, { ...settings(), retrievalTracking: false });
    expect(() => untracked.recordCompressionSample({ profile: 'balanced', tokensBefore: 10, tokensAfter: 1 })).toThrow('instrumented task');
    expect(buildTaskUsage(ledger.all()).find((item) => item.taskId === untracked.taskId)!.compression).toBeNull();
    untracked.finish('cancelled');
    task.finish('cancelled');
  });
});
