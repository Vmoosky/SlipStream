import type { Segment } from '../types.js';

export interface JsonCompressorConfig {
  /** Only compress arrays with at least this many elements. */
  minItems: number;
  /** Always keep this many leading elements (boundary context). */
  headItems: number;
  /** Always keep this many trailing elements (boundary context). */
  tailItems: number;
  /** A plan must omit at least this many elements to be worth a marker. */
  minOmitted: number;
  /** Keep any element whose serialized length exceeds median * this ratio. */
  sizeOutlierRatio: number;
}

export const DEFAULT_JSON_CONFIG: JsonCompressorConfig = {
  minItems: 8,
  headItems: 2,
  tailItems: 1,
  minOmitted: 4,
  sizeOutlierRatio: 3,
};

export interface JsonPlan {
  /**
   * Pretty-printed text the segments index into. The engine stores this as the
   * artifact, so retrieval returns these exact lines. It is a reformatting of
   * the input, not the original bytes: JSON is whitespace-insensitive, so the
   * kept elements carry the same values the model would have seen.
   */
  text: string;
  segments: Segment[];
  /** Which top-level shape was compressed: an array or an object. */
  format: 'array' | 'object';
  keptItems: number;
  omittedItems: number;
}

const ERROR_KEY_RE = /error|err|fail|failure|exception|stack|trace|fatal|panic/i;
const ERROR_VALUE_RE = /\b(error|errors|failed|failure|exception|fatal|panic|traceback)\b/i;

/** 1-based inclusive line span of one array element inside the built text. */
interface ItemRange {
  startLine: number;
  endLine: number;
}

/**
 * Plan a compression of JSON tool output. Large arrays of near-identical items
 * (search results, list endpoints, log records serialized as JSON) are the
 * target: boundary items, structurally unusual items, error items and size
 * outliers are kept, and contiguous runs of ordinary items collapse to a single
 * retrieval marker.
 *
 * Returns null when the input is not JSON, has no bulk array, or would not save
 * enough to pay for a marker. Callers fall back to passthrough on null.
 */
export function planJsonCompression(
  raw: string,
  config: Partial<JsonCompressorConfig> = {},
): JsonPlan | null {
  const merged: JsonCompressorConfig = { ...DEFAULT_JSON_CONFIG, ...config };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    return planArray(parsed, merged);
  }
  if (parsed !== null && typeof parsed === 'object') {
    return planObject(parsed as Record<string, unknown>, merged);
  }
  return null;
}

function planArray(arr: readonly unknown[], config: JsonCompressorConfig): JsonPlan | null {
  if (arr.length < config.minItems) return null;

  const out: string[] = ['['];
  const ranges: ItemRange[] = [];
  for (let i = 0; i < arr.length; i++) {
    const startLine = out.length + 1;
    appendElement(out, arr[i], 2, i < arr.length - 1);
    ranges.push({ startLine, endLine: out.length });
  }
  out.push(']');

  return finalize(out, ranges, arr, config, 'array');
}

function planObject(obj: Record<string, unknown>, config: JsonCompressorConfig): JsonPlan | null {
  const bulkKey = pickBulkArrayKey(obj, config.minItems);
  if (!bulkKey) return null;
  const bulkArr = obj[bulkKey] as unknown[];

  const out: string[] = ['{'];
  const ranges: ItemRange[] = [];
  const keys = Object.keys(obj);
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki] as string;
    const isLast = ki === keys.length - 1;
    if (key === bulkKey) {
      out.push(`  ${JSON.stringify(key)}: [`);
      for (let i = 0; i < bulkArr.length; i++) {
        const startLine = out.length + 1;
        appendElement(out, bulkArr[i], 4, i < bulkArr.length - 1);
        ranges.push({ startLine, endLine: out.length });
      }
      out.push(isLast ? '  ]' : '  ],');
    } else {
      appendProperty(out, key, obj[key], isLast);
    }
  }
  out.push('}');

  return finalize(out, ranges, bulkArr, config, 'object');
}

