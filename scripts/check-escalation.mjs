import { createHash } from 'node:crypto';

/**
 * Deterministic failure escalation: turn a failed default-branch CI run into a
 * single, deduplicated, human-owned GitHub issue, and record recovery on it.
 *
 * This module reads run metadata only. It never reads logs, never edits source,
 * never reruns or cancels anything, never merges, and never closes an issue.
 * Closing remains a human decision, so a recovered build still leaves the triage
 * record open for review.
 */

export const ESCALATION_LIMITS = Object.freeze({
  bodyBytes: 16 * 1024,
  titleBytes: 200,
  jobs: 60,
  commentBytes: 4 * 1024,
  pages: 10,
});

const MARKER_PREFIX = 'slipstream-escalation:v1:';
const SOURCE_WORKFLOW = '.github/workflows/ci.yml';
const SOURCE_WORKFLOW_NAME = 'CI';

/**
 * The identity `GITHUB_TOKEN` writes as. A marker in an issue opened by anyone
 * else is treated as a forgery and ignored.
 */
export const ESCALATION_AUTHOR = 'github-actions[bot]';

function requireContext(condition, message) {
  if (!condition) throw new Error(message);
}

/** A stable, greppable marker so one workflow keeps one open escalation issue. */
export function escalationMarker(workflowPath) {
  requireContext(
    typeof workflowPath === 'string' &&
      /^\.github\/workflows\/[\w.-]{1,80}\.yml$/.test(workflowPath),
    'An exact workflow path is required',
  );
  return `<!-- ${MARKER_PREFIX}${workflowPath} -->`;
}

/**
 * Binds this run to an enabled, first-attempt, same-repository default-branch CI
 * completion. The collector revision is the trusted default-branch checkout this
 * workflow runs from; the source revision is the commit whose CI completed. They
 * are deliberately independent: for `workflow_run`, `GITHUB_SHA` is the default
 * branch tip, so requiring equality would silently drop a failure whenever
 * another commit lands before the failing run finishes.
 */
export function escalationIdentity(collectorRevision, env = process.env, event = {}) {
  requireContext(
    /^[a-f0-9]{40}$/.test(collectorRevision ?? ''),
    'An exact collector revision is required',
  );
  const repository = event.repository?.full_name;
  const branch = event.repository?.default_branch;
  const run = event.workflow_run;
  requireContext(
    typeof repository === 'string' &&
      /^[\w.-]+\/[\w.-]+$/.test(repository) &&
      typeof branch === 'string' &&
      /^[\w./-]{1,200}$/.test(branch) &&
      env.SLIPSTREAM_FAILURE_ESCALATION_ENABLED === 'true' &&
      env.GITHUB_EVENT_NAME === 'workflow_run' &&
      env.GITHUB_REPOSITORY === repository &&
      env.GITHUB_SHA === collectorRevision &&
      env.GITHUB_REF === `refs/heads/${branch}` &&
      env.GITHUB_WORKFLOW_REF ===
        `${repository}/.github/workflows/failure-escalation.yml@refs/heads/${branch}` &&
      env.GITHUB_SERVER_URL === 'https://github.com' &&
      env.GITHUB_API_URL === 'https://api.github.com' &&
      /^[1-9]\d{0,15}$/.test(env.GITHUB_RUN_ID ?? '') &&
      Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) &&
      env.GITHUB_RUN_ATTEMPT === '1' &&
      event.action === 'completed' &&
      [event.repository?.id, run?.id, run?.workflow_id].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) &&
      String(run.id) !== env.GITHUB_RUN_ID &&
      run.name === SOURCE_WORKFLOW_NAME &&
      run.path === SOURCE_WORKFLOW &&
      run.event === 'push' &&
      run.status === 'completed' &&
      ['failure', 'success'].includes(run.conclusion) &&
      run.run_attempt === 1 &&
      run.head_branch === branch &&
      /^[a-f0-9]{40}$/.test(run.head_sha ?? '') &&
      run.repository?.id === event.repository.id &&
      run.repository?.full_name === repository &&
      run.head_repository?.id === event.repository.id &&
      run.head_repository?.full_name === repository,
    'Failure escalation requires an enabled, first-attempt default-branch CI completion from trusted source',
  );
  return {
    repository,
    branch,
    collectorRevision,
    revision: run.head_sha,
    runId: String(run.id),
    workflowId: run.workflow_id,
    conclusion: run.conclusion,
    marker: escalationMarker(SOURCE_WORKFLOW),
  };
}

