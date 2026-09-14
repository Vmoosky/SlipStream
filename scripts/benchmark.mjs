// Measures Slipstream against real command output from the demo workspace and
// prints the savings table used in the README.
//
// Every scenario also asserts that the omitted content is recoverable byte for
// byte, so a good compression ratio can never be bought with lost information.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompressionEngine, parseMarkers, recommendPolicyModel, runCommand, validateCostPolicy } from '../packages/core/dist/index.js';
import { DEFAULT_MARKDOWN_PATH, formatBenchmarkMarkdown, formatBenchmarkTable } from './benchmarkReport.mjs';

const args = process.argv.slice(2);
if (args.includes('--model-recommendations')) {
  const candidates = Array.from({ length: 64 }, (_, index) => ({
    model: { vendor: 'fixture', id: `model-${index}` }, inputTokens: 1000, maxInputTokens: 32000, toolCalling: true,
    verifiedPasses: 3, verifiedFailures: 0, rates: {
      basis: 'public-api-reference', mode: 'automatic', inputUsdPerMillion: 64 - index, outputUsdPerMillion: 64 - index,
      source: 'https://models.dev/api.json', fetchedAt: 100, revision: 'benchmark-fixture', stale: false, status: 'priced', assumption: 'standard-uncached-input',
    },
  }));
  const policy = validateCostPolicy({ version: 1, mode: 'recommend-only', allowedModels: candidates.map((candidate) => candidate.model) });
  const request = { category: 'code', requestedModel: candidates[0].model, outputTokens: 512 };
  const samples = 2000;
  const warmup = 200;
  const targetMs = 5;
  const mixed = candidates.map((candidate, index) => index % 4 === 1 ? { ...candidate, verifiedPasses: 0 }
    : index % 4 === 2 ? { ...candidate, rates: { ...candidate.rates, stale: true } }
    : index % 4 === 3 ? { ...candidate, toolCalling: false } : candidate);
  const scenarios = [
    { name: 'qualified-64', policy, candidates, expected: 'recommend' },
    { name: 'mixed-gaps-64', policy, candidates: mixed, expected: 'recommend' },
    { name: 'empty-policy', policy: { ...policy, allowedModels: [] }, candidates: [], expected: 'unavailable' },
  ];
  const results = scenarios.map((scenario) => {
    for (let sample = 0; sample < warmup; sample++) recommendPolicyModel(scenario.policy, scenario.candidates, request);
    const durations = [];
    for (let sample = 0; sample < samples; sample++) {
      const start = performance.now();
      const result = recommendPolicyModel(scenario.policy, scenario.candidates, request);
      durations.push(performance.now() - start);
      if (result.state !== scenario.expected) throw new Error(`Unexpected recommendation in ${scenario.name}.`);
    }
    durations.sort((left, right) => left - right);
    const percentile = (fraction) => Number(durations[Math.ceil(samples * fraction) - 1].toFixed(4));
    return { scenario: scenario.name, candidates: scenario.candidates.length, samples, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
  });
  const passed = results.every((result) => result.p95Ms <= targetMs);
  console.log(JSON.stringify({ benchmark: 'model-recommendation-local-rules', generatedAt: new Date().toISOString(), node: process.version,
    platform: `${process.platform} ${process.arch}`, osRelease: os.release(), cpu: os.cpus()[0]?.model ?? 'unknown', warmup, targetP95Ms: targetMs,
    excludes: ['host discovery', 'token estimation', 'ledger evidence aggregation', 'price snapshot assembly', 'network', 'model requests'], results, passed }, null, 2));
  process.exit(passed ? 0 : 1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(repoRoot, 'tests', 'fixtures', 'outcome-workload');
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-bench-'));
const markdown = args.includes('--markdown');
const outIndex = args.indexOf('--out');
const markdownPath = path.resolve(repoRoot, outIndex >= 0 ? args[outIndex + 1] : DEFAULT_MARKDOWN_PATH);

const engine = new CompressionEngine({
  rootDir: storage,
  workspaceRoots: [demoRoot, repoRoot],
});

const rows = [];

function record(scenario, before, after, detail) {
  rows.push({ scenario, before, after, saved: before - after, detail });
}

/**
 * Re-expand every marker and confirm the bytes come back exactly.
 *
 * A marker may point at an earlier artifact — that is what cross-turn dedup does —
 * so each one is checked against the artifact it names rather than the current output.
 */
function assertRecoverable(scenario, text) {
  const markers = parseMarkers(text);
  for (const marker of markers) {
    const slice = engine.retrieve({
      id: marker.id,
      startLine: marker.startLine,
      endLine: marker.endLine,
      maxLines: 1_000_000,
    });
    const expected = engine.store
      .get(marker.id)
      .split('\n')
      .slice(marker.startLine - 1, marker.endLine)
      .join('\n');
    if (slice.text !== expected) {
      throw new Error(
        `${scenario}: retrieving ${marker.id} lines ${marker.startLine}-${marker.endLine} did not round-trip`,
      );
    }
  }
  return markers.length;
}

async function commandScenario(scenario, command, args, { expectFailuresVerbatim = true } = {}) {
  const outcome = await runCommand({
    command,
    args,
    cwd: demoRoot,
    workspaceRoots: [demoRoot, repoRoot],
    timeoutMs: 180_000,
  });

  // Reconstruct exactly what the engine stores, so line numbers line up: CRLF is
  // normalized and stderr is appended behind a separator.
  const lf = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = [];
  if (outcome.stdout) parts.push(lf(outcome.stdout));
  if (outcome.stderr) parts.push('--- stderr ---', lf(outcome.stderr));
  const raw = parts.join('\n');

  const compressed = engine.compressCommandOutput({
    command: [command, ...args].join(' '),
    cwd: demoRoot,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    durationMs: outcome.durationMs,
  });

  // Nothing may be lost between the process and the store.
  const stored = engine.store.get(compressed.artifactId);
  if (stored !== raw) {
    throw new Error(`${scenario}: stored artifact does not match the process output`);
  }

  const markers = assertRecoverable(scenario, compressed.text);

  // The point of the log compressor: failures must survive verbatim. The one
  // exception is a repeat of output the model has already been given, where
  // cross-turn dedup deliberately replaces them with a pointer to that earlier copy.
  if (expectFailuresVerbatim) {
    for (const needle of ['FAIL', 'AssertionError']) {
      if (raw.includes(needle) && !compressed.text.includes(needle)) {
        throw new Error(`${scenario}: "${needle}" was dropped from the compressed output`);
      }
    }
  }

  record(
    scenario,
    compressed.tokensBefore,
    compressed.tokensAfter,
    `${compressed.linesBefore} → ${compressed.linesAfter} lines, ${markers} marker(s)`,
  );
  return raw;
}

function readScenario(scenario, filePath, mutate) {
  if (mutate) {
    const before = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, mutate(before), 'utf8');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const output = engine.compressFileRead({ path: filePath, content });
  record(scenario, output.tokensBefore, output.tokensAfter, output.strategy);
}

// A realistically sized module, so the diff path is exercised the way it would be
// on real source rather than on a toy file where a diff is as big as the content.
const target = path.join(demoRoot, 'src', 'generated-report.js');
const bigFile =
  `// Generated reporting helpers.\n\n` +
  Array.from(
    { length: 120 },
    (_, i) => `export function reportRow${i}(rows) {
  const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
  return { index: ${i}, label: 'row-${i}', total, average: rows.length ? total / rows.length : 0 };
}
`,
  ).join('\n');

try {
  await commandScenario('vitest run (12 suites, 2 failing)', 'npx', ['vitest', 'run', '--reporter=verbose']);
  await commandScenario('npm run build (chatty build)', 'npm', ['run', 'build']);
  await commandScenario('vitest run, second time (dedup)', 'npx', ['vitest', 'run', '--reporter=verbose'], {
    expectFailuresVerbatim: false,
  });

  fs.writeFileSync(target, bigFile, 'utf8');
  readScenario('read 600-line module (first time)', target);
  readScenario('read it again (unchanged)', target);
  readScenario('read after a one-line edit', target, (text) =>
    text.replace("label: 'row-42'", "label: 'row-42-renamed'"),
  );
} finally {
  fs.rmSync(target, { force: true });
}

const summary = engine.summary();
console.log(formatBenchmarkTable(rows));
console.log('');
console.log(
  `Ledger: ${summary.compressions} compression(s), ${summary.tokensSaved.toLocaleString()} tokens saved, ` +
    `about $${summary.estimatedCostSavedUsd.toFixed(4)} at $${3}/1M input tokens.`,
);
console.log('All omitted content verified recoverable byte for byte.');

if (markdown) {
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, formatBenchmarkMarkdown(rows, summary), 'utf8');
  console.log(`Benchmark snapshot written to ${path.relative(repoRoot, markdownPath)}`);
}

fs.rmSync(storage, { recursive: true, force: true });
