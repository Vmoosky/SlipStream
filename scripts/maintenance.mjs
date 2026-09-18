import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DOC_CONTRACTS, validateProofReport } from './check-ci.mjs';

const executeFile = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const GENERATOR = new URL('./check-docs.mjs', import.meta.url).href;
const GENERATE = [
  'const { checkDocs } = await import(process.argv[1]);',
  'const report = checkDocs(process.argv[2], { write: process.argv[3] === "write" });',
  'process.stdout.write(JSON.stringify(report));',
  'process.exitCode = report.passed || process.argv[3] === "diagnose" ? 0 : 1;',
].join('\n');

export const MAINTENANCE_LIMITS = Object.freeze({
  files: DOC_CONTRACTS.length,
  changedLines: 200,
  patchBytes: 64 * 1024,
  commandTimeoutMs: 60_000,
});

const REFERENCES = {
  'docs/architecture.md': 'build',
  'packages/extension/README.md': 'extension',
  'docs/mcp.md': 'mcp',
};

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function frame(file, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) {
    throw new Error('Documentation must be UTF-8 text');
  }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const startMarker = `<!-- slipstream-reference:${REFERENCES[file]}:start -->`;
  const endMarker = `<!-- slipstream-reference:${REFERENCES[file]}:end -->`;
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (
    start < 0 ||
    end <= start ||
    text.indexOf(startMarker, start + 1) >= 0 ||
    text.indexOf(endMarker, end + 1) >= 0
  ) {
    throw new Error('Exactly one existing generated block is required');
  }
  return [text.slice(0, start), text.slice(end + endMarker.length)];
}

export function validateDocumentationProposal(changes, patch) {
  if (
    !Array.isArray(changes) ||
    changes.length > MAINTENANCE_LIMITS.files ||
    new Set(changes.map((change) => change?.path)).size !== changes.length
  ) {
    throw new Error('Invalid documentation change set');
  }
  if (!Buffer.isBuffer(patch) || patch.length > MAINTENANCE_LIMITS.patchBytes) {
    throw new Error('Documentation patch exceeds its byte limit');
  }
  if ((changes.length === 0) !== (patch.length === 0)) {
    throw new Error('Patch and change set disagree');
  }
  let changedLines = 0;
  const files = changes.map((change) => {
    if (
      !DOC_CONTRACTS.includes(change?.path) ||
      change.status !== 'M' ||
      change.oldMode !== '100644' ||
      change.newMode !== '100644' ||
      !Number.isInteger(change.added) ||
      change.added < 0 ||
      !Number.isInteger(change.deleted) ||
      change.deleted < 0 ||
      change.added + change.deleted === 0
    ) {
      throw new Error('Only existing generated-document text edits are allowed');
    }
    const before = frame(change.path, change.before);
    const after = frame(change.path, change.after);
    if (before[0] !== after[0] || before[1] !== after[1] || change.before.equals(change.after)) {
      throw new Error('Changes must stay inside generated blocks');
    }
    changedLines += change.added + change.deleted;
    return {
      path: change.path,
      added: change.added,
      deleted: change.deleted,
      beforeSha256: digest(change.before),
      afterSha256: digest(change.after),
    };
  });
  if (changedLines > MAINTENANCE_LIMITS.changedLines) {
    throw new Error('Documentation patch exceeds its line limit');
  }
  return { files, changedLines, patchBytes: patch.length, patchSha256: digest(patch) };
}

export async function runMaintenanceCommand(command, args, cwd, timeoutMs = 60_000, signal) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('Maintenance command timeout must be between 1 and 60000 ms');
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.SLIPSTREAM_DOCS_REMEDIATION_TOKEN;
  for (const name of Object.keys(env)) {
    if (
      /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG)/.test(
        name,
      )
    ) {
      delete env[name];
    }
  }
  const execution = executeFile(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    encoding: 'buffer',
    signal,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  const closed = new Promise((resolve) => execution.child.once('close', resolve));
  try {
    return (await execution).stdout;
  } catch {
    throw new Error('Maintenance command failed, timed out, or exceeded its output limit');
  } finally {
    await closed;
  }
}

