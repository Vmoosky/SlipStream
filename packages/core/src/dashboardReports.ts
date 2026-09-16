import type { DashboardSummaryPayload } from './dashboard.js';
import { formatCost } from './pricing.js';

export function formatDashboardReportMarkdown(
  payload: DashboardSummaryPayload,
  generatedAt: string,
): string {
  const lines: string[] = [
    '# Slipstream Savings Snapshot',
    '',
    `Generated: ${generatedAt}`,
    '',
    'Estimates retain standard uncached input prices recorded per event and use the configured fallback for missing rates. Not a Copilot bill or measured invoice saving.',
    ...summaryLines(payload),
    ...activityLines(payload),
    ...retrievalLines(payload),
    ...strategyLines(payload),
    ...costLines(payload),
    ...lifetimeLines(payload),
  ];
  return `${lines.join('\n')}\n`;
}

function summaryLines(payload: DashboardSummaryPayload): string[] {
  const summary = payload.summary;
  return [
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Tokens saved | ${formatNumber(summary.tokensSaved)} |`,
    `| Tokens in | ${formatNumber(summary.tokensBefore)} |`,
    `| Forwarded | ${formatNumber(summary.tokensAfter)} |`,
    `| Percent saved | ${summary.percentSaved.toFixed(1)}% |`,
    `| Estimated saving | ${formatCost(summary.estimatedCostSavedUsd)} |`,
    `| Recorded-rate coverage | ${summary.cost.coverage} |`,
    `| Known priced subtotal | ${formatCost(summary.cost.knownUsd)} |`,
    `| Default-rate estimate | ${formatCost(summary.cost.fallbackUsd)} |`,
    `| Fallback USD / 1M tokens | ${summary.cost.fallbackUsdPerMillion} |`,
    `| Chats observed | ${formatNumber(payload.lifetime.chatsObserved)} |`,
    `| Tool events observed | ${formatNumber(payload.lifetime.observedToolCalls)} |`,
    `| Compressions | ${formatNumber(summary.compressions)} |`,
    `| Retrievals | ${formatNumber(summary.retrievals)} |`,
    `| Net saved after retrieval | ${formatNumber(payload.tokenFlow.netSavedTokens)} |`,
    `| Dashboard viewers | ${formatNumber(payload.traffic.viewerConnections)} |`,
    `| Active producers (last ${formatNumber(payload.traffic.activeWindowMinutes)} min) | ${formatNumber(payload.traffic.producerSessions)} |`,
    `| Tool outputs (all producers) | ${formatNumber(payload.traffic.totalOutputs)} |`,
  ];
}

function activityLines(payload: DashboardSummaryPayload): string[] {
  const lines: string[] = [
    '',
    '## Workspace attribution',
    '',
    '| Workspace | Calls | In | Out | Saved | % | Last activity |',
    '|---|---:|---:|---:|---:|---:|---|',
  ];

  for (const item of payload.workspaceAttribution) {
    lines.push(
      `| ${escapeMarkdownCell(item.label)} | ${formatNumber(item.calls)} | ${formatNumber(item.tokensBefore)} | ` +
        `${formatNumber(item.tokensAfter)} | ${formatNumber(item.tokensSaved)} | ${item.percentSaved.toFixed(1)}% | ` +
        `${escapeMarkdownCell(item.lastActivity)} |`,
    );
  }

  lines.push(
    '',
    '## Token flow',
    '',
    '| Metric | Tokens |',
    '|---|---:|',
    `| Raw tool output | ${formatNumber(payload.tokenFlow.rawTokens)} |`,
    `| Returned to model | ${formatNumber(payload.tokenFlow.returnedTokens)} |`,
    `| Omitted behind markers | ${formatNumber(payload.tokenFlow.omittedTokens)} |`,
    `| Reintroduced by retrieval | ${formatNumber(payload.tokenFlow.retrievedTokens)} |`,
    `| Net saved after retrieval | ${formatNumber(payload.tokenFlow.netSavedTokens)} |`,
    '',
    '## Outcome reasons',
    '',
    '| Reason | Calls | Saved |',
    '|---|---:|---:|',
  );

  for (const item of payload.outcomeBreakdown) {
    lines.push(
      `| ${escapeMarkdownCell(item.reason)} | ${formatNumber(item.calls)} | ${formatNumber(item.tokensSaved)} |`,
    );
  }
  return lines;
}

function retrievalLines(payload: DashboardSummaryPayload): string[] {
  const audit = payload.retrievalAudit;
  return [
    '',
    '## Retrieval audit',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Expandable markers | ${formatNumber(audit.totalMarkers)} |`,
    `| Markers expanded | ${formatNumber(audit.retrievedMarkers)} |`,
    `| Markers never needed | ${formatNumber(audit.unretrievedMarkers)} |`,
    `| Never-needed rate | ${audit.percentUnretrieved.toFixed(1)}% |`,
    `| Omitted lines | ${formatNumber(audit.omittedLines)} |`,
    `| Retrieved lines | ${formatNumber(audit.retrievedLines)} |`,
    '',
    '## Retrieval lifecycle',
    '',
    '| State | Markers |',
    '|---|---:|',
    `| Shown to model | ${formatNumber(audit.lifecycle.shownToModel)} |`,
    `| Retrieved by id | ${formatNumber(audit.lifecycle.retrievedById)} |`,
    `| Retrieved by grep | ${formatNumber(audit.lifecycle.retrievedByGrep)} |`,
    `| Expired or evicted | ${formatNumber(audit.lifecycle.expired)} |`,
    `| Still retrievable | ${formatNumber(audit.lifecycle.stillRetrievable)} |`,
    '',
    '## Reuse health',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Markers emitted | ${formatNumber(payload.reuseHealth.markersEmitted)} |`,
    `| Markers retrieved | ${formatNumber(payload.reuseHealth.markersRetrieved)} |`,
    `| Retrieval rate | ${payload.reuseHealth.retrievalRate.toFixed(1)}% |`,
    `| Dedup markers | ${formatNumber(payload.reuseHealth.dedupMarkers)} |`,
    `| Unchanged read hits | ${formatNumber(payload.reuseHealth.unchangedReadHits)} |`,
    `| Diff read hits | ${formatNumber(payload.reuseHealth.diffReadHits)} |`,
    `| Artifact entries | ${formatNumber(payload.reuseHealth.artifactEntries)} / ${formatNumber(payload.reuseHealth.artifactMaxEntries)} |`,
    `| Artifact storage | ${formatBytes(payload.reuseHealth.artifactBytes)} / ${formatBytes(payload.reuseHealth.artifactMaxBytes)} |`,
    `| Artifact entry cap used | ${payload.reuseHealth.artifactEntryPercent.toFixed(1)}% |`,
    `| Artifact size cap used | ${payload.reuseHealth.artifactBytePercent.toFixed(1)}% |`,
  ];
}

function strategyLines(payload: DashboardSummaryPayload): string[] {
  const lines: string[] = [
    '',
    '## Strategy timing',
    '',
    '| Strategy | Calls | Avg | Min | Max | P95 | Total |',
    '|---|---:|---:|---:|---:|---:|---:|',
  ];

  for (const item of payload.timingBreakdown) {
    lines.push(
      `| ${escapeMarkdownCell(item.name)} | ${formatNumber(item.calls)} | ${formatMs(item.avgMs)} | ` +
        `${formatMs(item.minMs)} | ${formatMs(item.maxMs)} | ${formatMs(item.p95Ms)} | ${formatMs(item.totalMs)} |`,
    );
  }

  lines.push(
    '',
    '## By strategy',
    '',
    '| Strategy | Variants | Calls | Saved | % |',
    '|---|---|---:|---:|---:|',
  );

  for (const item of payload.strategyBreakdown) {
    lines.push(
      `| ${escapeMarkdownCell(item.name)} | ${escapeMarkdownCell(item.strategies.join(', '))} | ` +
        `${formatNumber(item.calls)} | ${formatNumber(item.tokensSaved)} | ${item.percentSaved.toFixed(1)}% |`,
    );
  }

  lines.push('', '## Recent activity', '', '| What | Strategy | Lines | Tokens |', '|---|---|---:|---:|');
  for (const event of payload.events.slice(0, 12)) {
    lines.push(
      `| ${escapeMarkdownCell(event.label)} | ${escapeMarkdownCell(event.strategy)} | ` +
        `${formatNumber(event.linesBefore)} -> ${formatNumber(event.linesAfter)} | ` +
        `${formatNumber(event.tokensBefore)} -> ${formatNumber(event.tokensAfter)} |`,
    );
  }
  return lines;
}

function costLines(payload: DashboardSummaryPayload): string[] {
  const lines: string[] = [
    '',
    '## Waste removed',
    '',
    '| What was avoided | Times | Saved |',
    '|---|---:|---:|',
  ];

  for (const signal of payload.wasteSignals) {
    lines.push(
      `| ${escapeMarkdownCell(signal.label)} | ${formatNumber(signal.calls)} | ${formatNumber(signal.tokensSaved)} |`,
    );
  }

  lines.push(
    '',
    '## Cost attribution',
    '',
    '| Bucket | Calls | Tokens | Estimated |',
    '|---|---:|---:|---:|',
  );

  for (const bucket of payload.costAttribution.buckets) {
    lines.push(
      `| ${escapeMarkdownCell(bucket.label)} | ${formatNumber(bucket.calls)} | ${formatNumber(bucket.tokens)} | ` +
        `${formatCost(bucket.usd)} |`,
    );
  }
  lines.push(
    `| Retrieval paid back | | -${formatNumber(payload.costAttribution.retrievalTokens)} | ` +
      `${formatCost(payload.costAttribution.retrievalUsd === null ? null : -payload.costAttribution.retrievalUsd)} |`,
    `| Net saved | | ${formatNumber(payload.costAttribution.netTokensSaved)} | ` +
      `${formatCost(payload.costAttribution.netUsd)} |`,
  );

  lines.push('', '| Model / basis | Coverage | Net estimate | Known net subtotal |', '|---|---|---:|---:|');
  for (const model of payload.costAttribution.models) {
    lines.push(`| ${escapeMarkdownCell(model.label)} | ${model.cost.coverage} | ${formatCost(model.cost.usd)} | ${formatCost(model.cost.knownUsd)} |`);
  }
  return lines;
}

function lifetimeLines(payload: DashboardSummaryPayload): string[] {
  const lines: string[] = [
    '',
    '## Lifetime',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Recorded events | ${formatNumber(payload.lifetime.events)} |`,
    `| Chats observed | ${formatNumber(payload.lifetime.chatsObserved)} |`,
    `| Tool events observed | ${formatNumber(payload.lifetime.observedToolCalls)} |`,
    `| Tokens saved | ${formatNumber(payload.lifetime.tokensSaved)} |`,
    `| Percent saved | ${payload.lifetime.percentSaved.toFixed(1)}% |`,
    `| Estimated cost saved | ${formatCost(payload.lifetime.estimatedCostSavedUsd)} |`,
    `| Session panels show | last ${formatNumber(payload.lifetime.recentWindow)} events |`,
    '',
    '## Daily savings',
    '',
    '| Date | Calls | In | Out | Saved | % |',
    '|---|---:|---:|---:|---:|---:|',
  ];

  for (const bucket of payload.history.slice(0, 14)) {
    lines.push(
      `| ${bucket.date} | ${formatNumber(bucket.calls)} | ${formatNumber(bucket.tokensBefore)} | ` +
        `${formatNumber(bucket.tokensAfter)} | ${formatNumber(bucket.tokensSaved)} | ${bucket.percentSaved.toFixed(1)}% |`,
    );
  }
  return lines;
}

