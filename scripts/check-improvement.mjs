import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yauzl from 'yauzl';
import {
  compareImprovementReports,
  verifyImprovementRegression,
  UNIT_JOBS,
  UNIT_REPORTS,
} from './check-ci.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function hasControlCharacters(value) {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export const IMPROVEMENT_LIMITS = Object.freeze({
  archiveBytes: 20 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  reportBytes: 8 * 1024 * 1024,
  archiveEntries: 64,
  requestTimeoutMs: 15_000,
  collectionTimeoutMs: 180_000,
  runsPerWorkflow: 10,
  regressions: 4,
});

export function readImprovementArchive(bytes, files) {
  return new Promise((resolve, reject) => {
    let archive;
    const fail = () => {
      clearTimeout(deadline);
      archive?.close();
      reject(new Error('Artifact ZIP is missing, malformed, unsafe, or over its limit'));
    };
    const deadline = setTimeout(fail, IMPROVEMENT_LIMITS.requestTimeoutMs);
    deadline.unref();
    if (!Buffer.isBuffer(bytes) || bytes.length > IMPROVEMENT_LIMITS.archiveBytes) {
      fail();
      return;
    }
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, opened) => {
        if (error) return fail();
        archive = opened;
        const reports = new Map();
        const seen = new Set();
        let expandedBytes = 0;
        archive.on('error', fail);
        archive.on('entry', (entry) => {
          const name = entry.fileName;
          const fileType = (entry.externalFileAttributes >>> 16) & 0xf000;
          expandedBytes += entry.uncompressedSize;
          if (
            seen.has(name) ||
            seen.size >= IMPROVEMENT_LIMITS.archiveEntries ||
            expandedBytes > IMPROVEMENT_LIMITS.expandedBytes ||
            entry.uncompressedSize > IMPROVEMENT_LIMITS.reportBytes ||
            name.startsWith('/') ||
            name.includes('\\') ||
            name.includes(':') ||
            hasControlCharacters(name) ||
            name.split('/').includes('..') ||
            ![0, 0x8000, 0x4000].includes(fileType) ||
            (entry.generalPurposeBitFlag & 1) !== 0
          )
            return fail();
          seen.add(name);
          if (!files.includes(name)) return archive.readEntry();
          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail();
            const chunks = [];
            let size = 0;
            stream.on('error', fail);
            stream.on('data', (chunk) => {
              size += chunk.length;
              if (size > IMPROVEMENT_LIMITS.reportBytes) {
                stream.destroy();
                fail();
              } else chunks.push(chunk);
            });
            stream.on('end', () => {
              try {
                if (size !== entry.uncompressedSize) return fail();
                reports.set(name, JSON.parse(Buffer.concat(chunks).toString('utf8')));
                archive.readEntry();
              } catch {
                fail();
              }
            });
          });
        });
        archive.on('end', () => {
          clearTimeout(deadline);
          archive.close();
          if (files.every((file) => reports.has(file))) resolve(reports);
          else fail();
        });
        archive.readEntry();
      },
    );
  });
}

function requireEvidence(value) {
  if (!value) throw new Error('Invalid improvement evidence or configuration');
}

async function responseBytes(response, limit) {
  requireEvidence(response.ok && response.body);
  requireEvidence(Number(response.headers.get('content-length') ?? 0) <= limit);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      requireEvidence(size <= limit);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

export function createImprovementClient(repository, token, fetcher = fetch) {
  requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository) && repository.length <= 200);
  requireEvidence(typeof token === 'string' && token.length > 0);
  const budget = AbortSignal.timeout(IMPROVEMENT_LIMITS.collectionTimeoutMs);
  const request = (resource) => {
    requireEvidence(resource.startsWith('/actions/') && !resource.includes('..'));
    return fetcher(`https://api.github.com/repos/${repository}${resource}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.any([budget, AbortSignal.timeout(IMPROVEMENT_LIMITS.requestTimeoutMs)]),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Slipstream-improvement-report',
      },
    });
  };
  return {
    async json(resource) {
      return JSON.parse(
        (await responseBytes(await request(resource), 2 * 1024 * 1024)).toString('utf8'),
      );
    },
    async archive(artifact) {
      requireEvidence(Number.isSafeInteger(artifact.id) && artifact.id > 0);
      requireEvidence(/^sha256:[a-f0-9]{64}$/.test(artifact.digest));
      const response = await request(`/actions/artifacts/${artifact.id}/zip`);
      requireEvidence(response.status === 302);
      const location = new URL(response.headers.get('location'));
      requireEvidence(
        location.protocol === 'https:' &&
          !location.username &&
          !location.password &&
          !location.port,
      );
      requireEvidence(
        /\.(blob\.core\.windows\.net|actions\.githubusercontent\.com|githubusercontent\.com)$/.test(
          location.hostname,
        ),
      );
      const download = await fetcher(location.href, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.any([budget, AbortSignal.timeout(IMPROVEMENT_LIMITS.requestTimeoutMs)]),
      });
      const bytes = await responseBytes(download, IMPROVEMENT_LIMITS.archiveBytes);
      requireEvidence(
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` === artifact.digest,
      );
      return bytes;
    },
  };
}

