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
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > limit)
    throw new Error('Evidence file exceeds its limit or is linked');
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.length > limit) throw new Error('Evidence file exceeds its limit');
  return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
}

function findReport(root, name = 'agent-review.json', { optional = false } = {}) {
  const matches = [];
  let entries = 0;
  const walk = (directory, depth) => {
    if (depth > 4) throw new Error('Evidence directory is too deep');
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked evidence directory');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 64 || entry.isSymbolicLink()) throw new Error('Invalid evidence inventory');
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target, depth + 1);
      else if (entry.isFile() && entry.name === name) matches.push(target);
    }
  };
  walk(root, 0);
  if (matches.length > 1 || (!optional && matches.length !== 1))
    throw new Error(`Expected exactly one ${name} artifact`);
  return matches[0] ?? null;
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
  const sourceDirectory = path.join(root, 'test-results/agentic-review-source');
  const reviewPath = findReport(sourceDirectory, 'agent-review.json', { optional: true });
  const reportPath = reviewPath ?? findReport(sourceDirectory, 'summary.json');
  const { bytes, value: report } = readJson(reportPath);
  const workflow = `${repository}/.github/workflows/maintenance.yml@refs/heads/${branch}`;
  let reason;
  if (
    report.schemaVersion !== 1 ||
    report.eventName !== 'schedule' ||
    report.attempt !== '1' ||
    report.revision !== run.head_sha ||
    report.runId !== String(run.id) ||
    report.workflow !== workflow ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0
  )
    throw new Error('Agent review report failed its evidence contract');
  if (reviewPath) {
    if (
      report.kind !== 'bounded-agent-review' ||
      report.status !== 'reviewed' ||
      report.humanApprovalRequired !== true ||
      report.automaticPublication !== false ||
      report.cleanup !== true ||
      report.invocations !== 1 ||
      report.wrapperRetries !== 0 ||
      report.policy?.enabled !== true ||
      report.policy?.provider !== 'github-copilot-cli'
    )
      throw new Error('Agent review report failed its evidence contract');
  } else {
    const proposal = report.documentation?.proposal;
    if (
      report.kind !== 'maintenance-validation' ||
      report.passed !== true ||
      !['context', 'install', 'build', 'tests', 'audit', 'docs', 'proof'].every(
        (name) => report.steps?.[name] === 'success',
      ) ||
      !Array.isArray(proposal?.files)
    )
      throw new Error('Missing review requires successful maintenance evidence');
    if (
      report.documentation.outcome === 'no-op' &&
      report.proposalPath === null &&
      proposal.files.length === 0 &&
      proposal.changedLines === 0 &&
      proposal.patchBytes === 0 &&
      proposal.patchSha256 === createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    ) {
      reason = 'no-proposal';
    } else if (
      report.agentReview?.enabled === false &&
      report.documentation.outcome === 'proposed' &&
      /^test-results\/maintenance\/run-[A-Za-z0-9]+\/proposal\.patch$/.test(
        report.proposalPath ?? '',
      ) &&
      proposal.files.length > 0 &&
      proposal.files.length <= 3 &&
      Number.isInteger(proposal.changedLines) &&
      proposal.changedLines > 0 &&
      proposal.changedLines <= 200 &&
      Number.isInteger(proposal.patchBytes) &&
      proposal.patchBytes > 0 &&
      proposal.patchBytes <= 64 * 1024 &&
      /^[a-f0-9]{64}$/.test(proposal.patchSha256 ?? '')
    ) {
      reason = 'review-disabled';
    } else {
      throw new Error('An expected agent review is missing or its eligibility is unverified');
    }
  }
  return {
    schemaVersion: 1,
    kind: 'agentic-improvement-evidence',
    status: reviewPath ? 'verified' : 'not-applicable',
    ...(reason ? { reason } : {}),
    repository,
    branch,
    source: {
      workflow: run.path,
      runId: String(run.id),
      attempt: run.run_attempt,
      revision: run.head_sha,
      conclusion: run.conclusion,
      reportSha256: createHash('sha256').update(bytes).digest('hex'),
      ...(reviewPath ? {} : { reportKind: 'maintenance-validation' }),
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

export function runAgenticImprovementEvidence({ root, env }) {
  let report;
  try {
    if (env.SLIPSTREAM_AGENTIC_SOURCE_OUTCOME !== 'success')
      throw new Error('Maintenance artifact download did not succeed');
    const event = readJson(env.GITHUB_EVENT_PATH).value;
    report = verifyAgenticImprovementEvidence({ root, event, env });
  } catch {
    report = {
      schemaVersion: 1,
      kind: 'agentic-improvement-evidence',
      status: 'failed',
      errors: ['Maintenance evidence is missing, mismatched, or unsuccessful'],
      humanApprovalRequired: true,
      automaticPublication: false,
    };
  }
  const directory = path.join(root, 'test-results/agentic-improvement');
  fs.mkdirSync(directory, { recursive: true });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Linked report directory');
  fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Agentic Improvement Evidence\n\nStatus: ${report.status}\n\nReason: ${report.reason ?? (report.status === 'failed' ? 'invalid-evidence' : 'review-verified')}\n`,
    );
  }
  return report;
}

function main() {
  const report = runAgenticImprovementEvidence({ root: ROOT, env: process.env });
  console.log(JSON.stringify({ status: report.status, sourceRunId: report.source?.runId ?? null }));
  process.exitCode = report.status === 'failed' ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
