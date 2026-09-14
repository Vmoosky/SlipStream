import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  collectUnit,
  collectBrowser,
  verifyRequired,
  verifySecurity,
  UNIT_JOBS,
  BROWSER_JOBS,
  UNIT_REPORTS,
} from '../scripts/check-ci.mjs';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const META = {
  revision: 'a'.repeat(40),
  runId: '123',
  attempt: '1',
  eventName: 'pull_request',
  workflow: 'Vmoosky/SlipStream/.github/workflows/ci.yml@refs/pull/1/merge',
  headRevision: 'b'.repeat(40),
  baseRevision: 'c'.repeat(40),
};
const unitSteps = Object.fromEntries(
  ['install', 'build', 'types', 'tests', 'lint', 'format'].map((name) => [
    name,
    { outcome: 'success' },
  ]),
);
const browserSteps = Object.fromEntries(
  ['install', 'build', 'chromium', 'browser', 'docs', 'proof', 'package'].map((name) => [
    name,
    { outcome: 'success' },
  ]),
);

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-ci-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, data) => {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data));
  };
  for (const file of UNIT_REPORTS)
    write(file, {
      success: true,
      numTotalTests: 2,
      numPassedTests: 2,
      numPendingTests: 0,
      numFailedTests: 0,
      numFailedTestSuites: 0,
    });
  write('browser/report.json', {
    stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
    errors: [],
  });
  write('docs.json', {
    schemaVersion: 1,
    kind: 'documentation-contracts',
    passed: true,
    errors: [],
    contracts: ['a', 'b', 'c'],
    coverage: { markdownFiles: 3 },
    written: [],
    residual: ['Narrative review'],
  });
  write('outcome-proof.json', {
    proof: 'hc08-outcome-paired-comparison',
    runs: 5,
    gate: { passed: true, checks: [{ pass: true }] },
    task: { verifiedSuccess: true },
    arms: [{ arm: 'baseline' }, { arm: 'compressed' }, { arm: 'policy', policySimulated: true }],
    measurementCoverage: { notCovered: ['Live agent success rate'] },
  });
  return { root, write };
}

function artifacts(context) {
  const { root, write } = fixture(context);
  for (const job of UNIT_JOBS)
    write(`ci-unit-${job}/ci-unit.json`, collectUnit(root, { ...META, job, steps: unitSteps }));
  for (const job of BROWSER_JOBS)
    write(
      `ci-browser-${job}/ci-browser.json`,
      collectBrowser(root, { ...META, job, steps: browserSteps }),
    );
  return {
    root,
    write,
    options: {
      ...META,
      needs: {
        unit: { result: 'success' },
        'browser-proof': { result: 'success' },
        secrets: { result: 'success' },
      },
    },
  };
}

test('workspaces build in dependency order including the source-bundled plugin', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const packages = manifest.workspaces.map((folder) =>
    JSON.parse(fs.readFileSync(path.join(REPO, folder, 'package.json'), 'utf8')),
  );
  const names = packages.map((entry) => entry.name);
  for (const [index, entry] of packages.entries()) {
    for (const dependency of Object.keys(entry.dependencies ?? {})) {
      const required = names.indexOf(dependency);
      if (required >= 0) assert.ok(required < index, `${entry.name} must follow ${dependency}`);
    }
  }
  assert.ok(names.indexOf('@slipstream/core') < names.indexOf('@slipstream/copilot-plugin'));
});

test('valid unit and browser evidence records exact provenance', (context) => {
  const { root } = fixture(context);
  const unit = collectUnit(root, { ...META, job: UNIT_JOBS[0], steps: unitSteps });
  const browser = collectBrowser(root, { ...META, job: BROWSER_JOBS[0], steps: browserSteps });
  assert.equal(unit.passed, true);
  assert.equal(unit.revision, META.revision);
  assert.equal(browser.passed, true);
  assert.match(browser.proof.measurementCoverage.notCovered[0], /Live agent/);
});

