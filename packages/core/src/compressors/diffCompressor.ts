import type { Segment } from '../types.js';

export interface DiffCompressorConfig {
  /** Unchanged context lines kept on each side of every change. */
  contextLines: number;
  /** Only collapse an unchanged run at least this long; shorter runs stay. */
  minRunToOmit: number;
  /** A plan must omit at least this many lines to be worth a marker. */
  minOmitted: number;
}

export const DEFAULT_DIFF_CONFIG: DiffCompressorConfig = {
  contextLines: 3,
  minRunToOmit: 6,
  minOmitted: 12,
};

export interface DiffPlan {
  segments: Segment[];
  /** `git` when `diff --git` headers are present, otherwise a plain unified diff. */
  format: 'git' | 'unified';
  /** Number of file sections seen (`+++ ` headers). */
  files: number;
  keptLines: number;
  omittedLines: number;
}

/**
 * A unified-diff header line that carries structure the model needs to navigate
 * the patch. These are always kept — collapsing them would orphan the hunks.
 */
const HEADER_RE =
  /^(diff --git |diff --cc |diff --combined |index |--- |\+\+\+ |@@ |@@@ |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files |GIT binary patch|\\ )/;

const HUNK_RE = /^@@@? /;

/**
 * Plan a compression of unified-diff tool output. Every changed line (`+`/`-`)
 * and every structural header (`diff --git`, `@@`, `---`/`+++`, mode/rename
 * lines) is kept; only long runs of *unchanged context* far from any change are
 * collapsed behind a recoverable marker. It is therefore lossless and never
 * hides an actual change — the omitted lines are the file's own context bytes,
 * recovered verbatim from the artifact store.
 *
 * Returns null when the input has no hunks or would not omit enough context to
 * pay for a marker; callers fall back to passthrough on null.
 */
export function planDiffCompression(
  lines: readonly string[],
  config: Partial<DiffCompressorConfig> = {},
): DiffPlan | null {
  const cfg = { ...DEFAULT_DIFF_CONFIG, ...config };
  const n = lines.length;
  if (n === 0) return null;

  let hasHunk = false;
  let isGit = false;
  let files = 0;
  const change = new Array<boolean>(n).fill(false);
  const header = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('diff --git') || line.startsWith('diff --cc')) isGit = true;
    if (line.startsWith('+++ ')) files++;
    if (HUNK_RE.test(line)) hasHunk = true;
    if (HEADER_RE.test(line)) {
      header[i] = true;
    } else if (isChangeLine(line)) {
      change[i] = true;
    }
  }

  if (!hasHunk) return null;

  const keep = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (header[i] || change[i]) keep[i] = true;
  }
  // Retain a window of unchanged context around every change so the model sees
  // where each edit lands without the full body between distant hunks.
  for (let i = 0; i < n; i++) {
    if (!change[i]) continue;
    const from = Math.max(0, i - cfg.contextLines);
    const to = Math.min(n - 1, i + cfg.contextLines);
    for (let j = from; j <= to; j++) keep[j] = true;
  }

  const { segments, keptLines, omittedLines } = buildSegments(keep, cfg.minRunToOmit);
  if (omittedLines < cfg.minOmitted) return null;

  return {
    segments,
    format: isGit ? 'git' : 'unified',
    files,
    keptLines,
    omittedLines,
  };
}

/** A hunk body line that adds or removes content (not a `---`/`+++` header). */
function isChangeLine(line: string): boolean {
  if (line.startsWith('+++') || line.startsWith('---')) return false;
  return line.startsWith('+') || line.startsWith('-');
}

function buildSegments(
  keep: readonly boolean[],
  minRunToOmit: number,
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
    if (keeping || length < minRunToOmit) {
      raw.push({ kind: 'kept', startLine: start + 1, endLine: i });
      keptLines += length;
    } else {
      raw.push({
        kind: 'omitted',
        startLine: start + 1,
        endLine: i,
        reason: `${length} unchanged context line${length === 1 ? '' : 's'}`,
      });
      omittedLines += length;
    }
  }

  // A short unchanged run that was retained can leave two kept runs adjacent;
  // merge them so the render emits one continuous block.
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
