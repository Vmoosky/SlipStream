import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTaskUsage, OwnedTaskUsage, policyModelEvidence, recordTaskOutcome, taskWorkspaceKey, type TaskOutcomeEvidence } from '../src/taskUsage.js';
import { SavingsLedger } from '../src/savingsLedger.js';
import { resolvePricing } from '../src/pricing.js';
import { CompressionEngine } from '../src/engine.js';
import { buildSummaryPayload } from '../src/dashboard.js';

const model = { vendor: 'vendor', id: 'model' };
const rates = resolvePricing({ mode: 'automatic' }, 99, {
  version: 1, fetchedAt: 100, revision: 'fixture', models: [{
    providerId: 'vendor', providerName: 'Vendor', modelId: 'model', modelName: 'Model',
    input: 5, output: 10, cacheRead: 1, cacheWrite: 6,
  }],
}, 100, { ...model, name: 'Model' });
const usage = { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 600, cacheCreationInputTokens: 100 };
const options = { sessionId: 'fixture', policyRevision: 'a'.repeat(64), unit: 'tokens' as const, limit: 2000 };
let root: string;
let ledger: SavingsLedger;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-task-usage-'));
  ledger = new SavingsLedger({ rootDir: root });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('owned task usage accounting', () => {
  it('resumes retained exact task history without refunding or replaying interrupted calls', () => {
    const settings = { ...options, workspaceKey: taskWorkspaceKey([root]), category: 'code' as const, guardrails: true, retrievalTracking: true };
    const task = new OwnedTaskUsage(ledger, settings);
    const first = task.startCall(model, rates, { reserved: 1200, inputTokens: 500 });
    task.reportUsage(first, { inputTokens: 600 }, 'exact-report');
    task.recordRetrieval(false);
    task.dispose();
    const restarted = new SavingsLedger({ rootDir: root });
    const resumed = OwnedTaskUsage.resume(restarted, task.taskId, settings, model);
    expect(resumed.taskId).toBe(task.taskId);
    expect(resumed.getAllowanceUsed()).toBe(1200);
    expect(buildTaskUsage(restarted.all())[0]).toMatchObject({ state: 'running', resumes: 1, interruptedCalls: 1, pendingCalls: 0, calls: 1,
      allowanceUsed: 1200, allowanceRemaining: 800, totalTokens: null, recoveryFailures: 1, sessionId: settings.sessionId });
    expect(() => resumed.startCall(model, rates, { reserved: 801 })).toThrow('local allowance');
    resumed.reportUsage(first, { inputTokens: 600, outputTokens: 700 }, 'exact-report');
    expect(resumed.getAllowanceUsed()).toBe(1300);
    const reported = restarted.all().length;
    resumed.reportUsage(first, { inputTokens: 600, outputTokens: 700 }, 'exact-report');
    expect(restarted.all()).toHaveLength(reported);
    expect(() => resumed.reportUsage(first, { outputTokens: 1 }, 'exact-report')).toThrow('conflicting');
    expect(() => resumed.startCall({ ...model, id: 'other' }, rates, { reserved: 1 })).toThrow('original model');
    const second = resumed.startCall(model, rates, { reserved: 700 });
    resumed.finishCall(second, 'finished');
    resumed.finish('finished');
    const entries = restarted.all();
    expect(buildTaskUsage([...entries, ...entries])).toEqual(buildTaskUsage(entries));
    expect(buildTaskUsage(new SavingsLedger({ rootDir: root }).all())[0]).toMatchObject({ state: 'finished', resumes: 1, calls: 2, allowanceUsed: 2000 });
    expect(() => OwnedTaskUsage.resume(restarted, task.taskId, settings, model)).toThrow('cannot be resumed');
  });

  it('rejects concurrent resumes, changed ownership constraints, and completed outcome evidence', () => {
    const settings = { ...options, workspaceKey: taskWorkspaceKey([root]), guardrails: true };
    const task = new OwnedTaskUsage(ledger, settings);
    const callId = task.startCall(model, rates, { reserved: 1000 });
    expect(() => OwnedTaskUsage.resume(new SavingsLedger({ rootDir: root }), task.taskId, settings, model)).toThrow('already active');
    task.finishCall(callId, 'cancelled');
    task.finish('cancelled');
    for (const patch of [{ sessionId: 'other' }, { workspaceKey: 'b'.repeat(64) }, { policyRevision: 'b'.repeat(64) }, { limit: 3000 },
      { unit: 'reference-usd' as const }, { category: 'triage' as const }, { guardrails: false }, { retrievalTracking: true }]) {
      expect(() => OwnedTaskUsage.resume(ledger, task.taskId, { ...settings, ...patch }, model)).toThrow('original workspace');
    }
    expect(() => OwnedTaskUsage.resume(ledger, task.taskId, settings, { ...model, id: 'other' })).toThrow('original workspace');
    const resumed = OwnedTaskUsage.resume(ledger, task.taskId, settings, model);
    expect(() => task.reportUsage(callId, usage)).toThrow('already active');
    resumed.reportUsage(callId, { inputTokens: 2100 });
    expect(() => resumed.startCall(model, rates, { reserved: 0 })).toThrow('local allowance');
    resumed.finish('paused');
    recordTaskOutcome(ledger, task.taskId, { source: 'user', result: 'fail' });
    expect(() => OwnedTaskUsage.resume(ledger, task.taskId, settings, model)).toThrow('cannot be resumed');
  });

  it('retains active history through rotation and fails closed on incomplete history', () => {
    const settings = { ...options, workspaceKey: taskWorkspaceKey([root]), guardrails: true };
    const rotating = new SavingsLedger({ rootDir: root, maxFileBytes: 1 });
    const task = new OwnedTaskUsage(rotating, settings);
    task.startCall(model, rates, { reserved: 1000 });
    expect(buildTaskUsage(new SavingsLedger({ rootDir: root }).all())[0]?.calls).toBe(1);
    task.dispose();
    const history = fs.readFileSync(rotating.path(), 'utf8');
    fs.appendFileSync(rotating.path(), '{"taskUsage":');
    expect(() => OwnedTaskUsage.resume(rotating, task.taskId, settings, model)).toThrow('incomplete');
    fs.writeFileSync(rotating.path(), history);
    const resumed = OwnedTaskUsage.resume(rotating, task.taskId, settings, model);
    expect(resumed.getAllowanceUsed()).toBe(1000);
    resumed.dispose();
  });

  it('reclaims only a proven dead process owner after restart', () => {
    const settings = { ...options, workspaceKey: taskWorkspaceKey([root]), guardrails: true };
    const task = new OwnedTaskUsage(ledger, settings);
    task.startCall(model, rates, { reserved: 1500 });
    task.dispose();
    const lockPath = path.join(root, `.owned-task-${task.taskId}.lock`);
    const child = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, token: 'exited-process' }));", lockPath]);
    expect(child.status).toBe(0);
    const resumed = OwnedTaskUsage.resume(new SavingsLedger({ rootDir: root }), task.taskId, settings, model);
    expect(resumed.getAllowanceUsed()).toBe(1500);
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ resumes: 1, interruptedCalls: 1 });
    resumed.dispose();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 'unknown', token: 'unproven-owner' }));
    expect(() => OwnedTaskUsage.resume(ledger, task.taskId, settings, model)).toThrow('previous task owner');
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token).toBe('unproven-owner');
  });

  it('keeps recorded reference rates and rejects verification from an earlier run', () => {
    const settings = { ...options, unit: 'reference-usd' as const, limit: 1, workspaceKey: taskWorkspaceKey([root]), guardrails: true };
    const task = new OwnedTaskUsage(ledger, settings);
    const callId = task.startCall(model, rates, { reserved: 0.01 });
    task.reportUsage(callId, { inputTokens: 1000, cacheReadInputTokens: 600, cacheCreationInputTokens: 100 });
    task.finishCall(callId, 'cancelled');
    task.finish('cancelled');
    const earlier = buildTaskUsage(ledger.all())[0]!;
    ledger.updateTokenPrice(999);
    const resumed = OwnedTaskUsage.resume(ledger, task.taskId, settings, model);
    resumed.reportUsage(callId, { outputTokens: 100 });
    expect(resumed.getAllowanceUsed()).toBe(0.01);
    resumed.finish('failed');
    expect(buildTaskUsage(ledger.all())[0]?.referenceUsd).toBeCloseTo(0.0037);
    expect(() => recordTaskOutcome(ledger, task.taskId, { source: 'command', check: 'test', execution: 'completed', exitCode: 0, durationMs: 1 }, earlier)).toThrow('resumed');
    expect(buildTaskUsage(ledger.all())[0]?.outcome.status).toBe('unverified');
  });

  it('atomically reserves automatic calls, retains allowances after completion, and persists pauses', async () => {
    const task = new OwnedTaskUsage(ledger, { ...options, guardrails: true, retrievalTracking: true, category: 'code' });
    const attempts = await Promise.allSettled([0, 1].map(async () => task.startCall(model, rates, { reserved: 1500 })));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const callId = (attempts.find((attempt) => attempt.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
    task.finishCall(callId, 'finished');
    task.reportUsage(callId, { inputTokens: 100, outputTokens: 100 });
    expect(task.getAllowanceUsed()).toBe(1500);
    expect(() => task.startCall(model, rates, { reserved: 501 })).toThrow('local allowance');
    task.recordPolicyDecision({ state: 'paused', reason: 'budget-limit', requestedModel: model, selectedModel: model, profile: 'balanced' });
    expect(() => task.startCall(model, rates, { reserved: 1 })).toThrow('paused');
    task.recordRetrieval(true);
    task.finish('paused');
    const summary = buildTaskUsage(ledger.all())[0]!;
    expect(summary).toMatchObject({ state: 'paused', calls: 1, totalTokens: 200, remaining: 1800, allowanceUsed: 1500,
      allowanceRemaining: 500, enforcement: 'local-allowance', policyDecision: { state: 'paused', reason: 'budget-limit' }, retrievals: 1 });
    expect(buildTaskUsage(new SavingsLedger({ rootDir: root }).all())[0]).toEqual(summary);
  });

  it('does not consume allowance if the ledger append fails and never stores arbitrary decision text', () => {
    const task = new OwnedTaskUsage(ledger, { ...options, guardrails: true });
    fs.renameSync(ledger.path(), `${ledger.path()}.backup`);
    fs.mkdirSync(ledger.path());
    try {
      expect(() => task.startCall(model, rates, { reserved: 1000 })).toThrow();
      expect(task.getAllowanceUsed()).toBe(0);
    } finally {
      fs.rmSync(ledger.path(), { recursive: true });
      fs.renameSync(`${ledger.path()}.backup`, ledger.path());
    }
    expect(buildTaskUsage(ledger.all())[0]?.calls).toBe(0);
    const callId = task.startCall(model, rates, { reserved: 1000 });
    task.reportUsage(callId, { inputTokens: 2500 });
    expect(task.getAllowanceUsed()).toBe(2500);
    expect(() => task.startCall(model, rates, { reserved: 1 })).toThrow('local allowance');
    expect(() => task.recordPolicyDecision({ state: 'paused', reason: 'budget-limit', prompt: 'PRIVATE' } as never)).toThrow('Invalid owned policy decision');
    expect(fs.readFileSync(ledger.path(), 'utf8')).not.toContain('PRIVATE');
  });

  it('qualifies models only from exact, recent, same-workspace category tasks with verified command outcomes', () => {
    const workspaceKey = taskWorkspaceKey([root]);
    for (const source of ['command', 'command', 'command', 'user'] as const) {
      const task = new OwnedTaskUsage(ledger, { ...options, workspaceKey, category: 'code' });
      const callId = task.startCall(model, rates);
      task.finishCall(callId, 'finished');
      task.finish('finished');
      recordTaskOutcome(ledger, task.taskId, source === 'user' ? { source, result: 'pass' }
        : { source, check: 'test', execution: 'completed', exitCode: 0, durationMs: 1 });
    }
    expect(policyModelEvidence(ledger.all(), workspaceKey, 'code').get('vendor\0model')).toEqual({ verifiedPasses: 3, verifiedFailures: 0 });
    expect(policyModelEvidence(ledger.all(), workspaceKey, 'triage').size).toBe(0);
    expect(policyModelEvidence(ledger.all(), 'b'.repeat(64), 'code').size).toBe(0);
    expect(policyModelEvidence(ledger.all(), workspaceKey, undefined).size).toBe(0);
    expect(policyModelEvidence(ledger.all(), workspaceKey, 'code', Date.now() + 31 * 24 * 60 * 60 * 1000).size).toBe(0);
  });

  it('counts only instrumented retrievals and explicitly linked retries, with no success inference', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const task = new OwnedTaskUsage(ledger, { ...options, workspaceKey: taskWorkspaceKey([root]), retrievalTracking: true, retryTracking: true });
      const first = task.startCall(model, rates);
      task.finishCall(first, 'finished');
      expect(() => task.startCall(model, rates, { retryOfCallId: first })).toThrow('failed or cancelled');
      const second = task.startCall(model, rates);
      task.finishCall(second, 'failed');
      const retry = task.startCall(model, rates, { retryOfCallId: second });
      task.finishCall(retry, 'finished');
      expect(() => task.startCall(model, rates, { retryOfCallId: 'other-task-call' })).toThrow('exact owned call ID');
      task.recordRetrieval(true);
      task.recordRetrieval(false);
      clock.mockReturnValue(1600);
      task.finish('finished');
      const entries = ledger.all();
      expect(buildTaskUsage(entries)[0]).toMatchObject({
        calls: 3, modelRetries: 1, retrievals: 1, recoveryFailures: 1, durationMs: 600,
        workspaceKey: taskWorkspaceKey([root]), outcome: { status: 'unverified' },
      });
      expect(buildTaskUsage([...entries, ...entries])).toEqual(buildTaskUsage(entries));
      expect(() => task.recordRetrieval(true)).toThrow('active instrumented task');
      expect(fs.readFileSync(ledger.path(), 'utf8')).not.toContain(root);
    } finally { clock.mockRestore(); }
  });

  it('leaves uninstrumented metrics unknown and fingerprints workspace roots independent of order', () => {
    const task = new OwnedTaskUsage(ledger, options);
    expect(() => task.recordRetrieval(true)).toThrow('instrumented');
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ durationMs: null, modelRetries: null, retrievals: null, recoveryFailures: null });
    const other = path.join(root, 'other');
    expect(taskWorkspaceKey([root, other])).toBe(taskWorkspaceKey([other, root]));
    expect(taskWorkspaceKey([other])).not.toBe(taskWorkspaceKey([root]));
  });

  it.each(['finished', 'failed', 'cancelled'] as const)('keeps %s request completion separate from verified task success', (state) => {
    const task = new OwnedTaskUsage(ledger, options);
    task.finish(state);
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({
      state, durationMs: expect.any(Number), outcome: { status: state === 'cancelled' ? 'cancelled' : 'unverified', result: null, evidence: null, verificationAttempts: 0 },
    });
  });

  it('requires an exact completed owned task before accepting verification evidence', () => {
    const task = new OwnedTaskUsage(ledger, options);
    const evidence: TaskOutcomeEvidence = { source: 'user', result: 'pass' };
    expect(() => recordTaskOutcome(ledger, 'unowned', evidence)).toThrow('completed owned task');
    expect(() => recordTaskOutcome(ledger, task.taskId, evidence)).toThrow('completed owned task');
    const call = task.startCall(model, rates);
    task.finish('finished');
    expect(() => recordTaskOutcome(ledger, task.taskId, evidence)).toThrow('completed owned task');
    task.finishCall(call, 'finished');
    recordTaskOutcome(ledger, task.taskId, evidence);
    expect(buildTaskUsage(ledger.all())[0]?.outcome).toMatchObject({ status: 'user-reported', result: 'pass' });
  });

  it('distinguishes command results, user reports, cancellation and execution errors without changing history or savings', () => {
    const task = new OwnedTaskUsage(ledger, options);
    task.finish('finished');
    const original = fs.readFileSync(ledger.path(), 'utf8');
    const savings = ledger.summary();
    const evidence: TaskOutcomeEvidence = { source: 'command', check: 'test', execution: 'completed', exitCode: 1, durationMs: 100, checkKey: 'b'.repeat(64) };
    recordTaskOutcome(ledger, task.taskId, evidence);
    expect(buildTaskUsage(ledger.all())[0]?.outcome).toMatchObject({ status: 'verified-fail', result: 'fail', verificationAttempts: 1 });
    recordTaskOutcome(ledger, task.taskId, { ...evidence, exitCode: 0 });
    expect(buildTaskUsage(ledger.all())[0]?.outcome).toMatchObject({ status: 'verified-pass', result: 'pass', verificationAttempts: 2, evidence: { detail: { checkKey: 'b'.repeat(64) } } });
    recordTaskOutcome(ledger, task.taskId, { source: 'user', result: 'fail' });
    expect(buildTaskUsage(ledger.all())[0]?.outcome).toMatchObject({ status: 'user-reported', result: 'fail', verificationAttempts: 2 });
    recordTaskOutcome(ledger, task.taskId, { ...evidence, execution: 'cancelled', exitCode: null });
    expect(buildTaskUsage(ledger.all())[0]?.outcome).toMatchObject({ status: 'cancelled', result: null });
    recordTaskOutcome(ledger, task.taskId, { ...evidence, execution: 'error', exitCode: null });
    expect(buildTaskUsage(ledger.all())[0]?.outcome).toMatchObject({ status: 'unverified', result: null });
    const events = ledger.all();
    expect(buildTaskUsage([...events, ...events])).toEqual(buildTaskUsage(events));
    expect(buildTaskUsage(new SavingsLedger({ rootDir: root }).all())).toEqual(buildTaskUsage(events));
    expect(fs.readFileSync(ledger.path(), 'utf8').startsWith(original)).toBe(true);
    expect(ledger.summary()).toEqual(savings);
    expect(events.every((entry) => !entry.pricing && entry.tokensBefore === 0 && entry.tokensAfter === 0)).toBe(true);
  });

  it.each([
    { source: 'model', result: 'pass' },
    { source: 'user', result: 'pass', prompt: 'PRIVATE' },
    { source: 'command', check: 'test', execution: 'completed', exitCode: null, durationMs: 10 },
    { source: 'command', check: 'test', execution: 'completed', exitCode: 0, durationMs: NaN },
    { source: 'command', check: 'test', execution: 'completed', exitCode: 0, durationMs: 10, stdout: 'PRIVATE' },
    { source: 'command', check: 'test', execution: 'completed', exitCode: 0, durationMs: 10, checkKey: { toString: () => 'a'.repeat(64), prompt: 'PRIVATE' } },
  ])('rejects incomplete or content-bearing outcome evidence %#', (evidence) => {
    const task = new OwnedTaskUsage(ledger, options);
    task.finish('finished');
    const before = fs.readFileSync(ledger.path(), 'utf8');
    expect(() => recordTaskOutcome(ledger, task.taskId, evidence as TaskOutcomeEvidence)).toThrow('Invalid task outcome evidence');
    expect(fs.readFileSync(ledger.path(), 'utf8')).toBe(before);
  });

  it('projects the latest 25 owned tasks without mutating history or savings', () => {
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const clock = vi.spyOn(Date, 'now');
    try {
      const tasks: OwnedTaskUsage[] = [];
      for (let index = 0; index < 30; index++) {
        clock.mockReturnValue(1000 + index);
        const task = new OwnedTaskUsage(ledger, options);
        task.finish('finished');
        tasks.push(task);
      }
      recordTaskOutcome(ledger, tasks[0]!.taskId, { source: 'command', check: 'test', execution: 'completed', exitCode: 0, durationMs: 1 });
      recordTaskOutcome(ledger, tasks[1]!.taskId, { source: 'command', check: 'test', execution: 'completed', exitCode: 1, durationMs: 1 });
      recordTaskOutcome(ledger, tasks[2]!.taskId, { source: 'user', result: 'pass' });
      const history = fs.readFileSync(ledger.path(), 'utf8');
      const savings = engine.summary();
      const payload = buildSummaryPayload(engine);
      expect(payload.taskUsage.totalTasks).toBe(30);
      expect(payload.taskUsage.tasks).toHaveLength(25);
      expect(payload.taskUsage.outcomes).toEqual({ 'verified-pass': 1, 'verified-fail': 1, 'user-reported': 1, cancelled: 0, unverified: 27 });
      expect(payload.taskUsage.tasks.every((task) => task.outcome.status === 'unverified')).toBe(true);
      expect(payload.taskUsage.tasks.every((task) => task.enforcement === 'not-enforced')).toBe(true);
      expect(engine.summary()).toEqual(savings);
      expect(fs.readFileSync(ledger.path(), 'utf8')).toBe(history);
    } finally { clock.mockRestore(); engine.dispose(); }
  });

  it('creates exact task and call identities and leaves unreported spend unknown', () => {
    const task = new OwnedTaskUsage(ledger, options);
    const callId = task.startCall(model, rates, { reserved: 1200, inputTokens: 900 });
    task.finishCall(callId, 'finished', 90);
    task.finish('finished');
    expect(buildTaskUsage(ledger.all())).toEqual([expect.objectContaining({
      taskId: task.taskId, calls: 1, reportedCalls: 0, totalTokens: null, estimatedTokens: 990,
      estimateCoverage: 'complete',
      reserved: 1200, referenceUsd: null, remaining: null, budgetStatus: 'unknown', enforcement: 'not-enforced',
    })]);
    expect(ledger.all().every((entry) => entry.tool === 'session' && !entry.pricing && entry.tokensBefore === 0 && entry.tokensAfter === 0)).toBe(true);
  });

  it('counts a usage report once and reconciles its provisional allowance even when it arrives late', () => {
    const task = new OwnedTaskUsage(ledger, options);
    const callId = task.startCall(model, rates, { reserved: 1200 });
    task.finishCall(callId, 'finished');
    task.finish('finished');
    task.reportUsage(callId, { inputTokens: 1000 }, 'PRIVATE-OBSERVATION');
    const partial = buildTaskUsage(ledger.all())[0]!;
    expect(partial).toMatchObject({ knownTokens: 1000, totalTokens: null, reserved: 1200, remaining: null });
    task.reportUsage(callId, usage, 'PRIVATE-OBSERVATION');
    const count = ledger.all().length;
    task.reportUsage(callId, usage, 'PRIVATE-OBSERVATION');
    task.reportUsage(callId, { inputTokens: 1000 }, 'PRIVATE-OBSERVATION');
    expect(ledger.all()).toHaveLength(count);
    const result = buildTaskUsage(ledger.all())[0]!;
    expect(result).toMatchObject({ calls: 1, reportedCalls: 1, totalTokens: 1100, reserved: 0, remaining: 900, budgetStatus: 'within' });
    expect(result.referenceUsd).toBeCloseTo(0.0037, 10);
    expect(fs.readFileSync(ledger.path(), 'utf8')).not.toContain('PRIVATE-OBSERVATION');
    expect(buildTaskUsage(new SavingsLedger({ rootDir: root }).all())).toEqual([result]);
  });

  it('keeps the task configuration fixed and permits a report retry after an append failure', () => {
    const config = { ...options, unit: 'tokens' as 'tokens' | 'reference-usd' };
    const task = new OwnedTaskUsage(ledger, config);
    config.unit = 'reference-usd';
    expect(() => task.startCall(model, rates, { reserved: 0.1 })).toThrow('Invalid provisional allowance');
    const call = task.startCall(model, rates);
    const append = vi.spyOn(ledger, 'record').mockImplementationOnce(() => { throw new Error('Append failed'); });
    try {
      expect(() => task.reportUsage(call, usage)).toThrow('Append failed');
      expect(buildTaskUsage(ledger.all())[0]?.totalTokens).toBeNull();
      task.reportUsage(call, usage);
      expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ totalTokens: 1100, unit: 'tokens', remaining: 900 });
    } finally { append.mockRestore(); }
  });

  it('requires the owned call ID and prevents an observation being counted for another task', () => {
    const first = new OwnedTaskUsage(ledger, options);
    const second = new OwnedTaskUsage(ledger, options);
    const firstCall = first.startCall(model, rates);
    const secondCall = second.startCall(model, rates);
    first.reportUsage(firstCall, usage, 'span');
    expect(() => second.reportUsage(firstCall, usage)).toThrow('exact owned call ID');
    expect(() => second.reportUsage(secondCall, usage, 'span')).toThrow('another call');
    expect(buildTaskUsage(ledger.all()).find((task) => task.taskId === second.taskId)?.totalTokens).toBeNull();
  });

  it('binds a newly supplied observation identity even when its counts are already recorded', () => {
    const task = new OwnedTaskUsage(ledger, options);
    const first = task.startCall(model, rates);
    const second = task.startCall(model, rates);
    task.reportUsage(first, usage);
    task.reportUsage(first, usage, 'late-identity');
    expect(() => task.reportUsage(second, usage, 'late-identity')).toThrow('another call');
    const events = ledger.all();
    expect(buildTaskUsage([...events, ...events])).toEqual(buildTaskUsage(events));
  });

  it('marks input-only estimates as partial and does not treat overflowing totals as zero', () => {
    const task = new OwnedTaskUsage(ledger, options);
    const first = task.startCall(model, rates, { inputTokens: Number.MAX_SAFE_INTEGER, reserved: Number.MAX_SAFE_INTEGER });
    const second = task.startCall(model, rates, { inputTokens: 1, reserved: 1 });
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ estimatedTokens: null, estimateCoverage: 'partial', reserved: null, remaining: null });
    task.reportUsage(first, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
    task.reportUsage(second, { inputTokens: 1, outputTokens: 0 });
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ inputTokens: null, knownTokens: null, totalTokens: null, remaining: null, budgetStatus: 'unknown' });
  });

  it('preserves per-call rates across model changes and never adds retrieval as a second model charge', () => {
    const task = new OwnedTaskUsage(ledger, { ...options, unit: 'reference-usd', limit: 0.02 });
    const first = task.startCall(model, rates);
    const secondRates = { ...rates, inputUsdPerMillion: 10, outputUsdPerMillion: 20, cacheReadUsdPerMillion: 2, cacheWriteUsdPerMillion: 12 };
    const second = task.startCall({ ...model, id: 'second' }, secondRates);
    secondRates.outputUsdPerMillion = 999;
    const historical = fs.readFileSync(ledger.path(), 'utf8');
    const savedBefore = ledger.summary();
    task.reportUsage(first, usage);
    task.reportUsage(second, usage);
    expect(ledger.summary()).toEqual(savedBefore);
    const taskBeforeRetrieval = buildTaskUsage(ledger.all());
    ledger.record({ ts: Date.now(), tool: 'retrieve_artifact', label: 'retrieved', strategy: 'retrieve', tokensBefore: 0, tokensAfter: 100, bytesBefore: 0, bytesAfter: 400, linesBefore: 0, linesAfter: 1 });
    ledger.record({
      ts: Date.now(), tool: 'session', label: 'Native observation', strategy: 'session:model',
      tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
      modelObservation: { traceId: 'native', spanId: 'native', provider: model.vendor, requestModel: model.id, startedAt: 1, endedAt: 2, inputTokens: 1_000_000, outputTokens: 100 },
    });
    expect(buildTaskUsage(ledger.all())).toEqual(taskBeforeRetrieval);
    expect(taskBeforeRetrieval[0]?.referenceUsd).toBeCloseTo(0.0111, 10);
    expect(fs.readFileSync(ledger.path(), 'utf8').startsWith(historical)).toBe(true);
  });

  it('never substitutes the savings fallback for a missing spend rate', () => {
    const task = new OwnedTaskUsage(ledger, { ...options, unit: 'reference-usd', limit: 1 });
    const call = task.startCall(model, { ...rates, outputUsdPerMillion: null }, { reserved: 0.1 });
    task.reportUsage(call, usage);
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ totalTokens: 1100, referenceUsd: null, reserved: 0.1, remaining: null, budgetStatus: 'unknown', costCoverage: 'partial' });
  });

  it('rejects invalid and conflicting reports without rewriting accepted usage', () => {
    const task = new OwnedTaskUsage(ledger, options);
    const call = task.startCall(model, rates);
    for (const invalid of [{ inputTokens: -1 }, { inputTokens: NaN }, { inputTokens: 2.5 }, { inputTokens: 2, cacheReadInputTokens: 3 }]) {
      expect(() => task.reportUsage(call, invalid)).toThrow('Invalid');
    }
    task.reportUsage(call, { inputTokens: 0, outputTokens: 0 });
    const before = fs.readFileSync(ledger.path(), 'utf8');
    expect(() => task.reportUsage(call, { inputTokens: 2 })).toThrow('conflicting');
    expect(fs.readFileSync(ledger.path(), 'utf8')).toBe(before);
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ totalTokens: 0, referenceUsd: 0, remaining: 2000 });
  });

  it('does not treat cancellation or failures without usage as free calls', () => {
    const task = new OwnedTaskUsage(ledger, options);
    const call = task.startCall(model, rates, { reserved: 500 });
    task.finishCall(call, 'cancelled');
    task.finish('cancelled');
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ state: 'cancelled', totalTokens: null, reserved: 500, budgetStatus: 'unknown' });
    expect(() => task.startCall(model, rates)).toThrow('finished');
  });

  it('reports a measured overage and accepts a zero budget', () => {
    const task = new OwnedTaskUsage(ledger, { ...options, limit: 0 });
    const call = task.startCall(model, rates);
    task.reportUsage(call, usage);
    expect(buildTaskUsage(ledger.all())[0]).toMatchObject({ remaining: -1100, budgetStatus: 'exceeded', enforcement: 'not-enforced' });
    expect(() => new OwnedTaskUsage(ledger, { ...options, limit: 1.5 })).toThrow('Invalid task budget');
  });
});