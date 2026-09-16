import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { aggregateCost, resolvePricing, type PricingSnapshot } from './pricing.js';
import type { LedgerEntry, SavingsSummary, ToolCallContext, ToolSavings } from './types.js';

export interface SavingsLedgerOptions {
  rootDir: string;
  /** Rotate the JSONL file once it exceeds this size. Default 5 MiB. */
  maxFileBytes?: number;
  /** Blended input price used for the cost estimate. Default $3 / 1M tokens. */
  usdPerMillionTokens?: number;
  pricingSnapshot?: () => PricingSnapshot;
}

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_USD_PER_MILLION = 3;

/**
 * Append-only record of every compression and retrieval.
 *
 * Savings are measured strictly at the tool-output boundary:
 *   tokensSaved = tokens(rawToolOutput) - tokens(returnedToolOutput)
 * We cannot observe Copilot's full request, and we do not claim to.
 */
export class SavingsLedger {
  private readonly filePath: string;
  private readonly maxFileBytes: number;
  private usdPerMillionTokens: number;
  private readonly pricingSnapshot: () => PricingSnapshot;
  private entries: LedgerEntry[] = [];
  private listeners = new Set<(entry: LedgerEntry) => void>();
  private readonly toolCallContext = new AsyncLocalStorage<ToolCallContext>();
  /** Size and mtime of the parse currently held in `entries`. */
  private cacheKey = '';

  constructor(options: SavingsLedgerOptions) {
    this.filePath = path.join(options.rootDir, 'savings.jsonl');
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.usdPerMillionTokens = options.usdPerMillionTokens ?? DEFAULT_USD_PER_MILLION;
    this.pricingSnapshot = options.pricingSnapshot ?? (() => resolvePricing({ mode: 'manual' }, this.usdPerMillionTokens));
    fs.mkdirSync(options.rootDir, { recursive: true });
    this.load();
  }

  path(): string {
    return this.filePath;
  }

  record(entry: LedgerEntry, options: { durable?: boolean } = {}): void {
    const toolCall = this.toolCallContext.getStore();
    entry = structuredClone(entry.tool === 'session' ? entry : {
      ...entry, ...(toolCall ? { toolCall } : {}), pricing: entry.pricing ?? this.pricingSnapshot(),
    });
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flush: options.durable === true,
      });
    } catch (error) {
      if (options.durable) throw error;
      // Telemetry must never break a tool call.
    }
    this.entries.push(entry);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* ignore listener failures */
      }
    }
  }

  onRecord(listener: (entry: LedgerEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  withToolCallContext<Result>(context: ToolCallContext, action: () => Result): Result {
    const { source, sessionId, toolCallId, toolName } = context;
    return this.toolCallContext.run({ source, sessionId, toolCallId, toolName }, action);
  }

  updateTokenPrice(usdPerMillionTokens: number): void {
    this.usdPerMillionTokens = usdPerMillionTokens;
  }

  recent(count = 50): LedgerEntry[] {
    this.load();
    return this.entries.slice(-count).reverse();
  }

  /**
   * Every entry on disk, oldest first. Lifetime and history aggregates need the
   * whole ledger rather than the recent window the session panels use.
   */
  all(): readonly LedgerEntry[] {
    this.load();
    return this.entries;
  }

  summary(): SavingsSummary {
    this.load();
    const byTool = new Map<string, ToolSavings>();
    let tokensBefore = 0;
    let tokensAfter = 0;
    let calls = 0;
    let compressions = 0;
    let retrievals = 0;

    for (const entry of this.entries) {
      if (entry.tool === 'session') {
        continue;
      }
      calls++;
      if (entry.tool === 'retrieve_artifact') {
        retrievals++;
      } else {
        compressions++;
        tokensBefore += entry.tokensBefore;
        tokensAfter += entry.tokensAfter;
      }
      const bucket = byTool.get(entry.tool) ?? {
        tool: entry.tool,
        calls: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        tokensSaved: 0,
      };
      bucket.calls++;
      bucket.tokensBefore += entry.tokensBefore;
      bucket.tokensAfter += entry.tokensAfter;
      bucket.tokensSaved += entry.tokensBefore - entry.tokensAfter;
      byTool.set(entry.tool, bucket);
    }

    const tokensSaved = tokensBefore - tokensAfter;
  const cost = aggregateCost(this.entries, 'gross', this.usdPerMillionTokens);
    return {
      calls,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      percentSaved: tokensBefore > 0 ? (tokensSaved / tokensBefore) * 100 : 0,
      estimatedCostSavedUsd: cost.usd,
      cost,
      byTool: [...byTool.values()].sort((a, b) => b.tokensSaved - a.tokensSaved),
      compressions,
      retrievals,
      retrievalRate: compressions > 0 ? (retrievals / compressions) * 100 : 0,
    };
  }

  clear(): void {
    this.entries = [];
    this.cacheKey = '';
    for (const filePath of [`${this.filePath}.1`, this.filePath]) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > this.maxFileBytes && !fs.readdirSync(path.dirname(this.filePath)).some((name) => /^\.owned-task-[0-9a-f-]+\.lock$/.test(name))) {
        fs.rmSync(`${this.filePath}.1`, { force: true });
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      /* file may not exist yet */
    }
  }

  private load(): void {
    try {
      // Re-parsing the whole file on every read gets expensive as the ledger
      // grows, and the dashboard reads on every pushed update.
      const files = [`${this.filePath}.1`, this.filePath];
      const fingerprint = () => files.map((filePath) => {
        try {
          const stat = fs.statSync(filePath);
          return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
          throw error;
        }
      }).join('|');
      for (let attempt = 0; attempt < 2; attempt++) {
        const key = fingerprint();
        if (key === this.cacheKey) return;
        const entries: LedgerEntry[] = [];
        for (const filePath of files) {
          let raw: string;
          try { raw = fs.readFileSync(filePath, 'utf8'); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line) as LedgerEntry;
              if (isFiniteEntry(entry)) entries.push(entry);
            } catch {
              /* skip malformed line */
            }
          }
        }
        if (fingerprint() !== key) continue;
        this.entries = entries;
        this.cacheKey = key;
        return;
      }
    } catch {
      /* no ledger yet */
    }
  }
}

/** Reject NaN/Infinity so a corrupt line cannot poison the aggregate. */
function isFiniteEntry(entry: LedgerEntry): boolean {
  return (
    !!entry &&
    typeof entry.tool === 'string' &&
    Number.isFinite(entry.tokensBefore) &&
    Number.isFinite(entry.tokensAfter) &&
    Number.isFinite(entry.ts)
  );
}
