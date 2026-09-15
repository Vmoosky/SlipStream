import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import {
  collectUnit,
  collectBrowser,
  verifyRequired,
  verifySecurity,
  UNIT_JOBS,
  BROWSER_JOBS,
  UNIT_REPORTS,
  DOC_CONTRACTS,
} from '../scripts/check-ci.mjs';
import {
  MAINTENANCE_LIMITS,
  validateDocumentationProposal,
  runMaintenanceCommand,
  runDocumentationMaintenance,
  maintenanceIdentity,
  collectMaintenanceEvidence,
} from '../scripts/maintenance.mjs';

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
    contracts: [...DOC_CONTRACTS],
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

test('documentation evidence requires the exact contract set in any order', (context) => {
  const { root, write, options } = artifacts(context);
  const docs = JSON.parse(fs.readFileSync(path.join(root, 'docs.json'), 'utf8'));
  const file = `ci-browser-${BROWSER_JOBS[0]}/ci-browser.json`;
  const browser = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const contracts of [
    undefined,
    null,
    3,
    { length: 3 },
    DOC_CONTRACTS.join(','),
    [],
    ['a', 'b', 'c'],
    [DOC_CONTRACTS[0], DOC_CONTRACTS[0], DOC_CONTRACTS[2]],
    DOC_CONTRACTS.slice(1),
    [...DOC_CONTRACTS, 'docs/unknown.md'],
    [null, ...DOC_CONTRACTS.slice(1)],
    [0, ...DOC_CONTRACTS.slice(1)],
    [{ path: DOC_CONTRACTS[0] }, ...DOC_CONTRACTS.slice(1)],
  ]) {
    write('docs.json', { ...docs, contracts });
    assert.equal(
      collectBrowser(root, { ...META, job: BROWSER_JOBS[0], steps: browserSteps }).passed,
      false,
      `Collection accepted ${JSON.stringify(contracts)}`,
    );
    write(file, { ...browser, docs: { ...browser.docs, contracts } });
    assert.equal(
      verifyRequired(root, options).passed,
      false,
      `Aggregation accepted ${JSON.stringify(contracts)}`,
    );
  }
  write('docs.json', { ...docs, contracts: [...DOC_CONTRACTS].reverse() });
  const reordered = collectBrowser(root, { ...META, job: BROWSER_JOBS[0], steps: browserSteps });
  assert.equal(reordered.passed, true);
  write(file, reordered);
  assert.equal(verifyRequired(root, options).passed, true);
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

function documentationChange(file = 'docs/architecture.md') {
  const ids = {
    'docs/architecture.md': 'build',
    'packages/extension/README.md': 'extension',
    'docs/mcp.md': 'mcp',
  };
  const text = [
    '# Authored heading',
    `<!-- slipstream-reference:${ids[file]}:start -->`,
    'Old generated value',
    `<!-- slipstream-reference:${ids[file]}:end -->`,
    'Authored footer',
    '',
  ].join('\n');
  return {
    path: file,
    status: 'M',
    oldMode: '100644',
    newMode: '100644',
    before: Buffer.from(text),
    after: Buffer.from(text.replace('Old generated value', 'New generated value')),
    added: 1,
    deleted: 1,
  };
}

test('maintenance accepts no-op and bounded generated-block proposals', () => {
  assert.equal(validateDocumentationProposal([], Buffer.alloc(0)).changedLines, 0);
  const changes = DOC_CONTRACTS.map((file) => documentationChange(file));
  const report = validateDocumentationProposal(changes, Buffer.from('patch'));
  assert.deepEqual(
    report.files.map((file) => file.path),
    DOC_CONTRACTS,
  );
  assert.equal(report.changedLines, 6);
  assert.match(report.patchSha256, /^[a-f0-9]{64}$/);
  const change = { ...changes[0], added: 100, deleted: 100 };
  assert.equal(
    validateDocumentationProposal([change], Buffer.alloc(MAINTENANCE_LIMITS.patchBytes, 32))
      .changedLines,
    MAINTENANCE_LIMITS.changedLines,
  );
  assert.throws(() =>
    validateDocumentationProposal([{ ...change, added: 101 }], Buffer.from('patch')),
  );
  assert.throws(() =>
    validateDocumentationProposal([change], Buffer.alloc(MAINTENANCE_LIMITS.patchBytes + 1)),
  );
});

test('maintenance rejects paths, modes, duplicates and malformed change statistics', () => {
  const change = documentationChange();
  const patch = Buffer.from('patch');
  for (const invalid of [
    { path: '../README.md' },
    { path: 'README.md' },
    { status: 'A' },
    { status: 'D' },
    { status: 'R100' },
    { oldMode: '120000' },
    { newMode: '100755' },
    { newMode: '120000' },
    { added: '-' },
    { added: -1 },
    { deleted: 0.5 },
    { added: 0, deleted: 0 },
    { after: Buffer.from([0]) },
    { after: Buffer.from([255]) },
  ]) {
    assert.throws(() => validateDocumentationProposal([{ ...change, ...invalid }], patch));
  }
  assert.throws(() => validateDocumentationProposal([change, change], patch));
  assert.throws(() => validateDocumentationProposal([null], patch));
  assert.throws(() => validateDocumentationProposal([], patch));
  assert.throws(() => validateDocumentationProposal([change], Buffer.alloc(0)));
});

test('maintenance rejects authored prose edits and absent or malformed reference blocks', () => {
  const change = documentationChange();
  const patch = Buffer.from('patch');
  const text = change.after.toString();
  for (const after of [
    '\uFEFF' + text,
    text.replace('Authored heading', 'Changed heading'),
    text.replace('Authored footer', 'Changed footer'),
    text.replace('<!-- slipstream-reference:build:start -->', ''),
    text.replace(':build:end', ':other:end'),
    text + '<!-- slipstream-reference:build:start -->',
    text + '<!-- slipstream-reference:build:end -->',
    text
      .replace(':build:start', ':build:temp')
      .replace(':build:end', ':build:start')
      .replace(':build:temp', ':build:end'),
  ]) {
    assert.throws(() =>
      validateDocumentationProposal([{ ...change, after: Buffer.from(after) }], patch),
    );
  }
  assert.throws(() => validateDocumentationProposal([{ ...change, after: change.before }], patch));
  assert.throws(() =>
    validateDocumentationProposal([{ ...change, before: Buffer.from('No block') }], patch),
  );
});

test('maintenance commands preserve failure, timeout, and spawn errors', async (context) => {
  const { root } = fixture(context);
  assert.equal(
    (
      await runMaintenanceCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], root)
    ).toString(),
    'ok',
  );
  await assert.rejects(() =>
    runMaintenanceCommand(
      process.execPath,
      ['-e', 'console.log("success"); process.exit(7)'],
      root,
    ),
  );
  await assert.rejects(() =>
    runMaintenanceCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], root, 50),
  );
  await assert.rejects(() =>
    runMaintenanceCommand(process.execPath, [], path.join(root, 'missing')),
  );
  for (const timeout of [0, 60_001, 1.5]) {
    await assert.rejects(() => runMaintenanceCommand(process.execPath, [], root, timeout));
  }
});