export function formatDashboardReportJson(
  payload: DashboardSummaryPayload,
  generatedAt: string,
): string {
  return `${JSON.stringify({ generatedAt, ...payload }, null, 2)}\n`;
}

export function formatDashboardReportCsv(
  payload: DashboardSummaryPayload,
  generatedAt: string,
): string {
  const rows: string[][] = [['section', 'name', 'value', 'detail']];
  rows.push(['metadata', 'generatedAt', generatedAt, '']);
  rows.push(['metadata', 'pricingBasis', 'public-api-reference', 'Standard uncached input; recorded event rates plus configured fallback for missing rates; not Copilot billing']);
  rows.push(['metadata', 'lastDetectedModelPricing', JSON.stringify(payload.pricingSnapshot), 'Current cached rate for the last detected request; historical snapshots are unchanged']);
  rows.push(['summary', 'tokensSaved', String(payload.summary.tokensSaved), '']);
  rows.push(['activity', 'chatsObserved', String(payload.lifetime.chatsObserved), '']);
  rows.push(['activity', 'observedToolCalls', String(payload.lifetime.observedToolCalls), 'Observation only; no compression attributed']);
  rows.push(['summary', 'tokensBefore', String(payload.summary.tokensBefore), '']);
  rows.push(['summary', 'tokensAfter', String(payload.summary.tokensAfter), '']);
  rows.push(['summary', 'percentSaved', payload.summary.percentSaved.toFixed(1), '']);
  rows.push(['summary', 'estimatedCostSavedUsd', payload.summary.estimatedCostSavedUsd?.toFixed(2) ?? 'N/A', '']);
  rows.push(['summary', 'priceCoverage', payload.summary.cost.coverage, '']);
  rows.push(['summary', 'knownPricedSubtotalUsd', String(payload.summary.cost.knownUsd), '']);
  rows.push(['summary', 'fallbackEstimatedSubtotalUsd', String(payload.summary.cost.fallbackUsd), 'Estimate for events without recorded rates']);
  rows.push(['summary', 'fallbackUsdPerMillionTokens', String(payload.summary.cost.fallbackUsdPerMillion), 'Configured default; recorded event rates take precedence']);
  rows.push(['summary', 'netEstimateUsd', payload.costAttribution.netUsd?.toString() ?? 'N/A', payload.costAttribution.cost.coverage]);
  for (const model of payload.costAttribution.models) {
    rows.push(['modelCost', model.label, model.cost.usd?.toString() ?? 'N/A', JSON.stringify(model.cost)]);
  }
  rows.push(['traffic', 'dashboardViewers', String(payload.traffic.viewerConnections), '']);
  rows.push(['traffic', 'producerSessions', String(payload.traffic.producerSessions), payload.traffic.currentSessionLabel]);
  rows.push(['traffic', 'globalOutputs', String(payload.traffic.totalOutputs), '']);
  for (const item of payload.workspaceAttribution) {
    rows.push(['workspace', item.label, String(item.tokensSaved), `${item.calls} call(s); ${item.root ?? 'unknown root'}`]);
  }
  rows.push(['tokenFlow', 'rawToolOutput', String(payload.tokenFlow.rawTokens), '']);
  rows.push(['tokenFlow', 'returnedToModel', String(payload.tokenFlow.returnedTokens), '']);
  rows.push(['tokenFlow', 'netSavedAfterRetrieval', String(payload.tokenFlow.netSavedTokens), '']);

  for (const item of payload.strategyBreakdown) {
    rows.push(['strategy', item.name, String(item.tokensSaved), `${item.calls} call(s); ${item.strategies.join(', ')}`]);
  }
  for (const item of payload.outcomeBreakdown) {
    rows.push(['outcome', item.reason, String(item.calls), `${item.tokensSaved} token(s) saved`]);
  }
  for (const event of payload.events) {
    rows.push(['event', event.label, String(Math.max(0, event.tokensBefore - event.tokensAfter)), event.strategy]);
  }

  return `${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n')}\n`;
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatMs(value: number): string {
  return `${Math.max(0, value).toFixed(1)} ms`;
}

function formatBytes(value: number): string {
  const bytes = Math.max(0, value);
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function escapeCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}