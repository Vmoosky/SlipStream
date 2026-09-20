import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Minimatch } from 'minimatch';
import { parse } from 'yaml';
import yauzl from 'yauzl';
import { DOC_CONTRACTS } from './check-ci.mjs';
import { MAINTENANCE_LIMITS, validateDocumentationProposal } from './maintenance.mjs';
import { createImprovementClient } from './check-improvement.mjs';
import { writeReadinessReport } from './check-readiness-reports.mjs';

export const PR_OBSERVABILITY_LIMITS = Object.freeze({
  files: 100,
  bodyBytes: 64 * 1024,
  archiveBytes: 1024 * 1024,
  documentBytes: 1024 * 1024,
  responseBytes: 2 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  collectionTimeoutMs: 180_000,
});

const VALIDATION_WORKFLOWS = Object.freeze({ CI: 'ci.yml', Security: 'security.yml' });
const AGENT_REVIEW_WORKFLOW = Object.freeze({
  name: 'PR Agent Review',
  path: 'pr-agent-review.yml',
});

export const PR_OBSERVABILITY_LABELS = Object.freeze({
  'area:core': { color: '0366d6', description: 'Core compression, pricing, or dashboard changes' },
  'area:extension': { color: '1d76db', description: 'VS Code extension changes' },
  'area:mcp': { color: '0075ca', description: 'MCP server changes' },
  'area:hooks': { color: '0e8a16', description: 'Hook runtime changes' },
  'area:plugin': { color: '006b75', description: 'Copilot plugin changes' },
  'area:tooling': {
    color: '5319e7',
    description: 'Repository tooling, checks, or workflow changes',
  },
  'area:docs': { color: '0052cc', description: 'Documentation changes' },
  'automation:maintenance': {
    color: '0e8a16',
    description:
      'Maintenance proposal verified at the linked PR snapshot; not approval or authorship',
  },
  'automation:agent-review': {
    color: '5319e7',
    description:
      'Trusted bounded agent review completed for the linked PR snapshot; not approval or authorship',
  },
});

const AREA_LABEL_CONFIGURATION = parse(
  fs.readFileSync(new URL('../.github/labeler.yml', import.meta.url), 'utf8'),
  { maxAliasCount: 0 },
);

function areaLabelRules(configuration) {
  requireEvidence(
    configuration && typeof configuration === 'object' && !Array.isArray(configuration),
  );
  const entries = Object.entries(configuration);
  requireEvidence(
    entries.length > 0 && entries.length < Object.keys(PR_OBSERVABILITY_LABELS).length,
  );
  return entries.map(([label, rules]) => {
    requireEvidence(label.startsWith('area:') && Object.hasOwn(PR_OBSERVABILITY_LABELS, label));
    requireEvidence(Array.isArray(rules) && rules.length === 1);
    const group = rules[0];
    requireEvidence(group && Object.keys(group).length === 1);
    const selectors = group['changed-files'];
    requireEvidence(Array.isArray(selectors) && selectors.length > 0 && selectors.length <= 8);
    const checks = selectors.map((selector) => {
      requireEvidence(selector && Object.keys(selector).length === 1);
      const [strategy] = Object.keys(selector);
      requireEvidence(['any-glob-to-any-file', 'all-globs-to-any-file'].includes(strategy));
      const globs =
        typeof selector[strategy] === 'string' ? [selector[strategy]] : selector[strategy];
      requireEvidence(Array.isArray(globs) && globs.length > 0 && globs.length <= 32);
      const matchers = globs.map((glob) => {
        requireEvidence(typeof glob === 'string' && glob.length > 0 && glob.length <= 500);
        return new Minimatch(glob, { dot: true });
      });
      return (filename) =>
        strategy === 'all-globs-to-any-file'
          ? matchers.every((matcher) => matcher.match(filename))
          : matchers.some((matcher) => matcher.match(filename));
    });
    return { label, matches: (filename) => checks.some((check) => check(filename)) };
  });
}

function requireEvidence(condition) {
  if (!condition) throw new Error('Invalid or incomplete PR observability evidence');
}

