import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

test('plugin declares hooks and the retrieval MCP server', () => {
  const plugin = readJson('plugin.json');
  const hooks = readJson('hooks.json');
  const mcp = readJson('.mcp.json');

  assert.equal(plugin.name, 'slipstream');
  assert.equal(plugin.hooks, 'hooks.json');
  assert.equal(plugin.mcpServers, '.mcp.json');
  assert.equal(hooks.version, 1);
  assert.match(
    hooks.hooks.userPromptSubmitted[0].powershell,
    /^node "\$\{PLUGIN_ROOT\}\/dist\/hook\.js" user-prompt-submitted$/,
  );
  assert.match(
    hooks.hooks.postToolUse[0].bash,
    /^node "\$\{PLUGIN_ROOT\}\/dist\/hook\.js" post-tool-use$/,
  );
  assert.match(
    hooks.hooks.postToolUse[0].powershell,
    /^node "\$\{PLUGIN_ROOT\}\/dist\/hook\.js" post-tool-use$/,
  );
  assert.deepEqual(Object.keys(mcp.mcpServers), ['slipstream']);
  assert.ok(mcp.mcpServers.slipstream.args.includes('--retrieval-only'));
});

test('built plugin contains standalone hook and MCP entry points', () => {
  for (const entryPoint of ['hook.js', 'mcp-server.js']) {
    const entryPath = path.join(root, 'dist', entryPoint);
    assert.ok(fs.existsSync(entryPath));
    const syntaxCheck = spawnSync(process.execPath, ['--check', entryPath], {
      encoding: 'utf8',
    });
    assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
  }
});
