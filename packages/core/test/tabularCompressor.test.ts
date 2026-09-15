import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TABULAR_CONFIG,
  looksLikeTabular,
  planTabularCompression,
  type TabularPlan,
} from '../src/compressors/tabularCompressor.js';

function expectContiguous(plan: TabularPlan, total: number): void {
  expect(plan.segments[0]?.startLine).toBe(1);
  expect(plan.segments[plan.segments.length - 1]?.endLine).toBe(total);
  for (let i = 1; i < plan.segments.length; i++) {
    expect(plan.segments[i]!.startLine).toBe(plan.segments[i - 1]!.endLine + 1);
  }
}

function keptLineNumbers(plan: TabularPlan): Set<number> {
  const kept = new Set<number>();
  for (const s of plan.segments) {
    if (s.kind === 'kept') {
      for (let l = s.startLine; l <= s.endLine; l++) kept.add(l);
    }
  }
  return kept;
}

function markdownTable(rows: number): string[] {
  const lines = ['| id | name | status |', '| --- | --- | --- |'];
  for (let i = 1; i <= rows; i++) lines.push(`| ${i} | item-${i} | ok |`);
  return lines;
}

function csvTable(rows: number): string[] {
  const lines = ['id,name,status'];
  for (let i = 1; i <= rows; i++) lines.push(`${i},item-${i},ok`);
  return lines;
}

describe('looksLikeTabular', () => {
  it('is false for prose', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `A sentence, with a comma, number ${i}.`);
    // Prose has inconsistent field counts, so it is not read as a table.
    expect(looksLikeTabular(lines)).toBe(false);
  });

  it('is true for a markdown table', () => {
    expect(looksLikeTabular(markdownTable(30))).toBe(true);
  });

  it.each([
    '---',
    '| --- |',
    '--- | :---: | ---:',
    '\t|\t:---- \t| :---: |\t---:| \t',
    '\u00a0| :--- | ---: | :---: |\u00a0',
  ])('accepts a markdown alignment separator: %s', (separator) => {
    const lines = markdownTable(30);
    lines[1] = separator;
    expect(looksLikeTabular(lines)).toBe(true);
    expect(planTabularCompression(lines)?.format).toBe('markdown');
  });

  it.each([
    '--',
    '| -- |',
    '|| --- |',
    '| --- || --- |',
    '| :- -: |',
    '| :---:: |',
    '| --- | !',
    '| --- |\u200b',
    '| --- ||',
  ])('rejects a malformed markdown alignment separator: %s', (separator) => {
    const lines = markdownTable(30);
    lines[1] = separator;
    expect(looksLikeTabular(lines)).toBe(false);
    expect(planTabularCompression(lines)).toBeNull();
  });

  it.each(['', '|', '| --- |'])('bounds whitespace before a failing cell after %s', (prefix) => {
    const lines = markdownTable(30);
    lines[1] = prefix + ' '.repeat(200_000) + '!';
    expect(runInNewContext('looksLikeTabular(lines)', { looksLikeTabular, lines }, {
      timeout: 1000,
    })).toBe(false);
    expect(runInNewContext('planTabularCompression(lines)', { planTabularCompression, lines }, {
      timeout: 1000,
    })).toBeNull();
  });

  it('is true for a CSV block', () => {
    expect(looksLikeTabular(csvTable(30))).toBe(true);
  });

  it('is true for a TSV block', () => {
    const lines = ['id\tname\tstatus'];
    for (let i = 1; i <= 30; i++) lines.push(`${i}\titem-${i}\tok`);
    expect(looksLikeTabular(lines)).toBe(true);
  });

  it('is false below the row floor', () => {
    expect(looksLikeTabular(markdownTable(5))).toBe(false);
  });
});

describe('planTabularCompression', () => {
  it('returns null for non-tabular input', () => {
    expect(planTabularCompression(['just', 'some', 'lines'])).toBeNull();
  });

  it('returns null below the row floor', () => {
    expect(planTabularCompression(markdownTable(5))).toBeNull();
  });

  it('keeps the markdown header and separator and collapses the bulk', () => {
    const lines = markdownTable(40);
    const plan = planTabularCompression(lines);
    expect(plan).not.toBeNull();
    const kept = keptLineNumbers(plan!);
    // Header (line 1) and separator (line 2) always survive.
    expect(kept.has(1)).toBe(true);
    expect(kept.has(2)).toBe(true);
    // headRows=3, tailRows=2 (data rows start at line 3).
    expect(kept.has(3)).toBe(true);
    expect(kept.has(lines.length)).toBe(true);
    // Something in the middle is omitted.
    expect(kept.has(20)).toBe(false);
    expect(plan!.format).toBe('markdown');
    expect(plan!.rows).toBe(40);
    expect(plan!.omittedLines).toBeGreaterThanOrEqual(DEFAULT_TABULAR_CONFIG.minOmitted);
  });

  it('keeps the CSV header row', () => {
    const plan = planTabularCompression(csvTable(40))!;
    const kept = keptLineNumbers(plan);
    expect(kept.has(1)).toBe(true); // header
    expect(plan.format).toBe('csv');
  });

  it('keeps a row with an unusual column count (shape outlier)', () => {
    const lines = markdownTable(40);
    // Give row at line 20 an extra column.
    lines[19] = '| 18 | item-18 | ok | EXTRA |';
    const plan = planTabularCompression(lines)!;
    const kept = keptLineNumbers(plan);
    expect(kept.has(20)).toBe(true);
  });

  it('keeps a size-outlier row', () => {
    const lines = markdownTable(40);
    lines[19] = `| 18 | ${'x'.repeat(400)} | ok |`;
    const plan = planTabularCompression(lines)!;
    const kept = keptLineNumbers(plan);
    expect(kept.has(20)).toBe(true);
  });

  it('produces contiguous segments over all lines', () => {
    const lines = markdownTable(40);
    const plan = planTabularCompression(lines)!;
    expectContiguous(plan, lines.length);
  });

  it('describes omitted rows in the reason', () => {
    const plan = planTabularCompression(markdownTable(40))!;
    const omitted = plan.segments.find((s) => s.kind === 'omitted');
    expect(omitted && omitted.kind === 'omitted' && omitted.reason).toMatch(/similar row/);
  });
});