function positiveId(value) {
  return (
    typeof value === 'string' &&
    /^[1-9]\d{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

export function parseMaintenanceRun(repository, body = '') {
  requireEvidence(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository));
  requireEvidence(
    typeof body === 'string' && Buffer.byteLength(body) <= PR_OBSERVABILITY_LIMITS.bodyBytes,
  );
  const references = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Maintenance-Run:'));
  requireEvidence(references.length <= 1);
  if (references.length === 0) return null;
  const value = references[0].slice('Maintenance-Run:'.length).trim();
  if (!value || value === 'none') return null;
  const url = new URL(value);
  requireEvidence(url.origin === 'https://github.com' && url.href === value);
  requireEvidence(!url.username && !url.password && !url.search && !url.hash);
  const prefix = `/${repository}/actions/runs/`;
  requireEvidence(url.pathname.startsWith(prefix));
  const [runId, segment, attempt, ...extra] = url.pathname.slice(prefix.length).split('/');
  requireEvidence(
    positiveId(runId) && segment === 'attempts' && positiveId(attempt) && extra.length === 0,
  );
  return { runId, attempt, url: value };
}

export function pullRequestAreaLabels(
  files,
  changedFiles,
  configuration = AREA_LABEL_CONFIGURATION,
) {
  requireEvidence(Array.isArray(files) && files.length === changedFiles);
  requireEvidence(
    Number.isSafeInteger(changedFiles) &&
      changedFiles > 0 &&
      changedFiles < PR_OBSERVABILITY_LIMITS.files,
  );
  requireEvidence(files.every((file) => typeof file?.filename === 'string'));
  requireEvidence(new Set(files.map((file) => file.filename)).size === files.length);
  const filenames = [];
  for (const file of files) {
    for (const filename of [file.filename, file.previous_filename].filter(
      (value) => value !== undefined,
    )) {
      requireEvidence(
        typeof filename === 'string' && filename.length > 0 && filename.length <= 500,
      );
      requireEvidence(
        ![...filename].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) &&
          !/[\\:]/.test(filename) &&
          !filename.startsWith('/'),
      );
      requireEvidence(filename.split('/').every((part) => part && part !== '.' && part !== '..'));
      filenames.push(filename);
    }
  }
  return areaLabelRules(configuration)
    .filter((rule) => filenames.some(rule.matches))
    .map((rule) => rule.label)
    .sort();
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function readPrObservabilityArchive(bytes, kind) {
  return new Promise((resolve, reject) => {
    let archive;
    const fail = () => {
      clearTimeout(timer);
      archive?.close();
      reject(new Error('Invalid, unsafe or over-limit maintenance archive'));
    };
    const timer = setTimeout(fail, PR_OBSERVABILITY_LIMITS.requestTimeoutMs);
    timer.unref();
    if (
      !['evidence', 'proposal'].includes(kind) ||
      !Buffer.isBuffer(bytes) ||
      bytes.length > PR_OBSERVABILITY_LIMITS.archiveBytes
    )
      return fail();
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, opened) => {
        if (error) return fail();
        archive = opened;
        const entries = new Map();
        const seen = new Set();
        let expanded = 0;
        archive.on('error', fail);
        archive.on('entry', (entry) => {
          const name = entry.fileName;
          const directory = kind === 'evidence' && /^run-[A-Za-z0-9]+\/$/.test(name);
          const allowed =
            kind === 'evidence'
              ? /^run-[A-Za-z0-9]+\/(report|summary)\.json$/.test(name)
              : name === 'proposal.patch';
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          expanded += entry.uncompressedSize;
          if (
            (!directory && !allowed) ||
            seen.has(name) ||
            seen.size >= 4 ||
            expanded > PR_OBSERVABILITY_LIMITS.archiveBytes ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            ![0, directory ? 0x4000 : 0x8000].includes(mode)
          )
            return fail();
          seen.add(name);
          if (directory) {
            if (entry.uncompressedSize !== 0) return fail();
            return archive.readEntry();
          }
          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail();
            let size = 0;
            const chunks = [];
            stream.on('error', fail);
            stream.on('data', (chunk) => {
              size += chunk.length;
              if (size > PR_OBSERVABILITY_LIMITS.archiveBytes) {
                stream.destroy();
                fail();
              } else chunks.push(chunk);
            });
            stream.on('end', () => {
              if (size !== entry.uncompressedSize) return fail();
              entries.set(name, Buffer.concat(chunks));
              archive.readEntry();
            });
          });
        });
        archive.on('end', () => {
          clearTimeout(timer);
          archive.close();
          if (kind === 'evidence') {
            const report = [...entries.keys()].find((name) => name.endsWith('/report.json'));
            if (
              entries.size !== 2 ||
              !report ||
              !entries.has(report.replace('report.json', 'summary.json'))
            )
              return fail();
          } else if (entries.size !== 1 || !entries.has('proposal.patch')) return fail();
          resolve(entries);
        });
        archive.readEntry();
      },
    );
  });
}

export const PR_OBSERVABILITY_MARKER = '<!-- slipstream-pr-observability:v1 -->';

