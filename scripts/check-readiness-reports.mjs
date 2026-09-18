import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { devNull } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPORT_FILENAMES = Object.freeze({
  'bounded-agent-review': 'agent-review.json',
  'pr-observability': 'pr-observability.json',
  'continuous-improvement-review': 'improvement.json',
});

const SOURCES = Object.freeze({
  'bounded-agent-review': {
    workflow: '.github/workflows/maintenance.yml',
    artifact: 'readiness-agent-review',
    events: ['schedule'],
    days: 90,
  },
  'pr-observability': {
    workflow: '.github/workflows/pr-observability.yml',
    artifact: 'readiness-pr-observability',
    events: ['pull_request_target', 'workflow_dispatch', 'workflow_run'],
    days: 30,
  },
  'continuous-improvement-review': {
    workflow: '.github/workflows/improvement.yml',
    artifact: 'readiness-improvement',
    events: ['schedule', 'workflow_dispatch', 'workflow_run'],
    days: 90,
  },
});

export function writeReadinessReport(root, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1024 * 1024) {
    throw new Error('Invalid readiness report bytes');
  }
  const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (report?.schemaVersion !== 1 || !Object.hasOwn(REPORT_FILENAMES, report.kind)) {
    throw new Error('Unsupported readiness report');
  }
  const directory = path.join(root, 'reports');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Readiness reports require a real output directory');
  }
  const relative = `reports/${REPORT_FILENAMES[report.kind]}`;
  fs.writeFileSync(path.join(root, relative), bytes, { flag: 'wx', mode: 0o600 });
  return relative;
}

function requireEvidence(condition) {
  if (!condition)
    throw new Error('Readiness evidence is missing, stale, mismatched, or unsupported');
}

function positiveId(value) {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

function validateSelection({ repository, branch, revision, selections }) {
  requireEvidence(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository));
  requireEvidence(repository.length <= 200 && !repository.includes('..'));
  requireEvidence(typeof branch === 'string' && /^[\w./-]{1,200}$/.test(branch));
  requireEvidence(!branch.includes('..') && /^[a-f0-9]{40}$/.test(revision ?? ''));
  requireEvidence(Array.isArray(selections) && selections.length > 0 && selections.length <= 3);
  requireEvidence(
    new Set(selections.map((selection) => selection?.kind)).size === selections.length,
  );
  for (const selection of selections) {
    requireEvidence(
      selection &&
        Object.hasOwn(SOURCES, selection.kind) &&
        positiveId(selection.runId) &&
        positiveId(selection.attempt),
    );
  }
}

function validateRun(run, selection, source, { repository, repositoryId, branch, revision, now }) {
  requireEvidence(
    run?.id === Number(selection.runId) &&
      run.run_attempt === Number(selection.attempt) &&
      run.status === 'completed' &&
      [
        'success',
        'failure',
        'cancelled',
        'timed_out',
        'neutral',
        'skipped',
        'action_required',
        'stale',
        'startup_failure',
      ].includes(run.conclusion) &&
      source.events.includes(run.event) &&
      run.path === source.workflow &&
      run.head_sha === revision &&
      run.head_branch === branch &&
      run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository &&
      Number.isSafeInteger(run.repository.id) &&
      run.repository.id > 0 &&
      run.repository.id === repositoryId &&
      run.head_repository.id === run.repository.id &&
      Number.isSafeInteger(run.workflow_id) &&
      run.workflow_id > 0 &&
      Date.parse(run.created_at) <= now &&
      now - Date.parse(run.created_at) <= source.days * 86_400_000,
  );
}

function validateArtifact(artifact, run, name, now) {
  requireEvidence(
    artifact?.name === name &&
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 2 * 1024 * 1024 &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run.head_sha === run.head_sha &&
      artifact.workflow_run.repository_id === run.repository.id &&
      artifact.workflow_run.head_repository_id === run.repository.id &&
      Date.parse(artifact.created_at) >= Date.parse(run.created_at) &&
      Date.parse(artifact.created_at) <= now &&
      Date.parse(artifact.expires_at) > now,
  );
  return {
    id: artifact.id,
    name: artifact.name,
    bytes: artifact.size_in_bytes,
    digest: artifact.digest,
    createdAt: artifact.created_at,
    expiresAt: artifact.expires_at,
  };
}

