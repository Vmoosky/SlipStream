import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateCostPolicy, type CostPolicy, type PolicyModel } from './costPolicy.js';
import { COMPRESSION_FEEDBACK_ACTIONS, COMPRESSION_FEEDBACK_REASONS, emptyProfileEvidence,
  type CompressionFeedbackDecision, type CompressionProfileEvidence, type CompressionTrialState } from './adaptiveCompression.js';
import { COMPRESSION_PROFILES, isCompressionProfile, type CompressionProfile } from './compressionProfiles.js';
import { OWNED_POLICY_REASONS, OWNED_TASK_CATEGORIES, PolicyPauseError, type OwnedPolicyDecision, type OwnedTaskCategory } from './ownedPolicy.js';
import { isTokenCount, priceReportedUsage, PRICING_SOURCE, validRate, type PricingSnapshot, type ReportedModelUsage } from './pricing.js';
import type { SavingsLedger } from './savingsLedger.js';
import type { LedgerEntry } from './types.js';

type TaskState = 'running' | 'finished' | 'failed' | 'cancelled' | 'paused';
type CallState = 'running' | 'finished' | 'failed' | 'cancelled' | 'interrupted';

export type TaskOutcomeEvidence =
  | { source: 'command'; check: 'test' | 'build' | 'custom'; execution: 'completed' | 'cancelled' | 'error'; exitCode: number | null; durationMs: number; checkKey?: string }
  | { source: 'user'; result: 'pass' | 'fail' };

export interface TaskOutcomeSummary {
  status: 'unverified' | 'verified-pass' | 'verified-fail' | 'user-reported' | 'cancelled';
  result: 'pass' | 'fail' | null;
  evidence: { id: string; recordedAt: number; detail: TaskOutcomeEvidence } | null;
  verificationAttempts: number;
}

interface TaskEventBase {
  version: 1;
  taskId: string;
  eventId?: string;
}

export type TaskUsageEvent = TaskEventBase & (
  | { kind: 'task-start'; policyRevision: string; unit: CostPolicy['budgetUnit']; limit: number | null; workspaceKey?: string; retrievalTracking?: boolean; retryTracking?: boolean; category?: OwnedTaskCategory; guardrails?: boolean }
  | { kind: 'call-start'; callId: string; model: PolicyModel; rates: PricingSnapshot; reserved: number; estimatedInputTokens?: number; retryOfCallId?: string }
  | { kind: 'call-usage'; callId: string; usage: ReportedModelUsage; observationKey?: string }
  | { kind: 'call-end'; callId: string; state: Exclude<CallState, 'running'>; estimatedOutputTokens?: number }
  | { kind: 'task-end'; state: Exclude<TaskState, 'running'> }
  | { kind: 'task-resume' }
  | { kind: 'task-outcome'; evidenceId: string; evidence: TaskOutcomeEvidence }
  | { kind: 'artifact-retrieval'; retrievalId: string; success: boolean; tokens?: number; overheadMs?: number }
  | { kind: 'compression-sample'; sampleId: string; profile: CompressionProfile; tokensBefore: number; tokensAfter: number; overheadMs: number }
  | { kind: 'compression-feedback'; decisionId: string; decision: CompressionFeedbackDecision }
  | { kind: 'policy-decision'; decision: OwnedPolicyDecision }
);

export interface TaskCompressionSummary {
  profile: CompressionProfile;
  samples: number;
  tokensBefore: number;
  tokensAfter: number;
  overheadMs: number;
}

export interface TaskUsageSummary {
  taskId: string;
  sessionId: string | null;
  resumes: number;
  interruptedCalls: number;
  startedAt: number;
  endedAt: number | null;
  state: TaskState;
  durationMs: number | null;
  outcome: TaskOutcomeSummary;
  workspaceKey: string | null;
  modelRetries: number | null;
  retrievals: number | null;
  recoveryFailures: number | null;
  /** Tokens handed back to the model by retrievals in this task. */
  retrievedTokens: number | null;
  /** Reported tokens spent on calls that retried an earlier failed or cancelled call. */
  retryTokens: number | null;
  /** Compression accounted to this task, split by the profile that produced it. */
  compression: TaskCompressionSummary[] | null;
  /** The most recent adaptive-compression decision recorded while the task ran. */
  compressionFeedback: CompressionFeedbackDecision | null;
  policyRevision: string;
  calls: number;
  reportedCalls: number;
  pendingCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  knownTokens: number | null;
  estimatedTokens: number | null;
  estimateCoverage: 'complete' | 'partial' | 'unavailable';
  referenceUsd: number | null;
  knownReferenceUsd: number | null;
  usageCoverage: 'complete' | 'partial' | 'unavailable';
  costCoverage: 'complete' | 'partial' | 'unavailable';
  unit: CostPolicy['budgetUnit'];
  limit: number | null;
  reserved: number | null;
  remaining: number | null;
  budgetStatus: 'not-configured' | 'unknown' | 'within' | 'exceeded';
  enforcement: 'not-enforced' | 'local-allowance';
  allowanceUsed: number | null;
  allowanceRemaining: number | null;
  policyDecision: OwnedPolicyDecision | null;
  category: OwnedTaskCategory | null;
  model: PolicyModel | null;
}

