import type { Segment } from '../types.js';

export interface CodeCompressorConfig {
  /** Files shorter than this are left whole -- an outline saves too little. */
  minLines: number;
  /** A body run shorter than this is cheaper to keep than to replace with a marker. */
  minBlockLines: number;
  /** A plan must omit at least this many lines to be worth building. */
  minOmitted: number;
}

export const DEFAULT_CODE_CONFIG: CodeCompressorConfig = {
  minLines: 60,
  minBlockLines: 6,
  minOmitted: 12,
};

export interface CodePlan {
  /**
   * Segments index into the ORIGINAL file lines. Unlike the JSON compressor,
   * nothing is reformatted: kept lines are the file's own bytes, so retrieval of
   * an omitted body returns it exactly. Only whole-body runs are ever omitted.
   */
  segments: Segment[];
  keptLines: number;
  omittedLines: number;
  /** Which structural model was used to find the bodies. */
  language: 'brace' | 'indent';
}

/** Languages whose block structure is expressed with `{ ... }`. */
const BRACE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.cs',
  '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.swift', '.kt', '.scala', '.vue',
  '.svelte',
]);

/** Languages whose block structure is expressed with indentation. */
const INDENT_EXTENSIONS = new Set(['.py']);

/** Lines that name a container whose direct children are worth keeping. */
const CONTAINER_RE =
  /\b(class|interface|struct|enum|namespace|module|trait|impl|object|record)\b/;

/** Python container line: its members (def signatures, fields) are the outline. */
const PY_CONTAINER_RE = /^\s*(class)\b/;
/** Python line that opens a collapsible body: a function definition. */
const PY_DEF_RE = /^\s*(async\s+def|def)\b/;

/**
 * Plan a structure-preserving compression of a source file. Signatures,
 * declarations, imports and comments that make up the file's outline are kept;
 * the interiors of function and method bodies collapse to retrieval markers.
 *
 * Returns null when the extension is not a supported language, the file is too
 * short, the structure could not be parsed cleanly, or too little would be
 * omitted to pay for the markers. Callers fall back to a head cap on null.
 */
export function planCodeCompression(
  content: string,
  fileExtension: string,
  config: Partial<CodeCompressorConfig> = {},
): CodePlan | null {
  const merged: CodeCompressorConfig = { ...DEFAULT_CODE_CONFIG, ...config };
  const ext = fileExtension.toLowerCase();
  const language: 'brace' | 'indent' | null = BRACE_EXTENSIONS.has(ext)
    ? 'brace'
    : INDENT_EXTENSIONS.has(ext)
      ? 'indent'
      : null;
  if (language === null) return null;

  const lines = content === '' ? [] : content.split('\n');
  if (lines.length < merged.minLines) return null;

  const inBody = language === 'brace' ? markBraceBodies(lines) : markIndentBodies(lines);
  if (inBody === null) return null;

  return buildPlan(inBody, merged, language);
}

/**
 * Decide, for each line, whether it sits inside a collapsible body. A line that
 * opens a body (a function signature) is not itself in a body, so it survives as
 * part of the outline; the lines it encloses are.
 *
 * Returns null when the braces do not balance, which means the best-effort
 * string/comment scan lost track and any plan built on it would be unsafe.
 */
function markBraceBodies(lines: readonly string[]): boolean[] | null {
  const inBody = new Array<boolean>(lines.length).fill(false);
  const stack: Array<'container' | 'body'> = [];
  let inBlockComment = false;
  let stringQuote: '"' | "'" | '`' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    inBody[i] = !inBlockComment && stringQuote === null && countBodies(stack) > 0;
    const kind: 'container' | 'body' = CONTAINER_RE.test(line) ? 'container' : 'body';

    for (let c = 0; c < line.length; c++) {
      const ch = line[c] as string;
      if (inBlockComment) {
        if (ch === '*' && line[c + 1] === '/') {
          inBlockComment = false;
          c++;
        }
        continue;
      }
      if (stringQuote !== null) {
        if (ch === '\\') {
          c++;
        } else if (ch === stringQuote) {
          stringQuote = null;
        }
        continue;
      }
      if (ch === '/' && line[c + 1] === '*') {
        inBlockComment = true;
        c++;
      } else if (ch === '/' && line[c + 1] === '/') {
        break;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        stringQuote = ch;
      } else if (ch === '{') {
        stack.push(kind);
      } else if (ch === '}') {
        stack.pop();
      }
    }
  }

  // A leftover open block, string or comment means the scan desynced (most often
  // a cross-line template expression). Bail rather than collapse the wrong span.
  if (stack.length !== 0 || inBlockComment || stringQuote !== null) return null;
  return inBody;
}

function countBodies(stack: readonly ('container' | 'body')[]): number {
  let n = 0;
  for (const kind of stack) if (kind === 'body') n++;
  return n;
}

/**
 * Indentation-based structure (Python). A line is in a body when a `def` block
 * on the stack still encloses it. `class` blocks are containers, so their member
 * signatures stay in the outline.
 */
function markIndentBodies(lines: readonly string[]): boolean[] | null {
  const inBody = new Array<boolean>(lines.length).fill(false);
  const stack: Array<{ indent: number; kind: 'container' | 'body' }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '') {
      // Blank lines belong to whatever run surrounds them; carry the current
      // state so a blank inside a body is collapsed with it.
      inBody[i] = countBodies(stack.map((b) => b.kind)) > 0;
      continue;
    }
    const indent = indentWidth(line);
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) {
      stack.pop();
    }
    inBody[i] = countBodies(stack.map((b) => b.kind)) > 0;

    if (PY_DEF_RE.test(line)) {
      stack.push({ indent, kind: 'body' });
    } else if (PY_CONTAINER_RE.test(line)) {
      stack.push({ indent, kind: 'container' });
    }
  }
  return inBody;
}

function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width++;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * Coalesce the per-line body flags into segments. Body runs shorter than
 * `minBlockLines` are kept -- a marker would cost more than they do -- so only
 * substantial interiors are omitted.
 */
function buildPlan(
  inBody: readonly boolean[],
  config: CodeCompressorConfig,
  language: 'brace' | 'indent',
): CodePlan | null {
  const total = inBody.length;
  const segments: Segment[] = [];
  let omittedLines = 0;
  let line = 0;

  while (line < total) {
    const body = inBody[line] as boolean;
    let end = line;
    while (end + 1 < total && (inBody[end + 1] as boolean) === body) end++;
    const length = end - line + 1;
    const startLine = line + 1;
    const endLine = end + 1;

    if (body && length >= config.minBlockLines) {
      segments.push({
        kind: 'omitted',
        reason: `${length} lines of collapsed body`,
        startLine,
        endLine,
      });
      omittedLines += length;
    } else {
      pushKept(segments, startLine, endLine);
    }
    line = end + 1;
  }

  if (omittedLines < config.minOmitted) return null;

  return {
    segments,
    keptLines: total - omittedLines,
    omittedLines,
    language,
  };
}

/** Append a kept range, merging it with a preceding kept segment. */
function pushKept(segments: Segment[], startLine: number, endLine: number): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === 'kept' && last.endLine === startLine - 1) {
    last.endLine = endLine;
    return;
  }
  segments.push({ kind: 'kept', startLine, endLine });
}