function remediationTrigger(revision, env, event) {
  const repository = event.repository?.full_name;
  const branch = event.repository?.default_branch;
  const run = event.workflow_run;
  if (
    typeof repository !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    typeof branch !== 'string' ||
    !/^[\w./-]{1,200}$/.test(branch) ||
    env.SLIPSTREAM_DOCS_REMEDIATION_ENABLED !== 'true' ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_SHA !== revision ||
    env.GITHUB_REF !== `refs/heads/${branch}` ||
    env.GITHUB_WORKFLOW_REF !==
      `${repository}/.github/workflows/docs-remediation.yml@refs/heads/${branch}` ||
    env.GITHUB_SERVER_URL !== 'https://github.com' ||
    env.GITHUB_API_URL !== 'https://api.github.com' ||
    !/^[1-9]\d{0,15}$/.test(env.GITHUB_RUN_ID ?? '') ||
    !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) ||
    env.GITHUB_RUN_ATTEMPT !== '1' ||
    event.action !== 'completed' ||
    ![event.repository?.id, run?.id, run?.workflow_id].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    String(run.id) === env.GITHUB_RUN_ID ||
    run.name !== 'CI' ||
    run.path !== '.github/workflows/ci.yml' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'failure' ||
    run.run_attempt !== 1 ||
    run.head_branch !== branch ||
    run.head_sha !== revision ||
    run.repository?.id !== event.repository.id ||
    run.repository?.full_name !== repository ||
    run.head_repository?.id !== event.repository.id ||
    run.head_repository?.full_name !== repository
  ) {
    throw new Error(
      'Documentation remediation requires an enabled, first-attempt failed CI run at trusted current source',
    );
  }
  return { runId: String(run.id), attempt: '1', workflowId: run.workflow_id };
}

export function maintenanceIdentity(revision, env = process.env, event = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) {
    throw new Error('An exact source revision is required');
  }
  if (env.GITHUB_ACTIONS !== 'true') {
    return { revision, eventName: 'local', workflow: null, runId: null, attempt: null };
  }
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    return {
      revision,
      eventName: env.GITHUB_EVENT_NAME,
      workflow: env.GITHUB_WORKFLOW_REF,
      runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT,
      trigger: remediationTrigger(revision, env, event),
    };
  }
  const repository = event.repository?.full_name;
  const branch = event.repository?.default_branch;
  if (
    !repository ||
    !branch ||
    env.SLIPSTREAM_MAINTENANCE_ENABLED !== 'true' ||
    !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REPOSITORY !== repository ||
    env.GITHUB_SHA !== revision ||
    env.GITHUB_REF !== `refs/heads/${branch}` ||
    env.GITHUB_WORKFLOW_REF !==
      `${repository}/.github/workflows/maintenance.yml@refs/heads/${branch}` ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ||
    !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
  ) {
    throw new Error('Maintenance requires enabled, exact default-branch workflow provenance');
  }
  return {
    revision,
    eventName: env.GITHUB_EVENT_NAME,
    workflow: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  };
}

export async function verifyDocumentationRemediation(revision, env, event, client) {
  const metadata = maintenanceIdentity(revision, env, event);
  if (!metadata.trigger) throw new Error('A documentation remediation trigger is required');
  const workflow = await client.json('/actions/workflows/ci.yml');
  if (
    workflow?.id !== metadata.trigger.workflowId ||
    workflow.name !== 'CI' ||
    workflow.path !== '.github/workflows/ci.yml' ||
    workflow.state !== 'active'
  ) {
    throw new Error('The remediation source workflow could not be verified');
  }
  const run = await client.json(`/actions/runs/${metadata.trigger.runId}`);
  const current = remediationTrigger(revision, env, { ...event, workflow_run: run });
  if (
    current.runId !== metadata.trigger.runId ||
    current.workflowId !== metadata.trigger.workflowId
  ) {
    throw new Error('The remediation source run changed');
  }
  const branch = await client.json(
    `/branches/${encodeURIComponent(event.repository.default_branch)}`,
  );
  if (branch?.name !== event.repository.default_branch || branch.commit?.sha !== revision) {
    throw new Error('The remediation source is no longer the current default branch');
  }
  return metadata.trigger;
}