interface CallUsage {
  callId: string;
  model: PolicyModel;
  rates: PricingSnapshot;
  reserved: number;
  state: CallState;
  usage: ReportedModelUsage;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  retryOfCallId?: string;
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const;

interface OwnedTaskOptions {
  sessionId: string;
  policyRevision: string;
  unit: CostPolicy['budgetUnit'];
  limit?: number;
  workspaceKey?: string;
  retrievalTracking?: boolean;
  retryTracking?: boolean;
  category?: OwnedTaskCategory;
  guardrails?: boolean;
}

export class OwnedTaskUsage {
  readonly taskId: string;
  readonly resumed?: TaskUsageSummary;
  private readonly calls = new Map<string, CallUsage>();
  private finished = false;
  private paused = false;
  private lease?: ReturnType<typeof claimTask>;

  static resume(ledger: SavingsLedger, taskId: string, options: OwnedTaskOptions, model: PolicyModel): OwnedTaskUsage {
    return new OwnedTaskUsage(ledger, options, { taskId, model });
  }

  constructor(private readonly ledger: SavingsLedger, private readonly options: OwnedTaskOptions, resume?: { taskId: string; model: PolicyModel }) {
    this.taskId = resume?.taskId ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(this.taskId)) throw new Error('Resume requires an exact owned task ID');
    if (!['tokens', 'reference-usd'].includes(options.unit) ||
      (options.limit !== undefined && !validBudgetAmount(options.limit, options.unit)) ||
      !/^[a-f0-9]{64}$/.test(options.policyRevision)) throw new Error('Invalid task budget configuration');
    if (options.workspaceKey !== undefined && (typeof options.workspaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(options.workspaceKey))) throw new Error('Invalid task workspace key');
    if (options.category !== undefined && !OWNED_TASK_CATEGORIES.includes(options.category)) throw new Error('Invalid owned task category');
    this.options = {
      sessionId: options.sessionId, policyRevision: options.policyRevision, unit: options.unit, limit: options.limit,
      workspaceKey: options.workspaceKey, retrievalTracking: options.retrievalTracking === true, retryTracking: options.retryTracking === true,
      category: options.category, guardrails: options.guardrails === true,
    };
    if (this.options.guardrails) this.lease = claimTask(ledger, this.taskId);
    try {
      if (resume) {
        const entries = readTaskHistory(ledger);
        const restored = reconstructTaskUsage(entries).get(this.taskId);
        const summary = buildTaskUsage(entries).find((task) => task.taskId === this.taskId);
        const selected = summary?.model ?? summary?.policyDecision?.selectedModel;
        const start = entries.find((entry) => entry.taskUsage?.taskId === this.taskId && entry.taskUsage.kind === 'task-start');
        if (!this.options.guardrails || !restored?.guardrails || !start?.taskUsage?.eventId || !summary || !selected || summary.calls > 0 && !summary.model ||
          selected.vendor !== resume.model.vendor || selected.id !== resume.model.id ||
          restored.sessionId !== options.sessionId || !options.workspaceKey || restored.workspaceKey !== options.workspaceKey ||
          restored.policyRevision !== options.policyRevision || restored.unit !== options.unit || restored.limit !== (options.limit ?? null) ||
          restored.category !== (options.category ?? null) || restored.retrievalTracking !== this.options.retrievalTracking || restored.retryTracking !== this.options.retryTracking) {
          throw new Error('Resume requires retained task history and the original workspace, policy, budget, category, and model');
        }
        if (restored.state === 'finished' || restored.outcome.evidence || summary.allowanceUsed === null) throw new Error('This owned task cannot be resumed');
        for (const [callId, call] of restored.calls) this.calls.set(callId, call);
        this.resumed = summary;
        this.record({ kind: 'task-resume' });
        for (const call of this.calls.values()) if (call.state === 'running') call.state = 'interrupted';
      } else {
        this.record({
          kind: 'task-start', policyRevision: options.policyRevision, unit: options.unit, limit: options.limit ?? null,
          workspaceKey: this.options.workspaceKey, retrievalTracking: this.options.retrievalTracking, retryTracking: this.options.retryTracking,
          category: this.options.category, guardrails: this.options.guardrails,
        });
      }
    } catch (error) {
      this.lease?.release();
      this.lease = undefined;
      throw error;
    }
  }

  startCall(model: PolicyModel, rates: PricingSnapshot, estimates: { reserved?: number; inputTokens?: number; retryOfCallId?: string } = {}): string {
    this.assertActive();
    if (this.paused) throw new PolicyPauseError('budget-limit', 'Automatic task is paused; no further calls are admitted.');
    const selected = validateCostPolicy({ version: 1, mode: 'off', allowedModels: [model] }).allowedModels[0]!;
    const fixed = this.resumed?.model ?? this.resumed?.policyDecision?.selectedModel;
    if (fixed && (selected.vendor !== fixed.vendor || selected.id !== fixed.id)) throw new Error('A resumed task must retain its original model');
    if (estimates.inputTokens !== undefined && !isTokenCount(estimates.inputTokens)) throw new Error('Invalid input token estimate');
    if (!validBudgetAmount(estimates.reserved ?? 0, this.options.unit)) throw new Error('Invalid provisional allowance');
    if (this.options.guardrails && (this.options.limit === undefined || estimates.reserved === undefined ||
      this.getAllowanceUsed() + estimates.reserved > this.options.limit)) {
      throw new PolicyPauseError('budget-limit', 'Automatic task paused: the next call does not fit the remaining local allowance.');
    }
    if (estimates.retryOfCallId !== undefined && (!this.options.retryTracking || !['failed', 'cancelled'].includes(this.requireCall(estimates.retryOfCallId).state))) {
      throw new Error('A reported retry requires a failed or cancelled call in this task');
    }
    const callId = randomUUID();
    const snapshot = copyRates(rates);
    const call: CallUsage = { callId, model: selected, rates: snapshot, reserved: estimates.reserved ?? 0, state: 'running', usage: {}, estimatedInputTokens: estimates.inputTokens, retryOfCallId: estimates.retryOfCallId };
    this.record({ kind: 'call-start', callId, model: selected, rates: snapshot, reserved: call.reserved, estimatedInputTokens: estimates.inputTokens, retryOfCallId: estimates.retryOfCallId });
    this.calls.set(callId, call);
    return callId;
  }

