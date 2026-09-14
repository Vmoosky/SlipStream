/** Shared domain types for the Slipstream compression engine. */

export type Severity = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type LogFormat =
  | 'jest'
  | 'vitest'
  | 'tsc'
  | 'eslint'
  | 'npm'
  | 'cargo'
  | 'pytest'
  | 'dotnet'
  | 'gradle'
  | 'generic';

export type ContentKind = 'log' | 'diff' | 'json' | 'code' | 'search' | 'tabular' | 'config' | 'text';

/** A contiguous, 1-based inclusive line range of the stored artifact. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * A plan segment produced by a compressor. `kept` segments are rendered
 * verbatim; `omitted` segments become a retrieval marker.
 */
export type Segment =
  | ({ kind: 'kept' } & LineRange)
  | ({ kind: 'omitted'; reason: string } & LineRange);

export interface ArtifactMeta {
  id: string;
  label: string;
  kind: string;
  bytes: number;
  lines: number;
  createdAt: number;
  lastAccessAt: number;
}

/**
 * Why a tool call ended up with the payload it did. Recorded at the point the
 * decision is made, so the dashboard never has to infer intent from a strategy
 * name or a token delta.
 */
export type OutcomeReason =
  | 'Compressed'
  | 'Too small'
  | 'Not worth it after marker overhead'
  | 'Passthrough/raw output'
  | 'Strategy disabled'
  | 'No compressible content found'
  | 'Retrieved omitted content'
  | 'Session event'
  | 'Artifacts evicted';

/** A marker that actually reached the model, recorded when the payload is sent. */
export interface LedgerMarker {
  artifactId: string;
  startLine: number;
  endLine: number;
}

/** How the model asked for omitted content back. */
export type RetrievalMode = 'id' | 'grep';

export interface ModelObservation {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  conversationId?: string;
  chatSessionId?: string;
  provider: string;
  requestModel: string;
  responseModel?: string;
  startedAt: number;
  endedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface LedgerEntry {
  pricing?: import('./pricing.js').PricingSnapshot;
  detectedModel?: import('./pricing.js').DetectedModel;
  modelObservation?: ModelObservation;
  costPolicyAssessment?: import('./costPolicy.js').CostPolicyAssessment;
  taskUsage?: import('./taskUsage.js').TaskUsageEvent;
  nativeChat?: import('./nativeChat.js').NativeChatEvent;
  ts: number;
  /** Local engine/window/session that produced this event. Older entries may not have one. */
  sessionId?: string;
  /** Human-readable producer label, for example a VS Code window or MCP workspace. */
  sessionLabel?: string;
  /** Workspace root that best owns this event. Older entries may not have one. */
  workspaceRoot?: string;
  /** Human-readable workspace label shown in dashboard attribution. */
  workspaceLabel?: string;
  /** Normalized outcome. Older entries may not have one, so readers must fall back. */
  outcomeReason?: OutcomeReason;
  tool: string;
  label: string;
  strategy: string;
  tokensBefore: number;
  tokensAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  linesBefore: number;
  linesAfter: number;
  /** Slipstream processing time for this tool-output event. */
  durationMs?: number;
  /** Time spent inside artifact store reads and writes during this event. */
  artifactMs?: number;
  artifactId?: string;
  /** The text actually returned, stored so the saving can be inspected after the fact. */
  renderedArtifactId?: string;
  /** For retrieve_artifact entries, the inclusive line range requested from the artifact. */
  retrievalStartLine?: number;
  retrievalEndLine?: number;
  /**
   * Markers present in the payload the model received. Absent on entries
   * written before lifecycle accounting, which must fall back to re-parsing.
   */
  markers?: LedgerMarker[];
  /** Whether a retrieval was addressed by line range or by grep. */
  retrievalMode?: RetrievalMode;
  /** Artifact ids dropped by retention, so their markers can be marked expired. */
  evictedArtifactIds?: string[];
}

export interface ToolSavings {
  tool: string;
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
}

export interface SavingsSummary {
  calls: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** 0-100, share of input tokens removed. */
  percentSaved: number;
  estimatedCostSavedUsd: number | null;
  cost: import('./pricing.js').CostTotal;
  byTool: ToolSavings[];
  compressions: number;
  retrievals: number;
  /** 0-100, share of compressions the model later needed to expand. */
  retrievalRate: number;
}

/** Result handed back to a tool front-end (MCP server or VS Code LM tool). */
export interface ToolOutput {
  text: string;
  artifactId: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  linesBefore: number;
  linesAfter: number;
  strategy: string;
  durationMs: number;
}
