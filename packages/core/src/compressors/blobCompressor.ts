import type { Segment } from '../types.js';

/**
 * Opaque-blob elision.
 *
 * Every other compressor plans over line *ranges*, so a single enormous line —
 * a minified JS/CSS bundle, a standalone base64 string, a `data:` URI, or a hex
 * dump line — is invisible to them: it is one "kept" line that can dominate the
 * token cost of an otherwise small tool output. This compressor scans individual
 * lines and omits the ones that are both very long and opaque (carry no
 * line-structured, model-actionable content), keeping everything around them.
 *
 * Lossless and byte-exact: the omitted line lives verbatim in the artifact store
 * and is recovered exactly via `retrieve_artifact`. Two shapes are handled: a
 * single oversized opaque line, and a run of consecutive shorter opaque lines
 * (MIME-wrapped base64, a PEM body, a hex dump), which no individual-line test
 * can see. Blobs embedded mid-line alongside real content are still left for a
 * future intra-line (offset-range) enhancement.
 */

export interface BlobCompressorConfig {
  /** Only a line at least this many characters long can be elided. */
  minLineLength: number;
  /** A plan must omit at least this many characters to be worth a marker. */
  minOmitted: number;
  /**
   * A line qualifies when its longest run of base64/hex/url-safe characters
   * covers at least this fraction of the trimmed line.
   */
  opaqueRatio: number;
  /**
   * A line also qualifies (minified signal) when its whitespace fraction is at
   * or below this — long code bundles collapse to one nearly space-free line.
   */
  maxWhitespaceRatio: number;
  /**
   * Shortest line that may take part in a *multi-line* opaque run. Base64 is
   * conventionally wrapped at 64 or 76 columns; keeping this above the 40 of a
   * git SHA stops a column of hashes or short ids being swallowed.
   */
  minRunLineLength: number;
  /** Fewest consecutive opaque lines that can form a run. */
  minRunLines: number;
}

export const DEFAULT_BLOB_CONFIG: BlobCompressorConfig = {
  minLineLength: 2000,
  minOmitted: 2000,
  opaqueRatio: 0.85,
  maxWhitespaceRatio: 0.08,
  minRunLineLength: 60,
  minRunLines: 8,
};

export interface BlobPlan {
  segments: Segment[];
  keptLines: number;
  omittedLines: number;
  omittedChars: number;
}

const DATA_URI_RE = /data:[^\s,;]*;base64,/i;
const OPAQUE_CHAR_RE = /[A-Za-z0-9+/=_-]/;

/** Longest contiguous run of base64/hex/url-safe chars as a fraction of length. */
function opaqueRunFraction(line: string): number {
  if (line.length === 0) return 0;
  let best = 0;
  let current = 0;
  for (const ch of line) {
    if (OPAQUE_CHAR_RE.test(ch)) {
      current++;
      if (current > best) best = current;
    } else {
      current = 0;
    }
  }
  return best / line.length;
}

function whitespaceFraction(line: string): number {
  if (line.length === 0) return 1;
  let ws = 0;
  for (const ch of line) {
    if (ch === ' ' || ch === '\t') ws++;
  }
  return ws / line.length;
}

/**
 * True when a single line is long enough and opaque enough that eliding it (and
 * recovering it on demand) is worthwhile: a base64/hex run, a base64 data URI,
 * or a very long low-whitespace (minified) line.
 */
export function isOpaqueBlobLine(
  line: string,
  config: Partial<BlobCompressorConfig> = {},
): boolean {
  const cfg = { ...DEFAULT_BLOB_CONFIG, ...config };
  if (line.length < cfg.minLineLength) return false;
  if (DATA_URI_RE.test(line)) return true;
  const trimmed = line.trim();
  if (opaqueRunFraction(trimmed) >= cfg.opaqueRatio) return true;
  if (whitespaceFraction(line) <= cfg.maxWhitespaceRatio) return true;
  return false;
}