export function createPrObservabilityClient(repository, token, fetcher = fetch) {
  requireEvidence(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository));
  requireEvidence(typeof token === 'string' && token.length > 0);
  const budget = AbortSignal.timeout(PR_OBSERVABILITY_LIMITS.collectionTimeoutMs);
  const artifacts = createImprovementClient(repository, token, fetcher);
  const labelNames = Object.keys(PR_OBSERVABILITY_LABELS).map(encodeURIComponent);
  return {
    archive: (artifact) => artifacts.archive(artifact),
    async json(resource, { method = 'GET', body } = {}) {
      const label = resource.match(/^\/labels\/([^/]+)$/)?.[1];
      const removeLabel = resource.match(/^\/issues\/[1-9]\d{0,15}\/labels\/([^/]+)$/)?.[1];
      const comment = /^\/issues(?:\/[1-9]\d{0,15}\/comments|\/comments\/[1-9]\d{0,15})$/.test(
        resource,
      );
      const read =
        /^\/pulls\/[1-9]\d{0,15}(?:\/(?:files|reviews)\?per_page=100)?$/.test(resource) ||
        /^\/issues\/[1-9]\d{0,15}\/(?:labels|comments)\?per_page=100$/.test(resource) ||
        /^\/git\/(?:commits|blobs)\/[a-f0-9]{40}$/.test(resource) ||
        /^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/.test(resource) ||
        /^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}\?per_page=1$/.test(resource) ||
        /^\/actions\/(?:runs\/[1-9]\d{0,15}(?:\/artifacts\?per_page=10)?|workflows\/(?:maintenance|ci|security|pr-agent-review)\.yml)$/.test(
          resource,
        ) ||
        labelNames.includes(label);
      const add =
        /^\/issues\/[1-9]\d{0,15}\/labels$/.test(resource) &&
        method === 'POST' &&
        Array.isArray(body?.labels) &&
        body.labels.length <= Object.keys(PR_OBSERVABILITY_LABELS).length &&
        body.labels.every((name) => Object.hasOwn(PR_OBSERVABILITY_LABELS, name));
      const define =
        resource === '/labels' &&
        method === 'POST' &&
        Object.hasOwn(PR_OBSERVABILITY_LABELS, body?.name ?? '') &&
        isDeepStrictEqual(body, { name: body.name, ...PR_OBSERVABILITY_LABELS[body.name] });
      const note =
        comment &&
        ['POST', 'PATCH'].includes(method) &&
        typeof body?.body === 'string' &&
        body.body.startsWith(PR_OBSERVABILITY_MARKER) &&
        Buffer.byteLength(body.body) <= PR_OBSERVABILITY_LIMITS.bodyBytes;
      requireEvidence(
        (method === 'GET' && read && body === undefined) ||
          add ||
          define ||
          note ||
          (method === 'DELETE' && labelNames.includes(removeLabel) && body === undefined),
      );
      const response = await fetcher(`https://api.github.com/repos/${repository}${resource}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([
          budget,
          AbortSignal.timeout(PR_OBSERVABILITY_LIMITS.requestTimeoutMs),
        ]),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (method === 'GET' && label && response.status === 404) return null;
      requireEvidence(response.ok);
      if (response.status === 204) return null;
      const chunks = [];
      let size = 0;
      requireEvidence(
        Number(response.headers.get('content-length') ?? 0) <=
          PR_OBSERVABILITY_LIMITS.responseBytes,
      );
      requireEvidence(response.body);
      for await (const chunk of response.body) {
        size += chunk.length;
        requireEvidence(size <= PR_OBSERVABILITY_LIMITS.responseBytes);
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

async function documentSnapshot(client, commit, paths) {
  requireEvidence(revision(commit));
  const metadata = await client.json(`/git/commits/${commit}`);
  requireEvidence(metadata.sha === commit && revision(metadata.tree?.sha));
  const tree = await client.json(`/git/trees/${metadata.tree.sha}?recursive=1`);
  requireEvidence(
    tree.sha === metadata.tree.sha && tree.truncated === false && Array.isArray(tree.tree),
  );
  const documents = new Map();
  for (const file of paths) {
    const entries = tree.tree.filter((entry) => entry.path === file);
    requireEvidence(
      entries.length === 1 &&
        entries[0].mode === '100644' &&
        entries[0].type === 'blob' &&
        revision(entries[0].sha),
    );
    const blob = await client.json(`/git/blobs/${entries[0].sha}`);
    requireEvidence(
      blob.sha === entries[0].sha && blob.encoding === 'base64' && typeof blob.content === 'string',
    );
    requireEvidence(
      Number.isSafeInteger(blob.size) &&
        blob.size > 0 &&
        blob.size <= PR_OBSERVABILITY_LIMITS.documentBytes,
    );
    requireEvidence(blob.content.length <= PR_OBSERVABILITY_LIMITS.responseBytes);
    const encoded = blob.content.replace(/\n/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    requireEvidence(bytes.toString('base64') === encoded && bytes.length === blob.size);
    requireEvidence(
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === blob.sha,
    );
    documents.set(file, { bytes, sha: blob.sha });
  }
  return documents;
}

async function maintenanceForPull({ repository, branch, pull, files, client }) {
  let reference;
  try {
    reference = parseMaintenanceRun(repository, pull.body ?? '');
  } catch {
    return { status: 'unverified', reason: 'invalid-reference' };
  }
  if (!reference) return { status: 'not-requested' };
  try {
    requireEvidence(
      reference.attempt === '1' &&
        pull.head.repo?.full_name === repository &&
        pull.base.ref === branch,
    );
    const run = await client.json(`/actions/runs/${reference.runId}`);
    const workflow = await client.json('/actions/workflows/maintenance.yml');
    requireEvidence(
      run.id === Number(reference.runId) && run.run_attempt === 1 && run.conclusion === 'success',
    );
    const listed = await client.json(`/actions/runs/${run.id}/artifacts?per_page=10`);
    requireEvidence(
      Array.isArray(listed.artifacts) &&
        listed.total_count === listed.artifacts.length &&
        listed.total_count < 10,
    );
    const loaded = {};
    const evidence = [];
    for (const kind of ['evidence', 'proposal']) {
      const matches = listed.artifacts.filter(
        (artifact) => artifact.name === `maintenance-${kind}-${run.id}-1`,
      );
      requireEvidence(matches.length === 1);
      const artifact = matches[0];
      requireEvidence(
        positiveId(String(artifact.id)) &&
          artifact.expired === false &&
          artifact.size_in_bytes > 0 &&
          artifact.size_in_bytes <= PR_OBSERVABILITY_LIMITS.archiveBytes &&
          Date.parse(artifact.expires_at) > Date.now(),
      );
      requireEvidence(
        artifact.workflow_run?.id === run.id &&
          artifact.workflow_run.head_sha === run.head_sha &&
          artifact.workflow_run.repository_id === run.repository.id &&
          artifact.workflow_run.head_repository_id === run.head_repository.id,
      );
      const bytes = await client.archive(artifact);
      requireEvidence(
        bytes.length === artifact.size_in_bytes && `sha256:${digest(bytes)}` === artifact.digest,
      );
      loaded[kind] = await readPrObservabilityArchive(bytes, kind);
      evidence.push({
        kind,
        id: artifact.id,
        digest: artifact.digest,
        bytes: bytes.length,
        expiresAt: artifact.expires_at,
        url: `https://github.com/${repository}/actions/runs/${run.id}/artifacts/${artifact.id}`,
      });
    }
    const reportName = [...loaded.evidence.keys()].find((name) => name.endsWith('/report.json'));
    const summary = JSON.parse(
      loaded.evidence.get(reportName.replace('report.json', 'summary.json')).toString('utf8'),
    );
    requireEvidence(
      summary.proposalPath ===
        `test-results/maintenance/${reportName.replace('report.json', 'proposal.patch')}`,
    );
    const paths = summary.documentation?.proposal?.files?.map((file) => file.path);
    requireEvidence(
      Array.isArray(paths) &&
        paths.length > 0 &&
        paths.length <= MAINTENANCE_LIMITS.files &&
        paths.every((file) => DOC_CONTRACTS.includes(file)),
    );
    const source = await documentSnapshot(client, run.head_sha, paths);
    const base =
      run.head_sha === pull.base.sha
        ? source
        : await documentSnapshot(client, pull.base.sha, paths);
    const head = await documentSnapshot(client, pull.head.sha, paths);
    const changes = files.map((file) => {
      requireEvidence(head.get(file.filename)?.sha === file.sha);
      return {
        path: file.filename,
        status: 'M',
        oldMode: '100644',
        newMode: '100644',
        added: file.additions,
        deleted: file.deletions,
        before: source.get(file.filename)?.bytes,
        base: base.get(file.filename)?.bytes,
        after: head.get(file.filename)?.bytes,
      };
    });
    const comparison = await client.json(`/compare/${run.head_sha}...${pull.base.sha}?per_page=1`);
    const verified = verifyMaintenanceProposal({
      repository,
      branch,
      pull,
      files,
      run,
      workflow,
      reference,
      reportBytes: loaded.evidence.get(reportName),
      summary,
      patch: loaded.proposal.get('proposal.patch'),
      changes,
      comparison,
    });
    return { ...verified, artifacts: evidence };
  } catch {
    return { status: 'unverified', reference, reason: 'missing-expired-or-mismatched-evidence' };
  }
}

