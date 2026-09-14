/**
 * ANSI / terminal control-sequence stripping.
 *
 * Command and tool output frequently carries SGR colour codes, cursor moves and
 * spinner/redraw control sequences. To the model these are pure noise: they cost
 * tokens and carry no information it can act on. Removing them is a lossless-of-
 * information normalization — the decorative bytes are intentionally discarded,
 * the same way the JSON path discards insignificant whitespace before storing.
 *
 * Unlike the line-omission compressors this is not a `plan…Compression` returning
 * segments; it is a transform the engine applies to the sanitized text before
 * routing, so every downstream compressor (log, diff, search, …) sees clean
 * lines and the saving is folded into whatever strategy ultimately fires.
 */

export interface AnsiCompressorConfig {
  /** When false, output is left untouched (escape codes pass through). */
  enabled: boolean;
}

export const DEFAULT_ANSI_CONFIG: AnsiCompressorConfig = {
  enabled: true,
};

/**
 * ANSI escape-sequence matcher. Two alternatives:
 *   1. OSC sequences — `ESC ]` … up to a BEL (`\u0007`) or ST (`ESC \`), covering
 *      window-title / hyperlink sequences whose payload contains spaces.
 *   2. CSI and related sequences — `ESC [` … a final byte (colours, cursor
 *      movement, erase).
 * A literal `[31m` with no escape byte is deliberately not matched.
 */
const ANSI_PATTERN = [
  '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)',
  '[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]',
].join('|');

/** A fresh non-global instance for tests — `.test()` on a global regex is stateful. */
function detector(): RegExp {
  return new RegExp(ANSI_PATTERN);
}

/** True when the text contains at least one ANSI escape sequence. */
export function hasAnsi(text: string): boolean {
  return detector().test(text);
}

/**
 * Remove every ANSI escape sequence from the text, leaving all other bytes —
 * including newlines and non-escape content — exactly as they were.
 */
export function stripAnsi(text: string): string {
  if (text === '') return '';
  return text.replace(new RegExp(ANSI_PATTERN, 'g'), '');
}
