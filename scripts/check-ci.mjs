import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const UNIT_JOBS = ['linux-node20', 'linux-node22', 'linux-node24', 'windows-node24'];
export const BROWSER_JOBS = ['linux-node24', 'windows-node24'];
export const COVERAGE_JOBS = ['linux-node24', 'windows-node24'];
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
export const DOC_CHECKS = ['generated-manifests', 'local-links', 'json-examples', 'npm-scripts'];
const CONTAINMENT_RULES = [
  {
    category: 'dependency',
    pattern: /\binstall\b/i,
    action: 'Inspect dependency installation output.',
  },
  {
    category: 'build',
    pattern: /\b(build|types)\b/i,
    action: 'Reproduce the build or typecheck locally.',
  },
  {
    category: 'test',
    pattern: /\b(tests?|browser|coverage)\b/i,
    action: 'Reproduce the failing test suite locally.',
  },
  {
    category: 'validation',
    pattern: /\b(lint|format|docs|proof|package)\b/i,
    action: 'Run the named validation command locally.',
  },
  {
    category: 'security',
    pattern: /\b(secrets|codeql|dependency-review)\b/i,
    action: 'Review the corresponding security job without exposing findings.',
  },
];

function hasExpectedDocContracts(contracts) {
  return (
    Array.isArray(contracts) &&
    contracts.length === DOC_CONTRACTS.length &&
    DOC_CONTRACTS.every((file) => contracts.includes(file))
  );
}

export function isDocumentationFile(file) {
  return typeof file === 'string' && (/\.(md|markdown)$/i.test(file) || file === 'llms.txt');
}

function repositoryPath(file) {
  return (
    typeof file === 'string' &&
    file.length > 0 &&
    file.length <= 1024 &&
    !/[\\:]/.test(file) &&
    ![...file].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !path.posix.isAbsolute(file) &&
    !file.split('/').some((part) => ['', '.', '..'].includes(part))
  );
}

export function documentationContext(root, options) {
  const metadata = identity(options);
  const git = (args) => {
    try {
      return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(
        'Documentation Git evidence requires a clean checkout and full revision history.',
      );
    }
  };
  expect(
    path.relative(
      fs.realpathSync.native(root),
      fs.realpathSync.native(git(['rev-parse', '--show-toplevel']).trim()),
    ) === '',
  );
  expect(git(['rev-parse', 'HEAD']).trim() === metadata.revision);
  expect(git(['status', '--porcelain', '--untracked-files=no']).trim() === '');
  if (metadata.eventName === 'pull_request') {
    const parents = git(['show', '--no-patch', '--format=%P', metadata.revision]).trim().split(' ');
    expect(
      parents.length === 2 &&
        parents[0] === metadata.baseRevision &&
        parents[1] === metadata.headRevision,
    );
  } else {
    expect(metadata.headRevision === metadata.revision);
  }
  const entries = git(['ls-tree', '-r', '-z', '--full-tree', metadata.revision])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      expect(match && repositoryPath(match[4]));
      return { mode: match[1], path: match[4] };
    });
  expect(entries.length <= 20_000);
  const documents = entries
    .filter((entry) => isDocumentationFile(entry.path))
    .map((entry) => {
      expect(['100644', '100755'].includes(entry.mode));
      expect(!fs.lstatSync(path.join(root, entry.path)).isSymbolicLink());
      return entry.path;
    })
    .sort();
  expect(documents.length > 0 && documents.length <= 10_000);
  const comparedBase =
    metadata.baseRevision && !/^0+$/.test(metadata.baseRevision) ? metadata.baseRevision : null;
  let changes;
  if (comparedBase) {
    expect(git(['rev-parse', `${comparedBase}^{commit}`]).trim() === comparedBase);
    const fields = git([
      'diff',
      '--name-status',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      comparedBase,
      metadata.revision,
      '--',
    ])
      .split('\0')
      .filter(Boolean);
    expect(fields.length % 2 === 0 && fields.length <= 40_000);
    changes = [];
    for (let index = 0; index < fields.length; index += 2) {
      expect(['A', 'M', 'D', 'T'].includes(fields[index]) && repositoryPath(fields[index + 1]));
      changes.push({ status: fields[index], path: fields[index + 1] });
    }
  } else {
    changes = entries.map((entry) => ({ status: 'A', path: entry.path }));
  }
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { ...metadata, comparedBase, changes, documents };
}

