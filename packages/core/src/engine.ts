import { createTwoFilesPatch } from 'diff';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { ArtifactStore, type SliceOptions } from './artifactStore.js';
import { BaselineStore } from './baselineStore.js';
import { CrossTurnDedup } from './compressors/crossTurnDedup.js';
import { PersistentDedupIndex } from './compressors/persistentDedupIndex.js';
import { CompressorRegistry } from './compressors/compressorRegistry.js';
import {
  DEFAULT_LOG_CONFIG,
  type LogCompressorConfig,
} from './compressors/logCompressor.js';
import {
  DEFAULT_JSON_CONFIG,
  type JsonCompressorConfig,
} from './compressors/jsonCompressor.js';
import {
  DEFAULT_CODE_CONFIG,
  type CodeCompressorConfig,
} from './compressors/codeCompressor.js';
import {
  DEFAULT_DIFF_CONFIG,
  type DiffCompressorConfig,
} from './compressors/diffCompressor.js';
import {
  DEFAULT_SEARCH_CONFIG,
  type SearchCompressorConfig,
} from './compressors/searchCompressor.js';
import {
  DEFAULT_TABULAR_CONFIG,
  type TabularCompressorConfig,
} from './compressors/tabularCompressor.js';
import {
  DEFAULT_CONFIG_CONFIG,
  type ConfigCompressorConfig,
} from './compressors/configCompressor.js';
import {
  DEFAULT_ANSI_CONFIG,
  stripAnsi,
  type AnsiCompressorConfig,
} from './compressors/ansiCompressor.js';
import {
  DEFAULT_BLOB_CONFIG,
  type BlobCompressorConfig,
} from './compressors/blobCompressor.js';
import {
  DEFAULT_NEARDUP_CONFIG,
  type NearDupCompressorConfig,
} from './compressors/nearDupCompressor.js';
import {
  DEFAULT_PREFIX_CONFIG,
  type PrefixCompressorConfig,
} from './compressors/prefixCompressor.js';
import {
  DEFAULT_TOKEN_BUDGET_CONFIG,
  refineSegmentsByTokens,
  type TokenBudgetConfig,
} from './compressors/tokenBudget.js';
import { detectContentKind } from './contentRouter.js';
import { mergeConfigOverrides, resolveCompressionConfig, type CompressionProfile } from './compressionProfiles.js';
import { isValidArtifactId, parseMarkers, renderDedupMarker, renderMarker, renderNearDedupMarker, sanitizeUntrusted } from './markers.js';
import { ReadLifecycle } from './readLifecycle.js';
import { SavingsLedger } from './savingsLedger.js';
import { PricingService } from './pricingCatalog.js';
import { validatePricing, validRate, type DetectedModel, type PricingConfig } from './pricing.js';
import { assessCostPolicy, validateCostPolicy, type CostPolicy, type CostPolicyAssessment, type CostPolicyContext } from './costPolicy.js';
import { assertReadablePath } from './security/paths.js';
import { countTextTokens } from './tokenizer.js';
import type { LedgerEntry, OutcomeReason, SavingsSummary, Segment, ToolOutput } from './types.js';

export interface EngineConfig {
  profile: CompressionProfile;
  /** Master switch. When false every tool becomes a passthrough. */
  enabled: boolean;
  compressLogs: boolean;
  crossTurnDedup: boolean;
  readLifecycle: boolean;
  /** Fresh file reads longer than this are truncated with a retrievable marker. */
  maxFileLines: number;
  usdPerMillionTokens: number;
  pricing: PricingConfig;
  costPolicy: CostPolicy;
  artifactIdleTtlMinutes: number;
  artifactMaxEntries: number;
  artifactMaxTotalMiB: number;
  log: Partial<LogCompressorConfig>;
  json: Partial<JsonCompressorConfig>;
  code: Partial<CodeCompressorConfig>;
  diff: Partial<DiffCompressorConfig>;
  search: Partial<SearchCompressorConfig>;
  tabular: Partial<TabularCompressorConfig>;
  config: Partial<ConfigCompressorConfig>;
  ansi: Partial<AnsiCompressorConfig>;
  blob: Partial<BlobCompressorConfig>;
  neardup: Partial<NearDupCompressorConfig>;
  prefix: Partial<PrefixCompressorConfig>;
  tokenBudget: Partial<TokenBudgetConfig>;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  profile: 'balanced',
  enabled: true,
  compressLogs: true,
  crossTurnDedup: true,
  readLifecycle: true,
  maxFileLines: 1200,
  usdPerMillionTokens: 3,
  pricing: { mode: 'manual' },
  costPolicy: validateCostPolicy(),
  artifactIdleTtlMinutes: 60,
  artifactMaxEntries: 2000,
  artifactMaxTotalMiB: 256,
  log: DEFAULT_LOG_CONFIG,
  json: DEFAULT_JSON_CONFIG,
  code: DEFAULT_CODE_CONFIG,
  diff: DEFAULT_DIFF_CONFIG,
  search: DEFAULT_SEARCH_CONFIG,
  tabular: DEFAULT_TABULAR_CONFIG,
  config: DEFAULT_CONFIG_CONFIG,
  ansi: DEFAULT_ANSI_CONFIG,
  blob: DEFAULT_BLOB_CONFIG,
  neardup: DEFAULT_NEARDUP_CONFIG,
  prefix: DEFAULT_PREFIX_CONFIG,
  tokenBudget: DEFAULT_TOKEN_BUDGET_CONFIG,
};

