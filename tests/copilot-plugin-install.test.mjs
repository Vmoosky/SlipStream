import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Copilot plugin installer prints the persistent local marketplace workflow', () => {
  const result = spawnSync(process.execPath, ['scripts/registerCopilotCli.mjs', '--print'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /copilot plugin marketplace add /);
  assert.match(result.stdout, /copilot plugin install slipstream@slipstream-local/);
  assert.doesNotMatch(result.stdout, /excluded-tools|mcp add/);
});
