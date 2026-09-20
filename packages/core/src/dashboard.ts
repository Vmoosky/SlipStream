import { createHash } from 'node:crypto';

import type { CompressionEngine } from './engine.js';
import type { CostPolicy } from './costPolicy.js';
import type { PolicyRecommendation, PolicyRecommendationRequest } from './ownedPolicy.js';
import { MODEL_OBSERVATION_SOURCE_LABELS, readCliModelTrackingState, type CliModelTrackingState, type ModelTelemetryHealth } from './modelTelemetry.js';
import { BENCHMARK_REFERENCE } from './benchmarkReference.js';
import { COMPRESSION_PROFILES, type CompressionProfile } from './compressionProfiles.js';
import type { SavingsBaseline } from './baselineStore.js';
import { parseMarkers } from './markers.js';
import { aggregateCost, attributeSavingsPricing, priceReportedInput, type CostTotal, type ModelInputCost, type PricingConfig } from './pricing.js';
import { buildTaskUsage, type TaskUsageSummary } from './taskUsage.js';
import type { LedgerEntry, SavingsSummary } from './types.js';
import { formatDashboardReportMarkdown, formatDashboardReportJson, formatDashboardReportCsv } from './dashboardReports.js';

/** A contiguous range of the raw output that was replaced by a marker. */
export interface OmittedRange {
  startLine: number;
  endLine: number;
}

export interface DashboardEvent extends LedgerEntry {
  eventId?: string;
}

export interface DashboardSummaryPayload {
  type: 'summary';
  profileOptions: readonly CompressionProfile[];
  pricingStatus: ReturnType<CompressionEngine['pricing']['status']>;
  pricingSnapshot: ReturnType<CompressionEngine['pricing']['snapshot']>;
  modelDetectedAt: number | null;
  modelObservation: Pick<NonNullable<LedgerEntry['modelObservation']>,
    'provider' | 'requestModel' | 'responseModel' | 'startedAt' | 'endedAt'
    | 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'> | null;
  modelObservations: DashboardModelObservationItem[];
  modelUsage: DashboardModelUsageItem[];
  contextGrowth: DashboardContextGrowth;
  costPolicy: ReturnType<CompressionEngine['getCostPolicyAssessment']>;
  costPolicySettings: { value: CostPolicy; editable: boolean };
  canRecommendModels: boolean;
  canListPolicyModels: boolean;
  taskUsage: { totalTasks: number; tasks: TaskUsageSummary[]; outcomes: Record<TaskUsageSummary['outcome']['status'], number> };
  modelTracking?: DashboardModelTrackingStatus;
  /**
   * Standalone consent state, present only when VS Code is not supplying
   * `modelTracking`. Lets the CLI-only dashboard explain how to switch tracking
   * on instead of pointing at an extension the user may not have.
   */
  cliModelTracking?: CliModelTrackingState;
  enabled: boolean;
  config: DashboardConfigPayload;
  traffic: DashboardTrafficPayload;
  summary: SavingsSummary;
  tokenFlow: DashboardTokenFlowPayload;
  workspaceAttribution: DashboardWorkspaceAttributionItem[];
  outcomeBreakdown: DashboardOutcomeBreakdownItem[];
  reuseHealth: DashboardReuseHealthPayload;
  timingBreakdown: DashboardTimingBreakdownItem[];
  strategyBreakdown: DashboardStrategyBreakdownItem[];
  retrievalAudit: DashboardRetrievalAuditPayload;
  timeline: DashboardTimelineItem[];
  outputGroups: DashboardOutputGroup[];
  lifetime: DashboardLifetimePayload;
  history: DashboardHistoryBucket[];
  wasteSignals: DashboardWasteSignal[];
  costAttribution: DashboardCostAttributionPayload;
  comparison: DashboardComparisonPayload;
  events: DashboardEvent[];
}

export interface DashboardComparisonDelta {
  metric: string;
  current: number;
  baseline: number;
  change: number;
  /** Percent change, or undefined when the baseline is zero. */
  percentChange?: number;
  unit: 'tokens' | 'percent' | 'ms';
}

export interface DashboardComparisonPayload {
  current: SavingsBaseline;
  baseline?: SavingsBaseline;
  benchmark: typeof BENCHMARK_REFERENCE;
  deltas: DashboardComparisonDelta[];
}

export interface DashboardCostBucket {
  id: string;
  label: string;
  calls: number;
  tokens: number;
  usd: number | null;
}

export interface DashboardCostAttributionPayload {
  buckets: DashboardCostBucket[];
  grossTokensSaved: number;
  grossUsd: number | null;
  retrievalTokens: number;
  retrievalUsd: number | null;
  netTokensSaved: number;
  netUsd: number | null;
  cost: CostTotal;
  models: { label: string; cost: CostTotal }[];
  /**
   * Cross-turn dedup runs inside another strategy's output, so its saving is
   * already counted in the bucket for that call. Only the occurrence count can
   * be attributed to dedup on its own.
   */
  dedupCalls: number;
  usdPerMillionTokens: number;
}

/** A concrete kind of waste Slipstream removed, counted over the whole ledger. */
export interface DashboardWasteSignal {
  id: string;
  label: string;
  calls: number;
  tokensSaved: number;
  detail: string;
}

/**
 * Totals over the whole ledger. The panels above are computed from the recent
 * window, so these are what to trust for "how much has this saved overall".
 */
export interface DashboardLifetimePayload {
  events: number;
  chatsObserved: number;
  observedToolCalls: number;
  compressions: number;
  retrievals: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  percentSaved: number;
  estimatedCostSavedUsd: number | null;
  firstEventAt?: number;
  lastEventAt?: number;
  /** How many recent events the session panels are computed from. */
  recentWindow: number;
}

export interface DashboardHistoryBucket {
  date: string;
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  percentSaved: number;
}

export interface DashboardModelObservationItem {
  ts: number;
  model: string;
  vendor: string;
  /**
   * Which Copilot surface produced the call. Distinct from `scope`: a CLI turn
   * is chat-scoped too, so scope alone cannot tell the producers apart.
   */
  source: 'vscode' | 'cli';
  /** Chat calls update the detected model; background calls never do. */
  scope: 'chat' | 'background';
  nested: boolean;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  inputUsdPerMillion: number | null;
  inputCost: ModelInputCost;
}

export interface DashboardModelUsageItem {
  model: string;
  vendor: string;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  inputReportedCalls: number;
  outputReportedCalls: number;
  cacheReadReportedCalls: number;
  firstSeenAt: number;
  lastSeenAt: number;
  inputUsdPerMillion: number | null;
  inputRateReason: string | null;
}

export interface DashboardContextGrowth {
  startAt: number | null;
  endAt: number | null;
  windowMinutes: number;
  bucketMinutes: number;
  observationCount: number;
  observationLimit: number;
  observations: DashboardContextObservation[];
  savings: DashboardContextSavingsInterval[];
}

export interface DashboardContextObservation {
  ts: number;
  model: string;
  vendor: string;
  scope: 'chat' | 'background';
  inputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheSharePercent: number | null;
}

export interface DashboardContextSavingsInterval {
  startAt: number;
  endAt: number;
  toolOutputs: number;
  tokensSaved: number;
  retrievalTokens: number;
  netTokensSaved: number;
}

