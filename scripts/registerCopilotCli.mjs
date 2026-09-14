#!/usr/bin/env node
/**
 * Install the Slipstream Copilot CLI plugin from this working tree.
 *
 * Copilot CLI 1.0.x does not accept a local directory in `plugin install`,
 * despite newer documentation listing that form. A local marketplace provides
 * the same persistent installation while keeping the plugin source live.
 *
 * Usage:
 *   node scripts/registerCopilotCli.mjs [--print]
 *
 * After a successful install this optionally enables local model tracking
 * (opt-in; see docs/pricing.md). Control it non-interactively with
 * `--enable-model-tracking` / `--skip-model-tracking`, or the
 * `SLIPSTREAM_MODEL_TRACKING=1|0` environment variable. In an interactive
 * terminal with neither set, it prompts and defaults to off.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pluginEntry = path.join(repoRoot, 'packages', 'copilot-plugin', 'dist', 'hook.js');
const marketplaceManifest = path.join(repoRoot, '.github', 'plugin', 'marketplace.json');
const marketplaceName = 'slipstream-local';
const pluginSpec = `slipstream@${marketplaceName}`;
const printOnly = process.argv.slice(2).includes('--print');

for (const requiredPath of [pluginEntry, marketplaceManifest]) {
  if (!fs.existsSync(requiredPath)) {
    console.error(`Required plugin file is missing: ${requiredPath}`);
    console.error('Run `npm run package:copilot-plugin` first.');
    process.exit(1);
  }
}

const commands = [
  ['plugin', 'marketplace', 'add', repoRoot],
  ['plugin', 'install', pluginSpec],
];

if (printOnly) {
  for (const args of commands) {
    console.log(`copilot ${args.map(quoteArg).join(' ')}`);
  }
  process.exit(0);
}

const marketplaces = runCopilot(['plugin', 'marketplace', 'list'], true);
if (!new RegExp(`\\b${escapeRegExp(marketplaceName)}\\b`).test(marketplaces.stdout)) {
  runCopilot(commands[0]);
}
runCopilot(commands[1]);

console.log('\nInstalled the Slipstream Copilot CLI plugin.');
console.log('Verify with: copilot plugin list');
console.log('Start Copilot normally; no API key or excluded-tools flag is required.');

await maybeEnableModelTracking();

/**
 * Optionally opt in to local Copilot model tracking after install.
 *
 * Enabling records consent to receive local OpenTelemetry that may contain
 * prompt/tool content (discarded in memory; only model/timing/usage metadata is
 * kept). The default is off: it only enables when explicitly requested by a flag
 * or environment variable, or when a user answers yes to the interactive prompt.
 */
async function maybeEnableModelTracking() {
  const args = process.argv.slice(2);
  const forced = args.includes('--enable-model-tracking') || process.env.SLIPSTREAM_MODEL_TRACKING === '1';
  const skipped = args.includes('--skip-model-tracking') || process.env.SLIPSTREAM_MODEL_TRACKING === '0';

  let enable = forced;
  if (!forced && !skipped && process.stdin.isTTY && process.stdout.isTTY) {
    enable = await promptYesNo('\nEnable local Copilot model tracking? Opt-in, localhost-only. [y/N] ');
  }

  if (!enable) {
    console.log('\nModel tracking left off: Copilot CLI model and token usage will');
    console.log('not appear in the dashboard. Enable it later with:');
    console.log(`  node ${pluginEntry} model-tracking enable`);
    return;
  }

  console.log('\nEnabling local model tracking...');
  const result = spawnSync(process.execPath, [pluginEntry, 'model-tracking', 'enable'], { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('\nCould not enable model tracking automatically. Run it manually:');
    console.error(`  node ${pluginEntry} model-tracking enable`);
    return;
  }

  console.log('\nAfter starting Copilot once, print the exporter variables for your shell:');
  console.log(`  node ${pluginEntry} model-tracking env             # bash/zsh`);
  console.log(`  node ${pluginEntry} model-tracking env powershell`);
  console.log('Add them to the shell profile that launches Copilot.');
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function runCopilot(args, capture = false) {
  const result = spawnSync(`copilot ${args.map(quoteArg).join(' ')}`, {
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? 'pipe' : 'inherit',
    shell: true,
  });

  if (result.error) {
    console.error(`Could not run the Copilot CLI: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
}

function quoteArg(value) {
  if (value.includes('"')) {
    throw new Error(`Refusing to pass an argument containing a double quote: ${value}`);
  }
  return /\s/.test(value) ? `"${value}"` : value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
