import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { ESLint } from 'eslint';
import { resolveConfig, resolveConfigFile } from 'prettier';
import { developmentPlan, runDevelopmentCommand, runDevelopment } from '../scripts/develop.mjs';
import {
  agentReviewArguments,
  agentReviewEnvironment,
  agentReviewFindingIds,
  agentReviewPolicy,
  downloadAgentReviewArchive,
  runBoundedAgentReview,
  runAgentReviewProcess,
  prepareAgentReview,
  prepareAgentReviewDispositions,
  validateAgentReviewDispositions,
  validateAgentReviewResponse,
  validateAgentReviewUsage,
  verifyAgentReviewArchive,
} from '../scripts/check-agent-review.mjs';
import {
  IMPROVEMENT_LIMITS,
  readImprovementArchive,
  readRetainedImprovementEvidence,
  createImprovementClient,
  collectImprovementReports,
  validateImprovementRegistry,
  verifyImprovementRepair,
  improvementIdentity,
  runImprovementReview,
} from '../scripts/check-improvement.mjs';
import { createHash } from 'node:crypto';
import {
  collectUnit,
  collectBrowser,
  verifyRequired,
  verifySecurity,
  classifyFailureContainment,
  compareImprovementReports,
  verifyImprovementRegression,
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

import {
  PR_OBSERVABILITY_LIMITS,
  parseMaintenanceRun,
  pullRequestAreaLabels,
  verifyMaintenanceProposal,
  pullRequestReviewSummary,
  readPrObservabilityArchive,
  createPrObservabilityClient,
  collectPrObservability,
  publishPrObservability,
  pullRequestSnapshot,
  renderPrObservability,
  PR_OBSERVABILITY_MARKER,
  prObservabilityIdentity,
} from '../scripts/check-pr-observability.mjs';

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
  ['setup', 'chromium', 'validate'].map((name) => [name, { outcome: 'success' }]),
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
    coverage: { markdownFiles: 3, localLinks: 0, jsonExamples: 0, npmCommands: 0 },
    scope: {
      kind: 'repository-wide',
      checks: ['generated-manifests', 'local-links', 'json-examples', 'npm-scripts'],
      files: [...DOC_CONTRACTS].sort(),
      context: {
        ...META,
        comparedBase: META.baseRevision,
        changes: [{ status: 'M', path: 'docs/mcp.md' }],
        documents: [...DOC_CONTRACTS].sort(),
      },
    },
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
      documentation: JSON.parse(fs.readFileSync(path.join(root, 'docs.json'), 'utf8')).scope
        .context,
      needs: {
        unit: { result: 'success' },
        'browser-proof': { result: 'success' },
        secrets: { result: 'success' },
      },
    },
  };
}

test('PR observability accepts only exact same-repository maintenance attempt references', () => {
  const repository = 'Vmoosky/SlipStream';
  const url = `https://github.com/${repository}/actions/runs/123/attempts/1`;
  assert.deepEqual(parseMaintenanceRun(repository, `Maintenance-Run: ${url}`), {
    runId: '123',
    attempt: '1',
    url,
  });
  assert.equal(parseMaintenanceRun(repository, 'Normal PR'), null);
  assert.equal(parseMaintenanceRun(repository, 'Maintenance-Run: none'), null);
  for (const value of [
    url.replace(repository, 'other/repository'),
    `${url}?query=1`,
    `${url}#fragment`,
    url.replace('/attempts/1', ''),
    url.replace('/attempts/1', '/attempts/0'),
    url.replace('/123/', '/9007199254740992/'),
    `${url}/`,
  ])
    assert.throws(() => parseMaintenanceRun(repository, `Maintenance-Run: ${value}`), value);
  assert.throws(() =>
    parseMaintenanceRun(repository, `Maintenance-Run: ${url}\nMaintenance-Run: ${url}`),
  );
  assert.throws(() =>
    parseMaintenanceRun(repository, 'x'.repeat(PR_OBSERVABILITY_LIMITS.bodyBytes + 1)),
  );
});

test('PR observability labels complete file inventories without asserting automation origin', () => {
  const files = [
    {
      filename: 'packages/core/src/engine.ts',
      previous_filename: 'packages/extension/src/engine.ts',
    },
    { filename: 'docs/mcp.md' },
    { filename: '.github/workflows/ci.yml' },
  ];
  assert.deepEqual(pullRequestAreaLabels(files, 3), [
    'area:core',
    'area:docs',
    'area:extension',
    'area:tooling',
  ]);
  assert.deepEqual(pullRequestAreaLabels([{ filename: 'README.md' }], 1), ['area:docs']);
  for (const invalid of [
    [],
    [{}],
    [{ filename: '../README.md' }],
    [{ filename: 'C:/file' }],
    [{ filename: 'README.md', previous_filename: '' }],
    [{ filename: 'README.md' }, { filename: 'README.md' }],
  ]) {
    assert.throws(() => pullRequestAreaLabels(invalid, 1));
  }
  assert.throws(() => pullRequestAreaLabels(files, 4));
});

test('PR observability binds a maintenance proposal to its producer, validation and exact PR content', (context) => {
  const fixture = maintenanceEvidence(context);
  const change = documentationChange();
  const patch = Buffer.from('Synthetic validated proposal');
  const proposal = validateDocumentationProposal([change], patch);
  const report = { ...fixture.report, outcome: 'proposed', proposal };
  fixture.write(fixture.options.reportPath, report);
  fs.writeFileSync(
    path.join(fixture.root, fixture.options.reportPath.replace('report.json', 'proposal.patch')),
    patch,
  );
  const summary = collectMaintenanceEvidence(fixture.root, fixture.options);
  assert.equal(summary.passed, true);
  const repository = 'Vmoosky/SlipStream';
  const input = {
    repository,
    branch: 'main',
    reference: { runId: '123', attempt: '1' },
    pull: {
      changed_files: 1,
      base: { repo: { full_name: repository }, ref: 'main', sha: META.revision },
      head: { repo: { full_name: repository }, sha: META.headRevision },
    },
    files: [
      {
        filename: change.path,
        status: 'modified',
        additions: change.added,
        deletions: change.deleted,
      },
    ],
    run: {
      id: 123,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      event: 'schedule',
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      head_branch: 'main',
      head_sha: META.revision,
      path: '.github/workflows/maintenance.yml',
      name: 'Maintenance',
      workflow_id: 456,
    },
    workflow: { id: 456, path: '.github/workflows/maintenance.yml' },
    comparison: {
      status: 'identical',
      base_commit: { sha: META.revision },
      merge_base_commit: { sha: META.revision },
    },
    reportBytes: fs.readFileSync(path.join(fixture.root, fixture.options.reportPath)),
    summary,
    patch,
    changes: [{ ...change, base: change.before }],
  };
  assert.equal(verifyMaintenanceProposal(input).status, 'verified');
  for (const mutation of [
    { run: { ...input.run, run_attempt: 2 } },
    { run: { ...input.run, conclusion: 'failure' } },
    { run: { ...input.run, head_repository: { full_name: 'other/repo' } } },
    { run: { ...input.run, event: 'pull_request' } },
    { workflow: { ...input.workflow, id: 789 } },
    { reference: { runId: '123', attempt: '2' } },
    { summary: { ...summary, attempt: '2' } },
    { summary: { ...summary, steps: { ...summary.steps, audit: 'failure' } } },
    { reportBytes: Buffer.from(JSON.stringify({ ...report, cancelled: true })) },
    { patch: Buffer.concat([patch, Buffer.from('altered')]) },
    { files: [] },
    { comparison: { ...input.comparison, status: 'diverged' } },
    { changes: [{ ...change, base: Buffer.from('changed base') }] },
    {
      changes: [
        {
          ...change,
          base: change.before,
          after: Buffer.concat([change.after, Buffer.from('extra prose')]),
        },
      ],
    },
  ])
    assert.equal(verifyMaintenanceProposal({ ...input, ...mutation }).status, 'unverified');
});

test('PR observability review snapshots reject stale, self, bot and dismissed approvals', () => {
  const pull = { user: { id: 1 }, head: { sha: META.headRevision }, merged: false };
  const approved = {
    id: 2,
    user: { id: 3, type: 'User' },
    author_association: 'COLLABORATOR',
    state: 'APPROVED',
    commit_id: META.headRevision,
    submitted_at: '2026-01-01T00:00:00Z',
  };
  assert.equal(pullRequestReviewSummary(pull, [approved]).status, 'approved-current-head');
  assert.equal(pullRequestReviewSummary(pull, []).status, 'review-required');
  for (const mutation of [
    { commit_id: META.revision },
    { user: { id: 1, type: 'User' } },
    { user: { id: 3, type: 'Bot' } },
    { state: 'DISMISSED' },
    { author_association: 'CONTRIBUTOR' },
  ])
    assert.equal(
      pullRequestReviewSummary(pull, [{ ...approved, ...mutation }]).status,
      'review-required',
    );
  const later = {
    ...approved,
    id: 4,
    submitted_at: '2026-01-02T00:00:00Z',
    state: 'CHANGES_REQUESTED',
  };
  assert.equal(pullRequestReviewSummary(pull, [approved, later]).status, 'changes-requested');
  assert.equal(
    pullRequestReviewSummary(pull, [approved, { ...later, state: 'DISMISSED' }]).status,
    'review-required',
  );
  assert.equal(pullRequestReviewSummary(pull, [approved, approved]).status, 'unavailable');
  assert.equal(pullRequestReviewSummary(pull, Array(100).fill(approved)).status, 'unavailable');
});

test('PR observability API restricts writes to owned labels and marked comments', async () => {
  const calls = [];
  const client = createPrObservabilityClient(
    'Vmoosky/SlipStream',
    'synthetic-token',
    async (url, options) => {
      calls.push({ url, options });
      return new Response('{}');
    },
  );
  await client.json('/pulls/7');
  await client.json('/issues/7/labels', { method: 'POST', body: { labels: ['area:docs'] } });
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  for (const [resource, options] of [
    ['/pulls/7/merge', { method: 'PUT' }],
    ['/contents/package.json', { method: 'PUT' }],
    ['/issues/7/labels', { method: 'POST', body: { labels: ['unowned'] } }],
    ['/issues/7/comments', { method: 'POST', body: { body: 'Unmarked comment' } }],
    ['/issues/7/labels/unowned', { method: 'DELETE' }],
    ['https://other.invalid', {}],
  ])
    await assert.rejects(client.json(resource, options));
  assert.equal(calls.length, 2);
});

test('PR observability archives reject unrelated files, traversal and oversized inputs', async (context) => {
  const { root } = maintenanceRepository(context);
  const archive = (extra = []) =>
    execFileSync('git', ['archive', '--format=zip', ...extra, 'HEAD', 'package.json'], {
      cwd: root,
    });
  await assert.rejects(readPrObservabilityArchive(archive(), 'evidence'));
  await assert.rejects(readPrObservabilityArchive(archive(['--prefix=../']), 'evidence'));
  await assert.rejects(readPrObservabilityArchive(Buffer.from('not a zip'), 'proposal'));
  await assert.rejects(
    readPrObservabilityArchive(Buffer.alloc(PR_OBSERVABILITY_LIMITS.archiveBytes + 1), 'evidence'),
  );
});

test('PR observability collects ordinary PRs and withholds unverifiable automation labels', async () => {
  const pull = {
    number: 7,
    changed_files: 1,
    state: 'open',
    body: '',
    user: { id: 1 },
    head: { sha: META.headRevision, repo: { full_name: 'Vmoosky/SlipStream' } },
    base: { sha: META.baseRevision, ref: 'main', repo: { full_name: 'Vmoosky/SlipStream' } },
  };
  const calls = [];
  const client = {
    async json(resource) {
      calls.push(resource);
      if (resource.endsWith('/files?per_page=100'))
        return [{ filename: 'README.md', status: 'modified' }];
      if (resource.endsWith('/reviews?per_page=100')) return [];
      if (resource === '/pulls/7') return pull;
      throw new Error('Unavailable evidence');
    },
  };
  const collect = () =>
    collectPrObservability({ repository: 'Vmoosky/SlipStream', branch: 'main', number: 7, client });
  const ordinary = await collect();
  assert.deepEqual(ordinary.labels, ['area:docs']);
  assert.equal(ordinary.maintenance.status, 'not-requested');
  assert.equal(ordinary.review.status, 'review-required');
  assert.equal(calls.length, 3);
  pull.body = 'Maintenance-Run: https://github.com/Vmoosky/SlipStream/actions/runs/123/attempts/1';
  const missing = await collect();
  assert.equal(missing.maintenance.status, 'unverified');
  assert.deepEqual(missing.labels, ['area:docs']);
  pull.changed_files = 2;
  const incomplete = await collect();
  assert.deepEqual(incomplete.labels, []);
  assert.equal(incomplete.errors.length, 1);
});

test('PR observability publication preserves other labels and comments and removes stale provenance', async () => {
  const pull = {
    number: 7,
    body: '',
    head: { sha: META.headRevision },
    base: { sha: META.baseRevision },
  };
  const report = {
    repository: 'Vmoosky/SlipStream',
    number: 7,
    head: META.headRevision,
    checkedAt: '2026-01-01T00:00:00Z',
    state: 'open',
    snapshot: pullRequestSnapshot(pull),
    labels: ['area:docs'],
    maintenance: { status: 'not-requested' },
    review: { status: 'review-required', reviews: [] },
    errors: [],
    checksUrl: 'https://github.com/Vmoosky/SlipStream/pull/7/checks',
  };
  const writes = [];
  const client = {
    async json(resource, options) {
      if (options) {
        writes.push({ resource, ...options });
        return {};
      }
      if (resource === '/pulls/7') return pull;
      if (resource.endsWith('/labels?per_page=100'))
        return [{ name: 'human-label' }, { name: 'automation:maintenance' }];
      if (resource.endsWith('/comments?per_page=100'))
        return [
          { id: 8, user: { type: 'User', login: 'someone' }, body: PR_OBSERVABILITY_MARKER },
          {
            id: 9,
            user: { type: 'Bot', login: 'github-actions[bot]' },
            body: `${PR_OBSERVABILITY_MARKER}\nOld snapshot`,
          },
        ];
      if (resource === '/labels/area%3Adocs') return {};
      throw new Error('Unexpected request');
    },
  };
  await publishPrObservability(report, client);
  assert.equal(report.publication, 'applied');
  assert.deepEqual(
    writes.map((write) => [write.method, write.resource]),
    [
      ['DELETE', '/issues/7/labels/automation%3Amaintenance'],
      ['POST', '/issues/7/labels'],
      ['PATCH', '/issues/comments/9'],
    ],
  );
  assert.deepEqual(writes[1].body, { labels: ['area:docs'] });
  assert.equal(writes[2].body.body, renderPrObservability(report));
  writes.length = 0;
  pull.head.sha = META.revision;
  await publishPrObservability(report, client);
  assert.equal(report.publication, 'stale-pr');
  assert.equal(writes.length, 0);
});

test('PR observability runtime identity requires an enabled trusted default-branch workflow', () => {
  const event = {
    repository: { full_name: 'Vmoosky/SlipStream', default_branch: 'main' },
    inputs: { pull_request: '7' },
  };
  const env = {
    GITHUB_ACTIONS: 'true',
    SLIPSTREAM_OBSERVABILITY_ENABLED: 'true',
    GITHUB_REPOSITORY: 'Vmoosky/SlipStream',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF:
      'Vmoosky/SlipStream/.github/workflows/pr-observability.yml@refs/heads/main',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SHA: META.revision,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
  };
  assert.equal(prObservabilityIdentity(env, event).number, 7);
  for (const mutation of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/pull/7/merge' },
    { SLIPSTREAM_OBSERVABILITY_ENABLED: 'false' },
    { GITHUB_API_URL: 'https://other.invalid' },
    { GITHUB_SHA: 'main' },
    { GITHUB_WORKFLOW_REF: 'untrusted' },
  ]) {
    assert.throws(() => prObservabilityIdentity({ ...env, ...mutation }, event));
  }
});