const SOURCES = [
  {
    workflow: 'ci.yml',
    artifact: 'ci-required',
    file: 'ci-required.json',
    kind: 'required-validation',
  },
  {
    workflow: 'security.yml',
    artifact: 'security-required',
    file: 'ci-security.json',
    kind: 'security-validation',
  },
];

export function validateImprovementRegistry(registry) {
  requireEvidence(registry?.schemaVersion === 1 && Array.isArray(registry.regressions));
  requireEvidence(registry.regressions.length <= IMPROVEMENT_LIMITS.regressions);
  const keys = ['findingId', 'job', 'suite', 'testName', 'beforeRunId', 'afterRunId'].sort();
  const seen = new Set();
  for (const regression of registry.regressions) {
    requireEvidence(
      regression && JSON.stringify(Object.keys(regression).sort()) === JSON.stringify(keys),
    );
    requireEvidence(/^[a-f0-9]{64}$/.test(regression.findingId));
    requireEvidence(UNIT_JOBS.includes(regression.job) && UNIT_REPORTS.includes(regression.suite));
    requireEvidence(
      typeof regression.testName === 'string' && regression.testName.trim().length > 0,
    );
    requireEvidence(
      regression.testName.length <= 300 && !hasControlCharacters(regression.testName),
    );
    for (const key of ['beforeRunId', 'afterRunId']) {
      requireEvidence(
        typeof regression[key] === 'string' && /^[1-9]\d{0,19}$/.test(regression[key]),
      );
      requireEvidence(Number.isSafeInteger(Number(regression[key])));
    }
    requireEvidence(BigInt(regression.beforeRunId) < BigInt(regression.afterRunId));
    const signature = JSON.stringify(keys.map((key) => regression[key]));
    requireEvidence(!seen.has(signature));
    seen.add(signature);
  }
  return registry.regressions;
}