test('scheduled maintenance identity cannot weaken existing CI provenance', () => {
  const event = { repository: { full_name: 'Vmoosky/SlipStream', default_branch: 'main' } };
  const env = {
    GITHUB_ACTIONS: 'true',
    SLIPSTREAM_MAINTENANCE_ENABLED: 'true',
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_REPOSITORY: event.repository.full_name,
    GITHUB_SHA: META.revision,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'Vmoosky/SlipStream/.github/workflows/maintenance.yml@refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
  };
  assert.equal(maintenanceIdentity(META.revision, env, event).eventName, 'schedule');
  assert.equal(
    maintenanceIdentity(META.revision, { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, event)
      .eventName,
    'workflow_dispatch',
  );
  assert.equal(maintenanceIdentity(META.revision, {}).eventName, 'local');
  for (const invalid of [
    { SLIPSTREAM_MAINTENANCE_ENABLED: '' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/untrusted' },
    { GITHUB_SHA: 'b'.repeat(40) },
    { GITHUB_REPOSITORY: 'other/repository' },
    { GITHUB_WORKFLOW_REF: 'other' },
    { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ATTEMPT: '' },
  ])
    assert.throws(() => maintenanceIdentity(META.revision, { ...env, ...invalid }, event));
  assert.throws(() => maintenanceIdentity('HEAD', {}));
  assert.throws(() => verifySecurity({ ...META, eventName: 'schedule' }));
});

function maintenanceRepository(context) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-maintenance-test-'));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(fs.realpathSync.native(parent), 'source');
  const hooks = path.join(parent, 'hooks');
  fs.mkdirSync(hooks);
  execFileSync(
    'git',
    [
      'clone',
      '--quiet',
      '--local',
      '--no-hardlinks',
      '--config',
      `core.hooksPath=${hooks}`,
      '--config',
      'commit.gpgsign=false',
      REPO,
      root,
    ],
    { timeout: MAINTENANCE_LIMITS.commandTimeoutMs },
  );
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  fs.mkdirSync(path.join(root, '.slipstream'), { recursive: true });
  const sentinel = path.join(root, '.slipstream', 'user-sentinel');
  fs.writeFileSync(sentinel, 'Do not touch user data');
  const commit = () => {
    git(['add', '--', 'package.json']);
    git([
      '-c',
      'user.name=Test Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Synthetic maintenance fixture change',
    ]);
    return git(['rev-parse', 'HEAD']);
  };
  return { root, git, sentinel, commit };
}

test('maintenance runs in an isolated exact-revision checkout and retains no-op evidence', async (context) => {
  const { root, git, sentinel } = maintenanceRepository(context);
  const revision = git(['rev-parse', 'HEAD']);
  const result = await runDocumentationMaintenance(root, { revision, env: {} });
  assert.equal(result.report.passed, true, JSON.stringify(result.report));
  assert.equal(result.report.outcome, 'no-op');
  assert.equal(result.report.revision, revision);
  assert.equal(result.report.eventName, 'local');
  assert.equal(result.report.checks.cleanup, 'success');
  assert.equal(fs.existsSync(path.join(root, result.outputDirectory, 'proposal.patch')), false);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Do not touch user data');
});

test('maintenance proposes stale generated content without changing the source', async (context) => {
  const { root, git, sentinel, commit } = maintenanceRepository(context);
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.description += ' Synthetic fixture change';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const revision = commit();
  const original = fs.readFileSync(path.join(root, 'docs/architecture.md'));
  const result = await runDocumentationMaintenance(root, { revision, env: {} });
  assert.equal(result.report.passed, true, JSON.stringify(result.report));
  assert.equal(result.report.outcome, 'proposed');
  assert.deepEqual(
    result.report.proposal.files.map((file) => file.path),
    ['docs/architecture.md'],
  );
  assert.ok(fs.readFileSync(path.join(root, result.outputDirectory, 'proposal.patch')).length > 0);
  assert.deepEqual(fs.readFileSync(path.join(root, 'docs/architecture.md')), original);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Do not touch user data');

  const existing = new Set(fs.readdirSync(path.join(root, 'test-results/maintenance')));
  let sourceChecks = 0;
  const runCommand = async (command, args, cwd) => {
    const output = await runMaintenanceCommand(command, args, cwd);
    if (
      path.relative(cwd, root) === '' &&
      args.includes('--porcelain=v1') &&
      ++sourceChecks === 2
    ) {
      const directory = fs
        .readdirSync(path.join(root, 'test-results/maintenance'))
        .find((name) => !existing.has(name));
      fs.mkdirSync(path.join(root, 'test-results/maintenance', directory, 'report.json'));
    }
    return output;
  };
  const failed = await runDocumentationMaintenance(root, { revision, env: {}, runCommand });
  assert.equal(sourceChecks, 2);
  assert.equal(failed.report.passed, false);
  assert.equal(failed.report.proposal, null);
  assert.equal(failed.outputDirectory, null);
  assert.deepEqual(new Set(fs.readdirSync(path.join(root, 'test-results/maintenance'))), existing);
  assert.ok(fs.existsSync(path.join(root, result.outputDirectory, 'proposal.patch')));
});

test('maintenance rejects a dirty source and mismatched revision without creating a checkout', async (context) => {
  const { root, git } = maintenanceRepository(context);
  const revision = git(['rev-parse', 'HEAD']);
  assert.equal(
    (await runDocumentationMaintenance(root, { revision: 'a'.repeat(40), env: {} })).report.outcome,
    'blocked',
  );
  fs.appendFileSync(path.join(root, 'README.md'), '\nUncommitted work\n');
  const result = await runDocumentationMaintenance(root, { revision, env: {} });
  assert.equal(result.report.outcome, 'blocked');
  assert.equal(result.outputDirectory, null);
  assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /Uncommitted work/);
});

