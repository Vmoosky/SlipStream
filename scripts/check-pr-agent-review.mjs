import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_REVIEW_LIMITS,
  AGENT_REVIEW_RUNTIME,
  agentReviewEnvironment,
  agentReviewPolicy,
  downloadAgentReviewArchive,
  prepareAgentReviewRuntime,
  preparePrAgentReview,
  prAgentReviewArguments,
  runAgentReviewProcess,
  validateAgentReviewUsage,
  validatePrAgentReviewResponse,
} from './check-agent-review.mjs';

export const PR_AGENT_REVIEW_MARKER = '<!-- slipstream-pr-agent-review:v1 -->';
const REPORT_PATH = 'test-results/pr-agent-review/report.json';
const SUMMARY_PATH = 'test-results/pr-agent-review/summary.md';
const RUN_PATH = 'test-results/pr-agent-review/run';

function requireReview(condition) {
  if (!condition) throw new Error('Invalid or incomplete PR agent review evidence');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function prAgentReviewContext(env, event) {
  const pull = event?.pull_request;
  requireReview(
    env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_EVENT_NAME === 'pull_request_target' &&
      env.GITHUB_REPOSITORY === pull?.base?.repo?.full_name &&
      env.GITHUB_REF === `refs/heads/${pull?.base?.ref}` &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') &&
      env.GITHUB_WORKFLOW_REF ===
        `${env.GITHUB_REPOSITORY}/.github/workflows/pr-agent-review.yml@refs/heads/${pull?.base?.ref}` &&
      Number.isSafeInteger(pull?.number) &&
      pull.number > 0 &&
      /^[a-f0-9]{40}$/.test(pull?.head?.sha ?? '') &&
      /^[a-f0-9]{40}$/.test(pull?.base?.sha ?? '') &&
      pull.head.sha !== pull.base.sha &&
      pull.base.repo.full_name === env.GITHUB_REPOSITORY,
  );
  return {
    repository: env.GITHUB_REPOSITORY,
    number: pull.number,
    base: pull.base.sha,
    head: pull.head.sha,
    draft: pull.draft === true,
  };
}

export function createPrAgentReviewClient(repository, token, fetcher = fetch) {
  requireReview(/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && token);
  const request = async (resource, { method = 'GET', body } = {}) => {
    const read =
      /^\/pulls\/[1-9]\d{0,15}$/.test(resource) ||
      /^\/pulls\/[1-9]\d{0,15}\/files\?per_page=100$/.test(resource) ||
      /^\/issues\/[1-9]\d{0,15}\/comments\?per_page=100$/.test(resource);
    const write =
      /^\/issues(?:\/[1-9]\d{0,15}\/comments|\/comments\/[1-9]\d{0,15})$/.test(resource) &&
      ['POST', 'PATCH'].includes(method) &&
      typeof body?.body === 'string' &&
      body.body.startsWith(PR_AGENT_REVIEW_MARKER) &&
      Buffer.byteLength(body.body) <= 32 * 1024;
    requireReview((method === 'GET' && read && body === undefined) || write);
    const response = await fetcher(`https://api.github.com/repos/${repository}${resource}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    requireReview(response.ok);
    return response.status === 204 ? null : response.json();
  };
  return { request };
}

export async function collectPrAgentReview(context, client) {
  const pull = await client.request(`/pulls/${context.number}`);
  requireReview(
    pull.number === context.number &&
      pull.base?.repo?.full_name === context.repository &&
      pull.head?.sha === context.head &&
      /^[a-f0-9]{40}$/.test(pull.base?.sha ?? '') &&
      pull.base.sha !== pull.head.sha &&
      Number.isSafeInteger(pull.changed_files) &&
      pull.changed_files > 0 &&
      pull.changed_files <= 100,
  );
  const files = await client.request(`/pulls/${context.number}/files?per_page=100`);
  requireReview(
    Array.isArray(files) &&
      files.length === pull.changed_files &&
      files.every((file) => typeof file.patch === 'string'),
  );
  return preparePrAgentReview({ ...context, base: pull.base.sha, files });
}

export function prAgentReviewFindingIds(prepared, response) {
  return response.findings.map((finding, index) =>
    sha256(
      JSON.stringify({
        schemaVersion: 1,
        repository: prepared.repository,
        number: prepared.number,
        head: prepared.head,
        inputSha256: prepared.inputSha256,
        index,
        finding,
      }),
    ),
  );
}

export function renderPrAgentReview(report) {
  const findings = report.findings ?? [];
  return [
    PR_AGENT_REVIEW_MARKER,
    '## Bounded Agent Review',
    '',
    `Reviewed commit \`${report.head.slice(0, 12)}\` with no tools or repository write access.`,
    `Decision: **${report.decision}**. Findings: **${findings.length}**.`,
    '',
    ...findings.flatMap((finding) => [
      `- **${finding.severity}** in \`${finding.file}\`: ${finding.message}`,
      `  Finding ID: \`${finding.id}\``,
    ]),
    ...(findings.length ? [''] : []),
    'This automated review is advisory. Required checks and independent human approval remain mandatory.',
  ].join('\n');
}

export async function publishPrAgentReview(report, client) {
  const pull = await client.request(`/pulls/${report.number}`);
  requireReview(pull.head?.sha === report.head && pull.base?.sha === report.base);
  const comments = await client.request(`/issues/${report.number}/comments?per_page=100`);
  requireReview(Array.isArray(comments) && comments.length < 100);
  const owned = comments.filter(
    (comment) =>
      comment.user?.login === 'github-actions[bot]' &&
      typeof comment.body === 'string' &&
      comment.body.startsWith(PR_AGENT_REVIEW_MARKER),
  );
  requireReview(owned.length <= 1);
  const body = renderPrAgentReview(report);
  await client.request(
    owned.length ? `/issues/comments/${owned[0].id}` : `/issues/${report.number}/comments`,
    { method: owned.length ? 'PATCH' : 'POST', body: { body } },
  );
  report.publication = 'applied';
}

function writeExclusive(file, value) {
  fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
}

function readBounded(file, limit) {
  const stat = fs.lstatSync(file);
  requireReview(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit);
  const bytes = fs.readFileSync(file);
  requireReview(bytes.length === stat.size && bytes.length <= limit);
  return bytes;
}

export async function preparePrAgentReviewRun({
  root,
  env = process.env,
  event,
  fetcher = fetch,
} = {}) {
  const context = prAgentReviewContext(env, event);
  const policy = agentReviewPolicy(env);
  requireReview(policy.enabled);
  const client = createPrAgentReviewClient(context.repository, env.GITHUB_TOKEN, fetcher);
  const prepared = await collectPrAgentReview(context, client);
  const directory = path.join(root, RUN_PATH);
  fs.mkdirSync(directory, { recursive: true });
  for (const child of ['home', 'home/tmp', 'tmp', 'work', 'work/.git']) {
    fs.mkdirSync(path.join(directory, child), { recursive: true });
  }
  const archive = path.join(directory, AGENT_REVIEW_RUNTIME.archive);
  await downloadAgentReviewArchive(archive);
  const executable = await prepareAgentReviewRuntime(archive, directory);
  const input = JSON.parse(prepared.input.toString('utf8'));
  writeExclusive(path.join(directory, 'input.json'), `${JSON.stringify(input)}\n`);
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_PATH) {
    fs.appendFileSync(env.GITHUB_PATH, `${path.dirname(executable)}\n`);
  }
  return { ...context, base: prepared.base, inputSha256: prepared.inputSha256, executable };
}

export async function finalizePrAgentReviewRun({
  root,
  env = process.env,
  event,
  fetcher = fetch,
} = {}) {
  const context = prAgentReviewContext(env, event);
  const policy = agentReviewPolicy(env);
  requireReview(policy.enabled);
  const directory = path.join(root, RUN_PATH);
  const input = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(
      readBounded(path.join(directory, 'input.json'), AGENT_REVIEW_LIMITS.inputBytes),
    ),
  );
  const prepared = preparePrAgentReview(input);
  requireReview(
    prepared.repository === context.repository &&
      prepared.number === context.number &&
      /^[a-f0-9]{40}$/.test(prepared.base) &&
      prepared.head === context.head,
  );
  const responseBytes = readBounded(
    path.join(directory, 'response.json'),
    AGENT_REVIEW_LIMITS.outputBytes,
  );
  requireReview(!responseBytes.includes(env.SLIPSTREAM_AGENT_REVIEW_TOKEN));
  const response = validatePrAgentReviewResponse(responseBytes, prepared);
  const usage = validateAgentReviewUsage(
    readBounded(path.join(directory, 'usage.json'), AGENT_REVIEW_LIMITS.usageBytes),
    policy.model,
  );
  const ids = prAgentReviewFindingIds(prepared, response);
  const report = {
    schemaVersion: 1,
    kind: 'pr-agent-review',
    status: 'reviewed',
    repository: context.repository,
    number: context.number,
    base: prepared.base,
    head: context.head,
    inputSha256: prepared.inputSha256,
    responseSha256: sha256(responseBytes),
    decision: response.decision,
    runtime: AGENT_REVIEW_RUNTIME,
    limits: AGENT_REVIEW_LIMITS,
    invocations: 1,
    retries: 0,
    usage,
    findings: response.findings.map((finding, index) => ({
      ...finding,
      id: ids[index],
      disposition: 'pending-human-review',
      fixVerified: false,
    })),
    publication: 'not-applied',
    humanApprovalRequired: true,
    automaticFix: false,
  };
  const client = createPrAgentReviewClient(context.repository, env.GITHUB_TOKEN, fetcher);
  await publishPrAgentReview(report, client);
  const reportDirectory = path.join(root, path.dirname(REPORT_PATH));
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(root, SUMMARY_PATH), `${renderPrAgentReview(report)}\n`);
  fs.rmSync(directory, { recursive: true, force: true });
  return report;
}

