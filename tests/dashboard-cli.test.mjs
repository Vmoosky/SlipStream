import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboardScript = path.join(repoRoot, 'scripts', 'dashboard.mjs');

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function startDashboard(root, extraEnv = {}) {
  const child = spawn(process.execPath, [dashboardScript], {
    cwd: repoRoot,
    env: {
      ...process.env, PORT: '0', SLIPSTREAM_STORAGE_DIR: path.join(root, 'store'),
      SLIPSTREAM_CONFIG_PATH: path.join(root, 'config.json'), ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      const timer = setTimeout(() => reject(new Error('Dashboard startup timed out')), 15_000);
      child.stderr.on('data', (chunk) => { errors += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('exit', () => { clearTimeout(timer); reject(new Error(errors || 'Dashboard exited before startup')); });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/localhost:\d+\/?/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
    });
    return { child, url };
  } catch (error) {
    await stop(child);
    throw error;
  }
}

test('dashboard management finds the local tracking runtime without launching VS Code', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-manage-'));
  let available = true;
  let probes = 0;
  const runtime = http.createServer((request, response) => {
    probes += 1;
    assert.equal(request.url, '/api/summary');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ modelTracking: available ? { canConnect: false, canDisconnect: true } : null }));
  });
  await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
  const runtimePort = runtime.address().port;
  let running;
  context.after(async () => {
    if (running) await stop(running.child);
    if (runtime.listening) await new Promise((resolve) => runtime.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  running = await startDashboard(root, { SLIPSTREAM_VSCODE_DASHBOARD_PORT: String(runtimePort) });
  const request = (origin = new URL(running.url).origin) => fetch(new URL('/api/model-tracking', running.url), {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ action: 'manage', url: 'https://example.invalid/', args: ['--disable-extensions'] }),
  });
  assert.equal((await request('https://example.invalid')).status, 403);
  assert.equal(probes, 0);
  const opened = await request();
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { dashboardUrl: `http://localhost:${runtimePort}/` });
  assert.equal(probes, 1);
  available = false;
  const failed = await request();
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /tracking runtime is unavailable/);
  await new Promise((resolve) => runtime.close(resolve));
  assert.equal((await request()).status, 500);
});

test('dashboard profiles and fallback rates persist without freezing preset defaults', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-profile-'));
  const configPath = path.join(root, 'config.json');
  const children = [];
  context.after(async () => {
    for (const child of children) await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function start() {
    const dashboard = await startDashboard(root);
    children.push(dashboard.child);
    return dashboard;
  }
  async function update(url, patch) {
    const response = await fetch(new URL('/api/config', url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    assert.equal(response.status, 200);
    return (await response.json()).config;
  }
  const first = await start();
  const initial = await (await fetch(new URL('/api/summary', first.url))).json();
  assert.deepEqual(initial.config.pricing, { mode: 'automatic' });
  assert.equal(initial.config.usdPerMillionTokens, 3);
  assert.equal(initial.pricingSnapshot.inputUsdPerMillion, null);
  assert.equal((await update(first.url, { profile: 'aggressive' })).maxFileLines, 600);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { profile: 'aggressive' });
  await stop(first.child);

  const second = await start();
  const restored = await (await fetch(new URL('/api/summary', second.url))).json();
  assert.equal(restored.config.profile, 'aggressive');
  assert.equal(restored.config.maxFileLines, 600);
  assert.equal((await update(second.url, { profile: 'balanced' })).maxFileLines, 1200);
  await update(second.url, { maxFileLines: 850 });
  assert.equal((await update(second.url, { profile: 'conservative' })).maxFileLines, 850);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), { profile: 'conservative', maxFileLines: 850 });
  await stop(second.child);

  const third = await start();
  assert.equal((await update(third.url, { profile: 'aggressive' })).maxFileLines, 850);
  fs.writeFileSync(path.join(root, 'store', 'pricing-cache.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), revision: 'fixture', models: [
    { providerId: 'vendor', providerName: 'Vendor', modelId: 'model', modelName: 'Model', input: 5 },
  ] }));
  const pricing = { mode: 'catalog', providerId: 'vendor', modelId: 'model', inputRateOverride: null };
  const legacyEdit = await fetch(new URL('/api/config', third.url), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pricing }),
  });
  assert.equal(legacyEdit.status, 400);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.pricing, undefined);
  assert.equal(saved.pricingSnapshot, undefined);
  await stop(third.child);
  fs.writeFileSync(configPath, JSON.stringify({ ...saved, pricing, usdPerMillionTokens: 99 }));
  const fourth = await start();
  const pricingSummary = await (await fetch(new URL('/api/summary', fourth.url))).json();
  assert.deepEqual(pricingSummary.config.pricing, { mode: 'automatic' });
  assert.equal(pricingSummary.pricingSnapshot.inputUsdPerMillion, null);
  assert.equal(pricingSummary.config.usdPerMillionTokens, 99);
  await update(fourth.url, { profile: 'balanced' });
  const cleaned = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(cleaned.pricing, undefined);
  assert.equal(cleaned.usdPerMillionTokens, 99);
  await update(fourth.url, { usdPerMillionTokens: 0 });
  await stop(fourth.child);
  const fifth = await start();
  const restarted = await (await fetch(new URL('/api/summary', fifth.url))).json();
  assert.equal(restarted.config.usdPerMillionTokens, 0);
  assert.deepEqual(restarted.config.pricing, { mode: 'automatic' });
});

function runDashboard(args, storage) {
  return spawnSync(process.execPath, [dashboardScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, SLIPSTREAM_STORAGE_DIR: storage },
    encoding: 'utf8',
  });
}

test('dashboard --clear removes the configured store and exits', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-clear-'));
  fs.mkdirSync(path.join(storage, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(storage, 'savings.jsonl'), '{}\n');

  const result = runDashboard(['--clear'], storage);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cleared /);
  assert.equal(fs.existsSync(storage), false);
});

test('dashboard --fresh --clear also clears the configured store once', () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-fresh-'));
  fs.writeFileSync(path.join(storage, 'index.json'), '{"entries":[]}');

  const result = runDashboard(['--fresh', '--clear'], storage);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/cleared /g)?.length, 1);
  assert.equal(fs.existsSync(storage), false);
});

test('removed demo and unknown flags cannot clear an existing store', (context) => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cli-unsupported-'));
  context.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const ledger = path.join(storage, 'savings.jsonl');
  fs.writeFileSync(ledger, '{}\n');

  for (const args of [['--demo', '--clear'], ['--demo', '--fresh'], ['--unknown', '--clear']]) {
    const result = runDashboard(args, storage);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Usage:/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), '{}\n');
  }
});