  reportUsage(callId: string, usage: ReportedModelUsage, observationId?: string): void {
    if (this.options.guardrails && !this.lease) {
      this.lease = claimTask(this.ledger, this.taskId);
      try {
        const restored = reconstructTaskUsage(readTaskHistory(this.ledger)).get(this.taskId);
        if (!restored) throw new Error('Usage requires retained owned task history');
        this.calls.clear();
        for (const [storedId, call] of restored.calls) this.calls.set(storedId, call);
        return this.reportUsage(callId, usage, observationId);
      } finally {
        this.lease.release();
        this.lease = undefined;
      }
    }
    const call = this.requireCall(callId);
    const merged = mergeUsage(call.usage, usage);
    if (!merged) throw new Error('Invalid, inconsistent, or conflicting token usage');
    const observationKey = observationId === undefined ? undefined : createHash('sha256').update(observationId).digest('hex');
    const previous = observationKey === undefined ? undefined : this.ledger.all().find((entry) => entry.taskUsage?.kind === 'call-usage' && entry.taskUsage.observationKey === observationKey)?.taskUsage;
    if (previous?.kind === 'call-usage' && (previous.taskId !== this.taskId || previous.callId !== callId)) {
      throw new Error('Usage observation already belongs to another call');
    }
    if (JSON.stringify(merged) === JSON.stringify(call.usage) && (!observationKey || previous)) return;
    this.record({ kind: 'call-usage', callId, usage: merged, observationKey });
    call.usage = merged;
  }

  finishCall(callId: string, state: Exclude<CallState, 'running'>, estimatedOutputTokens?: number): void {
    const call = this.requireCall(callId);
    if (!['finished', 'failed', 'cancelled', 'interrupted'].includes(state) || (estimatedOutputTokens !== undefined && !isTokenCount(estimatedOutputTokens))) {
      throw new Error('Invalid call completion');
    }
    if (call.state !== 'running') return;
    this.record({ kind: 'call-end', callId, state, estimatedOutputTokens });
    call.state = state;
  }

  finish(state: Exclude<TaskState, 'running'>): void {
    if (!['finished', 'failed', 'cancelled', 'paused'].includes(state)) throw new Error('Invalid task completion');
    if (this.finished) return;
    this.record({ kind: 'task-end', state });
    this.finished = true;
    this.lease?.release();
    this.lease = undefined;
  }

  dispose(): void {
    this.finished = true;
    this.lease?.release();
    this.lease = undefined;
  }

  assertActive(): void {
    if (this.finished) throw new Error('Task has already finished');
    this.lease?.assert();
  }

  recordRetrieval(success: boolean, measured: { tokens?: number; overheadMs?: number } = {}): void {
    if (this.finished || !this.options.retrievalTracking || typeof success !== 'boolean') throw new Error('Retrieval tracking requires an active instrumented task');
    const tokens = isTokenCount(measured.tokens) ? measured.tokens : undefined;
    const overheadMs = validDuration(measured.overheadMs) ? measured.overheadMs : undefined;
    this.record({ kind: 'artifact-retrieval', retrievalId: randomUUID(), success, tokens, overheadMs });
  }

  /**
   * Account one compressed tool output to this task. Only an engine scoped to
   * the task may call this; unassociated activity must never reach the ledger
   * as task evidence.
   */
  recordCompressionSample(sample: { profile: CompressionProfile; tokensBefore: number; tokensAfter: number; overheadMs?: number }): void {
    if (this.finished || !this.options.retrievalTracking) throw new Error('Compression accounting requires an active instrumented task');
    if (!isCompressionProfile(sample?.profile) || !isTokenCount(sample.tokensBefore) || !isTokenCount(sample.tokensAfter) ||
      sample.tokensAfter > sample.tokensBefore || (sample.overheadMs !== undefined && !validDuration(sample.overheadMs))) {
      throw new Error('Invalid compression sample');
    }
    this.record({ kind: 'compression-sample', sampleId: randomUUID(), profile: sample.profile,
      tokensBefore: sample.tokensBefore, tokensAfter: sample.tokensAfter, overheadMs: sample.overheadMs ?? 0 });
  }

  recordCompressionFeedback(decision: CompressionFeedbackDecision): void {
    if (this.finished) throw new Error('Task has already finished');
    this.record({ kind: 'compression-feedback', decisionId: randomUUID(), decision: validateFeedbackDecision(decision) });
  }

  getAllowanceUsed(): number {
    return [...this.calls.values()].reduce((total, call) => total + callAllowance(call, this.options.unit), 0);
  }

  recordPolicyDecision(decision: OwnedPolicyDecision): void {
    if (this.finished) throw new Error('Task has already finished');
    const normalized = validatePolicyDecision(decision);
    this.record({ kind: 'policy-decision', decision: normalized });
    if (normalized.state === 'paused') this.paused = true;
  }