function clamp(text, limitBytes) {
  const suffix = '\n\n_Truncated._';
  let value = String(text);
  if (Buffer.byteLength(value, 'utf8') <= limitBytes) return value;
  while (Buffer.byteLength(value + suffix, 'utf8') > limitBytes && value.length > 0) {
    value = value.slice(0, -1);
  }
  return value + suffix;
}

/**
 * Job names are repository-authored, not log output, but they still land in a
 * public issue. Strip control characters and backticks so a name cannot break out
 * of its inline code span; markdown inside a code span is not rendered, so
 * removing the delimiter is enough to stop content injection.
 */
function safeJobName(name) {
  return [...String(name ?? '')]
    .map((character) => {
      const code = character.codePointAt(0);
      if (code < 0x20 || code === 0x7f) return ' ';
      return character === '`' ? '' : character;
    })
    .join('')
    .trim()
    .slice(0, 120);
}

export function failedJobNames(jobs) {
  requireContext(Array.isArray(jobs), 'Job inventory is required');
  const failed = jobs
    .filter((job) => ['failure', 'timed_out', 'startup_failure'].includes(job?.conclusion))
    .map((job) => safeJobName(job.name))
    .filter((name) => name.length > 0);
  return [...new Set(failed)].sort().slice(0, ESCALATION_LIMITS.jobs);
}

/** Distinct failed names before the display bound, so truncation can be disclosed. */
function countFailed(jobs) {
  return new Set(
    jobs
      .filter((job) => ['failure', 'timed_out', 'startup_failure'].includes(job?.conclusion))
      .map((job) => safeJobName(job.name))
      .filter((name) => name.length > 0),
  ).size;
}

export function buildEscalationIssue({
  repository,
  branch,
  revision,
  runId,
  jobs,
  now,
  jobsTruncated = false,
}) {
  requireContext(/^[a-f0-9]{40}$/.test(revision ?? ''), 'An exact source revision is required');
  requireContext(/^[1-9]\d{0,15}$/.test(String(runId)), 'An exact run id is required');
  const failed = failedJobNames(jobs);
  const url = `https://github.com/${repository}/actions/runs/${runId}`;
  const title = clamp(`CI is failing on ${branch}`, ESCALATION_LIMITS.titleBytes);
  const body = clamp(
    [
      escalationMarker(SOURCE_WORKFLOW),
      '',
      `\`${SOURCE_WORKFLOW_NAME}\` failed on \`${branch}\` and needs a human owner.`,
      '',
      `- Run: ${url}`,
      `- Revision: \`${revision}\``,
      `- First observed: ${new Date(now).toISOString()}`,
      '',
      failed.length > 0 ? '**Failed jobs**' : '**Failed jobs:** none reported by the API.',
      ...failed.map((name) => `- \`${name}\``),
      ...(jobsTruncated || failed.length < countFailed(jobs)
        ? ['', 'This list is incomplete; open the run for the full job inventory.']
        : []),
      '',
      'This issue was opened from run metadata only. No logs are included, nothing was',
      'rerun, and no source was changed. Diagnosis, the fix and closing this issue are',
      'human work; a later green build is recorded here as a comment but does not close it.',
      '',
    ].join('\n'),
    ESCALATION_LIMITS.bodyBytes,
  );
  return { title, body, marker: escalationMarker(SOURCE_WORKFLOW), failedJobs: failed, url };
}

export function buildRecurrenceComment({ repository, revision, runId, jobs, now }) {
  const failed = failedJobNames(jobs);
  return clamp(
    [
      `Still failing at \`${revision}\`.`,
      '',
      `- Run: https://github.com/${repository}/actions/runs/${runId}`,
      `- Observed: ${new Date(now).toISOString()}`,
      ...(failed.length > 0 ? ['', '**Failed jobs**', ...failed.map((n) => `- \`${n}\``)] : []),
      '',
    ].join('\n'),
    ESCALATION_LIMITS.commentBytes,
  );
}

