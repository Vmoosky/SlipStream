// HC-08 outcome proof: reproducible paired comparison of baseline, static
// compression, and policy-selected compression over one identical workload.
//
// The pairing rule is the whole point. Every arm is replayed against the *same
// captured bytes* from the same real demo project, so a difference in forwarded
// tokens is attributable to the arm and nothing else. Live agent runs cannot do
// this: two runs of the same task issue different tool calls, so they cannot
// isolate the contribution of compression.
//
// What this proves, precisely:
//   - net tokens forwarded per arm, including the cost of expanding every
//     marker the arm emitted (worst-case retrieval overhead, not a best case)
//   - that the task's ground-truth fix still passes its tests, and that every
//     omission round-trips byte-for-byte, so no task-critical information was
//     destroyed to buy a ratio
//   - added processing latency per tool call, as percentiles over repeated runs
//
// What it does NOT prove, and must not be read as proving:
//   - agent success *rate* per arm. That needs live model runs; this harness
//     holds the workload fixed on purpose.
//   - live model selection, a budget changing an owned action, or a
//     feedback-triggered profile rollback. Those are HC-05/06/07 acceptance
//     items and are reported as uncovered.
//   - financial ROI. The reference rate is a declared constant, so the cost
//     column supports a token-efficiency claim only.
//
// Nothing here touches ~/.slipstream; every arm gets a throwaway storage dir.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CompressionEngine,
  countTextTokens,
  parseMarkers,
  sanitizeUntrusted,
  stripAnsi,
  validateCostPolicy,
} from '../packages/core/dist/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKLOAD_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'outcome-workload');
const DEFAULT_OUT = 'test-results/outcome-proof.json';
const VITEST_PACKAGE = fileURLToPath(import.meta.resolve('vitest/package.json'));
const VITEST_CLI = path.resolve(path.dirname(VITEST_PACKAGE), JSON.parse(fs.readFileSync(VITEST_PACKAGE, 'utf8')).bin.vitest);
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_RUNS = 20;

/**
 * Declared reference rate. Constant on purpose: an automatic price lookup needs
 * the network and would make the export non-reproducible. Recorded in the
 * export so a reader can see exactly what the cost column is denominated in.
 */
const REFERENCE_USD_PER_MILLION = 3;

/**
 * Declared retrieval rate used for the net-benefit gate.
 *
 * Charging *every* marker's expansion (the worst case below) is break-even
 * minus marker overhead by construction: if the model expands everything it has
 * seen the raw content plus the markers. Gating on that would be gating on
 * "compression never helps", which nothing can pass. The honest gate is net
 * benefit at a realistic expansion rate, stated up front.
 */
const DECLARED_RETRIEVAL_RATE = 0.3;

/** Declared gate thresholds. Breaching any of these exits non-zero. */
const GATE = {
  /** Added processing latency per tool call, p95, in milliseconds. */
  maxAddedLatencyP95Ms: 250,
  /** Compression arms must beat baseline by at least this share of raw tokens. */
  minNetSavedRatio: 0.1,
  /** Share of emitted markers assumed to be expanded when charging overhead. */
  declaredRetrievalRate: DECLARED_RETRIEVAL_RATE,
};

/**
 * The known-correct fix for the demo's two seeded bugs. This is the task's
 * ground truth: applying it must turn a failing suite green. It is applied to a
 * scratch copy, never to the demo itself.
 */
const GROUND_TRUTH_FIX = [
  {
    file: 'src/pricing.js',
    find: '  return cents - Math.floor(cents / 100) * percent;',
    replace: '  return cents - Math.round((cents * percent) / 100);',
  },
  {
    file: 'src/shipping.js',
    find: '  const surcharge = weightGrams > 1000 ? (weightGrams - 1000) * 2 : 0;',
    replace: '  const surcharge = weightGrams > 1000 ? Math.ceil((weightGrams - 1000) / 1000) * 2 : 0;',
  },
];

