// Seeded, offline proof table.
//
// Unlike scripts/benchmark.mjs — which shells out to the live demo workspace
// (npm/npx, real timings) — this runs entirely offline against deterministic,
// seeded synthetic payloads, so anyone passing the same --seed gets the exact
// same numbers. It is the lossless analogue of Headroom's
// `benchmarks/index_proof_table.py --seed …`.
//
// Every scenario re-expands its markers and verifies them against the stored
// artifact byte for byte (inside runProofTable), so a good ratio can never be
// bought with lost information.
//
// Usage:
//   node scripts/proof-table.mjs [--seed N] [--markdown] [--out path]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PROOF_SEED, runProofTable } from '../packages/core/dist/index.js';
import { formatBenchmarkTable, percent } from './benchmarkReport.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const seedIndex = args.indexOf('--seed');
const seed = seedIndex >= 0 ? Number.parseInt(args[seedIndex + 1], 10) : DEFAULT_PROOF_SEED;
if (!Number.isFinite(seed)) {
  console.error(`Invalid --seed value: ${args[seedIndex + 1]}`);
  process.exit(1);
}

const markdown = args.includes('--markdown');
const outIndex = args.indexOf('--out');
const markdownPath = path.resolve(
  repoRoot,
  outIndex >= 0 ? args[outIndex + 1] : 'test-results/slipstream-proof-table.md',
);

const { rows, summary } = runProofTable({ seed });

const totalBefore = rows.reduce((acc, row) => acc + row.before, 0);
const totalAfter = rows.reduce((acc, row) => acc + row.after, 0);
const totalSaved = totalBefore - totalAfter;

if (args.includes('--dashboard-reference')) {
  const reference = {
    kind: 'synthetic',
    seed,
    profile: 'balanced',
    scenarios: rows.length,
    tokensBefore: totalBefore,
    tokensAfter: totalAfter,
    tokensSaved: totalSaved,
    percentSaved: totalBefore === 0 ? 0 : (totalSaved / totalBefore) * 100,
    retrievalRate: null,
    totalOverheadMs: null,
  };
  const target = path.join(repoRoot, 'packages/core/src/benchmarkReference.ts');
  fs.writeFileSync(target, `export const BENCHMARK_REFERENCE = ${JSON.stringify(reference, null, 2)} as const;\n`, 'utf8');
  console.log(`Dashboard reference written to ${path.relative(repoRoot, target)}`);
}

console.log(`Slipstream proof table (seed ${seed})`);
console.log(formatBenchmarkTable(rows));
console.log('');
console.log(
  `Total: ${totalSaved.toLocaleString()} tokens saved (${percent(totalSaved, totalBefore)}%) across ` +
    `${rows.length} scenarios, about $${summary.estimatedCostSavedUsd.toFixed(4)} saved.`,
);
console.log('Every omitted marker verified recoverable byte for byte.');
console.log('Seeded and offline: the same --seed reproduces these numbers exactly.');

if (markdown) {
  const lines = [
    '# Slipstream Proof Table',
    '',
    `Seed: \`${seed}\` — seeded and offline, so \`node scripts/proof-table.mjs --seed ${seed}\` reproduces these numbers exactly.`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Tokens in | ${totalBefore.toLocaleString()} |`,
    `| Forwarded | ${totalAfter.toLocaleString()} |`,
    `| Saved | ${totalSaved.toLocaleString()} |`,
    `| Percent saved | ${percent(totalSaved, totalBefore)}% |`,
    `| Estimated cost saved | $${summary.estimatedCostSavedUsd.toFixed(4)} |`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Tokens in | Forwarded | Saved | Detail |',
    '|---|---:|---:|---:|---|',
    ...rows.map(
      (row) =>
        `| ${row.scenario} | ${row.before.toLocaleString()} | ${row.after.toLocaleString()} | ` +
        `${percent(row.saved, row.before)}% | ${row.detail} |`,
    ),
    '',
    '## Integrity check',
    '',
    'Every omitted marker was expanded during the run and verified against the stored raw artifact byte for byte.',
    '',
  ];
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, lines.join('\n'), 'utf8');
  console.log(`Proof-table snapshot written to ${path.relative(repoRoot, markdownPath)}`);
}
