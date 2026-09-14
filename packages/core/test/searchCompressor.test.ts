import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SEARCH_CONFIG,
  looksLikeSearchResults,
  planSearchCompression,
  type SearchPlan,
} from '../src/compressors/searchCompressor.js';

function expectContiguous(plan: SearchPlan, total: number): void {
  expect(plan.segments[0]?.startLine).toBe(1);
  expect(plan.segments[plan.segments.length - 1]?.endLine).toBe(total);
  for (let i = 1; i < plan.segments.length; i++) {
    expect(plan.segments[i]!.startLine).toBe(plan.segments[i - 1]!.endLine + 1);
  }
}

function keptLineNumbers(plan: SearchPlan): Set<number> {
  const kept = new Set<number>();
  for (const s of plan.segments) {
    if (s.kind === 'kept') {
      for (let l = s.startLine; l <= s.endLine; l++) kept.add(l);
    }
  }
  return kept;
}

/** Flat `path:line:content` grep output, one block per file. */
function grepOutput(files: Array<{ path: string; matches: number }>): string[] {
  const lines: string[] = [];
  for (const f of files) {
    for (let i = 1; i <= f.matches; i++) {
      lines.push(`${f.path}:${i}:  const value${i} = ${i};`);
    }
  }
  return lines;
}