  private requireCall(callId: string): CallUsage {
    const call = this.calls.get(callId);
    if (!call) throw new Error('Usage requires an exact owned call ID');
    return call;
  }

  private record(event: Omit<Extract<TaskUsageEvent, { kind: 'task-start' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'call-start' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'call-usage' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'call-end' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'artifact-retrieval' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'compression-sample' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'compression-feedback' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'policy-decision' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'task-resume' }>, keyof TaskEventBase> |
    Omit<Extract<TaskUsageEvent, { kind: 'task-end' }>, keyof TaskEventBase>): void {
    if (this.options.guardrails) {
      if (!this.lease) throw new Error('Owned task no longer has an active owner');
      this.lease.assert();
    }
    this.ledger.record({
      ts: Date.now(), sessionId: this.options.sessionId, tool: 'session', label: 'Owned task accounting',
      strategy: 'session:task-usage', outcomeReason: 'Session event',
      tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
      taskUsage: { ...event, version: 1, taskId: this.taskId, eventId: randomUUID() } as TaskUsageEvent,
    }, { durable: this.options.guardrails });
  }
}

export function taskWorkspaceKey(roots: readonly string[]): string {
  const normalized = roots.map((root) => process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root)).sort();
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function recordTaskOutcome(ledger: SavingsLedger, taskId: string, evidence: TaskOutcomeEvidence, expected?: Pick<TaskUsageSummary, 'resumes' | 'endedAt'>): void {
  const normalized = validateOutcomeEvidence(evidence);
  const guarded = buildTaskUsage(ledger.all()).find((item) => item.taskId === taskId)?.enforcement === 'local-allowance';
  const lease = guarded ? claimTask(ledger, taskId) : undefined;
  try {
    const entries = guarded ? readTaskHistory(ledger) : ledger.all();
    const task = buildTaskUsage(entries).find((item) => item.taskId === taskId);
    if (!task || task.endedAt === null || task.pendingCalls !== 0) throw new Error('Verification requires a completed owned task');
    if (expected && (task.resumes !== expected.resumes || task.endedAt !== expected.endedAt)) throw new Error('Task resumed or completed again; select the current task before recording evidence');
    const start = entries.find((entry) => entry.taskUsage?.taskId === taskId && entry.taskUsage.kind === 'task-start');
    ledger.record({
      ts: Date.now(), sessionId: start?.sessionId, tool: 'session', label: 'Owned task outcome',
      strategy: 'session:task-usage', outcomeReason: 'Session event',
      tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
      taskUsage: { version: 1, taskId, kind: 'task-outcome', evidenceId: randomUUID(), evidence: normalized },
    }, { durable: guarded });
  } finally { lease?.release(); }
}

