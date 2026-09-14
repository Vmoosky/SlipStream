import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { evaluateGate, formatReport, runOutcomeProof, runProofCommand } from '../scripts/outcome-proof.mjs';

test('proof commands preserve a failing exit code despite success text', () => {
  const result = runProofCommand(['-e', 'console.log("passed"); process.exit(7)'], process.cwd());
  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /passed/);
});

test('a proof command exceeding its deadline is not verified', () => {
  assert.throws(() => runProofCommand(['-e', 'setInterval(() => {}, 1000)'], process.cwd(), 100), /did not complete: ETIMEDOUT/);
});

test('proof command launch failures are not task failures to repair', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-proof-command-'));
  try {
    assert.throws(() => runProofCommand(['-e', 'process.exit(0)'], path.join(root, 'missing')), /did not complete: ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('proof execution requires bounded deadlines and repeated samples', () => {
  for (const timeout of [0, -1, 60_001, Infinity, NaN, 0.5]) {
    assert.throws(() => runProofCommand([], process.cwd(), timeout), /Command timeout/);
  }
  for (const runs of [0, 1, 21, Infinity, NaN, 2.5]) {
    assert.throws(() => runOutcomeProof({ runs }), /--runs must be an integer between 2 and 20/);
  }
});

/**
 * These tests exercise the gate and the report rendering, not a live harness
 * run. `runOutcomeProof` shells out to the demo test suite several times per
 * arm and takes minutes; putting that in the unit suite would make it unusable.
 * The gate is where the judgement lives, so that is what is pinned here.
 */

function arm(overrides = {}) {
  return {
    arm: 'compressed',
    label: 'Static compression (balanced)',
    runs: 3,
    rawTokens: 18396,
    ansiSavedTokens: 12088,
    normalizedTokens: 6308,
    compressionSavedTokens: 4488,
    forwardedTokens: 1820,
    netSavedTokens: 16576,
    netSavedPercent: 90.11,
    retrievals: 9,
    retrievalTokensWorstCase: 4825,
    netSavedTokensWorstCase: 11751,
    netSavedTokensAtDeclaredRate: 15129,
    referenceCostUsd: 0.00546,
    latencyMs: { p50: 20, p95: 80, samples: 15 },
    spread: { forwardedTokens: { mean: 1820, stdDev: 0 } },
    ...overrides,
  };
}

function baselineArm() {
  return arm({
    arm: 'baseline',
    label: 'Baseline (Slipstream off)',
    ansiSavedTokens: 0,
    normalizedTokens: 18396,
    compressionSavedTokens: 0,
    forwardedTokens: 18396,
    netSavedTokens: 0,
    netSavedPercent: 0,
    retrievals: 0,
    retrievalTokensWorstCase: 0,
    netSavedTokensWorstCase: 0,
    netSavedTokensAtDeclaredRate: 0,
    spread: { forwardedTokens: { mean: 18396, stdDev: 0 } },
  });
}

function gateOf(armOverrides = {}, opts = {}) {
  const baseline = baselineArm();
  const subject = arm(armOverrides);
  return evaluateGate({
    arms: [baseline, subject],
    baseline,
    verifiedSuccess: opts.verifiedSuccess ?? true,
  });
}

/**
 * Find a gate check by fragment, ignoring the baseline arm's copy.
 *
 * Every per-arm check exists twice (once per arm), and the baseline's copy
 * legitimately passes. Matching the first hit would assert against the wrong
 * arm and report a false green.
 */
function check(gate, fragment) {
  const candidates = gate.checks.filter((entry) => entry.check.includes(fragment));
  assert.ok(candidates.length > 0, `expected a gate check mentioning "${fragment}"`);
  const subject = candidates.find((entry) => !entry.check.startsWith('baseline:'));
  assert.ok(subject, `only the baseline arm had a check mentioning "${fragment}"`);
  return subject;
}

test('a healthy report passes every gate check', () => {
  const gate = gateOf();
  assert.equal(gate.passed, true, JSON.stringify(gate.checks, null, 2));
});

test('an unverified ground-truth task fails the gate', () => {
  const gate = gateOf({}, { verifiedSuccess: false });
  assert.equal(gate.passed, false);
  assert.equal(check(gate, 'ground-truth task verified').pass, false);
});

test('the baseline arm is never asked to beat itself', () => {
  const gate = gateOf();
  const baselineSavingChecks = gate.checks.filter(
    (entry) => entry.check.startsWith('baseline:') && entry.check.includes('compression beats'),
  );
  assert.equal(baselineSavingChecks.length, 0);
});

test('a compression regression fails the gate', () => {
  // Compressors recover only 5% of normalized input, under the 10% bar.
  const gate = gateOf({ compressionSavedTokens: 315, forwardedTokens: 5993 });
  assert.equal(gate.passed, false);
  assert.equal(check(gate, 'compression beats normalized input').pass, false);
});

test('savings made entirely of ANSI stripping do not pass the compression gate', () => {
  // The bug this guards: crediting compressors with colour-code removal. Total
  // saving here is a headline-friendly 90%, but every token of it came from
  // normalization and the compressors achieved nothing.
  const gate = gateOf({
    ansiSavedTokens: 16576,
    normalizedTokens: 1820,
    compressionSavedTokens: 0,
    forwardedTokens: 1820,
    netSavedTokens: 16576,
    netSavedPercent: 90.11,
  });
  assert.equal(gate.passed, false);
  const entry = check(gate, 'compression beats normalized input');
  assert.equal(entry.pass, false);
  assert.match(entry.detail, /ANSI normalization separately removed 16576/);
});

test('losing the benefit once retrievals are charged fails the gate', () => {
  const gate = gateOf({ netSavedTokensAtDeclaredRate: -12, netSavedTokensWorstCase: -400 });
  assert.equal(gate.passed, false);
  const entry = check(gate, 'still ahead at the declared');
  assert.equal(entry.pass, false);
  // The worst case stays visible even though it is not itself a gate.
  assert.match(entry.detail, /-400 if every marker is expanded/);
});

test('non-reproducible token counts fail the gate', () => {
  const gate = gateOf({ spread: { forwardedTokens: { mean: 1820, stdDev: 12.5 } } });
  assert.equal(gate.passed, false);
  assert.equal(check(gate, 'reproducible across runs').pass, false);
});

test('excess added latency fails the gate', () => {
  const gate = gateOf({ latencyMs: { p50: 20, p95: 900, samples: 15 } });
  assert.equal(gate.passed, false);
  assert.equal(check(gate, 'p95 added latency').pass, false);
});

test('the report renders the ANSI/compression split and the uncovered list', () => {
  const baseline = baselineArm();
  const subject = arm();
  const report = {
    task: { name: 'demo', description: 'repair two seeded defects', verifiedSuccess: true },
    runs: 3,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    workload: [{ scenario: 'npm test', kind: 'command', tool: 'npm test' }],
    arms: [baseline, subject],
    gate: evaluateGate({ arms: [baseline, subject], baseline, verifiedSuccess: true }),
    measurementCoverage: {
      covered: ['net tokens forwarded per arm over an identical captured workload'],
      notCovered: ['agent success rate per arm (requires live model runs; workload is held fixed by design)'],
    },
  };

  const text = formatReport(report);
  // The split must be visible in the table, so a reader cannot mistake colour
  // stripping for compression.
  assert.match(text, /-ansi/);
  assert.match(text, /normalized/);
  assert.match(text, /-compress/);
  assert.match(text, /12088/);
  assert.match(text, /4488/);
  assert.match(text, /task verified: yes/);
  assert.match(text, /not covered by this proof:/);
  assert.match(text, /agent success rate per arm/);
});
