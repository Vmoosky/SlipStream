import type { Segment } from '../types.js';

export interface TabularCompressorConfig {
  /** Only engage when at least this many data rows are present. */
  minRows: number;
  /** Keep the first N data rows (the header context and first values). */
  headRows: number;
  /** Keep the last N data rows. */
  tailRows: number;
  /** Only collapse an interior run of at least this many ordinary rows. */
  minRunToOmit: number;
  /** A plan must omit at least this many lines to be worth a marker. */
  minOmitted: number;
  /** Keep any row whose length exceeds the median row length times this ratio. */
  sizeOutlierRatio: number;
}

export const DEFAULT_TABULAR_CONFIG: TabularCompressorConfig = {
  minRows: 20,
  headRows: 3,
  tailRows: 2,
  minRunToOmit: 6,
  minOmitted: 12,
  sizeOutlierRatio: 3,
};

export type TableFormat = 'markdown' | 'csv' | 'tsv';

export interface TabularPlan {
  segments: Segment[];
  format: TableFormat;
  /** Total data rows (header/separator excluded). */
  rows: number;
  keptRows: number;
  omittedRows: number;
  keptLines: number;
  omittedLines: number;
}

interface TableInfo {
  format: TableFormat;
  delimiter: string;
  /** 0-based line indices of header (and markdown separator) rows, always kept. */
  headerLines: number[];
  /** 0-based index where data rows begin. */
  dataStart: number;
}

/** A markdown alignment cell, requiring a run of at least 3 dashes. */
const MD_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;

function isMarkdownSeparator(line: string): boolean {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').every((cell) => MD_SEPARATOR_CELL_RE.test(cell.trim()));
}

/** Count the cells of a markdown row, ignoring the optional outer pipes. */
function markdownCells(line: string): number {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').length;
}

function fieldCount(line: string, info: TableInfo): number {
  return info.format === 'markdown'
    ? markdownCells(line)
    : line.split(info.delimiter).length;
}

function isRowLike(line: string, info: TableInfo): boolean {
  if (line.trim() === '') return false;
  return info.format === 'markdown'
    ? line.includes('|')
    : line.includes(info.delimiter);
}

/**
 * Identify the table: a markdown header + `---` separator, or a CSV/TSV block
 * whose rows share a delimiter and field count. Returns null when the text is
 * not predominantly a single delimited table.
 */
function findTable(lines: readonly string[]): TableInfo | null {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if ((lines[i] ?? '').trim() !== '') {
      first = i;
      break;
    }
  }
  if (first < 0) return null;

  // Markdown: a header row followed by an alignment separator.
  if ((lines[first] ?? '').includes('|')) {
    let sep = first + 1;
    while (sep < n && (lines[sep] ?? '').trim() === '') sep++;
    if (sep < n && isMarkdownSeparator(lines[sep] ?? '')) {
      return { format: 'markdown', delimiter: '|', headerLines: [first, sep], dataStart: sep + 1 };
    }
  }

  // CSV / TSV: prefer tab, then comma; a strong majority of non-blank lines must
  // share the same field count so prose with stray commas is not misread.
  for (const delimiter of ['\t', ',']) {
    const counts: number[] = [];
    for (let i = first; i < n; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '' || !line.includes(delimiter)) continue;
      counts.push(line.split(delimiter).length);
    }
    if (counts.length === 0) continue;
    const modal = mode(counts);
    if (modal < 2) continue;
    const matching = counts.filter((c) => c === modal).length;
    let nonBlank = 0;
    let sentenceEndings = 0;
    for (let i = first; i < n; i++) {
      const t = (lines[i] ?? '').trim();
      if (t === '') continue;
      nonBlank++;
      if (/[.!?]$/.test(t)) sentenceEndings++;
    }
    // Prose with regular commas has a consistent field count too; CSV rows,
    // unlike sentences, rarely end in terminal punctuation. This keeps ordinary
    // comma-separated prose from being misread as a table.
    if (nonBlank > 0 && sentenceEndings / nonBlank >= 0.5) continue;
    if (nonBlank > 0 && matching / nonBlank >= 0.6) {
      const format: TableFormat = delimiter === '\t' ? 'tsv' : 'csv';
      return { format, delimiter, headerLines: [first], dataStart: first + 1 };
    }
  }
  return null;
}