function reconstructTaskUsage(entries: readonly LedgerEntry[]) {
  const tasks = new Map<string, {
    sessionId: string | null; resumes: number;
    startedAt: number; endedAt: number | null; state: TaskState;
    policyRevision: string; unit: CostPolicy['budgetUnit']; limit: number | null; calls: Map<string, CallUsage>;
    outcome: TaskOutcomeSummary;
    workspaceKey: string | null; retryTracking: boolean; retrievalTracking: boolean; retrievals: number; recoveryFailures: number;
    retrievedTokens: number; retrievalOverheadMs: number; compression: Map<CompressionProfile, TaskCompressionSummary>; compressionFeedback: CompressionFeedbackDecision | null;
    category: OwnedTaskCategory | null; guardrails: boolean; policyDecision: OwnedPolicyDecision | null;
  }>();
  const observations = new Map<string, string>();
  const eventIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const retrievalIds = new Set<string>();
  const sampleIds = new Set<string>();
  for (const entry of entries) {
    const event = entry.taskUsage;
    if (entry.tool !== 'session' || entry.strategy !== 'session:task-usage' || !event || event.version !== 1 || typeof event.taskId !== 'string') continue;
    if (event.eventId) {
      if (eventIds.has(event.eventId)) continue;
      eventIds.add(event.eventId);
    }
    if (event.kind === 'task-start') {
      if (!tasks.has(event.taskId) && ['tokens', 'reference-usd'].includes(event.unit) &&
        (event.limit === null || validBudgetAmount(event.limit, event.unit))) tasks.set(event.taskId, {
        sessionId: entry.sessionId ?? null, resumes: 0,
        startedAt: entry.ts, endedAt: null, state: 'running', policyRevision: event.policyRevision,
        unit: event.unit, limit: event.limit, calls: new Map(),
        outcome: { status: 'unverified', result: null, evidence: null, verificationAttempts: 0 },
        workspaceKey: event.workspaceKey ?? null, retryTracking: event.retryTracking === true,
        retrievalTracking: event.retrievalTracking === true, retrievals: 0, recoveryFailures: 0,
        retrievedTokens: 0, retrievalOverheadMs: 0, compression: new Map(), compressionFeedback: null,
        category: event.category && OWNED_TASK_CATEGORIES.includes(event.category) ? event.category : null,
        guardrails: event.guardrails === true, policyDecision: null,
      });
      continue;
    }
    const task = tasks.get(event.taskId);
    if (!task) continue;
    if (event.kind === 'task-resume') {
      if (task.guardrails && task.state !== 'finished' && !task.outcome.evidence) {
        task.state = 'running';
        task.endedAt = null;
        task.resumes++;
        task.outcome.status = 'unverified';
        for (const call of task.calls.values()) if (call.state === 'running') call.state = 'interrupted';
      }
      continue;
    }
    if (event.kind === 'policy-decision') {
      if (task.endedAt === null) {
        try { task.policyDecision = validatePolicyDecision(event.decision); } catch { }
      }
      continue;
    }
    if (event.kind === 'artifact-retrieval') {
      if (task.retrievalTracking && task.endedAt === null && typeof event.retrievalId === 'string' &&
        typeof event.success === 'boolean' && !retrievalIds.has(event.retrievalId)) {
        retrievalIds.add(event.retrievalId);
        if (event.success) task.retrievals++; else task.recoveryFailures++;
        if (isTokenCount(event.tokens)) task.retrievedTokens += event.tokens;
        if (validDuration(event.overheadMs)) task.retrievalOverheadMs += event.overheadMs;
      }
      continue;
    }
    if (event.kind === 'compression-sample') {
      if (task.retrievalTracking && task.endedAt === null && typeof event.sampleId === 'string' && !sampleIds.has(event.sampleId) &&
        isCompressionProfile(event.profile) && isTokenCount(event.tokensBefore) && isTokenCount(event.tokensAfter) &&
        event.tokensAfter <= event.tokensBefore && validDuration(event.overheadMs)) {
        sampleIds.add(event.sampleId);
        const bucket = task.compression.get(event.profile) ??
          { profile: event.profile, samples: 0, tokensBefore: 0, tokensAfter: 0, overheadMs: 0 };
        bucket.samples++;
        bucket.tokensBefore += event.tokensBefore;
        bucket.tokensAfter += event.tokensAfter;
        bucket.overheadMs += event.overheadMs;
        task.compression.set(event.profile, bucket);
      }
      continue;
    }
    if (event.kind === 'compression-feedback') {
      if (task.endedAt === null && typeof event.decisionId === 'string') {
        try { task.compressionFeedback = validateFeedbackDecision(event.decision); } catch { }
      }
      continue;
    }
    if (event.kind === 'task-end') {
      if (task.endedAt === null && ['finished', 'failed', 'cancelled', 'paused'].includes(event.state)) {
        task.endedAt = entry.ts;
        task.state = event.state;
        if (event.state === 'cancelled') task.outcome.status = 'cancelled';
      }
      continue;
    }
    if (event.kind === 'task-outcome') {
      if (task.endedAt === null || typeof event.evidenceId !== 'string' || evidenceIds.has(event.evidenceId) ||
        [...task.calls.values()].some((call) => call.state === 'running')) continue;
      let detail: TaskOutcomeEvidence;
      try { detail = validateOutcomeEvidence(event.evidence); } catch { continue; }
      evidenceIds.add(event.evidenceId);
      const result = detail.source === 'user' ? detail.result : detail.execution !== 'completed' ? null : detail.exitCode === 0 ? 'pass' : 'fail';
      task.outcome = {
        status: detail.source === 'user' ? 'user-reported' : detail.execution === 'cancelled' ? 'cancelled' : detail.execution === 'error' ? 'unverified' : result === 'pass' ? 'verified-pass' : 'verified-fail',
        result, evidence: { id: event.evidenceId, recordedAt: entry.ts, detail },
        verificationAttempts: task.outcome.verificationAttempts + (detail.source === 'command' ? 1 : 0),
      };
      continue;
    }
    if (event.kind === 'call-start') {
      if (event.retryOfCallId !== undefined && (!task.retryTracking || !['failed', 'cancelled'].includes(task.calls.get(event.retryOfCallId)?.state ?? 'running'))) continue;
      if (!task.calls.has(event.callId) && event.rates && validBudgetAmount(event.reserved, task.unit)) task.calls.set(event.callId, {
        callId: event.callId, model: event.model, rates: event.rates, reserved: event.reserved, state: 'running', usage: {},
        estimatedInputTokens: isTokenCount(event.estimatedInputTokens) ? event.estimatedInputTokens : undefined,
        retryOfCallId: event.retryOfCallId,
      });
      continue;
    }
    const call = task.calls.get(event.callId);
    if (!call) continue;
    if (event.kind === 'call-usage') {
      const owner = `${event.taskId}/${event.callId}`;
      if (event.observationKey && observations.has(event.observationKey) && observations.get(event.observationKey) !== owner) continue;
      const merged = mergeUsage(call.usage, event.usage);
      if (!merged) continue;
      call.usage = merged;
      if (event.observationKey) observations.set(event.observationKey, owner);
    } else if (event.kind === 'call-end' && call.state === 'running' && ['finished', 'failed', 'cancelled', 'interrupted'].includes(event.state)) {
      call.state = event.state;
      call.estimatedOutputTokens = isTokenCount(event.estimatedOutputTokens) ? event.estimatedOutputTokens : undefined;
    }
  }
  return tasks;
}

