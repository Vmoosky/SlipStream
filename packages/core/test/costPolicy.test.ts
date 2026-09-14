import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assessCostPolicy, costPolicyPermissions, validateCostPolicy, type CostPolicyContext } from '../src/costPolicy.js';
import { CompressionEngine } from '../src/engine.js';
import { buildSummaryPayload } from '../src/dashboard.js';
import { parseConfigPatch } from '../src/dashboardServer.js';
import { choosePolicyProfile, planOwnedCall, recommendPolicyModel, selectPolicyModel, type PolicyCandidate } from '../src/ownedPolicy.js';

describe('cost policy validation', () => {
  it('validates and copies optional ordered pressure thresholds without changing defaults', () => {
    expect(validateCostPolicy().pressureThresholds).toBeUndefined();
    const pressureThresholds = Object.freeze({ balanced: 0.4, aggressive: 0.75 });
    const policy = validateCostPolicy({ version: 1, mode: 'off', pressureThresholds: new Proxy(pressureThresholds, {}) });
    expect(policy.pressureThresholds).toEqual(pressureThresholds);
    expect(policy.pressureThresholds).not.toBe(pressureThresholds);
    expect(() => structuredClone(policy)).not.toThrow();
    for (const invalid of [null, [], {}, { balanced: 0.5 }, { balanced: '0.5', aggressive: 0.8 },
      { balanced: -0.1, aggressive: 0.8 }, { balanced: 0.5, aggressive: 1.1 }, { balanced: 0.8, aggressive: 0.5 },
      { balanced: 0.5, aggressive: 0.5 }, { balanced: NaN, aggressive: 0.8 }, { balanced: 0.5, aggressive: Infinity },
      { balanced: 0.5, aggressive: 0.8, unknown: true }]) {
      expect(() => validateCostPolicy({ version: 1, mode: 'off', pressureThresholds: invalid })).toThrow();
    }
    expect(validateCostPolicy({ version: 1, mode: 'off', pressureThresholds: { balanced: 0, aggressive: 1 } }).pressureThresholds).toEqual({ balanced: 0, aggressive: 1 });
  });

  it('inherits workspace pressure thresholds and prevents task overrides from postponing them', () => {
    const context = { host: 'owned-chat' as const, scope: 'task' as const };
    expect(costPolicyPermissions(undefined, context).pressureThresholds).toEqual({ balanced: 0.5, aggressive: 0.8 });
    const policy = validateCostPolicy({ version: 1, mode: 'automatic-owned-request', pressureThresholds: { balanced: 0.4, aggressive: 0.75 } });
    expect(costPolicyPermissions(policy, context).pressureThresholds).toEqual(policy.pressureThresholds);
    expect(costPolicyPermissions(policy, { ...context, taskPolicy: validateCostPolicy() }).pressureThresholds).toEqual(policy.pressureThresholds);
    expect(costPolicyPermissions(policy, { ...context, taskPolicy: { ...policy, pressureThresholds: { balanced: 0.6, aggressive: 0.9 } } }).pressureThresholds).toEqual(policy.pressureThresholds);
    expect(costPolicyPermissions(policy, { ...context, taskPolicy: { ...policy, pressureThresholds: { balanced: 0.2, aggressive: 0.6 } } }).pressureThresholds).toEqual({ balanced: 0.2, aggressive: 0.6 });
  });

  it('defaults to off without enabling any allowed model', () => {
    expect(validateCostPolicy()).toEqual({
      version: 1, mode: 'off', allowedModels: [],
      allowedCompressionProfiles: ['conservative', 'balanced', 'aggressive'], budgetUnit: 'tokens',
    });
  });

  it('copies primitive fields and lists from configuration proxies', () => {
    const model = Object.freeze({ vendor: 'copilot', id: 'model-1' });
    const raw = new Proxy(Object.freeze({
      version: 1, mode: 'recommend-only', allowedModels: [new Proxy(model, {})],
      allowedCompressionProfiles: ['balanced'], budgetUnit: 'reference-usd',
    }), {});
    const policy = validateCostPolicy(raw);
    expect(policy).toEqual(raw);
    expect(() => structuredClone(policy)).not.toThrow();
    policy.allowedModels[0]!.id = 'changed';
    policy.allowedCompressionProfiles.push('aggressive');
    expect(model.id).toBe('model-1');
    expect(raw.allowedCompressionProfiles).toEqual(['balanced']);
  });

  it('accepts optional per-task token budgets and fractional reference-dollar budgets', () => {
    expect(validateCostPolicy({ version: 1, mode: 'recommend-only', taskBudget: 0 }).taskBudget).toBe(0);
    expect(validateCostPolicy({ version: 1, mode: 'recommend-only', taskBudget: 4000 }).taskBudget).toBe(4000);
    expect(validateCostPolicy({ version: 1, mode: 'recommend-only', budgetUnit: 'reference-usd', taskBudget: 0.25 }).taskBudget).toBe(0.25);
  });

  it('validates automatic controls without silently enabling model selection', () => {
    expect(validateCostPolicy().modelSelection).toBeUndefined();
    expect(validateCostPolicy({ version: 1, mode: 'automatic-owned-request', modelSelection: 'policy', outputTokenAllowance: 512 })).toMatchObject({ modelSelection: 'policy', outputTokenAllowance: 512 });
    for (const outputTokenAllowance of [0, -1, 1.5, 32769, NaN, null, '100']) expect(() => validateCostPolicy({ version: 1, mode: 'off', outputTokenAllowance })).toThrow();
    expect(() => validateCostPolicy({ version: 1, mode: 'off', modelSelection: 'anything' })).toThrow();
  });

  it.each([null, -1, 1.5, '1000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid token budget %#', (taskBudget) => {
    expect(() => validateCostPolicy({ version: 1, mode: 'recommend-only', taskBudget })).toThrow('Invalid task budget');
  });

  it.each([
    null, [], {}, { version: 2, mode: 'off' }, { version: 1, mode: 'automatic' },
    { version: 1, mode: 'off', unexpected: true },
    { version: 1, mode: 'off', budgetUnit: 'usd' }, { version: 1, mode: 'off', budgetUnit: null },
    { version: 1, mode: 'off', allowedModels: null }, { version: 1, mode: 'off', allowedModels: ['model-1'] },
    { version: 1, mode: 'off', allowedModels: [{ vendor: 'copilot', id: 'model-1', prompt: 'private' }] },
    { version: 1, mode: 'off', allowedModels: [{ vendor: 'copilot', id: 'model\n1' }] },
    { version: 1, mode: 'off', allowedModels: [{ vendor: 'copilot', id: 'model-1' }, { vendor: 'copilot', id: 'model-1' }] },
    { version: 1, mode: 'off', allowedCompressionProfiles: [] },
    { version: 1, mode: 'off', allowedCompressionProfiles: null },
    { version: 1, mode: 'off', allowedCompressionProfiles: ['balanced', 'balanced'] },
    { version: 1, mode: 'off', allowedCompressionProfiles: ['unknown'] },
  ])('rejects invalid configuration %#', (value) => {
    expect(() => validateCostPolicy(value)).toThrow();
  });
});

describe('cost policy capabilities and precedence', () => {
  const model = { vendor: 'copilot', id: 'model-1' };
  const automatic = validateCostPolicy({ version: 1, mode: 'automatic-owned-request', allowedModels: [model] });
  const owned: CostPolicyContext = { host: 'owned-chat', scope: 'task', profile: 'balanced' };

  it('keeps all new actions off by default', () => {
    const result = assessCostPolicy(undefined, owned);
    expect(result.effectiveMode).toBe('off');
    expect(result.decisions.every((decision) => decision.status === 'off')).toBe(true);
  });

  it.each(['native-copilot', 'external-tools'] as const)('reports %s as advisory rather than owned routing', (host) => {
    const result = assessCostPolicy(automatic, { host, scope: 'workspace' });
    expect(result.capabilities).toMatchObject({ ownedModelRequests: false, automaticModelSelection: false, budgetEnforcement: false });
    expect(result.effectiveMode).toBe('recommend-only');
    expect(result.decisions.every((decision) => decision.status === 'advisory' && decision.reason.includes('does not own'))).toBe(true);
  });

  it('distinguishes an owned host from an implemented automatic executor', () => {
    const result = assessCostPolicy(automatic, owned);
    expect(result.requestedMode).toBe('automatic-owned-request');
    expect(result.capabilities.ownedModelRequests).toBe(true);
    expect(result.decisions.every((decision) => decision.status === 'advisory' && decision.reason.includes('not implemented'))).toBe(true);
  });

  it('enables automatic actions only for an explicitly equipped owned host', () => {
    const result = assessCostPolicy(automatic, { ...owned, automaticExecutors: true });
    expect(result.effectiveMode).toBe('automatic-owned-request');
    expect(result.decisions.every((decision) => decision.status === 'automatic')).toBe(true);
    expect(result.capabilities).toMatchObject({ automaticModelSelection: true, budgetEnforcement: true, adaptiveCompression: true });
    for (const host of ['native-copilot', 'external-tools'] as const) {
      expect(assessCostPolicy(automatic, { ...owned, host, automaticExecutors: true })).toMatchObject({
        effectiveMode: 'recommend-only', capabilities: { ownedModelRequests: false, automaticModelSelection: false },
      });
    }
    expect(assessCostPolicy({ ...automatic, mode: 'recommend-only' }, { ...owned, automaticExecutors: true }).effectiveMode).toBe('recommend-only');
    expect(assessCostPolicy(undefined, { ...owned, automaticExecutors: true }).effectiveMode).toBe('off');
    expect(assessCostPolicy(automatic, { ...owned, automaticExecutors: true, constraints: { allowAutomation: false } }).effectiveMode).toBe('recommend-only');
    expect(assessCostPolicy(automatic, { ...owned, automaticExecutors: true, pinnedModel: model }).decisions[0]).toMatchObject({ status: 'blocked' });
    expect(assessCostPolicy(automatic, { ...owned, scope: 'workspace', automaticExecutors: true }).effectiveMode).toBe('recommend-only');
    expect(assessCostPolicy(automatic, { ...owned, automaticExecutors: true, constraints: { allowedCompressionProfiles: ['conservative'] } }).decisions[1]?.status).toBe('automatic');
  });

  it('retains user pins and makes a disallowed pin explicit without substitution', () => {
    const permitted = assessCostPolicy(automatic, { ...owned, pinnedModel: model });
    expect(permitted.decisions[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('retained') });
    const conflict = assessCostPolicy(automatic, { ...owned, pinnedModel: { ...model, id: 'other' } });
    expect(conflict.decisions[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('conflicts') });
  });

  it('intersects managed restrictions instead of allowing task or workspace policy to override them', () => {
    const result = assessCostPolicy(automatic, {
      ...owned, taskPolicy: automatic,
      constraints: { allowAutomation: false, allowedModels: [], allowedCompressionProfiles: ['conservative'] },
    });
    expect(result.decisions.map((decision) => decision.status)).toEqual(['blocked', 'blocked', 'advisory']);
    expect(result.decisions[2]?.reason).toContain('Managed constraints');
    expect(assessCostPolicy(automatic, { ...owned, constraints: { allowedCompressionProfiles: [] } }).decisions[1]?.status).toBe('blocked');
  });

  it('does not permit a task to widen workspace permissions or opt in an off workspace', () => {
    const taskPolicy = validateCostPolicy({ ...automatic, allowedModels: [{ ...model, id: 'other' }], allowedCompressionProfiles: ['aggressive'] });
    const workspace = validateCostPolicy({ ...automatic, allowedCompressionProfiles: ['balanced'] });
    expect(assessCostPolicy(workspace, { ...owned, taskPolicy }).decisions.slice(0, 2).map((decision) => decision.status)).toEqual(['blocked', 'blocked']);
    expect(assessCostPolicy(undefined, { ...owned, taskPolicy }).effectiveMode).toBe('off');
    expect(assessCostPolicy({ ...automatic, mode: 'recommend-only' }, { ...owned, taskPolicy: automatic }).decisions[2]?.reason).toContain('Recommend-only');
  });

  it('rejects a task budget unit conflict without inventing enforcement', () => {
    const taskPolicy = validateCostPolicy({ ...automatic, budgetUnit: 'reference-usd' });
    expect(assessCostPolicy(automatic, { ...owned, taskPolicy }).decisions[2]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('units conflict') });
  });

  it('allows a task to lower but not widen a workspace budget, without enabling enforcement', () => {
    const workspace = { ...automatic, taskBudget: 1000 };
    expect(assessCostPolicy(workspace, owned).taskBudget).toBe(1000);
    expect(assessCostPolicy(workspace, { ...owned, taskPolicy: automatic }).taskBudget).toBe(1000);
    expect(assessCostPolicy(workspace, { ...owned, taskPolicy: { ...automatic, taskBudget: 2000 } }).taskBudget).toBe(1000);
    expect(assessCostPolicy(workspace, { ...owned, taskPolicy: { ...automatic, taskBudget: 500 } })).toMatchObject({
      taskBudget: 500, capabilities: { budgetEnforcement: false },
    });
    expect(assessCostPolicy(automatic, { ...owned, taskPolicy: { ...automatic, taskBudget: 0 } }).taskBudget).toBe(0);
    expect(assessCostPolicy({ ...workspace, mode: 'off' }, owned).taskBudget).toBeNull();
    expect(assessCostPolicy(workspace, { ...owned, taskPolicy: { ...automatic, budgetUnit: 'reference-usd', taskBudget: 1 } }).taskBudget).toBeNull();
  });

  it('returns versioned metadata only and reflects a policy rollback', () => {
    const context = { ...owned, pinnedModel: { vendor: 'private-vendor', id: 'private-model' } };
    const before = assessCostPolicy(undefined, context);
    const active = assessCostPolicy(automatic, context);
    const rollback = assessCostPolicy(undefined, context);
    expect(active).toMatchObject({ policyVersion: 1, coverage: 'not-measured', scope: 'task' });
    expect(active.policyRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(active.policyRevision).not.toBe(before.policyRevision);
    expect(rollback).toEqual(before);
    expect(JSON.stringify(active)).not.toContain('private-');
  });
});

describe('owned policy admission and selection', () => {
  const candidate = (id: string, rate: number): PolicyCandidate => ({
    model: { vendor: 'vendor', id }, inputTokens: 100, maxInputTokens: 8000, toolCalling: true, verifiedPasses: 3, verifiedFailures: 0,
    rates: { basis: 'public-api-reference', mode: 'automatic', inputUsdPerMillion: rate, outputUsdPerMillion: rate,
      source: 'https://models.dev/api.json', fetchedAt: 100, revision: 'fixture', stale: false, status: 'priced', assumption: 'standard-uncached-input' },
  });

  it('selects a cheaper qualified candidate but respects pins, ties, and missing quality', () => {
    const current = candidate('current', 10);
    const cheap = candidate('cheap', 1);
    expect(selectPolicyModel([current, cheap], current.model, 512, true).candidate).toBe(cheap);
    expect(selectPolicyModel([current, cheap], current.model, 512, false).candidate).toBe(current);
    for (const invalid of [{ ...cheap, verifiedPasses: 0 }, { ...cheap, verifiedFailures: 1 }, { ...cheap, toolCalling: false },
      { ...cheap, maxInputTokens: 100 }, { ...cheap, inputTokens: null }, { ...cheap, rates: { ...cheap.rates, stale: true } },
      { ...cheap, rates: { ...cheap.rates, revision: 'different' } }, { ...cheap, rates: { ...cheap.rates, fetchedAt: 101 } },
      { ...cheap, rates: { ...cheap.rates, mode: 'manual' as const } },
      { ...cheap, rates: { ...cheap.rates, outputUsdPerMillion: null } }, candidate('tie', 10)]) {
      expect(selectPolicyModel([current, invalid], current.model, 512, true).candidate).toBe(current);
    }
    expect(selectPolicyModel([{ ...current, verifiedPasses: 0 }, cheap], current.model, 512, true).reason).toBe('insufficient-evidence');
    expect(() => selectPolicyModel([cheap], current.model, 512, true)).toThrow('No substitute');
  });

  it('uses conservative cumulative allowances and stops before unknown or unaffordable calls', () => {
    const current = candidate('current', 10);
    const plan = planOwnedCall(current, 'tokens', 2000, 0, 512);
    expect(plan.reservation).toBe(883);
    expect(() => planOwnedCall(current, 'tokens', 1000, plan.reservation, 512)).toThrow('remaining local allowance');
    expect(() => planOwnedCall(current, 'tokens', 0, 0, 512)).toThrow();
    expect(() => planOwnedCall(current, 'tokens', null, 0, 512)).toThrow('configure');
    expect(() => planOwnedCall({ ...current, inputTokens: null }, 'tokens', 1000, 0, 512)).toThrow('unavailable');
    expect(() => planOwnedCall({ ...current, maxInputTokens: 100 }, 'tokens', 1000, 0, 512)).toThrow('context');
    expect(planOwnedCall(current, 'reference-usd', 1, 0, 512).reservation).toBeCloseTo(0.00883);
    expect(() => planOwnedCall({ ...current, rates: { ...current.rates, stale: true } }, 'reference-usd', 1, 0, 512)).toThrow('fresh');
    expect(planOwnedCall(candidate('free', 0), 'reference-usd', 0, 0, 512).reservation).toBe(0);
    expect(() => planOwnedCall(current, 'tokens', 1000, 0, -1)).toThrow('output allowance');
  });

  it('returns advisory recommendations without a budget, execution opt-in, or mutation', () => {
    const current = candidate('current', 10);
    const cheap = candidate('cheap', 1);
    const policy = validateCostPolicy({ version: 1, mode: 'recommend-only', allowedModels: [current.model, cheap.model] });
    const before = JSON.stringify({ policy, current, cheap });
    const request = { category: 'code' as const, requestedModel: current.model, outputTokens: 512 };
    expect(recommendPolicyModel(policy, [current, cheap], request)).toMatchObject({ state: 'recommend', reason: 'lower-reference-cost', selectedModel: cheap.model });
    expect(recommendPolicyModel(policy, [current, cheap], { ...request, pinned: true })).toMatchObject({ state: 'retain', reason: 'pinned', selectedModel: current.model });
    expect(JSON.stringify({ policy, current, cheap })).toBe(before);
  });

  it('reports policy, permission, task, input, and availability gaps without guessing', () => {
    const current = candidate('current', 10);
    const policy = validateCostPolicy({ version: 1, mode: 'recommend-only', allowedModels: [current.model] });
    const request = { category: 'code' as const, requestedModel: current.model };
    expect(recommendPolicyModel({ ...policy, mode: 'off' }, [current], request).reason).toBe('policy-off');
    expect(recommendPolicyModel({ ...policy, allowedModels: [] }, [current], request)).toMatchObject({ reason: 'no-permitted-models', candidates: [] });
    expect(recommendPolicyModel(policy, [current]).reason).toBe('task-details-required');
    expect(recommendPolicyModel(policy, [current], { category: 'code' }).reason).toBe('model-required');
    expect(recommendPolicyModel(policy, [{ ...current, inputTokens: null }], request).reason).toBe('unknown-input');
    expect(recommendPolicyModel(policy, [], request)).toMatchObject({ reason: 'no-compatible-model', candidates: [{ available: false, gaps: ['unavailable'] }] });
    expect(recommendPolicyModel(policy, [current], { ...request, outputTokens: 0 }).reason).toBe('task-details-required');
  });

  it('keeps every permitted candidate visible with capability, pricing, and quality gaps', () => {
    const current = candidate('current', 10);
    const cheap = candidate('cheap', 1);
    const missing = { vendor: 'vendor', id: 'missing' };
    const policy = validateCostPolicy({ version: 1, mode: 'recommend-only', allowedModels: [current.model, cheap.model, missing] });
    const request = { category: 'triage' as const, requestedModel: current.model };
    for (const [invalid, gap] of [
      [{ ...cheap, verifiedPasses: 0 }, 'insufficient-evidence'], [{ ...cheap, verifiedFailures: 1 }, 'verified-failure'],
      [{ ...cheap, toolCalling: false }, 'tool-unsupported'], [{ ...cheap, maxInputTokens: 100 }, 'context-limit'],
      [{ ...cheap, rates: { ...cheap.rates, stale: true } }, 'unknown-price'],
      [{ ...cheap, rates: { ...cheap.rates, revision: 'other' } }, 'incomparable-price'],
    ] as const) {
      const result = recommendPolicyModel(policy, [current, invalid, candidate('disallowed', 0)], request);
      expect(result.selectedModel).toEqual(current.model);
      expect(result.candidates).toHaveLength(3);
      expect(result.candidates[1].gaps).toContain(gap);
      expect(result.candidates[2].gaps).toEqual(['unavailable']);
    }
    expect(recommendPolicyModel(policy, [{ ...current, verifiedPasses: 0 }, cheap], request).reason).toBe('insufficient-evidence');
    expect(recommendPolicyModel(policy, [{ ...current, rates: { ...current.rates, stale: true } }, cheap], request).reason).toBe('unknown-price');
  });

  it('uses configured pressure boundaries and preserves default and recovery behavior', () => {
    const profiles = ['conservative', 'balanced', 'aggressive'] as const;
    const thresholds = { balanced: 0.4, aggressive: 0.75 };
    expect(choosePolicyProfile('conservative', profiles, 0.39, false, thresholds)).toBe('conservative');
    expect(choosePolicyProfile('conservative', profiles, 0.4, false, thresholds)).toBe('balanced');
    expect(choosePolicyProfile('conservative', profiles, 0.749, false, thresholds)).toBe('balanced');
    expect(choosePolicyProfile('conservative', profiles, 0.75, false, thresholds)).toBe('aggressive');
    expect(choosePolicyProfile('conservative', profiles, 0.49, false)).toBe('conservative');
    expect(choosePolicyProfile('conservative', profiles, 0.5, false)).toBe('balanced');
    expect(choosePolicyProfile('conservative', profiles, 0.8, false)).toBe('aggressive');
    expect(choosePolicyProfile('aggressive', profiles, 0.9, true, thresholds)).toBe('conservative');
  });

  it('adapts only within permitted profiles and backs off on recovery failure', () => {
    expect(choosePolicyProfile('balanced', ['conservative', 'balanced', 'aggressive'], 0.9, false)).toBe('aggressive');
    expect(choosePolicyProfile('balanced', ['conservative', 'balanced'], 0.9, false)).toBe('balanced');
    expect(choosePolicyProfile('aggressive', ['conservative', 'balanced', 'aggressive'], 0.9, true)).toBe('conservative');
    expect(() => choosePolicyProfile('balanced', [], 0.9, false)).toThrow();
  });
});

describe('engine cost policy integration', () => {
  const engines: CompressionEngine[] = [];
  afterEach(() => {
    for (const engine of engines.splice(0)) {
      engine.dispose();
      fs.rmSync(engine.getStorageDir(), { recursive: true, force: true });
    }
  });
  function createEngine(policyContext?: CostPolicyContext): CompressionEngine {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-policy-'));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], policyContext });
    engines.push(engine);
    return engine;
  }

  it('adds no records or compression changes while off', () => {
    const engine = createEngine();
    expect(engine.getConfig().costPolicy.mode).toBe('off');
    expect(engine.getCostPolicyAssessment().effectiveMode).toBe('off');
    expect(engine.getConfig().profile).toBe('balanced');
    expect(engine.ledger.all()).toEqual([]);
  });

  it('allows only an owned engine to update its exact request model', () => {
    const model = { vendor: 'vendor', id: 'model', name: 'Model' };
    expect(() => createEngine().setRequestModel(model)).toThrow('Only an owned request');
    const engine = createEngine({ host: 'owned-chat', scope: 'task' });
    engine.updateConfig({ pricing: { mode: 'automatic' } });
    engine.setRequestModel(model);
    expect(engine.getPricingSnapshot().detectedModel).toEqual(model);
    const records = engine.ledger.all().length;
    engine.setRequestModel(model);
    expect(engine.ledger.all()).toHaveLength(records);
    engine.setRequestModel({ ...model, id: 'second' });
    expect(engine.getPricingSnapshot().detectedModel?.id).toBe('second');
    expect(engine.ledger.all().at(-1)?.tokensBefore).toBe(0);
  });

  it('exposes a read-only dashboard assessment without accepting policy mutations through runtime toggles', () => {
    const engine = createEngine();
    expect(buildSummaryPayload(engine).costPolicy).toEqual(engine.getCostPolicyAssessment());
    expect(() => parseConfigPatch({ costPolicy: validateCostPolicy() })).toThrow('host configuration');
    expect(engine.ledger.all()).toEqual([]);
  });

  it('rejects invalid policy updates before changing configuration or history', () => {
    const engine = createEngine();
    const before = engine.getConfig();
    expect(() => engine.updateConfig({
      profile: 'aggressive', costPolicy: JSON.parse('{"version":2,"mode":"off"}'),
    })).toThrow('Unsupported cost policy version');
    expect(() => engine.updateConfig({ costPolicy: JSON.parse('null') })).toThrow();
    expect(engine.getConfig()).toEqual(before);
    expect(engine.getConfigOverrides()).toEqual({});
    expect(engine.ledger.all()).toEqual([]);
  });

  it('replaces policies atomically and records metadata-only changes and rollback without savings', () => {
    const engine = createEngine();
    engine.compressToolResult({ toolName: 'test', text: 'recorded output', cwd: engine.getStorageDir() });
    const before = engine.ledger.summary();
    const recorded = fs.readFileSync(engine.ledger.path(), 'utf8');
    engine.updateConfig({ costPolicy: validateCostPolicy({
      version: 1, mode: 'automatic-owned-request', allowedModels: [{ vendor: 'PRIVATE', id: 'PRIVATE' }],
    }) });
    const active = engine.ledger.all().at(-1)!;
    expect(active).toMatchObject({ tool: 'session', strategy: 'session:cost-policy', tokensBefore: 0, tokensAfter: 0 });
    expect(active.costPolicyAssessment).toMatchObject({ requestedMode: 'automatic-owned-request', effectiveMode: 'recommend-only', coverage: 'not-measured' });
    expect(active.pricing).toBeUndefined();
    expect(JSON.stringify(active)).not.toContain('PRIVATE');
    const audit = JSON.stringify(active);
    engine.updateConfig({ costPolicy: JSON.parse('{"version":1,"mode":"off"}') });
    expect(engine.getConfig().costPolicy.allowedModels).toEqual([]);
    expect(engine.ledger.all().at(-1)?.costPolicyAssessment?.effectiveMode).toBe('off');
    expect(JSON.stringify(active)).toBe(audit);
    expect(engine.ledger.summary()).toEqual(before);
    expect(fs.readFileSync(engine.ledger.path(), 'utf8').startsWith(recorded)).toBe(true);
    const count = engine.ledger.all().length;
    engine.updateConfig({ costPolicy: undefined });
    engine.getCostPolicyAssessment();
    engine.getCostPolicyAssessment();
    expect(engine.ledger.all()).toHaveLength(count);
  });
});