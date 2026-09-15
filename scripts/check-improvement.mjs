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
  retentionDays: 90,
  retainedArchives: 16,
  retainedBytes: 4 * 1024 * 1024,
});

export function readImprovementArchive(bytes, files, allowedFiles) {
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
            (allowedFiles && !allowedFiles.includes(name)) ||
            ![0, 0x8000, 0x4000].includes(fileType) ||
            (entry.generalPurposeBitFlag & 1) !== 0
          )
            return fail();
          seen.add(name);
          if (!files.includes(name) && !allowedFiles) return archive.readEntry();
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

function validateRetainedRun(run, repository, branch, workflow, events) {
  requireEvidence(Number.isSafeInteger(run?.id) && run.id > 0 && run.run_attempt === 1);
  requireEvidence(
    run.repository?.full_name === repository && run.head_repository?.full_name === repository,
  );
  requireEvidence(run.path === `.github/workflows/${workflow}` && run.head_branch === branch);
  requireEvidence(events.includes(run.event) && run.status === 'completed');
  requireEvidence(/^[a-f0-9]{40}$/.test(run.head_sha));
  requireEvidence(['success', 'failure'].includes(run.conclusion));
}

function validateArtifactMetadata(artifact, run, name, allowExpired = false) {
  requireEvidence(artifact?.name === name);
  requireEvidence(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  requireEvidence(
    typeof artifact.expired === 'boolean' && (allowExpired || artifact.expired === false),
  );
  requireEvidence(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= IMPROVEMENT_LIMITS.archiveBytes,
  );
  requireEvidence(
    artifact.workflow_run?.id === run.id && artifact.workflow_run?.head_sha === run.head_sha,
  );
  requireEvidence(/^sha256:[a-f0-9]{64}$/.test(artifact.digest));
}

function verifyArtifactBytes(bytes, artifact) {
  requireEvidence(Buffer.isBuffer(bytes) && bytes.length === artifact.size_in_bytes);
  requireEvidence(`sha256:${createHash('sha256').update(bytes).digest('hex')}` === artifact.digest);
}

function retainedArtifactFiles(name) {
  if (name === 'ci-required') return ['ci-required.json', 'ci-contain-ci.json'];
  requireEvidence(UNIT_JOBS.some((job) => name === `ci-unit-${job}`));
  return ['ci-unit.json', ...UNIT_REPORTS];
}

export async function readRetainedImprovementEvidence(
  bytes,
  { repository, branch, run, artifact, now = Date.now() },
) {
  requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository) && repository.length <= 200);
  requireEvidence(typeof branch === 'string' && /^[\w./-]+$/.test(branch) && branch.length <= 200);
  validateRetainedRun(run, repository, branch, 'improvement.yml', [
    'schedule',
    'workflow_dispatch',
  ]);
  requireEvidence(run.conclusion === 'success');
  validateArtifactMetadata(artifact, run, `continuous-improvement-evidence-${run.id}-1`);
  verifyArtifactBytes(bytes, artifact);
  const reports = await readImprovementArchive(bytes, ['evidence.json'], ['evidence.json']);
  const bundle = reports.get('evidence.json');
  requireEvidence(bundle?.schemaVersion === 1 && bundle.kind === 'retained-improvement-evidence');
  requireEvidence(bundle.repository === repository && bundle.branch === branch);
  const collector = {
    revision: run.head_sha,
    runId: String(run.id),
    attempt: '1',
    eventName: run.event,
    workflow: `${repository}/.github/workflows/improvement.yml@refs/heads/${branch}`,
  };
  requireEvidence(
    Object.entries(collector).every(([key, value]) => bundle.collector?.[key] === value),
  );
  requireEvidence(
    Array.isArray(bundle.entries) && bundle.entries.length <= IMPROVEMENT_LIMITS.retainedArchives,
  );
  const completedAt = Date.parse(run.updated_at);
  requireEvidence(Number.isFinite(now) && Number.isFinite(completedAt) && completedAt <= now);
  const retained = new Map();
  let totalBytes = 0;
  for (const entry of bundle.entries) {
    requireEvidence(entry && typeof entry === 'object');
    validateRetainedRun(entry.run, repository, branch, 'ci.yml', ['push']);
    requireEvidence(
      ['ci-required', ...UNIT_JOBS.map((job) => `ci-unit-${job}`)].includes(entry.artifact?.name),
    );
    validateArtifactMetadata(entry.artifact, entry.run, entry.artifact.name);
    const capturedAt = Date.parse(entry.capturedAt);
    requireEvidence(
      typeof entry.capturedAt === 'string' &&
        Number.isFinite(capturedAt) &&
        capturedAt <= completedAt &&
        capturedAt <= now &&
        now - capturedAt <= IMPROVEMENT_LIMITS.retentionDays * 86_400_000,
    );
    requireEvidence(
      typeof entry.archive === 'string' &&
        entry.archive.length <= Math.ceil(IMPROVEMENT_LIMITS.retainedBytes / 3) * 4,
    );
    const original = Buffer.from(entry.archive, 'base64');
    requireEvidence(original.toString('base64') === entry.archive);
    totalBytes += original.length;
    requireEvidence(totalBytes <= IMPROVEMENT_LIMITS.retainedBytes);
    verifyArtifactBytes(original, entry.artifact);
    const allowed = retainedArtifactFiles(entry.artifact.name);
    await readImprovementArchive(original, [allowed[0]], allowed);
    const key = `${entry.run.id}/${entry.artifact.name}`;
    requireEvidence(!retained.has(key));
    retained.set(key, {
      run: entry.run,
      artifact: entry.artifact,
      capturedAt: entry.capturedAt,
      bytes: original,
      retainedFrom: {
        runId: String(run.id),
        artifactId: String(artifact.id),
        revision: run.head_sha,
        digest: artifact.digest,
      },
    });
  }
  return retained;
}

