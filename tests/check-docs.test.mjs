import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkDocs } from '../scripts/check-docs.mjs';
import { DOC_CONTRACTS } from '../scripts/check-ci.mjs';

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-docs-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const workspaces = ['core', 'hook-runtime', 'mcp-server', 'copilot-plugin', 'extension'];
  write('package.json', {
    engines: { node: '>=20' },
    workspaces: workspaces.map((name) => `packages/${name}`),
    scripts: {
      build: 'npm run build --workspaces',
      test: 'node --test',
      'docs:write': 'node scripts/check-docs.mjs --write',
      'check:docs': 'node scripts/check-docs.mjs',
    },
  });
  for (const name of workspaces)
    write(`packages/${name}/package.json`, { name, scripts: { build: 'build' } });
  const extension = {
    name: 'extension',
    contributes: {
      commands: [{ command: 'slipstream.start', title: 'Start' }],
      languageModelTools: [
        {
          name: 'slipstream_readFile',
          inputSchema: { required: ['path'], properties: { path: { type: 'string' } } },
        },
      ],
      configuration: { properties: { 'slipstream.enabled': { type: 'boolean', default: true } } },
    },
  };
  write('packages/extension/package.json', extension);
  write('server.json', {
    name: 'local.slipstream/slipstream',
    _meta: {
      'io.modelcontextprotocol.registry/publisher-provided': {
        distribution: 'local-source-only',
        localInstall: {
          command: 'node',
          args: ['server.js'],
          modes: { standalone: { additionalArgs: [], tools: ['read_file'] } },
        },
      },
    },
  });
  write('packages/copilot-plugin/.mcp.json', {
    mcpServers: { slipstream: { command: 'node', args: ['server.js'] } },
  });
  write('.node-version', '24.14.1\n');
  write('docs/architecture.md', '# Architecture\n');
  write('docs/mcp.md', '# MCP\n');
  write('packages/extension/README.md', '# Extension\n');
  write('README.md', '# Project\n\n[Architecture](docs/architecture.md#architecture)\n');
  return { root, write, extension };
}

function gitFixture(root) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'Documentation Test']);
  git(['config', 'user.email', 'docs@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  git(['add', '.']);
  git(['commit', '-m', 'Base documentation']);
  return git;
}

test('generation is repeatable and check mode does not modify documents', (context) => {
  const { root } = fixture(context);
  const file = path.join(root, 'docs/architecture.md');
  const original = fs.readFileSync(file);
  assert.equal(checkDocs(root).passed, false);
  assert.deepEqual(fs.readFileSync(file), original);
  const generated = checkDocs(root, { write: true });
  assert.equal(generated.passed, true, JSON.stringify(generated.errors));
  assert.deepEqual([...generated.contracts].sort(), [...DOC_CONTRACTS].sort());
  assert.deepEqual([...generated.written].sort(), [...DOC_CONTRACTS].sort());
  const modified = fs.statSync(file).mtimeMs;
  assert.deepEqual(checkDocs(root, { write: true }).written, []);
  assert.equal(checkDocs(root).passed, true);
  assert.equal(fs.statSync(file).mtimeMs, modified);
});

test('changed defaults and nested tool schemas fail until references are updated', (context) => {
  const { root, write, extension } = fixture(context);
  checkDocs(root, { write: true });
  extension.contributes.configuration.properties['slipstream.enabled'].default = false;
  extension.contributes.languageModelTools[0].inputSchema.properties.path.minLength = 1;
  write('packages/extension/package.json', extension);
  assert.match(checkDocs(root).errors.join('\n'), /generated manifest reference is stale/);
  assert.equal(checkDocs(root, { write: true }).passed, true);
  assert.equal(checkDocs(root).passed, true);
});

test('removed commands and unmapped workspaces cannot silently escape coverage', (context) => {
  const { root, write, extension } = fixture(context);
  checkDocs(root, { write: true });
  extension.contributes.commands = [];
  write('packages/extension/package.json', extension);
  assert.equal(checkDocs(root).passed, false);
  write('package.json', { engines: { node: '>=20' }, workspaces: ['packages/new'], scripts: {} });
  assert.match(checkDocs(root).errors.join('\n'), /Workspace contract mapping changed/);
});

test('broken files, anchors and escaping paths are reported without reading outside the root', (context) => {
  const { root, write } = fixture(context);
  checkDocs(root, { write: true });
  write(
    'docs/links.md',
    '# Links\n[missing](missing.md)\n[heading](mcp.md#absent)\n[outside](../../private.md)\n',
  );
  const result = checkDocs(root);
  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors.join('\n'), /outside the repository/);
});

