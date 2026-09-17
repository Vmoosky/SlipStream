import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompressionEngine } from '../src/engine.js';
import { parseMarkers } from '../src/markers.js';
import { recordModelObservation, type ModelObservation } from '../src/modelTelemetry.js';
import { startDashboardServer, watchLedgerChanges, type DashboardServerHandle, type DashboardServerOptions } from '../src/dashboardServer.js';
import { SavingsLedger } from '../src/savingsLedger.js';
import type { DashboardDetailPayload, DashboardSummaryPayload } from '../src/dashboard.js';
import { buildSummaryPayload, renderDashboardReportMarkdown, renderDashboardReportJson, renderDashboardReportCsv } from '../src/dashboard.js';
import { formatDashboardReportMarkdown, formatDashboardReportJson, formatDashboardReportCsv } from '../src/dashboardReports.js';
import { jestFailureLog, sourceFile } from './fixtures.js';

const tempRoots: string[] = [];
const servers: DashboardServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-dashboard-e2e-'));
  tempRoots.push(root);
  return root;
}

async function startSeededDashboard(options: DashboardServerOptions = {}): Promise<{
  engine: CompressionEngine;
  root: string;
  server: DashboardServerHandle;
}> {
  const root = tempRoot();
  const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { maxFileLines: 20 } });
  const command = engine.compressCommandOutput({
    command: 'npm test',
    cwd: root,
    exitCode: 1,
    stdout: jestFailureLog(45),
    stderr: 'npm warn using demo fixture',
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

  const server = await startDashboardServer(engine, { ...options, port: 0 });
  servers.push(server);
  return { engine, root, server };
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function freezeSnapshot(value: object): void {
  for (const entry of Object.values(value)) {
    if (entry !== null && typeof entry === 'object') freezeSnapshot(entry);
  }
  Object.freeze(value);
}

describe('dashboard end to end', () => {
  it('keeps the latest chat model cached when helper telemetry arrives later or out of order', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), revision: 'fixture', models: [
      { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.4', modelName: 'GPT-5.4', input: 2 },
    ] }));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      engine.recordChatSubmitted(1);
      const template = engine.ledger.recent(1)[0];
      engine.ledger.record({ ...template, ts: 30, strategy: 'session:model', detectedModel: { vendor: 'copilot', id: 'gpt-5.4', name: 'gpt-5.4' }, modelObservation: {
        traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), provider: 'github', requestModel: 'auto', responseModel: 'gpt-5.4',
        conversationId: 'chat-session', startedAt: 20, endedAt: 30, inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 500,
      } });
      engine.ledger.record({ ...template, ts: 10, strategy: 'session:model', detectedModel: { vendor: 'copilot', id: 'old-model', name: 'old-model' } });
      engine.ledger.record({ ...template, ts: 40, strategy: 'session:model', detectedModel: { vendor: 'copilot', id: 'helper-model', name: 'helper-model' }, modelObservation: {
        traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), provider: 'github', requestModel: 'helper-model', responseModel: 'helper-model',
        startedAt: 35, endedAt: 40, inputTokens: 200, outputTokens: 10,
      } });
      const payload = buildSummaryPayload(engine);
      expect(payload.pricingSnapshot.detectedModel?.id).toBe('gpt-5.4');
      expect(payload.pricingSnapshot.inputUsdPerMillion).toBe(2);
      expect(payload.modelDetectedAt).toBe(30);
      expect(payload.modelObservation).toMatchObject({ inputTokens: 1000, cacheReadInputTokens: 500 });
      expect(payload.summary.tokensSaved).toBe(0);
      expect(payload.modelTracking).toBeUndefined();
      const restored = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
      try {
        expect(buildSummaryPayload(restored)).toMatchObject({
          pricingSnapshot: { detectedModel: { id: 'gpt-5.4' }, inputUsdPerMillion: 2 }, modelDetectedAt: 30,
          modelObservation: { inputTokens: 1000, cacheReadInputTokens: 500 },
        });
      } finally { restored.dispose(); }
    } finally { engine.dispose(); }
  });

  it.each(['conversationId', 'chatSessionId'])('waits for %s before displaying an unscoped telemetry model', (scope) => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      engine.recordChatSubmitted(1);
      const template = engine.ledger.recent(1)[0];
      const observation = {
        traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), provider: 'github', requestModel: 'gpt-5.4',
        startedAt: 10, endedAt: 20, inputTokens: 1000,
      };
      const event = { ...template, ts: 20, strategy: 'session:model', detectedModel: { vendor: 'copilot', id: 'gpt-5.4', name: 'gpt-5.4' } };
      engine.ledger.record({ ...event, modelObservation: observation });
      expect(buildSummaryPayload(engine).pricingSnapshot.detectedModel).toBeFalsy();
      engine.ledger.record({ ...event, ts: 30, modelObservation: { ...observation, endedAt: 30, [scope]: 'chat-session' } });
      expect(buildSummaryPayload(engine).pricingSnapshot.detectedModel?.id).toBe('gpt-5.4');
      expect(engine.summary().tokensSaved).toBe(0);
    } finally { engine.dispose(); }
  });

  it('lists observed calls by scope without exposing conversation identifiers', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      engine.recordChatSubmitted(1);
      const template = engine.ledger.recent(1)[0];
      const observation = {
        traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), provider: 'github',
        requestModel: 'auto', responseModel: 'gpt-5.4', startedAt: 10, endedAt: 30,
        inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 750,
      };
      engine.ledger.record({
        ...template, ts: 30, strategy: 'session:model',
        detectedModel: { vendor: 'copilot', id: 'gpt-5.4', name: 'gpt-5.4' },
        modelObservation: { ...observation, conversationId: 'SECRET-CONVERSATION' },
      });
      engine.ledger.record({
        ...template, ts: 40, strategy: 'session:model',
        detectedModel: { vendor: 'copilot', id: 'helper-model', name: 'helper-model' },
        modelObservation: { ...observation, spanId: 'c'.repeat(16), parentSpanId: 'd'.repeat(16), responseModel: 'helper-model', endedAt: 40 },
      });

      const payload = buildSummaryPayload(engine);

      expect(payload.modelObservations).toMatchObject([
        { model: 'helper-model', scope: 'background', nested: true, ts: 40 },
        { model: 'gpt-5.4', scope: 'chat', nested: false, ts: 30, inputTokens: 1000, cacheReadInputTokens: 750, durationMs: 20 },
      ]);
      expect(JSON.stringify(payload.modelObservations)).not.toContain('SECRET-CONVERSATION');
      expect(payload.pricingSnapshot.detectedModel?.id).toBe('gpt-5.4');
      expect(payload.summary.tokensSaved).toBe(0);
    } finally { engine.dispose(); }
  });

  it('uses recorded cache rates for observed input estimates across catalog changes without repricing history', async () => {
    const root = tempRoot();
    const rates = { version: 1, fetchedAt: Date.now(), revision: 'recorded', models: [
      { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.4', modelName: 'GPT-5.4', input: 5, cacheRead: 1, cacheWrite: 6 },
    ] };
    fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify(rates));
    const observation: ModelObservation = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), provider: 'github', requestModel: 'auto', responseModel: 'gpt-5.4',
      conversationId: 'PRIVATE-CONVERSATION', startedAt: 10, endedAt: 20,
      inputTokens: 1_000_000, outputTokens: 100, cacheReadInputTokens: 600_000, cacheCreationInputTokens: 100_000,
    };
    fs.writeFileSync(path.join(root, 'savings.jsonl'), JSON.stringify({
      ts: 1, tool: 'session', strategy: 'session:model', label: 'Legacy observation',
      tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0,
      modelObservation: { ...observation, traceId: 'c'.repeat(32), responseModel: 'legacy-model', endedAt: 1, startedAt: 0 },
    }) + '\n');
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      engine.compressFileRead({ path: path.join(root, 'catalog.ts'), content: sourceFile(35, 'alpha') });
      const before = engine.summary();
      expect(recordModelObservation(engine, observation)).toBe(true);
      expect(recordModelObservation(engine, observation)).toBe(false);
      recordModelObservation(engine, { ...observation, traceId: 'd'.repeat(32), endedAt: 30, cacheCreationInputTokens: undefined });
      const stored = fs.readFileSync(engine.ledger.path(), 'utf8');
      const payload = buildSummaryPayload(engine);
      expect(payload.modelObservations).toHaveLength(3);
      expect(payload.modelObservations[0]?.inputCost).toMatchObject({
        usd: null, coverage: 'partial', reason: 'Missing token usage', standardUncachedUsd: 5,
      });
      expect(payload.modelObservations[0]?.inputCost.knownUsd).toBeCloseTo(0.6, 10);
      expect(payload.modelObservations[1]).toMatchObject({ cacheCreationInputTokens: 100_000, inputUsdPerMillion: 5, inputCost: {
        coverage: 'complete', uncachedInputTokens: 300_000, standardUncachedUsd: 5,
      } });
      expect(payload.modelObservations[1]?.inputCost.usd).toBeCloseTo(2.7, 10);
      expect(payload.modelObservations[2]?.inputCost).toMatchObject({
        usd: null, knownUsd: 0, coverage: 'unavailable', reason: 'Missing model rates', standardUncachedUsd: null,
      });
      expect(JSON.stringify(payload.modelObservations)).not.toContain('PRIVATE-CONVERSATION');
      const server = await startDashboardServer(engine, { port: 0 });
      servers.push(server);
      expect((await json<DashboardSummaryPayload>(`${server.url}api/summary`)).modelObservations).toEqual(payload.modelObservations);
      expect(engine.summary()).toEqual(before);
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(stored);

      fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({
        ...rates, revision: 'refreshed', models: [{ ...rates.models[0], input: 50, cacheRead: 10, cacheWrite: 60 }],
      }));
      const reopened = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
      try {
        const current = buildSummaryPayload(reopened);
        expect(current.modelUsage.find((item) => item.model === 'gpt-5.4')?.inputUsdPerMillion).toBe(50);
        expect(current.modelObservations).toEqual(payload.modelObservations);
        expect(current.costAttribution).toEqual(payload.costAttribution);
        expect(reopened.summary()).toEqual(before);
        expect(fs.readFileSync(reopened.ledger.path(), 'utf8')).toBe(stored);
        recordModelObservation(reopened, { ...observation, traceId: 'e'.repeat(32), endedAt: 40 });
        expect(buildSummaryPayload(reopened).modelObservations[0]?.inputCost.usd).toBeCloseTo(27, 10);
        expect(buildSummaryPayload(reopened).modelObservations.slice(1)).toEqual(payload.modelObservations);
      } finally { reopened.dispose(); }
    } finally { engine.dispose(); }
  });

  it('aligns observed context with independent savings intervals without attributing calls or changing history', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      expect(buildSummaryPayload(engine).contextGrowth).toMatchObject({ startAt: null, endAt: null, observations: [], savings: [] });
      const latest = Date.UTC(2026, 8, 12, 12);
      const minute = 60_000;
      const start = latest - 55 * minute;
      const base = {
        ts: start, tool: 'read_file' as const, label: 'PRIVATE-FILE', strategy: 'read-lifecycle:fresh',
        tokensBefore: 100, tokensAfter: 40, bytesBefore: 400, bytesAfter: 160,
        linesBefore: 100, linesAfter: 40, durationMs: 1, sessionId: 'PRIVATE-PRODUCER',
      };
      engine.ledger.record({ ...base, ts: start - 1, tokensBefore: 1000 });
      engine.ledger.record(base);
      engine.ledger.record({ ...base, ts: start + minute, tool: 'retrieve_artifact', tokensBefore: 0, tokensAfter: 10 });
      engine.ledger.record({ ...base, ts: start + 2 * minute, sessionId: 'PRIVATE-OTHER-PRODUCER', tokensBefore: 80, tokensAfter: 60 });
      engine.ledger.record({ ...base, ts: start + 5 * minute, tokensBefore: 40, tokensAfter: 55 });
      engine.ledger.record({ ...base, ts: start + 2 * minute, tool: 'session', strategy: 'session:chat', tokensBefore: 900, tokensAfter: 0 });
      const usage = [
        { endedAt: latest, inputTokens: 0, cacheReadInputTokens: 0 },
        { endedAt: start + 1, inputTokens: 200, cacheReadInputTokens: 150 },
        { endedAt: start + minute, inputTokens: 10, cacheReadInputTokens: 0 },
        { endedAt: start + 2 * minute, inputTokens: undefined, cacheReadInputTokens: undefined },
        { endedAt: start + 3 * minute, inputTokens: 10, cacheReadInputTokens: 20 },
        { endedAt: start - 1, inputTokens: 5000, cacheReadInputTokens: 1000 },
      ];
      for (const [index, counts] of usage.entries()) {
        recordModelObservation(engine, {
          traceId: (index + 1).toString(16).padStart(32, '0'), spanId: 'a'.repeat(16), provider: 'github',
          requestModel: 'auto', responseModel: 'observed-model', startedAt: counts.endedAt - 1,
          conversationId: index === 1 ? 'PRIVATE-CHAT' : undefined, ...counts,
        });
      }
      const recorded = fs.readFileSync(engine.ledger.path(), 'utf8');
      const before = engine.summary();
      const timeline = buildSummaryPayload(engine).contextGrowth;
      expect(timeline).toMatchObject({ startAt: start, endAt: latest + 5 * minute, windowMinutes: 60, bucketMinutes: 5, observationCount: 5 });
      expect(timeline.observations.map((item) => item.ts)).toEqual([start + 1, start + minute, start + 2 * minute, start + 3 * minute, latest]);
      expect(timeline.observations[0]).toMatchObject({ model: 'observed-model', vendor: 'copilot', scope: 'chat', inputTokens: 200, cacheReadInputTokens: 150, cacheSharePercent: 75 });
      expect(timeline.observations.slice(1).map((item) => item.cacheSharePercent)).toEqual([0, null, null, null]);
      expect(timeline.observations[2]?.inputTokens).toBeNull();
      expect(timeline.observations[4]?.inputTokens).toBe(0);
      expect(timeline.savings).toHaveLength(12);
      expect(timeline.savings[0]).toMatchObject({ startAt: start, endAt: start + 5 * minute, toolOutputs: 3, tokensSaved: 80, retrievalTokens: 10, netTokensSaved: 70 });
      expect(timeline.savings[1]).toMatchObject({ toolOutputs: 1, tokensSaved: -15, retrievalTokens: 0, netTokensSaved: -15 });
      expect(timeline.savings.slice(2).every((item) => item.toolOutputs === 0 && item.netTokensSaved === 0)).toBe(true);
      expect(JSON.stringify(timeline)).not.toContain('PRIVATE');
      expect(engine.summary()).toEqual(before);
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(recorded);
    } finally { engine.dispose(); }
  });

  it('bounds context samples without truncating savings or treating session markers as activity', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const latest = Date.UTC(2026, 8, 12, 12);
    const base = {
      ts: latest, tool: 'session' as const, label: 'Model observed', strategy: 'session:model',
      tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0, durationMs: 0,
    };
    const observations = Array.from({ length: 205 }, (_, index) => ({
      ...base, ts: latest + index, modelObservation: {
        traceId: 'a'.repeat(32), spanId: (index + 1).toString(16).padStart(16, '0'), provider: 'vendor', requestModel: 'model',
        startedAt: latest + index - 1, endedAt: latest + index, inputTokens: index === 10 ? NaN : index, cacheReadInputTokens: 0,
      },
    })).reverse();
    const tool = { ...base, ts: latest - 1000, tool: 'read_file' as const, strategy: 'read-lifecycle:fresh', tokensBefore: 100, tokensAfter: 30 };
    const marker = { ...base, ts: latest + 24 * 60 * 60_000, strategy: 'session:reset' };
    const all = vi.spyOn(engine.ledger, 'all').mockReturnValue([
      ...observations, tool, { ...tool, tool: 'retrieve_artifact', tokensBefore: 0, tokensAfter: 7 }, marker,
    ]);
    try {
      const timeline = buildSummaryPayload(engine).contextGrowth;
      expect(timeline).toMatchObject({ observationCount: 205, observationLimit: 200, endAt: latest + 5 * 60_000 });
      expect(timeline.observations).toHaveLength(200);
      expect(timeline.observations[0]?.ts).toBe(latest + 5);
      expect(timeline.observations.at(-1)?.ts).toBe(latest + 204);
      expect(timeline.observations.find((item) => item.ts === latest + 10)).toMatchObject({ inputTokens: null, cacheSharePercent: null });
      expect(timeline.savings.reduce((total, item) => total + item.netTokensSaved, 0)).toBe(63);
      all.mockReturnValue([marker]);
      expect(buildSummaryPayload(engine).contextGrowth).toMatchObject({ startAt: null, endAt: null, observationCount: 0, savings: [] });
      all.mockReturnValue([tool]);
      expect(buildSummaryPayload(engine).contextGrowth).toMatchObject({ observationCount: 0, observations: [] });
      expect(buildSummaryPayload(engine).contextGrowth.savings.at(-1)?.netTokensSaved).toBe(70);
    } finally { all.mockRestore(); engine.dispose(); }
  });

  it('aggregates lifetime usage by exact provider and model without changing savings', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), revision: 'fixture', models: [
      { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.4', modelName: 'GPT-5.4', input: 2 },
      { providerId: 'openai', providerName: 'OpenAI', modelId: 'free-model', modelName: 'Free model', input: 0 },
    ] }));
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      engine.compressFileRead({ path: path.join(root, 'catalog.ts'), content: sourceFile(35, 'alpha') });
      const before = engine.summary();
      expect(buildSummaryPayload(engine).modelUsage).toEqual([]);
      let sequence = 0;
      const record = (overrides: Partial<ModelObservation> = {}): ModelObservation => {
        sequence++;
        const observation: ModelObservation = {
          traceId: sequence.toString(16).padStart(32, '0'), spanId: 'b'.repeat(16),
          provider: 'github', requestModel: 'auto', responseModel: 'gpt-5.4',
          conversationId: 'PRIVATE-CONVERSATION', startedAt: 1000 + sequence, endedAt: 2000 + sequence,
          inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 5, ...overrides,
        };
        recordModelObservation(engine, observation);
        return observation;
      };
      const duplicate = record();
      for (let index = 1; index < 30; index++) record();
      expect(recordModelObservation(engine, duplicate)).toBe(false);
      record({ startedAt: 10, endedAt: 20, inputTokens: undefined, outputTokens: undefined, cacheReadInputTokens: undefined });
      record({ provider: 'other-provider' });
      record({ provider: 'openai', responseModel: 'free-model', inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 });
      record({ responseModel: 'unknown-model', inputTokens: undefined, outputTokens: undefined, cacheReadInputTokens: undefined });
      const stored = fs.readFileSync(engine.ledger.path(), 'utf8');

      const payload = buildSummaryPayload(engine);

      expect(payload.modelObservations).toHaveLength(25);
      expect(payload.modelUsage).toHaveLength(4);
      expect(payload.modelUsage[0]).toMatchObject({
        model: 'gpt-5.4', vendor: 'copilot', calls: 31,
        inputTokens: 300, outputTokens: 30, cacheReadInputTokens: 150,
        inputReportedCalls: 30, outputReportedCalls: 30, cacheReadReportedCalls: 30,
        firstSeenAt: 20, lastSeenAt: 2030, inputUsdPerMillion: 2, inputRateReason: null,
      });
      expect(payload.modelUsage.find((item) => item.vendor === 'other-provider')).toMatchObject({ model: 'gpt-5.4', calls: 1, inputTokens: 10 });
      expect(payload.modelUsage.find((item) => item.model === 'free-model')).toMatchObject({
        calls: 1, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
        inputReportedCalls: 1, outputReportedCalls: 1, cacheReadReportedCalls: 1, inputUsdPerMillion: 0, inputRateReason: null,
      });
      expect(payload.modelUsage.find((item) => item.model === 'unknown-model')).toMatchObject({
        calls: 1, inputTokens: null, outputTokens: null, cacheReadInputTokens: null,
        inputReportedCalls: 0, outputReportedCalls: 0, cacheReadReportedCalls: 0, inputUsdPerMillion: null,
        inputRateReason: 'Model not in catalog',
      });
      expect(JSON.stringify(payload.modelUsage)).not.toContain('PRIVATE-CONVERSATION');
      expect(engine.summary()).toEqual(before);
      expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(stored);
      fs.writeFileSync(path.join(root, 'pricing-cache.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), revision: 'refreshed', models: [
        { providerId: 'openai', providerName: 'OpenAI', modelId: 'gpt-5.4', modelName: 'GPT-5.4', input: 7 },
      ] }));
      const reopened = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
      try {
        const current = buildSummaryPayload(reopened);
        expect(current.modelUsage.find((item) => item.vendor === 'copilot' && item.model === 'gpt-5.4')).toMatchObject({
          calls: 31, inputTokens: 300, inputUsdPerMillion: 7, firstSeenAt: 20, lastSeenAt: 2030,
        });
        expect(current.modelUsage.find((item) => item.model === 'free-model')).toMatchObject({
          inputUsdPerMillion: null, inputRateReason: 'Model not in catalog',
        });
        expect(reopened.ledger.all().find((entry) => entry.modelObservation?.responseModel === 'gpt-5.4')?.pricing?.inputUsdPerMillion).toBe(2);
        expect(reopened.summary()).toEqual(before);
        expect(fs.readFileSync(reopened.ledger.path(), 'utf8')).toBe(stored);
      } finally { reopened.dispose(); }
    } finally { engine.dispose(); }
  });

  it('counts lifetime outputs and only producers active in the recent window', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { maxFileLines: 20 } });
    try {
      engine.compressFileRead({ path: path.join(root, 'catalog.ts'), content: sourceFile(35, 'alpha') });
      const template = engine.ledger.recent(1)[0]!;
      for (let index = 0; index < 44; index++) engine.ledger.record({ ...template, ts: Date.now() });
      engine.ledger.record({
        ...template, ts: Date.now() - 60 * 60_000, sessionId: 'stale-producer',
        tool: 'session', strategy: 'session:chat', tokensBefore: 0, tokensAfter: 0,
      });
      const payload = buildSummaryPayload(engine);
      expect(payload.events).toHaveLength(40);
      expect(payload.traffic.totalOutputs).toBe(45);
      expect(payload.traffic.producerSessions).toBe(1);
      expect(payload.traffic.activeWindowMinutes).toBe(15);
    } finally { engine.dispose(); }
  });

  it('keeps archived savings in dashboard totals across rotation and restart', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { maxFileLines: 20 } });
    try {
      engine.compressFileRead({ path: path.join(root, 'catalog.ts'), content: sourceFile(35, 'alpha') });
      const before = engine.summary();
      expect(before.tokensSaved).toBeGreaterThan(0);
      const observer = new SavingsLedger({ rootDir: root });
      expect(observer.summary()).toEqual(before);
      const writer = new SavingsLedger({ rootDir: root, maxFileBytes: 1 });
      const original = engine.ledger.recent(1)[0]!;
      const unchanged = { ...original, ts: Date.now(), label: 'Unchanged output', tokensBefore: 100, tokensAfter: 100 };
      writer.record(unchanged);
      const archivePath = `${engine.ledger.path()}.1`;
      const archive = fs.readFileSync(archivePath, 'utf8');
      const expected = {
        tokensBefore: before.tokensBefore + 100, tokensAfter: before.tokensAfter + 100,
        tokensSaved: before.tokensSaved, percentSaved: before.tokensSaved / (before.tokensBefore + 100) * 100,
      };
      const payload = buildSummaryPayload(engine);
      expect(payload.summary).toMatchObject({ ...expected, calls: 2 });
      expect(payload.summary.cost).toEqual(before.cost);
      expect(payload.lifetime).toMatchObject({ ...expected, compressions: 2 });
      expect(payload.traffic.totalOutputs).toBe(2);
      expect(payload.history[0]).toMatchObject({ ...expected, calls: 2 });
      expect(observer.summary()).toEqual(payload.summary);
      expect(observer.recent(2).map((entry) => entry.label)).toEqual(['Unchanged output', original.label]);
      const reopened = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
      try { expect(buildSummaryPayload(reopened).summary).toEqual(payload.summary); }
      finally { reopened.dispose(); }
      expect(fs.readFileSync(archivePath, 'utf8')).toBe(archive);
      engine.ledger.clear();
      expect(fs.existsSync(archivePath)).toBe(false);
      expect(observer.summary()).toMatchObject({ calls: 0, tokensSaved: 0, percentSaved: 0 });
      expect(new SavingsLedger({ rootDir: root }).all()).toEqual([]);
    } finally { engine.dispose(); }
  });

  it('refreshes archived totals when the active file is missing or only the archive changes', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { maxFileLines: 20 } });
    try {
      engine.compressFileRead({ path: path.join(root, 'catalog.ts'), content: sourceFile(35, 'alpha') });
      const original = engine.ledger.recent(1)[0]!;
      const before = engine.summary();
      const archivePath = `${engine.ledger.path()}.1`;
      fs.renameSync(engine.ledger.path(), archivePath);
      expect(engine.summary()).toEqual(before);
      const observer = new SavingsLedger({ rootDir: root });
      expect(observer.summary()).toEqual(before);
      fs.appendFileSync(archivePath, `${JSON.stringify({ ...original, label: 'Archived passthrough', tokensBefore: 100, tokensAfter: 100 })}\nnot-json\n${JSON.stringify({ ...original, tokensBefore: null })}\n`);
      expect(observer.summary()).toMatchObject({ calls: 2, tokensSaved: before.tokensSaved, tokensBefore: before.tokensBefore + 100 });
      expect(observer.summary().cost).toEqual(before.cost);
      expect(observer.recent(2).map((entry) => entry.label)).toEqual(['Archived passthrough', original.label]);
      fs.rmSync(archivePath);
      expect(observer.all()).toEqual([]);
      observer.record({ ...original, label: 'New history', tokensBefore: 200, tokensAfter: 100 });
      expect(engine.summary()).toMatchObject({ calls: 1, tokensSaved: 100, percentSaved: 50 });
    } finally { engine.dispose(); }
  });

  it('counts each retained archive generation once across repeated rotations', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { maxFileLines: 20 } });
    try {
      engine.compressFileRead({ path: path.join(root, 'catalog.ts'), content: sourceFile(35, 'alpha') });
      const original = engine.ledger.recent(1)[0]!;
      const observer = new SavingsLedger({ rootDir: root });
      const writer = new SavingsLedger({ rootDir: root, maxFileBytes: 1 });
      writer.record({ ...original, label: 'Second generation', tokensBefore: 200, tokensAfter: 100 });
      expect(observer.all()).toHaveLength(2);
      writer.record({ ...original, label: 'Third generation', tokensBefore: 300, tokensAfter: 100 });
      const expected = { calls: 2, tokensBefore: 500, tokensAfter: 200, tokensSaved: 300, percentSaved: 60 };
      expect(observer.summary()).toMatchObject(expected);
      expect(observer.all().map((entry) => entry.label)).toEqual(['Second generation', 'Third generation']);
      expect(observer.recent(1)[0]?.label).toBe('Third generation');
      expect(new SavingsLedger({ rootDir: root }).summary()).toMatchObject(expected);
      expect(buildSummaryPayload(engine).lifetime).toMatchObject({ compressions: 2, tokensSaved: 300, percentSaved: 60 });
    } finally { engine.dispose(); }
  });

  it('notifies viewers of externally observed tool events without inventing compression', async () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    engine.recordChatSubmitted();
    const writer = new SavingsLedger({ rootDir: root, maxFileBytes: 1 });
    let stop = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('External ledger notification missing')), 3000);
        stop = watchLedgerChanges(engine.ledger.path(), () => { clearTimeout(deadline); resolve(); });
        writer.record({ ...engine.ledger.recent(1)[0], strategy: 'session:tool-observed', label: 'Observed tool: read_file' });
      });
      expect(fs.existsSync(`${engine.ledger.path()}.1`)).toBe(true);
      const summary = buildSummaryPayload(engine);
      expect(summary.lifetime).toMatchObject({ chatsObserved: 1, observedToolCalls: 1 });
      expect(summary.summary).toMatchObject({ calls: 0, compressions: 0, tokensSaved: 0, estimatedCostSavedUsd: 0 });
      expect(summary.timeline.find((entry) => entry.strategy === 'session:tool-observed')).toMatchObject({ kind: 'Observed', inspectable: false });
      expect(summary.timeline.some((entry) => entry.kind === 'Compressed')).toBe(false);
    } finally { stop(); engine.dispose(); }
  });

  it('serves a readable browser dashboard backed by real Slipstream data', async () => {
    const { server } = await startSeededDashboard();

    expect(server.url).toMatch(/^http:\/\/localhost:\d+\/$/);
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const html = await page.text();
    expect(html).toContain('<title>Slipstream Savings</title>');
    expect(html).toContain('id="themeMode"');
    expect(html).toContain('id="connectionStatus"');
    expect(html).toContain('id="trafficStatus"');
    expect(html).toContain('id="retrievalAvoidance"');
    expect(html).not.toContain('id="retrieval"');
    expect(html).not.toContain('The model expanded');
    expect(html).toContain('id="workspaceAttribution"');
    expect(html).toContain('id="workspaceAttributionEmpty"');
    expect(html).toContain('id="outputTabs"');
    expect(html).toContain('id="outputMeta"');
    expect(html).toContain("'slipstream.dashboard.theme'");
    expect(html).toContain('id="strategies"');
    expect(html).toContain('id="configStatus"');
    // Setup and demo instructions belong in the docs, not the evidence surface.
    expect(html).not.toContain('id="judgeFlow"');
    expect(html).not.toContain('npm run dashboard:demo');
    expect(html).not.toContain('npm run benchmark:snapshot');
    expect(html).not.toContain('id="safetyClaims"');
    expect(html).not.toContain('<h2>Why this is safe</h2>');
    expect(html).toContain('id="retrievalAuditCallout"');
    expect(html).toContain('id="retrievalAudit"');
    expect(html).toContain('id="tokenFlow"');
    expect(html).toContain('id="outcomeReasons"');
    expect(html).toContain('id="reuseHealth"');
    expect(html).toContain('id="timingBreakdown"');
    expect(html).toContain('id="events"');
    expect(html).toContain('id="detail"');
    expect(html).toContain('id="modelPayloadLink"');
    expect(html).toContain('id="copyModelPayload"');
    expect(html).toContain('id="shareSnapshotLink"');
    expect(html).toContain('id="shareJsonLink"');
    expect(html).toContain('id="shareCsvLink"');
    expect(html).toContain('data-panel-target="overview"');
    expect(html).toContain('data-panel-target="evidence"');
    expect(html).toContain('data-panel-target="storage"');
    expect(html).toContain('data-panel-target="activity"');
    expect(html).toContain('data-panel-target="history"');
    expect(html).toContain('id="lifetimeTotals"');
    expect(html).toContain('id="history"');
    expect(html).toContain('id="wasteSignals"');
    expect(html).toContain('id="costAttribution"');
    expect(html).toContain('id="comparison"');
    expect(html).toContain('id="saveBaseline"');
    expect(html).toContain('id="sideBySideMode"');
    expect(html).toContain('id="diffMode"');
    expect(html).toContain('id="diffView"');
    expect(html).toContain("fetch('api/' + path");
    expect(html).toContain('new EventSource(eventStreamUrl())');
    expect(html).toContain("addEventListener('heartbeat'");
    expect(html).toContain("query.set('t', token)");
    expect(html).toContain("reportUrl('json')");
    expect(html).toContain("reportUrl('csv')");

    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script)).not.toThrow();
  });

  it('supports the exact clean-URL browser API contract', async () => {
    const { root, server } = await startSeededDashboard();

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    expect(summary.type).toBe('summary');
    expect(summary.enabled).toBe(true);
    expect(summary.summary.calls).toBe(4);
    expect(summary.summary.compressions).toBe(3);
    expect(summary.summary.retrievals).toBe(1);
    expect(summary.summary.tokensSaved).toBeGreaterThan(0);
    expect(summary.tokenFlow.rawTokens).toBe(summary.summary.tokensBefore);
    expect(summary.tokenFlow.returnedTokens).toBe(summary.summary.tokensAfter);
    expect(summary.tokenFlow.omittedTokens).toBe(summary.summary.tokensSaved);
    expect(summary.tokenFlow.retrievedTokens).toBeGreaterThan(0);
    expect(summary.tokenFlow.netSavedTokens).toBeLessThan(summary.summary.tokensSaved);
    expect(summary.outcomeBreakdown.map((item) => item.reason)).toContain('Compressed');
    expect(summary.outcomeBreakdown.map((item) => item.reason)).toContain('Retrieved omitted content');
    expect(summary.events.every((event) => event.outcomeReason)).toBe(true);
    expect(summary.events.find((event) => event.tool === 'retrieve_artifact')!.outcomeReason).toBe(
      'Retrieved omitted content',
    );
    expect(summary.reuseHealth.markersEmitted).toBe(summary.retrievalAudit.totalMarkers);
    expect(summary.reuseHealth.markersRetrieved).toBe(summary.retrievalAudit.retrievedMarkers);
    expect(summary.reuseHealth.unchangedReadHits).toBe(1);
    expect(summary.reuseHealth.artifactEntries).toBeGreaterThan(0);
    expect(summary.reuseHealth.artifactBytes).toBeGreaterThan(0);
    expect(summary.reuseHealth.artifactMaxEntries).toBe(summary.config.artifactMaxEntries);
    expect(summary.reuseHealth.artifactMaxBytes).toBe(summary.config.artifactMaxTotalMiB * 1024 * 1024);
    expect(summary.reuseHealth.artifactEntryPercent).toBeGreaterThan(0);
    expect(summary.reuseHealth.artifactBytePercent).toBeGreaterThan(0);
    expect(summary.timingBreakdown.map((item) => item.name)).toEqual([
      'Log compression',
      'Read lifecycle',
      'Retrieval',
      'Artifact store',
    ]);
    expect(summary.timingBreakdown[0]!.calls).toBe(1);
    expect(summary.timingBreakdown[0]!.strategies).toContain('log:jest');
    expect(summary.timingBreakdown.every((item) => item.avgMs >= 0 && item.maxMs >= item.avgMs)).toBe(true);
    expect(summary.timingBreakdown.every((item) => item.minMs <= item.avgMs)).toBe(true);
    expect(summary.timingBreakdown.every((item) => item.p95Ms <= item.maxMs)).toBe(true);
    // Store time is a component of each call, so it is counted once per event.
    const store = summary.timingBreakdown.find((item) => item.name === 'Artifact store')!;
    expect(store.calls).toBe(summary.events.length);
    expect(summary.events.every((event) => Number.isFinite(event.artifactMs))).toBe(true);
    expect(summary.outputGroups[0]!.id).toBe('global');
    expect(summary.outputGroups[0]!.label).toBe('Global outputs');
    expect(summary.outputGroups[0]!.calls).toBe(summary.events.length);
    expect(summary.outputGroups.some((group) => group.label === 'This session')).toBe(true);
    expect(summary.traffic.viewerConnections).toBe(0);
    expect(summary.traffic.producerSessions).toBeGreaterThan(0);
    expect(summary.traffic.activeWindowMinutes).toBe(15);
    expect(summary.traffic.totalOutputs).toBe(summary.lifetime.compressions + summary.lifetime.retrievals);
    expect(summary.workspaceAttribution).toHaveLength(1);
    expect(summary.workspaceAttribution[0]).toMatchObject({
      label: path.basename(root),
      root,
      calls: 4,
    });
    expect(summary.workspaceAttribution[0]!.tokensSaved).toBe(summary.summary.tokensSaved);
    expect(summary.workspaceAttribution[0]!.percentSaved).toBeGreaterThan(0);
    expect(summary.workspaceAttribution[0]!.lastActivity).toEqual(expect.any(String));
    expect(summary.config.enabled).toBe(true);
    expect(summary.config.compressLogs).toBe(true);
    expect(summary.config.readLifecycle).toBe(true);
    expect(summary.config.crossTurnDedup).toBe(true);
    expect(summary.config.maxFileLines).toBe(20);
    expect(summary.config.usdPerMillionTokens).toBe(3);
    expect(summary.config.artifactIdleTtlMinutes).toBe(60);
    expect(summary.config.artifactMaxEntries).toBe(2000);
    expect(summary.config.artifactMaxTotalMiB).toBe(256);
    expect(summary.summary.byTool.map((tool) => tool.tool).sort()).toEqual([
      'read_file',
      'retrieve_artifact',
      'run_command',
    ]);
    expect(summary.strategyBreakdown.map((item) => item.name)).toEqual([
      'Log compression',
      'Read lifecycle',
      'Retrieval',
    ]);
    expect(summary.strategyBreakdown[0]!.tokensSaved).toBeGreaterThan(0);
    expect(summary.strategyBreakdown[0]!.strategies).toContain('log:jest');
    expect(summary.strategyBreakdown[1]!.strategies).toContain('read-lifecycle:unchanged');
    expect(summary.retrievalAudit.totalMarkers).toBeGreaterThan(0);
    expect(summary.retrievalAudit.retrievedMarkers).toBeGreaterThan(0);
    expect(summary.retrievalAudit.unretrievedMarkers).toBeGreaterThan(0);
    expect(summary.retrievalAudit.percentUnretrieved).toBeGreaterThan(0);
    expect(summary.retrievalAudit.retrievedLines).toBe(1);
    expect(summary.retrievalAudit.items.some((item) => item.retrievedMarkers > 0)).toBe(true);
    expect(summary.retrievalAudit.items.some((item) => item.unretrievedMarkers > 0)).toBe(true);

    const runEvent = summary.events.find((event) => event.tool === 'run_command');
    expect(runEvent).toBeDefined();
    expect(runEvent!.strategy).toMatch(/^log:/);
    expect(runEvent!.durationMs).toEqual(expect.any(Number));

    const selector = new URLSearchParams({ ts: String(runEvent!.ts), eventId: runEvent!.eventId! });
    const detail = await json<DashboardDetailPayload>(`${server.url}api/detail?t=&${selector}`);
    expect(detail.type).toBe('detail');
    expect(detail.label).toBe('$ npm test');
    expect(detail.strategy).toBe(runEvent!.strategy);
    expect(detail.tokensBefore).toBe(runEvent!.tokensBefore);
    expect(detail.tokensAfter).toBe(runEvent!.tokensAfter);
    expect(detail.modelPayload).toEqual({
      tokens: runEvent!.tokensAfter,
      lines: runEvent!.linesAfter,
      markerCount: expect.any(Number),
    });
    expect(detail.modelPayload.markerCount).toBeGreaterThan(0);
    expect(detail.diffSummary.removedLines).toBeGreaterThan(0);
    expect(detail.diffSummary.keptLines).toBeGreaterThan(0);
    expect(detail.diffSummary.tokensSaved).toBeGreaterThan(0);
    expect(detail.diffSummary.percentSaved).toBeGreaterThan(0);
    expect(detail.before).toContain('FAIL src/services/billing/invoice.spec.ts');
    expect(detail.after).toContain('retrieve_artifact');
    expect(detail.omitted.length).toBeGreaterThan(0);

    const payload = await fetch(`${server.url}api/model-payload?t=&${selector}`);
    expect(payload.status).toBe(200);
    expect(payload.headers.get('content-type')).toContain('text/plain');
    expect(await payload.text()).toBe(detail.after);
  });

  it('keeps command details distinct from retrievals recorded in the same millisecond', async () => {
    const timestamp = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(timestamp);
    let seeded: Awaited<ReturnType<typeof startSeededDashboard>>;
    try {
      seeded = await startSeededDashboard();
    } finally {
      clock.mockRestore();
    }
    const { engine, root, server } = seeded;
    engine.ledger.record(engine.recentEvents(1)[0]!);
    const stored = fs.readFileSync(engine.ledger.path(), 'utf8');
    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const command = summary.events.find((event) => event.tool === 'run_command')!;
    const retrieval = summary.events.find((event) => event.tool === 'retrieve_artifact')!;
    expect(command.ts).toBe(retrieval.ts);
    expect(new Set(summary.events.map((event) => event.eventId)).size).toBe(summary.events.length);

    for (const event of summary.events) {
      expect(event.eventId).toMatch(/^[a-f0-9]{64}:\d+$/);
      const selector = new URLSearchParams({ ts: String(event.ts), eventId: event.eventId! });
      const detail = await json<DashboardDetailPayload>(`${server.url}api/detail?t=&${selector}`);
      expect(detail).toMatchObject({
        eventId: event.eventId,
        strategy: event.strategy,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      });
      expect(detail.before).toBe(engine.inspect(event).before);
      expect(detail.after).toBe(engine.inspect(event).after);
      const payload = await fetch(`${server.url}api/model-payload?t=&${selector}`);
      expect(payload.status).toBe(event.renderedArtifactId ? 200 : 404);
      expect(await payload.text()).toBe(detail.after ?? 'No such event');
    }
    const legacy = await json<DashboardDetailPayload>(`${server.url}api/detail?t=&ts=${command.ts}`);
    expect(legacy.eventId).toBe(summary.events[0]!.eventId);
    for (const route of ['detail', 'model-payload']) {
      for (const selector of [
        new URLSearchParams({ ts: String(command.ts), eventId: 'unknown' }),
        new URLSearchParams({ ts: String(command.ts + 1), eventId: command.eventId! }),
      ]) {
        expect((await fetch(`${server.url}api/${route}?t=&${selector}`)).status).toBe(404);
      }
    }
    expect(fs.readFileSync(engine.ledger.path(), 'utf8')).toBe(stored);
    const observer = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    try {
      expect(buildSummaryPayload(observer).events.map((event) => event.eventId)).toEqual(
        summary.events.map((event) => event.eventId),
      );
    } finally {
      observer.dispose();
    }
    engine.recordChatSubmitted();
    expect(buildSummaryPayload(engine).events.slice(1).map((event) => event.eventId)).toEqual(
      summary.events.map((event) => event.eventId),
    );
  });

  it('pushes summary updates from other sessions through an event stream', async () => {
    const root = tempRoot();
    const dashboardEngine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    const server = await startDashboardServer(dashboardEngine, { port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}api/events?t=`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const nextSummary = async (): Promise<DashboardSummaryPayload> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice('data: '.length);
          if (data) {
            return JSON.parse(data) as DashboardSummaryPayload;
          }
        }
      }
      throw new Error('Timed out waiting for dashboard event stream summary');
    };

    const initial = await nextSummary();
    expect(initial.summary.calls).toBe(0);
    expect(initial.traffic.viewerConnections).toBe(1);

    const otherSession = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    otherSession.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
      durationMs: 120,
    });

    const pushed = await nextSummary();
    expect(pushed.summary.calls).toBe(1);
    expect(pushed.summary.compressions).toBe(1);
    expect(pushed.summary.tokensSaved).toBeGreaterThan(0);
    expect(pushed.events[0]!.tool).toBe('run_command');

    await reader.cancel();
  });

  it('exports a shareable Markdown snapshot matching the dashboard summary', async () => {
    const { server } = await startSeededDashboard();

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const response = await fetch(`${server.url}api/report.md?t=`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="slipstream-savings-snapshot.md"',
    );
    const markdown = await response.text();

    expect(markdown).toContain('# Slipstream Savings Snapshot');
    expect(markdown).toContain(`Tokens saved | ${summary.summary.tokensSaved.toLocaleString()}`);
    expect(markdown).toContain('Dashboard viewers');
    expect(markdown).toContain('Active producers (last 15 min)');
    expect(markdown).toContain(`Tool outputs (all producers) | ${summary.traffic.totalOutputs.toLocaleString()}`);
    expect(markdown).toContain('## Workspace attribution');
    expect(markdown).toContain(`Expandable markers | ${summary.retrievalAudit.totalMarkers.toLocaleString()}`);
    expect(markdown).toContain('## Token flow');
    expect(markdown).toContain('## Outcome reasons');
    expect(markdown).toContain('## Retrieval audit');
    expect(markdown).toContain('## Reuse health');
    expect(markdown).toContain('Artifact entries');
    expect(markdown).toContain('Artifact storage');
    expect(markdown).toContain('## Strategy timing');
    expect(markdown).toContain('## By strategy');
    expect(markdown).toContain('## Recent activity');

    const jsonResponse = await fetch(`${server.url}api/report.json?t=`);
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.headers.get('content-type')).toContain('application/json');
    expect(jsonResponse.headers.get('content-disposition')).toBe(
      'attachment; filename="slipstream-savings-snapshot.json"',
    );
    const jsonSnapshot = await jsonResponse.json();
    expect(jsonSnapshot.generatedAt).toEqual(expect.any(String));
    expect(jsonSnapshot.summary.tokensSaved).toBe(summary.summary.tokensSaved);
    expect(jsonSnapshot.traffic.producerSessions).toBe(summary.traffic.producerSessions);
    expect(jsonSnapshot.workspaceAttribution[0].tokensSaved).toBe(summary.workspaceAttribution[0]!.tokensSaved);

    const csvResponse = await fetch(`${server.url}api/report.csv?t=`);
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get('content-type')).toContain('text/csv');
    expect(csvResponse.headers.get('content-disposition')).toBe(
      'attachment; filename="slipstream-savings-snapshot.csv"',
    );
    const csv = await csvResponse.text();
    expect(csv).toContain('"section","name","value","detail"');
    expect(csv).toContain('"traffic","producerSessions"');
    expect(csv).toContain('"workspace"');
    expect(csv).toContain('"event","$ npm test"');
  });

  it.each(['empty', 'populated'] as const)('formats a captured %s report snapshot without a live engine or mutation', async (kind) => {
    const engine = kind === 'populated'
      ? (await startSeededDashboard()).engine
      : new CompressionEngine({ rootDir: tempRoot(), workspaceRoots: [] });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const generatedAt = new Date('2026-09-16T12:00:00.000Z');
      const status = { viewerConnections: 3 };
      const snapshot = structuredClone(buildSummaryPayload(engine, status));
      const original = structuredClone(snapshot);
      const expected = {
        markdown: renderDashboardReportMarkdown(engine, generatedAt, status),
        json: renderDashboardReportJson(engine, generatedAt, status),
        csv: renderDashboardReportCsv(engine, generatedAt, status),
      };
      freezeSnapshot(snapshot);
      engine.dispose();

      expect(formatDashboardReportMarkdown(snapshot, generatedAt.toISOString())).toBe(expected.markdown);
      expect(formatDashboardReportJson(snapshot, generatedAt.toISOString())).toBe(expected.json);
      expect(formatDashboardReportCsv(snapshot, generatedAt.toISOString())).toBe(expected.csv);
      expect(snapshot).toEqual(original);
      expect(JSON.parse(expected.json)).toEqual({ generatedAt: generatedAt.toISOString(), ...snapshot });
      expect(expected.markdown).toContain('| Dashboard viewers | 3 |');
      expect(expected.csv).toContain('"traffic","dashboardViewers","3",""');
      for (const report of Object.values(expected)) expect(report).toMatch(/[^\n]\n$/);
    } finally {
      clock.mockRestore();
      engine.dispose();
    }
  });

  it('escapes captured report fields and preserves unknown costs in every format', async () => {
    const { engine } = await startSeededDashboard();
    try {
      const snapshot = structuredClone(buildSummaryPayload(engine));
      const generatedAt = '2026-09-16T12:00:00.000Z';
      const label = 'path "report", left\\|right\r\nsecond row';
      snapshot.workspaceAttribution[0]!.label = label;
      snapshot.events[0]!.label = label;
      snapshot.summary.estimatedCostSavedUsd = null;
      freezeSnapshot(snapshot);

      const markdown = formatDashboardReportMarkdown(snapshot, generatedAt);
      expect(markdown).toContain(String.raw`| path "report", left\\\|right second row |`);
      expect(markdown).toContain('| Estimated saving | N/A |');
      expect(markdown).toContain('## Outcome reasons\n\n| Reason | Calls | Saved |\n|---|---:|---:|\n');
      expect(markdown).toContain('## Daily savings\n\n| Date | Calls | In | Out | Saved | % |\n|---|---:|---:|---:|---:|---:|\n');
      const csv = formatDashboardReportCsv(snapshot, generatedAt);
      expect(csv).toContain('"event","path ""report"", left\\|right\r\nsecond row",');
      expect(csv).toContain('"summary","estimatedCostSavedUsd","N/A",""');
      const jsonReport = JSON.parse(formatDashboardReportJson(snapshot, generatedAt));
      expect(jsonReport.events[0].label).toBe(label);
      expect(jsonReport.workspaceAttribution[0].label).toBe(label);
      expect(jsonReport.summary.estimatedCostSavedUsd).toBeNull();
    } finally {
      engine.dispose();
    }
  });

  it('rejects an invalid JSON report timestamp before reading the ledger', () => {
    const engine = new CompressionEngine({ rootDir: tempRoot(), workspaceRoots: [] });
    const readLedger = vi.spyOn(engine.ledger, 'all');
    try {
      expect(() => renderDashboardReportJson(engine, new Date(Number.NaN))).toThrow(RangeError);
      expect(readLedger).not.toHaveBeenCalled();
    } finally {
      readLedger.mockRestore();
      engine.dispose();
    }
  });

  it('preserves literal backslashes in Markdown activity labels', async () => {
    const { engine, root, server } = await startSeededDashboard();
    const cases = [
      ['left|right', String.raw`left\|right`],
      [String.raw`left\|right`, String.raw`left\\\|right`],
      [String.raw`left\\|right`, String.raw`left\\\\\|right`],
      [String.raw`left\\\|right`, String.raw`left\\\\\\\|right`],
      ['C:\\workspace\\test\\', 'C:\\\\workspace\\\\test\\\\'],
    ] as const;
    try {
      for (const [label] of cases) {
        engine.compressCommandOutput({
          command: label, cwd: root, exitCode: 0, stdout: 'test output', stderr: '', durationMs: 1,
        });
      }
      const response = await fetch(`${server.url}api/report.md`);
      expect(response.status).toBe(200);
      const markdown = await response.text();
      for (const [, escaped] of cases) {
        expect(markdown).toContain(`| $ ${escaped} |`);
      }
    } finally {
      engine.dispose();
    }
  });

  it('updates runtime config from the local dashboard API', async () => {
    let persistedConfig: unknown;
    const { engine, server } = await startSeededDashboard({ onConfigChanged: (config) => (persistedConfig = config) });

    const forbidden = await fetch(`${server.url}api/config?t=`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.test' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(forbidden.status).toBe(403);

    const response = await fetch(`${server.url}api/config?t=`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: false,
        compressLogs: false,
        readLifecycle: false,
        crossTurnDedup: false,
        maxFileLines: 80,
        artifactIdleTtlMinutes: 15,
        artifactMaxEntries: 25,
        artifactMaxTotalMiB: 8,
      }),
    });

    expect(response.status).toBe(200);
    const summary = (await response.json()) as DashboardSummaryPayload;
    expect(summary.enabled).toBe(false);
    expect(summary.config).toMatchObject({
      enabled: false,
      compressLogs: false,
      readLifecycle: false,
      crossTurnDedup: false,
      maxFileLines: 80,
      artifactIdleTtlMinutes: 15,
      artifactMaxEntries: 25,
      artifactMaxTotalMiB: 8,
    });
    expect(engine.getConfig()).toMatchObject(summary.config);
    expect(persistedConfig).toMatchObject(summary.config);
    expect(engine.store.retentionPolicy()).toMatchObject({
      idleTtlMs: 15 * 60_000,
      maxEntries: 25,
      maxTotalBytes: 8 * 1024 * 1024,
    });
  });

  it('keeps recent activity chronological enough for timeline-style UI', async () => {
    const { server } = await startSeededDashboard();

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const newestFirst = summary.events.map((event) => event.ts);
    expect(newestFirst).toEqual([...newestFirst].sort((a, b) => b - a));

    const labels = summary.events.map((event) => `${event.tool}:${event.strategy}`);
    expect(labels).toContain('retrieve_artifact:retrieve');
    expect(labels).toContain('read_file:read-lifecycle:unchanged');
    expect(labels.some((label) => label.startsWith('run_command:log:'))).toBe(true);
  });

  it('shows reset and purge as timeline events without changing savings totals', async () => {
    const { engine, server } = await startSeededDashboard();
    const before = engine.summary();

    engine.resetSession();
    engine.purge();

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    expect(summary.summary.tokensSaved).toBe(before.tokensSaved);
    expect(summary.summary.compressions).toBe(before.compressions);
    expect(summary.summary.retrievals).toBe(before.retrievals);
    expect(summary.summary.byTool.map((tool) => tool.tool)).not.toContain('session');
    // Markers stay on the record: purging deletes the content, it does not undo
    // the fact that the model was shown a marker. Anything not already expanded
    // becomes expired rather than looking like it was never needed.
    expect(summary.retrievalAudit.totalMarkers).toBeGreaterThan(0);
    expect(summary.retrievalAudit.lifecycle.expired).toBe(summary.retrievalAudit.unretrievedMarkers);
    expect(summary.retrievalAudit.lifecycle.stillRetrievable).toBe(0);

    const timeline = summary.timeline.map((event) => `${event.kind}:${event.strategy}`);
    expect(timeline).toContain('Reset:session:reset');
    expect(timeline).toContain('Purged:session:purge');
    expect(summary.timeline.find((event) => event.strategy === 'session:reset')!.inspectable).toBe(false);
    expect(summary.timeline.find((event) => event.strategy === 'session:purge')!.detail).toBe(
      'Deleted stored artifacts and reset session memory.',
    );
  });

  it('records why each tool call was or was not compressed', async () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });

    engine.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });
    engine.compressCommandOutput({
      command: 'echo hi',
      cwd: root,
      exitCode: 0,
      stdout: 'hi',
      stderr: '',
    });
    engine.updateConfig({ compressLogs: false });
    engine.compressCommandOutput({
      command: 'npm run build',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });

    const server = await startDashboardServer(engine, { port: 0 });
    servers.push(server);

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const reasons = summary.events.map((event) => event.outcomeReason);
    expect(reasons).toContain('Compressed');
    expect(reasons).toContain('Too small');
    expect(reasons).toContain('Strategy disabled');

    // The dashboard must report the recorded reason, not re-derive it.
    const disabled = summary.events.find((event) => event.label === '$ npm run build')!;
    expect(disabled.outcomeReason).toBe('Strategy disabled');
    expect(disabled.strategy).toBe('passthrough');
    expect(summary.outcomeBreakdown.find((item) => item.reason === 'Too small')!.calls).toBe(1);
    expect(summary.outcomeBreakdown.find((item) => item.reason === 'Strategy disabled')!.calls).toBe(1);
  });

  it('tracks markers through their retrieval lifecycle', async () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });

    const first = engine.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });
    const marker = parseMarkers(first.text)[0]!;

    engine.retrieve({ id: marker.id, startLine: marker.startLine, endLine: marker.startLine, maxLines: 1 });
    engine.retrieve({ id: marker.id, grep: 'FAIL', maxLines: 5 });

    const server = await startDashboardServer(engine, { port: 0 });
    servers.push(server);

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const lifecycle = summary.retrievalAudit.lifecycle;
    expect(lifecycle.shownToModel).toBeGreaterThan(0);
    expect(lifecycle.retrievedById).toBe(1);
    expect(lifecycle.retrievedByGrep).toBe(1);
    expect(lifecycle.expired).toBe(0);

    // Markers are recorded when the payload is sent, not re-parsed later.
    const compression = summary.events.find((event) => event.tool === 'run_command')!;
    expect(compression.markers!.length).toBeGreaterThan(0);
    expect(compression.markers![0]!.artifactId).toBe(marker.id);

    const modes = summary.events
      .filter((event) => event.tool === 'retrieve_artifact')
      .map((event) => event.retrievalMode)
      .sort();
    expect(modes).toEqual(['grep', 'id']);
  });

  it('separates expired markers from ones the model never needed', async () => {
    const root = tempRoot();
    // A one-entry cap forces the next write to evict the previous artifact.
    const engine = new CompressionEngine({
      rootDir: root,
      workspaceRoots: [root],
      config: { artifactMaxEntries: 1 },
    });

    engine.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });
    engine.compressCommandOutput({
      command: 'npm run lint',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(60),
      stderr: '',
    });

    const server = await startDashboardServer(engine, { port: 0 });
    servers.push(server);

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const eviction = summary.events.find((event) => event.strategy === 'session:evict');
    expect(eviction).toBeDefined();
    expect(eviction!.outcomeReason).toBe('Artifacts evicted');
    expect(eviction!.evictedArtifactIds!.length).toBeGreaterThan(0);
    expect(summary.retrievalAudit.lifecycle.expired).toBeGreaterThan(0);
  });

  it('keeps the readable port when a reloading host releases it', async () => {
    const root = tempRoot();
    const first = await startDashboardServer(
      new CompressionEngine({ rootDir: root, workspaceRoots: [root] }),
      { port: 0 },
    );
    servers.push(first);

    // A second server wants the port the first one holds. Release it mid-retry,
    // the way a reloading extension host does, and the readable URL survives.
    const pending = startDashboardServer(
      new CompressionEngine({ rootDir: root, workspaceRoots: [root] }),
      { port: first.port, portRetryMs: 4000 },
    );
    setTimeout(() => void first.close(), 300);

    const second = await pending;
    servers.push(second);
    expect(second.port).toBe(first.port);
    expect(second.usedPreferredPort).toBe(true);
  });

  it('falls back to a free port when the preferred one stays taken', async () => {
    const root = tempRoot();
    const holder = await startDashboardServer(
      new CompressionEngine({ rootDir: root, workspaceRoots: [root] }),
      { port: 0 },
    );
    servers.push(holder);

    const second = await startDashboardServer(
      new CompressionEngine({ rootDir: root, workspaceRoots: [root] }),
      { port: holder.port, portRetryMs: 200 },
    );
    servers.push(second);

    expect(second.port).not.toBe(holder.port);
    expect(second.usedPreferredPort).toBe(false);
  });

  it('reports lifetime totals beyond the recent event window', async () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    engine.recordChatSubmitted();

    // More events than the session panels window, so the two scopes disagree.
    for (let i = 0; i < 45; i++) {
      engine.compressCommandOutput({
        command: `npm test -- shard${i}`,
        cwd: root,
        exitCode: 1,
        stdout: jestFailureLog(45),
        stderr: '',
      });
    }

    const server = await startDashboardServer(engine, { port: 0 });
    servers.push(server);

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    expect(summary.events).toHaveLength(summary.lifetime.recentWindow);
    expect(summary.lifetime.events).toBe(46);
    expect(summary.lifetime.chatsObserved).toBe(1);
    expect(summary.lifetime.compressions).toBe(45);
    // Lifetime must count every event, not just the ones still in the window.
    expect(summary.lifetime.tokensSaved).toBe(summary.summary.tokensSaved);
    expect(summary.lifetime.tokensSaved).toBeGreaterThan(0);

    const windowed = summary.events.reduce(
      (total, event) => total + Math.max(0, event.tokensBefore - event.tokensAfter),
      0,
    );
    expect(summary.lifetime.tokensSaved).toBeGreaterThan(windowed);

    expect(summary.history).toHaveLength(1);
    expect(summary.history[0]!.calls).toBe(45);
    expect(summary.history[0]!.tokensSaved).toBe(summary.lifetime.tokensSaved);
    expect(summary.history[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const report = await fetch(`${server.url}api/report.md?t=`);
    const markdown = await report.text();
    expect(markdown).toContain('## Lifetime');
    expect(markdown).toContain('| Chats observed | 1 |');
    expect(markdown).toContain('## Daily savings');
  });

  it('names the concrete waste it removed', async () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root], config: { maxFileLines: 20 } });

    engine.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });
    // Dense, short output: compression cannot pay for its own markers.
    engine.compressCommandOutput({
      command: 'echo hi',
      cwd: root,
      exitCode: 0,
      stdout: 'hi',
      stderr: '',
    });
    const filePath = path.join(root, 'src', 'catalog.ts');
    engine.compressFileRead({ path: filePath, content: sourceFile(35, 'alpha') });
    engine.compressFileRead({ path: filePath, content: sourceFile(35, 'alpha') });

    const server = await startDashboardServer(engine, { port: 0 });
    servers.push(server);

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const byId = new Map(summary.wasteSignals.map((signal) => [signal.id, signal]));

    expect(byId.get('log')!.calls).toBe(1);
    expect(byId.get('log')!.tokensSaved).toBeGreaterThan(0);
    expect(byId.get('repeat-read')!.calls).toBe(1);
    expect(byId.get('capped-read')!.calls).toBe(1);
    // Signals with no occurrences are left out rather than shown as zero rows.
    expect(summary.wasteSignals.every((signal) => signal.calls > 0)).toBe(true);

    const report = await fetch(`${server.url}api/report.md?t=`);
    expect(await report.text()).toContain('## Waste removed');
  });

  it('splits estimated savings into buckets and subtracts retrieval', async () => {
    const { server } = await startSeededDashboard();

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    const cost = summary.costAttribution;

    expect(cost.buckets.map((bucket) => bucket.label)).toContain('Log compression');
    expect(cost.usdPerMillionTokens).toBe(summary.config.usdPerMillionTokens);

    // Buckets must account for the gross saving, and retrieval is a cost paid back.
    const bucketed = cost.buckets.reduce((total, bucket) => total + bucket.tokens, 0);
    expect(cost.grossTokensSaved).toBe(bucketed);
    expect(cost.retrievalTokens).toBeGreaterThan(0);
    expect(cost.netTokensSaved).toBe(cost.grossTokensSaved - cost.retrievalTokens);
    expect(cost.netUsd).toBeLessThan(cost.grossUsd);

    // Retrieval is never double counted as a saving bucket.
    expect(cost.buckets.some((bucket) => bucket.label === 'Retrieval')).toBe(false);

    const report = await fetch(`${server.url}api/report.md?t=`);
    expect(await report.text()).toContain('## Cost attribution');
  });

  it('compares a later run against a saved baseline', async () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    engine.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });

    const server = await startDashboardServer(engine, { port: 0 });
    servers.push(server);

    const before = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    expect(before.comparison.baseline).toBeUndefined();
    expect(before.comparison.deltas).toEqual([]);
    expect(before.comparison.benchmark).toMatchObject({
      kind: 'synthetic', seed: 20260907, profile: 'balanced', scenarios: 6,
      retrievalRate: null, totalOverheadMs: null,
    });
    expect(before.comparison.benchmark.tokensSaved).toBeGreaterThan(0);
    expect(before.comparison.current.tokensSaved).toBe(before.summary.tokensSaved);
    const originalSummary = engine.summary();
    const originalLedger = engine.ledger.all();
    const repeated = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    expect(repeated.comparison.benchmark).toEqual(before.comparison.benchmark);
    expect(engine.summary()).toEqual(originalSummary);
    expect(engine.ledger.all()).toEqual(originalLedger);

    const forbidden = await fetch(`${server.url}api/baseline?t=`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.test' },
      body: '{}',
    });
    expect(forbidden.status).toBe(403);

    const saved = await fetch(`${server.url}api/baseline?t=`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(saved.status).toBe(200);
    const baselineTokens = ((await saved.json()) as DashboardSummaryPayload).comparison.baseline!.tokensSaved;

    // More traffic after the baseline should show up as a positive change.
    engine.compressCommandOutput({
      command: 'npm run lint',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(60),
      stderr: '',
    });

    const after = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    expect(after.comparison.baseline!.tokensSaved).toBe(baselineTokens);
    expect(after.comparison.benchmark).toEqual(before.comparison.benchmark);

    const savedDelta = after.comparison.deltas.find((delta) => delta.metric === 'Tokens saved')!;
    expect(savedDelta.baseline).toBe(baselineTokens);
    expect(savedDelta.current).toBeGreaterThan(baselineTokens);
    expect(savedDelta.change).toBe(savedDelta.current - savedDelta.baseline);
    expect(savedDelta.percentChange).toBeGreaterThan(0);

    // A zero baseline has no meaningful percent change.
    const retrieval = after.comparison.deltas.find((delta) => delta.metric === 'Retrieval rate')!;
    expect(retrieval.baseline).toBe(0);
    expect(retrieval.percentChange).toBeUndefined();
  });

  it('groups outputs globally and by producer session', async () => {
    const root = tempRoot();
    const first = new CompressionEngine({ rootDir: root, workspaceRoots: [root], sessionId: 'alpha-session' });
    const second = new CompressionEngine({
      rootDir: root,
      workspaceRoots: [root],
      sessionId: 'beta-session',
      sessionLabel: 'VS Code: Other window',
    });
    first.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });
    second.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(30),
      stderr: '',
    });

    const server = await startDashboardServer(first, { port: 0 });
    servers.push(server);

    const summary = await json<DashboardSummaryPayload>(`${server.url}api/summary?t=`);
    expect(summary.outputGroups.map((group) => group.id)).toEqual(['global', 'alpha-session', 'beta-session']);
    expect(summary.outputGroups[0]!.label).toBe('Global outputs');
    expect(summary.outputGroups[0]!.calls).toBe(2);
    expect(summary.outputGroups.find((group) => group.id === 'alpha-session')!.label).toBe('This session');
    expect(summary.outputGroups.find((group) => group.id === 'beta-session')!.label).toBe('VS Code: Other window');
    expect(summary.traffic.producerSessions).toBe(2);
    expect(summary.traffic.totalOutputs).toBe(2);
    expect(summary.workspaceAttribution).toHaveLength(1);
    expect(summary.workspaceAttribution[0]!.calls).toBe(2);
    expect(summary.workspaceAttribution[0]!.label).toBe(path.basename(root));
    expect(summary.events.every((event) => event.sessionId)).toBe(true);
    expect(summary.events.every((event) => event.workspaceRoot === root)).toBe(true);
  });

  it('reconciles the daily table: Saved equals In minus Out even with expansions', () => {
    const root = tempRoot();
    const engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
    // A real compression that removes tokens...
    engine.compressCommandOutput({
      command: 'npm test',
      cwd: root,
      exitCode: 1,
      stdout: jestFailureLog(45),
      stderr: '',
    });
    // ...and a synthetic entry whose forwarded tokens exceed its input, so its
    // net saving is negative. (The engine itself no longer expands passthrough
    // output, but the dashboard must still report the true net for any entry
    // that does, not a per-entry floor that would overstate the day.)
    engine.ledger.record({
      ts: Date.now(),
      tool: 'run_command',
      label: '$ echo hi',
      strategy: 'passthrough',
      tokensBefore: 5,
      tokensAfter: 40,
      bytesBefore: 20,
      bytesAfter: 160,
      linesBefore: 1,
      linesAfter: 1,
    });

    const expanded = engine.ledger.all().filter((e) => e.tokensAfter > e.tokensBefore);
    expect(expanded.length).toBeGreaterThan(0);

    const payload = buildSummaryPayload(engine);
    expect(payload.history).toHaveLength(1);
    const day = payload.history[0]!;

    // The three columns must reconcile exactly: Saved is the net, not a floor.
    expect(day.tokensSaved).toBe(day.tokensBefore - day.tokensAfter);

    // And the net is strictly below the old floored figure, proving the fix bites.
    const floored = engine.ledger
      .all()
      .reduce((total, e) => total + Math.max(0, e.tokensBefore - e.tokensAfter), 0);
    expect(day.tokensSaved).toBeLessThan(floored);
  });
});