test('missing or failed unit evidence cannot pass despite successful command status', (context) => {
  const { root, write } = fixture(context);
  fs.rmSync(path.join(root, UNIT_REPORTS[0]));
  assert.equal(collectUnit(root, { ...META, job: UNIT_JOBS[0], steps: unitSteps }).passed, false);
  write(UNIT_REPORTS[0], { success: true, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0 });
  assert.equal(collectUnit(root, { ...META, job: UNIT_JOBS[0], steps: unitSteps }).passed, false);
});

test('failed commands and cancelled or skipped jobs fail the required gate', (context) => {
  const { root, options } = artifacts(context);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(
      verifyRequired(root, { ...options, needs: { ...options.needs, secrets: { result } } }).passed,
      false,
    );
  }
  assert.equal(
    collectUnit(root, {
      ...META,
      job: UNIT_JOBS[0],
      steps: { ...unitSteps, tests: { outcome: 'failure', conclusion: 'success' } },
    }).passed,
    false,
  );
});

test('missing artifacts or an artifact from another revision or attempt fail closed', (context) => {
  const { root, options, write } = artifacts(context);
  assert.equal(verifyRequired(root, options).passed, true);
  const file = `ci-unit-${UNIT_JOBS[0]}/ci-unit.json`;
  const report = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const change of [
    { revision: 'b'.repeat(40) },
    { runId: '124' },
    { attempt: '2' },
    { headRevision: 'd'.repeat(40) },
    { baseRevision: 'e'.repeat(40) },
    { workflow: 'another-workflow' },
    { passed: false },
    { suites: [] },
    { suites: [report.suites[1], ...report.suites.slice(1)] },
  ]) {
    write(file, { ...report, ...change });
    assert.equal(verifyRequired(root, options).passed, false);
  }
  fs.rmSync(path.join(root, file));
  assert.equal(verifyRequired(root, options).passed, false);
});

test('browser failures and unverified proof cannot pass as successful evidence', (context) => {
  const { root, write } = fixture(context);
  write('browser/report.json', {
    stats: { expected: 2, unexpected: 1, flaky: 0, skipped: 0 },
    errors: [],
  });
  write('outcome-proof.json', { gate: { passed: true }, task: { verifiedSuccess: false } });
  const report = collectBrowser(root, { ...META, job: BROWSER_JOBS[0], steps: browserSteps });
  assert.equal(report.passed, false);
  assert.equal(report.errors.length, 2);
});

test('CI requires the configured five proof samples', (context) => {
  const { root, write } = fixture(context);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'outcome-proof.json'), 'utf8'));
  for (const runs of [undefined, 1, 2, 4, 6, '5']) {
    write('outcome-proof.json', { ...report, runs });
    assert.equal(
      collectBrowser(root, { ...META, job: BROWSER_JOBS[0], steps: browserSteps }).passed,
      false,
    );
  }
});

test('CI evidence cannot be attributed with missing identity fields', (context) => {
  const { root } = fixture(context);
  assert.throws(
    () => collectUnit(root, { ...META, revision: '', job: UNIT_JOBS[0], steps: unitSteps }),
    /Exact CI/,
  );
  assert.throws(
    () => collectUnit(root, { ...META, job: 'unknown', steps: unitSteps }),
    /Unknown unit job/,
  );
  assert.throws(() => verifySecurity({ ...META, baseRevision: null }), /base revision is required/);
});

test('both browser platforms must supply their own evidence', (context) => {
  const { root, options, write } = artifacts(context);
  for (const job of BROWSER_JOBS) {
    const file = `ci-browser-${job}/ci-browser.json`;
    const report = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    fs.rmSync(path.join(root, file));
    assert.equal(verifyRequired(root, options).passed, false);
    write(file, { ...report, job: 'another-platform' });
    assert.equal(verifyRequired(root, options).passed, false);
    write(file, report);
  }
  assert.equal(verifyRequired(root, options).passed, true);
});

