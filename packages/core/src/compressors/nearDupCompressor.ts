import type { Segment } from '../types.js';

/**
 * Near-duplicate line folding.
 *
 * Templated output — progress lines, per-item "processed X" messages, repeated
 * warnings/retries — produces long runs of lines that differ only by a varying
 * number (a counter, timestamp, size, id). Exact-match dedup misses them and the
 * log compressor only clusters recognised log lines, so this general pass folds
 * runs of *consecutive* lines that share a normalized template, keeping a few
 * representatives and omitting the middle behind a recoverable marker.
 *
 * Lossless and byte-exact: the omitted lines live verbatim in the artifact store
 * and are recovered exactly via `retrieve_artifact`. Only consecutive runs are
 * folded, so segments stay contiguous and order-preserving. Normalizes numeric
 * runs, UUIDs, and hex-looking ids (hex tokens containing at least one digit,
 * to avoid folding ordinary alphabetic words that happen to be hex-safe).
 */

export interface NearDupCompressorConfig {
  /** A run must be at least this many consecutive similar lines to fold. */
  minRun: number;
  /** Keep this many representative lines at the start of a folded run. */
  head: number;
  /** Keep this many representative lines at the end of a folded run. */
  tail: number;
  /** A plan must omit at least this many lines to be worth a marker. */
  minOmitted: number;
  /**
   * A line's template must have at least this many non-placeholder,
   * non-whitespace characters to be foldable — this excludes blanks, short
   * separators, and pure-number lines from accidental folding.
   */
  minTemplateChars: number;
}

export const DEFAULT_NEARDUP_CONFIG: NearDupCompressorConfig = {
  minRun: 4,
  head: 2,
  tail: 1,
  minOmitted: 3,
  minTemplateChars: 8,
};

export interface NearDupPlan {
  segments: Segment[];
  keptLines: number;
  omittedLines: number;
}

/** Matches canonical UUIDs (8-4-4-4-12 hex groups). */
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

/**
 * Matches hex-looking ids (commit SHAs, hashes, object ids) of 6+ characters.
 * Requires at least one digit so ordinary alphabetic words that happen to be
 * hex-safe (e.g. "facade", "deed") aren't mistaken for ids.
 */
const HEX_ID_RE = /\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{6,}\b/g;

/**
 * Normalize a line to a template by collapsing UUIDs, hex-looking ids, and
 * digit runs to `#`, so lines that differ only by a varying id/counter/
 * timestamp share the same template.
 */
export function lineTemplate(line: string): string {
  return line.replace(UUID_RE, '#').replace(HEX_ID_RE, '#').replace(/\d+/g, '#');
}

/** Count of characters in a template that are neither placeholders nor whitespace. */
function templateContent(template: string): number {
  let count = 0;
  for (const ch of template) {
    if (ch !== '#' && !/\s/.test(ch)) count++;
  }
  return count;
}

/**
 * Plan a fold of consecutive near-identical line runs. Returns null when no run
 * qualifies or too little would be omitted to pay for a marker; callers fall
 * back to passthrough on null.
 */
export function planNearDupCompression(
  lines: readonly string[],
  config: Partial<NearDupCompressorConfig> = {},
): NearDupPlan | null {
  const cfg = { ...DEFAULT_NEARDUP_CONFIG, ...config };
  const n = lines.length;
  if (n < cfg.minRun) return null;

  const templates = lines.map((line) => lineTemplate(line ?? ''));
  const foldable = templates.map((t) => templateContent(t) >= cfg.minTemplateChars);

  const keep = new Array<boolean>(n).fill(true);
  let omittedLines = 0;

  let i = 0;
  while (i < n) {
    if (!foldable[i]) {
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < n && foldable[i] && templates[i] === templates[start]) i++;
    const runLength = i - start;
    if (runLength >= cfg.minRun) {
      const omitStart = start + cfg.head;
      const omitEnd = i - cfg.tail; // exclusive
      for (let j = omitStart; j < omitEnd; j++) {
        keep[j] = false;
        omittedLines++;
      }
    }
  }

  if (omittedLines < cfg.minOmitted) return null;

  const { segments, keptLines } = buildSegments(keep);
  return { segments, keptLines, omittedLines };
}

function buildSegments(keep: readonly boolean[]): { segments: Segment[]; keptLines: number } {
  const n = keep.length;
  const segments: Segment[] = [];
  let i = 0;
  let keptLines = 0;

  while (i < n) {
    const start = i;
    const keeping = keep[i] === true;
    while (i < n && (keep[i] === true) === keeping) i++;
    const length = i - start;
    if (keeping) {
      segments.push({ kind: 'kept', startLine: start + 1, endLine: i });
      keptLines += length;
    } else {
      segments.push({
        kind: 'omitted',
        startLine: start + 1,
        endLine: i,
        reason: `${length} near-identical line${length === 1 ? '' : 's'}`,
      });
    }
  }

  return { segments, keptLines };
}
