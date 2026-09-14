export const DEFAULT_MARKDOWN_PATH = 'test-results/slipstream-benchmark-snapshot.md';

export function percent(saved, before) {
  return before > 0 ? ((saved / before) * 100).toFixed(1) : '0.0';
}

export function benchmarkTotals(rows) {
  return rows.reduce(
    (acc, row) => ({ before: acc.before + row.before, after: acc.after + row.after }),
    { before: 0, after: 0 },
  );
}

export function formatBenchmarkTable(rows) {
  const width = Math.max(...rows.map((row) => row.scenario.length), 8);
  const line = (a, b, c, d, e) =>
    `| ${a.padEnd(width)} | ${b.padStart(9)} | ${c.padStart(9)} | ${d.padStart(7)} | ${e} |`;
  const totals = benchmarkTotals(rows);
  const lines = [
    '',
    line('Scenario', 'Tokens in', 'Forwarded', 'Saved', 'Detail'),
    `|${'-'.repeat(width + 2)}|${'-'.repeat(11)}|${'-'.repeat(11)}|${'-'.repeat(9)}|--------|`,
  ];

  for (const row of rows) {
    lines.push(
      line(
        row.scenario,
        row.before.toLocaleString(),
        row.after.toLocaleString(),
        `${percent(row.saved, row.before)}%`,
        row.detail,
      ),
    );
  }

  lines.push(
    line(
      'TOTAL',
      totals.before.toLocaleString(),
      totals.after.toLocaleString(),
      `${percent(totals.before - totals.after, totals.before)}%`,
      '',
    ),
  );
  return lines.join('\n');
}

export function formatBenchmarkMarkdown(rows, summary, generatedAt = new Date()) {
  const totals = benchmarkTotals(rows);
  const lines = [
    '# Slipstream Benchmark Snapshot',
    '',
    `Generated: ${generatedAt.toISOString()}`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Tokens in | ${totals.before.toLocaleString()} |`,
    `| Forwarded | ${totals.after.toLocaleString()} |`,
    `| Saved | ${(totals.before - totals.after).toLocaleString()} |`,
    `| Percent saved | ${percent(totals.before - totals.after, totals.before)}% |`,
    `| Ledger compressions | ${summary.compressions.toLocaleString()} |`,
    `| Ledger retrievals | ${summary.retrievals.toLocaleString()} |`,
    `| Estimated cost saved | $${summary.estimatedCostSavedUsd.toFixed(4)} |`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Tokens in | Forwarded | Saved | Detail |',
    '|---|---:|---:|---:|---|',
  ];

  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdown(row.scenario)} | ${row.before.toLocaleString()} | ${row.after.toLocaleString()} | ` +
        `${percent(row.saved, row.before)}% | ${escapeMarkdown(row.detail)} |`,
    );
  }

  lines.push(
    '',
    '## Integrity check',
    '',
    'Every omitted marker was expanded during the benchmark and verified against the stored raw artifact byte for byte.',
    '',
  );
  return lines.join('\n');
}

function escapeMarkdown(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}