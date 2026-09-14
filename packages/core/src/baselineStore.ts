import * as fs from 'node:fs';
import * as path from 'node:path';

/** A saved aggregate to compare a later run against. */
export interface SavingsBaseline {
  savedAt: number;
  label: string;
  events: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  percentSaved: number;
  /** 0-100, share of compressions the model later expanded. */
  retrievalRate: number;
  /** Total Slipstream processing time across recorded events. */
  totalOverheadMs: number;
}

/**
 * Stores a single baseline next to the ledger.
 *
 * Comparison is deliberately against one explicitly saved point rather than an
 * automatic rolling window: a demo needs a stable "before" that does not move
 * while the run it is being compared with is in progress.
 */
export class BaselineStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'baseline.json');
  }

  path(): string {
    return this.filePath;
  }

  save(baseline: SavingsBaseline): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(baseline, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  load(): SavingsBaseline | undefined {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return isBaseline(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Reject a corrupt or hand-edited file rather than rendering NaN comparisons. */
function isBaseline(value: unknown): value is SavingsBaseline {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Number.isFinite(candidate['savedAt']) &&
    Number.isFinite(candidate['tokensSaved']) &&
    Number.isFinite(candidate['tokensBefore']) &&
    Number.isFinite(candidate['tokensAfter']) &&
    Number.isFinite(candidate['percentSaved']) &&
    Number.isFinite(candidate['retrievalRate']) &&
    Number.isFinite(candidate['totalOverheadMs']) &&
    Number.isFinite(candidate['events'])
  );
}