export function buildTaskUsage(entries: readonly LedgerEntry[]): TaskUsageSummary[] {
  return [...reconstructTaskUsage(entries)].map(([taskId, task]): TaskUsageSummary => {
    const calls = [...task.calls.values()];
    const knownTokens = safeTokenSum(calls.flatMap((call) => [call.usage.inputTokens ?? 0, call.usage.outputTokens ?? 0]));
    const reportedCalls = calls.filter((call) => call.usage.inputTokens !== undefined && call.usage.outputTokens !== undefined).length;
    const complete = reportedCalls === calls.length && knownTokens !== null;
    const costs = calls.map((call) => priceReportedUsage(call.rates, call.usage));
    const knownReferenceUsd = costs.reduce((total, cost) => total + cost.knownUsd, 0);
    const costComplete = costs.every((cost) => cost.usd !== null) && Number.isFinite(knownReferenceUsd);
    const referenceUsd = costComplete ? knownReferenceUsd : null;
    const totalTokens = complete ? knownTokens : null;
    const reservedTotal = calls.reduce((total, call, index) => total + ((task.unit === 'tokens'
      ? call.usage.inputTokens !== undefined && call.usage.outputTokens !== undefined : costs[index]!.usd !== null) ? 0 : call.reserved), 0);
    const reserved = validBudgetAmount(reservedTotal, task.unit) ? reservedTotal : null;
    const measured = task.unit === 'tokens' ? totalTokens : referenceUsd;
    const known = task.unit === 'tokens' ? knownTokens : knownReferenceUsd;
    const estimates = calls.flatMap((call) => [call.estimatedInputTokens, call.estimatedOutputTokens]).filter(isTokenCount);
    const allowanceUsed = calls.reduce((total, call) => total + callAllowance(call, task.unit), 0);
    const models = new Map(calls.filter((call) => call.model).map((call) => [`${call.model.vendor}\0${call.model.id}`, call.model]));
    return {
      sessionId: task.sessionId, resumes: task.resumes, interruptedCalls: calls.filter((call) => call.state === 'interrupted').length,
      taskId, startedAt: task.startedAt, endedAt: task.endedAt, state: task.state, policyRevision: task.policyRevision,
      durationMs: task.endedAt !== null && Number.isFinite(task.endedAt - task.startedAt) && task.endedAt >= task.startedAt ? task.endedAt - task.startedAt : null,
      outcome: task.outcome,
      workspaceKey: task.workspaceKey,
      modelRetries: task.retryTracking ? calls.filter((call) => call.retryOfCallId !== undefined).length : null,
      retrievals: task.retrievalTracking ? task.retrievals : null,
      recoveryFailures: task.retrievalTracking ? task.recoveryFailures : null,
      retrievedTokens: task.retrievalTracking ? task.retrievedTokens : null,
      retryTokens: task.retryTracking ? safeTokenSum(calls.filter((call) => call.retryOfCallId !== undefined)
        .flatMap((call) => [call.usage.inputTokens ?? 0, call.usage.outputTokens ?? 0])) : null,
      compression: task.retrievalTracking ? COMPRESSION_PROFILES.flatMap((profile) => {
        const bucket = task.compression.get(profile);
        return bucket ? [{ ...bucket, overheadMs: bucket.overheadMs + (task.compression.size === 1 ? task.retrievalOverheadMs : 0) }] : [];
      }) : null,
      compressionFeedback: task.compressionFeedback,
      calls: calls.length, reportedCalls, pendingCalls: calls.filter((call) => call.state === 'running').length,
      inputTokens: calls.every((call) => call.usage.inputTokens !== undefined) ? safeTokenSum(calls.map((call) => call.usage.inputTokens!)) : null,
      outputTokens: calls.every((call) => call.usage.outputTokens !== undefined) ? safeTokenSum(calls.map((call) => call.usage.outputTokens!)) : null,
      totalTokens, knownTokens,
      estimatedTokens: estimates.length ? safeTokenSum(estimates) : null,
      estimateCoverage: !estimates.length ? 'unavailable' : estimates.length === calls.length * 2 && safeTokenSum(estimates) !== null ? 'complete' : 'partial',
      referenceUsd, knownReferenceUsd: Number.isFinite(knownReferenceUsd) ? knownReferenceUsd : null,
      usageCoverage: complete ? 'complete' : calls.some((call) => Object.keys(call.usage).length > 0) ? 'partial' : 'unavailable',
      costCoverage: costComplete ? 'complete' : costs.some((cost) => cost.coverage !== 'unavailable') ? 'partial' : 'unavailable',
      unit: task.unit, limit: task.limit, reserved, remaining: task.limit !== null && measured !== null && reserved !== null ? task.limit - measured - reserved : null,
      budgetStatus: task.limit === null ? 'not-configured' : known !== null && known > task.limit ? 'exceeded' : measured === null || reserved === null ? 'unknown' : 'within',
      enforcement: task.guardrails ? 'local-allowance' : 'not-enforced',
      allowanceUsed: task.guardrails && validBudgetAmount(allowanceUsed, task.unit) ? allowanceUsed : null,
      allowanceRemaining: task.guardrails && task.limit !== null && validBudgetAmount(allowanceUsed, task.unit) ? task.limit - allowanceUsed : null,
      category: task.category, model: models.size === 1 ? { ...models.values().next().value! } : null,
      policyDecision: task.policyDecision,
    };
  }).sort((first, second) => second.startedAt - first.startedAt);
}

export function policyModelEvidence(entries: readonly LedgerEntry[], workspaceKey: string, category: OwnedTaskCategory | undefined, now = Date.now()) {
  const evidence = new Map<string, { verifiedPasses: number; verifiedFailures: number }>();
  if (!category) return evidence;
  const samples = new Map<string, number>();
  for (const task of buildTaskUsage(entries)) {
    if (task.workspaceKey !== workspaceKey || task.category !== category || !task.model || task.endedAt === null ||
      task.endedAt > now || task.endedAt < now - 30 * 24 * 60 * 60 * 1000 || task.pendingCalls !== 0 ||
      !['finished', 'failed'].includes(task.state) || !['verified-pass', 'verified-fail'].includes(task.outcome.status)) continue;
    const key = `${task.model.vendor}\0${task.model.id}`;
    const count = samples.get(key) ?? 0;
    if (count >= 20) continue;
    samples.set(key, count + 1);
    const totals = evidence.get(key) ?? { verifiedPasses: 0, verifiedFailures: 0 };
    if (task.outcome.status === 'verified-pass' && task.state === 'finished') totals.verifiedPasses++;
    else totals.verifiedFailures++;
    evidence.set(key, totals);
  }
  return evidence;
}