test('PR observability validates real ZIPs and Git blobs before labeling a maintenance PR', async (context) => {
  const fixture = maintenanceEvidence(context);
  const change = documentationChange();
  const patch = Buffer.from('Synthetic validated proposal');
  const proposal = validateDocumentationProposal([change], patch);
  const report = { ...fixture.report, outcome: 'proposed', proposal };
  fixture.write(fixture.options.reportPath, report);
  fs.writeFileSync(
    path.join(fixture.root, fixture.options.reportPath.replace('report.json', 'proposal.patch')),
    patch,
  );
  const summary = collectMaintenanceEvidence(fixture.root, fixture.options);
  fixture.write(fixture.options.reportPath.replace('report.json', 'summary.json'), summary);
  const git = (args) => execFileSync('git', args, { cwd: fixture.root, timeout: 30_000 });
  git(['init', '--quiet']);
  git(['add', '-f', '--', 'test-results/maintenance']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Synthetic archive fixture',
  ]);
  const evidenceZip = git([
    'archive',
    '--format=zip',
    'HEAD:test-results/maintenance',
    'run-fixture/report.json',
    'run-fixture/summary.json',
  ]);
  const proposalZip = git([
    'archive',
    '--format=zip',
    'HEAD:test-results/maintenance/run-fixture',
    'proposal.patch',
  ]);
  const repository = 'Vmoosky/SlipStream';
  const baseTree = 'd'.repeat(40);
  const headTree = 'e'.repeat(40);
  const blob = (bytes) => ({
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    encoding: 'base64',
    content: bytes.toString('base64'),
    size: bytes.length,
  });
  const before = blob(change.before);
  const after = blob(change.after);
  const run = {
    id: 123,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    event: 'schedule',
    repository: { id: 9, full_name: repository },
    head_repository: { id: 9, full_name: repository },
    head_branch: 'main',
    head_sha: META.revision,
    path: '.github/workflows/maintenance.yml',
    name: 'Maintenance',
    workflow_id: 456,
  };
  const artifacts = [evidenceZip, proposalZip].map((bytes, index) => ({
    id: 100 + index,
    name: `maintenance-${index ? 'proposal' : 'evidence'}-123-1`,
    size_in_bytes: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    expired: false,
    expires_at: '2099-01-01T00:00:00Z',
    workflow_run: { id: 123, head_sha: META.revision, repository_id: 9, head_repository_id: 9 },
  }));
  const headEntries = [{ path: change.path, mode: '100644', type: 'blob', sha: after.sha }];
  const responses = {
    '/pulls/7': {
      number: 7,
      changed_files: 1,
      state: 'open',
      user: { id: 1 },
      body: `Maintenance-Run: https://github.com/${repository}/actions/runs/123/attempts/1`,
      head: { sha: META.headRevision, repo: { full_name: repository } },
      base: { sha: META.revision, ref: 'main', repo: { full_name: repository } },
    },
    '/pulls/7/files?per_page=100': [
      {
        filename: change.path,
        status: 'modified',
        sha: after.sha,
        additions: change.added,
        deletions: change.deleted,
      },
    ],
    '/pulls/7/reviews?per_page=100': [],
    '/actions/runs/123': run,
    '/actions/workflows/maintenance.yml': { id: 456, path: run.path },
    '/actions/runs/123/artifacts?per_page=10': { total_count: 2, artifacts },
    [`/git/commits/${META.revision}`]: { sha: META.revision, tree: { sha: baseTree } },
    [`/git/commits/${META.headRevision}`]: { sha: META.headRevision, tree: { sha: headTree } },
    [`/git/trees/${baseTree}?recursive=1`]: {
      sha: baseTree,
      truncated: false,
      tree: [{ path: change.path, mode: '100644', type: 'blob', sha: before.sha }],
    },
    [`/git/trees/${headTree}?recursive=1`]: { sha: headTree, truncated: false, tree: headEntries },
    [`/git/blobs/${before.sha}`]: before,
    [`/git/blobs/${after.sha}`]: after,
    [`/compare/${META.revision}...${META.revision}?per_page=1`]: {
      status: 'identical',
      base_commit: { sha: META.revision },
      merge_base_commit: { sha: META.revision },
    },
  };
  const client = {
    async json(resource) {
      assert.ok(Object.hasOwn(responses, resource), resource);
      return responses[resource];
    },
    async archive(artifact) {
      return artifact.id === 100 ? evidenceZip : proposalZip;
    },
  };
  const collect = () => collectPrObservability({ repository, branch: 'main', number: 7, client });
  const verified = await collect();
  assert.equal(verified.maintenance.status, 'verified');
  assert.ok(verified.labels.includes('automation:maintenance'));
  assert.equal(verified.maintenance.artifacts.length, 2);
  assert.match(renderPrObservability(verified), /artifacts\/100/);
  headEntries[0].mode = '120000';
  assert.equal((await collect()).maintenance.status, 'unverified');
  headEntries[0].mode = '100644';
  artifacts[0].expired = true;
  assert.equal((await collect()).maintenance.status, 'unverified');
  artifacts[0].expired = false;
  artifacts[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.equal((await collect()).maintenance.status, 'unverified');
});

test('PR observability workflow writes metadata only from trusted default-branch code', () => {
  const workflow = parse(
    fs.readFileSync(path.join(REPO, '.github/workflows/pr-observability.yml'), 'utf8'),
  );
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request_target', 'workflow_dispatch']);
  const job = workflow.jobs.observe;
  assert.match(job.if, /SLIPSTREAM_OBSERVABILITY_ENABLED == 'true'/);
  assert.match(job.if, /github.ref == format/);
  assert.deepEqual(job.permissions, {
    contents: 'read',
    actions: 'read',
    'pull-requests': 'write',
  });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.deepEqual(checkout.with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  assert.ok(job.steps.some((step) => step.run === 'npm ci --ignore-scripts'));
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
    assert.equal(step['continue-on-error'], undefined);
    assert.doesNotMatch(step.run ?? '', /\$\{\{.*pull_request\.(head|body|title)/);
  }
  assert.equal(job.steps.filter((step) => step.env?.GITHUB_TOKEN).length, 1);
  const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 30);
});

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

test('workspace boundaries reject upward dependencies and private cross-package imports', async () => {
  const linter = new ESLint({
    cwd: REPO,
    overrideConfigFile: path.join(REPO, 'eslint.config.mjs'),
  });
  const allowed = {
    core: [],
    'hook-runtime': ['core'],
    'mcp-server': ['core'],
    'copilot-plugin': ['core', 'hook-runtime', 'mcp-server'],
    extension: ['core', 'hook-runtime', 'mcp-server'],
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(
    [...manifest.workspaces].sort(),
    Object.keys(allowed)
      .map((folder) => `packages/${folder}`)
      .sort(),
  );
  const workspaces = manifest.workspaces.map((folder) => ({
    folder: path.basename(folder),
    manifest: JSON.parse(fs.readFileSync(path.join(REPO, folder, 'package.json'), 'utf8')),
  }));
  for (const owner of workspaces) {
    const filePath = path.join(REPO, 'packages', owner.folder, 'src/boundary-probe.ts');
    for (const target of workspaces) {
      if (owner === target) continue;
      const permitted = allowed[owner.folder].includes(target.folder);
      if (Object.hasOwn(owner.manifest.dependencies ?? {}, target.manifest.name)) {
        assert.ok(permitted, `${owner.manifest.name} declares prohibited ${target.manifest.name}`);
      }
      for (const specifier of [
        target.manifest.name,
        `${target.manifest.name}/dist/index.js`,
        `../../${target.folder}/src/index.js`,
      ]) {
        const [result] = await linter.lintText(`import ${JSON.stringify(specifier)};`, {
          filePath,
        });
        const rejected = !permitted || specifier !== target.manifest.name;
        assert.equal(result.errorCount, Number(rejected), `${owner.folder}: ${specifier}`);
        assert.equal(result.warningCount, 0);
        if (rejected) {
          assert.equal(result.messages[0].ruleId, 'workspace/import-boundaries');
          assert.equal(result.messages[0].messageId, permitted ? 'publicEntry' : 'direction');
        }
      }
    }
    const [local] = await linter.lintText(
      "import './config.js'; import '../src/config.js'; import 'node:path'; import '@slipstream/core-utils';",
      { filePath },
    );
    assert.equal(local.errorCount, 0, JSON.stringify(local.messages));
  }
});

test('workspace boundaries cover static import syntax and normalized workspace paths', async () => {
  const linter = new ESLint({
    cwd: REPO,
    overrideConfigFile: path.join(REPO, 'eslint.config.mjs'),
  });
  const imports = [
    (specifier) => `import ${JSON.stringify(specifier)};`,
    (specifier) => `export * from ${JSON.stringify(specifier)};`,
    (specifier) => `export { Config } from ${JSON.stringify(specifier)};`,
    (specifier) => `import type { Config } from ${JSON.stringify(specifier)};`,
    (specifier) => `type Config = import(${JSON.stringify(specifier)}).Config;`,
    (specifier) => `import dependency = require(${JSON.stringify(specifier)});`,
    (specifier) => `import(${JSON.stringify(specifier)});`,
    (specifier) => `require(${JSON.stringify(specifier)});`,
    (specifier) => `import(\`${specifier}\`);`,
    (specifier) => `require(\`${specifier}\`);`,
  ];
  for (const statement of imports) {
    for (const [specifier, messageId] of [
      ['@slipstream/core', undefined],
      ['@slipstream/copilot-plugin', 'direction'],
      ['@slipstream/core/src/config.js', 'publicEntry'],
    ]) {
      const code = statement(specifier);
      const [result] = await linter.lintText(code, {
        filePath: path.join(REPO, 'packages/extension/src/boundary-probe.ts'),
      });
      assert.equal(result.errorCount, Number(Boolean(messageId)), code);
      assert.equal(result.warningCount, 0);
      if (messageId) {
        assert.equal(result.messages[0].ruleId, 'workspace/import-boundaries', code);
        assert.equal(result.messages[0].messageId, messageId, code);
      }
    }
  }
  for (const specifier of [
    '../../core',
    '../../core/',
    '../../core/dist/index.js',
    '../../extension/../core/src/index.js',
    path.join(REPO, 'packages/core/src/index.js'),
    pathToFileURL(path.join(REPO, 'packages/core/src/index.js')).href,
  ]) {
    const [result] = await linter.lintText(`import ${JSON.stringify(specifier)};`, {
      filePath: path.join(REPO, 'packages/extension/src/boundary-probe.ts'),
    });
    assert.equal(result.errorCount, 1, specifier);
    assert.equal(result.messages[0].ruleId, 'workspace/import-boundaries');
    assert.equal(result.messages[0].messageId, 'publicEntry');
  }
});

test('workspace boundaries apply to source and tests in every module format, not root integration tooling', async () => {
  const linter = new ESLint({
    cwd: REPO,
    overrideConfigFile: path.join(REPO, 'eslint.config.mjs'),
  });
  for (const extension of ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts']) {
    for (const folder of ['src', 'test', 'src/nested']) {
      const [result] = await linter.lintText("require('@slipstream/mcp-server');", {
        filePath: path.join(REPO, 'packages/core', folder, `boundary-probe.${extension}`),
      });
      assert.equal(result.errorCount, 1, `${folder}/*.${extension}`);
      assert.equal(result.messages[0].ruleId, 'workspace/import-boundaries');
      assert.equal(result.messages[0].messageId, 'direction');
    }
  }
  for (const filePath of [
    'scripts/check-boundary-probe.mjs',
    'tests/boundary-probe.mjs',
    'e2e/boundary-probe.ts',
  ]) {
    const [result] = await linter.lintText("import '../packages/core/dist/index.js';", {
      filePath: path.join(REPO, filePath),
    });
    assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
    assert.equal(result.warningCount, 0);
  }
});

test('formatting discovers standalone Prettier settings in every workspace', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const config = path.join(REPO, '.prettierrc.json');
  const expected = { singleQuote: true, printWidth: 100, endOfLine: 'lf' };
  for (const folder of ['.', ...manifest.workspaces]) {
    const target = path.join(REPO, folder, 'package.json');
    assert.equal(await resolveConfigFile(target), config);
    assert.deepEqual(await resolveConfig(target, { useCache: false }), expected);
  }
  assert.equal(Object.hasOwn(manifest, 'prettier'), false);
});

test('development editor tasks reuse root npm scripts and build dependencies before debugging', () => {
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const manifest = readJson('package.json');
  const configuration = readJson('.vscode/tasks.json');
  const launch = readJson('.vscode/launch.json');
  assert.equal(configuration.version, '2.0.0');
  assert.deepEqual(
    configuration.tasks.map((task) => [task.label, task.script]),
    [
      ['Slipstream: Setup', 'setup'],
      ['Slipstream: Build', 'build'],
      ['Slipstream: Validate', 'validate'],
      ['Slipstream: E2E', 'test:e2e'],
    ],
  );
  for (const task of configuration.tasks) {
    assert.equal(task.type, 'npm');
    assert.ok(Object.hasOwn(manifest.scripts, task.script));
    assert.deepEqual(task.options, { cwd: '${workspaceFolder}' });
    for (const property of [
      'path',
      'command',
      'dependsOn',
      'isBackground',
      'windows',
      'linux',
      'osx',
    ])
      assert.equal(task[property], undefined);
    assert.equal(task.runOptions?.runOn, undefined);
  }
  const build = configuration.tasks.find((task) => task.script === 'build');
  assert.deepEqual(build.group, { kind: 'build', isDefault: true });
  assert.deepEqual(build.problemMatcher, ['$tsc']);
  assert.deepEqual(configuration.tasks.find((task) => task.script === 'validate').group, {
    kind: 'test',
    isDefault: true,
  });
  const extension = launch.configurations.find((entry) => entry.type === 'extensionHost');
  assert.equal(extension.preLaunchTask, build.label);
  assert.equal(manifest.scripts.build, 'npm run build --workspaces --if-present');
});

function developmentFixture(context) {
  const { root: parent } = fixture(context);
  const root = path.join(parent, 'checkout with spaces');
  const npmCli = path.join(root, 'npm tools', 'npm-cli.js');
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(path.join(root, '.node-version'), '24.14.1\n');
  fs.writeFileSync(npmCli, 'process.exit(0);\n');
  return { root, npmCli, nodeVersion: '24.14.1', log: () => {} };
}

test('development runner retains LF in Windows-style Git checkouts', (context) => {
  const { root } = fixture(context);
  const file = 'scripts/develop.mjs';
  const checkout = path.join(root, 'windows checkout');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(REPO, '.gitattributes'), path.join(root, '.gitattributes'));
  fs.copyFileSync(path.join(REPO, file), path.join(root, file));
  const git = (args) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args],
      { stdio: 'pipe' },
    );
  git(['init', '--quiet']);
  git(['add', '--', '.gitattributes', file]);
  git(['checkout-index', `--prefix=${checkout.replaceAll(path.sep, '/')}/`, '--', file]);
  const checkedOut = fs.readFileSync(path.join(checkout, file), 'utf8');
  assert.equal(checkedOut.includes('\r\n'), false, 'Git checkout must keep LF for Prettier');
  assert.equal(checkedOut, fs.readFileSync(path.join(REPO, file), 'utf8'));
});

test('development setup rejects invalid modes and Node pins before running commands', async (context) => {
  const options = developmentFixture(context);
  let calls = 0;
  options.runCommand = async () => {
    calls += 1;
  };
  await assert.rejects(
    runDevelopment(options.root, 'unknown', options),
    /Expected setup or validate/,
  );
  await assert.rejects(
    runDevelopment(options.root, 'setup', { ...options, nodeVersion: '22.23.2' }),
    /Use Node.js 24\.14\.1/,
  );
  await assert.rejects(
    runDevelopment(options.root, 'setup', { ...options, npmCli: 'npm-cli.js' }),
    /Invoke this runner with npm/,
  );
  fs.writeFileSync(path.join(options.root, '.node-version'), '24\n');
  await assert.rejects(runDevelopment(options.root, 'setup', options), /Invalid .node-version/);
  assert.equal(calls, 0);
});

test('development setup uses the root and npm entry point in fixed dependency order', async (context) => {
  const options = developmentFixture(context);
  const calls = [];
  options.runCommand = async (command, args, settings) => calls.push({ command, args, settings });
  const result = await runDevelopment(options.root, 'setup', options);
  assert.deepEqual(result, { mode: 'setup', nodeVersion: '24.14.1', commands: 3 });
  assert.equal(calls[0].command, 'git');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.deepEqual(
    calls.slice(1).map((call) => call.args),
    [
      [options.npmCli, '--version'],
      [options.npmCli, 'ci'],
      [options.npmCli, 'run', 'build'],
      [options.npmCli, 'exec', '--', 'playwright', 'install', 'chromium'],
    ],
  );
  assert.ok(calls.slice(1).every((call) => call.command === process.execPath));
  assert.ok(calls.every((call) => call.settings.cwd === options.root));
});