test('maintenance withholds patches on generator, validation, idempotence, scope and cancellation failures', async (context) => {
  const { root, git, sentinel } = maintenanceRepository(context);
  const revision = git(['rev-parse', 'HEAD']);
  for (const fault of [
    'generation',
    'validation',
    'idempotence',
    'scope',
    'new-file',
    'cancelled',
  ]) {
    const controller = new AbortController();
    let writes = 0;
    let checkout;
    const runCommand = async (command, args, cwd, timeout, signal) => {
      if (command === process.execPath) {
        checkout = cwd;
        if (args.at(-1) === 'write') writes++;
        if (fault === 'generation') throw new Error('Synthetic spawn failure');
        if (fault === 'validation' && args.at(-1) === 'check')
          throw new Error('Synthetic validation failure');
        if (fault === 'idempotence' && writes === 2)
          throw new Error('Synthetic second-write failure');
        if (fault === 'cancelled') {
          const execution = runMaintenanceCommand(
            command,
            ['-e', 'setInterval(() => {}, 1000)'],
            cwd,
            timeout,
            signal,
          );
          controller.abort();
          return execution;
        }
        const output = await runMaintenanceCommand(command, args, cwd, timeout, signal);
        if (writes === 1 && args.at(-1) === 'write') {
          if (fault === 'scope')
            fs.appendFileSync(path.join(cwd, 'README.md'), '\nUnexpected prose edit\n');
          if (fault === 'new-file')
            fs.writeFileSync(path.join(cwd, 'unexpected.txt'), 'Unexpected file');
        }
        return output;
      }
      return runMaintenanceCommand(command, args, cwd, timeout, signal);
    };
    const result = await runDocumentationMaintenance(root, {
      revision,
      env: {},
      runCommand,
      signal: controller.signal,
    });
    assert.equal(result.report.passed, false, fault);
    assert.equal(result.report.cancelled, fault === 'cancelled', fault);
    assert.equal(result.report.proposal, null, fault);
    assert.equal(
      fs.existsSync(path.join(root, result.outputDirectory, 'proposal.patch')),
      false,
      fault,
    );
    assert.equal(fs.existsSync(checkout), false, fault);
    assert.equal(git(['status', '--porcelain']), '', fault);
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Do not touch user data');
});

test('maintenance refuses output junctions without touching their target', async (context) => {
  const { root, git } = maintenanceRepository(context);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-output-sentinel-'));
  context.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, 'sentinel'), 'unchanged');
  fs.symlinkSync(target, path.join(root, 'test-results'), 'junction');
  const result = await runDocumentationMaintenance(root, {
    revision: git(['rev-parse', 'HEAD']),
    env: {},
  });
  assert.equal(result.report.outcome, 'blocked');
  assert.deepEqual(fs.readdirSync(target), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'unchanged');
});

