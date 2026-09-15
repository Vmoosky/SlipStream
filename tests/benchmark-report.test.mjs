import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { formatBenchmarkMarkdown, formatBenchmarkTable, percent } from '../scripts/benchmarkReport.mjs';

const rows = [
  { scenario: 'vitest run | failures', before: 1000, after: 400, saved: 600, detail: '20 -> 8 lines' },
  { scenario: 'read again', before: 200, after: 20, saved: 180, detail: 'read-lifecycle:unchanged' },
];

test('formats benchmark percentages consistently', () => {
  assert.equal(percent(600, 1000), '60.0');
  assert.equal(percent(0, 0), '0.0');
});

test('benchmarks recommendation rules without model requests or the compression demo', () => {
  const execution = spawnSync(process.execPath, ['scripts/benchmark.mjs', '--model-recommendations'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const report = JSON.parse(execution.stdout);
  assert.equal(report.benchmark, 'model-recommendation-local-rules');
  assert.equal(report.targetP95Ms, 5);
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 3);
  assert.equal(report.results[0].candidates, 64);
  assert.ok(report.results.every((result) => result.samples === 2000 && result.p95Ms <= 5));
  assert.ok(report.excludes.includes('host discovery'));
  assert.ok(report.excludes.includes('model requests'));
});

test('formats console benchmark table with totals', () => {
  const table = formatBenchmarkTable(rows);

  assert.match(table, /Scenario/);
  assert.match(table, /TOTAL/);
  assert.match(table, /65\.0%/);
});

test('formats shareable benchmark Markdown safely', () => {
  const markdown = formatBenchmarkMarkdown(
    rows,
    { compressions: 2, retrievals: 1, estimatedCostSavedUsd: 0.0036 },
    new Date('2026-09-03T00:00:00.000Z'),
  );

  assert.match(markdown, /^# Slipstream Benchmark Snapshot/);
  assert.match(markdown, /Generated: 2026-09-03T00:00:00\.000Z/);
  assert.match(markdown, /vitest run \\\| failures/);
  assert.match(markdown, /Every omitted marker was expanded/);
});

test('preserves literal backslashes in Markdown scenario and detail cells', () => {
  const cases = [
    ['left|right', String.raw`left\|right`],
    [String.raw`left\|right`, String.raw`left\\\|right`],
    [String.raw`left\\|right`, String.raw`left\\\\\|right`],
    [String.raw`left\\\|right`, String.raw`left\\\\\\\|right`],
    ['C:\\workspace\\test\\', 'C:\\\\workspace\\\\test\\\\'],
    ['first\r\nsecond\nthird', 'first second third'],
  ];
  const markdown = formatBenchmarkMarkdown(
    cases.map(([value]) => ({ scenario: value, before: 10, after: 5, saved: 5, detail: value })),
    { compressions: cases.length, retrievals: 0, estimatedCostSavedUsd: 0 },
    new Date('2026-09-15T00:00:00.000Z'),
  );
  for (const [, escaped] of cases) {
    assert.ok(markdown.includes(`| ${escaped} | 10 | 5 | 50.0% | ${escaped} |`));
  }
});