import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG_PATH = '.github/agent-review.json';
const REPORT_LIMIT = 1024 * 1024;

function revision(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function positiveId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

function readJson(file, limit = REPORT_LIMIT) {
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.length > limit) throw new Error('Evidence file exceeds its limit');
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function findReport(root) {
  const matches = [];
  const walk = (directory, depth) => {
    if (depth > 4) throw new Error('Evidence directory is too deep');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target, depth + 1);
      else if (entry.isFile() && entry.name === 'agent-review.json') matches.push(target);
    }
  };
  walk(root, 0);
  if (matches.length !== 1) throw new Error('Expected exactly one agent-review.json artifact');
  return matches[0];
}

export function verifyAgenticImprovementEvidence({ root, event, env }) {
  const config = readJson(path.join(root, CONFIG_PATH)).value;
  if (
    config.schemaVersion !== 1 ||
    config.sourceWorkflow !== '.github/workflows/maintenance.yml' ||
    config.evidenceWorkflow !== '.github/workflows/agentic-improvement.yml' ||
    config.reportName !== 'agent-review.json' ||
    config.requiredEvent !== 'schedule' ||
    config.humanApprovalRequired !== true ||
    config.automaticPublication !== false
  )
    throw new Error('Invalid agent review contract');
  const run = event?.workflow_run;
  const repository = event?.repository?.full_name;
  const branch = event?.repository?.default_branch;
  if (
    event?.action !== 'completed' ||
    run?.name !== 'Maintenance' ||
    run?.path !== config.sourceWorkflow ||
    run?.event !== config.requiredEvent ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success' ||
    run?.head_branch !== branch ||
    run?.repository?.full_name !== repository ||
    run?.head_repository?.full_name !== repository ||
    run?.run_attempt !== 1 ||
    !positiveId(String(run.id)) ||
    !revision(run.head_sha) ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_run' ||
    env.GITHUB_REF !== `refs/heads/${branch}` ||
    env.GITHUB_REPOSITORY !== repository ||
    !revision(env.GITHUB_SHA) ||
    !positiveId(env.GITHUB_RUN_ID) ||
    !positiveId(env.GITHUB_RUN_ATTEMPT)
  )
    throw new Error('Untrusted or incomplete maintenance provenance');
  const reportPath = findReport(path.join(root, 'test-results/agentic-review-source'));
  const { bytes, value: report } = readJson(reportPath);
  if (
    report.schemaVersion !== 1 ||
    report.kind !== 'bounded-agent-review' ||
    report.status !== 'reviewed' ||
    report.eventName !== 'schedule' ||
    report.attempt !== '1' ||
    report.revision !== run.head_sha ||
    report.runId !== String(run.id) ||
    report.workflow !== `${repository}/.github/workflows/maintenance.yml@refs/heads/${branch}` ||
    report.humanApprovalRequired !== true ||
    report.automaticPublication !== false ||
    report.cleanup !== true ||
    report.invocations !== 1 ||
    report.wrapperRetries !== 0 ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0 ||
    report.policy?.enabled !== true ||
    report.policy?.provider !== 'github-copilot-cli'
  )
    throw new Error('Agent review report failed its evidence contract');
  return {
    schemaVersion: 1,
    kind: 'agentic-improvement-evidence',
    status: 'verified',
    repository,
    branch,
    source: {
      workflow: run.path,
      runId: String(run.id),
      attempt: run.run_attempt,
      revision: run.head_sha,
      conclusion: run.conclusion,
      reportSha256: createHash('sha256').update(bytes).digest('hex'),
    },
    collector: {
      workflow: env.GITHUB_WORKFLOW_REF,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      revision: env.GITHUB_SHA,
    },
    humanApprovalRequired: true,
    automaticPublication: false,
  };
}

function main() {
  const root = ROOT;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const report = verifyAgenticImprovementEvidence({ root, event, env: process.env });
  const directory = path.join(root, 'test-results/agentic-improvement');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(JSON.stringify({ status: report.status, sourceRunId: report.source.runId }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