/**
 * The three arms.
 *
 * `policy` does not re-run a live policy engine — in a non-owned host the policy
 * is advisory, so the honest thing to model is the profile the pressure guard
 * would select, and to label it as a simulation of that selection rather than
 * evidence of enforcement.
 */
const ARMS = [
  { id: 'baseline', label: 'Baseline (Slipstream off)', config: { enabled: false } },
  { id: 'compressed', label: 'Static compression (balanced)', config: { enabled: true, profile: 'balanced' } },
  {
    id: 'policy',
    label: 'Policy-selected profile (aggressive at 0.85 pressure)',
    config: { enabled: true, profile: 'aggressive' },
    policySimulated: true,
  },
];

export function runProofCommand(args, cwd, timeoutMs = COMMAND_TIMEOUT_MS) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > COMMAND_TIMEOUT_MS) {
    throw new Error(`Command timeout must be between 1 and ${COMMAND_TIMEOUT_MS}ms`);
  }
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    throw new Error(`Proof command did not complete: ${result.error?.code ?? result.signal ?? 'missing exit code'}`);
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status,
  };
}

function materializeWorkload(scratchRoot) {
  const target = path.join(scratchRoot, 'workload');
  fs.mkdirSync(target, { recursive: true });
  for (const entry of ['src', 'test', 'scripts', 'package.json', 'vitest.config.mjs']) {
    const from = path.join(WORKLOAD_ROOT, entry);
    fs.cpSync(from, path.join(target, entry), { recursive: true });
  }
  return target;
}

function applyGroundTruthFix(demoDir) {
  for (const patch of GROUND_TRUTH_FIX) {
    const file = path.join(demoDir, patch.file);
    const before = fs.readFileSync(file, 'utf8');
    if (!before.includes(patch.find)) {
      throw new Error(
        `Ground-truth fix no longer applies to ${patch.file}. The demo changed; update GROUND_TRUTH_FIX.`,
      );
    }
    fs.writeFileSync(file, before.replace(patch.find, patch.replace), 'utf8');
  }
}

/**
 * Capture the workload ONCE, from the real project, and hand the identical
 * bytes to every arm. Capturing per-arm would let incidental output differences
 * (timings printed by vitest, ordering) leak into the comparison.
 */
function captureWorkload(scratchRoot) {
  const broken = materializeWorkload(scratchRoot);
  const fixed = materializeWorkload(path.join(scratchRoot, 'fixed'));
  applyGroundTruthFix(fixed);

  const demoScripts = JSON.parse(fs.readFileSync(path.join(WORKLOAD_ROOT, 'package.json'), 'utf8')).scripts;
  if (demoScripts.test !== 'vitest run --reporter=verbose' || demoScripts.build !== 'node scripts/build.js') {
    throw new Error('Demo commands changed; review the proof workload before running it.');
  }
  const failing = runProofCommand([VITEST_CLI, 'run', '--reporter=verbose'], broken);
  const passing = runProofCommand([VITEST_CLI, 'run', '--reporter=verbose'], fixed);
  const build = runProofCommand([path.join(fixed, 'scripts/build.js')], fixed);

  if (failing.exitCode === 0) {
    throw new Error('The demo suite passed before the fix; the task has no failure to repair.');
  }

  const workload = [
    {
      name: 'npm test (failing suite)',
      kind: 'command',
      tool: 'npm test',
      stdout: failing.stdout,
      stderr: failing.stderr,
      exitCode: failing.exitCode,
    },
    {
      name: 'read src/pricing.js',
      kind: 'file',
      tool: 'read_file',
      filePath: path.join(fixed, 'src', 'pricing.js'),
      text: fs.readFileSync(path.join(broken, 'src', 'pricing.js'), 'utf8'),
    },
    {
      name: 'read src/shipping.js',
      kind: 'file',
      tool: 'read_file',
      filePath: path.join(fixed, 'src', 'shipping.js'),
      text: fs.readFileSync(path.join(broken, 'src', 'shipping.js'), 'utf8'),
    },
    {
      name: 'npm test (passing suite)',
      kind: 'command',
      tool: 'npm test',
      stdout: passing.stdout,
      stderr: passing.stderr,
      exitCode: passing.exitCode,
    },
    {
      name: 'npm run build',
      kind: 'command',
      tool: 'npm run build',
      stdout: build.stdout,
      stderr: build.stderr,
      exitCode: build.exitCode,
    },
  ];

  return { workload, fixedDemo: fixed, verification: passing, buildVerification: build };
}

