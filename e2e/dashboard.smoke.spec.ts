import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { CompressionEngine } from '../packages/core/src/engine.js';
import { BENCHMARK_REFERENCE } from '../packages/core/src/benchmarkReference.js';
import { validateCostPolicy } from '../packages/core/src/costPolicy.js';
import { recommendPolicyModel, type PolicyCandidate } from '../packages/core/src/ownedPolicy.js';
import { OwnedTaskUsage, recordTaskOutcome, taskWorkspaceKey } from '../packages/core/src/taskUsage.js';
import { resolvePricing } from '../packages/core/src/pricing.js';
import { parseMarkers } from '../packages/core/src/markers.js';
import { startDashboardServer, type DashboardServerHandle } from '../packages/core/src/dashboardServer.js';
import { jestFailureLog, sourceFile } from '../packages/core/test/fixtures.js';
import { createChatHookConfig } from '../packages/extension/src/chatHooks.js';
import { recordModelObservation, recordToolObservation, startModelTelemetryReceiver } from '../packages/extension/src/modelTelemetry.js';
import { buildSummaryPayload, type DashboardModelTrackingStatus } from '../packages/core/src/dashboard.js';

test('standalone model tracking reaches the connected runtime in the same tab', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-model-tracking-manage-'));
  const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
  const runtime = await startDashboardServer(engine, { port: 0, modelTracking: {
    status: () => ({ state: 'connected', detail: 'Local receiver ready.', canConnect: false, canDisconnect: true }),
    connect: async () => undefined,
    disconnect: async () => undefined,
  } });
  let launches = 0;
  let launchFails = true;
  let finishLaunch: (() => void) | undefined;
  const server = await startDashboardServer(engine, { port: 0, onManageModelTracking: async () => {
    launches += 1;
    if (launchFails) throw new Error('Runtime unavailable');
    await new Promise<void>((resolve) => { finishLaunch = resolve; });
    return runtime.url;
  } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(server.url);
    await expect(page.locator('#connectionStatus')).toHaveText('Connected');
    const pageCount = page.context().pages().length;
    const manage = page.getByRole('button', { name: 'Connect to VS Code', exact: true });
    const detail = page.locator('#modelTrackingDetail');
    await expect(page.locator('#cliTrackingSetup')).toBeVisible();
    await manage.click();
    await expect.poll(() => launches).toBe(1);
    await expect(detail).toContainText('unavailable');
    await expect(manage).toBeEnabled();
    engine.updateConfig({ usdPerMillionTokens: 4 });
    server.notify();
    await expect(page.locator('#config-usdPerMillionTokens')).toHaveValue('4');
    await expect(detail).toContainText('unavailable');
    expect(page.url()).toBe(server.url);
    launchFails = false;
    await manage.click();
    await expect.poll(() => launches).toBe(2);
    await expect(manage).toBeDisabled();
    engine.updateConfig({ usdPerMillionTokens: 3 });
    server.notify();
    await expect(page.locator('#config-usdPerMillionTokens')).toHaveValue('3');
    await expect(manage).toBeDisabled();
    finishLaunch!();
    await expect(page).toHaveURL(runtime.url);
    await expect(page.locator('#modelTrackingStatus')).toHaveText('Connected');
    await expect(page.locator('#disconnectModelTracking')).toBeVisible();
    await expect(manage).toHaveCount(0);
    expect(page.context().pages()).toHaveLength(pageCount);
    expect(errors).toEqual([]);
  } finally {
    finishLaunch?.();
    await server.close();
    await runtime.close();
    engine.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const width of [1280, 390]) {
  test(`model recommendations stay advisory and preserve drafts at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-recommendation-browser-'));
    const baseline = { vendor: 'vendor', id: 'baseline' };
    const alternate = { vendor: 'vendor', id: 'lower-cost-' + 'long-model-name-'.repeat(12) };
    const missing = { vendor: 'vendor', id: 'unavailable' };
    const policy = validateCostPolicy({ version: 1, mode: 'recommend-only', allowedModels: [baseline, alternate, missing] });
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { costPolicy: policy } });
    const makeCandidate = (model: typeof baseline, rate: number): PolicyCandidate => ({ model, inputTokens: 100, maxInputTokens: 8000,
      toolCalling: true, verifiedPasses: 3, verifiedFailures: 0, rates: { basis: 'public-api-reference', mode: 'automatic', inputUsdPerMillion: rate,
        outputUsdPerMillion: rate, source: 'https://models.dev/api.json', fetchedAt: 100, revision: 'fixture', stale: false, status: 'priced', assumption: 'standard-uncached-input' } });
    const candidates = [makeCandidate(baseline, 10), makeCandidate(alternate, 1)];
    candidates[1].verifiedPasses = 0;
    let trusted = true;
    let fail = false;
    let hold = false;
    let finish: (() => void) | undefined;
    let comparisons = 0;
    let saves = 0;
    const server = await startDashboardServer(engine, { port: 0, costPolicy: { canEdit: () => trusted, save: async () => { saves++; },
      recommend: async (request) => {
        comparisons++;
        if (hold) await new Promise<void>((resolve) => { finish = resolve; });
        if (fail) throw new Error('PRIVATE discovery error');
        return { ...recommendPolicyModel(engine.getConfig().costPolicy, candidates.map((candidate) => ({ ...candidate, inputTokens: request.inputTokens ?? null })), request),
          timings: { discoveryMs: 1.5, evaluationMs: 0.2 } };
      } } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(server.url);
      await page.getByRole('tab', { name: 'Cost policy', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Model recommendations', exact: true });
      const compare = page.getByRole('button', { name: 'Compare permitted models', exact: true });
      await expect(panel).toBeVisible();
      await expect(page.locator('#recommendationStatus')).toHaveText('Task details required.');
      expect(comparisons).toBe(0);
      await page.locator('#policyBudget').fill('777');
      await page.locator('#recommendationCategory').selectOption('code');
      await page.locator('#recommendationBaseline').selectOption(JSON.stringify(baseline));
      await page.locator('#recommendationInput').fill('100');
      await page.locator('#recommendationOutput').fill('512');
      const history = engine.ledger.all();
      await compare.click();
      await expect(page.locator('#recommendationStatus')).toContainText('Baseline retained.');
      const rows = page.locator('#recommendationCandidates tr');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(1)).toContainText('Insufficient verified evidence');
      await expect(rows.nth(2)).toContainText('Unavailable or not authorized');
      candidates[1].verifiedPasses = 3;
      await compare.click();
      await expect(page.locator('#recommendationSelection')).toHaveText('Suggested model: ' + alternate.vendor + '/' + alternate.id);
      await expect(page.locator('#recommendationTiming')).toContainText('Local rules: 0.20 ms');
      await page.evaluate(async () => {
        const data = await (await fetch('/api/summary')).json();
        window.postMessage({ ...data, pricingStatus: { ...data.pricingStatus, loading: true } }, window.location.origin);
      });
      await expect(page.locator('#refreshCatalog')).toBeDisabled();
      await expect(page.locator('#recommendationSelection')).toContainText(alternate.id);
      expect(engine.ledger.all()).toEqual(history);
      expect(engine.getConfig().costPolicy).toEqual(policy);
      expect(saves).toBe(0);
      await expect(page.locator('#policyBudget')).toHaveValue('777');
      await expect(page.locator('#policyStatus')).toHaveText('Unsaved changes.');
      await expect(page.locator('#recommendationBasis')).toContainText('not Copilot billing');
      const scroll = page.getByRole('region', { name: 'Model recommendation candidates', exact: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width === 390) {
        expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
        await scroll.focus();
        await expect(scroll).toBeFocused();
        await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      }
      await panel.screenshot({ path: testInfo.outputPath(`recommendation-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await panel.screenshot({ path: testInfo.outputPath(`recommendation-dark-${width}.png`) });
      await page.locator('#recommendationPinned').check();
      await compare.click();
      await expect(page.locator('#recommendationStatus')).toHaveText('Baseline held. No alternative recommended.');
      await page.locator('#recommendationPinned').uncheck();
      hold = true;
      await compare.click();
      await expect(page.locator('#recommendationStatus')).toHaveText('Comparing permitted models...');
      await expect(compare).toBeDisabled();
      await expect.poll(() => !!finish).toBe(true);
      await page.locator('#recommendationInput').fill('120');
      finish!(); hold = false;
      await expect(page.locator('#recommendationSelection')).toBeEmpty();
      await expect(page.locator('#recommendationForm')).toHaveAttribute('aria-busy', 'false');
      fail = true;
      await compare.click();
      await expect(page.locator('#recommendationStatus')).toContainText('Recommendation unavailable');
      await expect(panel).not.toContainText('PRIVATE');
      fail = false;
      await compare.click();
      await expect(page.locator('#recommendationSelection')).toContainText(alternate.id);
      await page.evaluate(async () => {
        const data = await (await fetch('/api/summary')).json();
        window.postMessage({ ...data, pricingSnapshot: { ...data.pricingSnapshot, revision: 'changed-price-snapshot' } }, window.location.origin);
      });
      await expect(page.locator('#recommendationSelection')).toBeEmpty();
      await expect(page.locator('#recommendationStatus')).toContainText('Result expired');
      engine.updateConfig({ costPolicy: { ...policy, allowedModels: [] } });
      server.notify();
      await expect(page.locator('#recommendationStatus')).toHaveText('No permitted models in the saved policy.');
      await expect(compare).toBeDisabled();
      await expect(page.locator('#recommendationInput')).toHaveValue('120');
      await expect(page.locator('#policyBudget')).toHaveValue('777');
      trusted = false;
      server.notify();
      await expect(page.locator('#recommendationStatus')).toHaveText('Model recommendations are unavailable on this host.');
      expect(errors).toEqual([]);
    } finally {
      finish?.();
      await server.close();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`permitted model picker preserves selections through discovery changes at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-model-picker-ui-'));
    const missing = { vendor: 'copilot', id: 'saved-model' };
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { costPolicy: validateCostPolicy({
      version: 1, mode: 'recommend-only', allowedModels: [missing], taskBudget: 15,
    }) } });
    const baseline = { vendor: 'copilot', id: 'test-model', name: 'Test model', authorized: true };
    const other = { vendor: 'other', id: 'test-model', name: 'Other model', authorized: false };
    let choices = [baseline, other, { vendor: 'custom', id: 'model-' + 'x'.repeat(250), name: 'Custom <model> ' + 'Extended'.repeat(18), authorized: false }];
    let editable = true;
    let failList = false;
    let holdList = true;
    const pending: (() => void)[] = [];
    const saved: unknown[] = [];
    const server = await startDashboardServer(engine, { port: 0, costPolicy: {
      canEdit: () => editable,
      listModels: async () => {
        const snapshot = [...choices];
        if (holdList) await new Promise<void>((resolve) => { pending.push(resolve); });
        if (failList) throw new Error('PRIVATE model provider failure');
        return snapshot;
      },
      save: async (policy) => { saved.push(policy); engine.updateConfig({ costPolicy: policy }); },
    } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const row = (vendor: string, id: string) => page.locator('.policyModelOption').filter({ hasText: vendor + ' / ' + id });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(server.url);
      await page.getByRole('tab', { name: 'Cost policy', exact: true }).click();
      await page.locator('#policyAdvanced > summary').click();
      const refresh = page.getByRole('button', { name: 'Refresh available models', exact: true });
      const search = page.getByRole('searchbox', { name: 'Find models', exact: true });
      const apply = page.locator('#applyPolicy');
      const budget = page.locator('#policyBudget');
      const config = engine.getConfig();
      const history = engine.ledger.all();
      await expect(page.locator('#policyModelsStatus')).toHaveText('Loading models...');
      await expect(refresh).toBeDisabled();
      await expect(row(missing.vendor, missing.id).getByRole('checkbox')).toBeChecked();
      await search.fill('test');
      await expect.poll(() => pending.length).toBe(1);
      holdList = false;
      pending.shift()!();
      await expect(page.locator('#policyModels')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('.policyModelOption')).toHaveCount(2);
      await expect(apply).toBeDisabled();
      await expect(page.locator('#policyStatus')).toHaveText('Saved workspace policy.');
      await row(baseline.vendor, baseline.id).getByRole('checkbox').focus();
      await page.keyboard.press('Space');
      await budget.fill('42');
      await expect(row(other.vendor, other.id)).toContainText('Access not granted');
      await row(other.vendor, other.id).getByRole('checkbox').check();
      await expect(page.locator('#policyModelsCount')).toHaveText('3 selected');
      await row(other.vendor, other.id).getByRole('checkbox').uncheck();
      await search.fill('no-match');
      await expect(page.locator('#policyModelsEmpty')).toHaveText('No models match your search.');
      await expect(page.locator('#policyModelsCount')).toHaveText('2 selected');
      await search.fill('');
      await expect(row(missing.vendor, missing.id)).toContainText('Not currently available');
      await expect(row(missing.vendor, missing.id).getByRole('checkbox')).toBeChecked();
      await expect(page.locator('#policyModels model, #policyModels img')).toHaveCount(0);
      await page.locator('#policyAdvanced').screenshot({ path: testInfo.outputPath(`model-picker-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.locator('#policyAdvanced').screenshot({ path: testInfo.outputPath(`model-picker-dark-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await page.locator('#policySettings').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(saved).toEqual([]);
      expect(engine.getConfig()).toEqual(config);
      expect(engine.ledger.all()).toEqual(history);
      failList = true;
      await refresh.click();
      await expect(page.locator('#policyModelsStatus')).toHaveText('Model list unavailable. Refresh to retry.');
      await expect(row(baseline.vendor, baseline.id).getByRole('checkbox')).toBeChecked();
      await expect(page.locator('#policySettings')).not.toContainText('PRIVATE');
      await expect(budget).toHaveValue('42');
      failList = false;
      choices = [other];
      holdList = true;
      await refresh.click();
      await expect(page.locator('#policyModelsStatus')).toHaveText('Loading models...');
      await expect.poll(() => pending.length).toBe(1);
      editable = false;
      server.notify();
      await expect(budget).toBeDisabled();
      await expect(page.locator('#policyModelsStatus')).toContainText('trusted VS Code host');
      choices = [];
      holdList = false;
      editable = true;
      server.notify();
      await expect(budget).toBeEnabled();
      await expect(page.locator('#policyModelsStatus')).toHaveText('');
      const staleResponse = page.waitForResponse((response) => response.url().includes('/api/policy-models'));
      pending.shift()!();
      await staleResponse;
      await expect(row(other.vendor, other.id)).toHaveCount(0);
      await expect(row(baseline.vendor, baseline.id)).toContainText('Not currently available');
      await expect(row(baseline.vendor, baseline.id).getByRole('checkbox')).toBeChecked();
      await expect(budget).toHaveValue('42');
      await apply.click();
      await expect(page.locator('#policyStatus')).toHaveText('Applied to workspace.');
      expect(saved).toHaveLength(1);
      expect(engine.getConfig().costPolicy.allowedModels).toEqual([missing, { vendor: baseline.vendor, id: baseline.id }]);
      expect(engine.getConfig().costPolicy.taskBudget).toBe(42);
      engine.updateConfig({ costPolicy: { ...engine.getConfig().costPolicy, allowedModels: [] } });
      server.notify();
      await expect(page.locator('#policyModelsCount')).toHaveText('0 selected');
      await expect(page.locator('#policyModelsEmpty')).toHaveText('No models available from VS Code.');
      await expect(apply).toBeDisabled();
      const permitted = Array.from({ length: 64 }, (_, index) => ({ vendor: 'saved', id: 'model-' + index }));
      engine.updateConfig({ costPolicy: { ...engine.getConfig().costPolicy, allowedModels: permitted } });
      server.notify();
      await expect(page.locator('#policyModelsCount')).toHaveText('64 selected');
      choices = [baseline];
      await refresh.click();
      await expect(row(baseline.vendor, baseline.id).getByRole('checkbox')).toBeDisabled();
      await row('saved', 'model-63').getByRole('checkbox').uncheck();
      await expect(row(baseline.vendor, baseline.id).getByRole('checkbox')).toBeEnabled();
      await row(baseline.vendor, baseline.id).getByRole('checkbox').check();
      await expect(page.locator('#policyModelsCount')).toHaveText('64 selected');
      expect(engine.getConfig().costPolicy.allowedModels).toEqual(permitted);
      expect(saved).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      for (const finish of pending) finish();
      await server.close();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`cost policy editor applies workspace settings without losing drafts at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-policy-editor-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], policyContext: { host: 'native-copilot', scope: 'workspace' } });
    let editable = true;
    let failSave = false;
    let holdSave = true;
    let finishSave: (() => void) | undefined;
    const saved: unknown[] = [];
    const server = await startDashboardServer(engine, { port: 0, costPolicy: {
      canEdit: () => editable,
      listModels: async () => [{ vendor: 'copilot', id: 'test-model', name: 'Test model', authorized: true }],
      save: async (policy) => {
        saved.push(policy);
        if (failSave) throw new Error('PRIVATE save failure');
        if (holdSave) await new Promise<void>((resolve) => { finishSave = resolve; });
        engine.updateConfig({ costPolicy: policy });
      },
    } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const openEditor = async () => {
      await page.getByRole('tab', { name: 'Cost policy', exact: true }).click();
      await expect(page.locator('#policyForm')).toBeVisible();
    };
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(server.url);
      await expect(page.locator('[data-panel="cost-policy"]')).toBeHidden();
      await openEditor();
      const policyPanel = page.locator('[data-panel="cost-policy"]');
      await expect(page.getByRole('tab', { name: 'Cost policy', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(policyPanel.locator('#policySettings, .costPolicy, .taskUsage')).toHaveCount(3);
      await expect(page.locator('[data-panel="models"] #policySettings, [data-panel="models"] .costPolicy, [data-panel="models"] .taskUsage')).toHaveCount(0);
      await expect(page.locator('#utilityDrawer #policySettings')).toHaveCount(0);
      const form = page.locator('#policyForm');
      const apply = page.locator('#applyPolicy');
      const budget = page.locator('#policyBudget');
      await expect(page.locator('#policyMode')).toHaveValue('off');
      await expect(apply).toBeDisabled();
      await expect(budget).toHaveValue('');
      await expect(page.locator('#policyMode option[value="automatic-owned-request"]')).toHaveJSProperty('disabled', false);
      await expect(page.locator('#policyModelSelection')).toHaveValue('pinned');
      await expect(page.locator('#policyOutputAllowance')).toHaveValue('2048');
      await expect(page.locator('#policyBalancedPressure')).toHaveValue('50');
      await expect(page.locator('#policyAggressivePressure')).toHaveValue('80');
      const before = engine.summary();
      await page.locator('#policyMode').selectOption('automatic-owned-request');
      await expect(apply).toBeDisabled();
      await expect(page.locator('#policyStatus')).toContainText('require a task budget');
      await page.locator('#policyMode').selectOption('recommend-only');
      await budget.fill('1.5');
      await expect(apply).toBeDisabled();
      await expect(page.locator('#policyStatus')).toContainText('whole numbers');
      await page.locator('#policyUnit').selectOption('reference-usd');
      await expect(apply).toBeEnabled();
      await budget.fill('0');
      await page.locator('#policyUnit').selectOption('tokens');
      await page.locator('#policyAdvanced > summary').click();
      const model = form.getByRole('checkbox', { name: 'Test model (copilot/test-model)', exact: true });
      await model.check();
      await form.getByLabel('Aggressive', { exact: true }).uncheck();
      await expect(apply).toBeEnabled();
      await page.getByRole('tab', { name: 'Models', exact: true }).click();
      await expect(policyPanel).toBeHidden();
      await expect(page.locator('#receiverHealthTitle')).toBeVisible();
      engine.updateConfig({ maxFileLines: 350 });
      server.notify();
      await expect(page.locator('#config-maxFileLines')).toHaveValue('350');
      await expect(page.getByRole('tab', { name: 'Models', exact: true })).toHaveAttribute('aria-selected', 'true');
      await openEditor();
      await expect(budget).toHaveValue('0');
      await expect(model).toBeChecked();
      await expect(form.getByLabel('Aggressive', { exact: true })).not.toBeChecked();
      expect(saved).toEqual([]);
      expect(engine.getConfig().costPolicy.mode).toBe('off');
      await apply.click();
      await expect.poll(() => saved.length).toBe(1);
      await expect(apply).toBeDisabled();
      await expect(budget).toBeDisabled();
      expect(engine.getConfig().costPolicy.mode).toBe('off');
      holdSave = false;
      finishSave!();
      await expect(page.locator('#policyStatus')).toHaveText('Applied to workspace.');
      expect(engine.getConfig().costPolicy).toEqual(validateCostPolicy({
        version: 1, mode: 'recommend-only', taskBudget: 0, allowedModels: [{ vendor: 'copilot', id: 'test-model' }], allowedCompressionProfiles: ['conservative', 'balanced'],
      }));
      expect(engine.getConfig().profile).toBe('balanced');
      expect(engine.summary()).toEqual(before);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`policy-editor-light-${width}.png`), fullPage: true });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: testInfo.outputPath(`policy-editor-dark-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await policyPanel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await budget.fill('10');
      engine.updateConfig({ costPolicy: validateCostPolicy({ ...engine.getConfig().costPolicy, taskBudget: 30 }) });
      await expect(page.locator('#policyStatus')).toContainText('changed elsewhere');
      await expect(budget).toHaveValue('10');
      await expect(apply).toBeDisabled();
      await page.getByRole('button', { name: 'Reload saved policy', exact: true }).click();
      await expect(budget).toHaveValue('30');
      await expect(apply).toBeDisabled();
      await budget.fill('99');
      failSave = true;
      const history = fs.readFileSync(engine.ledger.path(), 'utf8');
      await apply.click();
      await expect(page.locator('#policyStatus')).toContainText('could not be applied');
      await expect(budget).toHaveValue('99');
      await expect(apply).toBeEnabled();
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(history);
      expect(engine.getConfig().costPolicy.taskBudget).toBe(30);
      failSave = false;
      await page.locator('#policyMode').selectOption('automatic-owned-request');
      await page.locator('#policyOutputAllowance').fill('0');
      await expect(apply).toBeDisabled();
      await page.locator('#policyOutputAllowance').fill('512');
      await page.locator('#policyModelSelection').selectOption('policy');
      await page.locator('#policyBalancedPressure').fill('');
      await expect(apply).toBeDisabled();
      await page.locator('#policyBalancedPressure').fill('65');
      await page.locator('#policyAggressivePressure').fill('65');
      await expect(apply).toBeDisabled();
      await expect(page.locator('#policyStatus')).toContainText('balanced < aggressive');
      await page.locator('#policyAggressivePressure').fill('101');
      await expect(apply).toBeDisabled();
      await page.locator('#policyAggressivePressure').fill('75');
      engine.updateConfig({ maxFileLines: 351 });
      server.notify();
      await expect(page.locator('#config-maxFileLines')).toHaveValue('351');
      await expect(page.locator('#policyBalancedPressure')).toHaveValue('65');
      await expect(page.locator('#policyAggressivePressure')).toHaveValue('75');
      await budget.fill('4000');
      await apply.click();
      await expect(page.locator('#policyStatus')).toHaveText('Applied to workspace.');
      expect(engine.getConfig().costPolicy).toMatchObject({ mode: 'automatic-owned-request', taskBudget: 4000, outputTokenAllowance: 512, modelSelection: 'policy', pressureThresholds: { balanced: 0.65, aggressive: 0.75 } });
      await page.locator('#policyBalancedPressure').fill('10');
      await page.getByRole('button', { name: 'Reload saved policy', exact: true }).click();
      await expect(page.locator('#policyBalancedPressure')).toHaveValue('65');
      await expect(page.locator('#policyAggressivePressure')).toHaveValue('75');
      await expect(page.locator('#costPolicyMode')).toContainText('Effective: Recommend only');
      await expect(page.locator('#costPolicyDecisions')).toContainText('Unsupported host');
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.emulateMedia({ colorScheme: 'light' });
      await page.screenshot({ path: testInfo.outputPath(`automatic-policy-light-${width}.png`), fullPage: true });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.screenshot({ path: testInfo.outputPath(`automatic-policy-dark-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await budget.fill('99');
      await page.locator('#policyMode').selectOption('off');
      await apply.click();
      await expect(page.locator('#policyStatus')).toHaveText('Applied to workspace.');
      expect(engine.getCostPolicyAssessment().effectiveMode).toBe('off');
      editable = false;
      server.notify();
      await expect(budget).toBeDisabled();
      await expect(page.locator('#policyStatus')).toContainText('Read-only');
      editable = true;
      server.notify();
      await expect(budget).toBeEnabled();
      await page.reload();
      await openEditor();
      await expect(page.locator('#policyMode')).toHaveValue('off');
      await expect(budget).toHaveValue('99');
      await expect(apply).toBeDisabled();
      expect(engine.summary()).toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      finishSave?.();
      await server.close();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`owned task accounting separates usage, estimates and budgets at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-task-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const model = { vendor: 'vendor', id: 'model' };
    const rates = resolvePricing({ mode: 'automatic' }, 99, {
      version: 1, fetchedAt: 100, revision: 'fixture', models: [{
        providerId: 'vendor', providerName: 'Vendor', modelId: 'model', modelName: 'Model', input: 5, output: 10, cacheRead: 1, cacheWrite: 6,
      }],
    }, 100, { ...model, name: 'Model' });
    const options = { sessionId: 'fixture', policyRevision: 'a'.repeat(64), unit: 'tokens' as const, limit: 4000, retrievalTracking: true };
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(server.url);
      await page.getByRole('tab', { name: 'Cost policy', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Owned tasks', exact: true });
      await expect(page.locator('#taskUsageEmpty')).toBeVisible();
      await expect(panel.locator('button, input, select')).toHaveCount(0);
      const before = engine.summary();
      const task = new OwnedTaskUsage(engine.ledger, options);
      const call = task.startCall(model, rates, { reserved: 1200, inputTokens: 900 });
      const row = page.locator('#taskUsage tr[data-task-id="' + task.taskId + '"]');
      await expect(row).toContainText('900 (partial)');
      await expect(row.locator('td').nth(3)).toHaveText('Unknown');
      await expect(row.locator('td').nth(5)).toHaveText('Unknown');
      await expect(row.locator('td').nth(7)).toHaveText('1,200 tokens');
      await expect(row.locator('td').nth(8)).toContainText('Unknown');
      await expect(row.locator('.taskOutcomeStatus')).toHaveText('Unverified');
      task.reportUsage(call, { inputTokens: 1000 }, 'PRIVATE-OBSERVATION');
      await expect(row.locator('td').nth(3)).toHaveText('1,000 known (partial)');
      const usage = { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 600, cacheCreationInputTokens: 100 };
      task.finishCall(call, 'finished');
      task.recordRetrieval(true);
      task.recordRetrieval(false);
      task.finish('finished');
      task.reportUsage(call, usage, 'PRIVATE-OBSERVATION');
      task.reportUsage(call, usage, 'PRIVATE-OBSERVATION');
      await expect(row.locator('td').nth(3)).toHaveText('1,100');
      await expect(row.locator('td').nth(5)).toHaveText('$0.0037');
      await expect(row.locator('td').nth(7)).toHaveText('0 tokens');
      await expect(row.locator('td').nth(8)).toContainText('2,900 tokens');
      await expect(row.locator('.taskOutcomeStatus')).toHaveText('Unverified');
      await expect(row.locator('td').nth(2)).toContainText('Retries: Unknown');
      await expect(row.locator('td').nth(2)).toContainText('Retrievals: 1');
      await expect(row.locator('td').nth(2)).toContainText('Recovery failures: 1');
      await expect(row.locator('td').first()).toContainText('Duration:');
      const check = { source: 'command' as const, check: 'test' as const, execution: 'completed' as const, exitCode: 1, durationMs: 125, checkKey: 'b'.repeat(64) };
      recordTaskOutcome(engine.ledger, task.taskId, check);
      await expect(row.locator('.taskOutcomeStatus')).toHaveText('Verified fail');
      await row.locator('.taskEvidence summary').focus();
      await page.keyboard.press('Enter');
      await expect(row.locator('.taskEvidence')).toHaveAttribute('open', '');
      await expect(row.locator('.taskEvidence')).toContainText('Test check | Exit 1');
      recordTaskOutcome(engine.ledger, task.taskId, { ...check, exitCode: 0 });
      await expect(row.locator('.taskOutcomeStatus')).toHaveText('Verified pass');
      await expect(row.locator('.taskEvidence')).toHaveAttribute('open', '');
      await expect(row.locator('.taskEvidence')).toContainText('Test check | Exit 0');
      await expect(row.locator('.taskEvidence')).toContainText('Verification attempts: 2');
      const partial = new OwnedTaskUsage(engine.ledger, { ...options, unit: 'reference-usd', limit: 1 });
      const partialCall = partial.startCall(model, { ...rates, outputUsdPerMillion: null }, { reserved: 0.1 });
      partial.reportUsage(partialCall, usage);
      partial.finishCall(partialCall, 'failed');
      partial.finish('failed');
      const partialRow = page.locator('#taskUsage tr[data-task-id="' + partial.taskId + '"]');
      await expect(partialRow.locator('td').nth(5)).toHaveText('$0.0027 known (partial)');
      await expect(partialRow.locator('td').nth(8)).toContainText('Unknown');
      recordTaskOutcome(engine.ledger, partial.taskId, { ...check, execution: 'cancelled', exitCode: null });
      await expect(partialRow.locator('.taskOutcomeStatus')).toHaveText('Cancelled');
      recordTaskOutcome(engine.ledger, partial.taskId, { ...check, execution: 'error', exitCode: null });
      await expect(partialRow.locator('.taskOutcomeStatus')).toHaveText('Unverified');
      recordTaskOutcome(engine.ledger, partial.taskId, check);
      await expect(partialRow.locator('.taskOutcomeStatus')).toHaveText('Verified fail');
      const zero = new OwnedTaskUsage(engine.ledger, { ...options, limit: 0 });
      const zeroCall = zero.startCall(model, rates);
      zero.reportUsage(zeroCall, { inputTokens: 0, outputTokens: 0 });
      zero.finishCall(zeroCall, 'finished');
      zero.finish('finished');
      const zeroRow = page.locator('#taskUsage tr[data-task-id="' + zero.taskId + '"]');
      await expect(zeroRow.locator('td').nth(3)).toHaveText('0');
      await expect(zeroRow.locator('td').nth(5)).toHaveText('$0.00');
      recordTaskOutcome(engine.ledger, zero.taskId, { source: 'user', result: 'pass' });
      await expect(zeroRow.locator('.taskOutcomeStatus')).toHaveText('User-reported');
      await expect(zeroRow.locator('td').nth(1)).toContainText('Reported successful');
      await expect(page.locator('#taskUsage tr')).toHaveCount(3);
      await expect(page.locator('#taskUsageNote')).toHaveText('Owned requests only | 3 tasks | Not enforced');
      await expect(page.locator('#taskOutcomeNote')).toHaveText('Verified pass: 1 | Verified fail: 1 | User-reported: 1 | Cancelled: 0 | Unverified: 0');
      const automaticOptions = { ...options, workspaceKey: taskWorkspaceKey([root]), guardrails: true, category: 'code' as const };
      const automatic = new OwnedTaskUsage(engine.ledger, automaticOptions);
      const automaticCall = automatic.startCall(model, rates, { reserved: 1000, inputTokens: 750 });
      automatic.finishCall(automaticCall, 'finished', 80);
      automatic.recordPolicyDecision({ state: 'paused', reason: 'budget-limit', requestedModel: model, selectedModel: model, profile: 'aggressive' });
      automatic.finish('paused');
      const automaticRow = page.locator('#taskUsage tr[data-task-id="' + automatic.taskId + '"]');
      await expect(automaticRow.locator('td').first()).toContainText('Paused');
      await expect(automaticRow.locator('td').nth(3)).toHaveText('Unknown');
      await expect(automaticRow.locator('td').nth(8)).toContainText('Unknown');
      await expect(automaticRow.locator('td').nth(9)).toContainText('Local guardrails');
      await expect(automaticRow.locator('td').nth(9)).toContainText('Allowance left: 3,000 tokens');
      await expect(automaticRow.locator('td').nth(9)).toContainText('Paused: Task allowance exhausted');
      await expect(automaticRow.locator('td').nth(9)).toContainText('Model: vendor/model');
      const resumed = OwnedTaskUsage.resume(engine.ledger, automatic.taskId, automaticOptions, model);
      resumed.startCall(model, rates, { reserved: 500 });
      resumed.dispose();
      const recovered = OwnedTaskUsage.resume(engine.ledger, automatic.taskId, automaticOptions, model);
      recovered.finish('paused');
      await expect(automaticRow.locator('td').first()).toContainText('Resumes: 2');
      await expect(automaticRow.locator('td').nth(2)).toContainText('Interrupted: 1');
      await expect(automaticRow.locator('td').nth(9)).toContainText('Allowance left: 2,500 tokens');
      await expect(page.locator('#taskUsageNote')).toContainText('Local allowances, not billing caps');
      expect(engine.summary()).toEqual(before);
      const history = fs.readFileSync(engine.ledger.path(), 'utf8');
      expect(history).not.toContain('PRIVATE-OBSERVATION');
      const scroll = page.getByRole('region', { name: 'Owned task accounting', exact: true });
      await scroll.focus();
      await expect(scroll).toBeFocused();
      await panel.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await panel.screenshot({ path: testInfo.outputPath(`owned-tasks-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      if (width < 600) await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await panel.screenshot({ path: testInfo.outputPath(`owned-tasks-dark-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.reload();
      await page.getByRole('tab', { name: 'Cost policy', exact: true }).click();
      await expect(page.locator('#taskUsage tr')).toHaveCount(4);
      await expect(automaticRow.locator('td').first()).toContainText('Resumes: 2');
      await expect(automaticRow.locator('td').nth(2)).toContainText('Interrupted: 1');
      await expect(row.locator('.taskOutcomeStatus')).toHaveText('Verified pass');
      await expect(page.locator('#taskOutcomeNote')).toContainText('Verified pass: 1 | Verified fail: 1');
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(history);
      expect(errors).toEqual([]);
    } finally {
      server.close();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`cost policy reports capabilities without automation at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-policy-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], policyContext: { host: 'native-copilot', scope: 'workspace' } });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(server.url);
      await page.getByRole('tab', { name: 'Cost policy', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Cost policy', exact: true });
      await expect(panel).toBeVisible();
      await expect(page.locator('#costPolicyMode')).toHaveText('Requested: Off | Effective: Off');
      await expect(page.locator('#costPolicyScope')).toHaveText('Native Copilot | Workspace | Model requests: not owned');
      await expect(page.locator('#costPolicyDecisions tr')).toHaveCount(3);
      await expect(panel.locator('button, input, select')).toHaveCount(0);
      expect(engine.ledger.all()).toEqual([]);
      const before = engine.summary();
      expect(await page.evaluate(async () => (await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costPolicy: { version: 1, mode: 'recommend-only' } }),
      })).status)).toBe(400);
      engine.updateConfig({ costPolicy: validateCostPolicy({
        version: 1, mode: 'automatic-owned-request', allowedModels: [{ vendor: 'PRIVATE', id: 'PRIVATE' }], budgetUnit: 'reference-usd',
      }) });
      await expect(page.locator('#costPolicyMode')).toHaveText('Requested: Automatic owned request | Effective: Recommend only');
      await expect(page.locator('#costPolicyCoverage')).toContainText('Reference USD | Usage: not measured');
      await expect(page.locator('#costPolicyDecisions tr').first()).toContainText('Unsupported host');
      await expect(page.locator('#costPolicyDecisions tr').first()).toContainText('Advisory:');
      await expect(panel).not.toContainText('PRIVATE');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await panel.locator('table').evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      const scroll = page.getByRole('region', { name: 'Cost policy capabilities', exact: true });
      await scroll.focus();
      await expect(scroll).toBeFocused();
      await panel.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await panel.screenshot({ path: testInfo.outputPath(`cost-policy-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await panel.screenshot({ path: testInfo.outputPath(`cost-policy-dark-${width}.png`) });
      await page.reload();
      await page.getByRole('tab', { name: 'Cost policy', exact: true }).click();
      await expect(page.locator('#costPolicyMode')).toContainText('Effective: Recommend only');
      engine.updateConfig({ costPolicy: undefined });
      await expect(page.locator('#costPolicyMode')).toHaveText('Requested: Off | Effective: Off');
      const audits = engine.ledger.all();
      expect(audits).toHaveLength(2);
      expect(audits.every((entry) => entry.tool === 'session' && !entry.pricing && entry.tokensBefore === 0 && entry.tokensAfter === 0)).toBe(true);
      expect(engine.summary()).toEqual(before);
      expect(engine.getConfig().profile).toBe('balanced');
      expect(errors).toEqual([]);
    } finally {
      engine.dispose();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`cache-aware input estimates preserve recorded costs at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-cache-cost-ui-'));
    const samples = [
      { model: 'complete', usage: {} },
      { model: 'partial', usage: { cacheCreationInputTokens: undefined } },
      { model: 'missing-rates', usage: {} },
      { model: 'zero', usage: { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      { model: 'unreported', usage: { inputTokens: undefined, cacheReadInputTokens: undefined, cacheCreationInputTokens: undefined } },
      { model: 'inconsistent', usage: { inputTokens: 5, cacheReadInputTokens: 4, cacheCreationInputTokens: 2 } },
      { model: 'tiny', usage: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      { model: 'free', usage: {} },
    ];
    fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), revision: 'recorded', models:
      samples.map(({ model }) => ({
        providerId: 'openai', providerName: 'OpenAI', modelId: model, modelName: model,
        input: model === 'free' ? 0 : model === 'tiny' ? 0.01 : 5,
        ...(model === 'missing-rates' ? {} : { cacheRead: model === 'free' ? 0 : 1, cacheWrite: model === 'free' ? 0 : 6 }),
      })),
    }));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const before = engine.summary();
    for (const [index, sample] of samples.entries()) {
      recordModelObservation(engine, {
        traceId: (index + 1).toString(16).padStart(32, '0'), spanId: 'a'.repeat(16), provider: 'openai',
        requestModel: sample.model, responseModel: sample.model, conversationId: 'PRIVATE-CACHE-CONVERSATION',
        startedAt: 1000 + index, endedAt: 2000 + index,
        inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 600, cacheCreationInputTokens: 100, ...sample.usage,
      });
    }
    const stored = fs.readFileSync(engine.ledger.path(), 'utf8');
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(server.url);
      await page.locator('[data-panel-target="models"]').click();
      const observations = page.locator('#modelObservations tr');
      const row = (model: string) => observations.filter({ has: page.locator('td.label', { hasText: `${model} (openai)` }) });
      await expect(observations).toHaveCount(samples.length);
      await expect(row('complete').locator('.modelInputBreakdown')).toHaveText('Uncached$0.001500Cache read$0.000600Cache write$0.000600');
      await expect(row('complete').locator('.modelInputBreakdown > div').first()).toHaveAttribute('title', '300 tokens | $0.001500');
      await expect(row('complete').locator('.cacheAwareInput')).toHaveText('$0.002700Complete');
      await expect(row('complete').locator('.standardUncachedInput')).toHaveText('$0.005000Default estimate');
      await expect(row('partial').locator('.cacheAwareInput')).toHaveText('$0.000600Partial subtotal');
      await expect(row('partial').locator('.cacheAwareInput')).toHaveAttribute('title', 'Missing token usage');
      await expect(row('partial').locator('.modelInputBreakdown')).toContainText('UncachedUnavailable');
      await expect(row('partial').locator('.modelInputBreakdown')).toContainText('Cache writeUnavailable');
      await expect(row('missing-rates').locator('.cacheAwareInput')).toHaveText('$0.001500Partial subtotal');
      await expect(row('missing-rates').locator('.cacheAwareInput')).toHaveAttribute('title', 'Missing model rates');
      for (const model of ['zero', 'free']) await expect(row(model).locator('.cacheAwareInput')).toHaveText('$0.000000Complete');
      await expect(row('unreported').locator('.cacheAwareInput')).toHaveText('UnavailableNot priced');
      await expect(row('unreported').locator('.standardUncachedInput')).toHaveText('UnavailableDefault estimate');
      await expect(row('inconsistent').locator('.cacheAwareInput')).toHaveText('UnavailableNot priced');
      await expect(row('inconsistent').locator('.cacheAwareInput')).toHaveAttribute('title', 'Inconsistent cached-input counts');
      await expect(row('tiny').locator('.cacheAwareInput')).toHaveText('<$0.000001Complete');
      await expect(page.locator('#modelObservationsNote')).toContainText('input-only public API reference estimates at recorded rates, not Copilot bills');
      await expect(page.locator('#modelObservations')).not.toContainText('PRIVATE-CACHE-CONVERSATION');

      const scroll = page.getByRole('region', { name: 'Observed model calls', exact: true });
      await scroll.scrollIntoViewIfNeeded();
      await scroll.focus();
      await expect(scroll).toBeFocused();
      await scroll.evaluate((element) => {
        element.addEventListener('scrollend', () => element.setAttribute('data-keyboard-scroll-settled', 'true'), { once: true });
      });
      await scroll.press('ArrowRight');
      await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await expect(scroll).toHaveAttribute('data-keyboard-scroll-settled', 'true');
      await scroll.evaluate((element) => {
        const component = element.querySelector('.modelInputBreakdown')!;
        element.scrollTo({
          left: element.scrollLeft + component.getBoundingClientRect().left - element.getBoundingClientRect().left,
          behavior: 'instant',
        });
      });
      const componentBounds = await observations.first().locator('.modelInputBreakdown').boundingBox();
      const componentScrollBounds = await scroll.boundingBox();
      expect(componentBounds!.x).toBeGreaterThanOrEqual(componentScrollBounds!.x - 1);
      expect(componentBounds!.x + componentBounds!.width).toBeLessThanOrEqual(componentScrollBounds!.x + componentScrollBounds!.width + 1);
      await scroll.screenshot({ path: testInfo.outputPath(`cache-components-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await scroll.screenshot({ path: testInfo.outputPath(`cache-components-dark-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'light' });
      await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      const bounds = await scroll.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      const lastCell = await observations.first().locator('td').last().boundingBox();
      expect(lastCell!.x + lastCell!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await scroll.screenshot({ path: testInfo.outputPath(`cache-costs-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await scroll.screenshot({ path: testInfo.outputPath(`cache-costs-dark-${width}.png`) });
      await page.reload();
      await page.locator('[data-panel-target="models"]').click();
      await expect(row('complete').locator('.cacheAwareInput')).toHaveText('$0.002700Complete');
      expect(engine.summary()).toEqual(before);
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(stored);
      expect(errors).toEqual([]);
    } finally {
      await server.close();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`native model tracking updates the main dashboard at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-model-tracking-ui-'));
    fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), revision: 'fixture', models: [
      { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.4', modelName: 'GPT-5.4', input: 2 },
    ] }));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } } });
    let server: DashboardServerHandle;
    const receiver = await startModelTelemetryReceiver({
      onObservation: (observation) => recordModelObservation(engine, observation),
      onHealthChange: () => server?.notify(),
    });
    let receiverStarted = false;
    let tracking: DashboardModelTrackingStatus = { state: 'disconnected', detail: 'Off', canConnect: true, canDisconnect: false };
    server = await startDashboardServer(engine, { port: 0, modelTracking: {
      status: () => ({
        ...tracking, receiverHealthScope: tracking.receiverHealthScope ?? 'window',
        receiverHealth: receiverStarted && tracking.receiverHealthScope !== 'shared' ? receiver.getHealth() : undefined,
      }),
      connect: async () => { receiverStarted = true; tracking = { state: 'connected', detail: 'Local receiver ready.', canConnect: false, canDisconnect: true }; },
      disconnect: async () => { tracking = { state: 'disconnected', detail: 'Off', canConnect: true, canDisconnect: false }; },
    } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.install();
      await page.goto(server.url);
      const panel = page.getByRole('region', { name: 'Model tracking', exact: true });
      const warning = page.locator('#modelPricingWarning');
      await expect(panel).toBeVisible();
      await expect(page.locator('#utilityDrawer')).toBeHidden();
      await expect(page.locator('#modelTrackingStatus')).toHaveText('Not connected');
      await expect(warning).toContainText('default $3 / 1M tokens');
      const traffic = page.locator('#trafficStatus');
      const views = traffic.locator('.proofItem').filter({ hasText: 'Connected dashboard views' });
      const sessions = traffic.locator('.proofItem').filter({ hasText: 'Recently active sessions' });
      const operations = traffic.locator('.proofItem').filter({ hasText: 'Recorded tool operations' });
      await expect(traffic.locator('.proofItem')).toHaveCount(3);
      await expect(traffic).not.toContainText('Dashboard host');
      await expect(traffic).not.toContainText('Serving this page');
      await expect(traffic.locator('p, .trafficDescription')).toHaveCount(0);
      await expect(traffic.locator('.proofItem > *')).toHaveCount(9);
      await expect(views.locator('.trafficScope')).toHaveText('Live now');
      await expect(sessions.locator('.v')).toHaveText('0');
      await expect(sessions.locator('.trafficScope')).toHaveText('Last 15 minutes');
      await expect(operations.locator('.v')).toHaveText('0');
      await expect(operations.locator('.trafficScope')).toHaveText('All retained history | Shared store');
      await page.emulateMedia({ colorScheme: 'light' });
      await traffic.screenshot({ path: testInfo.outputPath(`traffic-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await traffic.screenshot({ path: testInfo.outputPath(`traffic-dark-${width}.png`) });
      expect(await traffic.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.emulateMedia({ colorScheme: 'light' });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.locator('#cost')).toHaveText('$0.00');
      await expect(warning).toContainText('Connect model tracking');
      await page.screenshot({ path: testInfo.outputPath(`model-tracking-disconnected-${width}.png`), fullPage: true });
      tracking = { state: 'blocked', detail: 'Telemetry settings are managed.', canConnect: false, canDisconnect: false };
      server.notify();
      await expect(page.locator('#modelTrackingStatus')).toHaveText('Tracking paused');
      await expect(views.locator('.v')).toHaveText('1');
      await expect(page.locator('#connectModelTracking')).toBeDisabled();
      await expect(warning).toContainText('Resolve the tracking issue');
      await expect(warning).not.toHaveClass(/\binfo\b/);
      await expect(page.locator('#modelPricingWarningIcon')).toBeVisible();
      tracking = { state: 'disconnected', detail: 'Off', canConnect: true, canDisconnect: false };
      server.notify();
      await expect(page.locator('#connectModelTracking')).toBeEnabled();
      await page.locator('#connectModelTracking').click();
      await expect(page.locator('#modelTrackingStatus')).toHaveText('Connected');
      await expect(page.locator('#disconnectModelTracking')).toBeVisible();
      await expect(warning).toContainText('No model detected yet');
      await page.getByRole('tab', { name: 'Models', exact: true }).click();
      const healthPanel = page.getByRole('region', { name: 'Receiver health', exact: true });
      await expect(healthPanel).toBeVisible();
      await expect(page.locator('#modelUsageEmpty')).toBeVisible();
      await expect(page.locator('#modelUsageNote')).toHaveText('Lifetime | 0 observed calls | 0 models');
      await expect(page.locator('#receiverHealthStatus')).toContainText('No authenticated exports received');
      await expect(page.locator('#receiverLastAccepted')).toHaveText('Not received');
      await expect(page.locator('#receiverAccepted')).toHaveText('0');
      const beforeHealth = engine.summary();
      for (const [contentType, token, body, status] of [
        ['application/json', receiver.token, '{PRIVATE', 400],
        ['application/x-protobuf', receiver.token, 'PRIVATE', 415],
        ['application/json', 'wrong', 'PRIVATE', 403],
      ] as const) {
        expect((await fetch(`${receiver.endpoint}/v1/traces`, {
          method: 'POST', headers: { 'content-type': contentType, Authorization: `Bearer ${token}` }, body,
        })).status).toBe(status);
      }
      expect((await fetch(`${receiver.endpoint}/v1/logs`, {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${receiver.token}` }, body: '{"body":"PRIVATE"}',
      })).status).toBe(200);
      await expect(page.locator('#receiverExports')).toHaveText('3');
      await expect(page.locator('#receiverRejected')).toHaveText('3');
      await expect(page.locator('#receiverAccepted')).toHaveText('0');
      await expect(page.locator('#receiverRejections')).toHaveText('Authentication: 1; Unsupported protocol: 1; Malformed JSON: 1');
      await expect(page.locator('#receiverHealthStatus')).toContainText('no model observations accepted');
      await expect(healthPanel).not.toContainText('PRIVATE');
      expect(engine.summary()).toEqual(beforeHealth);
      await page.getByRole('tab', { name: 'Overview', exact: true }).click();
      engine.compressCommandOutput({ command: 'npm test', cwd: root, exitCode: 1, stdout: jestFailureLog(45), stderr: '', durationMs: 10 });
      const before = engine.summary();
      await expect(sessions.locator('.v')).toHaveText('1');
      await expect(operations.locator('.v')).toHaveText('1');
      for (const [index, model] of ['gpt-5.4', 'unknown-model'].entries()) {
        const now = Date.now();
        const attributes = {
          'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
          'gen_ai.request.model': 'auto', 'gen_ai.response.model': model,
          'gen_ai.conversation.id': 'browser-test', 'gen_ai.usage.input_tokens': '1000',
          'gen_ai.usage.output_tokens': '100', 'gen_ai.usage.cache_read.input_tokens': '750',
          'gen_ai.input.messages': 'PRIVATE', 'gen_ai.tool.call.result': 'PRIVATE',
        };
        const response = await fetch(`${receiver.endpoint}/v1/traces`, {
          method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${receiver.token}` },
          body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [{
            traceId: 'a'.repeat(32), spanId: (index ? 'c' : 'b').repeat(16),
            startTimeUnixNano: String(BigInt(now - 1) * 1_000_000n), endTimeUnixNano: String(BigInt(now) * 1_000_000n),
            attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
          }] }] }] }),
        });
        expect(response.status).toBe(200);
        await expect(page.locator('#lastDetectedModel')).toContainText(model);
        await expect(page.locator('#detectedInputRate')).toHaveText(index ? 'Unavailable' : '$2 / 1M input');
        await expect(page.locator('#detectedModelSource')).toHaveText('Copilot telemetry');
        await expect(page.locator('#modelInputTokens')).toHaveText('1,000');
        await expect(page.locator('#modelOutputTokens')).toHaveText('100');
        await expect(page.locator('#modelCachedInputTokens')).toHaveText('750');
        if (index === 0) {
          await expect(warning).toContainText('Est. saved includes');
          await expect(warning).toHaveClass(/\binfo\b/);
          await expect(page.locator('#modelPricingInfoIcon')).toBeVisible();
          await expect(page.locator('#modelPricingWarningIcon')).toBeHidden();
          expect(await warning.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
          recordModelObservation(engine, {
            traceId: 'd'.repeat(32), spanId: 'e'.repeat(16), provider: 'github', requestModel: 'helper-model', responseModel: 'helper-model',
            startedAt: now, endedAt: now + 1, inputTokens: 200, outputTokens: 10,
          });
          await page.reload();
          await expect(page.locator('#modelTrackingStatus')).toHaveText('Connected');
          await expect(page.locator('#lastDetectedModel')).toContainText(model);
          await expect(page.locator('#detectedInputRate')).toHaveText('$2 / 1M input');
          await expect(page.locator('#modelInputTokens')).toHaveText('1,000');
          await expect(warning).toHaveClass(/\binfo\b/);
          await page.emulateMedia({ colorScheme: 'dark' });
          await panel.screenshot({ path: testInfo.outputPath(`model-tracking-connected-dark-${width}.png`) });
          await page.emulateMedia({ colorScheme: 'light' });
          await page.locator('#disconnectModelTracking').click();
          await expect(warning).toContainText('Connect model tracking');
          await expect(page.locator('#lastDetectedModel')).toContainText(model);
          await expect(page.locator('#detectedInputRate')).toHaveText('$2 / 1M input');
          await page.locator('#connectModelTracking').click();
          await expect(page.locator('#modelTrackingStatus')).toHaveText('Connected');
          await expect(page.locator('#lastDetectedModel')).toContainText(model);
          await expect(warning).toHaveClass(/\binfo\b/);
        } else {
          await expect(warning).toContainText('No cached input rate');
        }
        expect(engine.summary()).toEqual(before);
        await expect(operations.locator('.v')).toHaveText('1');
        await expect(traffic.locator('p, .trafficDescription')).toHaveCount(0);
      }
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).not.toContain('PRIVATE');
      await page.getByRole('tab', { name: 'Models', exact: true }).click();
      const observations = page.locator('#modelObservations tr');
      await expect(observations).toHaveCount(3);
      await expect(observations.first()).toContainText('unknown-model');
      await expect(observations.first()).toContainText('Conversation');
      await expect(observations.first()).toContainText('1,000');
      await expect(observations.first()).toContainText('750');
      await expect(page.locator('#modelObservationsNote')).toContainText('2 conversation turn(s), 1 background');
      await expect(observations.filter({ hasText: 'Background' })).toHaveCount(1);
      await expect(page.locator('#modelObservationsEmpty')).toBeHidden();
      await expect(page.locator('#modelObservations')).not.toContainText('browser-test');
      const usagePanel = page.getByRole('region', { name: 'Per-model usage', exact: true });
      const usage = page.locator('#modelUsage tr');
      await expect(usagePanel).toBeVisible();
      await expect(usage).toHaveCount(3);
      await expect(page.locator('#modelUsageEmpty')).toBeHidden();
      await expect(page.locator('#modelUsageNote')).toHaveText('Lifetime | 3 observed calls | 3 models');
      await expect(usage.filter({ hasText: 'gpt-5.4' })).toContainText('$2 / 1M');
      await expect(usage.filter({ hasText: 'gpt-5.4' }).locator('td').nth(2)).toHaveText('1,000');
      await expect(usage.filter({ hasText: 'unknown-model' })).toContainText('Model not in catalog');
      const helperUsage = usage.filter({ hasText: 'helper-model' });
      await expect(helperUsage.locator('td').nth(4)).toHaveText('Not reported');
      const backfill = {
        traceId: 'f'.repeat(32), provider: 'github', requestModel: 'helper-model',
        startedAt: 1000, endedAt: 2000, inputTokens: 10,
      };
      for (let index = 1; index <= 25; index++) {
        recordModelObservation(engine, { ...backfill, spanId: index.toString(16).padStart(16, '0') });
      }
      await expect(observations).toHaveCount(25);
      await expect(helperUsage.locator('td').nth(1)).toHaveText('26');
      await expect(helperUsage.locator('td').nth(2)).toHaveText('450');
      recordModelObservation(engine, { ...backfill, spanId: 'a'.repeat(16) });
      await expect(helperUsage.locator('td').nth(1)).toHaveText('27');
      await expect(helperUsage.locator('td').nth(2)).toHaveText('460');
      await expect(helperUsage.locator('td').nth(3)).toHaveText('10Partial (1/27 calls)');
      await expect(helperUsage.locator('td').nth(5)).toHaveAttribute('title', new Date(2000).toISOString());
      await expect(page.locator('#modelUsageNote')).toHaveText('Lifetime | 29 observed calls | 3 models');
      await expect(page.locator('#modelUsage')).not.toContainText('browser-test');
      await expect(page.locator('#lastDetectedModel')).toContainText('unknown-model');
      expect(engine.summary()).toEqual(before);
      const scroll = page.getByRole('region', { name: 'Lifetime per-model usage', exact: true });
      const usageBounds = await scroll.boundingBox();
      expect(usageBounds!.x).toBeGreaterThanOrEqual(0);
      expect(usageBounds!.x + usageBounds!.width).toBeLessThanOrEqual(width);
      expect(await scroll.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
      const observationScroll = page.getByRole('region', { name: 'Observed model calls', exact: true });
      await observationScroll.focus();
      await expect(observationScroll).toBeFocused();
      const observationBounds = await observationScroll.boundingBox();
      expect(observationBounds!.x).toBeGreaterThanOrEqual(0);
      expect(observationBounds!.x + observationBounds!.width).toBeLessThanOrEqual(width);
      expect(await observationScroll.evaluate((element) => getComputedStyle(element).overflowX)).toBe('auto');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await usagePanel.screenshot({ path: testInfo.outputPath(`model-usage-light-${width}.png`) });
      await observationScroll.screenshot({ path: testInfo.outputPath(`model-observations-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await usagePanel.screenshot({ path: testInfo.outputPath(`model-usage-dark-${width}.png`) });
      await observationScroll.screenshot({ path: testInfo.outputPath(`model-observations-dark-${width}.png`) });
      if (width === 390) {
        await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        expect(await scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        const rateBounds = await usage.first().locator('td').last().boundingBox();
        expect(rateBounds!.x).toBeGreaterThanOrEqual(usageBounds!.x);
        expect(rateBounds!.x + rateBounds!.width).toBeLessThanOrEqual(usageBounds!.x + usageBounds!.width + 1);
        await usagePanel.screenshot({ path: testInfo.outputPath(`model-usage-rates-${width}.png`) });
        await scroll.evaluate((element) => { element.scrollLeft = 0; });
        await observationScroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        expect(await observationScroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
        const observationRateBounds = await observations.first().locator('td').last().boundingBox();
        expect(observationRateBounds!.x).toBeGreaterThanOrEqual(observationBounds!.x);
        expect(observationRateBounds!.x + observationRateBounds!.width).toBeLessThanOrEqual(observationBounds!.x + observationBounds!.width + 1);
        await observationScroll.screenshot({ path: testInfo.outputPath(`model-observations-rates-${width}.png`) });
        await observationScroll.evaluate((element) => { element.scrollLeft = 0; });
      }
      await page.emulateMedia({ colorScheme: 'light' });
      await expect(page.locator('#receiverAccepted')).toHaveText('2');
      await expect(page.locator('#receiverExports')).toHaveText('5');
      await expect(page.locator('#receiverLastAccepted')).not.toHaveText('Not received');
      await page.clock.fastForward(65_000);
      await expect(page.locator('#receiverLastAcceptedAge')).toHaveText('1m ago');
      tracking = { ...tracking, receiverHealthScope: 'shared' };
      server.notify();
      await expect(page.locator('#receiverHealthStatus')).toContainText('another VS Code window');
      await expect(page.locator('#receiverHealthMetrics')).toBeHidden();
      tracking = { ...tracking, receiverHealthScope: 'window' };
      server.notify();
      await expect(page.locator('#receiverAccepted')).toBeVisible();
      await expect(page.locator('#receiverAccepted')).toHaveText('2');
      for (const selector of ['.receiverHealth', '.receiverHealthMetrics']) {
        const element = page.locator(selector);
        const bounds = await element.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await healthPanel.screenshot({ path: testInfo.outputPath(`receiver-health-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      await healthPanel.screenshot({ path: testInfo.outputPath(`receiver-health-dark-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByRole('tab', { name: 'Overview', exact: true }).click();
      for (const selector of ['.modelTrackingPanel', '.modelTrackingHead', '.modelTrackingActions', '.modelPricing', '#modelPricingWarning']) {
        const element = page.locator(selector);
        const bounds = await element.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await panel.screenshot({ path: testInfo.outputPath(`model-tracking-${width}.png`) });
      await page.locator('#disconnectModelTracking').click();
      await expect(page.locator('#modelTrackingStatus')).toHaveText('Not connected');
      await expect(page.locator('#lastDetectedModel')).toContainText('unknown-model');
      await expect(page.locator('#connectModelTracking')).toBeVisible();
      await expect(warning).toContainText('Connect model tracking');
      expect(errors).toEqual([]);
    } finally {
      await receiver.close();
      await server.close();
      engine.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`context growth aligns model samples and independent savings at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-context-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(server.url);
      await page.getByRole('tab', { name: 'Models', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Context growth versus savings', exact: true });
      const chart = page.locator('#contextGrowthChart');
      await expect(panel).toBeVisible();
      await expect(page.locator('#contextGrowthEmpty')).toBeVisible();
      await expect(chart).toBeHidden();
      const latest = Date.UTC(2026, 8, 12, 12);
      const base = { ts: latest, tool: 'read_file' as const, label: 'PRIVATE-FILE', strategy: 'read-lifecycle:fresh',
        tokensBefore: 200, tokensAfter: 80, bytesBefore: 800, bytesAfter: 320, linesBefore: 100, linesAfter: 40, durationMs: 1 };
      engine.ledger.record(base);
      engine.ledger.record({ ...base, ts: latest + 1000, tool: 'retrieve_artifact', tokensBefore: 0, tokensAfter: 50 });
      engine.ledger.record({ ...base, ts: latest - 5 * 60_000, tokensBefore: 20, tokensAfter: 30 });
      let sequence = 0;
      const observe = (model: string, endedAt: number, inputTokens?: number, cacheReadInputTokens?: number) => recordModelObservation(engine, {
        traceId: (++sequence).toString(16).padStart(32, '0'), spanId: 'a'.repeat(16), provider: 'github',
        requestModel: model, startedAt: endedAt - 1, endedAt, inputTokens, cacheReadInputTokens,
        conversationId: 'PRIVATE-CONVERSATION',
      });
      observe('first-model', latest - 120_000, 100, 75);
      observe('zero-input', latest - 60_000, 0, 0);
      observe('missing-usage', latest, undefined, undefined);
      observe('inconsistent-cache', latest + 1, 10, 20);
      observe('latest-model', latest + 2, 50, 0);
      const recorded = fs.readFileSync(engine.ledger.path(), 'utf8');
      const before = engine.summary();
      await expect(chart).toBeVisible();
      await expect(page.locator('#contextGrowthEmpty')).toBeHidden();
      await expect(page.locator('#contextWindow')).toContainText('All producers');
      await expect(page.locator('#contextWindow')).toContainText('Time alignment only');
      await expect(page.locator('#contextCoverage')).toHaveText('5 observed calls | Input reported: 4/5 | Cache share available: 2/5');
      await page.locator('#contextCallsDetails > summary').focus();
      await page.locator('#contextCallsDetails > summary').press('Enter');
      const calls = page.locator('#contextObservations tr');
      await expect(calls).toHaveCount(5);
      await expect(calls.first()).toContainText('75.0%');
      await expect(calls.filter({ hasText: 'zero-input' })).toContainText('Not defined (zero input)');
      await expect(calls.filter({ hasText: 'zero-input' }).locator('td').nth(3)).toHaveText('0');
      await expect(calls.filter({ hasText: 'missing-usage' })).toContainText('Not reported');
      await expect(calls.filter({ hasText: 'inconsistent-cache' })).toContainText('Inconsistent counts');
      await expect(calls.last()).toContainText('0.0%');
      await expect(panel).not.toContainText('PRIVATE');
      await page.locator('#contextSavingsDetails > summary').click();
      const intervals = page.locator('#contextSavings tr');
      await expect(intervals).toHaveCount(12);
      await expect(intervals.last().locator('td')).toHaveText([await intervals.last().locator('td').first().textContent() || '', '2', '120', '50', '70']);
      await expect(intervals.nth(10).locator('td').last()).toHaveText('-10');
      await expect.poll(() => chart.evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
        let inputPixels = 0;
        let savedPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index] === 9 && pixels[index + 1] === 105 && pixels[index + 2] === 218 && pixels[index + 3] > 0) inputPixels++;
          if (pixels[index] === 26 && pixels[index + 1] === 127 && pixels[index + 2] === 55 && pixels[index + 3] > 0) savedPixels++;
        }
        return inputPixels > 8 && savedPixels > 20;
      })).toBe(true);
      const initialPlot = await chart.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
      observe('late-arrival', latest - 180_000, 500, 400);
      await expect(calls).toHaveCount(6);
      await expect(calls.first()).toContainText('late-arrival');
      await expect.poll(() => chart.evaluate((node) => (node as HTMLCanvasElement).toDataURL())).not.toBe(initialPlot);
      expect(engine.summary()).toEqual(before);
      expect(fs.readFileSync(engine.ledger.path(), 'utf8').startsWith(recorded)).toBe(true);
      await page.locator('#contextCallsDetails > summary').click();
      await page.locator('#contextSavingsDetails > summary').click();
      await panel.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      const bounds = await chart.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.height).toBe(360);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await chart.hover({ position: { x: 8 + 52 / 60 * (bounds!.width - 16), y: 28 } });
      await expect(chart).toHaveAttribute('title', /late-arrival.*500 input tokens/);
      await page.locator('#contextGrowthTitle').hover();
      await expect(chart).toHaveAttribute('title', '');
      await panel.screenshot({ path: testInfo.outputPath(`context-growth-light-${width}.png`) });
      const lightPlot = await chart.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
      await page.emulateMedia({ colorScheme: 'dark' });
      await expect.poll(() => chart.evaluate((node) => (node as HTMLCanvasElement).toDataURL())).not.toBe(lightPlot);
      await panel.screenshot({ path: testInfo.outputPath(`context-growth-dark-${width}.png`) });
      const originalWidth = await chart.evaluate((node) => (node as HTMLCanvasElement).width);
      await page.setViewportSize({ width: width === 390 ? 1280 : 390, height: 900 });
      await expect.poll(() => chart.evaluate((node) => (node as HTMLCanvasElement).width)).not.toBe(originalWidth);
      await page.reload();
      await page.getByRole('tab', { name: 'Models', exact: true }).click();
      await expect(page.locator('#contextCoverage')).toContainText('6 observed calls');
      expect(errors).toEqual([]);
    } finally {
      engine.dispose();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`catalog gaps and refresh controls work at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-catalog-ui-'));
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = originalNow();
    let requests = 0;
    let failRefresh = false;
    let inputRate = 5;
    let refreshGate = Promise.resolve();
    let finishRefresh: (() => void) | undefined;
    let engine: CompressionEngine;
    try {
      Date.now = () => now;
      globalThis.fetch = async (source, options) => {
        expect(source).toBe('https://models.dev/api.json');
        expect(options?.redirect).toBe('error');
        requests++;
        await refreshGate;
        const model = (input: number) => ({ name: 'Model', modalities: { input: ['text'] }, cost: { input } });
        return failRefresh ? new Response('', { status: 429 }) : new Response(JSON.stringify({
          vendor: { name: 'Vendor', models: { known: model(inputRate), free: model(0) } },
          openai: { name: 'OpenAI', models: { duplicate: model(2) } },
          google: { name: 'Google', models: { duplicate: model(3) } },
        }));
      };
      engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
    }
    engine.compressToolResult({ toolName: 'read_file', cwd: root, text: jestFailureLog(40) });
    for (const [index, model] of ['known', 'free', 'unknown', 'duplicate'].entries()) {
      recordModelObservation(engine, { traceId: (index + 1).toString(16).padStart(32, '0'), spanId: 'a'.repeat(16),
        provider: model === 'duplicate' ? 'github' : 'vendor', requestModel: model,
        startedAt: now, endedAt: now + index, inputTokens: 10, outputTokens: 1,
      });
    }
    const before = engine.summary();
    const recorded = fs.readFileSync(engine.ledger.path(), 'utf8');
    const server = await startDashboardServer(engine, { port: 0, token: 'catalog-browser-test' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.setFixedTime(new Date(now));
      await page.goto(server.url);
      await page.getByRole('tab', { name: 'Models', exact: true }).click();
      const refresh = page.getByRole('button', { name: 'Refresh price catalog', exact: true });
      const rate = (model: string) => page.locator('#modelUsage tr').filter({ has: page.locator('td.label', { hasText: model }) }).locator('td').last();
      await expect(page.locator('#catalogFreshness')).toHaveText('Not cached');
      await expect(page.locator('#catalogAge')).toHaveText('Not cached');
      await expect(page.locator('#catalogRefreshStatus')).toHaveText('No successful fetch yet.');
      await expect(rate('known')).toHaveText('Catalog not loaded');
      refreshGate = new Promise<void>((resolve) => { finishRefresh = resolve; });
      await refresh.click();
      await expect(refresh).toBeDisabled();
      await expect(refresh).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#catalogRefreshStatus')).toHaveText('Refreshing catalog...');
      await expect.poll(() => requests).toBe(1);
      server.notify();
      await refresh.dispatchEvent('click');
      expect(requests).toBe(1);
      refreshGate = Promise.resolve();
      finishRefresh();
      finishRefresh = undefined;
      await expect(refresh).toBeEnabled();
      await expect(page.locator('#catalogFreshness')).toHaveText('Fresh');
      await expect(page.locator('#catalogModelCount')).toHaveText('4');
      await expect(page.locator('#catalogSource')).toHaveAttribute('title', 'https://models.dev/api.json');
      await expect(page.locator('#catalogRefreshStatus')).toContainText('Last successful fetch:');
      await expect(rate('known')).toHaveText('$5 / 1M');
      await expect(rate('free')).toHaveText('$0 / 1M');
      await expect(rate('unknown')).toHaveText('Model not in catalog');
      await expect(rate('duplicate')).toHaveText('Ambiguous model match');
      const cache = fs.readFileSync(path.join(root, 'pricing-cache.json'), 'utf8');
      now += 30_000;
      await page.clock.setFixedTime(new Date(now));
      await expect(page.locator('#catalogAge')).toHaveText('30s');
      now += 2 * 24 * 60 * 60 * 1000;
      await page.clock.setFixedTime(new Date(now));
      server.notify();
      await expect(page.locator('#catalogFreshness')).toHaveText('Stale');
      await expect(page.locator('#catalogAge')).toHaveText('2d');
      await expect(rate('known')).toHaveText('$5 / 1M');
      now += 6 * 24 * 60 * 60 * 1000;
      await page.clock.setFixedTime(new Date(now));
      server.notify();
      await expect(page.locator('#catalogFreshness')).toHaveText('Expired');
      await expect(page.locator('#catalogAge')).toHaveText('8d');
      await expect(rate('known')).toHaveText('Catalog expired');
      await expect(rate('free')).toHaveText('Catalog expired');
      failRefresh = true;
      await refresh.click();
      await expect(page.locator('#catalogRefreshStatus')).toHaveText('Refresh failed: Pricing source returned HTTP 429');
      await expect(refresh).toBeEnabled();
      await expect(rate('known')).toHaveText('Catalog expired');
      expect(fs.readFileSync(path.join(root, 'pricing-cache.json'), 'utf8')).toBe(cache);
      failRefresh = false;
      inputRate = 7;
      await refresh.click();
      await expect(page.locator('#catalogRefreshStatus')).toContainText('Last successful fetch:');
      await expect(page.locator('#catalogFreshness')).toHaveText('Fresh');
      await expect(page.locator('#catalogAge')).toHaveText('0s');
      await expect(rate('known')).toHaveText('$7 / 1M');
      expect(requests).toBe(3);
      await expect(page.locator('#modelObservations tr td:last-child')).toHaveText(['Unavailable', 'Unavailable', 'Unavailable', 'Unavailable']);
      expect(engine.summary()).toEqual(before);
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(recorded);
      const panel = page.locator('[data-panel="models"]');
      const catalog = page.getByRole('region', { name: 'Price catalog', exact: true });
      for (const element of [catalog, page.locator('.catalogHead'), page.locator('.catalogMetrics')]) {
        const bounds = await element.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await panel.screenshot({ path: testInfo.outputPath(`catalog-gaps-light-${width}.png`) });
      await page.emulateMedia({ colorScheme: 'dark' });
      if (width === 390) await page.locator('.modelUsageScroll').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
      await panel.screenshot({ path: testInfo.outputPath(`catalog-gaps-dark-${width}.png`) });
      await page.route('**/api/pricing/refresh?*', (route) => route.fulfill({ status: 503, body: '{}' }));
      await refresh.click();
      await expect(page.locator('#catalogRefreshStatus')).toHaveText('Refresh failed: Catalog refresh could not be completed.');
      await expect(refresh).toBeEnabled();
      await expect(rate('known')).toHaveText('$7 / 1M');
      expect(requests).toBe(3);
      expect(errors).toEqual([]);
    } finally {
      finishRefresh?.();
      engine.dispose();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`utility drawer keeps controls accessible at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-utilities-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    engine.compressCommandOutput({ command: 'npm test', cwd: root, exitCode: 1, stdout: jestFailureLog(40), stderr: '', durationMs: 10 });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(server.url);
      const drawer = page.getByRole('dialog', { name: 'Dashboard settings', exact: true });
      const opener = page.getByRole('button', { name: 'Dashboard settings', exact: true });
      await expect(drawer).toBeHidden();
      await expect(page.locator('#themeMode')).toBeHidden();
      await expect(page.locator('#runHealth')).toBeHidden();
      await expect(page.locator('#configStatus')).toBeHidden();
      await expect(page.locator('.masthead button')).toHaveCount(1);
      await opener.focus();
      await page.keyboard.press('Enter');
      await expect(drawer).toBeVisible();
      await expect(opener).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#closeUtilities')).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      expect(await drawer.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await page.getByLabel('Dashboard theme', { exact: true }).selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      for (const [selector, extension] of [['#shareSnapshotLink', 'md'], ['#shareJsonLink', 'json'], ['#shareCsvLink', 'csv']]) {
        const downloading = page.waitForEvent('download');
        await page.locator(selector).click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe(`slipstream-savings-snapshot.${extension}`);
        expect(await download.failure()).toBeNull();
      }
      await drawer.screenshot({ path: testInfo.outputPath(`utilities-dark-${width}.png`) });
      await page.getByLabel('Dashboard theme', { exact: true }).selectOption('light');
      await page.locator('#runtimeSettings > summary').click();
      await page.getByLabel('Compression profile', { exact: true }).selectOption('conservative');
      await expect.poll(() => engine.getConfig().profile).toBe('conservative');
      await page.locator('#runtimeSettings > summary').click();
      await page.locator('#healthSettings > summary').click();
      await page.getByRole('button', { name: 'Run health check', exact: true }).click();
      await expect(page.locator('#healthMeta')).toHaveText('All critical checks passed.');
      await expect(page.locator('#runHealth')).toBeEnabled();
      const bounds = await drawer.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.locator('.utilityBody').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await drawer.screenshot({ path: testInfo.outputPath(`utilities-light-${width}.png`) });
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(opener).toBeFocused();
      await expect(opener).toHaveAttribute('aria-expanded', 'false');
      await opener.click();
      await expect(page.locator('#config-profile')).toHaveValue('conservative');
      await page.getByRole('button', { name: 'Close dashboard settings', exact: true }).click();
      await expect(drawer).toBeHidden();
      if (width > 420) {
        await opener.click();
        await page.mouse.click(12, 100);
        await expect(drawer).toBeHidden();
        await expect(opener).toBeFocused();
      }
      await page.reload();
      await expect(drawer).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(errors).toEqual([]);
    } finally {
      engine.dispose();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`retrieval avoidance is a main metric at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-retrieval-metric-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(server.url);
      const metric = page.locator('.hero #retrievalAvoidance');
      const reduction = page.getByRole('group', { name: 'Tool-output reduction', exact: true });
      await expect(reduction).toBeVisible();
      await expect(reduction.locator('#pctLabel')).toHaveText('Tool-output reduction');
      await expect(reduction.locator('#pct')).toHaveText('0%');
      await expect(page.getByText('Tokens removed from tool output before it reached the model.', { exact: false })).toHaveCount(0);
      await expect(page.getByText('Nothing is lost', { exact: false })).toHaveCount(0);
      await expect(metric).toHaveText('N/A');
      const compressed = engine.compressCommandOutput({
        command: 'npm test', cwd: root, exitCode: 1, stdout: jestFailureLog(40), stderr: '', durationMs: 10,
      });
      await expect(metric).toHaveText('100.0%');
      await expect(page.locator('#costLabel')).toHaveText('est. saved');
      const compression = engine.ledger.recent(1)[0]!;
      for (let index = 1; index < 410; index++) engine.ledger.record(compression);
      const marker = parseMarkers(compressed.text)[0]!;
      expect(marker).toBeDefined();
      for (let index = 0; index < 11; index++) {
        engine.retrieve({ id: marker.id, startLine: marker.startLine, endLine: marker.startLine, maxLines: 1 });
      }
      expect(engine.summary()).toMatchObject({ compressions: 410, retrievals: 11 });
      await expect(metric).toHaveText('97.3%');
      await expect(reduction.locator('#pct')).toHaveText(engine.summary().percentSaved.toFixed(0) + '%');
      await expect(page.locator('#retrieval')).toHaveCount(0);
      await expect(page.getByText('The model expanded', { exact: false })).toHaveCount(0);
      const hero = page.locator('.hero');
      expect(await hero.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await hero.locator('.stat').evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth))).toBe(true);
      await hero.screenshot({ path: testInfo.outputPath(`retrieval-metric-${width}.png`) });
      const retrieval = engine.ledger.recent(1)[0]!;
      for (let index = 11; index < 411; index++) engine.ledger.record(retrieval);
      await expect(metric).toHaveText('0.0%');
      expect(errors).toEqual([]);
    } finally {
      engine.dispose();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`native chat observations update live at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-native-chat-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(server.url);
      await expect(page.locator('#chats')).toHaveText('0');
      const config = createChatHookConfig(root, path.resolve('packages/extension/dist/chat-hook.js'), root);
      const hook = config.hooks.UserPromptSubmit[0];
      for (const input of [
        { hook_event_name: 'UserPromptSubmit', session_id: 'native-browser-test', prompt: 'private input' },
        { hook_event_name: 'PostToolUse', session_id: 'native-browser-test', tool_name: 'read_file', tool_response: 'private output' },
      ]) {
        const result = spawnSync(hook.command, { shell: true, cwd: hook.cwd, env: { ...process.env, ...hook.env }, input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('{}');
      }
      await expect(page.locator('#chats')).toHaveText('1');
      await expect(page.locator('#observedTools')).toHaveText('1');
      expect(engine.summary()).toMatchObject({ calls: 0, compressions: 0, tokensSaved: 0, estimatedCostSavedUsd: 0 });
      const hero = page.locator('.hero');
      expect(await hero.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await hero.screenshot({ path: testInfo.outputPath(`native-chat-${width}.png`) });
      await page.getByRole('tab', { name: 'Activity', exact: true }).click();
      await page.getByRole('heading', { name: 'Session timeline', exact: true }).click();
      await expect(page.locator('#timeline')).toContainText('Observed tool: read_file');
      await expect(page.locator('#timeline')).toContainText('No compression or savings attributed');
      await expect(page.locator('#timeline')).not.toContainText('private');
      await page.reload();
      await expect(page.locator('#chats')).toHaveText('1');
      await expect(page.locator('#observedTools')).toHaveText('1');
      expect(errors).toEqual([]);
    } finally {
      engine.dispose();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`automatic model pricing updates in the background at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-pricing-ui-'));
    const originalFetch = globalThis.fetch;
    let requests = 0;
    let failRefresh = false;
    globalThis.fetch = async () => {
      requests++;
      return failRefresh ? new Response('', { status: 429 }) : new Response(JSON.stringify({ vendor: { name: 'Vendor', models: {
        model: { name: 'Model', modalities: { input: ['text'] }, cost: { input: 5 } },
        second: { name: 'Second model', modalities: { input: ['text'] }, cost: { input: 9 } },
      } } }));
    };
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } } });
    globalThis.fetch = originalFetch;
    await engine.pricing.refresh();
    const producers: CompressionEngine[] = [];
    const observe = (id: string, name = id) => {
      const producer = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { pricing: { mode: 'automatic' } }, detectedModel: { id, vendor: 'vendor', name } });
      producers.push(producer);
      producer.recordModelDetected();
      return producer;
    };
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    const priceRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/pricing') priceRequests.push(request.url()); });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(server.url);
      await expect(page.locator('#lastDetectedModel')).toHaveText('Not detected');
      await expect(page.locator('#detectedInputRate')).toHaveText('Unavailable');
      await expect(page.locator('#modelPricingWarning')).toContainText('Enable CLI model tracking');
      await expect(page.locator('#cliTrackingSetup')).toBeVisible();
      await expect(page.locator('#connectModelTracking')).toBeVisible();
      await expect(page.locator('#pricingSettings, #pricingControls')).toHaveCount(0);
      await expect(page.locator('#config-usdPerMillionTokens')).toHaveValue('3');
      const fallbackOnly = observe('unknown-fallback-model', 'Unknown fallback model');
      fallbackOnly.compressToolResult({ toolName: 'read_file', cwd: root, text: jestFailureLog(40) });
      await expect(page.locator('#costLabel')).toHaveText('est. saved @ $3/1M');
      engine.ledger.clear();
      const toolStartedAt = Date.now();
      engine.ledger.withToolCallContext({ source: 'vscode', sessionId: 'native-test-session',
        toolCallId: 'native-call__vscode-1', toolName: 'slipstream_readFile' }, () => {
        engine.compressToolResult({ toolName: 'read_file', cwd: root, text: jestFailureLog(41) });
      });
      const toolEndedAt = Date.now();
      await expect(page.locator('#costLabel')).toHaveText('est. saved @ $3/1M');
      recordToolObservation(engine, { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: 'c'.repeat(16),
        conversationId: 'native-test-host', chatSessionId: 'native-test-host', startedAt: toolStartedAt, endedAt: toolEndedAt,
        success: true, toolCallId: 'native-call', toolName: 'slipstream_readFile' });
      recordModelObservation(engine, { traceId: 'a'.repeat(32), spanId: 'd'.repeat(16), parentSpanId: 'c'.repeat(16),
        conversationId: 'native-test-session', chatSessionId: 'native-test-host', startedAt: toolStartedAt - 10, endedAt: toolStartedAt,
        provider: 'vendor', requestModel: 'model', responseToolCalls: [{ id: 'native-call', name: 'slipstream_readFile' }] });
      const attributedCost = engine.summary().tokensSaved * 5 / 1_000_000;
      expect(engine.summary().cost).toMatchObject({ knownUsd: attributedCost, fallbackUsd: 0, pricedEvents: 1, unpricedEvents: 0 });
      await expect(page.locator('#costLabel')).toHaveText('est. saved');
      await expect(page.locator('#cost')).toHaveText('$' + attributedCost.toFixed(2));
      await page.screenshot({ path: testInfo.outputPath(`attributed-pricing-${width}.png`), fullPage: true });
      engine.ledger.clear();
      const first = observe('model', 'First model');
      await expect(page.locator('#lastDetectedModel')).toHaveText('First model (vendor/model)');
      await expect(page.locator('#detectedInputRate')).toHaveText('$5 / 1M input');
      await expect(page.locator('#modelPricingWarning')).toBeHidden();
      first.compressToolResult({ toolName: 'read_file', cwd: root, text: jestFailureLog(40) });
      const recordedCost = engine.summary().estimatedCostSavedUsd;
      await expect(page.locator('#costLabel')).toHaveText('est. saved');
      observe('second', 'Second model');
      await expect(page.locator('#lastDetectedModel')).toHaveText('Second model (vendor/second)');
      await expect(page.locator('#detectedInputRate')).toHaveText('$9 / 1M input');
      await page.reload();
      await expect(page.locator('#lastDetectedModel')).toHaveText('Second model (vendor/second)');
      expect(requests).toBe(1);
      failRefresh = true;
      await engine.pricing.refresh(true);
      await expect(page.locator('#pricingStatus')).toContainText('429');
      await expect(page.locator('#detectedInputRate')).toHaveText('$9 / 1M input');
      expect(engine.summary().estimatedCostSavedUsd).toBe(recordedCost);
      const unknown = observe('unknown-model-with-a-long-provider-specific-identifier', 'Unknown model');
      await expect(page.locator('#lastDetectedModel')).toContainText('Unknown model');
      await expect(page.locator('#detectedInputRate')).toHaveText('Unavailable');
      unknown.compressToolResult({ toolName: 'read_file', cwd: root, text: jestFailureLog(45) });
      expect(engine.summary().cost.knownUsd).toBe(recordedCost);
      const missingRateTokens = engine.summary().cost.unpricedTokens;
      expect(missingRateTokens).toBeGreaterThan(0);
      const knownSubtotal = engine.summary().cost.knownUsd;
      const estimated = (rate: number) => knownSubtotal + missingRateTokens * rate / 1_000_000;
      expect(engine.summary().estimatedCostSavedUsd).toBeCloseTo(estimated(3));
      await expect(page.locator('#cost')).toHaveText('$' + estimated(3).toFixed(2));
      await expect(page.locator('#costLabel')).toHaveText('est. saved (mixed rates)');
      await expect(page.locator('#modelPricingWarning')).toContainText('default $3 / 1M tokens');
      await page.screenshot({ path: testInfo.outputPath(`fallback-estimate-${width}.png`), fullPage: true });
      const recorded = fs.readFileSync(engine.ledger.path(), 'utf8');
      await page.getByRole('button', { name: 'Dashboard settings', exact: true }).click();
      await page.locator('#runtimeSettings > summary').click();
      for (const rate of [7.125, 0]) {
        await page.locator('#config-usdPerMillionTokens').fill(String(rate));
        await page.locator('#config-usdPerMillionTokens').dispatchEvent('change');
        await expect.poll(() => engine.getConfig().usdPerMillionTokens).toBe(rate);
        await expect(page.locator('#cost')).toHaveText('$' + estimated(rate).toFixed(2));
        expect(engine.summary().cost.knownUsd).toBe(knownSubtotal);
      }
      await page.getByRole('button', { name: 'Close dashboard settings', exact: true }).click();
      await page.reload();
      await expect(page.locator('#cost')).toHaveText('$' + knownSubtotal.toFixed(2));
      await expect(page.locator('#config-usdPerMillionTokens')).toHaveValue('0');
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(recorded);
      expect(priceRequests).toHaveLength(0);
      for (const selector of ['.modelPricing', '#pricingStatus']) {
        const element = page.locator(selector);
        await element.scrollIntoViewIfNeeded();
        const bounds = await element.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      }
      await page.locator('.modelTrackingPanel').screenshot({ path: testInfo.outputPath(`automatic-pricing-${width}.png`) });
      expect(errors).toEqual([]);
    } finally {
      for (const producer of producers) producer.dispose();
      engine.dispose();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`synthetic benchmark comparison works at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-benchmark-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(server.url);
      await page.getByRole('tab', { name: 'History', exact: true }).click();
      await expect(page.getByRole('columnheader', { name: 'Synthetic benchmark', exact: true })).toBeVisible();
      await expect(page.locator('#benchmarkMeta')).toContainText('seed 20260907');
      await expect(page.locator('#benchmarkMeta')).toContainText('balanced profile');
      await expect(page.locator('#comparison tr')).toHaveCount(4);
      const saved = page.locator('#comparison tr').filter({ hasText: 'Tokens saved' });
      await expect(saved.locator('td').nth(1)).toHaveText('N/A');
      await expect(saved.locator('td').nth(2)).toHaveText('0');
      await expect(saved.locator('td').nth(3)).toHaveText('N/A');
      const reference = await saved.locator('td').nth(4).innerText();
      expect(reference.replace(/\D/g, '')).toBe(String(BENCHMARK_REFERENCE.tokensSaved));
      await expect(page.locator('#comparison tr').filter({ hasText: 'Retrieval rate' }).locator('td').nth(4)).toHaveText('N/A');
      await expect(page.locator('#comparison tr').filter({ hasText: 'Compression overhead' }).locator('td').nth(4)).toHaveText('N/A');
      expect(engine.summary().calls).toBe(0);
      await page.getByRole('button', { name: 'Save current as baseline', exact: true }).click();
      await expect(saved.locator('td').nth(1)).toHaveText('0');
      await expect(saved.locator('td').nth(3)).toHaveText('0');
      await expect(saved.locator('td').nth(4)).toHaveText(reference);
      await expect(page.locator('#comparisonEmpty')).toBeHidden();
      const configResponse = await page.request.post(new URL('api/config', server.url).href, { data: { profile: 'aggressive' } });
      expect(configResponse.ok()).toBe(true);
      await page.reload();
      await page.getByRole('tab', { name: 'History', exact: true }).click();
      await expect(page.locator('#benchmarkMeta')).toContainText('balanced profile');
      await expect(saved.locator('td').nth(4)).toHaveText(reference);
      const scroll = page.locator('[data-panel="history"] .comparisonScroll');
      await scroll.scrollIntoViewIfNeeded();
      const bounds = await scroll.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await scroll.screenshot({ path: testInfo.outputPath(`benchmark-${width}.png`) });
      if (width < 620) {
        await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
        await scroll.screenshot({ path: testInfo.outputPath(`benchmark-${width}-right.png`) });
      }
      expect(errors).toEqual([]);
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test(`compression profiles work at ${width}px`, async ({ page }, testInfo) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-profile-ui-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const server = await startDashboardServer(engine, { port: 0 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(server.url);
      await page.getByRole('button', { name: 'Dashboard settings', exact: true }).click();
      await page.locator('#runtimeSettings > summary').click();
      const profile = page.getByLabel('Compression profile', { exact: true });
      const limit = page.locator('#config-maxFileLines');
      await expect(profile).toHaveValue('balanced');
      await expect(limit).toHaveValue('1200');
      await profile.selectOption('aggressive');
      await expect(limit).toHaveValue('600');
      await profile.selectOption('conservative');
      await expect(limit).toHaveValue('2400');
      await limit.fill('900');
      engine.recordChatSubmitted();
      const summary = await (await page.request.get(new URL('api/summary', server.url).href)).json();
      await page.evaluate((data) => window.dispatchEvent(new MessageEvent('message', { data })), summary);
      await expect(limit).toHaveValue('900');
      await limit.blur();
      await expect.poll(() => engine.getConfig().maxFileLines).toBe(900);
      await profile.selectOption('balanced');
      await expect.poll(() => engine.getConfig().profile).toBe('balanced');
      await page.reload();
      await page.getByRole('button', { name: 'Dashboard settings', exact: true }).click();
      await page.locator('#runtimeSettings > summary').click();
      await expect(profile).toHaveValue('balanced');
      await expect(limit).toHaveValue('900');
      await profile.scrollIntoViewIfNeeded();
      const bounds = await profile.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.locator('#configStatus').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.locator('#configStatus').screenshot({ path: testInfo.outputPath(`profiles-${width}.png`) });
      expect(errors).toEqual([]);
    } finally {
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('dashboard renders audit, inspector, diff mode and exact model payload', async ({ page }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-dashboard-smoke-'));
  let server: DashboardServerHandle | undefined;

  try {
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { maxFileLines: 20 } });
    const command = engine.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: 'npm warn using smoke fixture',
      durationMs: 2400,
    });
    const marker = parseMarkers(command.text)[0];
    expect(marker).toBeDefined();
    engine.retrieve({
      id: marker!.id,
      startLine: marker!.startLine,
      endLine: marker!.startLine,
      maxLines: 1,
    });

    const filePath = path.join(root, 'src', 'catalog.ts');
    engine.compressFileRead({ path: filePath, content: sourceFile(35, 'alpha') });
    engine.compressFileRead({ path: filePath, content: sourceFile(35, 'alpha') });

    server = await startDashboardServer(engine, { port: 0 });

    await page.goto(server.url);
    await expect(page.locator('#shareSnapshotLink')).toHaveAttribute('href', /api\/report\.md/);
    await expect(page.locator('#shareJsonLink')).toHaveAttribute('href', /api\/report\.json/);
    await expect(page.locator('#shareCsvLink')).toHaveAttribute('href', /api\/report\.csv/);
    await expect(page.locator('#connectionStatus')).toContainText('Connected');
    await page.getByRole('button', { name: 'Dashboard settings', exact: true }).click();
    await expect(page.locator('#themeMode')).toHaveValue('system');
    await page.locator('#themeMode').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await page.getByRole('button', { name: 'Dashboard settings', exact: true }).click();
    await expect(page.locator('#themeMode')).toHaveValue('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#themeMode').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#runtimeSettings > summary').click();
    await expect(page.getByRole('heading', { name: 'Runtime config' })).toBeVisible();
    await expect(page.locator('#configStatus')).toContainText('Max file read');
    await expect(page.locator('#configStatus')).toContainText('20 lines');
    await page.locator('#config-maxFileLines').fill('60');
    await page.locator('#config-maxFileLines').blur();
    await expect(page.locator('#configStatus')).toContainText('60 lines');
    await page.locator('#config-compressLogs').uncheck();
    await expect(page.locator('#configStatus')).toContainText('Log compressionOff');
    const configResponse = await page.request.get(`${server.url}api/summary?t=`);
    const configSummary = await configResponse.json();
    expect(configSummary.config.maxFileLines).toBe(60);
    expect(configSummary.config.compressLogs).toBe(false);
    await page.getByRole('button', { name: 'Close dashboard settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Token flow' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Traffic' })).toBeVisible();
    await expect(page.locator('#trafficStatus')).toContainText('Connected dashboard views');
    await expect(page.locator('#trafficStatus')).toContainText('Recently active sessions');
    await expect(page.locator('#trafficStatus')).toContainText('Recorded tool operations');
    await expect(page.locator('#trafficStatus .proofItem').filter({ hasText: 'Recorded tool operations' }).locator('.v')).toHaveText('4');
    await expect(page.locator('#trafficStatus .proofItem')).toHaveCount(3);
    await expect(page.locator('#trafficStatus')).not.toContainText('Dashboard host');
    await expect(page.locator('#workspaceAttributionWindow')).toContainText('Most recent 40 tool events');
    await expect(page.locator('#tokenFlowWindow')).toContainText('not lifetime totals');
    await expect(page.getByRole('heading', { name: 'Workspace attribution' })).toBeVisible();
    await expect(page.locator('#workspaceAttribution')).toContainText(path.basename(root));
    await expect(page.locator('#tokenFlow')).toContainText('Raw tool output');
    await expect(page.locator('#tokenFlow')).toContainText('Net saved after retrieval');
    await expect(page.getByRole('heading', { name: 'Judge flow' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Evidence' }).click();
    await expect(page.getByRole('heading', { name: 'Waste removed' })).toBeVisible();
    await expect(page.locator('#wasteSignals')).toContainText('Build and test noise collapsed');
    await expect(page.getByRole('heading', { name: 'Outcome reasons' })).toBeVisible();
    await expect(page.locator('#outcomeReasons')).toContainText('Compressed');
    await expect(page.locator('#outcomeReasons')).toContainText('Retrieved omitted content');
    await expect(page.getByRole('heading', { name: 'Strategy timing' })).toBeVisible();
    await expect(page.locator('#timingBreakdown')).toContainText('Log compression');
    await expect(page.locator('#timingBreakdown')).toContainText('ms');
    await expect(page.getByRole('heading', { name: 'Why this is safe' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Storage' }).click();
    await expect(page.getByRole('heading', { name: 'Retrieval audit' })).toBeVisible();
    await expect(page.locator('#retrievalAuditCallout')).toContainText('never needed');
    expect(await page.locator('#retrievalAudit tr').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('#retrievalAudit')).toContainText('1 line(s) / 1 marker(s)');
    await expect(page.locator('#retrievalAudit')).toContainText('marker(s) stayed compressed');
    await expect(page.getByRole('heading', { name: 'Retrieval lifecycle' })).toBeVisible();
    await expect(page.locator('#retrievalLifecycle')).toContainText('Shown to model');
    await expect(page.locator('#retrievalLifecycle')).toContainText('Retrieved by grep');
    await expect(page.locator('#retrievalLifecycle')).toContainText('Still retrievable');
    await expect(page.getByRole('heading', { name: 'Reuse health' })).toBeVisible();
    await expect(page.locator('#reuseHealth')).toContainText('Markers emitted');
    await expect(page.locator('#reuseHealth')).toContainText('Repeat-read hits');
    await expect(page.locator('#reuseHealth')).toContainText('Artifact entries');
    await expect(page.locator('#reuseHealth')).toContainText('Artifact storage');
    await page.getByRole('tab', { name: 'Activity' }).click();
    await page.getByRole('heading', { name: 'By tool' }).click();
    await expect(page.locator('#tools')).toContainText('run_command');
    await page.getByRole('heading', { name: 'Session timeline' }).click();
    await expect(page.locator('#timeline')).toContainText('Compressed');
    await expect(page.getByRole('heading', { name: 'Outputs' })).toBeVisible();
    await expect(page.locator('#outputTabs')).toContainText('Global outputs');
    await expect(page.locator('#outputTabs')).toContainText('This session');
    await expect(page.locator('#outputMeta')).toContainText('Global outputs:');

    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'Lifetime' })).toBeVisible();
    await expect(page.locator('#lifetimeTotals')).toContainText('Tokens saved');
    await expect(page.locator('#lifetimeTotals')).toContainText('Session panels show');
    await expect(page.getByRole('heading', { name: 'Daily savings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Compare' })).toBeVisible();
    await expect(page.locator('#baselineMeta')).toContainText('No baseline saved yet');
    await page.getByRole('button', { name: 'Save current as baseline' }).click();
    await expect(page.locator('#baselineMeta')).toContainText('Baseline saved');
    await expect(page.locator('#comparison')).toContainText('Tokens saved');

    await expect(page.getByRole('heading', { name: 'Cost attribution' })).toBeVisible();
    await expect(page.locator('#costAttribution')).toContainText('Net saved');
    await expect(page.locator('#costAttributionNote')).toContainText('Standard uncached input estimate');
    await expect(page.locator('#costAttributionNote')).toContainText('default-rate net estimate');
    await expect(page.locator('#history')).toContainText('%');

    await page.getByRole('tab', { name: 'Activity' }).click();
    const commandEvent = buildSummaryPayload(engine).events.find((event) => event.tool === 'run_command')!;
    const retrievalEvent = engine.recentEvents().find((event) => event.tool === 'retrieve_artifact')!;
    engine.ledger.record({ ...retrievalEvent, ts: commandEvent.ts });
    await expect(page.locator('#events tr.event')).toHaveCount(5);
    await page.locator('#events tr.event').filter({ hasText: '$ npm test' }).first().click();
    await expect(page.getByRole('heading', { name: 'What was removed' })).toBeVisible();
    await expect(page.locator('#modelPayloadMeta')).toContainText('Exact payload:');
    await expect(page.locator('#dAfter')).toContainText('retrieve_artifact');

    await page.locator('#diffMode').click();
    await expect(page.locator('#diffView')).toBeVisible();
    await expect(page.locator('#sideBySideView')).toBeHidden();
    await expect(page.locator('#diffSummary')).toContainText('Raw vs compressed:');
    await expect(page.locator('#diffBody')).toContainText('Model received:');

    const payloadUrl = await page.locator('#modelPayloadLink').getAttribute('href');
    expect(payloadUrl).toContain('api/model-payload?');
    const target = new URL(payloadUrl!, server.url);
    expect(target.searchParams.get('eventId')).toBe(commandEvent.eventId);
    const payload = await page.request.get(target.toString());
    expect(payload.status()).toBe(200);
    expect(await payload.text()).toBe(command.text);
  } finally {
    await server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});