/** Build segments from the element decisions and package the plan. */
function finalize(
  out: string[],
  ranges: readonly ItemRange[],
  items: readonly unknown[],
  config: JsonCompressorConfig,
  format: 'array' | 'object',
): JsonPlan | null {
  const keep = chooseKept(items, config);

  // Lines default to kept; that covers all structural lines (braces, brackets,
  // scalar properties) since only element lines are ever marked omitted.
  const total = out.length;
  const lineKept = new Array<boolean>(total + 1).fill(true);
  let omittedItems = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (keep[i]) continue;
    omittedItems++;
    const range = ranges[i] as ItemRange;
    for (let line = range.startLine; line <= range.endLine; line++) {
      lineKept[line] = false;
    }
  }
  if (omittedItems < config.minOmitted) return null;

  const reason = `${omittedItems} similar JSON item${omittedItems === 1 ? '' : 's'}`;
  const segments = buildSegments(lineKept, total, reason);

  return {
    text: out.join('\n'),
    segments,
    format,
    keptItems: items.length - omittedItems,
    omittedItems,
  };
}

/** Decide which array elements survive. */
function chooseKept(items: readonly unknown[], config: JsonCompressorConfig): boolean[] {
  const n = items.length;
  const keep = new Array<boolean>(n).fill(false);

  for (let i = 0; i < config.headItems && i < n; i++) keep[i] = true;
  for (let i = 0; i < config.tailItems && i < n; i++) keep[n - 1 - i] = true;

  for (let i = 0; i < n; i++) {
    if (isErrorItem(items[i])) keep[i] = true;
  }

  // Structurally unusual objects — a different set of keys than the norm — are
  // where the surprising information lives, so they are never collapsed.
  const signatures = items.map(signatureOf);
  const modal = modalSignature(signatures);
  if (modal !== null) {
    for (let i = 0; i < n; i++) {
      if (signatures[i] !== null && signatures[i] !== modal) keep[i] = true;
    }
  }

  // Size outliers: one giant record among small ones usually carries the payload
  // that matters (a stack trace, a diff, a body).
  const lengths = items.map((item) => safeStringify(item).length);
  const med = median(lengths);
  if (med > 0) {
    for (let i = 0; i < n; i++) {
      if ((lengths[i] as number) > med * config.sizeOutlierRatio) keep[i] = true;
    }
  }

  return keep;
}

function buildSegments(lineKept: readonly boolean[], total: number, omittedReason: string): Segment[] {
  const segments: Segment[] = [];
  let line = 1;
  while (line <= total) {
    const kept = lineKept[line] as boolean;
    let end = line;
    while (end + 1 <= total && (lineKept[end + 1] as boolean) === kept) end++;
    if (kept) {
      segments.push({ kind: 'kept', startLine: line, endLine: end });
    } else {
      segments.push({ kind: 'omitted', reason: omittedReason, startLine: line, endLine: end });
    }
    line = end + 1;
  }
  return segments;
}

/** Append one array element, indented and comma-terminated where needed. */
function appendElement(out: string[], value: unknown, indent: number, trailingComma: boolean): void {
  const lines = indentLines(JSON.stringify(value, null, 2) ?? 'null', indent);
  if (trailingComma) lines[lines.length - 1] += ',';
  for (const l of lines) out.push(l);
}

/** Append a `"key": value` object property (all such lines are kept). */
function appendProperty(out: string[], key: string, value: unknown, isLast: boolean): void {
  const rendered = (JSON.stringify(value, null, 2) ?? 'null').split('\n');
  rendered[0] = `  ${JSON.stringify(key)}: ${rendered[0]}`;
  for (let i = 1; i < rendered.length; i++) rendered[i] = `  ${rendered[i]}`;
  if (!isLast) rendered[rendered.length - 1] += ',';
  for (const l of rendered) out.push(l);
}

function pickBulkArrayKey(obj: Record<string, unknown>, minItems: number): string | undefined {
  let bestKey: string | undefined;
  let bestLen = minItems - 1;
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > bestLen) {
      bestLen = value.length;
      bestKey = key;
    }
  }
  return bestKey;
}

function isErrorItem(item: unknown): boolean {
  if (typeof item === 'string') return ERROR_VALUE_RE.test(item);
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
  for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
    if (ERROR_KEY_RE.test(key) && value !== null && value !== false && value !== '' && value !== 0) {
      return true;
    }
    if (typeof value === 'string' && ERROR_VALUE_RE.test(value)) return true;
  }
  return false;
}

/** A stable signature of an object's shape: its sorted top-level keys. */
function signatureOf(item: unknown): string | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  return Object.keys(item as Record<string, unknown>).sort().join(',');
}

function modalSignature(signatures: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const sig of signatures) {
    if (sig === null) continue;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [sig, count] of counts) {
    if (count > bestCount) {
      best = sig;
      bestCount = count;
    }
  }
  return best;
}

function indentLines(text: string, spaces: number): string[] {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((line) => pad + line);
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}