export function verifyImprovementRepair(proof, repair, evidence) {
  const result = {
    schemaVersion: 1,
    kind: 'repair-history',
    findingId: proof?.findingId,
    verified: false,
    reviewRequired: true,
    automaticRepair: false,
  };
  if (repair === undefined) return { ...result, missing: ['repair-reference'] };
  let missing = 'verified-regression';
  try {
    requireEvidence(proof?.kind === 'regression-proof' && proof.verified === true);
    requireEvidence(
      /^[a-f0-9]{40}$/.test(proof.before?.revision) &&
        /^[a-f0-9]{40}$/.test(proof.after?.revision) &&
        proof.before.revision !== proof.after.revision,
    );
    missing = 'repair-reference';
    requireEvidence(/^[a-f0-9]{40}$/.test(repair?.fixCommit));
    requireEvidence(Number.isSafeInteger(repair.pullRequest) && repair.pullRequest > 0);
    missing = 'repair-history';
    const { repository, branch, pull, commits, comparison, reviews } = evidence;
    requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository) && repository.length <= 200);
    requireEvidence(typeof branch === 'string' && /^[\w./-]+$/.test(branch));
    missing = 'merged-pull-request';
    requireEvidence(pull?.number === repair.pullRequest && pull.merged === true);
    requireEvidence(pull.state === 'closed' && pull.merge_commit_sha === proof.after.revision);
    requireEvidence(
      pull.base?.repo?.full_name === repository &&
        pull.head?.repo?.full_name === repository &&
        pull.base.ref === branch &&
        /^[a-f0-9]{40}$/.test(pull.head.sha),
    );
    requireEvidence(Number.isSafeInteger(pull.user?.id) && pull.user.id > 0);
    const mergedAt = Date.parse(pull.merged_at);
    requireEvidence(Number.isFinite(mergedAt) && mergedAt <= Date.now());
    missing = 'fix-commit-membership';
    requireEvidence(
      Number.isInteger(pull.commits) &&
        pull.commits > 0 &&
        pull.commits < 100 &&
        Array.isArray(commits) &&
        commits.length === pull.commits,
    );
    requireEvidence(commits.every((commit) => /^[a-f0-9]{40}$/.test(commit?.sha)));
    requireEvidence(new Set(commits.map((commit) => commit.sha)).size === commits.length);
    requireEvidence(commits.some((commit) => commit.sha === repair.fixCommit));
    requireEvidence(commits.some((commit) => commit.sha === pull.head.sha));
    missing = 'failure-merge-ancestry';
    requireEvidence(
      comparison?.status === 'ahead' &&
        comparison.base_commit?.sha === proof.before.revision &&
        comparison.merge_base_commit?.sha === proof.before.revision,
    );
    requireEvidence(
      Number.isInteger(comparison.total_commits) &&
        comparison.total_commits > 0 &&
        comparison.total_commits < 100 &&
        Array.isArray(comparison.commits) &&
        comparison.commits.length === comparison.total_commits,
    );
    requireEvidence(comparison.commits.every((commit) => /^[a-f0-9]{40}$/.test(commit?.sha)));
    requireEvidence(
      new Set(comparison.commits.map((commit) => commit.sha)).size === comparison.commits.length &&
        comparison.commits.at(-1).sha === proof.after.revision,
    );
    missing = 'final-head-human-approval';
    requireEvidence(Array.isArray(reviews) && reviews.length < 100);
    requireEvidence(new Set(reviews.map((review) => review.id)).size === reviews.length);
    const latest = new Map();
    for (const review of reviews) {
      requireEvidence(Number.isSafeInteger(review?.id) && review.id > 0);
      requireEvidence(Number.isSafeInteger(review.user?.id) && review.user.id > 0);
      requireEvidence(
        review.pull_request_url ===
          `https://api.github.com/repos/${repository}/pulls/${repair.pullRequest}`,
      );
      requireEvidence(
        ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(
          review.state,
        ),
      );
      if (review.state === 'PENDING') continue;
      const submittedAt = Date.parse(review.submitted_at);
      requireEvidence(Number.isFinite(submittedAt));
      if (submittedAt > mergedAt || review.state === 'COMMENTED') continue;
      const previous = latest.get(review.user.id);
      if (
        !previous ||
        submittedAt > Date.parse(previous.submitted_at) ||
        (submittedAt === Date.parse(previous.submitted_at) && review.id > previous.id)
      )
        latest.set(review.user.id, review);
    }
    requireEvidence([...latest.values()].every((review) => review.state !== 'CHANGES_REQUESTED'));
    const approvals = [...latest.values()].filter(
      (review) =>
        review.state === 'APPROVED' &&
        review.commit_id === pull.head.sha &&
        review.user.type === 'User' &&
        review.user.id !== pull.user.id &&
        ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review.author_association),
    );
    requireEvidence(approvals.length > 0);
    return {
      ...result,
      verified: true,
      missing: [],
      fixCommit: repair.fixCommit,
      pullRequest: repair.pullRequest,
      pullRequestUrl: `https://github.com/${repository}/pull/${repair.pullRequest}`,
      mergeCommit: pull.merge_commit_sha,
      mergedAt: pull.merged_at,
      reviews: approvals.map((review) => ({
        id: review.id,
        reviewerId: review.user.id,
        commit: review.commit_id,
        submittedAt: review.submitted_at,
        url: `https://github.com/${repository}/pull/${repair.pullRequest}#pullrequestreview-${review.id}`,
      })),
    };
  } catch {
    return { ...result, missing: [missing] };
  }
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
    requireEvidence(
      typeof resource === 'string' &&
        resource.length <= 500 &&
        !hasControlCharacters(resource) &&
        ((resource.startsWith('/actions/') && !resource.includes('..')) ||
          /^\/pulls\/[1-9]\d{0,15}(?:\/(?:reviews|commits)\?per_page=100)?$/.test(resource) ||
          /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=100$/.test(resource)),
    );
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
    requireEvidence(regression && typeof regression === 'object' && !Array.isArray(regression));
    const expectedKeys = Object.hasOwn(regression, 'repair') ? [...keys, 'repair'].sort() : keys;
    requireEvidence(
      JSON.stringify(Object.keys(regression).sort()) === JSON.stringify(expectedKeys),
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
    if (Object.hasOwn(regression, 'repair')) {
      const repair = regression.repair;
      requireEvidence(
        repair &&
          JSON.stringify(Object.keys(repair).sort()) ===
            JSON.stringify(['fixCommit', 'pullRequest']),
      );
      requireEvidence(/^[a-f0-9]{40}$/.test(repair.fixCommit));
      requireEvidence(Number.isSafeInteger(repair.pullRequest) && repair.pullRequest > 0);
    }
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
  const repairs = [];
  const knownRuns = new Map();
  const snapshots = new Map();
  const artifactLists = new Map();
  const captures = new Map();
  const evidenceKeys = new Set();
  const retentionErrors = new Set();
  const regressionKeys = (regression) =>
    [regression.beforeRunId, regression.afterRunId].flatMap((runId) => [
      `${runId}/ci-required`,
      `${runId}/ci-unit-${regression.job}`,
    ]);
  const eligibleKeys = new Set(regressions.flatMap(regressionKeys));
  const verifiedKeys = new Set();
  let retainedHistory;
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
  const listArtifacts = async (run) => {
    if (!artifactLists.has(run.id)) {
      const listing = await client.json(`/actions/runs/${run.id}/artifacts?per_page=20`);
      requireEvidence(Array.isArray(listing.artifacts) && listing.artifacts.length <= 20);
      requireEvidence(listing.total_count === listing.artifacts.length);
      artifactLists.set(run.id, listing.artifacts);
    }
    return artifactLists.get(run.id);
  };
  const recoverHistory = () => {
    retainedHistory ??= (async () => {
      const listing = await client.json(
        `/actions/workflows/improvement.yml/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${IMPROVEMENT_LIMITS.runsPerWorkflow}`,
      );
      requireEvidence(
        Array.isArray(listing.workflow_runs) &&
          listing.workflow_runs.length <= IMPROVEMENT_LIMITS.runsPerWorkflow,
      );
      requireEvidence(
        new Set(listing.workflow_runs.map((run) => run.id)).size === listing.workflow_runs.length,
      );
      const originals = new Map();
      let size = 0;
      for (const run of listing.workflow_runs.slice().sort((left, right) => right.id - left.id)) {
        try {
          validateRetainedRun(run, repository, branch, 'improvement.yml', [
            'schedule',
            'workflow_dispatch',
          ]);
          requireEvidence(run.conclusion === 'success');
          const name = `continuous-improvement-evidence-${run.id}-1`;
          const matches = (await listArtifacts(run)).filter((artifact) => artifact.name === name);
          requireEvidence(matches.length === 1);
          validateArtifactMetadata(matches[0], run, name);
          const entries = await readRetainedImprovementEvidence(await client.archive(matches[0]), {
            repository,
            branch,
            run,
            artifact: matches[0],
          });
          for (const [key, entry] of entries) {
            if (!eligibleKeys.has(key) || originals.has(key)) continue;
            requireEvidence(size + entry.bytes.length <= IMPROVEMENT_LIMITS.retainedBytes);
            size += entry.bytes.length;
            originals.set(key, entry);
          }
          if ([...eligibleKeys].every((key) => originals.has(key))) break;
        } catch {
          continue;
        }
      }
      return originals;
    })();
    return retainedHistory;
  };
  const readArtifact = async (run, name, files) => {
    const key = `${run.id}/${name}`;
    const eligible = eligibleKeys.has(key);
    if (eligible) validateRetainedRun(run, repository, branch, 'ci.yml', ['push']);
    const matches = (await listArtifacts(run)).filter((artifact) => artifact.name === name);
    requireEvidence(matches.length <= 1);
    const current = matches[0];
    if (current) validateArtifactMetadata(current, run, name, true);
    let capture = captures.get(key);
    if (!capture && current && !current.expired) {
      const bytes = await client.archive(current);
      verifyArtifactBytes(bytes, current);
      capture = {
        run: {
          id: run.id,
          run_attempt: run.run_attempt,
          event: run.event,
          status: run.status,
          head_sha: run.head_sha,
          head_branch: run.head_branch,
          path: run.path,
          conclusion: run.conclusion,
          repository: { full_name: repository },
          head_repository: { full_name: repository },
        },
        artifact: {
          id: current.id,
          name,
          expired: false,
          size_in_bytes: current.size_in_bytes,
          digest: current.digest,
          workflow_run: { id: run.id, head_sha: run.head_sha },
        },
        capturedAt: new Date().toISOString(),
        bytes,
      };
    }
    if (!capture) {
      requireEvidence(eligible);
      capture = (await recoverHistory()).get(key);
      requireEvidence(capture);
      requireEvidence(
        JSON.stringify(expectedRun(capture.run, SOURCES[0])) ===
          JSON.stringify(expectedRun(run, SOURCES[0])),
      );
      if (current)
        requireEvidence(
          current.id === capture.artifact.id &&
            current.digest === capture.artifact.digest &&
            current.size_in_bytes === capture.artifact.size_in_bytes,
        );
    }
    const reports = await readImprovementArchive(
      capture.bytes,
      files,
      eligible ? retainedArtifactFiles(name) : undefined,
    );
    if (!evidenceKeys.has(key)) {
      evidenceKeys.add(key);
      evidence.push({
        runId: String(run.id),
        artifactId: String(capture.artifact.id),
        name,
        digest: capture.artifact.digest,
        source: capture.retainedFrom ? 'retained' : 'live',
        capturedAt: capture.capturedAt,
        ...(capture.retainedFrom ? { retainedFrom: capture.retainedFrom } : {}),
      });
    }
    if (eligible && !captures.has(key)) {
      const size = [...captures.values()].reduce((total, entry) => total + entry.bytes.length, 0);
      if (
        captures.size >= IMPROVEMENT_LIMITS.retainedArchives ||
        size + capture.bytes.length > IMPROVEMENT_LIMITS.retainedBytes
      )
        retentionErrors.add('Registered originals exceed the bounded retention budget.');
      else captures.set(key, capture);
    }
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
      const proof = verifyImprovementRegression(finding, regression, ...history);
      proofs.push(proof);
      if (proof.verified) regressionKeys(regression).forEach((key) => verifiedKeys.add(key));
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
    const proof = proofs.at(-1);
    let details;
    if (proof.verified && regression.repair) {
      try {
        const number = regression.repair.pullRequest;
        details = {
          repository,
          branch,
          pull: await client.json(`/pulls/${number}`),
          commits: await client.json(`/pulls/${number}/commits?per_page=100`),
          reviews: await client.json(`/pulls/${number}/reviews?per_page=100`),
          comparison: await client.json(
            `/compare/${proof.before.revision}...${proof.after.revision}?per_page=100`,
          ),
        };
      } catch {
        details = undefined;
      }
    }
    repairs.push(verifyImprovementRepair(proof, regression.repair, details));
  }
  const entries = [...verifiedKeys]
    .filter((key) => captures.has(key))
    .map((key) => captures.get(key));
  const retention = {
    status:
      regressions.length === 0
        ? 'not-requested'
        : proofs.every((proof) => proof.verified) &&
            entries.length === verifiedKeys.size &&
            retentionErrors.size === 0
          ? 'ready'
          : 'insufficient-evidence',
    retentionDays: IMPROVEMENT_LIMITS.retentionDays,
    archives: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes.length, 0),
    recoveredArchives: entries.filter((entry) => entry.retainedFrom).length,
    earliestExpiry:
      entries.length === 0
        ? null
        : new Date(
            Math.min(...entries.map((entry) => Date.parse(entry.capturedAt))) +
              IMPROVEMENT_LIMITS.retentionDays * 86_400_000,
          ).toISOString(),
    errors: [...retentionErrors],
  };
  return {
    schemaVersion: 1,
    kind: 'continuous-improvement-review',
    source: 'github-actions',
    repository,
    branch,
    status:
      comparisons.every((report) => report.status === 'reported') &&
      proofs.every((proof) => proof.verified) &&
      repairs.every((repair, index) => !regressions[index].repair || repair.verified) &&
      retention.status !== 'insufficient-evidence'
        ? 'reported'
        : 'insufficient-evidence',
    automaticRetry: false,
    automaticRepair: false,
    comparisons,
    regressions: proofs,
    repairHistoryStatus:
      repairs.length === 0
        ? 'not-requested'
        : repairs.every((repair) => repair.verified)
          ? 'verified'
          : 'insufficient-evidence',
    repairs,
    retention,
    retainedEvidence: {
      schemaVersion: 1,
      kind: 'retained-improvement-evidence',
      repository,
      branch,
      entries: (retention.status === 'ready' ? entries : []).map(
        ({ run, artifact, capturedAt, bytes }) => ({
          run,
          artifact,
          capturedAt,
          archive: bytes.toString('base64'),
        }),
      ),
    },
    evidence,
    errors,
    limits: IMPROVEMENT_LIMITS,
    residual: [
      'Only completed default-branch push runs are compared; PR and fork artifacts are not consumed.',
      'API metadata binds run, attempt, workflow and head; push base revisions remain report-declared.',
      'Only registered pairs can recover originals from authenticated successful first-attempt improvement runs.',
      'Retained capture timestamps are not renewed by copying; repository retention policy may shorten availability.',
      'Reruns, missing history and unavailable originals cannot establish improvement.',
      'Named regressions and live review/merge history are separate; neither establishes causality or automatic repair.',
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
      Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) &&
      env.GITHUB_RUN_ATTEMPT === '1',
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
  let retainedEvidence;
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
    const collected = await collectImprovementReports({
      repository,
      branch: event.repository.default_branch,
      client: client ?? createImprovementClient(repository, env.GITHUB_TOKEN),
      registry,
    });
    const { retainedEvidence: originals, ...compactReport } = collected;
    retainedEvidence = { ...originals, collector };
    report = {
      ...compactReport,
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
    `Review and merge history: ${report.repairHistoryStatus ?? 'local-unverified'}.`,
    `Original evidence retention: ${report.retention?.status ?? 'local-unverified'}.`,
    ...(report.repairs ?? []).map((repair) =>
      repair.verified
        ? `- Verified history: ${repair.pullRequestUrl}; fix ${repair.fixCommit}; merge ${repair.mergeCommit}.`
        : `- Missing history for ${repair.findingId}: ${repair.missing.join(', ')}.`,
    ),
    '',
    'CI recovery is not causal or automatic repair proof. Evidence still requires human review.',
    'Only authenticated retained originals can outlive source expiry; copying does not renew capture time.',
    'Missing history and reruns do not establish success.',
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
  const relativeDirectory = path.relative(root, outputDirectory).split(path.sep).join('/');
  if (retainedEvidence) {
    fs.writeFileSync(
      path.join(outputDirectory, 'evidence.json'),
      `${JSON.stringify(retainedEvidence, null, 2)}\n`,
    );
    if (env.GITHUB_OUTPUT)
      fs.appendFileSync(env.GITHUB_OUTPUT, `evidence-path=${relativeDirectory}/evidence.json\n`);
  }
  if (report.collector && env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  return {
    report,
    outputDirectory: relativeDirectory,
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
