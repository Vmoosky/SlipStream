import type { Segment } from '../types.js';

export interface ConfigCompressorConfig {
  /** Only engage when the input has at least this many lines. */
  minLines: number;
  /** Only collapse a comment/blank run of at least this many lines. */
  minRunToOmit: number;
  /** A plan must omit at least this many lines to be worth a marker. */
  minOmitted: number;
}

export const DEFAULT_CONFIG_CONFIG: ConfigCompressorConfig = {
  minLines: 40,
  minRunToOmit: 6,
  minOmitted: 12,
};

export type ConfigFormat = 'ini' | 'yaml';

export interface ConfigPlan {
  segments: Segment[];
  /** `ini` when `[section]` headers are present, otherwise treated as `yaml`. */
  format: ConfigFormat;
  keptLines: number;
  omittedLines: number;
}

const COMMENT_RE = /^\s*[#;]/;
const SECTION_RE = /^\s*\[[^\]]+\]\s*$/;
const KEYVAL_RE = /^\s*[\w.$-]+\s*[:=]\s?/;
const LIST_ITEM_RE = /^\s*-\s+\S/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** A line that carries no setting: a comment or a blank separator. */
function isCollapsible(line: string): boolean {
  return isBlank(line) || COMMENT_RE.test(line);
}

/**
 * True when a strong majority of the non-blank lines are config syntax
 * (comments, `[section]` headers, `key: value` / `key = value` pairs, list
 * items) and there is real structure (a section header or several keys). Used by
 * the content router to pick the `config` kind before falling back to `text`.
 */
export function looksLikeConfig(
  lines: readonly string[],
  minLines = DEFAULT_CONFIG_CONFIG.minLines,
): boolean {
  if (lines.length < minLines) return false;
  let nonBlank = 0;
  let configLike = 0;
  let sections = 0;
  let keyvals = 0;
  for (const raw of lines) {
    const line = raw ?? '';
    if (isBlank(line)) continue;
    nonBlank++;
    if (COMMENT_RE.test(line)) {
      configLike++;
    } else if (SECTION_RE.test(line)) {
      configLike++;
      sections++;
    } else if (KEYVAL_RE.test(line)) {
      configLike++;
      keyvals++;
    } else if (LIST_ITEM_RE.test(line)) {
      configLike++;
    }
  }
  if (nonBlank === 0) return false;
  return configLike / nonBlank >= 0.75 && (sections > 0 || keyvals >= 3);
}

/**
 * Plan a compression of config tool output (YAML / TOML / INI). Every line that
 * carries a setting — `[section]` headers, `key: value` / `key = value` pairs,
 * list items — is kept; long runs of comment and blank lines (license headers,
 * commented-out defaults, doc blocks) collapse behind a recoverable marker.
 *
 * Lossless — the engine stores the raw bytes and the marker recovers the omitted
 * comments verbatim. Returns null when the input is too short or would not omit
 * enough to pay for a marker; callers fall back to passthrough on null.
 */
export function planConfigCompression(
  lines: readonly string[],
  config: Partial<ConfigCompressorConfig> = {},
): ConfigPlan | null {
  const cfg = { ...DEFAULT_CONFIG_CONFIG, ...config };
  const n = lines.length;
  if (n < cfg.minLines) return null;

  let hasSection = false;
  const keep = new Array<boolean>(n).fill(true);
  for (let i = 0; i < n; i++) {
    if (SECTION_RE.test(lines[i] ?? '')) hasSection = true;
  }

  let omittedLines = 0;
  let i = 0;
  while (i < n) {
    if (!isCollapsible(lines[i] ?? '')) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isCollapsible(lines[i] ?? '')) i++;
    const length = i - start;
    if (length >= cfg.minRunToOmit) {
      for (let j = start; j < i; j++) keep[j] = false;
      omittedLines += length;
    }
  }
  if (omittedLines < cfg.minOmitted) return null;

  const { segments, keptLines } = buildSegments(keep);
  return {
    segments,
    format: hasSection ? 'ini' : 'yaml',
    keptLines,
    omittedLines,
  };
}

function buildSegments(keep: readonly boolean[]): { segments: Segment[]; keptLines: number } {
  const n = keep.length;
  const raw: Segment[] = [];
  let i = 0;
  let keptLines = 0;

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
        reason: `${length} comment/blank line${length === 1 ? '' : 's'}`,
      });
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

  return { segments, keptLines };
}
