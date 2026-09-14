import type { Segment } from '../types.js';
import { lineTemplate } from './nearDupCompressor.js';

export interface SearchCompressorConfig {
  /** Only engage when at least this many parseable match lines are present. */
  minMatches: number;
  /** Keep the first N matches of every file group (navigation boundary). */
  headPerFile: number;
  /** Keep the last N matches of every file group. */
  tailPerFile: number;
  /** Only collapse an interior run of at least this many matches. */
  minRunToOmit: number;
  /** A plan must omit at least this many lines to be worth a marker. */
  minOmitted: number;
  /**
   * Keep (do not omit) an interior run when the distinctness ratio of its
   * templated content column is at least this. Protects greps where the matched
   * text itself is the payload (heading/symbol/definition lists) from being
   * folded away. Set above 1 to disable the gate and always omit long runs.
   */
  keepDistinctRatio: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchCompressorConfig = {
  minMatches: 20,
  headPerFile: 2,
  tailPerFile: 1,
  minRunToOmit: 6,
  minOmitted: 12,
  keepDistinctRatio: 0.5,
};

export interface SearchPlan {
  segments: Segment[];
  /** Distinct files seen across the match lines. */
  files: number;
  /** Total parseable `path:line:` match lines. */
  matches: number;
  keptLines: number;
  omittedLines: number;
}

/**
 * A grep/ripgrep match line: an optional drive letter, a colon-free path, then
 * `:<line>:` (with an optional `:<col>:`). Anchored so a stray colon inside the
 * matched content never confuses the file boundary. Paths with spaces are not
 * matched — grep tool output uses relative or unquoted paths in practice.
 */
const MATCH_RE = /^((?:[A-Za-z]:)?[^\s:]+):(\d+):(?:(\d+):)?/;

/** The captured path must look like a real path: a separator or a file extension. */
function parsePath(line: string): string | null {
  const m = MATCH_RE.exec(line);
  if (!m) return null;
  const path = m[1] as string;
  if (!/[\\/]/.test(path) && !/\.[A-Za-z0-9]{1,8}$/.test(path)) return null;
  return path;
}

/** The matched text after the `path:line:` (or `path:line:col:`) coordinate prefix. */
function contentColumn(line: string): string {
  const m = MATCH_RE.exec(line);
  return m ? line.slice(m[0].length) : line;
}

/**
 * Fraction of an interior run whose content column is structurally distinct.
 * Content is templated (digit runs → `#`) before comparison, so "same shape,
 * different numbers" rows (`retry attempt 1`, `retry attempt 2`, …) count as
 * duplicates, while genuinely different text (a heading or symbol list) stays
 * distinct. 1.0 means every line is unique; near 0 means near-duplicate noise.
 */
function contentDistinctness(
  lines: readonly string[],
  start: number,
  end: number,
): number {
  const templates = new Set<string>();
  let count = 0;
  for (let j = start; j < end; j++) {
    templates.add(lineTemplate(contentColumn(lines[j] ?? '')));
    count++;
  }
  return count === 0 ? 1 : templates.size / count;
}

/**
 * True when a strong majority of the non-blank lines are `path:line:content`
 * match rows — the flat, machine-readable grep/ripgrep format. Used by the
 * content router to pick the `search` kind before falling back to `log`/`text`.
 */
export function looksLikeSearchResults(
  lines: readonly string[],
  minMatches = DEFAULT_SEARCH_CONFIG.minMatches,
): boolean {
  let nonBlank = 0;
  let matches = 0;
  for (const line of lines) {
    if ((line ?? '').trim() === '') continue;
    nonBlank++;
    if (parsePath(line ?? '') !== null) matches++;
  }
  return matches >= minMatches && nonBlank > 0 && matches / nonBlank >= 0.6;
}

/**
 * Plan a compression of flat grep/ripgrep output. Match lines are grouped by
 * file; the first `headPerFile` and last `tailPerFile` matches of each file are
 * kept (so every file and its coordinate boundaries survive) and long interior
 * runs collapse to a single recoverable marker. Non-match lines (blank
 * separators, `--` context breaks, headings) are always kept.
 *
 * Lossless — the engine stores the raw bytes and the marker recovers the omitted
 * matches verbatim. Returns null when there are too few matches or too little to
 * omit; callers fall back to passthrough on null.
 */
export function planSearchCompression(
  lines: readonly string[],
  config: Partial<SearchCompressorConfig> = {},
): SearchPlan | null {
  const cfg = { ...DEFAULT_SEARCH_CONFIG, ...config };
  const n = lines.length;
  if (n === 0) return null;

  const paths = new Array<string | null>(n);
  let matches = 0;
  const distinct = new Set<string>();
  for (let i = 0; i < n; i++) {
    const p = parsePath(lines[i] ?? '');
    paths[i] = p;
    if (p !== null) {
      matches++;
      distinct.add(p);
    }
  }
  if (matches < cfg.minMatches) return null;

  const keep = new Array<boolean>(n).fill(true);

  // Walk maximal runs of consecutive match lines sharing one path. Only the
  // interior of a long run is dropped; head/tail coordinates always stay.
  let i = 0;
  while (i < n) {
    const path = paths[i];
    if (path === null) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && paths[i] === path) i++;
    const length = i - start;
    const omittable = length - cfg.headPerFile - cfg.tailPerFile;
    if (omittable >= cfg.minRunToOmit) {
      const omitStart = start + cfg.headPerFile;
      const omitEnd = i - cfg.tailPerFile; // exclusive
      // Only fold the interior when its content is near-duplicate noise. When
      // the matched text itself is distinct (a heading/symbol list), keep it —
      // the omission would discard exactly the lines the caller searched for.
      const distinctness = contentDistinctness(lines, omitStart, omitEnd);
      if (distinctness < cfg.keepDistinctRatio) {
        for (let j = omitStart; j < omitEnd; j++) keep[j] = false;
      }
    }
  }

  const { segments, keptLines, omittedLines } = buildSegments(keep, paths);
  if (omittedLines < cfg.minOmitted) return null;

  return {
    segments,
    files: distinct.size,
    matches,
    keptLines,
    omittedLines,
  };
}

function buildSegments(
  keep: readonly boolean[],
  paths: readonly (string | null)[],
): { segments: Segment[]; keptLines: number; omittedLines: number } {
  const n = keep.length;
  const raw: Segment[] = [];
  let i = 0;
  let keptLines = 0;
  let omittedLines = 0;

  while (i < n) {
    const start = i;
    const keeping = keep[i] === true;
    while (i < n && (keep[i] === true) === keeping) i++;
    const length = i - start;
    if (keeping) {
      raw.push({ kind: 'kept', startLine: start + 1, endLine: i });
      keptLines += length;
    } else {
      const path = paths[start];
      const where = path ? ` in ${path}` : '';
      raw.push({
        kind: 'omitted',
        startLine: start + 1,
        endLine: i,
        reason: `${length} more match${length === 1 ? '' : 'es'}${where}`,
      });
      omittedLines += length;
    }
  }

  const segments: Segment[] = [];
  for (const segment of raw) {
    const previous = segments[segments.length - 1];
    if (previous && previous.kind === 'kept' && segment.kind === 'kept') {
      previous.endLine = segment.endLine;
    } else {
      segments.push(segment);
    }
  }

  return { segments, keptLines, omittedLines };
}