test('maintenance refuses missing blocks and tracked symlinks before generation', async (context) => {
  const { root, git, commit } = maintenanceRepository(context);
  const file = path.join(root, 'docs/architecture.md');
  const text = fs
    .readFileSync(file, 'utf8')
    .replace('<!-- slipstream-reference:build:start -->', '');
  fs.writeFileSync(file, text);
  git(['add', '--', 'docs/architecture.md']);
  const missing = await runDocumentationMaintenance(root, { revision: commit(), env: {} });
  assert.equal(missing.report.outcome, 'blocked');
  assert.equal(missing.report.checks.generation, undefined);
  assert.equal(missing.report.checks.cleanup, 'success');
  assert.equal(fs.existsSync(path.join(root, missing.outputDirectory, 'proposal.patch')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), text);

  git(['config', '--local', 'core.symlinks', 'false']);
  const blob = git(['rev-parse', 'HEAD:docs/architecture.md']);
  git(['update-index', '--cacheinfo', `120000,${blob},docs/architecture.md`]);
  const linked = await runDocumentationMaintenance(root, { revision: commit(), env: {} });
  assert.equal(linked.report.outcome, 'blocked');
  assert.equal(linked.report.checks.generation, undefined);
  assert.equal(linked.report.checks.cleanup, 'success');
  assert.equal(fs.existsSync(path.join(root, linked.outputDirectory, 'proposal.patch')), false);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

function maintenanceEvidence(context) {
  const { root, write } = fixture(context);
  const event = { repository: { full_name: 'Vmoosky/SlipStream', default_branch: 'main' } };
  const env = {
    GITHUB_ACTIONS: 'true',
    SLIPSTREAM_MAINTENANCE_ENABLED: 'true',
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_REPOSITORY: event.repository.full_name,
    GITHUB_SHA: META.revision,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'Vmoosky/SlipStream/.github/workflows/maintenance.yml@refs/heads/main',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
  };
  const reportPath = 'test-results/maintenance/run-fixture/report.json';
  const report = {
    schemaVersion: 1,
    kind: 'documentation-maintenance',
    ...maintenanceIdentity(META.revision, env, event),
    outcome: 'no-op',
    passed: true,
    cancelled: false,
    errors: [],
    checks: Object.fromEntries(
      ['source', 'generation', 'validation', 'idempotence', 'proposal', 'cleanup'].map((name) => [
        name,
        'success',
      ]),
    ),
    generatorSha256: 'a'.repeat(64),
    startedAt: '2026-09-15T00:00:00Z',
    finishedAt: '2026-09-15T00:00:01Z',
    durationMs: 1000,
    proposal: validateDocumentationProposal([], Buffer.alloc(0)),
    residual: ['Human review required'],
  };
  write(reportPath, report);
  write('test-results/maintenance-audit.json', {
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  });
  write(
    'test-results/maintenance-proof.json',
    JSON.parse(fs.readFileSync(path.join(root, 'outcome-proof.json'), 'utf8')),
  );
  const steps = Object.fromEntries(
    ['context', 'install', 'build', 'tests', 'audit', 'docs', 'proof'].map((name) => [
      name,
      { outcome: 'success' },
    ]),
  );
  return {
    root,
    write,
    report,
    options: { revision: META.revision, env, event, steps, reportPath },
  };
}

test('maintenance aggregation needs actual success from every independent check', (context) => {
  const { root, write, options } = maintenanceEvidence(context);
  const successful = collectMaintenanceEvidence(root, options);
  assert.equal(successful.passed, true);
  assert.equal(Object.keys(successful.evidenceSha256).length, 3);
  for (const digest of Object.values(successful.evidenceSha256))
    assert.match(digest, /^[a-f0-9]{64}$/);
  for (const name of Object.keys(options.steps)) {
    for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
      const result = collectMaintenanceEvidence(root, {
        ...options,
        steps: {
          ...options.steps,
          [name]: { outcome, conclusion: 'success' },
        },
      });
      assert.equal(result.passed, false, `${name}: ${outcome}`);
      assert.equal(result.proposalPath, null);
    }
  }
  write('test-results/maintenance-audit.json', {
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 } },
  });
  write('test-results/maintenance-proof.json', {
    proof: 'hc08-outcome-paired-comparison',
    runs: 1,
    gate: { passed: true },
  });
  assert.equal(collectMaintenanceEvidence(root, options).passed, false);
});