export function pullRequestSnapshot(pull) {
  return JSON.stringify({
    number: pull.number,
    head: pull.head?.sha,
    headRepository: pull.head?.repo?.full_name,
    headRepositoryId: pull.head?.repo?.id,
    base: pull.base?.sha,
    baseBranch: pull.base?.ref,
    repository: pull.base?.repo?.full_name,
    repositoryId: pull.base?.repo?.id,
    body: digest(Buffer.from(pull.body ?? '')),
    changedFiles: pull.changed_files,
    state: pull.state,
    merged: pull.merged,
    mergedAt: pull.merged_at,
    draft: pull.draft,
  });
}

export function observabilityLifecycle(report) {
  const validation = report.validation;
  const agentReview = report.agentReview;
  return {
    schemaVersion: 1,
    snapshot: {
      status: 'verified',
      pullRequest: report.number,
      head: report.head,
      base: report.base,
      state: report.state,
    },
    validation: validation
      ? {
          status: validation.status,
          workflow: validation.source?.workflow,
          runId: validation.source?.runId,
          attempt: validation.source?.attempt,
          conclusion: validation.source?.conclusion,
          head: validation.source?.head,
          base: validation.source?.base,
        }
      : { status: 'not-requested' },
    maintenance: { status: report.maintenance?.status ?? 'unavailable' },
    review: {
      status: report.review?.status ?? 'unavailable',
      count: report.review?.reviews?.length ?? 0,
    },
    agentReview: agentReview?.source
      ? {
          status: agentReview.status,
          runId: agentReview.source.runId,
          attempt: agentReview.source.attempt,
          conclusion: agentReview.source.conclusion,
          head: agentReview.source.head,
        }
      : { status: agentReview?.status ?? 'not-requested' },
    publication: { status: report.publication ?? 'not-applied' },
    collector: report.collector
      ? {
          status: 'verified',
          runId: report.collector.runId,
          attempt: report.collector.attempt,
          eventName: report.collector.eventName,
          revision: report.collector.revision,
        }
      : { status: 'not-recorded' },
  };
}

async function validationSourceCurrent(report, client) {
  try {
    const source = report.validation.source;
    requireEvidence(
      Object.hasOwn(VALIDATION_WORKFLOWS, source.workflow) &&
        positiveId(source.runId) &&
        source.number === report.number &&
        source.head === report.head &&
        source.base === report.base,
    );
    const workflow = await client.json(
      `/actions/workflows/${VALIDATION_WORKFLOWS[source.workflow]}`,
    );
    requireEvidence(
      workflow.id === source.workflowId &&
        workflow.name === source.workflow &&
        workflow.path === source.path,
    );
    const run = await client.json(`/actions/runs/${source.runId}`);
    return isDeepStrictEqual(validationRunSource(run, report.repository, report.branch), source);
  } catch {
    return false;
  }
}

async function agentReviewSourceCurrent(report, client) {
  try {
    const source = report.agentReview.source;
    requireEvidence(
      source.workflow === AGENT_REVIEW_WORKFLOW.name &&
        source.path === `.github/workflows/${AGENT_REVIEW_WORKFLOW.path}` &&
        positiveId(source.runId) &&
        source.number === report.number &&
        source.head === report.head &&
        source.base === report.base,
    );
    const workflow = await client.json(`/actions/workflows/${AGENT_REVIEW_WORKFLOW.path}`);
    requireEvidence(
      workflow.id === source.workflowId &&
        workflow.name === source.workflow &&
        workflow.path === source.path,
    );
    const run = await client.json(`/actions/runs/${source.runId}`);
    return isDeepStrictEqual(agentReviewRunSource(run, report.repository, report.branch), source);
  } catch {
    return false;
  }
}