test('development validation retains all existing gates and CI evidence outputs', (context) => {
  const { root, nodeVersion } = developmentFixture(context);
  assert.deepEqual(developmentPlan(root, 'validate', nodeVersion), [
    ['run', 'build'],
    ['run', 'typecheck'],
    ['test'],
    ['run', 'lint'],
    ['run', 'format:check'],
    ['run', 'check:docs', '--', '--report', 'test-results/docs.json'],
    ['run', 'test:e2e'],
    [
      'run',
      'outcome-proof',
      '--',
      '--runs',
      '5',
      '--json',
      '--out',
      'test-results/outcome-proof.json',
    ],
    ['run', 'package:extension'],
  ]);
});

test('development commands stop on every failed prerequisite or gate without retries', async (context) => {
  const options = developmentFixture(context);
  for (const mode of ['setup', 'validate']) {
    const commandCount = developmentPlan(options.root, mode, options.nodeVersion).length + 2;
    for (let failureIndex = 0; failureIndex < commandCount; failureIndex += 1) {
      let calls = 0;
      const failure = new Error('synthetic command failure');
      await assert.rejects(
        runDevelopment(options.root, mode, {
          ...options,
          runCommand: async () => {
            calls += 1;
            if (calls === failureIndex + 1) throw failure;
          },
        }),
        (error) => error === failure,
      );
      assert.equal(calls, failureIndex + 1);
    }
  }
  assert.equal(fs.readFileSync(path.join(options.root, '.node-version'), 'utf8'), '24.14.1\n');
});

test('development commands handle spaces, failed exits, timeouts and cancellation', async (context) => {
  const { root, npmCli } = developmentFixture(context);
  await runDevelopmentCommand(process.execPath, [npmCli], { cwd: root });
  await assert.rejects(
    runDevelopmentCommand(process.execPath, ['-e', 'process.exit(7)'], { cwd: root }),
    (error) => error.exitCode === 7,
  );
  await assert.rejects(
    runDevelopmentCommand('slipstream-missing-development-command', [], { cwd: root }),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    runDevelopmentCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root,
      timeoutMs: 50,
    }),
    /timed out/,
  );
  const controller = new AbortController();
  const running = runDevelopmentCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: root,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(running, /cancelled/);
  await assert.rejects(
    runDevelopmentCommand(process.execPath, [npmCli], { cwd: root, signal: controller.signal }),
    /cancelled/,
  );
  await assert.rejects(
    runDevelopmentCommand(process.execPath, [npmCli], { cwd: root, timeoutMs: 0 }),
    /timeout must be/,
  );
});

test('development CI executes E2E through the public commands on pinned Windows and Linux jobs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const workflow = parse(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  const job = workflow.jobs['browser-proof'];
  assert.equal(manifest.scripts.setup, 'node scripts/develop.mjs setup');
  assert.equal(manifest.scripts.validate, 'node scripts/develop.mjs validate');
  assert.equal(manifest.scripts['test:e2e'], 'playwright test');
  assert.equal(manifest.scripts['test:dashboard'], 'npm run test:e2e --');
  assert.ok(fs.existsSync(path.join(REPO, 'e2e/dashboard.smoke.spec.ts')));
  assert.equal(fs.existsSync(path.join(REPO, 'tests/dashboard.smoke.spec.ts')), false);
  assert.equal(
    job.steps.find((step) => step.id === 'validate').name,
    'Validate repository and browser E2E',
  );
  assert.deepEqual(job.strategy.matrix.include, [
    { id: 'linux-node24', os: 'ubuntu-latest' },
    { id: 'windows-node24', os: 'windows-latest' },
  ]);
  assert.deepEqual(
    job.steps.filter((step) => step.id).map(({ id, run }) => [id, run]),
    [
      ['setup', 'npm run setup'],
      ['chromium', job.steps.find((step) => step.id === 'chromium').run],
      ['validate', 'npm run validate'],
    ],
  );
  assert.match(
    job.steps.find((step) => step.id === 'chromium').run,
    /install --with-deps chromium/,
  );
  const nodeSetup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(nodeSetup.with['node-version-file'], '.node-version');
  assert.equal(nodeSetup.with.cache, 'npm');
  assert.equal(nodeSetup.with['cache-dependency-path'], 'package-lock.json');
});

test('development CI rejects failed, cancelled, skipped or absent commands despite valid reports', (context) => {
  const { root } = fixture(context);
  for (const name of Object.keys(browserSteps)) {
    for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
      const report = collectBrowser(root, {
        ...META,
        job: BROWSER_JOBS[0],
        steps: { ...browserSteps, [name]: { outcome } },
      });
      assert.equal(report.passed, false);
      assert.deepEqual(report.errors, [`${name}: required command did not succeed`]);
    }
  }
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

test('documentation evidence requires repository-wide coverage bound to the exact PR', (context) => {
  const { root, write, options } = artifacts(context);
  const docs = JSON.parse(fs.readFileSync(path.join(root, 'docs.json'), 'utf8'));
  const file = `ci-browser-${BROWSER_JOBS[0]}/ci-browser.json`;
  const browser = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const scope of [
    undefined,
    { ...docs.scope, kind: 'targeted' },
    { ...docs.scope, checks: docs.scope.checks.slice(1) },
    { ...docs.scope, files: docs.scope.files.slice(1) },
    { ...docs.scope, files: [...docs.scope.files, '../outside.md'] },
    { ...docs.scope, context: null },
    ...['revision', 'headRevision', 'baseRevision', 'comparedBase'].map((key) => ({
      ...docs.scope,
      context: { ...docs.scope.context, [key]: 'd'.repeat(40) },
    })),
    { ...docs.scope, context: { ...docs.scope.context, attempt: '2' } },
    { ...docs.scope, context: { ...docs.scope.context, changes: null } },
    { ...docs.scope, context: { ...docs.scope.context, changes: [] } },
    {
      ...docs.scope,
      context: { ...docs.scope.context, changes: [{ status: 'M', path: 'unrelated.txt' }] },
    },
    {
      ...docs.scope,
      context: {
        ...docs.scope.context,
        changes: [{ status: 'M', path: 'packages/new/README.md' }],
      },
    },
    {
      ...docs.scope,
      context: { ...docs.scope.context, changes: [{ status: 'D', path: 'docs/mcp.md' }] },
    },
  ]) {
    write('docs.json', { ...docs, scope });
    assert.equal(
      collectBrowser(root, {
        ...META,
        job: BROWSER_JOBS[0],
        steps: browserSteps,
        documentation: docs.scope.context,
      }).passed,
      false,
      `Collection accepted ${JSON.stringify(scope)}`,
    );
    write(file, { ...browser, docs: { ...browser.docs, scope } });
    assert.equal(verifyRequired(root, options).passed, false);
  }
  write('docs.json', docs);
  write(file, browser);
  assert.equal(
    collectBrowser(root, {
      ...META,
      job: BROWSER_JOBS[0],
      steps: browserSteps,
      documentation: null,
    }).passed,
    false,
  );
  assert.equal(verifyRequired(root, { ...options, documentation: null }).passed, false);
  assert.equal(
    classifyFailureContainment(
      root,
      {
        ...options,
        documentation: null,
      },
      'ci',
    ).status,
    'contained',
  );
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

test('failure containment stays clear for successful CI evidence', (context) => {
  const { root, options } = artifacts(context);
  assert.deepEqual(classifyFailureContainment(root, options, 'ci'), {
    schemaVersion: 1,
    kind: 'failure-containment',
    ...META,
    scope: 'ci',
    status: 'clear',
    automaticRetry: false,
    automaticRepair: false,
    failures: [],
    categories: [],
    actions: [],
  });
});

test('failure containment classifies bounded diagnostics and fails closed on missing evidence', (context) => {
  const { root, options } = artifacts(context);
  const failedUnit = collectUnit(root, {
    ...META,
    job: UNIT_JOBS[0],
    steps: { ...unitSteps, tests: { outcome: 'failure' } },
  });
  fs.writeFileSync(
    path.join(root, `ci-unit-${UNIT_JOBS[0]}`, 'ci-unit.json'),
    JSON.stringify(failedUnit),
  );
  fs.rmSync(path.join(root, `ci-browser-${BROWSER_JOBS[0]}`, 'ci-browser.json'));
  const report = classifyFailureContainment(
    root,
    { ...options, needs: { ...options.needs, unit: { result: 'failure' } } },
    'ci',
  );
  assert.equal(report.status, 'contained');
  assert.equal(report.automaticRetry, false);
  assert.equal(report.automaticRepair, false);
  assert.deepEqual(report.categories, ['evidence', 'test']);
  assert.ok(report.failures.some((failure) => failure.includes('tests: required command')));
  assert.ok(report.failures.some((failure) => failure.includes('evidence unavailable or invalid')));
  assert.deepEqual(report.actions, [
    'Inspect missing or invalid CI evidence before retrying.',
    'Reproduce the failing test suite locally.',
  ]);
});

function improvementSnapshot(runId, revision, errors = []) {
  const metadata = { ...META, runId, revision };
  return {
    expected: {
      ...metadata,
      kind: 'required-validation',
      conclusion: errors.length === 0 ? 'success' : 'failure',
    },
    report: {
      schemaVersion: 1,
      kind: 'required-validation',
      ...metadata,
      passed: errors.length === 0,
      errors,
    },
  };
}

test('improvement reports track recurrence without inferring proof of a fix', () => {
  const failure = 'unit: required job did not succeed';
  const before = improvementSnapshot('123', 'a'.repeat(40), [failure]);
  const after = improvementSnapshot('124', 'd'.repeat(40), [failure]);
  const recurring = compareImprovementReports(before, after);
  assert.equal(recurring.status, 'reported');
  assert.equal(recurring.findings[0].status, 'recurring');
  assert.equal(recurring.findings[0].fixVerified, false);
  const cleared = compareImprovementReports(before, improvementSnapshot('125', 'e'.repeat(40)));
  assert.equal(cleared.findings[0].id, recurring.findings[0].id);
  assert.equal(cleared.findings[0].status, 'cleared');
  assert.equal(cleared.findings[0].fixVerified, false);
  assert.equal(cleared.automaticRetry, false);
  assert.equal(cleared.automaticRepair, false);
  const introduced = compareImprovementReports(improvementSnapshot('123', 'a'.repeat(40)), after);
  assert.equal(introduced.findings[0].status, 'new');
  assert.equal(
    compareImprovementReports(before, improvementSnapshot('124', 'a'.repeat(40))).findings[0]
      .status,
    'unverified',
  );
  assert.deepEqual(
    compareImprovementReports(
      improvementSnapshot('123', 'a'.repeat(40)),
      improvementSnapshot('124', 'd'.repeat(40)),
    ).findings,
    [],
  );
});

test('improvement reports cannot clear failures with missing or mismatched evidence', () => {
  const before = improvementSnapshot('123', 'a'.repeat(40), ['unit: required job did not succeed']);
  for (const mutate of [
    (snapshot) => {
      snapshot.report = null;
    },
    (snapshot) => {
      snapshot.report.revision = 'f'.repeat(40);
    },
    (snapshot) => {
      snapshot.expected.attempt = snapshot.report.attempt = '2';
    },
    (snapshot) => {
      snapshot.expected.conclusion = 'cancelled';
    },
    (snapshot) => {
      snapshot.report.errors = ['untrusted diagnostic content'];
    },
  ]) {
    const after = improvementSnapshot('124', 'd'.repeat(40));
    mutate(after);
    const report = compareImprovementReports(before, after);
    assert.equal(report.status, 'insufficient-evidence');
    assert.equal(report.findings[0].status, 'unverified');
    assert.equal(report.findings[0].fixVerified, false);
    assert.equal(JSON.stringify(report).includes('untrusted diagnostic content'), false);
  }
  assert.equal(compareImprovementReports(before, null).findings[0].status, 'unverified');
  assert.throws(() => compareImprovementReports(before, before));
});

test('improvement regression proof requires one named failing then passing test', (context) => {
  const { root, write } = fixture(context);
  const before = improvementSnapshot('123', 'a'.repeat(40), ['unit: required job did not succeed']);
  const after = improvementSnapshot('124', 'd'.repeat(40));
  const finding = compareImprovementReports(before, after).findings[0];
  const regression = {
    findingId: finding.id,
    job: 'linux-node24',
    suite: 'unit-core.json',
    testName: 'preserves a regression sentinel',
  };
  const evidence = (snapshot, passed) => {
    const tests = {
      success: passed,
      numTotalTests: 1,
      numPassedTests: passed ? 1 : 0,
      numFailedTests: passed ? 0 : 1,
      numPendingTests: 0,
      numFailedTestSuites: passed ? 0 : 1,
      testResults: [
        {
          assertionResults: [
            { fullName: regression.testName, status: passed ? 'passed' : 'failed' },
          ],
        },
      ],
    };
    write(regression.suite, tests);
    const unit = collectUnit(root, {
      ...snapshot.expected,
      job: regression.job,
      steps: { ...unitSteps, tests: { outcome: passed ? 'success' : 'failure' } },
    });
    return { expected: snapshot.expected, unit, tests };
  };
  const baseline = evidence(before, false);
  const candidate = evidence(after, true);
  const proof = verifyImprovementRegression(finding, regression, baseline, candidate);
  assert.equal(proof.verified, true);
  assert.equal(proof.reviewRequired, true);
  assert.equal(proof.before.revision, before.expected.revision);
  assert.equal(proof.after.revision, after.expected.revision);
  for (const mutate of [
    (value) => {
      value.tests.testResults[0].assertionResults[0].fullName = 'another test';
    },
    (value) => {
      value.unit.revision = baseline.expected.revision;
    },
    (value) => {
      value.tests.numTotalTests = 0;
    },
    (value) => {
      value.tests.testResults[0].assertionResults[0].status = 'skipped';
    },
    (value) => {
      value.expected.attempt = value.unit.attempt = '2';
    },
  ]) {
    const invalid = structuredClone(candidate);
    mutate(invalid);
    assert.equal(
      verifyImprovementRegression(finding, regression, baseline, invalid).verified,
      false,
    );
  }
  assert.equal(
    verifyImprovementRegression(
      { ...finding, status: 'recurring' },
      regression,
      baseline,
      candidate,
    ).verified,
    false,
  );
});

function improvementRepairEvidence(proof, repair) {
  return {
    repository: 'Vmoosky/SlipStream',
    branch: 'main',
    pull: {
      number: 7,
      commits: 1,
      state: 'closed',
      merged: true,
      merged_at: '2026-09-15T12:00:00Z',
      merge_commit_sha: proof.after.revision,
      base: { ref: 'main', repo: { full_name: 'Vmoosky/SlipStream' } },
      head: { sha: repair.fixCommit, repo: { full_name: 'Vmoosky/SlipStream' } },
      user: { id: 1 },
    },
    commits: [{ sha: repair.fixCommit }],
    comparison: {
      status: 'ahead',
      base_commit: { sha: proof.before.revision },
      merge_base_commit: { sha: proof.before.revision },
      total_commits: 1,
      commits: [{ sha: proof.after.revision }],
    },
    reviews: [
      {
        id: 10,
        state: 'APPROVED',
        user: { id: 2, type: 'User' },
        author_association: 'COLLABORATOR',
        commit_id: repair.fixCommit,
        submitted_at: '2026-09-15T11:00:00Z',
        pull_request_url: 'https://api.github.com/repos/Vmoosky/SlipStream/pulls/7',
      },
    ],
  };
}

test('improvement repair history requires a merged fix and final-head human approval', () => {
  const proof = {
    kind: 'regression-proof',
    findingId: 'b'.repeat(64),
    verified: true,
    before: { revision: 'a'.repeat(40) },
    after: { revision: 'd'.repeat(40) },
  };
  const repair = { fixCommit: 'c'.repeat(40), pullRequest: 7 };
  const evidence = improvementRepairEvidence(proof, repair);
  const result = verifyImprovementRepair(proof, repair, evidence);
  assert.equal(result.verified, true);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.automaticRepair, false);
  assert.equal(result.mergeCommit, proof.after.revision);
  assert.equal(result.reviews[0].commit, repair.fixCommit);
  for (const mutate of [
    (value) => (value.pull.head.repo.full_name = 'untrusted/fork'),
    (value) => (value.pull.base.ref = 'other'),
    (value) => (value.pull.merged = false),
    (value) => (value.pull.head.sha = 'HEAD'),
    (value) => (value.pull.user.id = 0),
    (value) => (value.pull.merge_commit_sha = 'e'.repeat(40)),
    (value) => (value.commits = []),
    (value) => (value.commits[0].sha = 'HEAD'),
    (value) => (value.pull.commits = 100),
    (value) => (value.comparison.base_commit.sha = 'e'.repeat(40)),
    (value) => (value.comparison.merge_base_commit.sha = 'e'.repeat(40)),
    (value) => (value.comparison.total_commits = 100),
    (value) => (value.comparison.commits = [{ sha: 'HEAD' }, { sha: proof.after.revision }]),
    (value) => (value.reviews[0].commit_id = 'e'.repeat(40)),
    (value) => (value.reviews[0].state = 'DISMISSED'),
    (value) => (value.reviews[0].user.id = 1),
    (value) => (value.reviews[0].user.type = 'Bot'),
    (value) => (value.reviews[0].author_association = 'NONE'),
    (value) => (value.reviews[0].submitted_at = '2026-09-15T13:00:00Z'),
    (value) => (value.reviews[0].pull_request_url += '0'),
    (value) => value.reviews.push({ ...value.reviews[0], id: 11, state: 'CHANGES_REQUESTED' }),
    (value) =>
      value.reviews.push({
        ...value.reviews[0],
        id: 9,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-09-15T11:30:00Z',
      }),
    (value) => (value.reviews = Array(100).fill(value.reviews[0])),
  ]) {
    const invalid = structuredClone(evidence);
    mutate(invalid);
    const rejected = verifyImprovementRepair(proof, repair, invalid);
    assert.equal(rejected.verified, false);
    assert.equal(rejected.missing.length, 1);
  }
  assert.equal(
    verifyImprovementRepair({ ...proof, verified: false }, repair, evidence).verified,
    false,
  );
  assert.deepEqual(verifyImprovementRepair(proof, undefined).missing, ['repair-reference']);
});

test('improvement archives read bounded JSON without extracting or accepting unsafe names', async (context) => {
  const { root, sentinel } = maintenanceRepository(context);
  const archive = (extra = []) =>
    execFileSync('git', ['archive', '--format=zip', ...extra, 'HEAD', 'package.json'], {
      cwd: root,
      timeout: 60_000,
    });
  const reports = await readImprovementArchive(archive(), ['package.json']);
  assert.equal(reports.get('package.json').name, 'slipstream-monorepo');
  await assert.rejects(readImprovementArchive(archive(), ['missing.json']));
  await assert.rejects(readImprovementArchive(archive(['--prefix=../']), ['package.json']));
  await assert.rejects(
    readImprovementArchive(archive(['--add-file=package.json']), ['package.json']),
  );
  await assert.rejects(readImprovementArchive(Buffer.from('not a zip'), ['package.json']));
  await assert.rejects(
    readImprovementArchive(Buffer.alloc(IMPROVEMENT_LIMITS.archiveBytes + 1), ['package.json']),
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Do not touch user data');
});

test('improvement downloads authenticate only to GitHub and verify the archive digest', async () => {
  const bytes = Buffer.from('synthetic archive bytes');
  const artifact = {
    id: 100,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
  const calls = [];
  const client = createImprovementClient(
    'Vmoosky/SlipStream',
    'synthetic-token',
    async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://fixture.blob.core.windows.net/artifact?sig=synthetic' },
          })
        : new Response(bytes);
    },
  );
  assert.deepEqual(await client.archive(artifact), bytes);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[1].options.redirect, 'error');
  const invalid = createImprovementClient(
    'Vmoosky/SlipStream',
    'synthetic-token',
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.invalid/artifact' },
      }),
  );
  await assert.rejects(invalid.archive(artifact));
  const mismatched = createImprovementClient(
    'Vmoosky/SlipStream',
    'synthetic-token',
    async (url) =>
      url.startsWith('https://api.github.com/')
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://fixture.blob.core.windows.net/artifact' },
          })
        : new Response(Buffer.from('different bytes')),
  );
  await assert.rejects(mismatched.archive(artifact));
  const oversized = createImprovementClient(
    'Vmoosky/SlipStream',
    'synthetic-token',
    async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
  );
  await assert.rejects(oversized.json('/actions/runs/123'));
  const resources = [];
  const metadata = createImprovementClient(
    'Vmoosky/SlipStream',
    'synthetic-token',
    async (url, options) => {
      resources.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      return new Response('{}');
    },
  );
  for (const resource of [
    '/pulls/7',
    '/pulls/7/reviews?per_page=100',
    '/pulls/7/commits?per_page=100',
    `/compare/${'a'.repeat(40)}...${'d'.repeat(40)}?per_page=100`,
  ])
    await metadata.json(resource);
  assert.equal(resources.length, 4);
  for (const resource of [
    '/issues/7',
    '/pulls/7/comments',
    '/pulls/7?other=true',
    '/compare/HEAD...main',
  ])
    await assert.rejects(metadata.json(resource));
  assert.equal(resources.length, 4);
});