test('maintenance aggregation rejects stale reports and absent or altered proposals', (context) => {
  const { root, write, report, options } = maintenanceEvidence(context);
  for (const change of [
    { revision: 'b'.repeat(40) },
    { runId: '456' },
    { attempt: '2' },
    { workflow: 'other' },
    { eventName: 'workflow_dispatch' },
    { passed: false },
    { cancelled: true },
    { durationMs: -1 },
    { residual: [] },
    { outcome: 'proposed' },
  ]) {
    write(options.reportPath, { ...report, ...change });
    assert.equal(collectMaintenanceEvidence(root, options).passed, false);
  }
  const patch = Buffer.from('Synthetic validated patch');
  const proposal = validateDocumentationProposal([documentationChange()], patch);
  write(options.reportPath, { ...report, outcome: 'proposed', proposal });
  assert.equal(collectMaintenanceEvidence(root, options).passed, false);
  const patchPath = path.join(root, options.reportPath.replace('report.json', 'proposal.patch'));
  fs.writeFileSync(patchPath, patch);
  assert.equal(collectMaintenanceEvidence(root, options).passed, true);
  fs.appendFileSync(patchPath, 'altered');
  assert.equal(collectMaintenanceEvidence(root, options).passed, false);
  assert.equal(
    collectMaintenanceEvidence(root, { ...options, reportPath: '../report.json' }).passed,
    false,
  );
});