function validateDocumentationScope(report, metadata, expectedContext) {
  const { scope, coverage } = report;
  expect(scope?.kind === 'repository-wide');
  expect(
    Array.isArray(scope.checks) &&
      scope.checks.length === DOC_CHECKS.length &&
      DOC_CHECKS.every((check) => scope.checks.includes(check)),
  );
  expect(
    Array.isArray(scope.files) &&
      scope.files.length > 0 &&
      scope.files.length <= 10_000 &&
      scope.files.every((file) => repositoryPath(file) && isDocumentationFile(file)) &&
      new Set(scope.files).size === scope.files.length &&
      JSON.stringify(scope.files) === JSON.stringify([...scope.files].sort()),
  );
  expect(DOC_CONTRACTS.every((file) => scope.files.includes(file)));
  expect(
    ['markdownFiles', 'localLinks', 'jsonExamples', 'npmCommands'].every(
      (key) => Number.isSafeInteger(coverage?.[key]) && coverage[key] >= 0,
    ) && coverage.markdownFiles === scope.files.length,
  );
  const context = scope.context;
  expect(context && Object.entries(metadata).every(([key, value]) => context[key] === value));
  const comparedBase =
    metadata.baseRevision && !/^0+$/.test(metadata.baseRevision) ? metadata.baseRevision : null;
  expect(context.comparedBase === comparedBase);
  expect(metadata.eventName !== 'pull_request' || comparedBase !== null);
  expect(JSON.stringify(context.documents) === JSON.stringify(scope.files));
  if (expectedContext !== undefined) {
    expect(
      expectedContext &&
        Object.entries(expectedContext).every(
          ([key, value]) => JSON.stringify(context[key]) === JSON.stringify(value),
        ),
    );
  }
  expect(Array.isArray(context.changes) && context.changes.length <= 20_000);
  const paths = context.changes.map((change) => {
    expect(change && ['A', 'M', 'D', 'T'].includes(change.status) && repositoryPath(change.path));
    if (isDocumentationFile(change.path)) {
      expect(scope.files.includes(change.path) === (change.status !== 'D'));
    }
    return change.path;
  });
  expect(new Set(paths).size === paths.length);
  expect(JSON.stringify(paths) === JSON.stringify([...paths].sort()));
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

function readUnitSuite(root, file) {
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
}

function validateCoverageEvidence(report, unitFile) {
  const directory = `coverage/${unitFile.slice('unit-'.length, -'.json'.length)}`;
  expect(report?.file === `${directory}/coverage-summary.json`);
  expect(
    report.suite?.file === `${directory}/unit.json` &&
      Number.isInteger(report.suite.passed) &&
      report.suite.passed > 0 &&
      Number.isInteger(report.suite.skipped) &&
      report.suite.skipped >= 0 &&
      report.suite.total === report.suite.passed + report.suite.skipped,
  );
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    const value = report.totals?.[metric];
    expect(
      Number.isSafeInteger(value?.total) &&
        value.total > 0 &&
        Number.isSafeInteger(value.covered) &&
        value.covered > 0 &&
        value.covered <= value.total &&
        Number.isSafeInteger(value.skipped) &&
        value.skipped >= 0 &&
        value.skipped <= value.total &&
        Number.isFinite(value.pct) &&
        value.pct >= 0 &&
        value.pct <= 100 &&
        Math.abs(value.pct - (100 * value.covered) / value.total) < 0.011,
    );
  }
}