/** A diff is only worth sending if it is meaningfully smaller than the file. */
const DIFF_BUDGET_RATIO = 0.9;

/**
 * Compression must remove at least 10% of the tokens to be worth doing. Below
 * that the retrieval markers cost about as much as the lines they replace, and
 * the model pays an extra round trip to see content it could simply have been given.
 */
const MIN_BENEFIT_RATIO = 0.9;

export interface EngineOptions {
  /** Directory for artifacts and the savings ledger. */
  rootDir: string;
  /** Absolute paths the tools are allowed to read from. */
  workspaceRoots: string[];
  /** Stable identifier for this producer session/window. */
  sessionId?: string;
  /** Human-readable producer label shown in dashboard session tabs. */
  sessionLabel?: string;
  config?: Partial<EngineConfig>;
  compressorRegistry?: CompressorRegistry;
  detectedModel?: DetectedModel;
  policyContext?: CostPolicyContext;
}

export interface CommandOutputInput {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface FileReadInput {
  path: string;
  content: string;
}

export interface ToolResultInput {
  toolName: string;
  toolArgs?: unknown;
  cwd?: string;
  text: string;
}

export interface RetrieveInput extends SliceOptions {
  id: string;
}

export interface RetrieveResult {
  text: string;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  label: string;
}

/**
 * Orchestrates compression for every tool front-end.
 *
 * The MCP server and the VS Code extension both drive this class, so their
 * behaviour and their savings numbers stay identical.
 */
export class CompressionEngine {
  readonly store: ArtifactStore;
  readonly ledger: SavingsLedger;
  readonly pricing: PricingService;
  readonly baseline: BaselineStore;
  readonly reads = new ReadLifecycle();
  readonly dedup: CrossTurnDedup;
  private readonly persistentDedup: PersistentDedupIndex;
  private readonly compressorRegistry: CompressorRegistry;

  private config: EngineConfig;
  private configOverrides: Partial<EngineConfig>;
  private workspaceRoots: string[];
  private readonly rootDir: string;
  private readonly sessionId: string;
  private sessionLabel: string;
  private detectedModel?: DetectedModel;
  private readonly policyContext: CostPolicyContext;
  /**
   * Artifact store time for the tool call in flight. Every store operation here
   * is synchronous, so a single accumulator cannot interleave between calls.
   */
  private pendingArtifactMs = 0;
  /**
   * Ids dropped by retention during the call in flight. Flushed as its own
   * event after the current entry, so eviction never lands mid-write.
   */
  private pendingEvictions: string[] = [];