function improvementHistory(context) {
  const { root } = maintenanceRepository(context);
  const emptyTree = execFileSync('git', ['mktree'], {
    cwd: root,
    input: '',
    encoding: 'utf8',
  }).trim();
  const archives = new Map();
  const runs = [];
  const artifactLists = new Map();
  const calls = [];
  for (const [workflow, kind, name, file, firstId] of [
    ['ci.yml', 'required-validation', 'ci-required', 'ci-required.json', 123],
    ['security.yml', 'security-validation', 'security-required', 'ci-security.json', 223],
  ]) {
    for (const offset of [0, 1]) {
      const run = {
        id: firstId + offset,
        run_attempt: 1,
        workflow_id: workflow === 'ci.yml' ? 10 : 20,
        name: workflow === 'ci.yml' ? 'CI' : 'Security',
        event: 'push',
        status: 'completed',
        head_sha: (offset === 0 ? 'a' : 'd').repeat(40),
        head_branch: 'main',
        path: `.github/workflows/${workflow}`,
        conclusion: offset === 0 ? 'failure' : 'success',
        repository: { full_name: 'Vmoosky/SlipStream' },
        head_repository: { full_name: 'Vmoosky/SlipStream' },
      };
      const report = {
        schemaVersion: 1,
        kind,
        revision: run.head_sha,
        runId: String(run.id),
        attempt: '1',
        eventName: 'push',
        workflow: `Vmoosky/SlipStream/${run.path}@refs/heads/main`,
        headRevision: run.head_sha,
        baseRevision: null,
        passed: offset === 1,
        errors:
          offset === 1
            ? []
            : [
                workflow === 'ci.yml'
                  ? 'unit: required job did not succeed'
                  : 'codeql: required analysis did not succeed',
              ],
      };
      fs.writeFileSync(path.join(root, file), JSON.stringify(report));
      const bytes = execFileSync(
        'git',
        ['archive', '--format=zip', `--add-file=${file}`, emptyTree],
        { cwd: root },
      );
      const artifact = {
        id: run.id + 1000,
        name,
        expired: false,
        size_in_bytes: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        workflow_run: { id: run.id, head_sha: run.head_sha },
      };
      runs.push(run);
      artifactLists.set(run.id, [artifact]);
      archives.set(artifact.id, bytes);
    }
  }
  const client = {
    async json(resource) {
      calls.push(resource);
      const runId = Number(resource.match(/\/runs\/(\d+)/)?.[1]);
      if (resource.includes('/artifacts?')) {
        const artifacts = artifactLists.get(runId);
        return { total_count: artifacts.length, artifacts };
      }
      if (runId) return runs.find((run) => run.id === runId);
      const workflow = resource.match(/\/workflows\/([^/]+)\/runs/)?.[1];
      return { workflow_runs: runs.filter((run) => run.path.endsWith(`/${workflow}`)) };
    },
    async archive(artifact) {
      return archives.get(artifact.id);
    },
  };
  return { root, emptyTree, runs, artifactLists, archives, calls, client };
}

test('improvement retained evidence requires an authenticated producer and intact original archives', async (context) => {
  const history = improvementHistory(context);
  const sourceRun = history.runs[0];
  const sourceArtifact = history.artifactLists.get(sourceRun.id)[0];
  const producer = {
    ...history.runs[1],
    id: 300,
    head_sha: 'f'.repeat(40),
    path: '.github/workflows/improvement.yml',
    event: 'schedule',
    updated_at: new Date().toISOString(),
  };
  const bundle = {
    schemaVersion: 1,
    kind: 'retained-improvement-evidence',
    repository: 'Vmoosky/SlipStream',
    branch: 'main',
    collector: {
      revision: producer.head_sha,
      runId: '300',
      attempt: '1',
      eventName: 'schedule',
      workflow: 'Vmoosky/SlipStream/.github/workflows/improvement.yml@refs/heads/main',
    },
    entries: [
      {
        run: sourceRun,
        artifact: sourceArtifact,
        capturedAt: producer.updated_at,
        archive: history.archives.get(sourceArtifact.id).toString('base64'),
      },
    ],
  };
  const check = (value = bundle, mutate = () => {}) => {
    fs.writeFileSync(path.join(history.root, 'evidence.json'), JSON.stringify(value));
    const bytes = execFileSync(
      'git',
      ['archive', '--format=zip', '--add-file=evidence.json', history.emptyTree],
      { cwd: history.root },
    );
    const options = {
      repository: bundle.repository,
      branch: bundle.branch,
      run: structuredClone(producer),
      artifact: {
        id: 2000,
        name: 'continuous-improvement-evidence-300-1',
        expired: false,
        size_in_bytes: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        workflow_run: { id: producer.id, head_sha: producer.head_sha },
      },
    };
    mutate(options);
    return readRetainedImprovementEvidence(bytes, options);
  };
  const retained = await check();
  assert.equal(retained.size, 1);
  assert.deepEqual(retained.get('123/ci-required').bytes, history.archives.get(sourceArtifact.id));
  const completionBundle = structuredClone(bundle);
  completionBundle.collector.eventName = 'workflow_run';
  completionBundle.collector.trigger = {
    workflow: 'ci.yml',
    workflowId: '10',
    runId: '124',
    attempt: '1',
    revision: 'd'.repeat(40),
    eventName: 'push',
    conclusion: 'success',
  };
  const completed = await check(
    completionBundle,
    (options) => (options.run.event = 'workflow_run'),
  );
  assert.equal(completed.size, 1);
  assert.equal(completed.get('123/ci-required').capturedAt, bundle.entries[0].capturedAt);
  for (const trigger of [
    undefined,
    ...[
      { workflow: 'maintenance.yml' },
      { workflowId: '0' },
      { runId: '../124' },
      { runId: '300' },
      { attempt: '2' },
      { revision: 'HEAD' },
      { eventName: 'pull_request' },
      { conclusion: null },
      { unexpected: 'extra' },
    ].map((change) => ({ ...completionBundle.collector.trigger, ...change })),
  ]) {
    const invalid = structuredClone(completionBundle);
    invalid.collector.trigger = trigger;
    await assert.rejects(check(invalid, (options) => (options.run.event = 'workflow_run')));
  }
  const manualBundle = structuredClone(bundle);
  manualBundle.collector.eventName = 'workflow_dispatch';
  assert.equal(
    (await check(manualBundle, (options) => (options.run.event = 'workflow_dispatch'))).size,
    1,
  );
  fs.writeFileSync(path.join(history.root, 'unexpected.json'), '{"synthetic":"unrequested"}');
  const unexpectedBytes = execFileSync(
    'git',
    [
      'archive',
      '--format=zip',
      '--add-file=ci-required.json',
      '--add-file=unexpected.json',
      history.emptyTree,
    ],
    { cwd: history.root },
  );
  const unexpected = structuredClone(bundle);
  unexpected.entries[0].archive = unexpectedBytes.toString('base64');
  unexpected.entries[0].artifact.size_in_bytes = unexpectedBytes.length;
  unexpected.entries[0].artifact.digest = `sha256:${createHash('sha256').update(unexpectedBytes).digest('hex')}`;
  await assert.rejects(check(unexpected));
  for (const mutate of [
    (value) => (value.collector.revision = 'e'.repeat(40)),
    (value) => (value.collector.attempt = '2'),
    (value) => (value.repository = 'untrusted/fork'),
    (value) => (value.entries[0].run.event = 'pull_request'),
    (value) => (value.entries[0].run.run_attempt = 2),
    (value) => (value.entries[0].run.head_sha = 'e'.repeat(40)),
    (value) => (value.entries[0].capturedAt = '2999-01-01T00:00:00Z'),
    (value) => (value.entries[0].capturedAt = '2020-01-01T00:00:00Z'),
    (value) => (value.entries[0].archive = Buffer.from('different bytes').toString('base64')),
    (value) => (value.entries[0].archive += '\n'),
    (value) => (value.entries[0].artifact.expired = true),
    (value) => value.entries.push(value.entries[0]),
    (value) => (value.entries = Array(17).fill(value.entries[0])),
  ]) {
    const invalid = structuredClone(bundle);
    mutate(invalid);
    await assert.rejects(check(invalid));
  }
  for (const mutate of [
    (value) => (value.run.event = 'pull_request'),
    (value) => (value.run.run_attempt = 2),
    (value) => (value.run.conclusion = 'failure'),
    (value) => (value.run.head_repository.full_name = 'untrusted/fork'),
    (value) => (value.artifact.expired = true),
    (value) => (value.artifact.digest = `sha256:${'0'.repeat(64)}`),
  ])
    await assert.rejects(check(bundle, mutate));
});

test('improvement collection compares exact run artifacts and treats expiry as insufficient evidence', async (context) => {
  const history = improvementHistory(context);
  const options = { repository: 'Vmoosky/SlipStream', branch: 'main', client: history.client };
  const report = await collectImprovementReports(options);
  assert.equal(report.status, 'reported');
  assert.equal(report.comparisons.length, 2);
  assert.equal(report.evidence.length, 4);
  assert.ok(report.comparisons.every((comparison) => comparison.findings[0].status === 'cleared'));
  assert.ok(report.comparisons.every((comparison) => comparison.findings[0].fixVerified === false));
  history.artifactLists.get(124)[0].expired = true;
  const expired = await collectImprovementReports(options);
  assert.equal(expired.status, 'insufficient-evidence');
  assert.equal(expired.comparisons[0].findings[0].status, 'unverified');
  assert.ok(expired.errors.some((error) => error.includes('run 124')));
  history.artifactLists.get(124)[0].expired = false;
  history.runs[1].head_repository.full_name = 'untrusted/fork';
  assert.equal((await collectImprovementReports(options)).status, 'insufficient-evidence');
});