export function collectUnit(root, options) {
  const metadata = identity(options);
  if (!UNIT_JOBS.includes(options.job)) throw new Error('Unknown unit job');
  const errors = successfulSteps(options.steps, [
    'install',
    'build',
    'types',
    'tests',
    ...(COVERAGE_JOBS.includes(options.job) ? ['coverage'] : []),
    'lint',
    'format',
  ]);
  const suites = UNIT_REPORTS.map((file) => inspect(errors, file, () => readUnitSuite(root, file)));
  const coverage = (COVERAGE_JOBS.includes(options.job) ? UNIT_REPORTS : []).map((unitFile) =>
    inspect(errors, unitFile, () => {
      const directory = `coverage/${unitFile.slice('unit-'.length, -'.json'.length)}`;
      const file = `${directory}/coverage-summary.json`;
      const evidence = {
        file,
        totals: readJson(root, file).total,
        suite: readUnitSuite(root, `${directory}/unit.json`),
      };
      validateCoverageEvidence(evidence, unitFile);
      return evidence;
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
    coverage,
    errors,
  };
}

export function collectBrowser(root, options) {
  const metadata = identity(options);
  if (!BROWSER_JOBS.includes(options.job)) throw new Error('Unknown browser job');
  const errors = successfulSteps(options.steps, ['setup', 'chromium', 'validate']);
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
    validateDocumentationScope(report, metadata, options.documentation);
    return {
      contracts: report.contracts,
      coverage: report.coverage,
      scope: report.scope,
      residual: report.residual,
    };
  });
  const proof = inspect(errors, 'outcome-proof.json', () =>
    validateProofReport(readJson(root, 'outcome-proof.json')),
  );
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

export function validateProofReport(report) {
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
        if (COVERAGE_JOBS.includes(job)) {
          expect(Array.isArray(report.coverage) && report.coverage.length === UNIT_REPORTS.length);
          UNIT_REPORTS.forEach((unitFile, index) =>
            validateCoverageEvidence(report.coverage[index], unitFile),
          );
        }
      } else {
        expect(
          report.browser?.expected > 0 &&
            hasExpectedDocContracts(report.docs?.contracts) &&
            report.proof?.gate?.passed === true,
        );
        validateDocumentationScope(report.docs, metadata, options.documentation);
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

export function classifyFailureContainment(root, options, scope) {
  if (!['ci', 'security'].includes(scope)) throw new Error('Unknown containment scope');
  const metadata = identity(options);
  const gate = scope === 'ci' ? verifyRequired(root, options) : verifySecurity(options);
  const failures = [...gate.errors];
  let missingReport = false;
  if (scope === 'ci') {
    const reports = [
      ...UNIT_JOBS.map((job) => `ci-unit-${job}/ci-unit.json`),
      ...BROWSER_JOBS.map((job) => `ci-browser-${job}/ci-browser.json`),
    ];
    for (const file of reports) {
      if (!fs.existsSync(path.join(root, file))) missingReport = true;
      try {
        const report = readJson(root, file);
        if (!Array.isArray(report.errors)) throw new Error('invalid errors');
        for (const error of report.errors.slice(0, 20)) {
          if (typeof error === 'string' && error.length <= 500) failures.push(`${file}: ${error}`);
        }
      } catch {
        failures.push(`${file}: evidence unavailable or invalid`);
      }
    }
  }
  const completeDependencies =
    scope === 'ci' &&
    ['unit', 'browser-proof', 'secrets'].every((job) => options.needs?.[job]?.result === 'success');
  const incompletePartialRerun =
    scope === 'ci' && BigInt(metadata.attempt) > 1n && completeDependencies && missingReport;
  const uniqueFailures = [...new Set(failures)].slice(0, 100);
  const categories = [
    ...new Set(
      uniqueFailures.map(
        (failure) =>
          CONTAINMENT_RULES.find((rule) => rule.pattern.test(failure))?.category ?? 'evidence',
      ),
    ),
  ].sort();
  const actions = categories.map((category) =>
    category === 'evidence'
      ? incompletePartialRerun
        ? 'Rerun the complete workflow to produce same-attempt evidence.'
        : 'Inspect missing or invalid CI evidence before retrying.'
      : CONTAINMENT_RULES.find((rule) => rule.category === category).action,
  );
  return {
    schemaVersion: 1,
    kind: 'failure-containment',
    ...metadata,
    scope,
    status: uniqueFailures.length === 0 ? 'clear' : 'contained',
    automaticRetry: false,
    automaticRepair: false,
    failures: uniqueFailures,
    categories,
    actions,
    ...(incompletePartialRerun ? { classification: 'incomplete-partial-rerun' } : {}),
  };
}

export function compareImprovementReports(before, after) {
  const read = (snapshot) => {
    if (!snapshot) return null;
    const { expected, report } = snapshot;
    const metadata = identity(expected);
    const { kind, conclusion } = expected;
    expect(['required-validation', 'security-validation'].includes(kind));
    expect(metadata.runId.length <= 20 && metadata.workflow.length <= 512);
    const allowedErrors =
      kind === 'security-validation'
        ? [
            'codeql: required analysis did not succeed',
            'dependency-review: unexpected result for this event',
          ]
        : [
            ...['unit', 'browser-proof', 'secrets'].map(
              (name) => `${name}: required job did not succeed`,
            ),
            ...UNIT_JOBS.map((job) => `ci-unit-${job}/ci-unit.json`),
            ...BROWSER_JOBS.map((job) => `ci-browser-${job}/ci-browser.json`),
          ].map((error) =>
            error.endsWith('.json')
              ? `${error}: missing, malformed, or unsuccessful evidence`
              : error,
          );
    const valid =
      metadata.attempt === '1' &&
      report?.schemaVersion === 1 &&
      report.kind === kind &&
      Object.entries(metadata).every(([key, value]) => report[key] === value) &&
      typeof report.passed === 'boolean' &&
      Array.isArray(report.errors) &&
      report.errors.length <= allowedErrors.length &&
      report.errors.every((error) => allowedErrors.includes(error)) &&
      report.passed === (report.errors.length === 0) &&
      conclusion === (report.passed ? 'success' : 'failure');
    return {
      ...metadata,
      kind,
      valid,
      passed: valid ? report.passed : null,
      errors: valid ? [...new Set(report.errors)].sort() : [],
    };
  };
  const baseline = read(before);
  const candidate = read(after);
  if (baseline && candidate) {
    expect(baseline.kind === candidate.kind && baseline.workflow === candidate.workflow);
    expect(BigInt(baseline.runId) < BigInt(candidate.runId));
  }
  const comparable = Boolean(baseline?.valid && candidate?.valid);
  const failures = [...new Set([...(baseline?.errors ?? []), ...(candidate?.errors ?? [])])];
  const findings = failures.sort().map((failure) => {
    let status = 'unverified';
    if (comparable) {
      if (candidate.errors.includes(failure)) {
        status = baseline.errors.includes(failure) ? 'recurring' : 'new';
      } else if (candidate.passed && candidate.revision !== baseline.revision) {
        status = 'cleared';
      }
    }
    return {
      id: createHash('sha256')
        .update(`${(candidate ?? baseline).workflow}\0${(candidate ?? baseline).kind}\0${failure}`)
        .digest('hex'),
      failure,
      status,
      fixVerified: false,
      beforeRevision: baseline?.revision ?? null,
      afterRevision: candidate?.revision ?? null,
      nextAction: 'Add a regression that fails before the fix and passes after it; require review.',
    };
  });
  return {
    schemaVersion: 1,
    kind: 'continuous-improvement',
    status: comparable ? 'reported' : 'insufficient-evidence',
    before: baseline,
    after: candidate,
    automaticRetry: false,
    automaticRepair: false,
    findings,
    residual: [
      'Cleared CI failures are not proof of a targeted regression fix or its review.',
      'The offline outcome proof covers its synthetic workload, not arbitrary source repairs.',
    ],
  };
}

export function verifyImprovementRegression(finding, regression, before, after) {
  const result = {
    schemaVersion: 1,
    kind: 'regression-proof',
    findingId: finding.id,
    verified: false,
    reviewRequired: true,
  };
  try {
    expect(finding.status === 'cleared' && regression.findingId === finding.id);
    expect(UNIT_JOBS.includes(regression.job) && UNIT_REPORTS.includes(regression.suite));
    expect(
      finding.failure === 'unit: required job did not succeed' ||
        finding.failure ===
          `ci-unit-${regression.job}/ci-unit.json: missing, malformed, or unsuccessful evidence`,
    );
    expect(typeof regression.testName === 'string' && regression.testName.trim().length > 0);
    expect(regression.testName.length <= 300);
    const baseline = identity(before.expected);
    const candidate = identity(after.expected);
    expect(baseline.revision === finding.beforeRevision);
    expect(
      candidate.revision === finding.afterRevision && candidate.revision !== baseline.revision,
    );
    expect(
      baseline.workflow === candidate.workflow && BigInt(baseline.runId) < BigInt(candidate.runId),
    );
    for (const [evidence, passed] of [
      [before, false],
      [after, true],
    ]) {
      const { expected, unit, tests } = evidence;
      const metadata = identity(expected);
      expect(expected.kind === 'required-validation' && metadata.attempt === '1');
      expect(expected.conclusion === (passed ? 'success' : 'failure'));
      expect(unit.schemaVersion === 1 && unit.kind === 'unit-validation');
      expect(Object.entries(metadata).every(([key, value]) => unit[key] === value));
      expect(unit.job === regression.job && unit.passed === passed && Array.isArray(unit.errors));
      expect(
        passed
          ? unit.errors.length === 0
          : unit.errors.includes(
              `${regression.suite}: missing, malformed, or unsuccessful evidence`,
            ),
      );
      expect(tests.success === passed && Array.isArray(tests.testResults));
      const counts = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests'];
      expect(counts.every((key) => Number.isInteger(tests[key]) && tests[key] >= 0));
      expect(tests.numTotalTests > 0 && tests.numTotalTests <= 20_000);
      expect(
        tests.numTotalTests === tests.numPassedTests + tests.numFailedTests + tests.numPendingTests,
      );
      expect(
        passed
          ? tests.numFailedTests === 0 && tests.numFailedTestSuites === 0
          : tests.numFailedTests > 0,
      );
      expect(tests.testResults.length <= tests.numTotalTests);
      expect(tests.testResults.every((suite) => Array.isArray(suite.assertionResults)));
      const assertions = tests.testResults.flatMap((suite) => suite.assertionResults);
      expect(assertions.length === tests.numTotalTests);
      expect(
        assertions.filter((assertion) => assertion.status === 'passed').length ===
          tests.numPassedTests,
      );
      expect(
        assertions.filter((assertion) => assertion.status === 'failed').length ===
          tests.numFailedTests,
      );
      expect(
        assertions.filter((assertion) =>
          ['pending', 'skipped', 'todo', 'disabled'].includes(assertion.status),
        ).length === tests.numPendingTests,
      );
      const matches = assertions.filter((assertion) => assertion.fullName === regression.testName);
      expect(matches.length === 1 && matches[0].status === (passed ? 'passed' : 'failed'));
      if (passed) {
        expect(
          Array.isArray(unit.suites) &&
            unit.suites.some(
              (suite) =>
                suite?.file === regression.suite &&
                suite.total === tests.numTotalTests &&
                suite.passed === tests.numPassedTests &&
                suite.skipped === tests.numPendingTests,
            ),
        );
      }
    }
    return {
      ...result,
      verified: true,
      job: regression.job,
      suite: regression.suite,
      testName: regression.testName,
      before: baseline,
      after: candidate,
    };
  } catch {
    return { ...result, reason: 'Missing or mismatched failing-then-passing regression evidence.' };
  }
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
  if (['browser', 'required', 'contain-ci'].includes(mode)) {
    try {
      options.documentation = documentationContext(ROOT, options);
    } catch {
      options.documentation = null;
    }
  }
  const reports = path.join(ROOT, 'test-results');
  let report;
  if (mode === 'unit') report = collectUnit(reports, options);
  else if (mode === 'browser') report = collectBrowser(reports, options);
  else if (mode === 'required') report = verifyRequired(path.join(ROOT, 'artifacts'), options);
  else if (mode === 'security') report = verifySecurity(options);
  else if (mode === 'contain-ci')
    report = classifyFailureContainment(path.join(ROOT, 'artifacts'), options, 'ci');
  else if (mode === 'contain-security')
    report = classifyFailureContainment(path.join(ROOT, 'artifacts'), options, 'security');
  else
    throw new Error(
      'Usage: check-ci.mjs unit|browser|required|security|contain-ci|contain-security',
    );
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, `ci-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = mode.startsWith('contain-') || report.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