/**
 * True when a line is a plausible *member* of a wrapped blob: opaque, and long
 * enough that it is machine-wrapped payload rather than prose or an identifier.
 * Deliberately weaker than `isOpaqueBlobLine` — a single 76-char base64 line is
 * meaningless on its own, so a run of them is required before anything is
 * omitted.
 */
function isOpaqueRunLine(line: string, cfg: BlobCompressorConfig): boolean {
  const trimmed = line.trim();
  if (trimmed.length < cfg.minRunLineLength) return false;
  return opaqueRunFraction(trimmed) >= cfg.opaqueRatio;
}

/**
 * Plan an elision of oversized opaque lines. Returns null when nothing qualifies
 * or too little would be omitted to pay for a marker; callers fall back to
 * passthrough on null.
 */
export function planBlobCompression(
  lines: readonly string[],
  config: Partial<BlobCompressorConfig> = {},
): BlobPlan | null {
  const cfg = { ...DEFAULT_BLOB_CONFIG, ...config };
  const n = lines.length;
  if (n === 0) return null;

  const keep = new Array<boolean>(n).fill(true);
  let omittedChars = 0;
  let omittedLines = 0;
  for (let i = 0; i < n; i++) {
    const line = lines[i] ?? '';
    if (isOpaqueBlobLine(line, cfg)) {
      keep[i] = false;
      omittedChars += line.length;
      omittedLines++;
    }
  }

  // A blob wrapped across many short lines — MIME-style base64, a PEM body, a
  // hex dump — is invisible to the single-line test above because no individual
  // line is oversized. Fold maximal runs of such lines instead.
  for (let i = 0; i < n; i++) {
    if (!keep[i] || !isOpaqueRunLine(lines[i] ?? '', cfg)) continue;
    let end = i;
    let chars = 0;
    while (end < n && keep[end] && isOpaqueRunLine(lines[end] ?? '', cfg)) {
      chars += (lines[end] ?? '').length;
      end++;
    }
    const count = end - i;
    if (count >= cfg.minRunLines && chars >= cfg.minOmitted) {
      // Wrapping leaves a short final line (45,000 base64 chars at 76 columns
      // ends in 8). Absorb that remainder so the marker does not leave a
      // meaningless fragment stranded in the output.
      const tail = lines[end] ?? '';
      const tailTrimmed = tail.trim();
      if (
        end < n && keep[end] &&
        tailTrimmed.length > 0 && tailTrimmed.length < cfg.minRunLineLength &&
        opaqueRunFraction(tailTrimmed) >= cfg.opaqueRatio
      ) {
        chars += tail.length;
        end++;
      }
      for (let j = i; j < end; j++) keep[j] = false;
      omittedChars += chars;
      omittedLines += end - i;
    }
    i = end - 1;
  }

  if (omittedLines === 0 || omittedChars < cfg.minOmitted) return null;

  const { segments, keptLines } = buildSegments(keep, lines);
  return { segments, keptLines, omittedLines, omittedChars };
}

function buildSegments(
  keep: readonly boolean[],
  lines: readonly string[],
): { segments: Segment[]; keptLines: number } {
  const n = keep.length;
  const segments: Segment[] = [];
  let i = 0;
  let keptLines = 0;

  while (i < n) {
    const start = i;
    const keeping = keep[i] === true;
    while (i < n && (keep[i] === true) === keeping) i++;
    if (keeping) {
      segments.push({ kind: 'kept', startLine: start + 1, endLine: i });
      keptLines += i - start;
    } else {
      let chars = 0;
      for (let j = start; j < i; j++) chars += (lines[j] ?? '').length;
      const count = i - start;
      segments.push({
        kind: 'omitted',
        startLine: start + 1,
        endLine: i,
        reason: `${count} oversized/opaque line${count === 1 ? '' : 's'} (~${chars.toLocaleString('en-US')} chars)`,
      });
    }
  }

  return { segments, keptLines };
}