  constructor(options: EngineOptions) {
    this.configOverrides = mergeConfigOverrides({}, options.config ?? {});
    this.config = resolveCompressionConfig(DEFAULT_ENGINE_CONFIG, this.configOverrides);
    this.validatePricingConfig(this.config);
    const policyContext = options.policyContext ?? { host: 'external-tools', scope: 'workspace' };
    assessCostPolicy(this.config.costPolicy, policyContext);
    this.policyContext = structuredClone(policyContext);
    this.detectedModel = options.detectedModel ? { ...options.detectedModel } : undefined;
    this.pricing = new PricingService(options.rootDir);
    this.pricing.start(this.config.pricing.mode !== 'manual');
    this.compressorRegistry = options.compressorRegistry ?? new CompressorRegistry();
    this.workspaceRoots = options.workspaceRoots.map((root) => root);
    this.rootDir = options.rootDir;
    this.sessionId = options.sessionId ?? `session-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    this.sessionLabel = options.sessionLabel ?? `Session ${this.sessionId.slice(-6)}`;
    this.store = new ArtifactStore({
      rootDir: options.rootDir,
      idleTtlMs: this.config.artifactIdleTtlMinutes * 60_000,
      maxEntries: this.config.artifactMaxEntries,
      maxTotalBytes: this.config.artifactMaxTotalMiB * 1024 * 1024,
      onEvict: (ids) => this.pendingEvictions.push(...ids),
    });
    this.ledger = new SavingsLedger({
      rootDir: options.rootDir,
      usdPerMillionTokens: this.config.usdPerMillionTokens,
      pricingSnapshot: () => this.getPricingSnapshot(),
    });
    this.baseline = new BaselineStore(options.rootDir);
    // Cross-session dedup: a durable, shared index rehydrated from the same
    // storage dir every producer writes to. Source lines are lazy-loaded from
    // the artifact store and byte-verified, so an evicted source is skipped and
    // never yields a dangling pointer. TTL tracks artifact retention.
    this.persistentDedup = new PersistentDedupIndex({
      rootDir: options.rootDir,
      config: { idleTtlMs: this.config.artifactIdleTtlMinutes * 60_000 },
    });
    this.dedup = new CrossTurnDedup(
      {},
      {
        persistence: this.persistentDedup,
        loadSource: (id) => {
          const content = this.store.readContent(id);
          return content === undefined ? undefined : content.split('\n');
        },
      },
    );
  }

  updateConfig(patch: Partial<EngineConfig>): void {
    const overrides = mergeConfigOverrides(this.configOverrides, patch);
    const config = resolveCompressionConfig(DEFAULT_ENGINE_CONFIG, overrides);
    this.validatePricingConfig(config);
    const policyChanged = JSON.stringify(this.config.costPolicy) !== JSON.stringify(config.costPolicy);
    const pricingChanged = JSON.stringify(this.config.pricing) !== JSON.stringify(config.pricing);
    this.config = config;
    this.configOverrides = overrides;
    this.ledger.updateTokenPrice(this.config.usdPerMillionTokens);
    if (pricingChanged) this.pricing.start(this.config.pricing.mode !== 'manual');
    this.store.updateRetention({
      idleTtlMs: this.config.artifactIdleTtlMinutes * 60_000,
      maxEntries: this.config.artifactMaxEntries,
      maxTotalBytes: this.config.artifactMaxTotalMiB * 1024 * 1024,
    });
    this.persistentDedup.updateTtl(this.config.artifactIdleTtlMinutes * 60_000);
    if (policyChanged) this.recordCostPolicyAssessment();
  }

  getConfig(): EngineConfig {
    return structuredClone(this.config);
  }

  getCostPolicyContext(): CostPolicyContext {
    return structuredClone(this.policyContext);
  }

  getCostPolicyAssessment(): CostPolicyAssessment {
    return assessCostPolicy(this.config.costPolicy, { ...this.policyContext, profile: this.config.profile });
  }

  recordCostPolicyAssessment(): CostPolicyAssessment {
    const assessment = this.getCostPolicyAssessment();
    this.ledger.record({
      ts: Date.now(), tool: 'session', label: 'Cost policy assessed', strategy: 'session:cost-policy',
      sessionId: this.sessionId, sessionLabel: this.sessionLabel, outcomeReason: 'Session event',
      tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
      costPolicyAssessment: assessment,
    });
    return assessment;
  }

  getPricingSnapshot() {
    return this.pricing.snapshot(this.config.pricing, this.config.usdPerMillionTokens, this.detectedModel);
  }

  setRequestModel(model: DetectedModel): void {
    if (this.policyContext.host !== 'owned-chat') throw new Error('Only an owned request can set its model');
    const identity = validateCostPolicy({ version: 1, mode: 'off', allowedModels: [{ vendor: model.vendor, id: model.id }] }).allowedModels[0]!;
    if (typeof model.name !== 'string' || model.name.length > 300) throw new Error('Invalid request model name');
    if (this.detectedModel?.id === identity.id && this.detectedModel.vendor === identity.vendor) return;
    this.detectedModel = { ...identity, name: model.name };
    this.recordModelDetected();
  }

  dispose(): void {
    this.pricing.dispose();
  }

  private validatePricingConfig(config: EngineConfig): void {
    validatePricing(config.pricing);
    if (!validRate(config.usdPerMillionTokens)) throw new Error('Invalid manual token price');
  }

  getConfigOverrides(): Partial<EngineConfig> {
    return structuredClone(this.configOverrides);
  }

  setWorkspaceRoots(roots: string[]): void {
    this.workspaceRoots = [...roots];
  }

  getWorkspaceRoots(): readonly string[] {
    return this.workspaceRoots;
  }

  /** Directory that holds this engine's artifacts, ledger, and indexes. */
  getStorageDir(): string {
    return this.rootDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionLabel(): string {
    return this.sessionLabel;
  }

  /**
   * Update the producer label shown for this session. Events already recorded
   * keep their original label; subsequent events adopt the new one. Callers use
   * this to track the project the user is actively working in.
   */
  setSessionLabel(label: string): void {
    const trimmed = label.trim();
    if (trimmed) this.sessionLabel = trimmed;
  }

  // --- command output ---------------------------------------------------

  compressCommandOutput(input: CommandOutputInput): ToolOutput {
    const startedAtMs = Date.now();
    this.pendingArtifactMs = 0;
    const raw = renderRawCommandOutput(input);
    const header = renderCommandHeader(input);
    return this.compressBlob({
      raw,
      header,
      label: `$ ${input.command}`,
      kind: 'command-output',
      tool: 'run_command',
      forceLogCompression: true,
      startedAtMs,
      workspacePath: input.cwd,
    });
  }

  /**
   * Compress text returned by a Copilot postToolUse hook.
   *
   * Hook results have already been rendered by the originating tool, so this
   * path must not add a synthetic command header or alter passthrough output.
   */
  compressToolResult(input: ToolResultInput): ToolOutput {
    const startedAtMs = Date.now();
    this.pendingArtifactMs = 0;
    const label = `${input.toolName} result`;
    return this.compressBlob({
      raw: input.text,
      label,
      kind: 'tool-output',
      tool: input.toolName,
      forceLogCompression: isCommandLikeTool(input.toolName),
      startedAtMs,
      workspacePath: input.cwd,
    });
  }

  // --- file reads -------------------------------------------------------

  /**
   * Resolve and validate a caller-supplied path. Throws `PathAccessError` with
   * a message written for the model when the path is out of bounds.
   */
  resolveReadPath(candidate: string): string {
    return assertReadablePath(candidate, this.workspaceRoots);
  }

  compressFileRead(input: FileReadInput): ToolOutput {
    const startedAtMs = Date.now();
    this.pendingArtifactMs = 0;
    const safe = sanitizeUntrusted(input.content);
    const lines = safe === '' ? [] : safe.split('\n');
    const artifact = this.timeStore(() => this.store.put(safe, { label: input.path, kind: 'file' }));
    const tokensBefore = countTextTokens(safe);

    if (!this.config.enabled || !this.config.readLifecycle) {
      return this.finish({
        tool: 'read_file',
        label: input.path,
        strategy: 'passthrough',
        outcomeReason: 'Strategy disabled',
        text: safe,
        artifactId: artifact.id,
        tokensBefore,
        bytesBefore: Buffer.byteLength(safe, 'utf8'),
        linesBefore: lines.length,
        startedAtMs,
      });
    }

    const classification = this.reads.classify(input.path, safe);
    let text: string;
    let strategy: string;

    if (classification.state === 'unchanged' && classification.previous) {
      const previous = classification.previous;
      text =
        `${input.path}\n` +
        `--- slipstream: unchanged since read #${previous.readCount} earlier this session ` +
        `(${previous.lines} lines, sha ${previous.contentHash.slice(0, 8)}). Content omitted. ---\n` +
        renderMarker({
          id: artifact.id,
          startLine: 1,
          endLine: Math.max(lines.length, 1),
          reason: 'unchanged since last read',
        });
      strategy = 'read-lifecycle:unchanged';
    } else if (classification.state === 'modified' && classification.previous) {
      const previousContent = this.timeStore(() => this.store.get(classification.previous!.artifactId));
      if (previousContent === undefined) {
        text = this.renderFreshFile(input.path, safe, lines, artifact.id);
        strategy = 'read-lifecycle:fresh';
      } else {
        const patch = createTwoFilesPatch(
          `${input.path} (read #${classification.previous.readCount})`,
          `${input.path} (current)`,
          previousContent,
          safe,
          undefined,
          undefined,
          { context: 3 },
        );
        // A file that was rewritten wholesale produces a diff containing both
        // versions, which is worse than just sending the new one.
        if (patch.length < safe.length * DIFF_BUDGET_RATIO) {
          text =
            `--- slipstream: file changed since read #${classification.previous.readCount}. ` +
            `Showing a unified diff instead of the full ${lines.length}-line file. ---\n` +
            `${patch}\n` +
            renderMarker({
              id: artifact.id,
              startLine: 1,
              endLine: Math.max(lines.length, 1),
              reason: 'full current file',
            });
          strategy = 'read-lifecycle:diff';
        } else {
          text = this.renderFreshFile(input.path, safe, lines, artifact.id);
          strategy = 'read-lifecycle:rewritten';
        }
      }
    } else {
      text = this.renderFreshFile(input.path, safe, lines, artifact.id);
      strategy = 'read-lifecycle:fresh';
    }