export function retainPrAgentReviewFailure({ root, env = process.env, event } = {}) {
  const context = prAgentReviewContext(env, event);
  const report = {
    schemaVersion: 1,
    kind: 'pr-agent-review',
    status: 'failed',
    ...context,
    runtime: AGENT_REVIEW_RUNTIME,
    limits: AGENT_REVIEW_LIMITS,
    invocations: 1,
    retries: 0,
    publication: 'not-applied',
    humanApprovalRequired: true,
    automaticFix: false,
    errors: ['pr-agent-review-failed'],
  };
  const summary = [
    PR_AGENT_REVIEW_MARKER,
    '## Bounded Agent Review',
    '',
    `Review of commit \`${context.head.slice(0, 12)}\` failed before a validated response was produced.`,
    'No findings were published. Required checks and independent human approval remain mandatory.',
  ].join('\n');
  const reportDirectory = path.join(root, path.dirname(REPORT_PATH));
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(root, SUMMARY_PATH), `${summary}\n`);
  fs.rmSync(path.join(root, RUN_PATH), { recursive: true, force: true });
  return report;
}

export async function runPrAgentReview({ env = process.env, event, fetcher = fetch } = {}) {
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    kind: 'pr-agent-review',
    status: 'disabled',
    startedAt,
    finishedAt: null,
    runtime: AGENT_REVIEW_RUNTIME,
    limits: AGENT_REVIEW_LIMITS,
    invocations: 0,
    retries: 0,
    publication: 'not-applied',
    humanApprovalRequired: true,
    automaticFix: false,
    errors: [],
  };
  let directory;
  try {
    const context = prAgentReviewContext(env, event);
    Object.assign(report, context);
    if (context.draft) return report;
    const policy = agentReviewPolicy(env);
    report.policy = policy;
    if (!policy.enabled) return report;
    const api = createPrAgentReviewClient(context.repository, env.GITHUB_TOKEN, fetcher);
    const prepared = await collectPrAgentReview(context, api);
    report.inputSha256 = prepared.inputSha256;
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-pr-review-')),
    );
    const home = path.join(directory, 'home');
    const work = path.join(directory, 'work');
    fs.mkdirSync(home);
    fs.mkdirSync(work);
    fs.mkdirSync(path.join(work, '.git'));
    fs.mkdirSync(path.join(directory, 'tmp'));
    fs.mkdirSync(path.join(home, 'tmp'));
    const archive = path.join(directory, AGENT_REVIEW_RUNTIME.archive);
    await downloadAgentReviewArchive(archive);
    const executable = await prepareAgentReviewRuntime(archive, directory);
    report.invocations = 1;
    const bytes = await runAgentReviewProcess(
      executable,
      prAgentReviewArguments(prepared, policy, directory),
      { cwd: work, env: agentReviewEnvironment(home, env.SLIPSTREAM_AGENT_REVIEW_TOKEN) },
    );
    const response = validatePrAgentReviewResponse(bytes, prepared);
    const usage = validateAgentReviewUsage(
      fs.readFileSync(path.join(directory, 'usage.json')),
      policy.model,
    );
    const ids = prAgentReviewFindingIds(prepared, response);
    Object.assign(report, {
      status: 'reviewed',
      decision: response.decision,
      responseSha256: sha256(bytes),
      usage,
      findings: response.findings.map((finding, index) => ({
        ...finding,
        id: ids[index],
        disposition: 'pending-human-review',
        fixVerified: false,
      })),
    });
    await publishPrAgentReview(report, api);
  } catch {
    report.status = 'failed';
    report.errors.push('pr-agent-review-failed');
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.finishedAt) - Date.parse(startedAt);
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--prepare', '--finalize'].includes(args[0])) {
    throw new Error('Usage: check-pr-agent-review.mjs --prepare | --finalize');
  }
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    if (args[0] === '--prepare') {
      const prepared = await preparePrAgentReviewRun({ root, event });
      console.log(JSON.stringify({ status: 'prepared', head: prepared.head }));
      return;
    }
    const report = await finalizePrAgentReviewRun({ root, event });
    console.log(JSON.stringify({ status: report.status, decision: report.decision ?? null }));
    process.exitCode = report.decision === 'no-objection' ? 0 : 1;
  } catch (error) {
    retainPrAgentReviewFailure({ root, event });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('PR agent review failed; inspect the retained bounded report.');
    process.exitCode = 1;
  });
}