test('security aggregation only allows an intentionally inapplicable dependency review', () => {
  const needs = { codeql: { result: 'success' }, 'dependency-review': { result: 'success' } };
  assert.equal(verifySecurity({ ...META, needs }).passed, true);
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(
      verifySecurity({ ...META, needs: { ...needs, codeql: { result } } }).passed,
      false,
    );
    assert.equal(
      verifySecurity({ ...META, needs: { ...needs, 'dependency-review': { result } } }).passed,
      false,
    );
  }
  assert.equal(
    verifySecurity({
      ...META,
      eventName: 'push',
      needs: { ...needs, 'dependency-review': { result: 'skipped' } },
    }).passed,
    true,
  );
  assert.equal(
    verifySecurity({
      ...META,
      eventName: 'push',
      needs: { ...needs, 'dependency-review': { result: 'failure' } },
    }).passed,
    false,
  );
});

test('security workflow isolates write permission and never builds untrusted PR code', () => {
  const workflow = parse(
    fs.readFileSync(path.join(REPO, '.github/workflows/security.yml'), 'utf8'),
  );
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(workflow.on.pull_request?.paths, undefined);
  assert.equal(workflow.on.pull_request?.['paths-ignore'], undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.on.workflow_run, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.codeql.permissions, {
    contents: 'read',
    'security-events': 'write',
  });
  assert.ok(workflow.jobs.codeql.steps.every((step) => !step.run));
  assert.equal(workflow.jobs['security-required'].if, '${{ always() }}');
  assert.deepEqual(workflow.jobs['security-required'].needs, ['codeql', 'dependency-review']);
  assert.equal(workflow.jobs['dependency-review'].if, "${{ github.event_name == 'pull_request' }}");
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps) {
      assert.equal(step['continue-on-error'], undefined);
      if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@'))
        assert.equal(step.with['persist-credentials'], false);
    }
  }
});

test('required CI has no path bypass, unpinned actions, or success-by-skipping paths', () => {
  const workflow = parse(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.pull_request?.paths, undefined);
  assert.equal(workflow.on.pull_request?.['paths-ignore'], undefined);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs['ci-required'].if, '${{ always() }}');
  assert.deepEqual(workflow.jobs['ci-required'].needs, ['unit', 'browser-proof', 'secrets']);
  assert.deepEqual(
    workflow.jobs.unit.strategy.matrix.include.map((entry) => entry.id),
    UNIT_JOBS,
  );
  assert.equal(workflow.jobs.unit.strategy['fail-fast'], false);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 30);
    assert.equal(job['continue-on-error'], undefined);
    for (const step of job.steps) {
      assert.equal(step['continue-on-error'], undefined);
      const command = step.run?.match(/^npm run ([\w:-]+)(?:\s|$)/)?.[1];
      if (command)
        assert.ok(Object.hasOwn(manifest.scripts, command), `Missing npm script: ${command}`);
      if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@'))
        assert.equal(step.with['persist-credentials'], false);
      if (step.uses?.startsWith('actions/upload-artifact@')) {
        assert.equal(step.with['retention-days'], 7);
        assert.equal(step.with['if-no-files-found'], 'error');
        assert.equal(step.if, '${{ always() }}');
        assert.ok(
          step.with.path
            .trim()
            .split('\n')
            .every((line) => line.startsWith('test-results/')),
        );
      }
    }
  }
  const ids = workflow.jobs.unit.steps.map((step) => step.id).filter(Boolean);
  assert.deepEqual(ids, Object.keys(unitSteps));
  const browserIds = workflow.jobs['browser-proof'].steps.map((step) => step.id).filter(Boolean);
  assert.deepEqual(browserIds, Object.keys(browserSteps));
  assert.deepEqual(
    workflow.jobs['browser-proof'].strategy.matrix.include.map((entry) => entry.id),
    BROWSER_JOBS,
  );
  assert.equal(workflow.jobs['browser-proof'].strategy['fail-fast'], false);
});