/**
 * True when the text is a delimited table (markdown / CSV / TSV) with at least
 * `minRows` data rows. Used by the content router to pick the `tabular` kind.
 */
export function looksLikeTabular(
  lines: readonly string[],
  minRows = DEFAULT_TABULAR_CONFIG.minRows,
): boolean {
  const info = findTable(lines);
  if (!info) return false;
  let rows = 0;
  for (let i = info.dataStart; i < lines.length; i++) {
    if (isRowLike(lines[i] ?? '', info)) rows++;
  }
  return rows >= minRows;
}

/**
 * Plan a compression of tabular tool output. The header (and markdown separator)
 * are always kept, along with the first `headRows` and last `tailRows` data
 * rows, rows with an unusual field count, and size outliers; long interior runs
 * of ordinary rows collapse to a recoverable marker. Non-row lines (blanks,
 * surrounding prose) are kept.
 *
 * Lossless — the engine stores the raw bytes and the marker recovers the omitted
 * rows verbatim. Returns null when there are too few rows or too little to omit.
 */
export function planTabularCompression(
  lines: readonly string[],
  config: Partial<TabularCompressorConfig> = {},
): TabularPlan | null {
  const cfg = { ...DEFAULT_TABULAR_CONFIG, ...config };
  const info = findTable(lines);
  if (!info) return null;
  const n = lines.length;

  const rowIdx: number[] = [];
  for (let i = info.dataStart; i < n; i++) {
    if (isRowLike(lines[i] ?? '', info)) rowIdx.push(i);
  }
  if (rowIdx.length < cfg.minRows) return null;

  const counts = rowIdx.map((i) => fieldCount(lines[i] ?? '', info));
  const modalCount = mode(counts);
  const lengths = rowIdx.map((i) => (lines[i] ?? '').length);
  const med = median(lengths);

  // Rows that must always survive: the boundary rows, shape outliers (a row with
  // a different column count), and size outliers (a row far longer than typical).
  const keepRow = new Set<number>();
  for (let k = 0; k < cfg.headRows && k < rowIdx.length; k++) keepRow.add(rowIdx[k] as number);
  for (let k = 0; k < cfg.tailRows && k < rowIdx.length; k++) {
    keepRow.add(rowIdx[rowIdx.length - 1 - k] as number);
  }
  for (let k = 0; k < rowIdx.length; k++) {
    const outlier =
      counts[k] !== modalCount ||
      (med > 0 && (lengths[k] as number) > med * cfg.sizeOutlierRatio);
    if (outlier) keepRow.add(rowIdx[k] as number);
  }

  const isRow = new Array<boolean>(n).fill(false);
  for (const i of rowIdx) isRow[i] = true;

  // Omittable = an ordinary data row not marked for keeping. Only maximal runs of
  // consecutive omittable rows that are long enough collapse.
  const keep = new Array<boolean>(n).fill(true);
  let omittedRows = 0;
  let i = 0;
  while (i < n) {
    if (!isRow[i] || keepRow.has(i)) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isRow[i] && !keepRow.has(i)) i++;
    const length = i - start;
    if (length >= cfg.minRunToOmit) {
      for (let j = start; j < i; j++) keep[j] = false;
      omittedRows += length;
    }
  }

  const { segments, keptLines, omittedLines } = buildSegments(keep);
  if (omittedLines < cfg.minOmitted) return null;

  return {
    segments,
    format: info.format,
    rows: rowIdx.length,
    keptRows: rowIdx.length - omittedRows,
    omittedRows,
    keptLines,
    omittedLines,
  };
}

function buildSegments(
  keep: readonly boolean[],
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
      raw.push({
        kind: 'omitted',
        startLine: start + 1,
        endLine: i,
        reason: `${length} similar row${length === 1 ? '' : 's'}`,
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

function mode(values: readonly number[]): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}