export async function collectPrObservability({
  repository,
  branch,
  number,
  client,
  validationSource,
  agentReviewSource,
}) {
  requireEvidence(positiveId(String(number)));
  const pull = await client.json(`/pulls/${number}`);
  requireEvidence(
    pull.number === number &&
      pull.base?.repo?.full_name === repository &&
      revision(pull.head?.sha) &&
      revision(pull.base?.sha),
  );
  requireEvidence(
    typeof (pull.body ?? '') === 'string' &&
      Buffer.byteLength(pull.body ?? '') <= PR_OBSERVABILITY_LIMITS.bodyBytes,
  );
  const report = {
    schemaVersion: 1,
    kind: 'pr-observability',
    repository,
    branch,
    number,
    checkedAt: new Date().toISOString(),
    snapshot: pullRequestSnapshot(pull),
    head: pull.head.sha,
    base: pull.base.sha,
    state: pull.merged ? 'merged' : pull.state,
    draft: pull.draft === true,
    labels: [],
    errors: [],
    maintenance: { status: 'unverified' },
    review: { status: 'unavailable', reviews: [] },
    agentReview: { status: 'not-requested' },
    checksUrl: `https://github.com/${repository}/pull/${number}/checks`,
    pullUrl: `https://github.com/${repository}/pull/${number}`,
    publication: 'not-applied',
  };
  report.lifecycle = observabilityLifecycle(report);
  if (validationSource) {
    report.validation = { status: 'unverified', source: validationSource };
    if (
      pull.base.ref !== branch ||
      pull.base.repo.id !== validationSource.repositoryId ||
      pull.head.repo?.id !== validationSource.headRepositoryId ||
      pull.head.repo?.full_name !== validationSource.headRepository ||
      !(await validationSourceCurrent(report, client))
    ) {
      report.errors.push(
        'The triggering validation run is unavailable, stale, or does not match this PR snapshot.',
      );
      report.lifecycle = observabilityLifecycle(report);
      return report;
    }
    report.validation.status = 'verified-completion';
  }
  if (agentReviewSource) {
    report.agentReview = { status: 'unverified', source: agentReviewSource };
    if (
      pull.base.ref !== branch ||
      pull.base.sha !== agentReviewSource.base ||
      pull.base.repo.id !== agentReviewSource.repositoryId ||
      pull.head.sha !== agentReviewSource.head ||
      pull.head.repo?.id !== agentReviewSource.headRepositoryId ||
      pull.head.repo?.full_name !== agentReviewSource.headRepository ||
      !(await agentReviewSourceCurrent(report, client))
    ) {
      report.errors.push(
        'The triggering agent-review run is unavailable, stale, or does not match this PR snapshot.',
      );
      report.lifecycle = observabilityLifecycle(report);
      return report;
    }
    report.agentReview.status = 'verified-completion';
  }
  try {
    const files = await client.json(`/pulls/${number}/files?per_page=100`);
    report.labels = pullRequestAreaLabels(files, pull.changed_files);
    report.maintenance = await maintenanceForPull({ repository, branch, pull, files, client });
    if (report.maintenance.status === 'verified') report.labels.push('automation:maintenance');
    if (
      report.agentReview.status === 'verified-completion' &&
      report.agentReview.source.conclusion === 'success'
    )
      report.labels.push('automation:agent-review');
  } catch {
    report.errors.push(
      'PR file inventory is unavailable or incomplete; managed labels are withheld.',
    );
  }
  try {
    report.review = pullRequestReviewSummary(
      pull,
      await client.json(`/pulls/${number}/reviews?per_page=100`),
    );
  } catch {
    report.errors.push('Review history is unavailable.');
  }
  report.lifecycle = observabilityLifecycle(report);
  return report;
}

export function renderPrObservability(report) {
  const base = `https://github.com/${report.repository}`;
  const maintenance = report.maintenance;
  const agentReview = report.agentReview ?? { status: 'not-requested' };
  const lifecycle = observabilityLifecycle(report);
  return [
    PR_OBSERVABILITY_MARKER,
    '## Automation Observability',
    '',
    `Snapshot: [${report.head.slice(0, 12)}](${base}/commit/${report.head}) at ${report.checkedAt}.`,
    `PR state: ${report.state}${report.draft ? ' (draft)' : ''}.`,
    `Lifecycle evidence: snapshot **${lifecycle.snapshot.status}**, validation **${lifecycle.validation.status}**, review **${lifecycle.review.status}**, maintenance **${lifecycle.maintenance.status}**, publication **${lifecycle.publication.status}**.`,
    `Maintenance provenance: **${maintenance.status}**.`,
    ...(maintenance.reason ? [`Verification detail: ${maintenance.reason}.`] : []),
    ...(maintenance.reference
      ? [`[Declared maintenance attempt](${maintenance.reference.url}).`]
      : []),
    ...(maintenance.status === 'verified'
      ? [
          `[Maintenance source](${base}/commit/${maintenance.revision}).`,
          ...maintenance.artifacts.map(
            (artifact) =>
              `[${artifact.kind === 'proposal' ? 'Proposal patch' : 'Validation evidence'}](${artifact.url}) (artifact ${artifact.id}, ${artifact.digest}).`,
          ),
        ]
      : []),
    '',
    `Human review snapshot: **${report.review.status}**.`,
    ...report.review.reviews.map(
      (review) =>
        `[${review.state} review ${review.id}](${base}/pull/${report.number}#pullrequestreview-${review.id}).`,
    ),
    `[Current PR checks](${report.checksUrl}) remain independent of this report.`,
    ...(report.validation
      ? [
          `Triggering validation: **${report.validation.status}**.`,
          ...(report.validation.status === 'verified-completion'
            ? [
                `[${report.validation.source.workflow} run ${report.validation.source.runId}, attempt ${report.validation.source.attempt}](${base}/actions/runs/${report.validation.source.runId}/attempts/${report.validation.source.attempt}) reported **${report.validation.source.conclusion}** for this exact PR head and recorded base.`,
                'This is one workflow outcome, not aggregate required-check success, agent authorship, or a verified repair.',
              ]
            : ['No validation outcome is verified for this observation.']),
        ]
      : []),
    ...(agentReview.status === 'verified-completion'
      ? [
          `Trusted bounded agent review: [run ${agentReview.source.runId}, attempt ${agentReview.source.attempt}](${base}/actions/runs/${agentReview.source.runId}/attempts/${agentReview.source.attempt}) reported **${agentReview.source.conclusion}** for this exact PR head and recorded base.`,
          'This records a trusted review workflow outcome, not agent authorship, approval, or a verified repair.',
        ]
      : agentReview.status === 'unverified'
        ? ['No agent-review outcome is verified for this observation.']
        : []),
    ...(report.collector
      ? [
          `[Observation run](${base}/actions/runs/${report.collector.runId}/attempts/${report.collector.attempt}).`,
        ]
      : []),
    '',
    'Labels describe the recorded snapshot, not agent authorship, approval, current CI success, or permission to merge.',
    'Review changes are refreshed on the next observed PR event, verified validation completion, or manual refresh; this is not a required gate.',
    ...report.errors,
  ].join('\n');
}

