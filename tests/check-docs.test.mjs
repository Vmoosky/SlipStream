import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
    scripts: { build: 'npm run build --workspaces', test: 'node --test' },
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
