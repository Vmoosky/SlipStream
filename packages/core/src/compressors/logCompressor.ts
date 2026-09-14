import type { LogFormat, Segment, Severity } from '../types.js';

export interface LogCompressorConfig {
  /** Always keep this many leading lines (command echo, tool version banner). */
  headLines: number;
  /** Always keep this many trailing lines (the summary block). */
  tailLines: number;
  /** Lines of context retained before an error anchor. */
  contextBefore: number;
  /** Lines of context retained after an error anchor. */
  contextAfter: number;
  /** Stack frames retained per error before the rest is dropped. */
  maxStackFrames: number;
  /** Warning lines retained before the rest is dropped. */
  maxWarnings: number;
  /** Occurrences retained per repeated line template. */
  duplicateThreshold: number;
  /** Runs shorter than this are cheaper to keep than to replace with a marker. */
  minRunToOmit: number;
}

export const DEFAULT_LOG_CONFIG: LogCompressorConfig = {
  headLines: 6,
  tailLines: 30,
  contextBefore: 2,
  contextAfter: 4,
  maxStackFrames: 12,
  maxWarnings: 20,
  duplicateThreshold: 3,
  minRunToOmit: 5,
};

export interface LogPlan {
  segments: Segment[];
  format: LogFormat;
  keptLines: number;
  totalLines: number;
}

type DropReason = 'build noise' | 'repeated pattern' | 'low-severity output';

interface LineInfo {
  severity: Severity | null;
  isStackFrame: boolean;
  isSummary: boolean;
  isNoise: boolean;
  template: string;
}

// --- format detection ---------------------------------------------------

/**
 * Weighted signals. A distinctive anchor such as `Test Suites:` identifies the
 * format on its own, while a common glyph such as a check mark is worth almost
 * nothing -- several tools use it, and a long run of them would otherwise
 * outvote the anchor.
 */
interface FormatSignal {
  re: RegExp;
  weight: number;
  cap: number;
}