    this.reads.commit({
      absPath: input.path,
      contentHash: classification.contentHash,
      content: safe,
      artifactId: artifact.id,
    });

    return this.finish({
      tool: 'read_file',
      label: input.path,
      strategy,
      outcomeReason: text === safe ? 'Passthrough/raw output' : 'Compressed',
      text,
      raw: safe,
      artifactId: artifact.id,
      tokensBefore,
      bytesBefore: Buffer.byteLength(safe, 'utf8'),
      linesBefore: lines.length,
      startedAtMs,
      workspacePath: input.path,
    });
  }

  // --- retrieval --------------------------------------------------------

  retrieve(input: RetrieveInput): RetrieveResult {
    const startedAtMs = Date.now();
    this.pendingArtifactMs = 0;
    if (!isValidArtifactId(input.id)) {
      throw new Error(
        `"${String(input.id)}" is not a valid artifact id. Ids are 12 hexadecimal characters ` +
          `and appear inside [[slipstream:...]] markers in earlier tool output.`,
      );
    }
    const slice = this.timeStore(() =>
      this.store.slice(input.id, {
        startLine: input.startLine,
        endLine: input.endLine,
        grep: input.grep,
        maxLines: input.maxLines,
      }),
    );
    if (!slice) {
      throw new Error(
        `Artifact ${input.id} is no longer available (artifacts expire after 60 minutes of ` +
          `disuse). Re-run the command or re-read the file to regenerate it.`,
      );
    }
    const tokens = countTextTokens(slice.text);
    this.ledger.record({
      ts: Date.now(),
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      ...this.workspaceAttributionForArtifact(input.id, slice.label),
      outcomeReason: 'Retrieved omitted content',
      tool: 'retrieve_artifact',
      label: slice.label,
      strategy: 'retrieve',
      tokensBefore: tokens,
      tokensAfter: tokens,
      bytesBefore: Buffer.byteLength(slice.text, 'utf8'),
      bytesAfter: Buffer.byteLength(slice.text, 'utf8'),
      linesBefore: slice.returnedLines,
      linesAfter: slice.returnedLines,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      artifactMs: this.pendingArtifactMs,
      artifactId: input.id,
      retrievalMode: input.grep ? 'grep' : 'id',
      retrievalStartLine: input.startLine,
      retrievalEndLine:
        input.endLine ??
        (input.startLine === undefined ? undefined : input.startLine + Math.max(0, slice.returnedLines - 1)),
    });
    this.flushEvictions();
    return slice;
  }