test('improvement completion collection stays bound to its triggering run and API identity', async (context) => {
  const history = improvementHistory(context);
  const options = { repository: 'Vmoosky/SlipStream', branch: 'main', client: history.client };
  const trigger = {
    workflow: 'ci.yml',
    workflowId: '10',
    runId: '124',
    attempt: '1',
    revision: 'd'.repeat(40),
    eventName: 'push',
    conclusion: 'success',
  };
  history.runs.push({ ...history.runs[1], id: 125, head_sha: 'e'.repeat(40) });
  const report = await collectImprovementReports({ ...options, trigger });
  assert.equal(report.status, 'reported');
  assert.equal(report.comparisons.length, 1);
  assert.equal(report.comparisons[0].before.runId, '123');
  assert.equal(report.comparisons[0].after.runId, '124');
  assert.deepEqual(report.trigger, {
    ...trigger,
    verified: true,
    url: 'https://github.com/Vmoosky/SlipStream/actions/runs/124',
  });
  assert.deepEqual(
    report.evidence.map((entry) => entry.runId),
    ['123', '124'],
  );
  assert.ok(history.calls.includes('/actions/runs/124'));
  assert.ok(history.calls.every((resource) => !/security\.yml|\/runs\/125/.test(resource)));
  const security = await collectImprovementReports({
    ...options,
    trigger: { ...trigger, workflow: 'security.yml', workflowId: '20', runId: '224' },
  });
  assert.equal(security.status, 'reported');
  assert.equal(security.comparisons.length, 1);
  assert.equal(security.comparisons[0].after.runId, '224');
  for (const invalid of [
    { id: 125 },
    { run_attempt: 2 },
    { workflow_id: 20 },
    { name: 'Security' },
    { path: '.github/workflows/security.yml' },
    { head_sha: 'e'.repeat(40) },
    { conclusion: 'failure' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { head_branch: 'other' },
    { repository: { full_name: 'untrusted/fork' } },
    { head_repository: { full_name: 'untrusted/fork' } },
  ]) {
    const rejected = await collectImprovementReports({
      ...options,
      trigger,
      client: {
        ...history.client,
        async json(resource) {
          const result = await history.client.json(resource);
          return resource === '/actions/runs/124' ? { ...result, ...invalid } : result;
        },
      },
    });
    assert.equal(rejected.status, 'insufficient-evidence');
    assert.equal(rejected.trigger.verified, false);
    assert.deepEqual(rejected.evidence, []);
  }
  const missing = await collectImprovementReports({
    ...options,
    trigger,
    client: {
      ...history.client,
      async json(resource) {
        const result = await history.client.json(resource);
        return resource.includes('/workflows/ci.yml/runs')
          ? { workflow_runs: result.workflow_runs.filter((run) => run.id > 124) }
          : result;
      },
    },
  });
  assert.equal(missing.status, 'insufficient-evidence');
  assert.equal(missing.comparisons[0].before, null);
  assert.equal(missing.comparisons[0].after.runId, '124');
  assert.ok(missing.errors.some((error) => error.includes('no older completed run')));
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
    history.runs[1].conclusion = conclusion;
    const failed = await collectImprovementReports({
      ...options,
      trigger: { ...trigger, conclusion },
    });
    assert.equal(failed.trigger.verified, true);
    assert.equal(failed.trigger.conclusion, conclusion);
    assert.equal(failed.status, 'insufficient-evidence');
    assert.ok(failed.comparisons[0].findings.every((finding) => finding.status !== 'cleared'));
  }
  history.runs[1].conclusion = 'failure';
  const artifact = history.artifactLists.get(124)[0];
  const failedAggregate = (
    await readImprovementArchive(history.archives.get(artifact.id), ['ci-required.json'])
  ).get('ci-required.json');
  failedAggregate.passed = false;
  failedAggregate.errors = ['unit: required job did not succeed'];
  fs.writeFileSync(path.join(history.root, 'ci-required.json'), JSON.stringify(failedAggregate));
  const failedBytes = execFileSync(
    'git',
    ['archive', '--format=zip', '--add-file=ci-required.json', history.emptyTree],
    { cwd: history.root },
  );
  artifact.size_in_bytes = failedBytes.length;
  artifact.digest = `sha256:${createHash('sha256').update(failedBytes).digest('hex')}`;
  history.archives.set(artifact.id, failedBytes);
  const failureReport = await collectImprovementReports({
    ...options,
    trigger: { ...trigger, conclusion: 'failure' },
  });
  assert.equal(failureReport.status, 'reported');
  assert.equal(failureReport.trigger.conclusion, 'failure');
  assert.equal(failureReport.comparisons[0].findings[0].status, 'recurring');
  assert.equal(failureReport.comparisons[0].findings[0].fixVerified, false);
});

test('improvement registry connects an explicit run pair to a verified regression artifact', async (context) => {
  const history = improvementHistory(context);
  const options = { repository: 'Vmoosky/SlipStream', branch: 'main', client: history.client };
  const initial = await collectImprovementReports(options);
  const regression = {
    findingId: initial.comparisons[0].findings[0].id,
    job: 'linux-node24',
    suite: 'unit-core.json',
    testName: 'preserves regression input',
    beforeRunId: '123',
    afterRunId: '124',
  };
  const registry = { schemaVersion: 1, regressions: [regression] };
  const { root, write } = fixture(context);
  for (const run of history.runs.filter((entry) => entry.path.endsWith('/ci.yml'))) {
    const passed = run.conclusion === 'success';
    const tests = {
      success: passed,
      numTotalTests: 1,
      numPassedTests: passed ? 1 : 0,
      numFailedTests: passed ? 0 : 1,
      numPendingTests: 0,
      numFailedTestSuites: passed ? 0 : 1,
      testResults: [
        {
          assertionResults: [
            { fullName: regression.testName, status: passed ? 'passed' : 'failed' },
          ],
        },
      ],
    };
    write(regression.suite, tests);
    const unit = collectUnit(root, {
      ...initial.comparisons[0][passed ? 'after' : 'before'],
      job: regression.job,
      steps: { ...unitSteps, tests: { outcome: passed ? 'success' : 'failure' } },
    });
    fs.writeFileSync(path.join(history.root, 'ci-unit.json'), JSON.stringify(unit));
    fs.writeFileSync(path.join(history.root, regression.suite), JSON.stringify(tests));
    const bytes = execFileSync(
      'git',
      [
        'archive',
        '--format=zip',
        '--add-file=ci-unit.json',
        `--add-file=${regression.suite}`,
        history.emptyTree,
      ],
      { cwd: history.root },
    );
    const artifact = {
      id: run.id + 2000,
      name: `ci-unit-${regression.job}`,
      expired: false,
      size_in_bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      workflow_run: { id: run.id, head_sha: run.head_sha },
    };
    history.artifactLists.get(run.id).push(artifact);
    history.archives.set(artifact.id, bytes);
  }
  const report = await collectImprovementReports({ ...options, registry });
  assert.equal(report.status, 'reported');
  assert.equal(report.regressions[0].verified, true);
  assert.equal(report.regressions[0].reviewRequired, true);
  assert.equal(report.evidence.length, 6);
  assert.equal(report.retention.status, 'ready');
  assert.equal(report.retainedEvidence.entries.length, 4);
  assert.equal(report.repairHistoryStatus, 'insufficient-evidence');
  assert.deepEqual(report.repairs[0].missing, ['repair-reference']);
  const originals = [];
  for (const runId of [123, 124]) {
    const artifact = history.artifactLists.get(runId)[1];
    const bytes = history.archives.get(artifact.id);
    originals.push({ artifact, metadata: structuredClone(artifact), bytes });
    const reports = await readImprovementArchive(bytes, ['ci-unit.json', regression.suite]);
    fs.writeFileSync(
      path.join(history.root, 'ci-unit.json'),
      JSON.stringify({
        ...reports.get('ci-unit.json'),
        retentionLimitFixture: 'x'.repeat(2 * 1024 * 1024),
      }),
    );
    fs.writeFileSync(
      path.join(history.root, regression.suite),
      JSON.stringify(reports.get(regression.suite)),
    );
    const oversized = execFileSync(
      'git',
      [
        'archive',
        '--format=zip',
        '-0',
        '--add-file=ci-unit.json',
        `--add-file=${regression.suite}`,
        history.emptyTree,
      ],
      { cwd: history.root, maxBuffer: 4 * 1024 * 1024 },
    );
    artifact.size_in_bytes = oversized.length;
    artifact.digest = `sha256:${createHash('sha256').update(oversized).digest('hex')}`;
    history.archives.set(artifact.id, oversized);
  }
  const overLimit = await collectImprovementReports({ ...options, registry });
  assert.equal(overLimit.regressions[0].verified, true);
  assert.equal(overLimit.status, 'insufficient-evidence');
  assert.equal(overLimit.retention.status, 'insufficient-evidence');
  assert.match(overLimit.retention.errors[0], /retention budget/);
  assert.deepEqual(overLimit.retainedEvidence.entries, []);
  for (const original of originals) {
    Object.assign(original.artifact, original.metadata);
    history.archives.set(original.artifact.id, original.bytes);
  }
  const repair = { fixCommit: 'c'.repeat(40), pullRequest: 7 };
  const linkedRegistry = { schemaVersion: 1, regressions: [{ ...regression, repair }] };
  const details = improvementRepairEvidence(report.regressions[0], repair);
  const responses = new Map([
    ['/pulls/7', details.pull],
    ['/pulls/7/commits?per_page=100', details.commits],
    ['/pulls/7/reviews?per_page=100', details.reviews],
    [`/compare/${'a'.repeat(40)}...${'d'.repeat(40)}?per_page=100`, details.comparison],
  ]);
  const linkedClient = {
    ...history.client,
    json: (resource) =>
      responses.has(resource) ? responses.get(resource) : history.client.json(resource),
  };
  const linked = await collectImprovementReports({
    ...options,
    registry: linkedRegistry,
    client: linkedClient,
  });
  assert.equal(linked.status, 'reported');
  assert.equal(linked.repairHistoryStatus, 'verified');
  assert.equal(linked.repairs[0].verified, true);
  details.reviews[0].commit_id = 'e'.repeat(40);
  const stale = await collectImprovementReports({
    ...options,
    registry: linkedRegistry,
    client: linkedClient,
  });
  assert.equal(stale.status, 'insufficient-evidence');
  assert.equal(stale.regressions[0].verified, true);
  assert.equal(stale.repairs[0].verified, false);
  for (const invalidRepair of [
    null,
    { ...repair, command: 'not allowed' },
    { ...repair, fixCommit: 'HEAD' },
    { ...repair, pullRequest: '7' },
  ]) {
    assert.throws(() =>
      validateImprovementRegistry({
        schemaVersion: 1,
        regressions: [{ ...regression, repair: invalidRepair }],
      }),
    );
  }
  const invalid = structuredClone(registry);
  invalid.regressions[0].testName = 'unobserved test';
  assert.equal(
    (await collectImprovementReports({ ...options, registry: invalid })).status,
    'insufficient-evidence',
  );
  assert.throws(() =>
    validateImprovementRegistry({ schemaVersion: 1, regressions: [regression, regression] }),
  );
  assert.throws(() =>
    validateImprovementRegistry({
      schemaVersion: 1,
      regressions: [{ ...regression, command: 'not allowed' }],
    }),
  );
  assert.throws(() =>
    validateImprovementRegistry({
      schemaVersion: 1,
      regressions: [{ ...regression, afterRunId: '122' }],
    }),
  );
  const producer = {
    ...history.runs[1],
    id: 300,
    path: '.github/workflows/improvement.yml',
    event: 'schedule',
    head_sha: 'f'.repeat(40),
    updated_at: new Date().toISOString(),
  };
  const retainedBundle = {
    ...report.retainedEvidence,
    collector: {
      revision: producer.head_sha,
      workflow: 'Vmoosky/SlipStream/.github/workflows/improvement.yml@refs/heads/main',
      eventName: 'schedule',
      runId: '300',
      attempt: '1',
    },
  };
  fs.writeFileSync(path.join(history.root, 'evidence.json'), JSON.stringify(retainedBundle));
  const retainedBytes = execFileSync(
    'git',
    ['archive', '--format=zip', '--add-file=evidence.json', history.emptyTree],
    { cwd: history.root },
  );
  const retainedArtifact = {
    id: 5000,
    name: 'continuous-improvement-evidence-300-1',
    expired: false,
    size_in_bytes: retainedBytes.length,
    digest: `sha256:${createHash('sha256').update(retainedBytes).digest('hex')}`,
    workflow_run: { id: producer.id, head_sha: producer.head_sha },
  };
  history.runs.push(producer);
  history.artifactLists.set(producer.id, [retainedArtifact]);
  history.archives.set(retainedArtifact.id, retainedBytes);
  for (const runId of [123, 124]) {
    for (const artifact of history.artifactLists.get(runId)) artifact.expired = true;
  }
  const recovered = await collectImprovementReports({ ...options, registry });
  assert.equal(recovered.status, 'reported');
  assert.equal(recovered.regressions[0].verified, true);
  assert.equal(recovered.retention.recoveredArchives, 4);
  assert.ok(
    recovered.evidence
      .filter((entry) => entry.source === 'retained')
      .every((entry) => entry.retainedFrom.digest === retainedArtifact.digest),
  );
  assert.deepEqual(
    recovered.retainedEvidence.entries.map((entry) => entry.capturedAt),
    report.retainedEvidence.entries.map((entry) => entry.capturedAt),
  );
  producer.event = 'workflow_run';
  retainedBundle.collector.eventName = 'workflow_run';
  retainedBundle.collector.trigger = {
    workflow: 'ci.yml',
    workflowId: '10',
    runId: '124',
    attempt: '1',
    revision: 'd'.repeat(40),
    eventName: 'push',
    conclusion: 'success',
  };
  fs.writeFileSync(path.join(history.root, 'evidence.json'), JSON.stringify(retainedBundle));
  const completionBytes = execFileSync(
    'git',
    ['archive', '--format=zip', '--add-file=evidence.json', history.emptyTree],
    { cwd: history.root },
  );
  retainedArtifact.size_in_bytes = completionBytes.length;
  retainedArtifact.digest = `sha256:${createHash('sha256').update(completionBytes).digest('hex')}`;
  history.archives.set(retainedArtifact.id, completionBytes);
  const completionRecovery = await collectImprovementReports({ ...options, registry });
  assert.equal(completionRecovery.status, 'reported');
  assert.equal(completionRecovery.retention.recoveredArchives, 4);
  assert.deepEqual(
    completionRecovery.retainedEvidence.entries.map((entry) => entry.capturedAt),
    report.retainedEvidence.entries.map((entry) => entry.capturedAt),
  );
  retainedArtifact.expired = true;
  assert.equal(
    (await collectImprovementReports({ ...options, registry })).status,
    'insufficient-evidence',
  );
  retainedArtifact.expired = false;
  history.runs[1].run_attempt = 2;
  assert.equal(
    (await collectImprovementReports({ ...options, registry })).status,
    'insufficient-evidence',
  );
  history.runs[1].run_attempt = 1;
  history.artifactLists.get(124)[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.equal(
    (await collectImprovementReports({ ...options, registry })).status,
    'insufficient-evidence',
  );
  history.artifactLists.set(123, []);
  history.artifactLists.set(124, []);
  const removed = await collectImprovementReports({ ...options, registry });
  assert.equal(removed.status, 'reported');
  assert.equal(removed.retention.recoveredArchives, 4);
  const unregistered = await collectImprovementReports(options);
  assert.equal(unregistered.status, 'insufficient-evidence');
  assert.equal(unregistered.retention.recoveredArchives, 0);
});

test('improvement workflow is opt-in, default-branch-only, read-only and artifact-producing', () => {
  const workflow = parse(
    fs.readFileSync(path.join(REPO, '.github/workflows/improvement.yml'), 'utf8'),
  );
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'schedule',
    'workflow_dispatch',
    'workflow_run',
  ]);
  assert.equal(workflow.on.schedule[0].cron, '0 8 * * *');
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ['CI', 'Security'],
    types: ['completed'],
  });
  assert.deepEqual(
    workflow.on.workflow_run.workflows,
    ['ci.yml', 'security.yml'].map(
      (file) => parse(fs.readFileSync(path.join(REPO, '.github/workflows', file), 'utf8')).name,
    ),
  );
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(
    workflow.concurrency.group,
    "improvement-${{ github.repository }}-${{ github.event.workflow_run.id || 'scheduled' }}",
  );
  const job = workflow.jobs.report;
  assert.equal(
    job.if.replace(/\s+/g, ' '),
    [
      "${{ vars.SLIPSTREAM_IMPROVEMENT_ENABLED == 'true' &&",
      "(github.event_name != 'workflow_run' ||",
      "(github.event.action == 'completed' &&",
      "github.event.workflow_run.event == 'push' &&",
      'github.event.workflow_run.head_branch == github.event.repository.default_branch &&',
      'github.event.workflow_run.repository.full_name == github.repository &&',
      'github.event.workflow_run.head_repository.full_name == github.repository &&',
      'github.event.workflow_run.run_attempt == 1)) }}',
    ].join(' '),
  );
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', 'pull-requests': 'read' });
  assert.equal(job['timeout-minutes'], 10);
  assert.equal(job['continue-on-error'], undefined);
  assert.match(job.steps[0].run, /test "\$GITHUB_REF" = "refs\/heads\/\$DEFAULT_BRANCH"/);
  assert.match(job.steps[0].run, /test "\$GITHUB_RUN_ATTEMPT" = '1'/);
  for (const [variable, expected] of [
    ['SOURCE_EVENT', "'push'"],
    ['SOURCE_BRANCH', '"$DEFAULT_BRANCH"'],
    ['SOURCE_REPOSITORY', '"$GITHUB_REPOSITORY"'],
    ['SOURCE_HEAD_REPOSITORY', '"$GITHUB_REPOSITORY"'],
    ['SOURCE_ATTEMPT', "'1'"],
  ])
    assert.ok(job.steps[0].run.includes(`test "$${variable}" = ${expected}`));
  const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(job.steps.every((step) => !step.uses || /@[a-f0-9]{40}$/.test(step.uses)));
  assert.ok(job.steps.every((step) => step['continue-on-error'] === undefined));
  const retained = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.match(retained.if, /always\(\)/);
  assert.equal(retained.with['retention-days'], IMPROVEMENT_LIMITS.retentionDays);
  assert.equal(retained.with['if-no-files-found'], 'error');
  assert.match(retained.with.path, /report\.json/);
  const originals = job.steps.find((step) =>
    step.with?.name?.startsWith('continuous-improvement-evidence-'),
  );
  assert.equal(originals.if, "${{ success() && steps.review.outcome == 'success' }}");
  assert.equal(originals.with['retention-days'], IMPROVEMENT_LIMITS.retentionDays);
  assert.equal(originals.with.path, '${{ steps.review.outputs.evidence-path }}');
  assert.equal(originals.with['if-no-files-found'], 'error');
  assert.deepEqual(
    job.outputs,
    Object.fromEntries(
      [
        'status',
        'report-path',
        'evidence-path',
        'trigger-workflow',
        'trigger-run-id',
        'trigger-attempt',
        'trigger-revision',
        'trigger-conclusion',
        'trigger-verified',
      ].map((name) => [name, `\${{ steps.review.outputs.${name} }}`]),
    ),
  );
  assert.ok(job.steps.some((step) => step.run === 'npm run improvement:report'));
  const registry = JSON.parse(
    fs.readFileSync(path.join(REPO, '.github/improvement-regressions.json'), 'utf8'),
  );
  assert.ok(Array.isArray(validateImprovementRegistry(registry)));
});