test('maintenance workflow stays opt-in, read-only, bounded and default-branch-only', () => {
  const workflow = parse(
    fs.readFileSync(path.join(REPO, '.github/workflows/maintenance.yml'), 'utf8'),
  );
  const job = workflow.jobs.maintenance;
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.schedule, [{ cron: '0 7 * * 1' }]);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, {
    group: 'maintenance-${{ github.repository }}',
    'cancel-in-progress': false,
  });
  assert.equal(job.if, "${{ vars.SLIPSTREAM_MAINTENANCE_ENABLED == 'true' }}");
  assert.equal(job['timeout-minutes'], 20);
  assert.equal(job.permissions, undefined);
  const context = job.steps[0];
  assert.equal(context.id, 'context');
  assert.equal(context.env.DEFAULT_BRANCH, '${{ github.event.repository.default_branch }}');
  assert.ok(context.run.includes('test "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH"'));
  assert.ok(
    context.run.includes(
      'test "$GITHUB_WORKFLOW_REF" = "$GITHUB_REPOSITORY/.github/workflows/maintenance.yml@refs/heads/$DEFAULT_BRANCH"',
    ),
  );
  const steps = Object.fromEntries(
    job.steps.filter((step) => step.id).map((step) => [step.id, step]),
  );
  assert.deepEqual(Object.keys(steps), [
    'context',
    'install',
    'build',
    'tests',
    'audit',
    'docs',
    'proof',
    'verify',
  ]);
  for (const name of ['tests', 'audit', 'docs', 'proof']) {
    assert.equal(steps[name].if, "${{ !cancelled() && steps.build.outcome == 'success' }}");
    assert.ok(steps[name]['timeout-minutes'] > 0 && steps[name]['timeout-minutes'] <= 6);
  }
  assert.match(steps.proof.run, /--runs 5 --json --out test-results\/maintenance-proof\.json$/);
  assert.equal(steps.verify.if, "${{ always() && steps.context.outcome == 'success' }}");
  assert.equal(steps.verify.env.CI_STEPS, '${{ toJSON(steps) }}');
  assert.equal(steps.verify.env.MAINTENANCE_REPORT, '${{ steps.docs.outputs.report_path }}');
  for (const step of job.steps) {
    assert.equal(step['continue-on-error'], undefined);
    if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
    if (step.uses?.startsWith('actions/checkout@')) {
      assert.equal(step.with.ref, '${{ github.sha }}');
      assert.equal(step.with['persist-credentials'], false);
    }
    if (step.uses?.startsWith('actions/setup-node@'))
      assert.equal(step.with['node-version-file'], '.node-version');
  }
  const uploads = job.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(uploads.length, 2);
  for (const step of uploads) {
    assert.equal(step.with['retention-days'], 7);
    assert.equal(step.with['if-no-files-found'], 'error');
    assert.ok(step.with.name.endsWith('${{ github.run_id }}-${{ github.run_attempt }}'));
  }
  assert.equal(uploads[0].if, "${{ always() && steps.context.outcome == 'success' }}");
  assert.deepEqual(uploads[0].with.path.trim().split('\n'), [
    'test-results/maintenance/run-*/report.json',
    'test-results/maintenance/run-*/summary.json',
  ]);
  assert.equal(
    uploads[1].if,
    "${{ !cancelled() && steps.verify.outcome == 'success' && steps.verify.outputs.proposal_path != '' }}",
  );
  assert.equal(uploads[1].with.path, '${{ steps.verify.outputs.proposal_path }}');
});

test('Dependabot version updates stay paused pending owner-verified enforcement', () => {
  const config = parse(fs.readFileSync(path.join(REPO, '.github/dependabot.yml'), 'utf8'));
  assert.equal(config.version, 2);
  assert.deepEqual(
    config.updates.map((entry) => entry['package-ecosystem']),
    ['npm', 'github-actions'],
  );
  for (const entry of config.updates) {
    assert.equal(entry.directory, '/');
    assert.equal(entry['open-pull-requests-limit'], 0);
    assert.deepEqual(entry.schedule, {
      interval: 'weekly',
      day: 'monday',
      time: '07:00',
      timezone: 'Etc/UTC',
    });
    assert.deepEqual(entry.ignore, [
      { 'dependency-name': '*', 'update-types': ['version-update:semver-major'] },
    ]);
  }
});
