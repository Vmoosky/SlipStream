// Starts the Slipstream dashboard on a local URL.
//
//   node scripts/dashboard.mjs           serve whatever is already in the store
//   node scripts/dashboard.mjs --fresh   clear the store before serving
//   node scripts/dashboard.mjs --clear   clear the store and exit
//
// Useful without VS Code: point a browser at the printed URL.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((argument) => !['--fresh', '--clear'].includes(argument))) {
  process.stderr.write('Usage: node scripts/dashboard.mjs [--fresh] [--clear]\n');
  process.exit(2);
}
const fresh = process.argv.includes('--fresh');
const clear = process.argv.includes('--clear');
const storage = process.env.SLIPSTREAM_STORAGE_DIR
  ? path.resolve(process.env.SLIPSTREAM_STORAGE_DIR)
  : path.resolve(process.env.SLIPSTREAM_HOME ?? path.join(os.homedir(), '.slipstream'));
const configPath = process.env.SLIPSTREAM_CONFIG_PATH
  ? path.resolve(process.env.SLIPSTREAM_CONFIG_PATH)
  : path.join(repoRoot, '.slipstream.config.json');

const configurableKeys = [
  'profile',
  'enabled',
  'compressLogs',
  'readLifecycle',
  'crossTurnDedup',
  'maxFileLines',
  'usdPerMillionTokens',
  'artifactIdleTtlMinutes',
  'artifactMaxEntries',
  'artifactMaxTotalMiB',
];

function pickConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const config = {};
  for (const key of configurableKeys) {
    if (raw[key] !== undefined) config[key] = raw[key];
  }
  return config;
}

function readDashboardConfig() {
  try {
    return pickConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    return {};
  }
}

function writeDashboardConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(pickConfig(config), null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

if (fresh || clear) {
  fs.rmSync(storage, { recursive: true, force: true });
  process.stdout.write(`cleared ${storage}\n`);
}

if (clear) {
  process.exit(0);
}

const { CompressionEngine, startDashboardServer } = await import(
  '../packages/core/dist/index.js'
);

const engine = new CompressionEngine({
  rootDir: storage,
  workspaceRoots: [repoRoot],
  config: { ...readDashboardConfig(), pricing: { mode: 'automatic' } },
});

const port = Number(process.env.PORT ?? 7331);
const server = await startDashboardServer(engine, {
  port,
  onConfigChanged: (_config, overrides) => writeDashboardConfig(overrides),
  onManageModelTracking: async () => {
    try {
      const runtimePort = Number(process.env.SLIPSTREAM_VSCODE_DASHBOARD_PORT ?? 7331);
      if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) {
        throw new Error('Invalid VS Code dashboard port.');
      }
      const dashboardUrl = new URL(`http://localhost:${runtimePort}/`);
      const response = await fetch(new URL('api/summary', dashboardUrl), { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const data = await response.json();
      if (!response.ok || typeof data.modelTracking?.canConnect !== 'boolean' || typeof data.modelTracking?.canDisconnect !== 'boolean') {
        throw new Error('No model tracking controller at this address.');
      }
      return dashboardUrl.href;
    } catch {
      throw new Error('The VS Code tracking runtime is unavailable. Enable the Slipstream dashboard server in VS Code.');
    }
  },
});
const summary = engine.summary();

process.stdout.write(
  `\nSlipstream dashboard\n  ${server.url}\n\n` +
    `  ${summary.compressions} compression(s), ` +
    `${summary.tokensSaved.toLocaleString()} tokens saved ` +
    `(${summary.percentSaved.toFixed(1)}%)\n\n` +
    `Reachable only from this machine.\n` +
    `Press Ctrl+C to stop.\n`,
);

// startDashboardServer unrefs the listener so it never blocks a short-lived
// process; this script is meant to stay up, so hold the loop open explicitly.
const keepAlive = setInterval(() => {}, 1 << 30);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(keepAlive);
    engine.dispose();
    void server.close().then(() => process.exit(0));
  });
}