test('improvement runner preserves the checkout and separates local from workflow evidence', async (context) => {
  const history = improvementHistory(context);
  fs.mkdirSync(path.join(history.root, '.github'), { recursive: true });
  fs.writeFileSync(
    path.join(history.root, '.github/improvement-regressions.json'),
    JSON.stringify({ schemaVersion: 1, regressions: [] }),
  );
  const event = { repository: { full_name: 'Vmoosky/SlipStream', default_branch: 'main' } };
  const env = {
    GITHUB_ACTIONS: 'true',
    SLIPSTREAM_IMPROVEMENT_ENABLED: 'true',
    GITHUB_REPOSITORY: 'Vmoosky/SlipStream',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'Vmoosky/SlipStream/.github/workflows/improvement.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_SHA: 'f'.repeat(40),
    GITHUB_RUN_ID: '300',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_OUTPUT: path.join(history.root, 'step-outputs'),
  };
  const result = await runImprovementReview(history.root, { env, event, client: history.client });
  assert.equal(result.report.status, 'reported');
  assert.equal(result.report.collector.revision, env.GITHUB_SHA);
  assert.equal(result.report.source, 'github-actions');
  assert.ok(fs.existsSync(path.join(history.root, result.outputDirectory, 'report.json')));
  assert.ok(fs.existsSync(path.join(history.root, result.outputDirectory, 'summary.md')));
  const retainedBundle = JSON.parse(
    fs.readFileSync(path.join(history.root, result.outputDirectory, 'evidence.json'), 'utf8'),
  );
  assert.equal(retainedBundle.kind, 'retained-improvement-evidence');
  assert.deepEqual(retainedBundle.collector, result.report.collector);
  assert.deepEqual(retainedBundle.entries, []);
  assert.equal(result.report.retainedEvidence, undefined);
  const outputs = (file) =>
    Object.fromEntries(
      fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => line.split('=')),
    );
  assert.deepEqual(outputs(env.GITHUB_OUTPUT), {
    status: 'reported',
    'report-path': `${result.outputDirectory}/report.json`,
    'evidence-path': `${result.outputDirectory}/evidence.json`,
    'trigger-workflow': '',
    'trigger-run-id': '',
    'trigger-attempt': '',
    'trigger-revision': '',
    'trigger-conclusion': '',
    'trigger-verified': '',
  });
  assert.equal(
    fs.readFileSync(path.join(history.root, '.slipstream/user-sentinel'), 'utf8'),
    'Do not touch user data',
  );
  for (const invalid of [
    { SLIPSTREAM_IMPROVEMENT_ENABLED: '' },
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_REF: 'untrusted' },
    { GITHUB_REPOSITORY: 'untrusted/fork' },
    { GITHUB_API_URL: 'https://untrusted.invalid' },
    { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_SHA: 'HEAD' },
  ])
    assert.throws(() => improvementIdentity({ ...env, ...invalid }, event));
  const completionEnv = {
    ...env,
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_OUTPUT: path.join(history.root, 'completion-outputs'),
    GITHUB_STEP_SUMMARY: path.join(history.root, 'completion-summary'),
  };
  const completion = {
    ...event,
    action: 'completed',
    workflow_run: {
      id: 124,
      run_attempt: 1,
      workflow_id: 10,
      name: 'CI',
      path: '.github/workflows/ci.yml',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'd'.repeat(40),
      head_branch: 'main',
      repository: { full_name: env.GITHUB_REPOSITORY },
      head_repository: { full_name: env.GITHUB_REPOSITORY },
    },
  };
  const identity = improvementIdentity(completionEnv, completion);
  assert.equal(identity.revision, env.GITHUB_SHA);
  assert.deepEqual(identity.trigger, {
    workflow: 'ci.yml',
    workflowId: '10',
    runId: '124',
    attempt: '1',
    revision: 'd'.repeat(40),
    eventName: 'push',
    conclusion: 'success',
  });
  for (const invalid of [
    { id: 0 },
    { id: 300 },
    { id: 301 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { run_attempt: 2 },
    { workflow_id: 0 },
    { name: 'Security' },
    { path: '.github/workflows/maintenance.yml' },
    { event: 'pull_request' },
    { status: 'in_progress' },
    { conclusion: null },
    { head_sha: 'HEAD' },
    { head_branch: 'other' },
    { repository: { full_name: 'untrusted/fork' } },
    { head_repository: { full_name: 'untrusted/fork' } },
  ])
    assert.throws(() =>
      improvementIdentity(completionEnv, {
        ...completion,
        workflow_run: { ...completion.workflow_run, ...invalid },
      }),
    );
  assert.throws(() => improvementIdentity(completionEnv, { ...completion, action: 'requested' }));
  assert.throws(() => improvementIdentity(completionEnv, event));
  const completed = await runImprovementReview(history.root, {
    env: completionEnv,
    event: completion,
    client: history.client,
  });
  assert.equal(completed.report.status, 'reported');
  assert.equal(completed.report.comparisons.length, 1);
  assert.deepEqual(completed.report.collector.trigger, identity.trigger);
  assert.deepEqual(outputs(completionEnv.GITHUB_OUTPUT), {
    status: 'reported',
    'report-path': `${completed.outputDirectory}/report.json`,
    'evidence-path': `${completed.outputDirectory}/evidence.json`,
    'trigger-workflow': 'ci.yml',
    'trigger-run-id': '124',
    'trigger-attempt': '1',
    'trigger-revision': 'd'.repeat(40),
    'trigger-conclusion': 'success',
    'trigger-verified': 'true',
  });
  const completionSummary = fs.readFileSync(completionEnv.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(completionSummary, /ci\.yml run 124, attempt 1/);
  const summaryUrls = completionSummary.match(/https?:\/\/[^\s)]+/g) ?? [];
  assert.ok(
    summaryUrls.some((value) => {
      try {
        const parsed = new URL(value);
        return (
          parsed.protocol === 'https:' &&
          parsed.host === 'github.com' &&
          parsed.pathname === '/Vmoosky/SlipStream/actions/runs/124'
        );
      } catch {
        return false;
      }
    }),
  );
  assert.ok(completionSummary.includes(`Source revision: ${'d'.repeat(40)}`));
  assert.ok(completionSummary.includes(`Collector revision: ${env.GITHUB_SHA}`));
  history.runs[1].conclusion = 'failure';
  const failed = await runImprovementReview(history.root, {
    env: completionEnv,
    event: { ...completion, workflow_run: { ...completion.workflow_run, conclusion: 'failure' } },
    client: history.client,
  });
  assert.equal(failed.report.status, 'insufficient-evidence');
  assert.equal(outputs(completionEnv.GITHUB_OUTPUT).status, 'insufficient-evidence');
  assert.equal(outputs(completionEnv.GITHUB_OUTPUT)['trigger-conclusion'], 'failure');
  const input = path.join(history.root, 'local-evidence.json');
  fs.writeFileSync(
    input,
    JSON.stringify({
      schemaVersion: 1,
      before: improvementSnapshot('123', 'a'.repeat(40), ['unit: required job did not succeed']),
      after: improvementSnapshot('124', 'd'.repeat(40)),
    }),
  );
  const local = await runImprovementReview(history.root, { env: {}, input });
  assert.equal(local.report.source, 'local-unverified');
  assert.equal(local.report.collector, undefined);
  assert.equal(
    fs.existsSync(path.join(history.root, local.outputDirectory, 'evidence.json')),
    false,
  );
  assert.equal(local.report.comparisons[0].findings[0].fixVerified, false);
  assert.notEqual(local.outputDirectory, result.outputDirectory);
  await assert.rejects(runImprovementReview(history.root, { env, event, input }));
  const command = [path.join(REPO, 'scripts/check-improvement.mjs'), '--input', input];
  const commandOptions = {
    cwd: history.root,
    env: { ...process.env, GITHUB_ACTIONS: 'false' },
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 30_000,
  };
  const cli = JSON.parse(execFileSync(process.execPath, command, commandOptions));
  assert.equal(cli.source, 'local-unverified');
  assert.equal(cli.status, 'reported');
  assert.match(cli.outputDirectory, /^test-results\/improvement\/run-[A-Za-z0-9]{6}$/);
  const cliOutput = path.join(REPO, cli.outputDirectory);
  context.after(() => fs.rmSync(cliOutput, { recursive: true, force: true }));
  const retained = JSON.parse(fs.readFileSync(path.join(cliOutput, 'report.json'), 'utf8'));
  assert.equal(retained.source, 'local-unverified');
  assert.equal(retained.comparisons[0].findings[0].fixVerified, false);
  fs.writeFileSync(input, 'not json');
  assert.throws(() => execFileSync(process.execPath, command, commandOptions));
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
    actions: 'read',
    'security-events': 'write',
  });
  assert.ok(workflow.jobs.codeql.steps.every((step) => !step.run));
  assert.equal(workflow.jobs['security-required'].if, '${{ always() }}');
  assert.deepEqual(workflow.jobs['security-required'].needs, ['codeql', 'dependency-review']);
  const containment = workflow.jobs['security-required'].steps.find((step) =>
    step.run?.endsWith('check-ci.mjs contain-security'),
  );
  assert.equal(containment.if, '${{ always() }}');
  assert.equal(containment.env.CI_NEEDS, '${{ toJSON(needs) }}');
  const retained = workflow.jobs['security-required'].steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.match(retained.with.path, /test-results\/ci-contain-security\.json/);
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
  const containment = workflow.jobs['ci-required'].steps.find((step) =>
    step.run?.endsWith('check-ci.mjs contain-ci'),
  );
  assert.equal(containment.if, '${{ always() }}');
  assert.equal(containment.env.CI_NEEDS, '${{ toJSON(needs) }}');
  const retained = workflow.jobs['ci-required'].steps.find((step) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  assert.match(retained.with.path, /test-results\/ci-contain-ci\.json/);
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
  for (const job of [workflow.jobs['browser-proof'], workflow.jobs['ci-required']]) {
    assert.equal(
      job.steps.find((step) => step.uses?.startsWith('actions/checkout@')).with['fetch-depth'],
      0,
    );
  }
  assert.equal(
    workflow.jobs['browser-proof'].steps.find((step) => step.id === 'validate').env
      .SLIPSTREAM_DOCS_CI,
    'true',
  );
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

test('bounded agent review requires explicit opt-in, billing confirmation and a named model', () => {
  assert.deepEqual(agentReviewPolicy(), { enabled: false });
  assert.deepEqual(agentReviewPolicy({ SLIPSTREAM_AGENT_REVIEW_ENABLED: 'false' }), {
    enabled: false,
  });
  const env = { SLIPSTREAM_AGENT_REVIEW_ENABLED: 'true' };
  assert.throws(() => agentReviewPolicy(env), /billing controls/);
  env.SLIPSTREAM_AGENT_REVIEW_NO_OVERAGE_CONFIRMED = 'true';
  for (const model of [undefined, '', 'auto', '--model', 'model\nother', 'model'.repeat(30)]) {
    assert.throws(
      () => agentReviewPolicy({ ...env, SLIPSTREAM_AGENT_REVIEW_MODEL: model }),
      /explicit supported review model/,
    );
  }
  const policy = agentReviewPolicy({ ...env, SLIPSTREAM_AGENT_REVIEW_MODEL: 'gpt-4.1' });
  assert.equal(policy.budgetMode, 'included-allowance-only');
  assert.equal(policy.limits.invocations, 1);
  assert.equal(policy.limits.retries, 0);
  assert.equal(policy.limits.timeoutMs, 300_000);
});

test('bounded agent review isolates credentials, configuration and telemetry', (context) => {
  const { root } = fixture(context);
  const token = `github_pat_${'synthetic'.repeat(4)}`;
  const env = agentReviewEnvironment(root, token);
  assert.equal(env.COPILOT_GITHUB_TOKEN, token);
  assert.equal(env.HOME, root);
  assert.equal(env.COPILOT_HOME, path.join(root, 'copilot'));
  assert.equal(env.GH_CONFIG_DIR, path.join(root, 'gh'));
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.OTEL_SDK_DISABLED, 'true');
  assert.equal(env.COPILOT_ALLOW_ALL, 'false');
  for (const name of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'NODE_OPTIONS',
    'BASH_ENV',
    'LD_PRELOAD',
    'HTTPS_PROXY',
    'COPILOT_PROVIDER_API_KEY_COMMAND',
    'COPILOT_CUSTOM_INSTRUCTIONS_DIRS',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'COPILOT_OTEL_FILE_EXPORTER_PATH',
  ])
    assert.equal(Object.hasOwn(env, name), false, name);
  for (const invalid of [undefined, '', 'ghp_classic', `${token}\n`]) {
    assert.throws(() => agentReviewEnvironment(root, invalid), /dedicated fine-grained token/);
  }
  assert.throws(() => agentReviewEnvironment('relative', token), /isolated directory/);
});