  // --- reporting --------------------------------------------------------

  summary(): SavingsSummary {
    return this.ledger.summary();
  }

  recentEvents(count = 50): LedgerEntry[] {
    return this.ledger.recent(count);
  }

  /** Record a Copilot prompt without retaining its text or affecting savings. */
  recordChatSubmitted(timestamp = Date.now()): void {
    this.recordSessionEvent({
      label: 'Chat submitted',
      strategy: 'session:chat',
      timestamp,
    });
  }

  recordModelDetected(): void {
    this.recordSessionEvent({ label: this.detectedModel?.name ?? 'Unknown model', strategy: 'session:model' });
  }

  /**
   * The input and output of a past compression, for display.
   *
   * Either side may be missing once the artifact has been evicted; callers are
   * expected to show the entry without a preview rather than fail.
   */
  inspect(entry: LedgerEntry, maxLines = 3000): { before?: string; after?: string } {
    const clamp = (text: string | undefined): string | undefined => {
      if (text === undefined) return undefined;
      const lines = text.split('\n');
      if (lines.length <= maxLines) return text;
      return `${lines.slice(0, maxLines).join('\n')}\n... ${lines.length - maxLines} more line(s) not shown`;
    };
    return {
      before: clamp(entry.artifactId ? this.store.get(entry.artifactId) : undefined),
      after: clamp(entry.renderedArtifactId ? this.store.get(entry.renderedArtifactId) : undefined),
    };
  }

  purge(): { artifacts: number } {
    const artifacts = this.store.purgeAll();
    this.dedup.clearPersistent();
    this.dedup.reset();
    this.reads.reset();
    this.recordSessionEvent({ label: `Purged ${artifacts} stored artifact(s)`, strategy: 'session:purge' });
    this.flushEvictions();
    return { artifacts };
  }

  /**
   * Forget what the model has already been shown, without deleting artifacts.
   * Existing retrieval markers stay valid; the next read of a file is full again
   * and previously-returned text is no longer deduplicated away.
   */
  resetSession(): void {
    this.dedup.reset({ detachPersistence: true });
    this.reads.reset();
    this.recordSessionEvent({ label: 'Session reset', strategy: 'session:reset' });
  }

  private recordSessionEvent(input: { label: string; strategy: string; timestamp?: number }): void {
    this.ledger.record({
      ts: input.timestamp ?? Date.now(),
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      ...this.workspaceAttribution(this.workspaceRoots[0]),
      outcomeReason: 'Session event',
      tool: 'session',
      ...(this.detectedModel ? { detectedModel: { ...this.detectedModel } } : {}),
      label: input.label,
      strategy: input.strategy,
      tokensBefore: 0,
      tokensAfter: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      linesBefore: 0,
      linesAfter: 0,
      durationMs: 0,
    });
  }

  // --- internals --------------------------------------------------------