/**
 * Expand every marker the arm emitted and confirm the bytes come back exactly.
 * Returns the token cost of that expansion, which is charged against the arm as
 * worst-case retrieval overhead.
 */
/**
 * Tokens the engine would see after normalization but before any compressor.
 *
 * The engine measures `tokensBefore` on the RAW text (see engine.ts:711-715), so
 * ANSI removal lands inside its "saved" figure. That is a real saving a user
 * banks, but it is normalization rather than compression, and it only exists
 * because the tool colourizes. Measuring the delta separately lets the report
 * attribute each part honestly instead of crediting compressors with colour
 * codes.
 *
 * The delta is computed on the body alone and subtracted from the engine's own
 * `tokensBefore`, so it stays anchored to the engine's accounting rather than
 * re-deriving the command header.
 */
function ansiTokenDelta(rawBody) {
  const safe = sanitizeUntrusted(rawBody);
  return countTextTokens(safe) - countTextTokens(stripAnsi(safe));
}

function rawBodyFor(item) {
  if (item.kind === 'command') return `${item.stdout ?? ''}${item.stderr ?? ''}`;
  return item.text ?? '';
}

function measureRetrieval(engine, text) {
  const markers = parseMarkers(text);
  let tokens = 0;
  for (const marker of markers) {
    const slice = engine.retrieve({
      id: marker.id,
      startLine: marker.startLine,
      endLine: marker.endLine,
      maxLines: 1_000_000,
    });
    const source = engine.store.get(marker.id);
    if (source === undefined) {
      throw new Error(`Artifact ${marker.id} vanished; the omission is unrecoverable.`);
    }
    const expected = source.split('\n').slice(marker.startLine - 1, marker.endLine).join('\n');
    if (slice.text !== expected) {
      throw new Error(`Marker ${marker.id} L${marker.startLine}-${marker.endLine} did not round-trip byte-exactly.`);
    }
    tokens += countTextTokens(slice.text);
  }
  return { retrievals: markers.length, tokens };
}