export interface DashboardModelTrackingStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'blocked' | 'error';
  detail: string;
  canConnect: boolean;
  canDisconnect: boolean;
  receiverHealth?: ModelTelemetryHealth;
  receiverHealthScope?: 'window' | 'shared';
}

export interface DashboardModelTrackingControls {
  status(): DashboardModelTrackingStatus;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface DashboardServerStatus {
  viewerConnections: number;
  modelTracking?: DashboardModelTrackingStatus;
  canManageModelTracking?: boolean;
  canEditCostPolicy?: boolean;
  canRecommendModels?: boolean;
  canListPolicyModels?: boolean;
}

export interface DashboardPolicyModel {
  vendor: string;
  id: string;
  name: string;
  authorized: boolean;
}

export interface DashboardCostPolicyControls {
  canEdit(): boolean;
  save(policy: CostPolicy, expectedRevision: string): Promise<void>;
  recommend?(request: PolicyRecommendationRequest, expectedRevision: string): Promise<PolicyRecommendation>;
  listModels?(): Promise<DashboardPolicyModel[]>;
}

export interface DashboardTrafficPayload {
  viewerConnections: number;
  producerSessions: number;
  /** Minutes a producer keeps counting as active after its last event. */
  activeWindowMinutes: number;
  totalOutputs: number;
  currentSessionId: string;
  currentSessionLabel: string;
}

export interface DashboardOutputGroup {
  id: string;
  label: string;
  calls: number;
  tokensSaved: number;
  events: DashboardEvent[];
}

export interface DashboardWorkspaceAttributionItem {
  id: string;
  label: string;
  root?: string;
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  percentSaved: number;
  lastActivity: string;
}

export interface DashboardTokenFlowPayload {
  rawTokens: number;
  returnedTokens: number;
  omittedTokens: number;
  retrievedTokens: number;
  netSavedTokens: number;
}

export interface DashboardOutcomeBreakdownItem {
  reason: string;
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}

export interface DashboardReuseHealthPayload {
  markersEmitted: number;
  markersRetrieved: number;
  retrievalRate: number;
  omittedLines: number;
  retrievedLines: number;
  dedupMarkers: number;
  unchangedReadHits: number;
  diffReadHits: number;
  artifactEntries: number;
  artifactBytes: number;
  artifactMaxEntries: number;
  artifactMaxBytes: number;
  artifactEntryPercent: number;
  artifactBytePercent: number;
}

export interface DashboardTimingBreakdownItem {
  name: string;
  calls: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  strategies: string[];
}

export interface DashboardConfigPayload {
  pricing: PricingConfig;
  profile: CompressionProfile;
  enabled: boolean;
  compressLogs: boolean;
  readLifecycle: boolean;
  crossTurnDedup: boolean;
  maxFileLines: number;
  usdPerMillionTokens: number;
  artifactIdleTtlMinutes: number;
  artifactMaxEntries: number;
  artifactMaxTotalMiB: number;
}

export interface DashboardRetrievalLifecyclePayload {
  shownToModel: number;
  retrievedById: number;
  retrievedByGrep: number;
  expired: number;
  stillRetrievable: number;
}

export interface DashboardRetrievalAuditPayload {
  totalMarkers: number;
  retrievedMarkers: number;
  unretrievedMarkers: number;
  percentUnretrieved: number;
  omittedLines: number;
  retrievedLines: number;
  lifecycle: DashboardRetrievalLifecyclePayload;
  items: DashboardRetrievalAuditItem[];
}

export interface DashboardRetrievalAuditItem {
  ts: number;
  label: string;
  strategy: string;
  markerCount: number;
  retrievedMarkers: number;
  unretrievedMarkers: number;
  omittedLines: number;
  retrievedLines: number;
  tokensSaved: number;
}

export interface DashboardStrategyBreakdownItem {
  name: string;
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  percentSaved: number;
  strategies: string[];
}

export interface DashboardTimelineItem {
  ts: number;
  eventId?: string;
  time: string;
  kind: string;
  title: string;
  detail: string;
  tool: string;
  strategy: string;
  tokensSaved: number;
  durationMs?: number;
  inspectable: boolean;
}

export interface DashboardDetailPayload {
  type: 'detail';
  ts: number;
  eventId?: string;
  label: string;
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  modelPayload: DashboardModelPayloadMeta;
  diffSummary: DashboardDiffSummary;
  before?: string;
  after?: string;
  omitted: OmittedRange[];
}

export interface DashboardDiffSummary {
  keptLines: number;
  removedLines: number;
  tokensSaved: number;
  percentSaved: number;
}

export interface DashboardModelPayloadMeta {
  tokens: number;
  lines: number;
  markerCount: number;
}

/**
 * Share of a conversation's own peak context an observation must reach before it
 * is taken as that conversation's model.
 *
 * Scope alone is not enough. Copilot interleaves small internal housekeeping
 * calls (title generation, intent classification) with the real turns, and those
 * calls sometimes carry the conversation id, so they pass a conversationId
 * check. Their input is typically two orders of magnitude smaller than a real
 * turn's, so measuring against the conversation's *own* peak separates them
 * without hardcoding an absolute token floor: a genuinely short session has a
 * correspondingly low bar, and the test scales with whatever context the model
 * is actually carrying.
 */
const MODEL_CONTEXT_SHARE = 0.1;

function conversationKey(entry: LedgerEntry): string {
  const observation = entry.modelObservation;
  return observation?.conversationId || observation?.chatSessionId || entry.sessionId || '';
}

/**
 * The most recent observation that plausibly reflects the model the user is
 * actually talking to. Picking purely by recency lets a background call that
 * happens to land last hijack the headline.
 */
function pickDetectedModelEvent(entries: readonly LedgerEntry[]): LedgerEntry | undefined {
  const candidates = entries.filter((entry) => {
    if (entry.strategy !== 'session:model' && !entry.pricing?.detectedModel) return false;
    const observation = entry.modelObservation;
    // Entries with no observation at all keep their previous meaning.
    if (!observation) return true;
    return Boolean(observation.conversationId || observation.chatSessionId);
  });

  const peakByConversation = new Map<string, number>();
  for (const entry of candidates) {
    const input = entry.modelObservation?.inputTokens;
    if (typeof input !== 'number') continue;
    const key = conversationKey(entry);
    peakByConversation.set(key, Math.max(peakByConversation.get(key) ?? 0, input));
  }

  let latest: LedgerEntry | undefined;
  for (const entry of candidates) {
    const input = entry.modelObservation?.inputTokens;
    if (typeof input === 'number') {
      const peak = peakByConversation.get(conversationKey(entry)) ?? 0;
      // Fail open when there is no peak to compare against yet.
      if (peak > 0 && input < peak * MODEL_CONTEXT_SHARE) continue;
    }
    if (!latest || entry.ts >= latest.ts) latest = entry;
  }
  return latest;
}

function recentDashboardEvents(entries: readonly LedgerEntry[], count: number): DashboardEvent[] {
  const occurrences = new Map<string, number>();
  const events: DashboardEvent[] = [];
  const pricedEntries = attributeSavingsPricing(entries);
  entries.forEach((entry, index) => {
    const fingerprint = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    if (index >= entries.length - count) {
      const event: DashboardEvent = { ...pricedEntries[index]!, eventId: `${fingerprint}:${occurrence}` };
      delete event.toolCall;
      delete event.toolObservation;
      delete event.telemetryConflict;
      delete event.modelObservation;
      delete event.telemetrySource;
      if (entry.modelObservation || entry.toolObservation || entry.telemetryConflict || entry.sessionId?.startsWith('copilot-otel:')) {
        event.sessionId = `copilot-otel:${createHash('sha256').update(JSON.stringify([
          entry.telemetrySource, entry.sessionId ?? entry.modelObservation?.traceId ?? entry.toolObservation?.traceId ?? entry.telemetryConflict?.traceId,
        ])).digest('hex')}`;
      }
      events.push(event);
    }
  });
  return events.reverse();
}

export function buildSummaryPayload(
  engine: CompressionEngine,
  status: DashboardServerStatus = { viewerConnections: 0 },
): DashboardSummaryPayload {
  const lifetimeEvents = engine.ledger.all();
  const events = recentDashboardEvents(lifetimeEvents, RECENT_WINDOW);
  const config = buildConfigPayload(engine);
  const retrievalAudit = buildRetrievalAudit(engine, events);
  const modelEvent = pickDetectedModelEvent(lifetimeEvents);
  const observation = modelEvent?.modelObservation;
  const detectedModel = modelEvent?.detectedModel ?? modelEvent?.pricing?.detectedModel;
  const tasks = buildTaskUsage(lifetimeEvents);
  const outcomes = { 'verified-pass': 0, 'verified-fail': 0, 'user-reported': 0, cancelled: 0, unverified: 0 };
  for (const task of tasks) outcomes[task.outcome.status]++;
  return {
    type: 'summary',
    pricingStatus: engine.pricing.status(),
    pricingSnapshot: engine.pricing.snapshot({ mode: 'automatic' }, 0, detectedModel),
    modelDetectedAt: modelEvent?.ts ?? null,
    modelObservation: observation ? {
      provider: observation.provider, requestModel: observation.requestModel, responseModel: observation.responseModel,
      startedAt: observation.startedAt, endedAt: observation.endedAt,
      inputTokens: observation.inputTokens, outputTokens: observation.outputTokens,
      cacheReadInputTokens: observation.cacheReadInputTokens, cacheCreationInputTokens: observation.cacheCreationInputTokens,
    } : null,
    modelObservations: buildModelObservations(lifetimeEvents),
    modelUsage: buildModelUsage(engine, lifetimeEvents),
    contextGrowth: buildContextGrowth(lifetimeEvents),
    costPolicy: engine.getCostPolicyAssessment(),
    costPolicySettings: { value: engine.getConfig().costPolicy, editable: status.canEditCostPolicy === true },
    canRecommendModels: status.canRecommendModels === true,
    canListPolicyModels: status.canListPolicyModels === true,
    taskUsage: { totalTasks: tasks.length, tasks: tasks.slice(0, 25), outcomes },
    modelTracking: status.modelTracking,
    // Only meaningful without VS Code: when the extension is driving tracking it
    // owns the status, and a second source would just contradict it. Falling back
    // to an explicit "not consented" state matters — a first-time CLI user has no
    // file at all, and that is exactly who needs the setup steps.
    // Only meaningful when VS Code is not actively reporting status. A standalone
    // server can still *offer* to bridge to VS Code (canManageModelTracking), but
    // gating on that would hide these steps from precisely the CLI-only user who
    // needs them — the bridge is a dead end with no extension running.
    cliModelTracking: status.modelTracking
      ? undefined
      : readCliModelTrackingState(engine.getStorageDir()) ?? { consented: false, port: 0 },
    profileOptions: COMPRESSION_PROFILES,
    enabled: config.enabled,
    config,
    traffic: buildTrafficPayload(engine, lifetimeEvents, status),
    summary: engine.summary(),
    tokenFlow: buildTokenFlow(events),
    workspaceAttribution: buildWorkspaceAttribution(events),
    outcomeBreakdown: buildOutcomeBreakdown(events),
    reuseHealth: buildReuseHealth(engine, events, retrievalAudit),
    timingBreakdown: buildTimingBreakdown(events),
    strategyBreakdown: buildStrategyBreakdown(events),
    retrievalAudit,
    timeline: buildTimeline(events),
    outputGroups: buildOutputGroups(events, engine.getSessionId()),
    lifetime: buildLifetime(engine, lifetimeEvents),
    history: buildHistory(lifetimeEvents),
    wasteSignals: buildWasteSignals(lifetimeEvents),
    costAttribution: buildCostAttribution(lifetimeEvents, config.usdPerMillionTokens),
    comparison: buildComparison(engine, lifetimeEvents),
    events,
  };
}

/** Events the session-scoped panels are computed from. */
const RECENT_WINDOW = 40;

/** How long a producer keeps counting as active after its last event. */
const ACTIVE_PRODUCER_WINDOW_MS = 15 * 60_000;

/** Observed model calls listed in the Models tab, newest first. */
const MODEL_OBSERVATION_WINDOW = 25;

function buildLifetime(
  engine: CompressionEngine,
  entries: readonly LedgerEntry[],
): DashboardLifetimePayload {
  const summary = engine.summary();
  const timestamps = entries.map((entry) => entry.ts).filter((ts) => Number.isFinite(ts));
  return {
    events: entries.length,
    chatsObserved: entries.filter((entry) => entry.strategy === 'session:chat').length,
    observedToolCalls: entries.filter((entry) => entry.strategy === 'session:tool-observed').length,
    compressions: summary.compressions,
    retrievals: summary.retrievals,
    tokensBefore: summary.tokensBefore,
    tokensAfter: summary.tokensAfter,
    tokensSaved: summary.tokensSaved,
    percentSaved: summary.percentSaved,
    estimatedCostSavedUsd: summary.estimatedCostSavedUsd,
    firstEventAt: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
    lastEventAt: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
    recentWindow: RECENT_WINDOW,
  };
}

/**
 * Daily savings, newest first. Session events carry no tokens, so they are
 * skipped. Saved is the net of In minus Out (not floored per row), so the three
 * columns reconcile exactly: a day that spends more tokens retrieving omitted
 * content than it saved shows a smaller -- or negative -- net, which is honest.
 */
function buildHistory(entries: readonly LedgerEntry[]): DashboardHistoryBucket[] {
  const buckets = new Map<string, DashboardHistoryBucket>();
  for (const entry of entries) {
    if (entry.tool === 'session') continue;
    const date = toLocalDate(entry.ts);
    const bucket = buckets.get(date) ?? {
      date,
      calls: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
      percentSaved: 0,
    };
    bucket.calls++;
    bucket.tokensBefore += entry.tokensBefore;
    bucket.tokensAfter += entry.tokensAfter;
    bucket.tokensSaved += entry.tokensBefore - entry.tokensAfter;
    bucket.percentSaved = bucket.tokensBefore > 0 ? (bucket.tokensSaved / bucket.tokensBefore) * 100 : 0;
    buckets.set(date, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Split estimated savings into readable buckets, then subtract what retrieval
 * cost to put back. Buckets follow the strategy that produced each call.
 */
function buildCostAttribution(
  retainedEntries: readonly LedgerEntry[],
  usdPerMillionTokens: number,
): DashboardCostAttributionPayload {
  const entries = attributeSavingsPricing(retainedEntries);
  const order = ['Log compression', 'Read lifecycle', 'Passthrough guard', 'Other'];
  const buckets = new Map<string, DashboardCostBucket>();
  const bucketEntries = new Map<string, LedgerEntry[]>();
  let retrievalTokens = 0;
  let dedupCalls = 0;

  for (const entry of entries) {
    if (entry.tool === 'session') continue;

    if (entry.tool === 'retrieve_artifact') {
      retrievalTokens += entry.tokensAfter;
      continue;
    }

    if ((entry.markers ?? []).some((marker) => entry.artifactId && marker.artifactId !== entry.artifactId)) {
      dedupCalls++;
    }

    const label = strategyFamily(entry);
    const bucket = buckets.get(label) ?? { id: label, label, calls: 0, tokens: 0, usd: 0 };
    bucket.calls++;
    bucket.tokens += Math.max(0, entry.tokensBefore - entry.tokensAfter);
    const group = bucketEntries.get(label) ?? [];
    group.push(entry);
    bucketEntries.set(label, group);
    buckets.set(label, bucket);
  }

  for (const [label, bucket] of buckets) bucket.usd = aggregateCost(bucketEntries.get(label) ?? [], 'gross', usdPerMillionTokens).usd;

  const ordered = [...buckets.values()].sort((a, b) => {
    const rank = order.indexOf(a.label) - order.indexOf(b.label);
    return rank !== 0 ? rank : b.tokens - a.tokens;
  });

  const grossTokensSaved = ordered.reduce((total, bucket) => total + bucket.tokens, 0);
  const netTokensSaved = Math.max(0, grossTokensSaved - retrievalTokens);
  const modelEntries = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    if (entry.tool === 'session') continue;
    const snapshot = entry.pricing;
    const label = snapshot ? [snapshot.basis, snapshot.source, snapshot.providerId, snapshot.modelId].filter(Boolean).join(' / ') : 'Legacy / unpriced';
    const group = modelEntries.get(label) ?? [];
    group.push(entry);
    modelEntries.set(label, group);
  }

  return {
    buckets: ordered,
    grossTokensSaved,
    grossUsd: aggregateCost(entries, 'gross', usdPerMillionTokens).usd,
    retrievalTokens,
    retrievalUsd: aggregateCost(entries, 'retrieval', usdPerMillionTokens).usd,
    netTokensSaved,
    netUsd: aggregateCost(entries, 'net', usdPerMillionTokens).usd,
    cost: aggregateCost(entries, 'net', usdPerMillionTokens),
    models: [...modelEntries].map(([label, group]) => ({ label, cost: aggregateCost(group, 'net', usdPerMillionTokens) })),
    dedupCalls,
    usdPerMillionTokens,
  };
}

/** The aggregate a comparison is taken against, and how the current run differs. */
export function buildCurrentBaseline(
  engine: CompressionEngine,
  entries: readonly LedgerEntry[],
  label = 'Current run',
): SavingsBaseline {
  const summary = engine.summary();
  let totalOverheadMs = 0;
  for (const entry of entries) {
    if (entry.tool === 'session') continue;
    totalOverheadMs += Math.max(0, entry.durationMs ?? 0);
  }
  return {
    savedAt: Date.now(),
    label,
    events: entries.filter((entry) => entry.tool !== 'session').length,
    tokensBefore: summary.tokensBefore,
    tokensAfter: summary.tokensAfter,
    tokensSaved: summary.tokensSaved,
    percentSaved: summary.percentSaved,
    retrievalRate: summary.retrievalRate,
    totalOverheadMs,
  };
}

function buildComparison(
  engine: CompressionEngine,
  entries: readonly LedgerEntry[],
): DashboardComparisonPayload {
  const current = buildCurrentBaseline(engine, entries);
  const baseline = engine.baseline.load();
  if (!baseline) {
    return { current, benchmark: { ...BENCHMARK_REFERENCE }, deltas: [] };
  }

  const delta = (
    metric: string,
    currentValue: number,
    baselineValue: number,
    unit: DashboardComparisonDelta['unit'],
  ): DashboardComparisonDelta => ({
    metric,
    current: currentValue,
    baseline: baselineValue,
    change: currentValue - baselineValue,
    // A zero baseline has no meaningful percent change; say nothing rather
    // than reporting an infinite improvement.
    percentChange:
      baselineValue === 0 ? undefined : ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100,
    unit,
  });

  return {
    current,
    baseline,
    benchmark: { ...BENCHMARK_REFERENCE },
    deltas: [
      delta('Tokens saved', current.tokensSaved, baseline.tokensSaved, 'tokens'),
      delta('Percent saved', current.percentSaved, baseline.percentSaved, 'percent'),
      delta('Retrieval rate', current.retrievalRate, baseline.retrievalRate, 'percent'),
      delta('Compression overhead', current.totalOverheadMs, baseline.totalOverheadMs, 'ms'),
    ],
  };
}

function toLocalDate(ts: number): string {
  const date = new Date(ts);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Name the waste in terms of what happened to the developer's output, rather
 * than the internal strategy that produced it.
 */
function buildWasteSignals(entries: readonly LedgerEntry[]): DashboardWasteSignal[] {
  const signals: DashboardWasteSignal[] = [
    {
      id: 'log',
      label: 'Build and test noise collapsed',
      calls: 0,
      tokensSaved: 0,
      detail: 'Errors, stack traces and summaries kept; routine progress output omitted.',
    },
    {
      id: 'repeat-read',
      label: 'Repeated file read avoided',
      calls: 0,
      tokensSaved: 0,
      detail: 'The file was unchanged since the last read, so a marker was sent instead.',
    },
    {
      id: 'diff-read',
      label: 'Changed file sent as a diff',
      calls: 0,
      tokensSaved: 0,
      detail: 'Only the changed hunks were sent instead of the whole file again.',
    },
    {
      id: 'capped-read',
      label: 'Oversized first read capped',
      calls: 0,
      tokensSaved: 0,
      detail: 'The file exceeded the read budget; the remainder stays retrievable.',
    },
    {
      id: 'dedup',
      label: 'Duplicate content pointed at earlier output',
      calls: 0,
      tokensSaved: 0,
      detail: 'Text already returned this session was replaced with a pointer to it.',
    },
    {
      id: 'not-worth-it',
      label: 'Returned raw because compression would not pay',
      calls: 0,
      tokensSaved: 0,
      detail: 'Marker overhead would have exceeded the saving, so the original was sent.',
    },
  ];
  const byId = new Map(signals.map((signal) => [signal.id, signal]));

  const add = (id: string, entry: LedgerEntry): void => {
    const signal = byId.get(id);
    if (!signal) return;
    signal.calls++;
    signal.tokensSaved += Math.max(0, entry.tokensBefore - entry.tokensAfter);
  };

  for (const entry of entries) {
    if (entry.tool === 'session') continue;

    // A marker pointing at a different artifact is a cross-turn dedup pointer
    // rather than an omission from this output.
    const dedupMarkers = (entry.markers ?? []).filter(
      (marker) => entry.artifactId && marker.artifactId !== entry.artifactId,
    );
    if (dedupMarkers.length > 0) {
      add('dedup', entry);
    }

    if (entry.strategy === 'passthrough:not-worth-it') add('not-worth-it', entry);
    else if (entry.strategy.startsWith('log:')) add('log', entry);
    else if (entry.strategy === 'read-lifecycle:unchanged') add('repeat-read', entry);
    else if (entry.strategy === 'read-lifecycle:diff') add('diff-read', entry);
    else if (entry.strategy === 'read-lifecycle:fresh' && (entry.markers ?? []).length > 0) {
      add('capped-read', entry);
    }
  }

  return signals.filter((signal) => signal.calls > 0).sort((a, b) => b.tokensSaved - a.tokensSaved);
}

/** Conversation identifiers stay out of the payload; only scope is exposed. */
function buildModelObservations(entries: readonly LedgerEntry[]): DashboardModelObservationItem[] {
  const items: DashboardModelObservationItem[] = [];
  for (let index = entries.length - 1; index >= 0 && items.length < MODEL_OBSERVATION_WINDOW; index--) {
    const entry = entries[index]!;
    const observation = entry.modelObservation;
    if (!observation) continue;
    const detected = entry.detectedModel ?? entry.pricing?.detectedModel;
    items.push({
      ts: entry.ts,
      model: detected?.name ?? observation.responseModel ?? observation.requestModel,
      vendor: detected?.vendor ?? observation.provider,
      source: entry.sessionLabel === MODEL_OBSERVATION_SOURCE_LABELS.cli ? 'cli' : 'vscode',
      scope: observation.conversationId || observation.chatSessionId ? 'chat' : 'background',
      nested: !!observation.parentSpanId,
      durationMs: Math.max(0, observation.endedAt - observation.startedAt),
      inputTokens: observation.inputTokens ?? null,
      outputTokens: observation.outputTokens ?? null,
      cacheReadInputTokens: observation.cacheReadInputTokens ?? null,
      cacheCreationInputTokens: observation.cacheCreationInputTokens ?? null,
      inputUsdPerMillion: entry.pricing?.inputUsdPerMillion ?? null,
      inputCost: priceReportedInput(entry.pricing, observation),
    });
  }
  return items;
}

function buildContextGrowth(entries: readonly LedgerEntry[]): DashboardContextGrowth {
  const result: DashboardContextGrowth = {
    startAt: null, endAt: null, windowMinutes: 60, bucketMinutes: 5,
    observationCount: 0, observationLimit: 200, observations: [], savings: [],
  };
  let latest: number | null = null;
  const activityTime = (entry: LedgerEntry) => entry.modelObservation?.endedAt
    ?? (entry.tool !== 'session' && !entry.strategy.startsWith('session:') ? entry.ts : undefined);
  for (const entry of entries) {
    const timestamp = activityTime(entry);
    if (timestamp !== undefined && Number.isFinite(timestamp) && timestamp >= 0) latest = Math.max(latest ?? timestamp, timestamp);
  }
  if (latest === null) return result;
  const interval = result.bucketMinutes * 60_000;
  const endAt = (Math.floor(latest / interval) + 1) * interval;
  const startAt = endAt - result.windowMinutes * 60_000;
  result.startAt = startAt;
  result.endAt = endAt;
  result.savings = Array.from({ length: result.windowMinutes / result.bucketMinutes }, (_, index) => ({
    startAt: startAt + index * interval, endAt: startAt + (index + 1) * interval,
    toolOutputs: 0, tokensSaved: 0, retrievalTokens: 0, netTokensSaved: 0,
  }));
  const reportedTokens = (value: number | undefined): number | null =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
  for (const entry of entries) {
    const timestamp = activityTime(entry);
    if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp < startAt || timestamp >= endAt) continue;
    const observation = entry.modelObservation;
    if (observation) {
      const inputTokens = reportedTokens(observation.inputTokens);
      const cacheReadInputTokens = reportedTokens(observation.cacheReadInputTokens);
      result.observations.push({
        ts: timestamp, model: observation.responseModel ?? observation.requestModel,
        vendor: observation.provider === 'github' ? 'copilot' : observation.provider,
        scope: observation.conversationId || observation.chatSessionId ? 'chat' : 'background',
        inputTokens, cacheReadInputTokens,
        cacheSharePercent: inputTokens !== null && inputTokens > 0 && cacheReadInputTokens !== null && cacheReadInputTokens <= inputTokens
          ? cacheReadInputTokens / inputTokens * 100 : null,
      });
    } else {
      const before = reportedTokens(entry.tokensBefore);
      const after = reportedTokens(entry.tokensAfter);
      if (before === null || after === null) continue;
      const bucket = result.savings[Math.floor((timestamp - startAt) / interval)]!;
      bucket.toolOutputs++;
      if (entry.tool === 'retrieve_artifact') bucket.retrievalTokens += after;
      else bucket.tokensSaved += before - after;
      bucket.netTokensSaved = bucket.tokensSaved - bucket.retrievalTokens;
    }
  }
  result.observationCount = result.observations.length;
  result.observations.sort((left, right) => left.ts - right.ts || left.vendor.localeCompare(right.vendor) || left.model.localeCompare(right.model));
  result.observations = result.observations.slice(-result.observationLimit);
  return result;
}

function buildModelUsage(engine: CompressionEngine, entries: readonly LedgerEntry[]): DashboardModelUsageItem[] {
  const groups = new Map<string, DashboardModelUsageItem>();
  const fields = [
    ['inputTokens', 'inputReportedCalls'],
    ['outputTokens', 'outputReportedCalls'],
    ['cacheReadInputTokens', 'cacheReadReportedCalls'],
  ] as const;
  for (const entry of entries) {
    const observation = entry.modelObservation;
    if (!observation) continue;
    const model = observation.responseModel ?? observation.requestModel;
    const vendor = observation.provider === 'github' ? 'copilot' : observation.provider;
    const key = JSON.stringify([vendor, model]);
    let group = groups.get(key);
    if (!group) {
      const pricing = engine.pricing.snapshot({ mode: 'automatic' }, 0, { id: model, vendor, name: model });
      group = {
        model, vendor, calls: 0,
        inputTokens: null, outputTokens: null, cacheReadInputTokens: null,
        inputReportedCalls: 0, outputReportedCalls: 0, cacheReadReportedCalls: 0,
        firstSeenAt: observation.endedAt, lastSeenAt: observation.endedAt,
        inputUsdPerMillion: pricing.inputUsdPerMillion,
        inputRateReason: pricing.reason ?? null,
      };
      groups.set(key, group);
    }
    group.calls++;
    group.firstSeenAt = Math.min(group.firstSeenAt, observation.endedAt);
    group.lastSeenAt = Math.max(group.lastSeenAt, observation.endedAt);
    for (const [tokens, reported] of fields) {
      const count = observation[tokens];
      if (count === undefined || !Number.isSafeInteger(count) || count < 0) continue;
      group[tokens] = (group[tokens] ?? 0) + count;
      group[reported]++;
    }
  }
  return [...groups.values()].sort((left, right) => right.calls - left.calls
    || right.lastSeenAt - left.lastSeenAt || left.vendor.localeCompare(right.vendor) || left.model.localeCompare(right.model));
}

function buildTrafficPayload(
  engine: CompressionEngine,
  entries: readonly LedgerEntry[],
  status: DashboardServerStatus,
  now = Date.now(),
): DashboardTrafficPayload {
  const activeSince = now - ACTIVE_PRODUCER_WINDOW_MS;
  const active = new Set(entries
    .filter((entry) => entry.ts >= activeSince)
    .map((entry) => entry.sessionId ?? 'legacy'));
  return {
    viewerConnections: Math.max(0, status.viewerConnections),
    producerSessions: active.size,
    activeWindowMinutes: ACTIVE_PRODUCER_WINDOW_MS / 60_000,
    totalOutputs: entries.filter((entry) => entry.tool !== 'session').length,
    currentSessionId: engine.getSessionId(),
    currentSessionLabel: engine.getSessionLabel(),
  };
}

function buildConfigPayload(engine: CompressionEngine): DashboardConfigPayload {
  const config = engine.getConfig();
  const retention = engine.store.retentionPolicy();
  return {
    profile: config.profile,
    pricing: config.pricing,
    enabled: config.enabled,
    compressLogs: config.compressLogs,
    readLifecycle: config.readLifecycle,
    crossTurnDedup: config.crossTurnDedup,
    maxFileLines: config.maxFileLines,
    usdPerMillionTokens: config.usdPerMillionTokens,
    artifactIdleTtlMinutes: Math.round(retention.idleTtlMs / 60_000),
    artifactMaxEntries: retention.maxEntries,
    artifactMaxTotalMiB: Math.round(retention.maxTotalBytes / 1024 / 1024),
  };
}

export function renderDashboardReportMarkdown(
  engine: CompressionEngine,
  generatedAt = new Date(),
  status: DashboardServerStatus = { viewerConnections: 0 },
): string {
  return formatDashboardReportMarkdown(buildSummaryPayload(engine, status), generatedAt.toISOString());
}

export function renderDashboardReportJson(
  engine: CompressionEngine,
  generatedAt = new Date(),
  status: DashboardServerStatus = { viewerConnections: 0 },
): string {
  const timestamp = generatedAt.toISOString();
  return formatDashboardReportJson(buildSummaryPayload(engine, status), timestamp);
}

export function renderDashboardReportCsv(
  engine: CompressionEngine,
  generatedAt = new Date(),
  status: DashboardServerStatus = { viewerConnections: 0 },
): string {
  return formatDashboardReportCsv(buildSummaryPayload(engine, status), generatedAt.toISOString());
}

function buildTokenFlow(events: readonly LedgerEntry[]): DashboardTokenFlowPayload {
  let rawTokens = 0;
  let returnedTokens = 0;
  let retrievedTokens = 0;

  for (const entry of events) {
    if (entry.tool === 'session') {
      continue;
    }
    if (entry.tool === 'retrieve_artifact') {
      retrievedTokens += entry.tokensAfter;
      continue;
    }
    rawTokens += entry.tokensBefore;
    returnedTokens += entry.tokensAfter;
  }

  const omittedTokens = Math.max(0, rawTokens - returnedTokens);
  return {
    rawTokens,
    returnedTokens,
    omittedTokens,
    retrievedTokens,
    netSavedTokens: Math.max(0, omittedTokens - retrievedTokens),
  };
}

function buildWorkspaceAttribution(events: readonly LedgerEntry[]): DashboardWorkspaceAttributionItem[] {
  const buckets = new Map<string, DashboardWorkspaceAttributionItem>();
  for (const entry of events) {
    if (entry.tool === 'session') continue;
    const id = entry.workspaceRoot ?? 'unknown';
    const bucket = buckets.get(id) ?? {
      id,
      label: entry.workspaceLabel ?? 'Unknown workspace',
      root: entry.workspaceRoot,
      calls: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
      percentSaved: 0,
      lastActivity: '',
    };
    bucket.calls++;
    bucket.tokensBefore += entry.tokensBefore;
    bucket.tokensAfter += entry.tokensAfter;
    bucket.tokensSaved += Math.max(0, entry.tokensBefore - entry.tokensAfter);
    bucket.percentSaved = bucket.tokensBefore > 0 ? (bucket.tokensSaved / bucket.tokensBefore) * 100 : 0;
    bucket.lastActivity = new Date(Math.max(Date.parse(bucket.lastActivity) || 0, entry.ts)).toISOString();
    buckets.set(id, bucket);
  }

  return [...buckets.values()].sort((a, b) => {
    if (b.tokensSaved !== a.tokensSaved) return b.tokensSaved - a.tokensSaved;
    if (b.calls !== a.calls) return b.calls - a.calls;
    return a.label.localeCompare(b.label);
  });
}

function buildOutcomeBreakdown(events: readonly LedgerEntry[]): DashboardOutcomeBreakdownItem[] {
  const order = [
    'Compressed',
    'Too small',
    'No compressible content found',
    'Not worth it after marker overhead',
    'Passthrough/raw output',
    'Strategy disabled',
    'Retrieved omitted content',
    'Session event',
  ];
  const rank = (reason: string): number => {
    const index = order.indexOf(reason);
    return index === -1 ? order.length : index;
  };
  const buckets = new Map<string, DashboardOutcomeBreakdownItem>();

  for (const entry of events) {
    const reason = outcomeReason(entry);
    const bucket = buckets.get(reason) ?? {
      reason,
      calls: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
    };
    bucket.calls++;
    bucket.tokensBefore += entry.tokensBefore;
    bucket.tokensAfter += entry.tokensAfter;
    bucket.tokensSaved += entry.tokensBefore - entry.tokensAfter;
    buckets.set(reason, bucket);
  }

  return [...buckets.values()].sort((a, b) => {
    const byOrder = rank(a.reason) - rank(b.reason);
    return byOrder !== 0 ? byOrder : b.tokensSaved - a.tokensSaved;
  });
}

/**
 * Prefer the reason the engine recorded at decision time. Entries written
 * before outcome accounting existed still need a best-effort guess.
 */
function outcomeReason(entry: LedgerEntry): string {
  if (entry.outcomeReason) return entry.outcomeReason;
  if (entry.tool === 'session') return 'Session event';
  if (entry.tool === 'retrieve_artifact') return 'Retrieved omitted content';
  if (entry.strategy === 'passthrough:not-worth-it') return 'Not worth it after marker overhead';
  if (entry.strategy.startsWith('passthrough')) return 'Passthrough/raw output';
  if (entry.tokensBefore > entry.tokensAfter) return 'Compressed';
  return 'Passthrough/raw output';
}

function buildReuseHealth(
  engine: CompressionEngine,
  events: readonly LedgerEntry[],
  audit: DashboardRetrievalAuditPayload,
): DashboardReuseHealthPayload {
  let dedupMarkers = 0;
  const size = engine.store.size();
  const retention = engine.store.retentionPolicy();
  for (const entry of events) {
    if (entry.tool === 'session' || entry.tool === 'retrieve_artifact') {
      continue;
    }
    const after = engine.inspect(entry).after;
    if (after === undefined) {
      continue;
    }
    dedupMarkers += parseMarkers(after).filter((marker) => marker.raw.includes('identical line')).length;
  }

  return {
    markersEmitted: audit.totalMarkers,
    markersRetrieved: audit.retrievedMarkers,
    retrievalRate: audit.totalMarkers > 0 ? (audit.retrievedMarkers / audit.totalMarkers) * 100 : 0,
    omittedLines: audit.omittedLines,
    retrievedLines: audit.retrievedLines,
    dedupMarkers,
    unchangedReadHits: events.filter((entry) => entry.strategy === 'read-lifecycle:unchanged').length,
    diffReadHits: events.filter((entry) => entry.strategy === 'read-lifecycle:diff').length,
    artifactEntries: size.entries,
    artifactBytes: size.bytes,
    artifactMaxEntries: retention.maxEntries,
    artifactMaxBytes: retention.maxTotalBytes,
    artifactEntryPercent: retention.maxEntries > 0 ? (size.entries / retention.maxEntries) * 100 : 0,
    artifactBytePercent: retention.maxTotalBytes > 0 ? (size.bytes / retention.maxTotalBytes) * 100 : 0,
  };
}

function buildTimingBreakdown(events: readonly LedgerEntry[]): DashboardTimingBreakdownItem[] {
  const order = [
    'Log compression',
    'Read lifecycle',
    'Cross-turn dedup',
    'Passthrough guard',
    'Retrieval',
    'Other',
    'Artifact store',
  ];
  // Percentiles need every sample, so collect durations per bucket first.
  const samples = new Map<string, { strategies: string[]; durations: number[] }>();

  const addSample = (name: string, durationMs: number, strategy?: string): void => {
    const bucket = samples.get(name) ?? { strategies: [], durations: [] };
    bucket.durations.push(Math.max(0, durationMs));
    if (strategy && !bucket.strategies.includes(strategy)) {
      bucket.strategies.push(strategy);
    }
    samples.set(name, bucket);
  };

  for (const entry of events) {
    if (entry.tool === 'session') {
      continue;
    }
    if (Number.isFinite(entry.durationMs)) {
      addSample(strategyFamily(entry), entry.durationMs ?? 0, entry.strategy);
    }
    // Store time is a component of the call above, so it gets its own row
    // rather than being double counted inside a strategy family.
    if (Number.isFinite(entry.artifactMs)) {
      addSample('Artifact store', entry.artifactMs ?? 0);
    }
  }

  const items: DashboardTimingBreakdownItem[] = [];
  for (const [name, bucket] of samples) {
    const durations = [...bucket.durations].sort((a, b) => a - b);
    const totalMs = durations.reduce((total, value) => total + value, 0);
    items.push({
      name,
      calls: durations.length,
      totalMs,
      avgMs: durations.length > 0 ? totalMs / durations.length : 0,
      minMs: durations[0] ?? 0,
      maxMs: durations[durations.length - 1] ?? 0,
      p95Ms: percentile(durations, 95),
      strategies: bucket.strategies,
    });
  }

  return items.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

/** Nearest-rank percentile over an ascending list. */
function percentile(ascending: readonly number[], percent: number): number {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil((percent / 100) * ascending.length);
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1));
  return ascending[index] ?? 0;
}

function buildOutputGroups(events: readonly DashboardEvent[], currentSessionId: string): DashboardOutputGroup[] {
  const groups: DashboardOutputGroup[] = [
    {
      id: 'global',
      label: 'Global outputs',
      calls: events.length,
      tokensSaved: sumTokensSaved(events),
      events: [...events],
    },
  ];
  const bySession = new Map<string, LedgerEntry[]>();
  for (const entry of events) {
    const sessionId = entry.sessionId ?? 'legacy';
    const bucket = bySession.get(sessionId) ?? [];
    bucket.push(entry);
    bySession.set(sessionId, bucket);
  }

  for (const [sessionId, sessionEvents] of [...bySession.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const current = sessionId === currentSessionId;
    const producerLabel = sessionEvents.find((entry) => entry.sessionLabel)?.sessionLabel;
    groups.push({
      id: sessionId,
      label: sessionId === 'legacy' ? 'Legacy session' : current ? 'This session' : producerLabel ?? sessionLabel(sessionId),
      calls: sessionEvents.length,
      tokensSaved: sumTokensSaved(sessionEvents),
      events: sessionEvents,
    });
  }
  return groups;
}

function sessionLabel(sessionId: string): string {
  return `Session ${sessionId.slice(-6)}`;
}

function sumTokensSaved(events: readonly LedgerEntry[]): number {
  return events.reduce((total, entry) => total + Math.max(0, entry.tokensBefore - entry.tokensAfter), 0);
}

function buildRetrievalAudit(
  engine: CompressionEngine,
  events: readonly LedgerEntry[],
): DashboardRetrievalAuditPayload {
  const retrievals = new Map<string, OmittedRange[]>();
  const evicted = new Set<string>();
  let retrievedById = 0;
  let retrievedByGrep = 0;

  for (const entry of events) {
    for (const id of entry.evictedArtifactIds ?? []) {
      evicted.add(id);
    }
    if (entry.tool !== 'retrieve_artifact' || !entry.artifactId) {
      continue;
    }
    if (entry.retrievalMode === 'grep') retrievedByGrep++;
    else if (entry.retrievalMode === 'id') retrievedById++;
    // A grep retrieval is not addressed by line range, so counting it as an
    // overlap would overstate which specific lines the model actually saw.
    if (entry.retrievalMode === 'grep') {
      continue;
    }
    const existing = retrievals.get(entry.artifactId) ?? [];
    existing.push({
      startLine: entry.retrievalStartLine ?? 1,
      endLine: entry.retrievalEndLine ?? Number.MAX_SAFE_INTEGER,
    });
    retrievals.set(entry.artifactId, existing);
  }

  for (const [id, ranges] of retrievals) {
    retrievals.set(id, mergeRanges(ranges));
  }

  const items: DashboardRetrievalAuditItem[] = [];
  let expiredMarkers = 0;
  for (const entry of events) {
    if (entry.tool === 'session' || entry.tool === 'retrieve_artifact') {
      continue;
    }
    // Prefer the markers recorded when the payload was sent. Re-reading the
    // stored artifact is only a fallback for entries written before lifecycle
    // accounting, and it silently loses markers once an artifact is evicted.
    const markers =
      entry.markers ??
      parseMarkers(engine.inspect(entry).after ?? '').map((marker) => ({
        artifactId: marker.id,
        startLine: marker.startLine,
        endLine: marker.endLine,
      }));
    if (markers.length === 0) {
      continue;
    }

    let omittedLines = 0;
    let retrievedLines = 0;
    let retrievedMarkers = 0;
    for (const marker of markers) {
      const markerLines = Math.max(0, marker.endLine - marker.startLine + 1);
      const markerRetrievedLines = countOverlap(
        { startLine: marker.startLine, endLine: marker.endLine },
        retrievals.get(marker.artifactId) ?? [],
      );
      omittedLines += markerLines;
      retrievedLines += markerRetrievedLines;
      if (markerRetrievedLines > 0) {
        retrievedMarkers++;
      } else if (evicted.has(marker.artifactId)) {
        expiredMarkers++;
      }
    }

    items.push({
      ts: entry.ts,
      label: entry.label,
      strategy: entry.strategy,
      markerCount: markers.length,
      retrievedMarkers,
      unretrievedMarkers: markers.length - retrievedMarkers,
      omittedLines,
      retrievedLines,
      tokensSaved: entry.tokensBefore - entry.tokensAfter,
    });
  }

  const totalMarkers = items.reduce((total, item) => total + item.markerCount, 0);
  const retrievedMarkers = items.reduce((total, item) => total + item.retrievedMarkers, 0);
  const unretrievedMarkers = items.reduce((total, item) => total + item.unretrievedMarkers, 0);

  return {
    totalMarkers,
    retrievedMarkers,
    unretrievedMarkers,
    percentUnretrieved: totalMarkers > 0 ? (unretrievedMarkers / totalMarkers) * 100 : 0,
    omittedLines: items.reduce((total, item) => total + item.omittedLines, 0),
    retrievedLines: items.reduce((total, item) => total + item.retrievedLines, 0),
    lifecycle: {
      shownToModel: totalMarkers,
      retrievedById,
      retrievedByGrep,
      expired: expiredMarkers,
      stillRetrievable: Math.max(0, unretrievedMarkers - expiredMarkers),
    },
    items,
  };
}

function mergeRanges(ranges: readonly OmittedRange[]): OmittedRange[] {
  const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
  const merged: OmittedRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.startLine > previous.endLine + 1) {
      merged.push({ ...range });
    } else {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    }
  }
  return merged;
}

function countOverlap(marker: OmittedRange, retrievals: readonly OmittedRange[]): number {
  let total = 0;
  for (const retrieval of retrievals) {
    const start = Math.max(marker.startLine, retrieval.startLine);
    const end = Math.min(marker.endLine, retrieval.endLine);
    if (end >= start) {
      total += end - start + 1;
    }
  }
  return total;
}

function buildStrategyBreakdown(events: readonly LedgerEntry[]): DashboardStrategyBreakdownItem[] {
  const order = ['Log compression', 'Read lifecycle', 'Cross-turn dedup', 'Passthrough guard', 'Retrieval', 'Other'];
  const buckets = new Map<string, DashboardStrategyBreakdownItem>();

  for (const entry of events) {
    if (entry.tool === 'session') {
      continue;
    }
    const name = strategyFamily(entry);
    const bucket = buckets.get(name) ?? {
      name,
      calls: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      tokensSaved: 0,
      percentSaved: 0,
      strategies: [],
    };
    bucket.calls++;
    bucket.tokensBefore += entry.tokensBefore;
    bucket.tokensAfter += entry.tokensAfter;
    bucket.tokensSaved += entry.tokensBefore - entry.tokensAfter;
    if (!bucket.strategies.includes(entry.strategy)) {
      bucket.strategies.push(entry.strategy);
    }
    buckets.set(name, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      percentSaved: bucket.tokensBefore > 0 ? (bucket.tokensSaved / bucket.tokensBefore) * 100 : 0,
    }))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

function strategyFamily(entry: LedgerEntry): string {
  if (entry.tool === 'retrieve_artifact') return 'Retrieval';
  if (entry.strategy.startsWith('log:')) return 'Log compression';
  if (entry.strategy.startsWith('read-lifecycle:')) return 'Read lifecycle';
  if (entry.strategy.startsWith('dedup:')) return 'Cross-turn dedup';
  if (entry.strategy.startsWith('passthrough')) return 'Passthrough guard';
  return 'Other';
}

function buildTimeline(events: readonly DashboardEvent[]): DashboardTimelineItem[] {
  return [...events]
    .sort((a, b) => a.ts - b.ts)
    .map((entry) => {
      const tokensSaved = entry.tokensBefore - entry.tokensAfter;
      const detail =
        entry.strategy === 'session:chat'
          ? 'Prompt submitted. Content not recorded.'
          : entry.strategy === 'session:tool-observed'
            ? 'Observed only. No compression or savings attributed.'
          : entry.tool === 'retrieve_artifact'
          ? `Expanded ${entry.linesAfter.toLocaleString()} line(s) from stored content.`
          : entry.strategy === 'session:reset'
            ? 'Forgot read lifecycle and cross-turn dedup state. Stored artifacts stayed available.'
            : entry.strategy === 'session:purge'
              ? 'Deleted stored artifacts and reset session memory.'
              : tokensSaved > 0
                ? `${tokensSaved.toLocaleString()} tokens removed before the model saw this output.`
                : 'Forwarded unchanged because compression would not help.';

      return {
        ts: entry.ts,
        eventId: entry.eventId,
        time: new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        kind: timelineKind(entry),
        title: timelineTitle(entry),
        detail,
        tool: entry.tool,
        strategy: entry.strategy,
        tokensSaved,
        durationMs: entry.durationMs,
        inspectable: entry.tool !== 'session',
      };
    });
}

function timelineKind(entry: LedgerEntry): string {
  if (entry.tool === 'retrieve_artifact') return 'Retrieved';
  if (entry.strategy === 'session:chat') return 'Chat';
  if (entry.strategy === 'session:tool-observed') return 'Observed';
  if (entry.strategy === 'session:reset') return 'Reset';
  if (entry.strategy === 'session:purge') return 'Purged';
  if (entry.tool === 'read_file') return 'Read';
  if (entry.strategy.startsWith('passthrough')) return 'Passed through';
  return 'Compressed';
}

function timelineTitle(entry: LedgerEntry): string {
  if (entry.strategy === 'session:chat') return 'Chat submitted';
  if (entry.strategy === 'session:reset') return 'Session reset';
  if (entry.strategy === 'session:purge') return entry.label;
  if (entry.tool === 'retrieve_artifact') return `Retrieved ${entry.label}`;
  return entry.label;
}

/** `undefined` when no recent ledger entry matches the timestamp and optional event selector. */
export function buildDetailPayload(
  engine: CompressionEngine,
  ts: number,
  eventId?: string,
): DashboardDetailPayload | undefined {
  const entry = recentDashboardEvents(engine.ledger.all(), 200).find(
    (candidate) => candidate.ts === ts && (eventId === undefined || candidate.eventId === eventId),
  );
  if (!entry) return undefined;

  const { before, after } = engine.inspect(entry);
  // Only markers pointing at this entry's own artifact describe omissions from
  // this output; a cross-turn dedup marker refers to a different one.
  const omitted =
    after === undefined
      ? []
      : parseMarkers(after)
          .filter((marker) => marker.id === entry.artifactId)
          .map((marker) => ({ startLine: marker.startLine, endLine: marker.endLine }))
          .sort((a, b) => a.startLine - b.startLine);

  return {
    type: 'detail',
    ts: entry.ts,
    eventId: entry.eventId,
    label: entry.label,
    strategy: entry.strategy,
    tokensBefore: entry.tokensBefore,
    tokensAfter: entry.tokensAfter,
    modelPayload: {
      tokens: entry.tokensAfter,
      lines: entry.linesAfter,
      markerCount: after === undefined ? 0 : parseMarkers(after).length,
    },
    diffSummary: {
      keptLines: Math.max(0, entry.linesBefore - countOmittedLines(omitted)),
      removedLines: countOmittedLines(omitted),
      tokensSaved: entry.tokensBefore - entry.tokensAfter,
      percentSaved:
        entry.tokensBefore > 0 ? ((entry.tokensBefore - entry.tokensAfter) / entry.tokensBefore) * 100 : 0,
    },
    before,
    after,
    omitted,
  };
}

function countOmittedLines(omitted: readonly OmittedRange[]): number {
  return omitted.reduce((total, range) => total + Math.max(0, range.endLine - range.startLine + 1), 0);
}

export function buildModelPayload(engine: CompressionEngine, ts: number, eventId?: string): string | undefined {
  return buildDetailPayload(engine, ts, eventId)?.after;
}