const FORMAT_SIGNALS: Array<{ format: LogFormat; patterns: FormatSignal[] }> = [
  {
    format: 'jest',
    patterns: [
      { re: /^Test Suites:/, weight: 50, cap: 1 },
      { re: /^Ran all test suites/, weight: 30, cap: 1 },
      { re: /^\s*●\s/, weight: 15, cap: 2 },
      { re: /^(PASS|FAIL)\s+\S/, weight: 2, cap: 10 },
    ],
  },
  {
    format: 'vitest',
    patterns: [
      { re: /^\s*Test Files\s+\d/, weight: 50, cap: 1 },
      { re: /^\s*FAIL\s+\S+\s*>/, weight: 10, cap: 3 },
      { re: /^\s*[✓×❯]\s/, weight: 1, cap: 6 },
    ],
  },
  {
    format: 'tsc',
    patterns: [
      { re: /^Found \d+ errors?/, weight: 50, cap: 1 },
      { re: /\berror TS\d{4}\b/, weight: 3, cap: 10 },
    ],
  },
  {
    format: 'eslint',
    patterns: [
      { re: /\bproblems? \(\d+ errors?/, weight: 50, cap: 1 },
      { re: /^\s+\d+:\d+\s+(error|warning)\s{2,}/, weight: 3, cap: 10 },
    ],
  },
  {
    format: 'npm',
    patterns: [
      { re: /^added \d+ packages/, weight: 40, cap: 1 },
      { re: /^npm (ERR!|WARN|notice)/, weight: 3, cap: 10 },
    ],
  },
  {
    format: 'cargo',
    patterns: [
      { re: /^error: could not compile|^\s{4}Finished\b/, weight: 40, cap: 1 },
      { re: /^error\[E\d{4}\]/, weight: 10, cap: 5 },
      { re: /^\s{3}Compiling \S+ v/, weight: 2, cap: 10 },
    ],
  },
  {
    format: 'pytest',
    patterns: [
      { re: /^=+ .*(passed|failed|error).* =+$/, weight: 50, cap: 1 },
      { re: /^FAILED \S+::/, weight: 10, cap: 5 },
      { re: /^_{5,} .+ _{5,}$/, weight: 5, cap: 5 },
    ],
  },
  {
    format: 'dotnet',
    patterns: [
      { re: /^Build (succeeded|FAILED)\./, weight: 50, cap: 1 },
      { re: /: (error|warning) [A-Z]{2}\d{4}:/, weight: 3, cap: 10 },
    ],
  },
  {
    format: 'gradle',
    patterns: [
      { re: /^BUILD (SUCCESSFUL|FAILED)/, weight: 50, cap: 1 },
      { re: /^> Task :/, weight: 3, cap: 10 },
    ],
  },
];

export function detectLogFormat(lines: readonly string[]): LogFormat {
  const sample = lines.slice(0, 4000);
  let best: LogFormat = 'generic';
  let bestScore = 0;
  for (const { format, patterns } of FORMAT_SIGNALS) {
    let score = 0;
    for (const signal of patterns) {
      let hits = 0;
      for (const line of sample) {
        if (signal.re.test(line)) {
          hits++;
          if (hits >= signal.cap) {
            break;
          }
        }
      }
      score += hits * signal.weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = format;
    }
  }
  return bestScore > 0 ? best : 'generic';
}

// --- line classification ------------------------------------------------

/** Matches "0 failed", "0 errors" etc. so a clean summary is not read as an error. */
const ZERO_COUNT_RE = /\b0\s+(errors?|failures?|failed|failing|problems?)\b/i;

const ERROR_RE =
  /(^|\s)(error|errors|ERR!|FAIL|FAILED|FAILURE|Exception|panicked|fatal|Traceback|✕|✗|×|⨯)(\s|:|!|$)|\berror\s+TS\d{4}\b|^error\[E\d{4}\]|^\s*●\s|: error [A-Z]{2}\d{4}:/;

const WARN_RE = /(^|\s)(warn|warning|WARN|deprecated|DeprecationWarning)(\s|:|$)|: warning [A-Z]{2}\d{4}:/i;

const STACK_FRAME_RE =
  /^\s+at\s|^\s+File\s+".+",\s+line\s+\d+|^\s+\d+:\s+0x[0-9a-f]+|^\s+#\d+\s+0x|^\s{4,}(\||\d+\s*\|)|^\s+-->\s|^\s+\.{3}\s|^\s+in\s+\S+\s+\(/;

const SUMMARY_RE =
  /^(Test Suites|Tests|Snapshots|Time|Ran all test suites|Found \d+ errors?|Build (succeeded|FAILED)|BUILD (SUCCESSFUL|FAILED))\b|^\s*(Test Files|Duration|Start at)\s+\d|^=+ .*(passed|failed|error).* =+$|^\s*\d+ (passing|failing|pending)\b|\bexit code \d+|^added \d+ packages|^error: could not compile|^error: aborting due to/i;

const NOISE_RE =
  /^\s*[\u2500-\u257f\u2580-\u259f=_\-*.]{8,}\s*$|^\s*\[?[=#>\-]{5,}\]?\s*\d{0,3}%?\s*$|^npm (http|timing|verb|sill)\b|^\s{3}(Compiling|Downloading|Downloaded|Checking|Updating|Fresh|Blocking)\s|^\s*(⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)|^\s*\d+\/\d+\s+\[.*\]\s*$|^\s*$/;

function classify(line: string): LineInfo {
  const isNoise = NOISE_RE.test(line);
  const isSummary = !isNoise && SUMMARY_RE.test(line);
  const isStackFrame = STACK_FRAME_RE.test(line);

  let severity: Severity | null = null;
  if (!isNoise && !ZERO_COUNT_RE.test(line)) {
    if (ERROR_RE.test(line)) {
      severity = 'error';
    } else if (WARN_RE.test(line)) {
      severity = 'warn';
    }
  }

  return { severity, isStackFrame, isSummary, isNoise, template: templateOf(line) };
}

/** Collapse volatile parts of a line so repeats of the same message group together. */
export function templateOf(line: string): string {
  return line
    .replace(/0x[0-9a-fA-F]+/g, '#x')
    .replace(/\b[0-9a-fA-F]{8,}\b/g, '#h')
    .replace(/\b\d+(\.\d+)?(ms|s|m|kb|mb|gb)\b/gi, '#t')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- planning -----------------------------------------------------------

/**
 * Decide which lines of a build/test log survive.
 *
 * Guarantees relied on by the tests:
 *  - every error-severity line is kept unless it is the Nth repeat of an
 *    identical template (N > duplicateThreshold);
 *  - a stack trace is never split from the error line it belongs to;
 *  - the trailing summary block is always kept.
 */
export function planLogCompression(
  lines: readonly string[],
  config: Partial<LogCompressorConfig> = {},
): LogPlan {
  const cfg = { ...DEFAULT_LOG_CONFIG, ...config };
  const n = lines.length;
  const format = detectLogFormat(lines);

  if (n === 0) {
    return { segments: [], format, keptLines: 0, totalLines: 0 };
  }

  const info = lines.map((line) => classify(line ?? ''));
  const keep = new Array<boolean>(n).fill(false);
  const reason = new Array<DropReason>(n).fill('low-severity output');
  const isErrorAnchor = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    if (info[i]?.isNoise) {
      reason[i] = 'build noise';
    }
  }

  // Head and tail.
  for (let i = 0; i < Math.min(cfg.headLines, n); i++) {
    if (!info[i]?.isNoise) {
      keep[i] = true;
    }
  }
  for (let i = Math.max(0, n - cfg.tailLines); i < n; i++) {
    keep[i] = true;
  }

  // Errors, their context, and their stack frames.
  let warningsKept = 0;
  for (let i = 0; i < n; i++) {
    const line = info[i];
    if (!line) {
      continue;
    }
    if (line.isSummary) {
      keep[i] = true;
      continue;
    }
    if (line.severity === 'error') {
      keep[i] = true;
      isErrorAnchor[i] = true;
      for (let j = Math.max(0, i - cfg.contextBefore); j < i; j++) {
        if (!info[j]?.isNoise) {
          keep[j] = true;
        }
      }
      let frames = 0;
      let held = 0;
      for (let j = i + 1; j < n; j++) {
        const next = info[j];
        if (!next) {
          break;
        }
        if (next.isStackFrame) {
          if (frames < cfg.maxStackFrames) {
            keep[j] = true;
            frames++;
          } else {
            reason[j] = 'build noise';
          }
          continue;
        }
        if (held < cfg.contextAfter && !next.isNoise) {
          keep[j] = true;
          held++;
          continue;
        }
        break;
      }
      continue;
    }
    if (line.severity === 'warn' && warningsKept < cfg.maxWarnings) {
      keep[i] = true;
      warningsKept++;
    }
  }

  // Collapse repeats of the same message. A hundred identical type errors carry
  // the information of three.
  const seenTemplates = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const line = info[i];
    if (!keep[i] || !line || line.isSummary || line.isStackFrame) {
      continue;
    }
    // Neither the head nor the tail window is exempt. Their job is to preserve
    // the command echo and the outcome block, both of which are unique lines,
    // so nothing there can be collapsed by accident -- but a log whose first or
    // last thirty lines are the same repeated error still collapses.
    if (line.template.length < 12) {
      continue;
    }
    const count = (seenTemplates.get(line.template) ?? 0) + 1;
    seenTemplates.set(line.template, count);
    if (count > cfg.duplicateThreshold) {
      keep[i] = false;
      reason[i] = 'repeated pattern';
      // Drop the frames that belonged to this duplicate too.
      for (let j = i + 1; j < n && info[j]?.isStackFrame; j++) {
        keep[j] = false;
        reason[j] = 'repeated pattern';
      }
    }
  }

  return { ...buildSegments(keep, reason, cfg.minRunToOmit), format, totalLines: n };
}

function buildSegments(
  keep: readonly boolean[],
  reason: readonly DropReason[],
  minRunToOmit: number,
): { segments: Segment[]; keptLines: number } {
  const n = keep.length;
  const raw: Segment[] = [];
  let i = 0;
  let keptLines = 0;

  while (i < n) {
    const start = i;
    const keeping = keep[i] === true;
    while (i < n && (keep[i] === true) === keeping) {
      i++;
    }
    const length = i - start;
    if (keeping || length < minRunToOmit) {
      raw.push({ kind: 'kept', startLine: start + 1, endLine: i });
      keptLines += length;
    } else {
      raw.push({
        kind: 'omitted',
        startLine: start + 1,
        endLine: i,
        reason: dominantReason(reason, start, i),
      });
    }
  }

  // Merge kept runs that became adjacent when a short dropped run was retained.
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

function dominantReason(reason: readonly DropReason[], start: number, end: number): DropReason {
  const counts = new Map<DropReason, number>();
  for (let i = start; i < end; i++) {
    const value = reason[i] ?? 'low-severity output';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: DropReason = 'low-severity output';
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}
