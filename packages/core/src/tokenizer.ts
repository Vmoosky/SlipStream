import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

/**
 * Canonical token counter for the whole project.
 *
 * The MCP server has no access to the VS Code API, so both front-ends must use
 * the same counter or the ledger totals will disagree. o200k_base is the
 * encoding used by current GPT-4o/5-class models.
 */

/** Above this length we sample rather than tokenize the whole payload. */
const EXACT_LIMIT_CHARS = 400_000;
const SAMPLE_CHARS = 100_000;

export function countTextTokens(text: string): number {
  if (!text) {
    return 0;
  }
  try {
    if (text.length <= EXACT_LIMIT_CHARS) {
      return countTokens(text);
    }
    // Sample from the head, middle and tail, then scale.
    const third = Math.floor(SAMPLE_CHARS / 3);
    const mid = Math.floor(text.length / 2);
    const sample =
      text.slice(0, third) +
      text.slice(mid, mid + third) +
      text.slice(text.length - third);
    const sampled = countTokens(sample);
    return Math.round((sampled / sample.length) * text.length);
  } catch {
    // Never let token counting break a tool call.
    return Math.ceil(text.length / 4);
  }
}

/** Rough USD cost of a token count at a given per-million input rate. */
export function estimateCostUsd(tokens: number, usdPerMillionTokens: number): number {
  return (tokens / 1_000_000) * usdPerMillionTokens;
}