export async function collectImprovementReports({
  repository,
  branch,
  client,
  registry = { schemaVersion: 1, regressions: [] },
}) {
  const regressions = validateImprovementRegistry(registry);
  requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository) && repository.length <= 200);
  requireEvidence(typeof branch === 'string' && /^[\w./-]+$/.test(branch) && branch.length <= 200);
  const evidence = [];
  const errors = [];
  const comparisons = [];
  const proofs = [];
  const knownRuns = new Map();
  const snapshots = new Map();
  const artifactLists = new Map();
  const expectedRun = (run, source) => {
    requireEvidence(Number.isSafeInteger(run.id) && run.id > 0);
    requireEvidence(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
    requireEvidence(
      run.repository?.full_name === repository && run.head_repository?.full_name === repository,
    );
    requireEvidence(run.path === `.github/workflows/${source.workflow}`);
    requireEvidence(
      run.event === 'push' && run.head_branch === branch && run.status === 'completed',
    );
    requireEvidence(/^[a-f0-9]{40}$/.test(run.head_sha));
    return {
      revision: run.head_sha,
      runId: String(run.id),
      attempt: String(run.run_attempt),
      eventName: 'push',
      workflow: `${repository}/.github/workflows/${source.workflow}@refs/heads/${branch}`,
      headRevision: run.head_sha,
      baseRevision: null,
      kind: source.kind,
      conclusion: run.conclusion,
    };
  };
  const readArtifact = async (run, name, files) => {
    if (!artifactLists.has(run.id)) {
      const listing = await client.json(`/actions/runs/${run.id}/artifacts?per_page=20`);
      requireEvidence(Array.isArray(listing.artifacts) && listing.artifacts.length <= 20);
      requireEvidence(listing.total_count === listing.artifacts.length);
      artifactLists.set(run.id, listing.artifacts);
    }
    const matches = artifactLists.get(run.id).filter((artifact) => artifact.name === name);
    requireEvidence(matches.length === 1);
    const artifact = matches[0];
    requireEvidence(
      artifact.expired === false && Number.isSafeInteger(artifact.id) && artifact.id > 0,
    );
    requireEvidence(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0);
    requireEvidence(artifact.size_in_bytes <= IMPROVEMENT_LIMITS.archiveBytes);
    requireEvidence(
      artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === run.head_sha,
    );
    requireEvidence(/^sha256:[a-f0-9]{64}$/.test(artifact.digest));
    const bytes = await client.archive(artifact);
    requireEvidence(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` === artifact.digest,
    );
    const reports = await readImprovementArchive(bytes, files);
    evidence.push({
      runId: String(run.id),
      artifactId: String(artifact.id),
      name,
      digest: artifact.digest,
    });
    return reports;
  };
  const snapshot = async (run, source) => {
    const expected = expectedRun(run, source);
    if (snapshots.has(run.id)) return snapshots.get(run.id);
    let report = null;
    try {
      report = (await readArtifact(run, source.artifact, [source.file])).get(source.file);
      requireEvidence(
        report && (report.baseRevision === null || /^[a-f0-9]{40}$/.test(report.baseRevision)),
      );
      expected.baseRevision = report.baseRevision;
    } catch {
      report = null;
      errors.push(`${source.workflow} run ${run.id}: aggregate artifact unavailable or invalid`);
    }
    const value = { expected, report };
    snapshots.set(run.id, value);
    return value;
  };
  for (const source of SOURCES) {
    try {
      const listing = await client.json(
        `/actions/workflows/${source.workflow}/runs?branch=${encodeURIComponent(branch)}&event=push&status=completed&per_page=${IMPROVEMENT_LIMITS.runsPerWorkflow}`,
      );
      requireEvidence(
        Array.isArray(listing.workflow_runs) &&
          listing.workflow_runs.length <= IMPROVEMENT_LIMITS.runsPerWorkflow,
      );
      const runs = listing.workflow_runs;
      runs.forEach((run) => {
        expectedRun(run, source);
        knownRuns.set(run.id, run);
      });
      requireEvidence(new Set(runs.map((run) => run.id)).size === runs.length);
      const latest = runs
        .slice()
        .sort((left, right) => left.id - right.id)
        .slice(-2);
      const history = [];
      for (const run of latest) history.push(await snapshot(run, source));
      comparisons.push({
        workflow: source.workflow,
        ...compareImprovementReports(
          history.length === 2 ? history[0] : null,
          history.at(-1) ?? null,
        ),
      });
    } catch {
      errors.push(`${source.workflow}: run history unavailable or invalid`);
      comparisons.push({ workflow: source.workflow, ...compareImprovementReports(null, null) });
    }
  }
  for (const regression of regressions) {
    try {
      const history = [];
      for (const runId of [regression.beforeRunId, regression.afterRunId]) {
        const run = knownRuns.get(Number(runId)) ?? (await client.json(`/actions/runs/${runId}`));
        requireEvidence(String(run.id) === runId);
        const aggregate = await snapshot(run, SOURCES[0]);
        const reports = await readArtifact(run, `ci-unit-${regression.job}`, [
          'ci-unit.json',
          regression.suite,
        ]);
        history.push({
          ...aggregate,
          unit: reports.get('ci-unit.json'),
          tests: reports.get(regression.suite),
        });
      }
      const comparison = compareImprovementReports(...history);
      const finding = comparison.findings.find((entry) => entry.id === regression.findingId);
      requireEvidence(finding);
      proofs.push(verifyImprovementRegression(finding, regression, ...history));
    } catch {
      proofs.push({
        schemaVersion: 1,
        kind: 'regression-proof',
        findingId: regression.findingId,
        verified: false,
        reviewRequired: true,
        reason: 'The configured run pair or its regression artifacts are unavailable or invalid.',
      });
    }
  }
  return {
    schemaVersion: 1,
    kind: 'continuous-improvement-review',
    source: 'github-actions',
    repository,
    branch,
    status:
      comparisons.every((report) => report.status === 'reported') &&
      proofs.every((proof) => proof.verified)
        ? 'reported'
        : 'insufficient-evidence',
    automaticRetry: false,
    automaticRepair: false,
    comparisons,
    regressions: proofs,
    evidence,
    errors,
    limits: IMPROVEMENT_LIMITS,
    residual: [
      'Only completed default-branch push runs are compared; PR and fork artifacts are not consumed.',
      'API metadata binds run, attempt, workflow and head; push base revisions remain report-declared.',
      'Reruns, expired artifacts and missing history cannot establish improvement.',
      'A verified named regression does not establish review, causal attribution, or live-agent quality.',
    ],
  };
}

export function improvementIdentity(env, event) {
  const repository = event.repository?.full_name;
  const branch = event.repository?.default_branch;
  requireEvidence(env.GITHUB_ACTIONS === 'true' && env.SLIPSTREAM_IMPROVEMENT_ENABLED === 'true');
  requireEvidence(typeof repository === 'string' && typeof branch === 'string');
  requireEvidence(
    env.GITHUB_REPOSITORY === repository && env.GITHUB_REF === `refs/heads/${branch}`,
  );
  requireEvidence(
    env.GITHUB_WORKFLOW_REF ===
      `${repository}/.github/workflows/improvement.yml@refs/heads/${branch}`,
  );
  requireEvidence(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  requireEvidence(
    env.GITHUB_SERVER_URL === 'https://github.com' &&
      env.GITHUB_API_URL === 'https://api.github.com',
  );
  requireEvidence(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''));
  requireEvidence(
    /^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '') &&
      /^[1-9]\d{0,9}$/.test(env.GITHUB_RUN_ATTEMPT ?? ''),
  );
  return {
    revision: env.GITHUB_SHA,
    workflow: env.GITHUB_WORKFLOW_REF,
    eventName: env.GITHUB_EVENT_NAME,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  };
}

function readLocalJson(file, limit) {
  const info = fs.lstatSync(file);
  requireEvidence(info.isFile() && !info.isSymbolicLink() && info.size <= limit);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function runImprovementReview(
  root,
  { env = process.env, event = {}, input, client } = {},
) {
  let report;
  if (input) {
    requireEvidence(env.GITHUB_ACTIONS !== 'true');
    const bundle = readLocalJson(input, 1024 * 1024);
    requireEvidence(bundle.schemaVersion === 1);
    const comparison = compareImprovementReports(bundle.before, bundle.after);
    report = {
      schemaVersion: 1,
      kind: 'continuous-improvement-review',
      source: 'local-unverified',
      status: comparison.status,
      automaticRetry: false,
      automaticRepair: false,
      comparisons: [comparison],
      regressions: [],
      evidence: [],
      errors: [],
      residual: ['Local input is not authenticated GitHub evidence or an observed workflow run.'],
    };
  } else {
    const collector = improvementIdentity(env, event);
    const repository = event.repository.full_name;
    const registry = readLocalJson(
      path.join(root, '.github', 'improvement-regressions.json'),
      64 * 1024,
    );
    report = {
      ...(await collectImprovementReports({
        repository,
        branch: event.repository.default_branch,
        client: client ?? createImprovementClient(repository, env.GITHUB_TOKEN),
        registry,
      })),
      collector,
    };
  }
  const counts = Object.fromEntries(
    ['new', 'recurring', 'cleared', 'unverified'].map((status) => [
      status,
      report.comparisons
        .flatMap((comparison) => comparison.findings)
        .filter((finding) => finding.status === status).length,
    ]),
  );
  const summary = [
    '## Continuous Improvement',
    '',
    `Source: ${report.source}. Result: ${report.status}.`,
    '',
    '| New | Recurring | Cleared CI Symptoms | Unverified | Verified Regression Pairs |',
    '| --- | --- | --- | --- | --- |',
    `| ${counts.new} | ${counts.recurring} | ${counts.cleared} | ${counts.unverified} | ${report.regressions.filter((proof) => proof.verified).length} |`,
    '',
    'CI recovery is not proof of a repair. Regression evidence still requires human review.',
    'Missing history, reruns, and expired artifacts do not establish success.',
    '',
  ].join('\n');
  const base = path.join(root, 'test-results', 'improvement');
  fs.mkdirSync(base, { recursive: true });
  const outputDirectory = fs.mkdtempSync(path.join(base, 'run-'));
  fs.writeFileSync(
    path.join(outputDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(outputDirectory, 'summary.md'), summary);
  if (report.collector && env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return {
    report,
    outputDirectory: path.relative(root, outputDirectory).split(path.sep).join('/'),
  };
}

async function main() {
  const { values } = parseArgs({ options: { input: { type: 'string' } } });
  const event = values.input ? {} : readLocalJson(process.env.GITHUB_EVENT_PATH, 2 * 1024 * 1024);
  const result = await runImprovementReview(ROOT, { input: values.input, event });
  console.log(
    JSON.stringify({
      status: result.report.status,
      source: result.report.source,
      outputDirectory: result.outputDirectory,
    }),
  );
  process.exitCode = result.report.status === 'reported' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Improvement review failed; no successful evidence was produced.');
    process.exitCode = 1;
  });
}