  private renderFreshFile(
    filePath: string,
    content: string,
    lines: readonly string[],
    artifactId: string,
  ): string {
    const plan = this.compressorRegistry.compress({
      text: content,
      lines,
      source: 'file',
      fileExtension: path.extname(filePath),
      config: this.config,
    });
    if (plan) {
      const artifactText = plan.artifactText ?? content;
      const plannedLines = artifactText === content ? lines : artifactText.split('\n');
      const plannedArtifactId = artifactText === content
        ? artifactId
        : this.timeStore(() => this.store.put(artifactText, { label: filePath, kind: 'file' })).id;
      const body = this.renderSegments(plan.segments, plannedLines, plannedArtifactId);
      return (
        `--- slipstream: ${plannedLines.length}-line file outlined to ${countKept(plan.segments)} kept lines. ` +
        `Collapsed bodies are recoverable with retrieve_artifact(id="${plannedArtifactId}"). ---\n` +
        body
      );
    }
    if (lines.length <= this.config.maxFileLines) {
      return content;
    }
    const head = lines.slice(0, this.config.maxFileLines).join('\n');
    return (
      `${head}\n` +
      renderMarker({
        id: artifactId,
        startLine: this.config.maxFileLines + 1,
        endLine: lines.length,
        reason: 'file longer than the read budget',
      })
    );
  }

  private compressBlob(params: {
    raw: string;
    header?: string;
    label: string;
    kind: string;
    tool: string;
    forceLogCompression?: boolean;
    startedAtMs: number;
    workspacePath?: string;
  }): ToolOutput {
    const safeRaw = sanitizeUntrusted(params.raw);
    // ANSI stripping is a normalization applied before routing so every
    // downstream compressor sees clean lines and the saving folds into whatever
    // strategy fires. tokensBefore/bytesBefore are measured on the RAW text so
    // removing the escape codes is counted as a real saving, not hidden.
    const ansiEnabled = this.config.enabled && this.config.ansi?.enabled !== false;
    const safe = ansiEnabled ? stripAnsi(safeRaw) : safeRaw;
    const ansiRemoved = safe !== safeRaw;
    const safeLines = safe === '' ? [] : safe.split('\n');
    // The baseline includes the header: any terminal tool echoes the command it
    // ran, so charging it to compression would make passthrough look like a loss.
    const baseline = params.header ? `${params.header}\n${safeRaw}` : safeRaw;
    const tokensBefore = countTextTokens(baseline);
    const bytesBefore = Buffer.byteLength(baseline, 'utf8');

    const compressionAllowed = this.config.enabled && this.config.compressLogs;

    // A strategy may reformat what gets stored. The log path keeps the raw bytes;
    // the JSON path pretty-prints so each element lands on its own line and can
    // be pointed at. `artifactText` is whatever the segments below index into,
    // and it is exactly what the artifact store holds for retrieval.
    let artifactText = safe;
    let segments: Segment[];
    let strategy: string;
    let outcomeReason: OutcomeReason;

    const plan = this.compressorRegistry.compress({
      text: safe,
      lines: safeLines,
      source: 'output',
      forceLogCompression: params.forceLogCompression,
      config: this.config,
    });

    if (plan) {
      artifactText = plan.artifactText ?? safe;
      segments = plan.segments;
      strategy = plan.strategy;
      outcomeReason = 'Compressed';
    } else {
      segments = safeLines.length > 0 ? [{ kind: 'kept', startLine: 1, endLine: safeLines.length }] : [];
      strategy = 'passthrough';
      const kind = detectContentKind(safe);
      const compressibleKind =
        kind === 'log' ||
        kind === 'json' ||
        kind === 'diff' ||
        kind === 'search' ||
        kind === 'tabular' ||
        kind === 'config' ||
        Boolean(params.forceLogCompression);
      outcomeReason = !compressionAllowed
        ? 'Strategy disabled'
        : compressibleKind
          ? 'Too small'
          : 'No compressible content found';
    }

    // When no line-omission plan fired but ANSI normalization already removed
    // escape codes, that stripping is itself the compression: label it so the
    // saving is not mis-reported as passthrough.
    if (strategy === 'passthrough' && ansiRemoved) {
      strategy = 'ansi';
      outcomeReason = 'Compressed';
    }

    const compressed = strategy !== 'passthrough';
    const lines = artifactText === '' ? [] : artifactText.split('\n');
    // Tokenizer-aware refinement: compressors decide omissions by line count, but
    // each marker costs ~50 tokens, so revert any omitted run that is too cheap in
    // tokens to pay for its marker. Purely additive to fidelity (reverting shows
    // more verbatim), and it trims money-losing markers a net-positive plan would
    // otherwise keep. Skipped for whole-text strategies with no omitted segments.
    if (this.config.enabled && this.config.tokenBudget?.enabled !== false) {
      segments = refineSegmentsByTokens(segments, lines, countTextTokens, this.config.tokenBudget);
    }
    const artifact = this.timeStore(() =>
      this.store.put(artifactText, { label: params.label, kind: params.kind }),
    );

    const body = this.renderSegments(segments, lines, artifact.id);
    if (this.config.enabled && this.config.crossTurnDedup) {
      this.dedup.register(artifact.id, lines, params.label);
    }

    const keptLines = countKept(segments);
    // Only decorate when something was actually omitted. A passthrough has
    // nothing to retrieve, so appending the recoverability banner would be both
    // misleading and a net token loss — on small command output it can forward
    // more tokens than it received.
    const text = compressed
      ? `${params.header ? `${params.header}\n` : ''}` +
        `--- slipstream: ${lines.length} -> ${keptLines} lines; ` +
        `omissions recoverable via retrieve_artifact ---\n` +
        body
      : baseline;

    return this.finish({
      tool: params.tool,
      label: params.label,
      strategy,
      outcomeReason,
      text,
      raw: baseline,
      artifactId: artifact.id,
      tokensBefore,
      bytesBefore,
      linesBefore: lines.length,
      startedAtMs: params.startedAtMs,
      workspacePath: params.workspacePath,
    });
  }