test('bounded agent review bounds real child processes and redacts failures', async (context) => {
  const { root } = fixture(context);
  const options = { cwd: root, env: {}, timeoutMs: 5_000 };
  const run = (code, overrides = {}) =>
    runAgentReviewProcess(process.execPath, ['-e', code], { ...options, ...overrides });
  assert.equal(
    (await run('process.stdout.write("review"); process.stderr.write("diagnostic")')).toString(),
    'review',
  );
  await assert.rejects(run('process.stderr.write("private diagnostic"); process.exit(1)'), {
    message: 'Review process failed',
  });
  await assert.rejects(
    run('process.stdout.write(Buffer.alloc(65537))'),
    /output exceeds its limit/,
  );
  await assert.rejects(
    run('process.stderr.write(Buffer.alloc(65537))'),
    /output exceeds its limit/,
  );
  await assert.rejects(run('setInterval(() => {}, 1000)', { timeoutMs: 100 }), /timed out/);
  const controller = new AbortController();
  const pending = run('setInterval(() => {}, 1000)', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(run('process.exit(0)', { signal: controller.signal }), /cancelled/);
  await assert.rejects(run('process.exit(0)', { timeoutMs: 300_001 }), /timeout exceeds/);
  await assert.rejects(runAgentReviewProcess(path.join(root, 'absent'), [], options), {
    message: 'Review process failed',
  });
});

test('bounded agent review fixes tool denial and bounds the complete prompt', (context) => {
  const { root } = fixture(context);
  const prepared = {
    evidence: {
      revision: META.revision,
      documentation: { proposal: { patchSha256: 'a'.repeat(64) } },
    },
    input: Buffer.from('Synthetic untrusted proposal'),
    inputSha256: 'b'.repeat(64),
  };
  const args = agentReviewArguments(prepared, { model: 'synthetic-model' }, root);
  assert.ok(args.includes('--available-tools=__slipstream_no_tools__'));
  assert.deepEqual(
    args.filter((arg) => arg.startsWith('--deny-tool=')),
    ['read', 'write', 'shell', 'url', 'memory'].map((kind) => `--deny-tool=${kind}`),
  );
  assert.ok(args.includes('--disable-builtin-mcps'));
  assert.ok(args.includes('--no-custom-instructions'));
  assert.ok(args.includes('--no-auto-login'));
  assert.ok(args.includes('--max-ai-credits=30'));
  assert.ok(args.includes('--max-autopilot-continues=0'));
  assert.equal(args[args.indexOf('--model') + 1], 'synthetic-model');
  assert.equal(args[args.indexOf('--usage-output-file') + 1], path.join(root, 'usage.json'));
  assert.equal(
    args.some((arg) => /^--(allow|yolo|agent|fleet|autopilot|resume|continue|share)/.test(arg)),
    false,
  );
  assert.throws(
    () =>
      agentReviewArguments(
        { ...prepared, input: Buffer.alloc(96 * 1024) },
        { model: 'synthetic-model' },
        root,
      ),
    /prompt exceeds/,
  );
});

function agentReviewUsage(model = 'synthetic-model') {
  return {
    sessionStartTime: '2026-09-16T00:00:00Z',
    totalUserRequests: 1,
    totalNanoAiu: 1_000_000,
    totalPremiumRequestCost: 0,
    totalApiDurationMs: 100,
    codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
    modelMetrics: { [model]: {} },
  };
}

test('bounded agent review finding IDs bind exact review identity and content', () => {
  const finding = { file: 'docs/mcp.md', severity: 'warning', message: 'Synthetic concern' };
  const report = {
    ...META,
    evidenceSha256: { 'first.json': 'c'.repeat(64), 'second.json': 'd'.repeat(64) },
    inputSha256: 'e'.repeat(64),
    patchSha256: 'f'.repeat(64),
    responseSha256: '1'.repeat(64),
    response: { findings: [finding, { ...finding }] },
  };
  const original = structuredClone(report);
  const ids = agentReviewFindingIds(report);
  assert.equal(ids.length, 2);
  assert.match(ids[0], /^[a-f0-9]{64}$/);
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(agentReviewFindingIds(JSON.parse(JSON.stringify(report))), ids);
  assert.deepEqual(
    agentReviewFindingIds({
      ...report,
      evidenceSha256: Object.fromEntries(Object.entries(report.evidenceSha256).reverse()),
    }),
    ids,
  );
  assert.deepEqual(agentReviewFindingIds({ ...report, durationMs: 999 }), ids);
  for (const field of [
    'workflow',
    'revision',
    'runId',
    'attempt',
    'evidenceSha256',
    'inputSha256',
    'patchSha256',
    'responseSha256',
  ]) {
    assert.notEqual(agentReviewFindingIds({ ...report, [field]: 'different' })[0], ids[0]);
  }
  for (const field of ['file', 'severity', 'message']) {
    const changed = structuredClone(report);
    changed.response.findings[0][field] = 'different';
    assert.notEqual(agentReviewFindingIds(changed)[0], ids[0]);
  }
  assert.deepEqual(agentReviewFindingIds({ ...report, response: { findings: [] } }), []);
  assert.deepEqual(report, original);
});

function agentReviewDispositionReport() {
  const response = {
    schemaVersion: 1,
    revision: META.revision,
    inputSha256: 'd'.repeat(64),
    patchSha256: 'e'.repeat(64),
    decision: 'changes-requested',
    findings: Array.from({ length: 4 }, (_value, index) => ({
      file: 'docs/mcp.md',
      severity: 'warning',
      message: `Synthetic concern ${index}`,
    })),
  };
  const report = {
    ...META,
    schemaVersion: 1,
    kind: 'bounded-agent-review',
    status: 'reviewed',
    eventName: 'schedule',
    workflow: 'Vmoosky/SlipStream/.github/workflows/maintenance.yml@refs/heads/main',
    startedAt: '2026-09-16T00:00:00.000Z',
    finishedAt: '2026-09-16T00:00:01.000Z',
    durationMs: 1_000,
    invocations: 1,
    wrapperRetries: 0,
    cleanup: true,
    errors: [],
    humanApprovalRequired: true,
    automaticPublication: false,
    evidenceSha256: {
      'test-results/maintenance/run-synthetic/report.json': '1'.repeat(64),
      'test-results/maintenance-audit.json': '2'.repeat(64),
      'test-results/maintenance-proof.json': '3'.repeat(64),
    },
    inputSha256: response.inputSha256,
    patchSha256: response.patchSha256,
    responseSha256: createHash('sha256').update(JSON.stringify(response)).digest('hex'),
    policy: { enabled: true, provider: 'github-copilot-cli', model: 'synthetic-model' },
    usage: validateAgentReviewUsage(
      Buffer.from(JSON.stringify(agentReviewUsage())),
      'synthetic-model',
    ),
    response: { ...response, humanApprovalRequired: true, automaticPublication: false },
  };
  report.findingIds = agentReviewFindingIds(report);
  return report;
}

test('bounded agent review dispositions bind triage without granting approval or resolution', () => {
  const report = agentReviewDispositionReport();
  const reportBytes = Buffer.from(JSON.stringify(report));
  const record = prepareAgentReviewDispositions(reportBytes);
  const validate = (value) =>
    validateAgentReviewDispositions(Buffer.from(JSON.stringify(value)), reportBytes);
  assert.deepEqual(record.entries, []);
  assert.equal(record.review.reportSha256, createHash('sha256').update(reportBytes).digest('hex'));
  assert.equal(validate(record).counts.untriaged, 4);
  record.entries = ['accepted', 'rejected', 'deferred'].map((disposition, index) => ({
    findingId: report.findingIds[index],
    disposition,
    reason: `Synthetic ${disposition} rationale`,
    recordedBy: 'synthetic-reviewer',
    recordedAt: '2026-09-16T00:00:02Z',
  }));
  const before = structuredClone(record);
  const result = validate(record);
  assert.deepEqual(result.counts, {
    total: 4,
    untriaged: 1,
    accepted: 1,
    rejected: 1,
    deferred: 1,
  });
  assert.deepEqual(
    result.findings.map((finding) => finding.disposition),
    ['accepted', 'rejected', 'deferred', 'untriaged'],
  );
  assert.equal(result.evidence, 'local-consistency-only');
  assert.equal(result.provenanceVerified, false);
  assert.equal(result.identityVerified, false);
  assert.equal(result.resolutionVerified, false);
  assert.equal(result.humanApprovalRequired, true);
  assert.equal(result.automaticPublication, false);
  assert.equal(JSON.stringify(result).includes('Synthetic accepted rationale'), false);
  assert.deepEqual(record, before);
  assert.deepEqual(JSON.parse(reportBytes), report);
});

test('bounded agent review dispositions reject stale bindings and invalid decision records', () => {
  const report = agentReviewDispositionReport();
  const reportBytes = Buffer.from(JSON.stringify(report));
  const record = prepareAgentReviewDispositions(reportBytes);
  const entry = {
    findingId: report.findingIds[0],
    disposition: 'accepted',
    reason: 'Synthetic rationale',
    recordedBy: 'synthetic-reviewer',
    recordedAt: '2026-09-16T00:00:02.000Z',
  };
  const validate = (value) =>
    validateAgentReviewDispositions(Buffer.from(JSON.stringify(value)), reportBytes);
  for (const key of Object.keys(record.review)) {
    assert.throws(() => validate({ ...record, review: { ...record.review, [key]: 'different' } }));
  }
  for (const change of [
    { schemaVersion: 2 },
    { kind: 'different' },
    { entries: {} },
    { entries: Array(11).fill(entry) },
    { entries: [entry, entry] },
    { review: { ...record.review, approved: true } },
    { resolved: true },
    { humanApprovalRequired: false },
  ])
    assert.throws(() => validate({ ...record, ...change }));
  for (const change of [
    { findingId: '0'.repeat(64) },
    { disposition: 'resolved' },
    { disposition: 'untriaged' },
    { reason: '' },
    { reason: ' \n\t' },
    { reason: 'x'.repeat(2_001) },
    { reason: '\u001b[31m' },
    { recordedBy: '' },
    { recordedBy: 'x'.repeat(40) },
    { recordedBy: 'synthetic--reviewer' },
    { recordedAt: '2026-02-30T00:00:02.000Z' },
    { recordedAt: '2026-09-16T00:00:00.000Z' },
    { recordedAt: '2026-09-16' },
    { command: 'git push' },
    { approved: true },
  ])
    assert.throws(() => validate({ ...record, entries: [{ ...entry, ...change }] }));
  for (const key of Object.keys(entry)) {
    const incomplete = { ...entry };
    delete incomplete[key];
    assert.throws(() => validate({ ...record, entries: [incomplete] }));
  }
  assert.throws(() =>
    validateAgentReviewDispositions(
      Buffer.from(JSON.stringify(record)),
      Buffer.concat([reportBytes, Buffer.from('\n')]),
    ),
  );
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(65_537),
    Buffer.from([255]),
    Buffer.from('{'),
  ]) {
    assert.throws(() => validateAgentReviewDispositions(bytes, reportBytes));
  }
});

test('bounded agent review dispositions reject invalid reports and derive legacy IDs without writes', () => {
  const report = agentReviewDispositionReport();
  const mutations = [
    (value) => {
      value.status = 'failed';
    },
    (value) => {
      value.status = 'no-op';
    },
    (value) => {
      value.eventName = 'workflow_dispatch';
    },
    (value) => {
      value.attempt = '2';
    },
    (value) => {
      value.runId = 123;
    },
    (value) => {
      value.cleanup = false;
    },
    (value) => {
      value.errors.push('synthetic failure');
    },
    (value) => {
      value.wrapperRetries = 1;
    },
    (value) => {
      value.evidenceSha256 = 'unknown';
    },
    (value) => {
      value.workflow = META.workflow;
    },
    (value) => {
      value.humanApprovalRequired = false;
    },
    (value) => {
      value.automaticPublication = true;
    },
    (value) => {
      value.durationMs = 1;
    },
    (value) => {
      value.usage = null;
    },
    (value) => {
      value.usage.model = 'different';
    },
    (value) => {
      value.usage.nanoAiUnits = 0;
    },
    (value) => {
      value.findingIds[0] = '0'.repeat(64);
    },
    (value) => {
      value.findingIds = [];
    },
    (value) => {
      value.response.patchSha256 = '0'.repeat(64);
    },
    (value) => {
      value.response.findings[0].file = '../outside';
    },
    (value) => {
      value.response.findings[0].approved = true;
    },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => prepareAgentReviewDispositions(Buffer.from(JSON.stringify(invalid))));
  }
  const legacy = structuredClone(report);
  delete legacy.findingIds;
  const bytes = Buffer.from(JSON.stringify(legacy));
  const record = prepareAgentReviewDispositions(bytes);
  const result = validateAgentReviewDispositions(Buffer.from(JSON.stringify(record)), bytes);
  assert.deepEqual(
    result.findings.map((finding) => finding.findingId),
    report.findingIds,
  );
  assert.equal(Object.hasOwn(JSON.parse(bytes), 'findingIds'), false);
  report.response.decision = 'no-objection';
  report.response.findings = [];
  report.findingIds = [];
  const emptyBytes = Buffer.from(JSON.stringify(report));
  assert.equal(
    validateAgentReviewDispositions(
      Buffer.from(JSON.stringify(prepareAgentReviewDispositions(emptyBytes))),
      emptyBytes,
    ).counts.total,
    0,
  );
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.alloc(98_305),
    Buffer.from([255]),
    Buffer.from('null'),
  ]) {
    assert.throws(() => prepareAgentReviewDispositions(invalid));
  }
});