function outputDirectory(root) {
  let directory = root;
  for (const name of ['test-results', 'maintenance']) {
    directory = path.join(directory, name);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Maintenance output must stay inside the repository');
    }
  }
  return fs.mkdtempSync(path.join(directory, 'run-'));
}

function readDocument(root, file) {
  let target = root;
  for (const part of file.split('/')) {
    target = path.join(target, part);
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Symlink paths are not allowed');
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error('Unexpected documentation file');
  }
  return fs.readFileSync(target);
}

export async function runDocumentationMaintenance(
  root,
  { revision, env = process.env, event = {}, runCommand = runMaintenanceCommand, signal, client },
) {
  root = fs.realpathSync.native(root);
  const metadata = maintenanceIdentity(revision, env, event);
  const report = {
    schemaVersion: 1,
    kind: 'documentation-maintenance',
    ...metadata,
    startedAt: new Date().toISOString(),
    limits: MAINTENANCE_LIMITS,
    generatorSha256: digest(fs.readFileSync(fileURLToPath(GENERATOR))),
    outcome: 'failed',
    passed: false,
    cancelled: false,
    checks: {},
    proposal: null,
    ...(metadata.trigger
      ? {
          remediation: {
            status: 'unverified',
            before: null,
            after: null,
            ciResolutionVerified: false,
            automaticPublication: false,
            humanApprovalRequired: true,
          },
        }
      : {}),
    errors: [],
    residual: [
      'A proposed patch requires a human-created PR, full required checks, and manual review.',
      'Local execution does not prove scheduler enrollment or merge enforcement.',
      ...(metadata.trigger
        ? [
            'A documentation patch does not establish the cause or resolution of the triggering CI failure.',
          ]
        : []),
    ],
  };
  const git = (cwd, args) =>
    runCommand('git', ['-C', cwd, ...args], cwd, MAINTENANCE_LIMITS.commandTimeoutMs, signal);
  let scratch;
  let output;
  let patch;
  const documentationEvidence = new Map();
  let stage = 'source';
  try {
    signal?.throwIfAborted();
    if (
      path.relative(
        fs.realpathSync.native(
          (await git(root, ['rev-parse', '--show-toplevel'])).toString().trim(),
        ),
        root,
      ) !== ''
    ) {
      throw new Error('The source must be a repository root');
    }
    if ((await git(root, ['rev-parse', 'HEAD'])).toString().trim() !== revision) {
      throw new Error('Source revision changed');
    }
    if ((await git(root, ['status', '--porcelain=v1', '-z'])).length !== 0) {
      throw new Error('The source must be clean');
    }
    if (digest(readDocument(root, 'scripts/check-docs.mjs')) !== report.generatorSha256) {
      throw new Error('The generator must match the source revision');
    }
    output = outputDirectory(root);
    if (metadata.trigger) {
      stage = 'trigger';
      signal?.throwIfAborted();
      await verifyDocumentationRemediation(revision, env, event, client);
      signal?.throwIfAborted();
      report.checks.trigger = 'success';
      stage = 'source';
    }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-maintenance-'));
    const checkout = path.join(scratch, 'checkout');
    await git(root, [
      'clone',
      '--quiet',
      '--local',
      '--no-hardlinks',
      '--no-checkout',
      '--no-tags',
      '--config',
      'core.autocrlf=false',
      root,
      checkout,
    ]);
    const tree = (await git(checkout, ['ls-tree', '-r', '-z', revision]))
      .toString()
      .split('\0')
      .filter(Boolean);
    if (tree.some((entry) => !/^(100644|100755) blob [a-f0-9]{40}\t/.test(entry))) {
      throw new Error('Source symlinks and submodules are not supported');
    }
    const hooks = path.join(scratch, 'hooks');
    fs.mkdirSync(hooks);
    await git(checkout, [
      '-c',
      `core.hooksPath=${hooks}`,
      'checkout',
      '--quiet',
      '--detach',
      revision,
    ]);
    const originals = new Map(DOC_CONTRACTS.map((file) => [file, readDocument(checkout, file)]));
    for (const [file, bytes] of originals) frame(file, bytes);
    report.checks.source = 'success';

    const generate = async (write, diagnose = false) => {
      const bytes = await runCommand(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          GENERATE,
          GENERATOR,
          checkout,
          write ? 'write' : diagnose ? 'diagnose' : 'check',
        ],
        checkout,
        MAINTENANCE_LIMITS.commandTimeoutMs,
        signal,
      );
      const result = JSON.parse(bytes.toString());
      if (
        result.schemaVersion !== 1 ||
        result.kind !== 'documentation-contracts' ||
        typeof result.passed !== 'boolean' ||
        (!diagnose && result.passed !== true) ||
        !Array.isArray(result.errors) ||
        result.passed !== (result.errors.length === 0) ||
        !Array.isArray(result.contracts) ||
        result.contracts.length !== DOC_CONTRACTS.length ||
        !DOC_CONTRACTS.every((file) => result.contracts.includes(file)) ||
        !Array.isArray(result.written) ||
        !result.written.every((file) => DOC_CONTRACTS.includes(file))
      ) {
        throw new Error('Documentation evidence is invalid');
      }
      if (metadata.trigger && !write) {
        documentationEvidence.set(diagnose ? 'before.json' : 'after.json', bytes);
      }
      return { ...result, reportSha256: digest(bytes) };
    };
    const diff = () =>
      git(checkout, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--binary',
        '--full-index',
        'HEAD',
        '--',
      ]);
    if (metadata.trigger) {
      stage = 'diagnosis';
      const before = await generate(false, true);
      if (before.written.length !== 0 || (await diff()).length !== 0) {
        throw new Error('Diagnosis modified source documents');
      }
      report.remediation.before = { passed: before.passed, reportSha256: before.reportSha256 };
      report.checks.diagnosis = 'success';
    }
    stage = 'generation';
    await generate(true);
    report.checks.generation = 'success';
    patch = await diff();
    stage = 'validation';
    const validation = await generate(false);
    if (validation.written.length !== 0 || !(await diff()).equals(patch)) {
      throw new Error('Check mode modified documents');
    }
    report.checks.validation = 'success';
    report.coverage = validation.coverage;
    if (metadata.trigger) {
      report.remediation.after = { passed: true, reportSha256: validation.reportSha256 };
    }
    stage = 'idempotence';
    if ((await generate(true)).written.length !== 0 || !(await diff()).equals(patch)) {
      throw new Error('Documentation generation is not idempotent');
    }
    report.checks.idempotence = 'success';

    stage = 'proposal';
    if (
      (await git(checkout, ['ls-files', '--others', '--exclude-standard', '-z'])).length !== 0 ||
      (await git(checkout, ['diff', '--cached', '--name-only', '-z'])).length !== 0
    ) {
      throw new Error('Unexpected untracked or staged files in the proposal');
    }
    const raw = (
      await git(checkout, [
        'diff',
        '--raw',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-abbrev',
        '--no-renames',
        '-z',
        'HEAD',
        '--',
      ])
    )
      .toString()
      .split('\0')
      .filter(Boolean);
    const statistics = new Map(
      (
        await git(checkout, [
          'diff',
          '--numstat',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--no-renames',
          '-z',
          'HEAD',
          '--',
        ])
      )
        .toString()
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const [added, deleted, file] = entry.split('\t');
          return [file, { added: Number(added), deleted: Number(deleted) }];
        }),
    );
    const changes = [];
    for (let index = 0; index < raw.length; index += 2) {
      const [oldMode, newMode, , , status] = raw[index].split(' ');
      const file = raw[index + 1];
      if (!DOC_CONTRACTS.includes(file) || !statistics.has(file)) {
        throw new Error('Unexpected changed path');
      }
      changes.push({
        path: file,
        status,
        oldMode: oldMode.slice(1),
        newMode,
        before: originals.get(file),
        after: readDocument(checkout, file),
        ...statistics.get(file),
      });
    }
    report.proposal = validateDocumentationProposal(changes, patch);
    if (metadata.trigger && report.remediation.before.passed !== (changes.length === 0)) {
      throw new Error('The proposal does not match the reproduced documentation outcome');
    }
    await git(checkout, ['diff', '--check', 'HEAD', '--']);
    if (
      (await git(root, ['rev-parse', 'HEAD'])).toString().trim() !== revision ||
      (await git(root, ['status', '--porcelain=v1', '-z'])).length !== 0
    ) {
      throw new Error('Source changed while preparing the proposal');
    }
    signal?.throwIfAborted();
    report.checks.proposal = 'success';
    report.outcome = changes.length === 0 ? 'no-op' : 'proposed';
    report.passed = true;
  } catch {
    if (signal?.aborted) {
      report.cancelled = true;
      stage = 'cancellation';
    }
    report.checks[stage] = 'failure';
    report.outcome = ['source', 'proposal', 'trigger'].includes(stage) ? 'blocked' : 'failed';
    report.errors.push(`${stage}: maintenance stopped without publishing a patch`);
    report.proposal = null;
  } finally {
    if (scratch) {
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
        report.checks.cleanup = 'success';
      } catch {
        report.checks.cleanup = 'failure';
        report.errors.push('cleanup: temporary checkout could not be removed');
        report.outcome = 'failed';
        report.passed = false;
        report.proposal = null;
      }
    }
  }
  if (metadata.trigger && report.passed) {
    try {
      signal?.throwIfAborted();
      await verifyDocumentationRemediation(revision, env, event, client);
      signal?.throwIfAborted();
    } catch {
      report.checks.trigger = 'failure';
      report.outcome = 'blocked';
      report.passed = false;
      report.cancelled = signal?.aborted === true;
      report.proposal = null;
      report.errors.push('trigger: source freshness could not be verified; no patch retained');
    }
  }
  if (metadata.trigger) {
    report.remediation.status = !report.passed
      ? 'blocked'
      : report.outcome === 'proposed'
        ? 'proposed'
        : 'not-applicable';
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  if (output) {
    try {
      for (const [file, bytes] of documentationEvidence) {
        fs.writeFileSync(path.join(output, file), bytes, { flag: 'wx' });
      }
      if (report.passed && report.outcome === 'proposed') {
        fs.writeFileSync(path.join(output, 'proposal.pending'), patch, { flag: 'wx' });
      }
      fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
        flag: 'wx',
      });
      if (report.passed && report.outcome === 'proposed') {
        fs.renameSync(path.join(output, 'proposal.pending'), path.join(output, 'proposal.patch'));
      }
    } catch {
      fs.rmSync(output, { recursive: true, force: true });
      output = null;
      report.outcome = 'failed';
      report.passed = false;
      report.proposal = null;
      if (metadata.trigger) report.remediation.status = 'blocked';
      report.errors.push('publication: no complete report and patch could be retained');
    }
  }
  return {
    report,
    outputDirectory: output ? path.relative(root, output).split(path.sep).join('/') : null,
  };
}