export async function publishPrObservability(report, client) {
  requireEvidence(
    positiveId(String(report.number)) &&
      revision(report.head) &&
      typeof report.snapshot === 'string',
  );
  requireEvidence(
    Array.isArray(report.labels) &&
      report.labels.every((name) => Object.hasOwn(PR_OBSERVABILITY_LABELS, name)),
  );
  if (report.validation && report.validation.status !== 'verified-completion') {
    report.publication = 'unverified-validation';
    report.lifecycle = observabilityLifecycle(report);
    return;
  }
  if (report.agentReview?.status === 'unverified') {
    report.publication = 'unverified-agent-review';
    report.lifecycle = observabilityLifecycle(report);
    return;
  }
  const number = report.number;
  const fresh = async () => {
    if (report.snapshot !== pullRequestSnapshot(await client.json(`/pulls/${number}`))) {
      report.publication = 'stale-pr';
      return false;
    }
    if (report.validation && !(await validationSourceCurrent(report, client))) {
      report.validation.status = 'unverified';
      report.publication = 'stale-validation';
      report.errors.push(
        'The triggering validation run changed or could not be reverified; publication was withheld.',
      );
      return false;
    }
    if (
      report.agentReview?.status === 'verified-completion' &&
      !(await agentReviewSourceCurrent(report, client))
    ) {
      report.agentReview.status = 'unverified';
      report.publication = 'stale-agent-review';
      report.errors.push(
        'The triggering agent-review run changed or could not be reverified; publication was withheld.',
      );
      return false;
    }
    return true;
  };
  if (!(await fresh())) {
    report.lifecycle = observabilityLifecycle(report);
    return;
  }
  const labels = await client.json(`/issues/${number}/labels?per_page=100`);
  const comments = await client.json(`/issues/${number}/comments?per_page=100`);
  requireEvidence(
    Array.isArray(labels) &&
      labels.length < 100 &&
      labels.every((label) => typeof label.name === 'string'),
  );
  requireEvidence(Array.isArray(comments) && comments.length < 100);
  const owned = comments.filter(
    (comment) =>
      comment.user?.type === 'Bot' &&
      comment.user.login === 'github-actions[bot]' &&
      typeof comment.body === 'string' &&
      comment.body.startsWith(PR_OBSERVABILITY_MARKER),
  );
  requireEvidence(owned.length <= 1 && owned.every((comment) => positiveId(String(comment.id))));
  const existing = new Set(labels.map((label) => label.name));
  const additions = [...new Set(report.labels)].filter((label) => !existing.has(label));
  const definitions = [];
  for (const name of additions) {
    if (!(await client.json(`/labels/${encodeURIComponent(name)}`))) definitions.push(name);
  }
  if (!(await fresh())) {
    report.lifecycle = observabilityLifecycle(report);
    return;
  }
  for (const name of definitions) {
    await client.json('/labels', {
      method: 'POST',
      body: { name, ...PR_OBSERVABILITY_LABELS[name] },
    });
  }
  for (const name of existing) {
    if (Object.hasOwn(PR_OBSERVABILITY_LABELS, name) && !report.labels.includes(name)) {
      await client.json(`/issues/${number}/labels/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    }
  }
  if (additions.length)
    await client.json(`/issues/${number}/labels`, { method: 'POST', body: { labels: additions } });
  report.publication = 'applied';
  report.lifecycle = observabilityLifecycle(report);
  const body = renderPrObservability(report);
  if (!owned.length)
    await client.json(`/issues/${number}/comments`, { method: 'POST', body: { body } });
  else if (owned[0].body !== body)
    await client.json(`/issues/comments/${owned[0].id}`, { method: 'PATCH', body: { body } });
}

function validationRunSource(run, repository, branch) {
  requireEvidence(Object.hasOwn(VALIDATION_WORKFLOWS, run?.name ?? ''));
  requireEvidence(
    run.path === `.github/workflows/${VALIDATION_WORKFLOWS[run.name]}` &&
      run.event === 'pull_request' &&
      run.status === 'completed' &&
      run.repository?.full_name === repository &&
      typeof run.head_repository?.full_name === 'string' &&
      /^[\w.-]+\/[\w.-]+$/.test(run.head_repository.full_name),
  );
  requireEvidence(
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
    ].includes(run.conclusion),
  );
  requireEvidence(Array.isArray(run.pull_requests) && run.pull_requests.length === 1);
  const pull = run.pull_requests[0];
  requireEvidence(
    [
      run.id,
      run.run_attempt,
      run.workflow_id,
      run.repository.id,
      run.head_repository.id,
      pull?.number,
    ].every((value) => Number.isSafeInteger(value) && value > 0),
  );
  requireEvidence(
    revision(run.head_sha) &&
      pull.head?.sha === run.head_sha &&
      pull.head.repo?.id === run.head_repository.id &&
      revision(pull.base?.sha) &&
      pull.base.ref === branch &&
      pull.base.repo?.id === run.repository.id,
  );
  return {
    workflow: run.name,
    path: run.path,
    workflowId: run.workflow_id,
    runId: String(run.id),
    attempt: run.run_attempt,
    conclusion: run.conclusion,
    head: run.head_sha,
    base: pull.base.sha,
    number: pull.number,
    repositoryId: run.repository.id,
    headRepository: run.head_repository.full_name,
    headRepositoryId: run.head_repository.id,
  };
}

function agentReviewRunSource(run, repository, branch) {
  requireEvidence(
    run?.name === AGENT_REVIEW_WORKFLOW.name &&
      run.path === `.github/workflows/${AGENT_REVIEW_WORKFLOW.path}` &&
      run.event === 'pull_request_target' &&
      run.status === 'completed' &&
      run.repository?.full_name === repository &&
      typeof run.head_repository?.full_name === 'string' &&
      /^[\w.-]+\/[\w.-]+$/.test(run.head_repository.full_name),
  );
  requireEvidence(
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
    ].includes(run.conclusion),
  );
  requireEvidence(Array.isArray(run.pull_requests) && run.pull_requests.length === 1);
  const pull = run.pull_requests[0];
  requireEvidence(
    [
      run.id,
      run.run_attempt,
      run.workflow_id,
      run.repository.id,
      run.head_repository.id,
      pull?.number,
    ].every((value) => Number.isSafeInteger(value) && value > 0),
  );
  requireEvidence(
    revision(run.head_sha) &&
      pull.head?.sha === run.head_sha &&
      pull.head.repo?.id === run.head_repository.id &&
      revision(pull.base?.sha) &&
      pull.base.ref === branch &&
      pull.base.repo?.id === run.repository.id,
  );
  return {
    workflow: run.name,
    path: run.path,
    workflowId: run.workflow_id,
    runId: String(run.id),
    attempt: run.run_attempt,
    conclusion: run.conclusion,
    head: run.head_sha,
    base: pull.base.sha,
    number: pull.number,
    repositoryId: run.repository.id,
    headRepository: run.head_repository.full_name,
    headRepositoryId: run.head_repository.id,
  };
}

export function prObservabilityIdentity(env, event) {
  const repository = event.repository?.full_name;
  const branch = event.repository?.default_branch;
  requireEvidence(env.GITHUB_ACTIONS === 'true' && env.SLIPSTREAM_OBSERVABILITY_ENABLED === 'true');
  requireEvidence(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository));
  requireEvidence(typeof branch === 'string' && /^[\w./-]+$/.test(branch) && branch.length <= 200);
  requireEvidence(
    env.GITHUB_REPOSITORY === repository && env.GITHUB_REF === `refs/heads/${branch}`,
  );
  requireEvidence(
    env.GITHUB_WORKFLOW_REF ===
      `${repository}/.github/workflows/pr-observability.yml@refs/heads/${branch}`,
  );
  requireEvidence(
    env.GITHUB_SERVER_URL === 'https://github.com' &&
      env.GITHUB_API_URL === 'https://api.github.com',
  );
  requireEvidence(
    revision(env.GITHUB_SHA) && positiveId(env.GITHUB_RUN_ID) && positiveId(env.GITHUB_RUN_ATTEMPT),
  );
  requireEvidence(
    ['pull_request_target', 'workflow_dispatch', 'workflow_run'].includes(env.GITHUB_EVENT_NAME),
  );
  let validationSource;
  let agentReviewSource;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    requireEvidence(event.action === 'completed');
    if (event.workflow_run?.name === AGENT_REVIEW_WORKFLOW.name)
      agentReviewSource = agentReviewRunSource(event.workflow_run, repository, branch);
    else validationSource = validationRunSource(event.workflow_run, repository, branch);
    requireEvidence(
      event.repository.id === (validationSource ?? agentReviewSource).repositoryId &&
        env.GITHUB_RUN_ID !== (validationSource ?? agentReviewSource).runId,
    );
  }
  const source = validationSource ?? agentReviewSource;
  const number = source
    ? String(source.number)
    : env.GITHUB_EVENT_NAME === 'pull_request_target'
      ? String(event.pull_request?.number)
      : event.inputs?.pull_request;
  requireEvidence(positiveId(number));
  if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    requireEvidence(
      event.pull_request.base?.ref === branch &&
        event.pull_request.base?.repo?.full_name === repository,
    );
  }
  return {
    repository,
    branch,
    number: Number(number),
    ...(validationSource ? { validationSource } : {}),
    ...(agentReviewSource ? { agentReviewSource } : {}),
    collector: {
      revision: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      eventName: env.GITHUB_EVENT_NAME,
      workflow: env.GITHUB_WORKFLOW_REF,
    },
  };
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const identity = prObservabilityIdentity(
    process.env,
    JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
  );
  const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  requireEvidence(checkedOut === identity.collector.revision);
  const client = createPrObservabilityClient(identity.repository, process.env.GITHUB_TOKEN);
  const report = await collectPrObservability({ ...identity, client });
  report.collector = identity.collector;
  report.lifecycle = observabilityLifecycle(report);
  const directory = path.join(root, 'test-results/pr-observability');
  fs.mkdirSync(directory, { recursive: true });
  try {
    if (process.env.PR_OBSERVABILITY_APPLY === 'true') await publishPrObservability(report, client);
  } catch {
    report.publication = 'failed';
    report.errors.push('Metadata publication failed; no automatic retry was attempted.');
    process.exitCode = 1;
  } finally {
    report.lifecycle = observabilityLifecycle(report);
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(directory, 'report.json'), bytes);
    const summary = renderPrObservability(report);
    fs.writeFileSync(path.join(directory, 'summary.md'), `${summary}\n`);
    const readinessReport = writeReadinessReport(root, bytes);
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `readiness_report_path=${readinessReport}\n`);
    if (process.env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    if (
      [
        'stale-pr',
        'stale-validation',
        'unverified-validation',
        'stale-agent-review',
        'unverified-agent-review',
      ].includes(report.publication)
    )
      process.exitCode = 1;
    console.log(
      JSON.stringify({
        number: report.number,
        maintenance: report.maintenance.status,
        publication: report.publication,
      }),
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('PR observability failed; no successful provenance claim was produced.');
    process.exitCode = 1;
  });
}

export function verifyMaintenanceProposal({
  repository,
  branch,
  pull,
  files,
  run,
  workflow,
  reference,
  reportBytes,
  summary,
  patch,
  changes,
  comparison,
}) {
  let reason = 'producer';
  try {
    requireEvidence(reference.attempt === '1' && String(run.id) === reference.runId);
    requireEvidence(
      run.run_attempt === 1 && run.status === 'completed' && run.conclusion === 'success',
    );
    requireEvidence(['schedule', 'workflow_dispatch'].includes(run.event));
    requireEvidence(
      run.repository?.full_name === repository && run.head_repository?.full_name === repository,
    );
    requireEvidence(run.head_branch === branch && revision(run.head_sha));
    requireEvidence(run.path === '.github/workflows/maintenance.yml' && run.name === 'Maintenance');
    requireEvidence(workflow.path === run.path && workflow.id === run.workflow_id);
    requireEvidence(
      pull.base?.repo?.full_name === repository && pull.head?.repo?.full_name === repository,
    );
    requireEvidence(pull.base.ref === branch && revision(pull.base.sha) && revision(pull.head.sha));
    reason = 'source-ancestry';
    requireEvidence(['ahead', 'identical'].includes(comparison.status));
    requireEvidence(
      comparison.base_commit?.sha === run.head_sha &&
        comparison.merge_base_commit?.sha === run.head_sha,
    );
    reason = 'validation';
    const report = JSON.parse(reportBytes.toString('utf8'));
    const identity = {
      revision: run.head_sha,
      eventName: run.event,
      runId: String(run.id),
      attempt: '1',
      workflow: `${repository}/.github/workflows/maintenance.yml@refs/heads/${branch}`,
    };
    for (const value of [report, summary]) {
      requireEvidence(value.schemaVersion === 1 && value.passed === true);
      requireEvidence(Object.entries(identity).every(([key, expected]) => value[key] === expected));
      requireEvidence(Array.isArray(value.errors) && value.errors.length === 0);
    }
    requireEvidence(
      report.kind === 'documentation-maintenance' && summary.kind === 'maintenance-validation',
    );
    requireEvidence(report.outcome === 'proposed' && report.cancelled === false);
    requireEvidence(
      ['source', 'generation', 'validation', 'idempotence', 'proposal', 'cleanup'].every(
        (key) => report.checks?.[key] === 'success',
      ),
    );
    requireEvidence(
      ['context', 'install', 'build', 'tests', 'audit', 'docs', 'proof'].every(
        (key) => summary.steps?.[key] === 'success',
      ),
    );
    requireEvidence(
      /^test-results\/maintenance\/run-[A-Za-z0-9]+\/proposal\.patch$/.test(summary.proposalPath),
    );
    const reportPath = summary.proposalPath.replace('proposal.patch', 'report.json');
    requireEvidence(summary.evidenceSha256?.[reportPath] === digest(reportBytes));
    requireEvidence(
      ['moderate', 'high', 'critical'].every((key) => summary.vulnerabilities?.[key] === 0),
    );
    requireEvidence(summary.proof?.runs === 5 && summary.proof.gate?.passed === true);
    requireEvidence(
      Array.isArray(summary.proof.gate.checks) &&
        summary.proof.gate.checks.length > 0 &&
        summary.proof.gate.checks.every((check) => check.pass === true),
    );
    reason = 'proposal-content';
    pullRequestAreaLabels(files, pull.changed_files);
    requireEvidence(
      files.length === changes.length &&
        files.every((file) => file.status === 'modified' && !file.previous_filename),
    );
    for (const file of files) {
      const change = changes.find((entry) => entry.path === file.filename);
      requireEvidence(
        change && change.added === file.additions && change.deleted === file.deletions,
      );
      requireEvidence(Buffer.isBuffer(change.base) && change.before.equals(change.base));
    }
    const proposal = validateDocumentationProposal(changes, patch);
    requireEvidence(proposal.files.length > 0 && isDeepStrictEqual(proposal, report.proposal));
    requireEvidence(
      summary.documentation?.outcome === 'proposed' &&
        isDeepStrictEqual(proposal, summary.documentation.proposal),
    );
    return { status: 'verified', reference, revision: run.head_sha, proposal };
  } catch {
    return { status: 'unverified', reference, reason };
  }
}

export function pullRequestReviewSummary(pull, reviews, now = Date.now()) {
  const incomplete = { status: 'unavailable', reviews: [] };
  if (!Array.isArray(reviews) || reviews.length >= 100 || !revision(pull.head?.sha))
    return incomplete;
  const cutoff = pull.merged ? Date.parse(pull.merged_at) : now;
  if (!Number.isFinite(cutoff) || cutoff > now) return incomplete;
  const seen = new Set();
  const latest = new Map();
  for (const review of reviews) {
    if (
      !positiveId(String(review?.id)) ||
      seen.has(review.id) ||
      !positiveId(String(review.user?.id)) ||
      !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(review.state)
    )
      return incomplete;
    seen.add(review.id);
    if (review.state === 'PENDING') continue;
    const submitted = Date.parse(review.submitted_at);
    if (!Number.isFinite(submitted)) return incomplete;
    if (
      submitted > cutoff ||
      review.state === 'COMMENTED' ||
      review.user.type !== 'User' ||
      review.user.id === pull.user?.id ||
      !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review.author_association)
    )
      continue;
    const previous = latest.get(review.user.id);
    if (
      !previous ||
      submitted > Date.parse(previous.submitted_at) ||
      (submitted === Date.parse(previous.submitted_at) && review.id > previous.id)
    )
      latest.set(review.user.id, review);
  }
  const effective = [...latest.values()];
  const changesRequested = effective.filter((review) => review.state === 'CHANGES_REQUESTED');
  const approvals = effective.filter(
    (review) => review.state === 'APPROVED' && review.commit_id === pull.head.sha,
  );
  return {
    status: changesRequested.length
      ? 'changes-requested'
      : approvals.length
        ? 'approved-current-head'
        : 'review-required',
    reviews: [...changesRequested, ...approvals].map((review) => ({
      id: review.id,
      state: review.state,
      commit: review.commit_id,
      submittedAt: review.submitted_at,
    })),
  };
}