export function buildRecoveryComment({ repository, revision, runId, now }) {
  return clamp(
    [
      `\`${SOURCE_WORKFLOW_NAME}\` succeeded at \`${revision}\`.`,
      '',
      `- Run: https://github.com/${repository}/actions/runs/${runId}`,
      `- Observed: ${new Date(now).toISOString()}`,
      '',
      'A green build is not proof that the original cause was understood or fixed.',
      'Close this issue only after a human confirms the resolution.',
      '',
    ].join('\n'),
    ESCALATION_LIMITS.commentBytes,
  );
}

export function escalationDigest(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * A deliberately small API surface: read the triggering run and its jobs, search
 * this repository's open issues, and write only an issue or an issue comment.
 */
export function createEscalationClient(repository, token, fetchImpl = fetch) {
  requireContext(
    typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository),
    'A valid repository is required',
  );
  requireContext(typeof token === 'string' && token.length > 0, 'An API token is required');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'slipstream-failure-escalation',
  };
  const readable = [
    /^\/actions\/runs\/[1-9]\d{0,15}$/,
    /^\/actions\/runs\/[1-9]\d{0,15}\/jobs\?per_page=100&page=[1-9]\d{0,2}$/,
    /^\/issues\?state=open&per_page=100&page=[1-9]\d{0,2}$/,
  ];
  const writable = [/^\/issues$/, /^\/issues\/[1-9]\d{0,15}\/comments$/];
  const request = async (method, resource, body) => {
    const allowed = method === 'GET' ? readable : writable;
    requireContext(
      allowed.some((pattern) => pattern.test(resource)),
      'Escalation refused an unsupported API request',
    );
    const response = await fetchImpl(`${base}${resource}`, {
      method,
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    requireContext(response.ok, `GitHub request failed with status ${response.status}`);
    return response.json();
  };
  return {
    json: (resource) => request('GET', resource, undefined),
    post: (resource, body) => request('POST', resource, body),
  };
}

/**
 * Open issues only, never pull requests, and only records this automation actually
 * authored. Matching on the marker alone would let anyone forge it in a hand-made
 * issue and capture every later recurrence and recovery comment.
 *
 * Runs are keyed per triggering run so no completion is dropped, which means two
 * near-simultaneous failures can each open a record. Rather than fail and leave
 * escalation broken exactly when it is needed, the oldest record is chosen
 * deterministically and the duplicate count is reported.
 */
export function findEscalationIssue(issues, marker, author = ESCALATION_AUTHOR) {
  if (!Array.isArray(issues)) throw new Error('An issue inventory is required');
  const matches = issues
    .filter(
      (issue) =>
        issue &&
        issue.pull_request === undefined &&
        issue.state === 'open' &&
        typeof issue.body === 'string' &&
        issue.body.includes(marker) &&
        issue.user?.login === author &&
        issue.user?.type === 'Bot' &&
        Number.isSafeInteger(issue.number) &&
        issue.number > 0,
    )
    .sort((left, right) => left.number - right.number);
  return { issue: matches[0], duplicates: Math.max(0, matches.length - 1) };
}

/** Bounded pagination. Reports truncation instead of silently returning a partial list. */
export async function readAllPages(client, resource, key) {
  const items = [];
  for (let page = 1; page <= ESCALATION_LIMITS.pages; page += 1) {
    const chunk = await client.json(`${resource}per_page=100&page=${page}`);
    const batch = key ? chunk?.[key] : chunk;
    requireContext(Array.isArray(batch), 'A paged inventory is required');
    items.push(...batch);
    if (batch.length < 100) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export async function runEscalation({
  collectorRevision,
  env = process.env,
  event = {},
  client,
  now = Date.now(),
}) {
  const identity = escalationIdentity(collectorRevision, env, event);
  const runPath = `/actions/runs/${identity.runId}`;
  const run = await client.json(runPath);
  requireContext(
    run?.id === Number(identity.runId) &&
      run.head_sha === identity.revision &&
      run.head_branch === identity.branch &&
      run.path === SOURCE_WORKFLOW &&
      run.event === 'push' &&
      run.status === 'completed' &&
      run.run_attempt === 1 &&
      run.conclusion === identity.conclusion &&
      run.repository?.full_name === identity.repository &&
      run.head_repository?.full_name === identity.repository,
    'The triggering run no longer matches its event payload',
  );
  const jobInventory = await readAllPages(client, `${runPath}/jobs?`, 'jobs');
  const issueInventory = await readAllPages(client, '/issues?state=open&', null);
  const { issue: existing, duplicates } = findEscalationIssue(
    issueInventory.items,
    identity.marker,
  );
  requireContext(
    existing !== undefined || !issueInventory.truncated,
    'Open-issue inventory is incomplete; refusing to risk a duplicate escalation issue',
  );
  const context = {
    ...identity,
    jobs: jobInventory.items,
    jobsTruncated: jobInventory.truncated,
    now,
  };

  let action = 'none';
  let issueNumber = existing?.number;
  if (identity.conclusion === 'failure') {
    if (existing) {
      await client.post(`/issues/${existing.number}/comments`, {
        body: buildRecurrenceComment(context),
      });
      action = 'recurrence-recorded';
    } else {
      const issue = buildEscalationIssue(context);
      const created = await client.post('/issues', { title: issue.title, body: issue.body });
      requireContext(
        Number.isSafeInteger(created?.number) && created.number > 0,
        'Issue creation did not return a number',
      );
      issueNumber = created.number;
      action = 'issue-opened';
    }
  } else if (existing) {
    await client.post(`/issues/${existing.number}/comments`, {
      body: buildRecoveryComment(context),
    });
    action = 'recovery-recorded';
  }

  const report = {
    schemaVersion: 1,
    kind: 'failure-escalation',
    repository: identity.repository,
    branch: identity.branch,
    revision: identity.revision,
    collectorRevision: identity.collectorRevision,
    sourceRunId: identity.runId,
    sourceConclusion: identity.conclusion,
    action,
    issueNumber: issueNumber ?? null,
    failedJobs: failedJobNames(jobInventory.items),
    jobInventoryComplete: !jobInventory.truncated,
    duplicateRecords: duplicates,
    automaticResolution: false,
    automaticClosure: false,
    humanTriageRequired: true,
    residual: [
      'Run metadata only; no logs were read and no source, rerun or merge was performed.',
      'A recorded recovery is not proof that the original cause was diagnosed or fixed.',
      ...(jobInventory.truncated
        ? ['The job inventory was truncated; the failed-job list is incomplete.']
        : []),
      ...(duplicates > 0
        ? [
            `${duplicates} additional open escalation record(s) exist; the oldest was used and the rest need closing by hand.`,
          ]
        : []),
    ],
    observedAt: new Date(now).toISOString(),
  };
  return { ...report, digest: escalationDigest(report) };
}

async function main() {
  const collectorRevision = process.env.GITHUB_SHA;
  const event = JSON.parse(
    await (await import('node:fs/promises')).readFile(process.env.GITHUB_EVENT_PATH, 'utf8'),
  );
  const client = createEscalationClient(
    process.env.GITHUB_REPOSITORY,
    process.env.SLIPSTREAM_ESCALATION_TOKEN,
  );
  const report = await runEscalation({ collectorRevision, env: process.env, event, client });
  const fs = await import('node:fs');
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/failure-escalation.json', `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        `## Failure Escalation — ${report.action}`,
        '',
        `Source run: ${report.sourceRunId} (${report.sourceConclusion})`,
        `Failed revision: ${report.revision}`,
        `Collector revision: ${report.collectorRevision}`,
        report.issueNumber ? `Issue: #${report.issueNumber}` : 'No escalation issue was required.',
        '',
        ...report.residual.map((line) => `- ${line}`),
        '',
      ].join('\n'),
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

if (
  process.argv[1] &&
  (await import('node:url')).fileURLToPath(import.meta.url) ===
    (await import('node:path')).resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(`Failure escalation did not complete: ${error.message}`);
    process.exitCode = 1;
  });
}
