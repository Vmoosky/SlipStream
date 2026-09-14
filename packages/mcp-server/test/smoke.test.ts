import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server.json'), 'utf8'));
const localInstall = manifest._meta['io.modelcontextprotocol.registry/publisher-provided'].localInstall;
const serverPackage = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const serverEntry =
  process.env['SLIPSTREAM_TEST_SERVER_ENTRY'] ?? path.join(here, '..', 'dist', 'index.js');

let client: Client;
let workspace: string;
let storage: string;

function manifestArgs(mode: 'standalone' | 'retrieval-only'): string[] {
  return [
    serverEntry,
    ...localInstall.args.slice(1).map((argument: string) =>
      argument.replaceAll('{repoRoot}', repoRoot).replaceAll('{workspaceRoot}', workspace)),
    ...localInstall.modes[mode].additionalArgs,
    '--storage',
    storage,
  ];
}

/** Text of the first content block of a tool result. */
function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? '').join('\n');
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

beforeAll(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-mcp-ws-'));
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-mcp-store-'));

  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'src', 'app.ts'),
    Array.from({ length: 60 }, (_, i) => `export const value${i} = ${i}; // padding to make this file worth reading`).join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(workspace, '.env'), 'SECRET_TOKEN=hunter2', 'utf8');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: manifestArgs('standalone'),
  });
  client = new Client({ name: 'slipstream-test', version: '0.0.0' });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(storage, { recursive: true, force: true });
});

