import type { Segment } from '../types.js';

/**
 * Tokenizer-aware keep/omit refinement.
 *
 * Every compressor decides which line runs to omit by *line count* (minRunToOmit
 * / minOmitted), but savings are actually paid in *tokens*, and each omission
 * replaces its lines with a retrieval marker that itself costs ~50 tokens. A run
 * that is long in lines but cheap in tokens (short paths, blank-ish lines, tiny
 * counters) can therefore cost more to omit than to keep — the whole-output
 * not-worth-it revert in the engine only catches this at the level of the entire
 * plan, so a net-positive plan can still carry individual money-losing markers.
 *
 * This post-pass runs once over any compressor's finished segments and reverts
 * each omitted run whose token content does not clear the marker cost by a
 * margin, then coalesces the kept neighbours that reverting creates. It is purely
 * additive to fidelity — reverting an omission shows *more* verbatim content, so
 * the artifact still round-trips — and it improves every compressor at once.
 */

export interface TokenBudgetConfig {
  /** When false, the refinement pass is skipped and segments pass through. */
  enabled: boolean;
  /** Estimated tokens a retrieval marker costs (its rendered text). */
  markerTokenCost: number;
  /** An omission must save at least this many tokens beyond the marker to keep. */
  minNetTokenGain: number;
}

export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
  enabled: true,
  // A rendered marker measures ~36 tokens for a typical reason string; 40 keeps
  // a small margin for longer reasons without over-charging every omission.
  markerTokenCost: 40,
  minNetTokenGain: 8,
};

/**
 * Measured against the seeded proof-table scenarios (scripts/proof-table.mjs):
 * total savings are completely flat for any combined bar
 * (`markerTokenCost + minNetTokenGain`) up to ~104 tokens, and only start to
 * *degrade* past ~168, where genuinely worthwhile omissions get reverted.
 *
 * In other words this pass is a safety net against pathological tiny omissions,
 * not a tuning knob: every omission real compressors produce is far larger than
 * the bar. Raising `minNetTokenGain` to "compress less" does nothing until it is
 * large enough to start losing savings outright, so profile presets should not
 * rely on it to differentiate their aggressiveness.
 */

type TokenCounter = (text: string) => number;

/**
 * Revert omitted segments that do not pay for their marker in tokens and merge
 * the resulting adjacent same-kind runs. Returns a new segment list; the input
 * is not mutated.
 */
export function refineSegmentsByTokens(
  segments: readonly Segment[],
  lines: readonly string[],
  countTokens: TokenCounter,
  config: Partial<TokenBudgetConfig> = {},
): Segment[] {
  const cfg = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
  if (segments.length === 0) return [];

  const scored: Segment[] = segments.map((segment) => {
    if (segment.kind !== 'omitted') return segment;
    const omittedText = lines.slice(segment.startLine - 1, segment.endLine).join('\n');
    const netGain = countTokens(omittedText) - cfg.markerTokenCost;
    if (netGain >= cfg.minNetTokenGain) return segment;
    // Not worth a marker: keep the run inline instead.
    return { kind: 'kept', startLine: segment.startLine, endLine: segment.endLine };
  });

  return coalesce(scored);
}

/** Merge contiguous segments of the same kind (and, for omitted, same reason). */
function coalesce(segments: readonly Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const contiguous = previous && previous.endLine + 1 === segment.startLine;
    if (
      contiguous &&
      previous.kind === 'kept' &&
      segment.kind === 'kept'
    ) {
      previous.endLine = segment.endLine;
      continue;
    }
    if (
      contiguous &&
      previous.kind === 'omitted' &&
      segment.kind === 'omitted' &&
      previous.reason === segment.reason
    ) {
      previous.endLine = segment.endLine;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}