/**
 * Per-profile compression evidence for the adaptive feedback loop.
 *
 * Only tasks with a verified outcome, a single compression profile, and a
 * single model contribute: activity that cannot be attributed to one task, one
 * profile, and one model must never drive task-quality adaptation.
 */
export function compressionProfileEvidence(entries: readonly LedgerEntry[], workspaceKey: string,
  category: OwnedTaskCategory | undefined, now = Date.now()): CompressionProfileEvidence[] {
  const evidence = new Map<CompressionProfile, CompressionProfileEvidence>();
  for (const task of buildTaskUsage(entries)) {
    if (task.workspaceKey !== workspaceKey || (category !== undefined && task.category !== category) || !task.model ||
      task.endedAt === null || task.endedAt > now || task.endedAt < now - 30 * 24 * 60 * 60 * 1000 || task.pendingCalls !== 0 ||
      !['finished', 'failed'].includes(task.state) || !['verified-pass', 'verified-fail'].includes(task.outcome.status)) continue;
    const bucket = task.compression?.length === 1 ? task.compression[0]! : undefined;
    if (!bucket || bucket.samples === 0) continue;
    const totals = evidence.get(bucket.profile) ?? emptyProfileEvidence(bucket.profile);
    if (totals.tasks >= 20) continue;
    totals.tasks++;
    if (task.outcome.status === 'verified-pass' && task.state === 'finished') totals.verifiedPasses++;
    else totals.verifiedFailures++;
    totals.samples += bucket.samples;
    totals.tokensBefore += bucket.tokensBefore;
    totals.tokensAfter += bucket.tokensAfter;
    totals.overheadMs += bucket.overheadMs;
    totals.retrievedTokens += task.retrievedTokens ?? 0;
    totals.retryTokens += task.retryTokens ?? 0;
    totals.retrievals += task.retrievals ?? 0;
    totals.recoveryFailures += task.recoveryFailures ?? 0;
    evidence.set(bucket.profile, totals);
  }
  return COMPRESSION_PROFILES.flatMap((profile) => evidence.get(profile) ?? []);
}

/**
 * The trial and cooldown bookkeeping carried by the most recent recorded
 * feedback decision in this workspace. Reconstructed from the append-only
 * ledger so a trial survives a restart without rewriting history.
 */
export function compressionTrialState(entries: readonly LedgerEntry[], workspaceKey: string): CompressionTrialState | null {
  for (const task of buildTaskUsage(entries)) {
    if (task.workspaceKey !== workspaceKey || !task.compressionFeedback) continue;
    return task.compressionFeedback.trial;
  }
  return null;
}

function validateFeedbackDecision(value: CompressionFeedbackDecision): CompressionFeedbackDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 ||
    Object.keys(value).some((key) => !['version', 'action', 'reason', 'profile', 'signal', 'trial'].includes(key)) ||
    !COMPRESSION_FEEDBACK_ACTIONS.includes(value.action) || !COMPRESSION_FEEDBACK_REASONS.includes(value.reason) ||
    !isCompressionProfile(value.profile)) throw new Error('Invalid compression feedback decision');
  const signal = value.signal ?? null;
  if (signal !== null && (typeof signal !== 'object' || Array.isArray(signal) || !isCompressionProfile(signal.profile) ||
    !Object.values(signal).every((field) => typeof field === 'string' || (typeof field === 'number' && Number.isFinite(field))))) {
    throw new Error('Invalid compression feedback signal');
  }
  const trial = value.trial ?? null;
  if (trial !== null && (typeof trial !== 'object' || Array.isArray(trial) || !isCompressionProfile(trial.profile) ||
    !isCompressionProfile(trial.baseline) || !Number.isFinite(trial.startedAt) || !Number.isFinite(trial.lastChangeAt) ||
    !trial.rollbacks || typeof trial.rollbacks !== 'object' || Array.isArray(trial.rollbacks) ||
    Object.entries(trial.rollbacks).some(([profile, count]) => !isCompressionProfile(profile) || !Number.isSafeInteger(count) || (count as number) < 0))) {
    throw new Error('Invalid compression trial state');
  }
  return structuredClone({ version: 1, action: value.action, reason: value.reason, profile: value.profile, signal, trial });
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function callAllowance(call: CallUsage, unit: CostPolicy['budgetUnit']): number {  const known = unit === 'tokens' ? (call.usage.inputTokens ?? 0) + (call.usage.outputTokens ?? 0) : priceReportedUsage(call.rates, call.usage).knownUsd;
  return Math.max(call.reserved, known);
}

function readTaskHistory(ledger: SavingsLedger): LedgerEntry[] {
  const raw = fs.readFileSync(ledger.path(), 'utf8');
  if (!raw.endsWith('\n')) throw new Error('Owned task history is incomplete; resume is unavailable');
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as LedgerEntry);
}

