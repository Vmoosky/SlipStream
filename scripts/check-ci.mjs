import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const UNIT_JOBS = ['linux-node20', 'linux-node22', 'linux-node24', 'windows-node24'];
export const BROWSER_JOBS = ['linux-node24', 'windows-node24'];
export const UNIT_REPORTS = [
  'unit-core.json',
  'unit-hook-runtime.json',
  'unit-mcp-server.json',
  'unit-extension.json',
];
export const DOC_CONTRACTS = [
  'docs/architecture.md',
  'packages/extension/README.md',
  'docs/mcp.md',
];

function hasExpectedDocContracts(contracts) {
  return (
    Array.isArray(contracts) &&
    contracts.length === DOC_CONTRACTS.length &&
    DOC_CONTRACTS.every((file) => contracts.includes(file))
  );
}

function readJson(root, file) {
  const target = path.join(root, file);
  if (fs.statSync(target).size > 20 * 1024 * 1024) throw new Error(`${file}: report is too large`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function successfulSteps(steps, required) {
  return required
    .filter((name) => steps?.[name]?.outcome !== 'success')
    .map((name) => `${name}: required command did not succeed`);
}

function identity(options) {
  if (
    !/^[a-f0-9]{40}$/.test(options.revision ?? '') ||
    !/^\d+$/.test(options.runId ?? '') ||
    !/^\d+$/.test(options.attempt ?? '')
  ) {
    throw new Error('Exact CI revision, run ID and attempt are required');
  }
  if (
    !['pull_request', 'push', 'workflow_dispatch'].includes(options.eventName) ||
    !/^[a-f0-9]{40}$/.test(options.headRevision ?? '') ||
    typeof options.workflow !== 'string' ||
    !options.workflow.trim()
  ) {
    throw new Error('Exact workflow, event and head revision are required');
  }
  if (options.baseRevision !== null && !/^[a-f0-9]{40}$/.test(options.baseRevision ?? ''))
    throw new Error('Invalid base revision');
  if (options.eventName === 'pull_request' && options.baseRevision === null)
    throw new Error('Pull request base revision is required');
  return {
    revision: options.revision,
    runId: options.runId,
    attempt: options.attempt,
    eventName: options.eventName,
    workflow: options.workflow,
    headRevision: options.headRevision,
    baseRevision: options.baseRevision,
  };
}

function inspect(errors, name, operation) {
  try {
    return operation();
  } catch {
    errors.push(`${name}: missing, malformed, or unsuccessful evidence`);
    return null;
  }
}

function expect(value) {
  if (!value) throw new Error('Invalid evidence');
}

export function collectUnit(root, options) {
  const metadata = identity(options);
  if (!UNIT_JOBS.includes(options.job)) throw new Error('Unknown unit job');
  const errors = successfulSteps(options.steps, [
    'install',
    'build',
    'types',
    'tests',
    'lint',
    'format',
  ]);
  const suites = UNIT_REPORTS.map((file) =>
    inspect(errors, file, () => {
      const report = readJson(root, file);
      expect(
        report.success === true &&
          Number.isInteger(report.numTotalTests) &&
          report.numTotalTests > 0 &&
          Number.isInteger(report.numPassedTests) &&
          report.numPassedTests > 0 &&
          report.numFailedTests === 0 &&
          report.numFailedTestSuites === 0,
      );
      expect(
        Number.isInteger(report.numPendingTests) &&
          report.numPendingTests >= 0 &&
          report.numPassedTests + report.numPendingTests === report.numTotalTests,
      );
      return {
        file,
        total: report.numTotalTests,
        passed: report.numPassedTests,
        skipped: report.numPendingTests,
      };
    }),
  );
  return {
    schemaVersion: 1,
    kind: 'unit-validation',
    ...metadata,
    job: options.job,
    node: process.version,
    passed: errors.length === 0,
    suites,
    errors,
  };
}

export function collectBrowser(root, options) {
  const metadata = identity(options);
  if (!BROWSER_JOBS.includes(options.job)) throw new Error('Unknown browser job');
  const errors = successfulSteps(options.steps, [
    'install',
    'build',
    'chromium',
    'browser',
    'docs',
    'proof',
    'package',
  ]);
  const browser = inspect(errors, 'browser/report.json', () => {
    const { stats, errors: failures } = readJson(root, 'browser/report.json');
    expect(
      stats &&
        Number.isInteger(stats.expected) &&
        stats.expected > 0 &&
        stats.unexpected === 0 &&
        stats.flaky === 0 &&
        stats.skipped === 0 &&
        Array.isArray(failures) &&
        failures.length === 0,
    );
    return stats;
  });
  const docs = inspect(errors, 'docs.json', () => {
    const report = readJson(root, 'docs.json');
    expect(
      report.schemaVersion === 1 &&
        report.kind === 'documentation-contracts' &&
        report.passed === true &&
        Array.isArray(report.errors) &&
        report.errors.length === 0 &&
        hasExpectedDocContracts(report.contracts) &&
        report.coverage?.markdownFiles > 0 &&
        Array.isArray(report.written) &&
        report.written.length === 0,
    );
    return { contracts: report.contracts, coverage: report.coverage, residual: report.residual };
  });
  const proof = inspect(errors, 'outcome-proof.json', () => {
    const report = readJson(root, 'outcome-proof.json');
    expect(
      report.proof === 'hc08-outcome-paired-comparison' &&
        report.gate?.passed === true &&
        report.task?.verifiedSuccess === true &&
        report.runs === 5,
    );
    expect(
      Array.isArray(report.gate.checks) &&
        report.gate.checks.length > 0 &&
        report.gate.checks.every((check) => check.pass === true),
    );
    expect(
      Array.isArray(report.arms) &&
        ['baseline', 'compressed', 'policy'].every((name) =>
          report.arms.some((arm) => arm.arm === name),
        ) &&
        report.arms.length === 3,
    );
    expect(
      report.arms.find((arm) => arm.arm === 'policy').policySimulated === true &&
        report.measurementCoverage?.notCovered?.length > 0,
    );
    return {
      runs: report.runs,
      gate: report.gate,
      measurementCoverage: report.measurementCoverage,
    };
  });
  return {
    schemaVersion: 1,
    kind: 'browser-proof-validation',
    ...metadata,
    job: options.job,
    passed: errors.length === 0,
    browser,
    docs,
    proof,
    errors,
  };
}

export function verifyRequired(root, options) {
  const metadata = identity(options);
  const errors = ['unit', 'browser-proof', 'secrets']
    .filter((name) => options.needs?.[name]?.result !== 'success')
    .map((name) => `${name}: required job did not succeed`);
  const artifacts = [
    ...UNIT_JOBS.map((job) => [`ci-unit-${job}/ci-unit.json`, 'unit-validation', job]),
    ...BROWSER_JOBS.map((job) => [
      `ci-browser-${job}/ci-browser.json`,
      'browser-proof-validation',
      job,
    ]),
  ];
  for (const [file, kind, job] of artifacts) {
    inspect(errors, file, () => {
      const report = readJson(root, file);
      expect(
        report.schemaVersion === 1 &&
          report.kind === kind &&
          report.passed === true &&
          Array.isArray(report.errors) &&
          report.errors.length === 0,
      );
      expect(Object.entries(metadata).every(([key, value]) => report[key] === value));
      expect(report.job === job);
      if (kind === 'unit-validation') {
        expect(
          report.job === job &&
            Array.isArray(report.suites) &&
            report.suites.length === UNIT_REPORTS.length,
        );
        expect(
          UNIT_REPORTS.every((file) =>
            report.suites.some(
              (suite) =>
                suite?.file === file &&
                Number.isInteger(suite.passed) &&
                suite.passed > 0 &&
                Number.isInteger(suite.skipped) &&
                suite.skipped >= 0 &&
                suite.total === suite.passed + suite.skipped,
            ),
          ),
        );
      } else {
        expect(
          report.browser?.expected > 0 &&
            hasExpectedDocContracts(report.docs?.contracts) &&
            report.proof?.gate?.passed === true,
        );
      }
    });
  }
  return {
    schemaVersion: 1,
    kind: 'required-validation',
    ...metadata,
    passed: errors.length === 0,
    errors,
  };
}

export function verifySecurity(options) {
  const metadata = identity(options);
  const errors = [];
  if (options.needs?.codeql?.result !== 'success')
    errors.push('codeql: required analysis did not succeed');
  const expectedReview = options.eventName === 'pull_request' ? 'success' : 'skipped';
  if (options.needs?.['dependency-review']?.result !== expectedReview)
    errors.push('dependency-review: unexpected result for this event');
  return {
    schemaVersion: 1,
    kind: 'security-validation',
    ...metadata,
    passed: errors.length === 0,
    errors,
  };
}

function main() {
  const [mode] = process.argv.slice(2);
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const options = {
    revision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    eventName: process.env.GITHUB_EVENT_NAME,
    workflow: process.env.GITHUB_WORKFLOW_REF,
    headRevision: event.pull_request?.head?.sha ?? process.env.GITHUB_SHA,
    baseRevision: event.pull_request?.base?.sha ?? event.before ?? null,
    job: process.env.CI_MATRIX_JOB,
    steps: JSON.parse(process.env.CI_STEPS ?? '{}'),
    needs: JSON.parse(process.env.CI_NEEDS ?? '{}'),
  };
  const reports = path.join(ROOT, 'test-results');
  let report;
  if (mode === 'unit') report = collectUnit(reports, options);
  else if (mode === 'browser') report = collectBrowser(reports, options);
  else if (mode === 'required') report = verifyRequired(path.join(ROOT, 'artifacts'), options);
  else if (mode === 'security') report = verifySecurity(options);
  else throw new Error('Usage: check-ci.mjs unit|browser|required|security');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, `ci-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