describe('slipstream MCP server', () => {
  it('validates the manifest against the pinned official schema offline', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/mcp-server-2025-12-11.schema.json'), 'utf8'));
    const validator = new Ajv({ strict: false, allErrors: true });
    addFormats(validator);
    const validate = validator.compile(schema);
    expect(manifest.$schema).toBe(schema.$id);
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, name: 'not-namespaced' })).toBe(false);
    expect(validate({ ...manifest, version: undefined })).toBe(false);
    const metadata = manifest._meta['io.modelcontextprotocol.registry/publisher-provided'];
    expect(metadata.distribution).toBe('local-source-only');
    expect(metadata.identityStatus).toContain('not a verified or published');
    expect(localInstall.node).toBe(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node);
    expect(localInstall.modes['retrieval-only'].additionalArgs).toEqual(['--retrieval-only']);
    expect(localInstall.modes.standalone.additionalArgs).toEqual([]);
    expect(localInstall.setup).toEqual([
      { command: 'npm', args: ['install'] },
      { command: 'npm', args: ['run', 'build'] },
    ]);
  });

  it('resolves all local links in the agent index and MCP guide', () => {
    const metadata = manifest._meta['io.modelcontextprotocol.registry/publisher-provided'];
    for (const document of [metadata.agentIndex, metadata.documentation]) {
      const sourcePath = path.join(repoRoot, document);
      const text = fs.readFileSync(sourcePath, 'utf8');
      const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
      expect(links.length).toBeGreaterThan(0);
      for (const [, link] of links) {
        if (/^https?:\/\//.test(link!)) continue;
        const [relativePath, anchor] = link!.split('#');
        const target = path.resolve(path.dirname(sourcePath), decodeURIComponent(relativePath!));
        const relative = path.relative(repoRoot, target);
        expect(relative.startsWith('..') || path.isAbsolute(relative), link).toBe(false);
        expect(fs.statSync(target).isFile(), link).toBe(true);
        if (anchor) {
          const headings = [...fs.readFileSync(target, 'utf8').matchAll(/^#+ (.+)$/gm)]
            .map((match) => match[1]!.toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-'));
          expect(headings, link).toContain(anchor);
        }
      }
    }
  });

  it('matches the canonical manifest and package version at initialization', () => {
    expect(client.getServerVersion()).toEqual({ name: 'slipstream', version: manifest.version });
    expect(manifest.version).toBe(serverPackage.version);
    expect(serverPackage.private).toBe(true);
    expect(manifest.packages).toBeUndefined();
    expect(manifest.remotes).toBeUndefined();
    expect(localInstall.transport).toBe('stdio');
    expect(localInstall.command).toBe('node');
    expect(localInstall.args[0]).toBe(`{repoRoot}/packages/mcp-server/${serverPackage.bin['slipstream-mcp'].replace(/^\.\//, '')}`);
    const plugin = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages/copilot-plugin/.mcp.json'), 'utf8'));
    expect(plugin.mcpServers.slipstream.args).toContain('--retrieval-only');
  });

  it('advertises the four tools with correct read-only annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['get_savings', 'read_file', 'retrieve_artifact', 'run_command']);
    expect(names).toEqual([...localInstall.modes.standalone.tools].sort());

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // run_command must NOT be read-only, so VS Code asks for confirmation.
    expect(byName.get('run_command')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('read_file')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('retrieve_artifact')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('get_savings')?.annotations?.readOnlyHint).toBe(true);
  });

  it('can expose only retrieval and savings tools for the hook plugin', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: manifestArgs('retrieval-only'),
    });
    const retrievalClient = new Client({ name: 'slipstream-retrieval-test', version: '0.0.0' });
    await retrievalClient.connect(transport);
    try {
      const { tools } = await retrievalClient.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...localInstall.modes['retrieval-only'].tools].sort());
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'get_savings',
        'retrieve_artifact',
      ]);
    } finally {
      await retrievalClient.close();
    }
  });

  it('steers the model toward the compressing tools', async () => {
    const { tools } = await client.listTools();
    const runCommand = tools.find((tool) => tool.name === 'run_command');
    expect(runCommand?.description).toMatch(/PREFER THIS/);
    expect(runCommand?.description).toMatch(/retrieve_artifact/);
  });

  it('runs an allowlisted command and compresses the output', async () => {
    const result = await client.callTool({
      name: 'run_command',
      arguments: {
        command: 'node',
        args: ['-e', 'for (let i = 0; i < 400; i++) console.log("progress line " + i); console.error("Error: boom"); process.exit(1)'],
        cwd: workspace,
      },
    });
    const text = firstText(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain('exit 1');
    expect(text).toContain('Error: boom');
    expect(text).toMatch(/\[\[slipstream:[0-9a-f]{12} L\d+-\d+/);
    expect(text).toMatch(/% saved/);
  });

  it('refuses a command outside the allowlist', async () => {
    const result = await client.callTool({
      name: 'run_command',
      arguments: { command: 'curl', args: ['https://example.com'], cwd: workspace },
    });
    expect(isError(result)).toBe(true);
    expect(firstText(result)).toMatch(/not in the allowed command list/);
  });

  it('refuses to run outside the workspace', async () => {
    const result = await client.callTool({
      name: 'run_command',
      arguments: { command: 'node', args: ['-e', '1'], cwd: os.tmpdir() },
    });
    expect(isError(result)).toBe(true);
    expect(firstText(result)).toMatch(/outside the open workspace/);
  });

  it('reads a workspace file, then omits it on the second read', async () => {
    const target = path.join(workspace, 'src', 'app.ts');
    const first = await client.callTool({ name: 'read_file', arguments: { path: target } });
    expect(firstText(first)).toContain('export const value0');

    const second = await client.callTool({ name: 'read_file', arguments: { path: target } });
    const text = firstText(second);
    expect(text).toContain('unchanged since read #1');
    expect(text).not.toContain('export const value59');
  });

  it('refuses to read secrets and paths outside the workspace', async () => {
    const denied = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(workspace, '.env') },
    });
    expect(isError(denied)).toBe(true);
    expect(firstText(denied)).toMatch(/protected secret/);
    expect(firstText(denied)).not.toContain('hunter2');

    const outside = await client.callTool({
      name: 'read_file',
      arguments: { path: path.join(os.tmpdir(), 'anything.txt') },
    });
    expect(isError(outside)).toBe(true);
    expect(firstText(outside)).toMatch(/outside the open workspace/);
  });

  it('retrieves omitted content byte-for-byte', async () => {
    const run = await client.callTool({
      name: 'run_command',
      arguments: {
        command: 'node',
        args: ['-e', 'for (let i = 0; i < 300; i++) console.log("needle-" + i + " filler filler filler")'],
        cwd: workspace,
      },
    });
    const marker = /\[\[slipstream:([0-9a-f]{12}) L(\d+)-(\d+)/.exec(firstText(run));
    expect(marker).not.toBeNull();

    const retrieved = await client.callTool({
      name: 'retrieve_artifact',
      arguments: {
        id: marker![1],
        startLine: Number(marker![2]),
        endLine: Number(marker![3]),
        maxLines: 5000,
      },
    });
    expect(isError(retrieved)).toBe(false);
    expect(firstText(retrieved)).toContain('needle-150');
  });

  it('supports grep-filtered retrieval', async () => {
    const run = await client.callTool({
      name: 'run_command',
      arguments: {
        command: 'node',
        args: ['-e', 'for (let i = 0; i < 200; i++) console.log("row " + i); console.log("UNIQUE_SENTINEL_VALUE")'],
        cwd: workspace,
      },
    });
    const id = /\[\[slipstream:([0-9a-f]{12})/.exec(firstText(run))?.[1];
    expect(id).toBeDefined();

    const retrieved = await client.callTool({
      name: 'retrieve_artifact',
      arguments: { id, grep: 'UNIQUE_SENTINEL_VALUE' },
    });
    expect(firstText(retrieved)).toContain('UNIQUE_SENTINEL_VALUE');
  });

  it('rejects a malformed artifact id', async () => {
    const result = await client.callTool({
      name: 'retrieve_artifact',
      arguments: { id: '../../../etc/passwd' },
    });
    expect(isError(result)).toBe(true);
    expect(firstText(result)).toMatch(/not a valid artifact id/);
  });

  it('reports session savings', async () => {
    const result = await client.callTool({ name: 'get_savings', arguments: {} });
    const text = firstText(result);
    expect(text).toMatch(/Tokens saved:\s+[\d,]+/);
    expect(text).toMatch(/Retrievals:/);
    expect(text).toContain('run_command');
  });
});