describe('looksLikeSearchResults', () => {
  it('is false for prose', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i}.`);
    expect(looksLikeSearchResults(lines)).toBe(false);
  });

  it('is false when there are too few matches', () => {
    expect(looksLikeSearchResults(grepOutput([{ path: 'src/a.ts', matches: 5 }]))).toBe(false);
  });

  it('is true for a flat grep dump', () => {
    expect(looksLikeSearchResults(grepOutput([{ path: 'src/a.ts', matches: 30 }]))).toBe(true);
  });

  it('parses a Windows drive-letter path', () => {
    const lines = Array.from(
      { length: 25 },
      (_, i) => `C:\\repo\\src\\file.ts:${i + 1}:  match ${i}`,
    );
    expect(looksLikeSearchResults(lines)).toBe(true);
  });
});

describe('planSearchCompression', () => {
  it('returns null below the match floor', () => {
    expect(planSearchCompression(grepOutput([{ path: 'src/a.ts', matches: 5 }]))).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(planSearchCompression([])).toBeNull();
  });

  it('collapses a large file block, keeping head and tail coordinates', () => {
    const lines = grepOutput([{ path: 'src/a.ts', matches: 30 }]);
    const plan = planSearchCompression(lines);
    expect(plan).not.toBeNull();
    const kept = keptLineNumbers(plan!);

    // headPerFile=2, tailPerFile=1 kept; interior omitted.
    expect(kept.has(1)).toBe(true);
    expect(kept.has(2)).toBe(true);
    expect(kept.has(30)).toBe(true);
    expect(kept.has(15)).toBe(false);
    expect(plan!.omittedLines).toBeGreaterThanOrEqual(DEFAULT_SEARCH_CONFIG.minOmitted);
    expect(plan!.matches).toBe(30);
    expect(plan!.files).toBe(1);
  });

  it('keeps head and tail of every file group', () => {
    const lines = grepOutput([
      { path: 'src/a.ts', matches: 12 },
      { path: 'src/b.ts', matches: 12 },
      { path: 'src/c.ts', matches: 12 },
    ]);
    const plan = planSearchCompression(lines)!;
    const kept = keptLineNumbers(plan);
    // First file: lines 1,2 (head) and 12 (tail).
    expect(kept.has(1)).toBe(true);
    expect(kept.has(12)).toBe(true);
    // Second file starts at line 13: head 13,14 tail 24.
    expect(kept.has(13)).toBe(true);
    expect(kept.has(24)).toBe(true);
    // Third file starts at 25: head 25,26 tail 36.
    expect(kept.has(25)).toBe(true);
    expect(kept.has(36)).toBe(true);
    expect(plan.files).toBe(3);
  });

  it('does not collapse a short file block', () => {
    // 3 files of 8 matches each: 24 matches total (over the floor), but no single
    // block reaches head+tail+minRun (2+1+6 = 9), so nothing is omitted → null.
    const lines = grepOutput([
      { path: 'src/a.ts', matches: 8 },
      { path: 'src/b.ts', matches: 8 },
      { path: 'src/c.ts', matches: 8 },
    ]);
    expect(planSearchCompression(lines)).toBeNull();
  });

  it('keeps non-match lines (blank separators and headings)', () => {
    const lines: string[] = [];
    lines.push('Results:');
    lines.push('');
    for (let i = 1; i <= 30; i++) lines.push(`src/a.ts:${i}:  match ${i}`);
    lines.push('');
    lines.push('Done.');
    const plan = planSearchCompression(lines)!;
    const kept = keptLineNumbers(plan);
    expect(kept.has(1)).toBe(true); // heading
    expect(kept.has(2)).toBe(true); // blank
    expect(kept.has(lines.length - 1)).toBe(true); // trailing blank
    expect(kept.has(lines.length)).toBe(true); // 'Done.'
  });

  it('produces contiguous segments over all lines', () => {
    const lines = grepOutput([{ path: 'src/a.ts', matches: 30 }]);
    const plan = planSearchCompression(lines)!;
    expectContiguous(plan, lines.length);
  });

  it('names the file in the omission reason', () => {
    const lines = grepOutput([{ path: 'src/a.ts', matches: 30 }]);
    const plan = planSearchCompression(lines)!;
    const omitted = plan.segments.find((s) => s.kind === 'omitted');
    expect(omitted && omitted.kind === 'omitted' && omitted.reason).toContain('src/a.ts');
  });
});

/** Encode i as a distinct, digit-free alpha token: a, b, ... z, aa, ab, ... */
function alpha(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

describe('planSearchCompression content-distinctness gate', () => {
  it('keeps a single-file run whose matched content is highly distinct', () => {
    // A grep whose value IS the matched text (a heading/symbol list): every
    // content column is a different word, so nothing should be folded away.
    const lines = Array.from(
      { length: 30 },
      (_, i) => `docs/backlog.md:${i + 1}:### ${alpha(i)} chapter heading`,
    );
    expect(planSearchCompression(lines)).toBeNull();
  });

  it('still collapses a run of identical content (only line numbers differ)', () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `src/a.ts:${i + 1}:  WARN deprecated API call`,
    );
    const plan = planSearchCompression(lines);
    expect(plan).not.toBeNull();
    expect(plan!.omittedLines).toBeGreaterThan(0);
  });

  it('still collapses a run of templated content (same shape, different numbers)', () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `src/a.ts:${i + 1}:  retry attempt ${i} failed after ${i * 10}ms`,
    );
    const plan = planSearchCompression(lines);
    expect(plan).not.toBeNull();
    expect(plan!.omittedLines).toBeGreaterThan(0);
  });

  it('gates per file: keeps the distinct block, folds the repetitive one', () => {
    const distinct = Array.from(
      { length: 20 },
      (_, i) => `docs/a.md:${i + 1}:### ${alpha(i)} section`,
    );
    const repetitive = Array.from(
      { length: 20 },
      (_, i) => `src/b.ts:${i + 1}:  WARN deprecated API call`,
    );
    const plan = planSearchCompression([...distinct, ...repetitive])!;
    expect(plan).not.toBeNull();
    const kept = keptLineNumbers(plan);
    // Every distinct heading (lines 1..20) is kept verbatim.
    for (let l = 1; l <= 20; l++) expect(kept.has(l)).toBe(true);
    // The repetitive block's interior is folded.
    expect(kept.has(31)).toBe(false);
    const omitted = plan.segments.find((s) => s.kind === 'omitted');
    expect(omitted && omitted.kind === 'omitted' && omitted.reason).toContain('src/b.ts');
  });

  it('honours keepDistinctRatio: a high threshold disables the gate', () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `docs/backlog.md:${i + 1}:### ${alpha(i)} chapter heading`,
    );
    // With an unreachable threshold, distinct content collapses as before.
    const plan = planSearchCompression(lines, { keepDistinctRatio: 1.5 });
    expect(plan).not.toBeNull();
    expect(plan!.omittedLines).toBeGreaterThan(0);
  });
});