  /**
   * Turn a segment plan into text, running cross-turn dedup over the kept runs.
   * Dedup happens after log compression so pointers only cover surviving lines.
   */
  private renderSegments(
    segments: readonly Segment[],
    lines: readonly string[],
    artifactId: string,
  ): string {
    const parts: string[] = [];
    for (const segment of segments) {
      if (segment.kind === 'omitted') {
        parts.push(
          renderMarker({
            id: artifactId,
            startLine: segment.startLine,
            endLine: segment.endLine,
            reason: segment.reason,
          }),
        );
        continue;
      }
      const slice = lines.slice(segment.startLine - 1, segment.endLine);
      if (!this.config.enabled || !this.config.crossTurnDedup) {
        parts.push(slice.join('\n'));
        continue;
      }
      parts.push(this.applyDedup(slice, artifactId, segment.startLine));
    }
    return parts.join('\n');
  }

  /**
   * @param absStartLine 1-based line number of `slice[0]` within the current
   * artifact. Near-duplicate pointers address the current artifact, so they need
   * absolute line numbers rather than offsets into the slice.
   */
  private applyDedup(slice: readonly string[], artifactId: string, absStartLine: number): string {
    const matches = this.dedup.find(slice);
    if (matches.length === 0) {
      return slice.join('\n');
    }
    const parts: string[] = [];
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) {
        parts.push(slice.slice(cursor, match.start).join('\n'));
      }
      if (match.exact) {
        // Byte-identical: the source artifact holds exactly these bytes.
        parts.push(
          renderDedupMarker({
            id: match.sourceArtifactId,
            startLine: match.source.startLine,
            endLine: match.source.endLine,
            reason: 'duplicate',
            label: match.sourceLabel,
          }),
        );
      } else {
        // Near-identical: the differing bytes live only in this output, so the
        // pointer must address the current artifact or retrieval would hand
        // back the earlier run's content instead.
        const start = absStartLine + match.start;
        parts.push(
          renderNearDedupMarker({
            id: artifactId,
            startLine: start,
            endLine: start + match.length - 1,
            reason: 'near-duplicate',
            label: match.sourceLabel,
          }),
        );
      }
      cursor = match.start + match.length;
    }
    if (cursor < slice.length) {
      parts.push(slice.slice(cursor).join('\n'));
    }
    return parts.join('\n');
  }

  private finish(params: {
    tool: string;
    label: string;
    strategy: string;
    outcomeReason: OutcomeReason;
    text: string;
    /**
     * The uncompressed text. When compressing turns out not to pay, this is sent
     * instead. Omit only when there is nothing to fall back to.
     */
    raw?: string;
    artifactId: string;
    tokensBefore: number;
    bytesBefore: number;
    linesBefore: number;
    startedAtMs: number;
    workspacePath?: string;
  }): ToolOutput {
    let text = params.text;
    let strategy = params.strategy;
    let outcomeReason = params.outcomeReason;
    let tokensAfter = countTextTokens(text);

    // Markers are not free: each one costs roughly 30 tokens. On small or dense
    // output that overhead can exceed what the omitted lines were worth, and a
    // "compression" that inflates the payload is worse than doing nothing. When
    // the saving is not worth the indirection, send the original instead.
    //
    // Outputs that already equal the raw text are left alone: nothing was
    // rewritten, so the strategy that produced them is still the accurate label.
    if (
      params.raw !== undefined &&
      text !== params.raw &&
      strategy !== 'passthrough' &&
      tokensAfter > params.tokensBefore * MIN_BENEFIT_RATIO
    ) {
      text = params.raw;
      strategy = 'passthrough:not-worth-it';
      outcomeReason = 'Not worth it after marker overhead';
      tokensAfter = countTextTokens(text);
    }

    // A plan that produced no omissions returns the original bytes; recording it
    // as "Compressed" would overstate what actually happened.
    if (outcomeReason === 'Compressed' && params.raw !== undefined && text === params.raw) {
      outcomeReason = 'Passthrough/raw output';
    }

    const linesAfter = text === '' ? 0 : text.split('\n').length;
    // Keep the rendered output too, so the dashboard can show what was actually
    // sent next to what came in. Identical content is deduplicated by the store,
    // so a passthrough costs nothing extra.
    const rendered = this.timeStore(() =>
      this.store.put(text, {
        label: `rendered: ${params.label}`,
        kind: 'rendered',
      }),
    );
    const durationMs = Math.max(0, Date.now() - params.startedAtMs);

    this.ledger.record({
      ts: Date.now(),
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      ...this.workspaceAttribution(params.workspacePath ?? params.label),
      outcomeReason,
      tool: params.tool,
      label: params.label,
      strategy,
      tokensBefore: params.tokensBefore,
      tokensAfter,
      bytesBefore: params.bytesBefore,
      bytesAfter: Buffer.byteLength(text, 'utf8'),
      linesBefore: params.linesBefore,
      linesAfter,
      durationMs,
      artifactMs: this.pendingArtifactMs,
      artifactId: params.artifactId,
      renderedArtifactId: rendered.id,
      // Parsed from the payload that is actually being returned, so a plan that
      // was reverted for marker overhead records no markers as shown.
      markers: parseMarkers(text).map((marker) => ({
        artifactId: marker.id,
        startLine: marker.startLine,
        endLine: marker.endLine,
      })),
    });
    this.flushEvictions();
    return {
      text,
      artifactId: params.artifactId,
      tokensBefore: params.tokensBefore,
      tokensAfter,
      tokensSaved: params.tokensBefore - tokensAfter,
      linesBefore: params.linesBefore,
      linesAfter,
      strategy,
      durationMs,
    };
  }

  /** Run a store operation, charging its elapsed time to the call in flight. */
  private timeStore<T>(operation: () => T): T {
    const started = Date.now();
    try {
      return operation();
    } finally {
      this.pendingArtifactMs += Math.max(0, Date.now() - started);
    }
  }

  /**
   * Record artifacts retention dropped during this call. Their markers can no
   * longer be expanded, so the audit must not count them as never needed.
   */
  private flushEvictions(): void {
    if (this.pendingEvictions.length === 0) return;
    const evictedArtifactIds = [...new Set(this.pendingEvictions)];
    this.pendingEvictions = [];
    this.ledger.record({
      ts: Date.now(),
      sessionId: this.sessionId,
      sessionLabel: this.sessionLabel,
      ...this.workspaceAttribution(this.workspaceRoots[0]),
      outcomeReason: 'Artifacts evicted',
      tool: 'session',
      label: `Evicted ${evictedArtifactIds.length} stored artifact(s)`,
      strategy: 'session:evict',
      tokensBefore: 0,
      tokensAfter: 0,
      bytesBefore: 0,
      bytesAfter: 0,
      linesBefore: 0,
      linesAfter: 0,
      durationMs: 0,
      evictedArtifactIds,
    });
  }

  private workspaceAttribution(candidate: string | undefined): { workspaceRoot?: string; workspaceLabel?: string } {
    if (!candidate) return {};
    const normalizedCandidate = path.resolve(candidate);
    const root = this.workspaceRoots
      .map((workspaceRoot) => path.resolve(workspaceRoot))
      .sort((a, b) => b.length - a.length)
      .find((workspaceRoot) => {
        const relative = path.relative(workspaceRoot, normalizedCandidate);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
    if (!root) return {};
    return {
      workspaceRoot: root,
      workspaceLabel: path.basename(root) || root,
    };
  }

  private workspaceAttributionForArtifact(
    artifactId: string,
    fallback: string | undefined,
  ): { workspaceRoot?: string; workspaceLabel?: string } {
    const source = this.ledger.recent(200).find((entry) => entry.artifactId === artifactId && entry.workspaceRoot);
    if (source?.workspaceRoot) {
      return {
        workspaceRoot: source.workspaceRoot,
        workspaceLabel: source.workspaceLabel,
      };
    }
    return this.workspaceAttribution(fallback);
  }
}

function countKept(segments: readonly Segment[]): number {
  let total = 0;
  for (const segment of segments) {
    if (segment.kind === 'kept') {
      total += segment.endLine - segment.startLine + 1;
    }
  }
  return total;
}

function renderRawCommandOutput(input: CommandOutputInput): string {
  const parts: string[] = [];
  if (input.stdout) {
    parts.push(input.stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  }
  if (input.stderr) {
    parts.push(`--- stderr ---`);
    parts.push(input.stderr.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  }
  return parts.join('\n');
}

function renderCommandHeader(input: CommandOutputInput): string {
  const bits = [`exit ${input.exitCode ?? 'null'}`];
  if (typeof input.durationMs === 'number') {
    bits.push(`${(input.durationMs / 1000).toFixed(1)}s`);
  }
  bits.push(`cwd ${input.cwd}`);
  return `$ ${input.command}\n(${bits.join(', ')})`;
}

function isCommandLikeTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === 'bash' ||
    normalized === 'powershell' ||
    normalized === 'task' ||
    normalized === 'run_command' ||
    normalized.endsWith('-run_command') ||
    normalized.endsWith('_runcommand')
  );
}