export function collectMaintenanceEvidence(root, { revision, env, event, steps, reportPath }) {
  const metadata = maintenanceIdentity(revision, env, event);
  if (metadata.eventName === 'local')
    throw new Error('Workflow evidence requires GitHub provenance');
  if (metadata.trigger)
    throw new Error('Remediation is not scheduled or manual maintenance evidence');
  const required = ['context', 'install', 'build', 'tests', 'audit', 'docs', 'proof'];
  const errors = required
    .filter((name) => steps?.[name]?.outcome !== 'success')
    .map((name) => `${name}: required command did not succeed`);
  const evidenceSha256 = {};
  const readJson = (file) => {
    const bytes = readDocument(root, file);
    evidenceSha256[file] = digest(bytes);
    return JSON.parse(bytes.toString());
  };
  let documentation = null;
  let vulnerabilities = null;
  let proof = null;
  let proposalPath = null;
  try {
    if (!/^test-results\/maintenance\/run-[A-Za-z0-9]+\/report\.json$/.test(reportPath ?? '')) {
      throw new Error('Unexpected maintenance report path');
    }
    const report = readJson(reportPath);
    if (
      report.schemaVersion !== 1 ||
      report.kind !== 'documentation-maintenance' ||
      !Object.entries(metadata).every(([key, value]) => report[key] === value) ||
      report.passed !== true ||
      report.cancelled !== false ||
      !['no-op', 'proposed'].includes(report.outcome) ||
      !Array.isArray(report.errors) ||
      report.errors.length !== 0 ||
      !['source', 'generation', 'validation', 'idempotence', 'proposal', 'cleanup'].every(
        (name) => report.checks?.[name] === 'success',
      ) ||
      !/^[a-f0-9]{64}$/.test(report.generatorSha256 ?? '') ||
      !Number.isInteger(report.durationMs) ||
      report.durationMs < 0 ||
      Date.parse(report.finishedAt) - Date.parse(report.startedAt) !== report.durationMs ||
      !Array.isArray(report.residual) ||
      report.residual.length === 0
    ) {
      throw new Error('Invalid maintenance report');
    }
    const proposal = report.proposal;
    if (
      !proposal ||
      !Array.isArray(proposal.files) ||
      proposal.files.length > MAINTENANCE_LIMITS.files ||
      new Set(proposal.files.map((file) => file?.path)).size !== proposal.files.length ||
      !proposal.files.every(
        (file) =>
          DOC_CONTRACTS.includes(file?.path) &&
          /^[a-f0-9]{64}$/.test(file.beforeSha256 ?? '') &&
          /^[a-f0-9]{64}$/.test(file.afterSha256 ?? '') &&
          Number.isInteger(file.added) &&
          file.added >= 0 &&
          Number.isInteger(file.deleted) &&
          file.deleted >= 0 &&
          file.added + file.deleted > 0,
      ) ||
      proposal.changedLines !==
        proposal.files.reduce((total, file) => total + file.added + file.deleted, 0) ||
      proposal.changedLines > MAINTENANCE_LIMITS.changedLines ||
      !Number.isInteger(proposal.patchBytes) ||
      proposal.patchBytes < 0 ||
      proposal.patchBytes > MAINTENANCE_LIMITS.patchBytes
    )
      throw new Error('Invalid proposal metadata');
    const candidatePath = reportPath.replace(/report\.json$/, 'proposal.patch');
    if (report.outcome === 'proposed') {
      const patch = readDocument(root, candidatePath);
      if (
        proposal.files.length === 0 ||
        patch.length === 0 ||
        patch.length !== proposal.patchBytes ||
        digest(patch) !== proposal.patchSha256
      ) {
        throw new Error('Proposal does not match its report');
      }
      proposalPath = candidatePath;
    } else if (
      proposal.files.length !== 0 ||
      proposal.patchBytes !== 0 ||
      proposal.patchSha256 !== digest(Buffer.alloc(0)) ||
      fs.existsSync(path.join(root, candidatePath))
    ) {
      throw new Error('Unexpected patch for a no-op');
    }
    documentation = {
      outcome: report.outcome,
      durationMs: report.durationMs,
      generatorSha256: report.generatorSha256,
      proposal,
      residual: report.residual,
    };
  } catch {
    errors.push('documentation: missing, malformed, mismatched, or unsuccessful evidence');
    proposalPath = null;
  }
  try {
    vulnerabilities = readJson('test-results/maintenance-audit.json').metadata?.vulnerabilities;
    if (
      !vulnerabilities ||
      !['info', 'low', 'moderate', 'high', 'critical', 'total'].every(
        (name) => Number.isInteger(vulnerabilities[name]) && vulnerabilities[name] >= 0,
      ) ||
      ['moderate', 'high', 'critical'].some((name) => vulnerabilities[name] !== 0) ||
      vulnerabilities.total !==
        ['info', 'low', 'moderate', 'high', 'critical'].reduce(
          (total, name) => total + vulnerabilities[name],
          0,
        )
    ) {
      throw new Error('Dependency audit did not pass');
    }
  } catch {
    vulnerabilities = null;
    errors.push('audit: missing, malformed, or moderate-or-higher advisories');
  }
  try {
    proof = validateProofReport(readJson('test-results/maintenance-proof.json'));
  } catch {
    errors.push('proof: missing, malformed, or unsuccessful five-sample proof');
  }
  return {
    schemaVersion: 1,
    kind: 'maintenance-validation',
    ...metadata,
    passed: errors.length === 0,
    evidenceSha256,
    steps: Object.fromEntries(required.map((name) => [name, steps?.[name]?.outcome ?? 'missing'])),
    documentation,
    vulnerabilities,
    proof,
    proposalPath: errors.length === 0 ? proposalPath : null,
    agentReview: { enabled: env.SLIPSTREAM_AGENT_REVIEW_ENABLED === 'true' },
    errors,
  };
}