test('all maintained markdown is scanned while generated and installed content is excluded', (context) => {
  const { root, write } = fixture(context);
  checkDocs(root, { write: true });
  write('.github/copilot-instructions.md', '# Instructions\n[wrong](../absent.md)\n');
  write('packages/copilot-plugin/README.md', '# Plugin\n[wrong](absent.md)\n');
  write('llms.txt', '# Agent index\n[wrong](absent.md)\n');
  write('node_modules/third-party/README.md', '[bad](missing.md)');
  write('.agents/skills/codeblend-ai-composite/SKILL.md', '[bad](missing.md)');
  write('test-results/report.md', '[bad](missing.md)');
  const result = checkDocs(root);
  assert.equal(result.errors.length, 3);
  assert.equal(result.coverage.markdownFiles, 7);
  assert.ok(result.errors.some((error) => error.startsWith('llms.txt:')));
});

test('removed npm scripts fail documentation checks outside generated reference documents', (context) => {
  const { root, write } = fixture(context);
  checkDocs(root, { write: true });
  write('packages/core/USAGE.md', '# Usage\n\n```sh\nnpm run removed-command\n```\n');
  const result = checkDocs(root);
  assert.equal(result.passed, false);
  assert.match(result.errors.join('\n'), /unknown npm script.*removed-command/i);
  assert.ok(result.errors.some((error) => error.startsWith('packages/core/USAGE.md:')));
});

test('static npm examples resolve workspaces and directories without running scripts', (context) => {
  const { root, write } = fixture(context);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  manifest.scripts['docs-probe'] =
    "node -e \"require('node:fs').writeFileSync('executed.txt', 'unexpected')\"";
  write('package.json', manifest);
  const baseline = checkDocs(root, { write: true });
  assert.equal(baseline.passed, true);
  write(
    'packages/core/USAGE.md',
    [
      '# Usage',
      '```sh',
      'npm run test',
      'npm --workspace core run build',
      'npm run build --workspace=./packages/core',
      'npm run build -w packages/core/',
      'npm run build --workspace core --workspace=mcp-server',
      'npm --prefix packages/core run-script build',
      'npm run build --workspaces --if-present',
      'npm run test --workspaces --include-workspace-root --if-present',
      'npm run test -- --workspace=absent --prefix=../outside',
      'npm run docs-probe',
      'cd packages/core',
      'npm run build',
      'cd ../mcp-server && npm run build',
      'cd ../..',
      'npm run test',
      '```',
    ].join('\n'),
  );
  const report = checkDocs(root);
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.equal(report.coverage.npmCommands - baseline.coverage.npmCommands, 13);
  assert.deepEqual(report.manualExamples, []);
  assert.equal(fs.existsSync(path.join(root, 'executed.txt')), false);
});

test('npm examples reject missing workspace scripts and retain unsupported syntax for review', (context) => {
  const { root, write } = fixture(context);
  checkDocs(root, { write: true });
  for (const [command, error] of [
    ['npm run build -w removed', /unknown npm workspace/],
    ['npm --prefix packages/core run removed', /unknown npm script/],
    ['cd packages/core\nnpm run test', /unknown npm script/],
    ['npm run test -w core', /unknown npm script/],
    ['npm run build --workspaces', /unknown npm script/],
    ['npm --prefix packages/core run build --workspaces --if-present', /no npm workspaces/],
  ]) {
    write('docs/commands.md', `# Commands\n\n\`\`\`sh\n${command}\n\`\`\`\n`);
    const report = checkDocs(root);
    assert.equal(report.passed, false, command);
    assert.match(report.errors.join('\n'), error, command);
  }
  for (const command of [
    'npm run $SCRIPT',
    'npm run $(select-script)',
    'npm run build --workspace packages/*',
    'npm run removed --filter=core',
    'npm run removed --if-present=false',
    'cd ../outside\nnpm run build',
    'cd packages\ncd /core\nnpm run build',
    'cd packages\nnpm --prefix /core run build',
  ]) {
    write('docs/commands.md', `# Commands\n\n\`\`\`sh\n${command}\n\`\`\`\n`);
    const report = checkDocs(root);
    assert.equal(report.passed, true, JSON.stringify(report.errors));
    assert.equal(report.manualExamples.length, 1, command);
    assert.equal(report.manualExamples[0].file, 'docs/commands.md');
  }
});

test('PR documentation inventory covers new formats and unchanged links to deleted files', (context) => {
  const { root, write } = fixture(context);
  write('guide.txt', 'A linked guide.\n');
  write('README.md', '# Project\n\n[Guide](guide.txt)\n');
  assert.equal(checkDocs(root, { write: true }).passed, true);
  const git = gitFixture(root);
  const baseRevision = git(['rev-parse', 'HEAD']);
  git(['checkout', '-b', 'documentation-change']);
  write('packages/core/USAGE.markdown', '# Usage\n\n```sh\nnpm run removed-command\n```\n');
  fs.rmSync(path.join(root, 'guide.txt'));
  git(['add', '--all']);
  git(['commit', '-m', 'Change documentation dependencies']);
  const headRevision = git(['rev-parse', 'HEAD']);
  git(['checkout', 'main']);
  git(['merge', '--no-ff', '--no-edit', 'documentation-change']);
  const revision = git(['rev-parse', 'HEAD']);
  const metadata = {
    revision,
    runId: '123',
    attempt: '1',
    eventName: 'pull_request',
    workflow: 'example/repo/.github/workflows/ci.yml@refs/pull/1/merge',
    headRevision,
    baseRevision,
  };
  const before = git(['status', '--porcelain']);
  const report = checkDocs(root, { context: metadata });
  assert.equal(report.passed, false);
  assert.ok(
    report.errors.some((error) => error.startsWith('README.md:')),
    JSON.stringify(report.errors),
  );
  assert.ok(report.errors.some((error) => error.startsWith('packages/core/USAGE.markdown:')));
  assert.equal(report.scope.kind, 'repository-wide');
  assert.ok(report.scope.files.includes('packages/core/USAGE.markdown'));
  assert.deepEqual(report.scope.context.changes, [
    { status: 'D', path: 'guide.txt' },
    { status: 'A', path: 'packages/core/USAGE.markdown' },
  ]);
  assert.equal(report.scope.context.comparedBase, baseRevision);
  assert.equal(report.scope.context.revision, revision);
  assert.equal(report.scope.context.headRevision, headRevision);
  assert.equal(git(['status', '--porcelain']), before);
  assert.deepEqual(report.written, []);
});