export async function collectReadinessArtifacts(options) {
  validateSelection(options);
  const { repository, branch, revision, selections, client, now = Date.now() } = options;
  requireEvidence(Number.isFinite(now));
  const started = performance.now();
  const currentTime = () => now + performance.now() - started;
  const { readImprovementArchive } = await import('./check-improvement.mjs');
  const repositoryInfo = await client.json('');
  requireEvidence(
    repositoryInfo?.full_name === repository &&
      repositoryInfo.default_branch === branch &&
      Number.isSafeInteger(repositoryInfo.id) &&
      repositoryInfo.id > 0,
  );
  const identity = { repository, repositoryId: repositoryInfo.id, branch, revision };
  const reports = [];
  for (const selection of selections) {
    const source = SOURCES[selection.kind];
    const runPath = `/actions/runs/${selection.runId}`;
    const run = await client.json(runPath);
    validateRun(run, selection, source, { ...identity, now: currentTime() });
    const workflow = await client.json(`/actions/workflows/${run.workflow_id}`);
    requireEvidence(workflow?.id === run.workflow_id && workflow.path === source.workflow);
    const inventory = await client.json(`${runPath}/artifacts?per_page=100`);
    requireEvidence(
      Array.isArray(inventory?.artifacts) &&
        inventory.total_count === inventory.artifacts.length &&
        inventory.total_count <= 100,
    );
    const numberPattern = selection.kind === 'pr-observability' ? '-([1-9][0-9]{0,15})' : '';
    const namePattern = new RegExp(
      `^${source.artifact}${numberPattern}-${selection.runId}-${selection.attempt}$`,
    );
    const matches = inventory.artifacts.filter((artifact) => namePattern.test(artifact.name));
    requireEvidence(matches.length === 1);
    const artifact = matches[0];
    const metadata = validateArtifact(artifact, run, artifact.name, currentTime());
    const archive = await client.archive(artifact);
    requireEvidence(Buffer.isBuffer(archive) && archive.length === metadata.bytes);
    requireEvidence(
      `sha256:${createHash('sha256').update(archive).digest('hex')}` === metadata.digest,
    );
    const filename = REPORT_FILENAMES[selection.kind];
    const contents = await readImprovementArchive(archive, [filename], [filename], [filename]);
    const bytes = contents.get(filename);
    requireEvidence(bytes.length > 0 && bytes.length <= 1024 * 1024);
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    requireEvidence(report?.schemaVersion === 1 && report.kind === selection.kind);
    const producer = selection.kind === 'bounded-agent-review' ? report : report.collector;
    requireEvidence(
      producer?.revision === revision &&
        producer.runId === selection.runId &&
        producer.attempt === selection.attempt &&
        producer.eventName === run.event &&
        producer.workflow === `${repository}/${source.workflow}@refs/heads/${branch}`,
    );
    if (selection.kind !== 'bounded-agent-review')
      requireEvidence(report.repository === repository && report.branch === branch);
    if (selection.kind === 'pr-observability')
      requireEvidence(
        positiveId(String(report.number)) &&
          String(report.number) === namePattern.exec(artifact.name)[1],
      );
    if (selection.kind === 'continuous-improvement-review')
      requireEvidence(report.source === 'github-actions');
    const status = selection.kind === 'pr-observability' ? report.publication : report.status;
    requireEvidence(typeof status === 'string' && /^[a-z][a-z-]{0,79}$/.test(status));
    const currentRun = await client.json(runPath);
    validateRun(currentRun, selection, source, { ...identity, now: currentTime() });
    requireEvidence(
      currentRun.workflow_id === run.workflow_id &&
        currentRun.conclusion === run.conclusion &&
        currentRun.event === run.event &&
        currentRun.created_at === run.created_at,
    );
    const currentArtifact = await client.json(`/actions/artifacts/${artifact.id}`);
    requireEvidence(
      JSON.stringify(
        validateArtifact(currentArtifact, currentRun, artifact.name, currentTime()),
      ) === JSON.stringify(metadata),
    );
    reports.push({
      bytes,
      evidence: {
        kind: selection.kind,
        path: `reports/${filename}`,
        reportSha256: createHash('sha256').update(bytes).digest('hex'),
        status,
        producer: {
          runId: selection.runId,
          attempt: selection.attempt,
          revision,
          workflow: source.workflow,
          event: run.event,
          conclusion: run.conclusion,
        },
        artifact: metadata,
      },
    });
  }
  return reports;
}

function git(root, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(GIT_|GH_TOKEN$|GITHUB_TOKEN$|COPILOT_GITHUB_TOKEN$|SLIPSTREAM_AGENT_REVIEW_TOKEN$)/i.test(
          name,
        ),
    ),
  );
  return execFileSync(
    'git',
    ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', ...args],
    {
      cwd: root,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  ).trim();
}