function workflowOutput(name, value) {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_OUTPUT && value) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const event =
    process.env.GITHUB_ACTIONS === 'true'
      ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
      : {};
  if (args.length === 1 && args[0] === '--verify') {
    const report = collectMaintenanceEvidence(ROOT, {
      revision: process.env.GITHUB_SHA,
      env: process.env,
      event,
      steps: JSON.parse(process.env.CI_STEPS ?? '{}'),
      reportPath: process.env.MAINTENANCE_REPORT,
    });
    const output = outputDirectory(ROOT);
    fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
    workflowOutput('proposal_path', report.proposalPath);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          `## Maintenance ${report.passed ? 'Passed' : 'Failed'}`,
          '',
          `Revision: ${report.revision}`,
          `Run: ${report.runId}, attempt ${report.attempt}`,
          `Documentation: ${report.documentation?.outcome ?? 'unverified'}`,
          '',
          '| Check | Outcome |',
          '| --- | --- |',
          ...Object.entries(report.steps).map(([name, outcome]) => `| ${name} | ${outcome} |`),
          '',
          ...report.errors.map((error) => `- ${error}`),
          '',
          'Patch artifacts require a human-created PR, required checks, and manual review.',
          '',
        ].join('\n'),
      );
    }
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
    return;
  }
  if (args.length !== 2 || args[0] !== '--revision') {
    throw new Error('Usage: maintenance.mjs --revision <40-character-commit> | --verify');
  }
  let client;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    maintenanceIdentity(args[1], process.env, event);
    const { createImprovementClient } = await import('./check-improvement.mjs');
    client = createImprovementClient(
      process.env.GITHUB_REPOSITORY,
      process.env.SLIPSTREAM_DOCS_REMEDIATION_TOKEN,
    );
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  let result;
  try {
    result = await runDocumentationMaintenance(ROOT, {
      revision: args[1],
      event,
      signal: controller.signal,
      client,
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
  workflowOutput(
    'report_path',
    result.outputDirectory ? `${result.outputDirectory}/report.json` : null,
  );
  if (result.report.trigger) {
    workflowOutput(
      'proposal_path',
      result.report.passed && result.report.outcome === 'proposed' && result.outputDirectory
        ? `${result.outputDirectory}/proposal.patch`
        : null,
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          '## Documentation Remediation',
          '',
          `Revision: ${result.report.revision}`,
          `Source CI run: ${result.report.trigger.runId}, attempt ${result.report.trigger.attempt}`,
          `Source verification: ${result.report.checks.trigger ?? 'unverified'}`,
          `Documentation: ${result.report.remediation.status}`,
          '',
          'CI cause and resolution remain unverified. No commit, push, merge, retry, or agent review was performed.',
          'Any patch requires a human-created PR, full required CI and Security checks, and manual approval.',
          '',
        ].join('\n'),
      );
    }
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.report.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      'Maintenance could not complete; check source identity, arguments, and output access.',
    );
    process.exitCode = 1;
  });
}