function runArm(arm, workload, storageRoot) {
  const rootDir = fs.mkdtempSync(path.join(storageRoot, `${arm.id}-`));
  const engine = new CompressionEngine({
    rootDir,
    workspaceRoots: [REPO_ROOT, os.tmpdir(), storageRoot],
    sessionLabel: `outcome-proof:${arm.id}`,
    config: arm.config,
  });
  try {
    const calls = [];
    for (const item of workload) {
      const started = performance.now();
      let output;
      if (item.kind === 'command') {
        output = engine.compressCommandOutput({
          command: item.tool,
          cwd: REPO_ROOT,
          exitCode: item.exitCode,
          stdout: item.stdout,
          stderr: item.stderr,
        });
      } else if (item.kind === 'file') {
        output = engine.compressFileRead({ path: item.filePath, content: item.text });
      } else {
        output = engine.compressToolResult({ toolName: item.tool, cwd: REPO_ROOT, text: item.text });
      }
      const elapsedMs = performance.now() - started;
      const retrieval = measureRetrieval(engine, output.text);
      calls.push({
        scenario: item.name,
        rawTokens: output.tokensBefore,
        // Tokens after ANSI stripping but before any compressor runs. The gap
        // raw -> normalized is colour-code removal, not compression; keeping it
        // separate stops the headline crediting compressors for it.
        normalizedTokens:
          arm.config.enabled === false
            ? output.tokensBefore
            : output.tokensBefore - ansiTokenDelta(rawBodyFor(item)),
        forwardedTokens: output.tokensAfter,
        retrievals: retrieval.retrievals,
        retrievalTokens: retrieval.tokens,
        strategy: output.strategy,
        elapsedMs,
      });
    }
    return calls;
  } finally {
    engine.dispose();
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function summarize(values) {
  if (values.length === 0) return { n: 0, mean: 0, stdDev: 0, min: 0, max: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    n: values.length,
    mean: Number(mean.toFixed(4)),
    stdDev: Number(Math.sqrt(variance).toFixed(4)),
    min: Number(Math.min(...values).toFixed(4)),
    max: Number(Math.max(...values).toFixed(4)),
  };
}

function usd(tokens) {
  return (tokens / 1_000_000) * REFERENCE_USD_PER_MILLION;
}

/**
 * Run every arm `runs` times over one captured workload.
 *
 * Token counts are expected to be identical across runs — the engine is
 * deterministic for fixed input — so the export reports their spread rather
 * than assuming it. A non-zero token stdDev means something is not reproducible
 * and the result should not be trusted.
 */
export function runOutcomeProof(options = {}) {
  const runs = options.runs ?? 5;
  if (!Number.isInteger(runs) || runs < 2 || runs > MAX_RUNS) {
    throw new Error(`--runs must be an integer between 2 and ${MAX_RUNS}`);
  }
  const scratchRoot = fs.mkdtempSync(path.join(REPO_ROOT, '.outcome-proof-'));
  const startedAt = new Date().toISOString();
  try {
    const { workload, verification, buildVerification } = captureWorkload(scratchRoot);
    const verifiedSuccess = verification.exitCode === 0 && buildVerification.exitCode === 0;

    const arms = ARMS.map((arm) => {
      const perRun = [];
      for (let index = 0; index < runs; index++) {
        perRun.push(runArm(arm, workload, scratchRoot));
      }
      const rawTokens = perRun.map((calls) => calls.reduce((sum, call) => sum + call.rawTokens, 0));
      const normalizedTokens = perRun.map((calls) => calls.reduce((sum, call) => sum + call.normalizedTokens, 0));
      const forwarded = perRun.map((calls) => calls.reduce((sum, call) => sum + call.forwardedTokens, 0));
      const retrievalTokens = perRun.map((calls) => calls.reduce((sum, call) => sum + call.retrievalTokens, 0));
      const retrievals = perRun.map((calls) => calls.reduce((sum, call) => sum + call.retrievals, 0));
      const latencies = perRun.flat().map((call) => call.elapsedMs).sort((a, b) => a - b);

      const raw = rawTokens[0];
      const norm = normalizedTokens[0];
      const fwd = forwarded[0];
      const retr = retrievalTokens[0];
      return {
        arm: arm.id,
        label: arm.label,
        policySimulated: Boolean(arm.policySimulated),
        profile: arm.config.profile ?? null,
        enabled: arm.config.enabled,
        runs,
        rawTokens: raw,
        normalizedTokens: norm,
        // Split of the total saving. ANSI removal is normalization the engine
        // performs before routing; only the second figure is the compressors'.
        ansiSavedTokens: raw - norm,
        compressionSavedTokens: norm - fwd,
        forwardedTokens: fwd,
        netSavedTokens: raw - fwd,
        netSavedPercent: raw === 0 ? 0 : Number((((raw - fwd) / raw) * 100).toFixed(2)),
        retrievals: retrievals[0],
        retrievalTokensWorstCase: retr,
        // Every marker expanded — the pessimistic bound. Near zero by
        // construction; reported as information, not used as a gate.
        netSavedTokensWorstCase: raw - (fwd + retr),
        // Net benefit once a declared share of markers is expanded.
        netSavedTokensAtDeclaredRate: Math.round(raw - (fwd + retr * DECLARED_RETRIEVAL_RATE)),
        referenceCostUsd: Number(usd(fwd).toFixed(6)),
        referenceCostSavedUsd: Number(usd(raw - fwd).toFixed(6)),
        latencyMs: {
          p50: Number(percentile(latencies, 0.5).toFixed(4)),
          p95: Number(percentile(latencies, 0.95).toFixed(4)),
          samples: latencies.length,
        },
        spread: {
          rawTokens: summarize(rawTokens),
          forwardedTokens: summarize(forwarded),
          latencyMs: summarize(latencies),
        },
        perScenario: perRun[0].map((call) => ({
          scenario: call.scenario,
          strategy: call.strategy,
          rawTokens: call.rawTokens,
          forwardedTokens: call.forwardedTokens,
          retrievals: call.retrievals,
        })),
      };
    });

    const baseline = arms.find((arm) => arm.arm === 'baseline');
    const gate = evaluateGate({ arms, baseline, verifiedSuccess });

    return {
      proof: 'hc08-outcome-paired-comparison',
      generatedAt: startedAt,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      runs,
      task: {
        name: 'slipstream-demo-shop: repair two seeded defects',
        groundTruth: GROUND_TRUTH_FIX.map((patch) => patch.file),
        verification: 'demo test and build commands exit 0 with the ground-truth fix applied',
        verifiedSuccess,
      },
      workload: workload.map((item) => ({ scenario: item.name, kind: item.kind, tool: item.tool })),
      rates: {
        basis: 'declared-constant',
        usdPerMillionTokens: REFERENCE_USD_PER_MILLION,
        note: 'Constant reference rate, not a live catalogue price. Supports a token-efficiency claim only, not measured financial ROI or a Copilot bill reduction.',
      },
      policy: {
        version: validateCostPolicy({ version: 1, mode: 'recommend-only' }).version,
        mode: 'recommend-only',
        note: 'The policy arm simulates the profile the pressure guard would select. It is not evidence of live policy enforcement.',
      },
      arms,
      gate,
      measurementCoverage: {
        covered: [
          'net tokens forwarded per arm over an identical captured workload',
          'saving split into ANSI normalization vs compression',
          'retrieval overhead at a declared expansion rate, and the worst case',
          'byte-exact recoverability of every omission',
          'added processing latency per tool call (p50/p95)',
          'ground-truth task verification via the demo test suite',
        ],
        notCovered: [
          'agent success rate per arm (requires live model runs; workload is held fixed by design)',
          'end-to-end task latency including model time',
          'a compatible cheaper model actually selected (HC-05, live-provider validation pending)',
          'a budget changing an owned action (HC-06)',
          'a feedback-triggered profile rollback (HC-07, outcome-driven loop pending)',
          'measured financial ROI (reference rate is a declared constant)',
        ],
      },
    };
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

export function evaluateGate({ arms, baseline, verifiedSuccess }) {
  const checks = [];
  checks.push({
    check: 'ground-truth task verified',
    pass: verifiedSuccess === true,
    detail: verifiedSuccess ? 'demo suite and build green with the fix applied' : 'demo suite or build did not pass with the fix applied',
  });

  for (const arm of arms) {
    if (arm.arm === 'baseline') continue;
    // Measured against normalized tokens, not raw: ANSI removal happens before
    // any compressor runs, so charging it to compression would let a colourful
    // tool pass this gate on colour codes alone.
    const ratio = arm.normalizedTokens === 0 ? 0 : arm.compressionSavedTokens / arm.normalizedTokens;
    checks.push({
      check: `${arm.arm}: compression beats normalized input by >= ${GATE.minNetSavedRatio * 100}%`,
      pass: ratio >= GATE.minNetSavedRatio,
      detail:
        `compressors saved ${arm.compressionSavedTokens} of ${arm.normalizedTokens} normalized tokens (${(ratio * 100).toFixed(2)}%); ` +
        `ANSI normalization separately removed ${arm.ansiSavedTokens}`,
    });
    checks.push({
      check: `${arm.arm}: still ahead at the declared ${Math.round(DECLARED_RETRIEVAL_RATE * 100)}% retrieval rate`,
      pass: arm.netSavedTokensAtDeclaredRate > 0,
      detail:
        `${arm.netSavedTokensAtDeclaredRate} tokens net with ${Math.round(DECLARED_RETRIEVAL_RATE * 100)}% of markers expanded ` +
        `(${arm.netSavedTokensWorstCase} if every marker is expanded)`,
    });
  }

  for (const arm of arms) {
    checks.push({
      check: `${arm.arm}: p95 added latency <= ${GATE.maxAddedLatencyP95Ms}ms`,
      pass: arm.latencyMs.p95 <= GATE.maxAddedLatencyP95Ms,
      detail: `p95 ${arm.latencyMs.p95}ms over ${arm.latencyMs.samples} calls`,
    });
    checks.push({
      check: `${arm.arm}: token counts reproducible across runs`,
      pass: arm.spread.forwardedTokens.stdDev === 0,
      detail: `forwarded token stdDev ${arm.spread.forwardedTokens.stdDev} over ${arm.runs} runs`,
    });
  }

  return {
    thresholds: GATE,
    latencyNote:
      'Added processing latency only. End-to-end task latency including model time is not measured here, so the 10% task-latency allowance in HC-08 is not evaluated.',
    checks,
    passed: checks.every((entry) => entry.pass),
  };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`HC-08 outcome proof — ${report.task.name}`);
  lines.push(`runs: ${report.runs}   node: ${report.node}   ${report.platform}`);
  lines.push('');
  const header = [
    'arm',
    'raw',
    '-ansi',
    'normalized',
    '-compress',
    'forwarded',
    'total%',
    'retr',
    `net@${Math.round(DECLARED_RETRIEVAL_RATE * 100)}%`,
    'worst',
    'p95 ms',
    'ref $',
  ];
  const rows = report.arms.map((arm) => [
    arm.arm,
    String(arm.rawTokens),
    String(arm.ansiSavedTokens),
    String(arm.normalizedTokens),
    String(arm.compressionSavedTokens),
    String(arm.forwardedTokens),
    `${arm.netSavedPercent}%`,
    String(arm.retrievals),
    String(arm.netSavedTokensAtDeclaredRate),
    String(arm.netSavedTokensWorstCase),
    String(arm.latencyMs.p95),
    arm.referenceCostUsd.toFixed(6),
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length)),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  lines.push(line(header));
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) lines.push(line(row));
  lines.push('');
  lines.push(`task verified: ${report.task.verifiedSuccess ? 'yes' : 'NO'}`);
  lines.push('');
  lines.push('gate:');
  for (const check of report.gate.checks) {
    lines.push(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.check} — ${check.detail}`);
  }
  lines.push('');
  lines.push('not covered by this proof:');
  for (const gap of report.measurementCoverage.notCovered) lines.push(`  - ${gap}`);
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const runsIndex = args.indexOf('--runs');
  const runs = runsIndex >= 0 ? Number(args[runsIndex + 1]) : 5;
  if (!Number.isInteger(runs) || runs < 2 || runs > MAX_RUNS) {
    console.error(`--runs must be an integer between 2 and ${MAX_RUNS}`);
    process.exit(2);
  }
  const outIndex = args.indexOf('--out');
  const outPath = path.resolve(REPO_ROOT, outIndex >= 0 ? args[outIndex + 1] : DEFAULT_OUT);

  const report = runOutcomeProof({ runs });

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (!args.includes('--json')) console.log(`\nwrote ${path.relative(REPO_ROOT, outPath)}`);

  process.exit(report.gate.passed ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