function readinessDestination(root, value) {
  requireEvidence(typeof value === 'string' && value.length > 0);
  const destination = path.resolve(root, value);
  const relative = path.relative(root, destination);
  const segments = relative.split(path.sep);
  requireEvidence(
    segments[0] === 'test-results' && segments.length > 1 && !segments.includes('..'),
  );
  let ancestor = root;
  for (const segment of segments) {
    ancestor = path.join(ancestor, segment);
    const stat = fs.lstatSync(ancestor, { throwIfNoEntry: false });
    if (stat) {
      requireEvidence(stat.isDirectory() && !stat.isSymbolicLink());
    }
  }
  requireEvidence(!fs.existsSync(destination));
  return destination;
}

export async function prepareReadinessCheckout(root, options) {
  validateSelection(options);
  root = fs.realpathSync.native(root);
  requireEvidence(fs.realpathSync.native(git(root, ['rev-parse', '--show-toplevel'])) === root);
  const origin = git(root, ['remote', 'get-url', 'origin'])
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');
  requireEvidence(
    origin.toLowerCase() === `https://github.com/${options.repository}`.toLowerCase(),
  );
  requireEvidence(
    git(root, ['rev-parse', '--verify', `${options.revision}^{commit}`]) === options.revision,
  );
  const destination = readinessDestination(root, options.destination);
  for (const selection of options.selections)
    git(root, ['cat-file', '-e', `${options.revision}:${SOURCES[selection.kind].workflow}`]);
  const reports = await collectReadinessArtifacts(options);
  requireEvidence(readinessDestination(root, options.destination) === destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  git(root, ['worktree', 'add', '--detach', destination, options.revision]);
  requireEvidence(git(destination, ['rev-parse', 'HEAD']) === options.revision);
  requireEvidence(git(destination, ['status', '--porcelain', '--untracked-files=all']) === '');
  requireEvidence(!fs.existsSync(path.join(destination, 'reports')));
  for (const report of reports) {
    writeReadinessReport(destination, report.bytes);
    requireEvidence(
      git(destination, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        report.evidence.path,
      ]) === report.evidence.path,
    );
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'readiness-evidence-preparation',
    status: 'prepared',
    repository: options.repository,
    branch: options.branch,
    revision: options.revision,
    preparedAt: new Date(options.now ?? Date.now()).toISOString(),
    operationSuccessVerified: false,
    reports: reports.map((report) => report.evidence),
  };
  const directory = path.join(destination, 'test-results');
  fs.mkdirSync(directory, { recursive: true });
  requireEvidence(!fs.lstatSync(directory).isSymbolicLink());
  fs.writeFileSync(
    path.join(directory, 'readiness-evidence.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      flag: 'wx',
    },
  );
  return { checkout: destination, ...manifest };
}

async function main() {
  const { values } = parseArgs({
    options: {
      prepare: { type: 'boolean' },
      help: { type: 'boolean' },
      repository: { type: 'string' },
      branch: { type: 'string', default: 'main' },
      revision: { type: 'string' },
      report: { type: 'string', multiple: true },
      out: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node scripts/check-readiness-reports.mjs --prepare --repository OWNER/REPO --revision SHA --report KIND:RUN_ID:ATTEMPT --out test-results/NAME',
    );
    console.log(
      'KIND: bounded-agent-review, pr-observability, continuous-improvement-review. Repeat --report for different kinds at the same revision. --branch defaults to main.',
    );
    return;
  }
  requireEvidence(values.prepare === true);
  const selections = (values.report ?? []).map((value) => {
    const fields = value.split(':');
    requireEvidence(fields.length === 3);
    return { kind: fields[0], runId: fields[1], attempt: fields[2] };
  });
  const options = {
    repository: values.repository,
    branch: values.branch,
    revision: values.revision,
    selections,
    destination: values.out,
  };
  validateSelection(options);
  const token =
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 16 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const { createImprovementClient } = await import('./check-improvement.mjs');
  const prepared = await prepareReadinessCheckout(fileURLToPath(new URL('../', import.meta.url)), {
    ...options,
    client: createImprovementClient(values.repository, token),
  });
  console.log(
    JSON.stringify(
      {
        status: prepared.status,
        checkout: prepared.checkout,
        revision: prepared.revision,
        reports: prepared.reports.map(({ path: file, status }) => ({ path: file, status })),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      'Readiness preparation failed; verify the explicit revision, producer runs, artifact provenance, authentication, and unused output path. No evaluation was started.',
    );
    process.exitCode = 1;
  });
}