test('bounded agent review disposition CLI is read-only and bypasses live configuration', (context) => {
  const { root, write } = fixture(context);
  const report = agentReviewDispositionReport();
  write('review.json', report);
  const initialFiles = fs.readdirSync(root);
  const token = `github_pat_${'synthetic'.repeat(4)}`;
  const env = {
    SLIPSTREAM_AGENT_REVIEW_ENABLED: 'true',
    SLIPSTREAM_AGENT_REVIEW_MODEL: 'invalid model',
    SLIPSTREAM_AGENT_REVIEW_TOKEN: token,
    COPILOT_GITHUB_TOKEN: token,
    GH_TOKEN: token,
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_PATH: path.join(root, 'must-not-read.json'),
    GITHUB_OUTPUT: path.join(root, 'must-not-write.txt'),
    GITHUB_STEP_SUMMARY: path.join(root, 'must-not-summarize.md'),
  };
  const command = (...args) =>
    execFileSync(process.execPath, [path.join(REPO, 'scripts/check-agent-review.mjs'), ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const original = fs.readFileSync(path.join(root, 'review.json'));
  const template = JSON.parse(command('--prepare-dispositions', 'review.json'));
  assert.deepEqual(template, prepareAgentReviewDispositions(original));
  assert.deepEqual(template.entries, []);
  template.entries.push({
    findingId: report.findingIds[0],
    disposition: 'accepted',
    reason: token,
    recordedBy: 'synthetic-reviewer',
    recordedAt: '2026-09-16T00:00:02.000Z',
  });
  write('dispositions.json', template);
  const decisions = fs.readFileSync(path.join(root, 'dispositions.json'));
  const output = command('--validate-dispositions', 'review.json', 'dispositions.json');
  const result = JSON.parse(output);
  assert.equal(result.counts.accepted, 1);
  assert.equal(result.counts.untriaged, 3);
  assert.equal(result.resolutionVerified, false);
  assert.equal(output.includes(token), false);
  for (const args of [
    ['--prepare-dispositions'],
    ['--prepare-dispositions', 'review.json', 'extra'],
    ['--validate-dispositions', 'review.json'],
    ['--validate-dispositions', 'review.json', 'dispositions.json', '--review'],
    ['--prepare-dispositions', '../review.json'],
    ['--prepare-dispositions', path.join(root, 'review.json')],
    ['--prepare-dispositions', 'folder\\review.json'],
    ['--prepare-dispositions', 'missing.json'],
    ['--validate-dispositions', 'review.json', '../dispositions.json'],
  ]) {
    assert.throws(
      () => command(...args),
      (error) => {
        assert.equal(error.status, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /^Disposition command failed;/);
        assert.equal(error.stderr.includes(token), false);
        return true;
      },
    );
  }
  assert.deepEqual(fs.readdirSync(root).sort(), [...initialFiles, 'dispositions.json'].sort());
  assert.deepEqual(fs.readFileSync(path.join(root, 'review.json')), original);
  assert.deepEqual(fs.readFileSync(path.join(root, 'dispositions.json')), decisions);
});

test('bounded agent review disposition CLI rejects oversized inputs and directory junctions', (context) => {
  const { root, write } = fixture(context);
  const { root: outside } = fixture(context);
  const report = agentReviewDispositionReport();
  write('review.json', report);
  fs.writeFileSync(path.join(root, 'oversized-review.json'), Buffer.alloc(98_305));
  fs.writeFileSync(path.join(root, 'oversized-dispositions.json'), Buffer.alloc(65_537));
  fs.writeFileSync(path.join(outside, 'review.json'), JSON.stringify(report));
  fs.symlinkSync(
    outside,
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  for (const args of [
    ['--prepare-dispositions', 'oversized-review.json'],
    ['--validate-dispositions', 'review.json', 'oversized-dispositions.json'],
    ['--prepare-dispositions', 'linked/review.json'],
    ['--prepare-dispositions', 'linked'],
  ]) {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [path.join(REPO, 'scripts/check-agent-review.mjs'), ...args],
          {
            cwd: root,
            env: {},
            encoding: 'utf8',
            timeout: 5_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      (error) =>
        error.status === 1 &&
        error.stdout === '' &&
        /^Disposition command failed;/.test(error.stderr),
    );
  }
  assert.equal(fs.readFileSync(path.join(outside, 'review.json'), 'utf8'), JSON.stringify(report));
});

test('bounded agent review requires usage evidence and a pinned runtime archive', (context) => {
  const { root } = fixture(context);
  const usage = agentReviewUsage();
  const validate = (value) =>
    validateAgentReviewUsage(Buffer.from(JSON.stringify(value)), 'synthetic-model');
  assert.equal(validate(usage).nanoAiUnits, 1_000_000);
  assert.equal(validate(usage).billedUsd, null);
  assert.equal(validate(usage).providerRetries, null);
  for (const invalid of [
    { totalNanoAiu: undefined },
    { totalNanoAiu: 0 },
    { totalNanoAiu: -1 },
    { totalUserRequests: 2 },
    { totalPremiumRequestCost: null },
    { totalApiDurationMs: -1 },
    { sessionStartTime: 'unknown' },
    { modelMetrics: {} },
    { modelMetrics: { other: {} } },
    { modelMetrics: { ...usage.modelMetrics, other: {} } },
    { codeChanges: { linesAdded: 1, linesRemoved: 0, filesModified: [] } },
    { codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: ['file'] } },
  ])
    assert.throws(() => validate({ ...usage, ...invalid }));
  assert.throws(() => validateAgentReviewUsage(Buffer.alloc(65_537), 'synthetic-model'));
  const archive = path.join(root, 'untrusted.tgz');
  fs.writeFileSync(archive, 'untrusted executable');
  assert.throws(() => verifyAgentReviewArchive(archive), /pinned integrity/);
});

test('bounded agent review CLI is offline by default and rejects unsafe runtime downloads', async (context) => {
  const { root } = fixture(context);
  const output = execFileSync(
    process.execPath,
    [path.join(REPO, 'scripts/check-agent-review.mjs'), '--review'],
    {
      cwd: root,
      env: {},
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  const report = JSON.parse(output);
  assert.equal(report.status, 'disabled');
  assert.equal(report.invocations, 0);
  const archive = path.join(root, 'runtime.tgz');
  for (const response of [
    new Response('not the pinned archive'),
    new Response(null, { status: 503 }),
    new Response('oversized', { headers: { 'content-length': String(170 * 1024 * 1024) } }),
  ]) {
    await assert.rejects(
      downloadAgentReviewArchive(archive, {
        fetchArchive: async (url, options) => {
          assert.equal(
            url,
            'https://registry.npmjs.org/@github/copilot-linux-x64/-/copilot-linux-x64-1.0.84-5.tgz',
          );
          assert.equal(options.redirect, 'error');
          assert.equal(options.headers, undefined);
          return response;
        },
      }),
    );
    assert.equal(fs.existsSync(archive), false);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    downloadAgentReviewArchive(archive, {
      signal: controller.signal,
      fetchArchive: () => assert.fail('Cancelled downloads must not start'),
    }),
  );
  fs.writeFileSync(archive, 'existing archive');
  await assert.rejects(
    downloadAgentReviewArchive(archive, { fetchArchive: async () => new Response('untrusted') }),
  );
  assert.equal(fs.readFileSync(archive, 'utf8'), 'existing archive');
});

test('bounded agent review invokes once, binds its report and removes temporary state', async (context) => {
  const { root, write, report, options } = maintenanceEvidence(context);
  const env = {
    ...options.env,
    SLIPSTREAM_AGENT_REVIEW_ENABLED: 'true',
    SLIPSTREAM_AGENT_REVIEW_NO_OVERAGE_CONFIRMED: 'true',
    SLIPSTREAM_AGENT_REVIEW_MODEL: 'synthetic-model',
    SLIPSTREAM_AGENT_REVIEW_TOKEN: `github_pat_${'synthetic'.repeat(4)}`,
    GH_TOKEN: 'must-not-reach-the-child',
  };
  let calls = 0;
  let temporary;
  const runnerOptions = {
    ...options,
    env,
    event: { ...options.event, schedule: '0 7 * * 1' },
    prepareRuntime: async (_archive, directory) => {
      temporary = directory;
      return path.join(directory, 'synthetic-cli');
    },
    runCommand: async (_command, args, childOptions) => {
      calls++;
      assert.equal(childOptions.env.GH_TOKEN, undefined);
      assert.equal(childOptions.env.COPILOT_GITHUB_TOKEN, env.SLIPSTREAM_AGENT_REVIEW_TOKEN);
      assert.equal(childOptions.cwd, path.join(temporary, 'work'));
      assert.equal(childOptions.env.HOME, path.join(temporary, 'home'));
      const prepared = prepareAgentReview(root, options);
      fs.writeFileSync(
        args[args.indexOf('--usage-output-file') + 1],
        JSON.stringify(agentReviewUsage()),
      );
      return Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          revision: options.revision,
          inputSha256: prepared.inputSha256,
          patchSha256: prepared.evidence.documentation.proposal.patchSha256,
          decision: 'changes-requested',
          findings: [
            {
              file: report.proposal.files[0].path,
              severity: 'warning',
              message: 'Synthetic concern',
            },
          ],
        }),
      );
    },
  };
  assert.equal(
    (await runBoundedAgentReview(root, { ...runnerOptions, env: {} })).status,
    'disabled',
  );
  assert.equal((await runBoundedAgentReview(root, runnerOptions)).status, 'no-op');
  assert.equal(calls, 0);
  const patch = Buffer.from('Synthetic patch data; never executed');
  fs.writeFileSync(path.join(root, path.dirname(options.reportPath), 'proposal.patch'), patch);
  report.outcome = 'proposed';
  report.proposal = validateDocumentationProposal([documentationChange()], patch);
  write(options.reportPath, report);
  const reviewed = await runBoundedAgentReview(root, runnerOptions);
  assert.equal(reviewed.status, 'reviewed', JSON.stringify(reviewed.errors));
  assert.equal(reviewed.response.humanApprovalRequired, true);
  assert.equal(reviewed.automaticPublication, false);
  assert.equal(reviewed.invocations, 1);
  assert.equal(reviewed.usage.model, 'synthetic-model');
  assert.equal(reviewed.patchSha256, report.proposal.patchSha256);
  assert.deepEqual(reviewed.findingIds, agentReviewFindingIds(reviewed));
  assert.equal(reviewed.findingIds.length, 1);
  assert.deepEqual(Object.keys(reviewed.response.findings[0]), ['file', 'severity', 'message']);
  const reviewBytes = Buffer.from(JSON.stringify(reviewed));
  const record = prepareAgentReviewDispositions(reviewBytes);
  assert.equal(
    validateAgentReviewDispositions(Buffer.from(JSON.stringify(record)), reviewBytes).counts
      .untriaged,
    1,
  );
  assert.equal(reviewed.cleanup, true);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(JSON.stringify(reviewed).includes(env.SLIPSTREAM_AGENT_REVIEW_TOKEN), false);
  assert.equal((await runBoundedAgentReview(root, runnerOptions)).status, 'failed');
  assert.equal(calls, 1);
});

test('bounded agent review fails closed and cleans up without retrying or leaking diagnostics', async (context) => {
  for (const failure of ['runtime', 'process', 'response', 'usage', 'cancelled', 'credential']) {
    const { root, write, report, options } = maintenanceEvidence(context);
    const patch = Buffer.from('Synthetic patch data; never executed');
    fs.writeFileSync(path.join(root, path.dirname(options.reportPath), 'proposal.patch'), patch);
    report.outcome = 'proposed';
    report.proposal = validateDocumentationProposal([documentationChange()], patch);
    write(options.reportPath, report);
    const token = `github_pat_${'synthetic'.repeat(4)}`;
    const controller = new AbortController();
    let temporary;
    let calls = 0;
    const reviewed = await runBoundedAgentReview(root, {
      ...options,
      event: { ...options.event, schedule: '0 7 * * 1' },
      env: {
        ...options.env,
        SLIPSTREAM_AGENT_REVIEW_ENABLED: 'true',
        SLIPSTREAM_AGENT_REVIEW_NO_OVERAGE_CONFIRMED: 'true',
        SLIPSTREAM_AGENT_REVIEW_MODEL: 'synthetic-model',
        SLIPSTREAM_AGENT_REVIEW_TOKEN: token,
      },
      signal: controller.signal,
      prepareRuntime: async (_archive, directory) => {
        temporary = directory;
        if (failure === 'runtime') throw new Error(token);
        if (failure === 'cancelled') controller.abort();
        return path.join(directory, 'synthetic-cli');
      },
      runCommand: async (_command, args) => {
        calls++;
        if (failure === 'process') throw new Error(token);
        if (failure === 'response') return Buffer.from('invalid private diagnostic');
        if (failure !== 'usage') {
          fs.writeFileSync(
            args[args.indexOf('--usage-output-file') + 1],
            JSON.stringify(agentReviewUsage()),
          );
        }
        const prepared = prepareAgentReview(root, options);
        return Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            revision: options.revision,
            inputSha256: prepared.inputSha256,
            patchSha256: report.proposal.patchSha256,
            decision: failure === 'credential' ? 'changes-requested' : 'no-objection',
            findings:
              failure === 'credential'
                ? [{ file: report.proposal.files[0].path, severity: 'warning', message: token }]
                : [],
          }).replaceAll('_', '\\u005f'),
        );
      },
    });
    assert.equal(reviewed.status, 'failed', failure);
    assert.equal(reviewed.response, null, failure);
    assert.equal(reviewed.usage, null, failure);
    assert.equal(reviewed.cleanup, true, failure);
    assert.equal(fs.existsSync(temporary), false, failure);
    assert.equal(JSON.stringify(reviewed).includes(token), false, failure);
    assert.equal(JSON.stringify(reviewed).includes('private diagnostic'), false, failure);
    assert.equal(calls, ['runtime', 'cancelled'].includes(failure) ? 0 : 1, failure);
  }
});

test('bounded agent review accepts only verified first-attempt proposals and skips no-ops', (context) => {
  const { root, write, report, options } = maintenanceEvidence(context);
  const noOp = prepareAgentReview(root, options);
  assert.equal(noOp.status, 'no-op');
  assert.equal(noOp.input, null);
  const patch = Buffer.from('Synthetic patch data; never executed');
  const patchPath = options.reportPath.replace('report.json', 'proposal.patch');
  fs.writeFileSync(path.join(root, patchPath), patch);
  report.outcome = 'proposed';
  report.proposal = validateDocumentationProposal([documentationChange()], patch);
  write(options.reportPath, report);
  const prepared = prepareAgentReview(root, options);
  assert.equal(prepared.status, 'ready');
  assert.equal(prepared.inputSha256, createHash('sha256').update(prepared.input).digest('hex'));
  const payload = JSON.parse(prepared.input);
  assert.equal(payload.revision, options.revision);
  assert.deepEqual(payload.proposal, report.proposal);
  assert.equal(payload.patch, patch.toString());
  assert.throws(
    () =>
      prepareAgentReview(root, {
        ...options,
        steps: { ...options.steps, audit: { outcome: 'failure' } },
      }),
    /verified first-attempt/,
  );
  report.attempt = '2';
  write(options.reportPath, report);
  assert.throws(
    () =>
      prepareAgentReview(root, {
        ...options,
        env: { ...options.env, GITHUB_RUN_ATTEMPT: '2' },
      }),
    /verified first-attempt/,
  );
  report.attempt = '1';
  write(options.reportPath, report);
  fs.appendFileSync(path.join(root, patchPath), ' changed');
  assert.throws(() => prepareAgentReview(root, options), /verified first-attempt/);
});

test('bounded agent review rejects malformed, unbound, oversized and executable responses', () => {
  const proposal = validateDocumentationProposal([documentationChange()], Buffer.from('patch'));
  const prepared = {
    evidence: { revision: META.revision, documentation: { proposal } },
    inputSha256: 'b'.repeat(64),
  };
  const response = {
    schemaVersion: 1,
    revision: META.revision,
    inputSha256: prepared.inputSha256,
    patchSha256: proposal.patchSha256,
    decision: 'no-objection',
    findings: [],
  };
  const validate = (value) =>
    validateAgentReviewResponse(Buffer.from(JSON.stringify(value)), prepared);
  assert.equal(validate(response).humanApprovalRequired, true);
  assert.equal(validate(response).automaticPublication, false);
  const finding = { file: proposal.files[0].path, severity: 'error', message: 'Synthetic concern' };
  assert.equal(
    validate({ ...response, decision: 'changes-requested', findings: [finding] }).decision,
    'changes-requested',
  );
  for (const invalid of [
    { schemaVersion: 2 },
    { revision: 'c'.repeat(40) },
    { inputSha256: 'c'.repeat(64) },
    { patchSha256: 'c'.repeat(64) },
    { decision: 'approved' },
    { decision: 'changes-requested' },
    { findings: [finding] },
    { patch: 'git push' },
    { humanApprovalRequired: false },
  ])
    assert.throws(() => validate({ ...response, ...invalid }));
  for (const invalid of [
    { file: '../../secrets' },
    { file: 'README.md' },
    { severity: 'critical' },
    { message: '' },
    { message: 'x'.repeat(2_001) },
    { message: '\u001b[31m' },
    { command: 'git push' },
  ])
    assert.throws(() =>
      validate({
        ...response,
        decision: 'changes-requested',
        findings: [{ ...finding, ...invalid }],
      }),
    );
  assert.throws(() =>
    validate({ ...response, decision: 'changes-requested', findings: Array(11).fill(finding) }),
  );
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.alloc(65_537),
    Buffer.from([255]),
    Buffer.from('```json\n{}\n```'),
  ]) {
    assert.throws(() => validateAgentReviewResponse(invalid, prepared));
  }
});

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
  assert.equal(job['timeout-minutes'], 30);
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
    'review_runtime',
    'agent_review',
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
    'test-results/maintenance/run-*/agent-review.json',
  ]);
  assert.equal(
    uploads[1].if,
    "${{ !cancelled() && steps.verify.outcome == 'success' && steps.verify.outputs.proposal_path != '' }}",
  );
  assert.equal(uploads[1].with.path, '${{ steps.verify.outputs.proposal_path }}');
});

test('bounded agent review workflow exposes its dedicated credential only after verified opt-in preparation', () => {
  const workflow = parse(
    fs.readFileSync(path.join(REPO, '.github/workflows/maintenance.yml'), 'utf8'),
  );
  const job = workflow.jobs.maintenance;
  const steps = Object.fromEntries(
    job.steps.filter((step) => step.id).map((step) => [step.id, step]),
  );
  const runtime = steps.review_runtime;
  const review = steps.agent_review;
  assert.match(runtime.if, /!cancelled\(\)/);
  assert.match(runtime.if, /steps\.verify\.outcome == 'success'/);
  assert.match(runtime.if, /steps\.verify\.outputs\.proposal_path != ''/);
  assert.match(runtime.if, /github\.event_name == 'schedule'/);
  assert.match(runtime.if, /github\.run_attempt == '1'/);
  assert.match(runtime.if, /vars\.SLIPSTREAM_AGENT_REVIEW_ENABLED == 'true'/);
  assert.equal(runtime.run, 'node scripts/check-agent-review.mjs --prepare-runtime');
  assert.equal(runtime['timeout-minutes'], 2);
  assert.equal(
    review.if,
    "${{ !cancelled() && steps.review_runtime.outcome == 'success' && steps.review_runtime.outputs.archive_path != '' }}",
  );
  assert.equal(review['timeout-minutes'], 7);
  assert.equal(review.run, 'node scripts/check-agent-review.mjs --review');
  for (const step of [runtime, review]) {
    assert.equal(step.env.CI_STEPS, '${{ toJSON(steps) }}');
    assert.equal(step.env.MAINTENANCE_REPORT, '${{ steps.docs.outputs.report_path }}');
    assert.equal(
      step.env.SLIPSTREAM_AGENT_REVIEW_MODEL,
      '${{ vars.SLIPSTREAM_AGENT_REVIEW_MODEL }}',
    );
    assert.equal(
      step.env.SLIPSTREAM_AGENT_REVIEW_NO_OVERAGE_CONFIRMED,
      '${{ vars.SLIPSTREAM_AGENT_REVIEW_NO_OVERAGE_CONFIRMED }}',
    );
  }
  assert.equal(
    review.env.SLIPSTREAM_AGENT_REVIEW_ARCHIVE,
    '${{ steps.review_runtime.outputs.archive_path }}',
  );
  assert.equal(
    review.env.SLIPSTREAM_AGENT_REVIEW_TOKEN,
    '${{ secrets.SLIPSTREAM_AGENT_REVIEW_TOKEN }}',
  );
  for (const holder of [workflow, job, ...job.steps.filter((step) => step !== review)]) {
    assert.equal(JSON.stringify(holder.env ?? {}).includes('secrets.'), false);
    assert.equal(holder.env?.SLIPSTREAM_AGENT_REVIEW_TOKEN, undefined);
  }
  const cleanup = job.steps.find((step) => step.run?.endsWith('--cleanup-runtime'));
  assert.equal(cleanup.if, "${{ always() && steps.docs.outputs.report_path != '' }}");
  assert.equal(cleanup['timeout-minutes'], 1);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
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