function claimTask(ledger: SavingsLedger, taskId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(taskId)) throw new Error('An exact owned task ID is required');
  const lockPath = path.join(path.dirname(ledger.path()), `.owned-task-${taskId}.lock`);
  const token = randomUUID();
  const create = () => fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600, flush: true });
  const owner = () => JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; token: string };
  try { create(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const reclaimPath = `${lockPath}.reclaim`;
    let acquired = false;
    try {
      fs.writeFileSync(reclaimPath, token, { flag: 'wx', mode: 0o600 });
      acquired = true;
      const existing = owner();
      if (!Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== 'string') throw new Error('Cannot establish the previous task owner');
      let dead = false;
      try { process.kill(existing.pid, 0); }
      catch (failure) { dead = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead) throw new Error('Owned task is already active in another request or process');
      fs.unlinkSync(lockPath);
      create();
    } finally {
      if (acquired) fs.rmSync(reclaimPath, { force: true });
    }
  }
  return {
    assert() {
      if (owner().token !== token) throw new Error('Owned task ownership changed');
    },
    release() {
      if (fs.existsSync(lockPath) && owner().token === token) fs.unlinkSync(lockPath);
    },
  };
}

function validatePolicyDecision(value: OwnedPolicyDecision): OwnedPolicyDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !['state', 'reason', 'requestedModel', 'selectedModel', 'profile'].includes(key)) ||
    !['active', 'paused'].includes(value.state) || !OWNED_POLICY_REASONS.includes(value.reason) ||
    (value.profile !== undefined && !isCompressionProfile(value.profile))) throw new Error('Invalid owned policy decision');
  const copyModel = (model: PolicyModel) => validateCostPolicy({ version: 1, mode: 'off', allowedModels: [model] }).allowedModels[0]!;
  return { state: value.state, reason: value.reason,
    ...(value.requestedModel === undefined ? {} : { requestedModel: copyModel(value.requestedModel) }),
    ...(value.selectedModel === undefined ? {} : { selectedModel: copyModel(value.selectedModel) }),
    ...(value.profile === undefined ? {} : { profile: value.profile }),
  };
}

function validateOutcomeEvidence(value: TaskOutcomeEvidence): TaskOutcomeEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task outcome evidence');
  if (value.source === 'user' && Object.keys(value).every((key) => ['source', 'result'].includes(key)) && ['pass', 'fail'].includes(value.result)) {
    return { source: 'user', result: value.result };
  }
  if (value.source === 'command' && Object.keys(value).every((key) => ['source', 'check', 'execution', 'exitCode', 'durationMs', 'checkKey'].includes(key)) &&
    ['test', 'build', 'custom'].includes(value.check) && ['completed', 'cancelled', 'error'].includes(value.execution) &&
    (value.checkKey === undefined || (typeof value.checkKey === 'string' && /^[a-f0-9]{64}$/.test(value.checkKey))) &&
    typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= Number.MAX_SAFE_INTEGER &&
    (value.execution === 'completed' ? Number.isSafeInteger(value.exitCode) : value.exitCode === null)) {
    return { source: 'command', check: value.check, execution: value.execution, exitCode: value.exitCode, durationMs: value.durationMs,
      ...(value.checkKey === undefined ? {} : { checkKey: value.checkKey }) };
  }
  throw new Error('Invalid task outcome evidence');
}

function validBudgetAmount(value: unknown, unit: CostPolicy['budgetUnit']): value is number {
  return validRate(value) && value <= Number.MAX_SAFE_INTEGER && (unit !== 'tokens' || isTokenCount(value));
}

function safeTokenSum(values: readonly number[]): number | null {
  const total = values.reduce((sum, value) => sum + value, 0);
  return isTokenCount(total) ? total : null;
}

function mergeUsage(current: ReportedModelUsage, supplied: ReportedModelUsage): ReportedModelUsage | undefined {
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return;
  const merged: ReportedModelUsage = {};
  for (const field of USAGE_FIELDS) {
    const value = supplied[field] ?? current[field];
    if (supplied[field] !== undefined && (!isTokenCount(supplied[field]) || (current[field] !== undefined && current[field] !== supplied[field]))) return;
    if (value !== undefined) merged[field] = value;
  }
  if (merged.inputTokens !== undefined && (merged.cacheReadInputTokens ?? 0) + (merged.cacheCreationInputTokens ?? 0) > merged.inputTokens) return;
  return merged;
}

function copyRates(snapshot: PricingSnapshot): PricingSnapshot {
  return {
    basis: 'public-api-reference', mode: snapshot.mode, assumption: 'standard-uncached-input',
    providerId: snapshot.providerId, modelId: snapshot.modelId,
    inputUsdPerMillion: validRate(snapshot.inputUsdPerMillion) ? snapshot.inputUsdPerMillion : null,
    outputUsdPerMillion: validRate(snapshot.outputUsdPerMillion) ? snapshot.outputUsdPerMillion : null,
    cacheReadUsdPerMillion: validRate(snapshot.cacheReadUsdPerMillion) ? snapshot.cacheReadUsdPerMillion : null,
    cacheWriteUsdPerMillion: validRate(snapshot.cacheWriteUsdPerMillion) ? snapshot.cacheWriteUsdPerMillion : null,
    source: [PRICING_SOURCE, 'manual', 'manual-override'].includes(snapshot.source) ? snapshot.source : 'unavailable',
    fetchedAt: snapshot.fetchedAt, revision: snapshot.revision, stale: snapshot.stale, status: snapshot.status,
  };
}