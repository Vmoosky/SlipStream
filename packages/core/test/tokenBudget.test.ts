import { describe, it, expect } from 'vitest';
import {
  refineSegmentsByTokens,
  DEFAULT_TOKEN_BUDGET_CONFIG,
} from '../src/compressors/tokenBudget.js';
import type { Segment } from '../src/types.js';

/** Deterministic stub: one token per whitespace-separated word. */
const wordTokens = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const CONFIG = { markerTokenCost: 10, minNetTokenGain: 2 };

function lines(n: number, wordsPerLine: number, word = 'x'): string[] {
  return Array.from({ length: n }, () => Array(wordsPerLine).fill(word).join(' '));
}

describe('refineSegmentsByTokens', () => {
  it('reverts a cheap omitted run whose tokens are below the marker cost', () => {
    // 4 lines x 1 word = 4 tokens omitted, marker costs 10 -> net loss, revert.
    const body = lines(4, 1);
    const segments: Segment[] = [
      { kind: 'omitted', startLine: 1, endLine: 4, reason: 'low-severity output' },
    ];
    const refined = refineSegmentsByTokens(segments, body, wordTokens, CONFIG);
    expect(refined).toEqual([{ kind: 'kept', startLine: 1, endLine: 4 }]);
  });

  it('keeps a token-heavy omitted run omitted', () => {
    // 4 lines x 20 words = 80 tokens omitted, well above the marker cost.
    const body = lines(4, 20);
    const segments: Segment[] = [
      { kind: 'omitted', startLine: 1, endLine: 4, reason: 'low-severity output' },
    ];
    const refined = refineSegmentsByTokens(segments, body, wordTokens, CONFIG);
    expect(refined).toEqual(segments);
  });

  it('merges kept neighbours created when a cheap omission is reverted', () => {
    // kept(1-2) + cheap omitted(3-5) + kept(6-7): the omission reverts and the
    // three kept runs coalesce into one span covering every line.
    const body = lines(7, 1);
    const segments: Segment[] = [
      { kind: 'kept', startLine: 1, endLine: 2 },
      { kind: 'omitted', startLine: 3, endLine: 5, reason: 'low-severity output' },
      { kind: 'kept', startLine: 6, endLine: 7 },
    ];
    const refined = refineSegmentsByTokens(segments, body, wordTokens, CONFIG);
    expect(refined).toEqual([{ kind: 'kept', startLine: 1, endLine: 7 }]);
  });

  it('preserves a worthwhile omission sitting between kept runs', () => {
    const body = [...lines(2, 1), ...lines(4, 20), ...lines(2, 1)];
    const segments: Segment[] = [
      { kind: 'kept', startLine: 1, endLine: 2 },
      { kind: 'omitted', startLine: 3, endLine: 6, reason: 'low-severity output' },
      { kind: 'kept', startLine: 7, endLine: 8 },
    ];
    const refined = refineSegmentsByTokens(segments, body, wordTokens, CONFIG);
    expect(refined).toEqual(segments);
  });

  it('is a no-op when there are no omitted segments', () => {
    const body = lines(5, 3);
    const segments: Segment[] = [{ kind: 'kept', startLine: 1, endLine: 5 }];
    expect(refineSegmentsByTokens(segments, body, wordTokens, CONFIG)).toEqual(segments);
  });

  it('returns an empty plan unchanged', () => {
    expect(refineSegmentsByTokens([], [], wordTokens, CONFIG)).toEqual([]);
  });

  it('every refined segment still tiles the input contiguously', () => {
    const body = lines(10, 1);
    const segments: Segment[] = [
      { kind: 'kept', startLine: 1, endLine: 1 },
      { kind: 'omitted', startLine: 2, endLine: 5, reason: 'low-severity output' },
      { kind: 'kept', startLine: 6, endLine: 6 },
      { kind: 'omitted', startLine: 7, endLine: 10, reason: 'low-severity output' },
    ];
    const refined = refineSegmentsByTokens(segments, body, wordTokens, CONFIG);
    let cursor = 1;
    for (const seg of refined) {
      expect(seg.startLine).toBe(cursor);
      cursor = seg.endLine + 1;
    }
    expect(cursor - 1).toBe(body.length);
  });

  it('honours a lower marker cost by keeping smaller omissions', () => {
    const body = lines(4, 3); // 12 tokens omitted
    const segments: Segment[] = [
      { kind: 'omitted', startLine: 1, endLine: 4, reason: 'low-severity output' },
    ];
    // With the default cost (>=50) this reverts; with a tiny cost it stays omitted.
    expect(refineSegmentsByTokens(segments, body, wordTokens)).toEqual([
      { kind: 'kept', startLine: 1, endLine: 4 },
    ]);
    expect(
      refineSegmentsByTokens(segments, body, wordTokens, { markerTokenCost: 2, minNetTokenGain: 1 }),
    ).toEqual(segments);
  });

  it('exposes sensible defaults', () => {
    expect(DEFAULT_TOKEN_BUDGET_CONFIG.markerTokenCost).toBeGreaterThanOrEqual(40);
    expect(DEFAULT_TOKEN_BUDGET_CONFIG.minNetTokenGain).toBeGreaterThan(0);
  });
});