test('Git documentation context rejects dirty, shallow, and mismatched checkouts', (context) => {
  const { root, write } = fixture(context);
  assert.equal(checkDocs(root, { write: true }).passed, true);
  const git = gitFixture(root);
  const baseRevision = git(['rev-parse', 'HEAD']);
  write('out/USAGE.MARKDOWN', '# Tracked usage\n\n`npm run build`\n');
  git(['add', 'out/USAGE.MARKDOWN']);
  git(['commit', '-m', 'Add tracked usage']);
  const revision = git(['rev-parse', 'HEAD']);
  const metadata = {
    revision,
    runId: '123',
    attempt: '1',
    eventName: 'push',
    workflow: 'example/repo/.github/workflows/ci.yml@refs/heads/main',
    headRevision: revision,
    baseRevision,
  };
  const report = checkDocs(root, { context: metadata });
  assert.equal(report.passed, true, JSON.stringify(report.errors));
  assert.ok(report.scope.files.includes('out/USAGE.MARKDOWN'));
  assert.deepEqual(report.scope.context.changes, [{ status: 'A', path: 'out/USAGE.MARKDOWN' }]);
  for (const initial of [
    { eventName: 'push', baseRevision: '0'.repeat(40) },
    { eventName: 'workflow_dispatch', baseRevision: null },
  ]) {
    const result = checkDocs(root, { context: { ...metadata, ...initial } });
    assert.equal(result.passed, true);
    assert.equal(result.scope.context.comparedBase, null);
    assert.ok(result.scope.context.changes.every((change) => change.status === 'A'));
  }
  for (const invalid of [
    { revision: 'f'.repeat(40) },
    { headRevision: 'f'.repeat(40) },
    { baseRevision: 'f'.repeat(40) },
    { eventName: 'pull_request', baseRevision: null },
    { eventName: 'pull_request' },
    { runId: '' },
    { attempt: '' },
    { workflow: '' },
  ]) {
    const result = checkDocs(root, { context: { ...metadata, ...invalid } });
    assert.equal(result.passed, false, JSON.stringify(invalid));
    assert.equal(result.scope, undefined);
    assert.deepEqual(result.written, []);
  }
  assert.equal(checkDocs(root, { write: true, context: metadata }).passed, false);
  assert.equal(git(['status', '--porcelain']), '');
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-docs-shallow-'));
  context.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
  git(['clone', '--depth=1', '--no-local', pathToFileURL(root).href, shallow]);
  const unavailable = checkDocs(shallow, { context: metadata });
  assert.equal(unavailable.passed, false);
  assert.match(unavailable.errors.join('\n'), /full revision history/);
  write('README.md', '# Uncommitted documentation\n');
  const before = git(['status', '--porcelain']);
  const dirty = checkDocs(root, { context: metadata });
  assert.equal(dirty.passed, false);
  assert.equal(dirty.scope, undefined);
  assert.deepEqual(dirty.written, []);
  assert.equal(git(['status', '--porcelain']), before);
});

test('JSON and cost-policy examples are validated without executing Markdown commands', (context) => {
  const { root, write } = fixture(context);
  checkDocs(root, { write: true });
  write(
    'docs/examples.md',
    '# Examples\n```json\n{"bad":}\n```\n```jsonc\n{"slipstream.costPolicy":{"version":1,"mode":"not-valid"}}\n```\n```sh\nexit 1\n```\n',
  );
  const result = checkDocs(root);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.join('\n'), /invalid json example/);
  assert.match(result.errors.join('\n'), /invalid cost-policy example/);
});

test('malformed reference markers are not overwritten', (context) => {
  const { root, write } = fixture(context);
  const malformed = '# Architecture\n<!-- slipstream-reference:build:start -->\n';
  write('docs/architecture.md', malformed);
  const result = checkDocs(root, { write: true });
  assert.equal(result.passed, false);
  assert.equal(fs.readFileSync(path.join(root, 'docs/architecture.md'), 'utf8'), malformed);
});
