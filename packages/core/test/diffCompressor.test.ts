import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DIFF_CONFIG,
  planDiffCompression,
  type DiffPlan,
} from '../src/compressors/diffCompressor.js';
import type { Segment } from '../src/types.js';

/** Segments must tile every line with no gaps or overlaps. */
function expectContiguous(plan: DiffPlan, total: number): void {
  expect(plan.segments[0]?.startLine).toBe(1);
  expect(plan.segments[plan.segments.length - 1]?.endLine).toBe(total);
  for (let i = 1; i < plan.segments.length; i++) {
    expect(plan.segments[i]!.startLine).toBe(plan.segments[i - 1]!.endLine + 1);
  }
}

/** Lines covered by kept segments (1-based), for asserting what survives. */
function keptLineNumbers(plan: DiffPlan): Set<number> {
  const kept = new Set<number>();
  for (const s of plan.segments) {
    if (s.kind === 'kept') {
      for (let l = s.startLine; l <= s.endLine; l++) kept.add(l);
    }
  }
  return kept;
}

/** A git diff of one file with a wide unchanged block between two edits. */
function wideContextDiff(): string[] {
  const lines: string[] = [
    'diff --git a/app.ts b/app.ts',
    'index 1111111..2222222 100644',
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -1,40 +1,40 @@',
    '-const a = 1;',
    '+const a = 2;',
  ];
  for (let i = 0; i < 30; i++) lines.push(` unchanged line ${i}`);
  lines.push('-const z = 9;');
  lines.push('+const z = 8;');
  return lines;
}

describe('planDiffCompression', () => {
  it('returns null when there is no hunk header', () => {
    expect(planDiffCompression(['just some text', 'no diff here'])).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(planDiffCompression([])).toBeNull();
  });

  it('returns null when there is too little context to omit', () => {
    const lines = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
    ];
    expect(planDiffCompression(lines)).toBeNull();
  });

  it('collapses a wide unchanged context block but keeps every change and header', () => {
    const lines = wideContextDiff();
    const plan = planDiffCompression(lines);
    expect(plan).not.toBeNull();
    const kept = keptLineNumbers(plan!);

    // Headers (1-5) are always kept.
    for (const h of [1, 2, 3, 4, 5]) expect(kept.has(h)).toBe(true);
    // Both changes are kept (lines 6,7 and the two trailing change lines).
    expect(kept.has(6)).toBe(true);
    expect(kept.has(7)).toBe(true);
    expect(kept.has(lines.length - 1)).toBe(true); // -const z
    expect(kept.has(lines.length)).toBe(true); // +const z

    // Something in the middle of the unchanged block is omitted.
    expect(plan!.segments.some((s) => s.kind === 'omitted')).toBe(true);
    expect(plan!.omittedLines).toBeGreaterThanOrEqual(DEFAULT_DIFF_CONFIG.minOmitted);
  });

  it('keeps contextLines of unchanged lines around each change', () => {
    const lines = wideContextDiff();
    const plan = planDiffCompression(lines, { contextLines: 3 });
    const kept = keptLineNumbers(plan!);
    // The change at line 7 (+const a) keeps the 3 following context lines (8,9,10).
    for (const l of [8, 9, 10]) expect(kept.has(l)).toBe(true);
    // A line well beyond the window is omitted.
    expect(kept.has(20)).toBe(false);
  });

  it('produces contiguous segments over all lines', () => {
    const lines = wideContextDiff();
    const plan = planDiffCompression(lines)!;
    expectContiguous(plan, lines.length);
  });

  it('never omits a + or - change line', () => {
    const lines = wideContextDiff();
    const plan = planDiffCompression(lines)!;
    const kept = keptLineNumbers(plan);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const isChange =
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'));
      if (isChange) expect(kept.has(i + 1)).toBe(true);
    }
  });

  it('reports git format and file count', () => {
    const plan = planDiffCompression(wideContextDiff())!;
    expect(plan.format).toBe('git');
    expect(plan.files).toBe(1);
  });

  it('classifies a plain unified diff (no git headers) as unified', () => {
    const lines: string[] = ['--- a/x', '+++ b/x', '@@ -1,40 +1,40 @@', '-old', '+new'];
    for (let i = 0; i < 30; i++) lines.push(` ctx ${i}`);
    lines.push('-tail-old');
    lines.push('+tail-new');
    const plan = planDiffCompression(lines);
    expect(plan).not.toBeNull();
    expect(plan!.format).toBe('unified');
  });

  it('keeps unchanged runs shorter than minRunToOmit', () => {
    const lines = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,60 +1,60 @@',
      '-a',
      '+A',
    ];
    for (let i = 0; i < 40; i++) lines.push(` far ${i}`);
    lines.push('-b');
    lines.push('+B');
    // With an unreachable minRunToOmit no run is collapsed, so nothing is
    // omitted and the planner declines (null → passthrough).
    expect(planDiffCompression(lines, { minRunToOmit: 100 })).toBeNull();
  });
});
