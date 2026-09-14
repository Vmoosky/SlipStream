import { formatCost, watchLedgerChanges, type CompressionEngine } from '@slipstream/core';
import * as vscode from 'vscode';

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function createStatusBar(
  context: vscode.ExtensionContext,
  engine: CompressionEngine,
): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'slipstream.showDashboard';

  const render = (): void => {
    const summary = engine.summary();
    const enabled = engine.getConfig().enabled;
    const chats = engine.ledger.all().filter((entry) => entry.strategy === 'session:chat').length;

    if (!enabled) {
      item.text = '$(circle-slash) Slipstream off';
      item.tooltip = 'Slipstream compression is disabled. Click for the dashboard.';
    } else if (summary.compressions === 0) {
      item.text = '$(zap) Slipstream';
      item.tooltip = `${chats} chat prompt(s) observed. No tool output compressed yet. Click for the dashboard.`;
    } else {
      item.text = `$(zap) ${summary.percentSaved.toFixed(0)}% · ${compact(summary.tokensSaved)} saved`;
      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`**Slipstream**\n\n`);
      tooltip.appendMarkdown(`${chats} chat prompt(s) observed\n\n`);
      tooltip.appendMarkdown(
        `${summary.tokensBefore.toLocaleString()} tokens in → ` +
          `${summary.tokensAfter.toLocaleString()} forwarded\n\n`,
      );
      tooltip.appendMarkdown(
        `${summary.tokensSaved.toLocaleString()} saved across ${summary.compressions} ` +
          `compression(s) — API reference estimate ${formatCost(summary.estimatedCostSavedUsd)} (${summary.cost.coverage})\n\n`,
      );
      tooltip.appendMarkdown(`Click for the dashboard.`);
      item.tooltip = tooltip;
    }
    item.show();
  };

  render();
  context.subscriptions.push(item, { dispose: engine.ledger.onRecord(render) }, { dispose: watchLedgerChanges(engine.ledger.path(), render) });

  // Config changes flip the "off" badge without waiting for the next tool call.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('slipstream')) {
        setTimeout(render, 0);
      }
    }),
  );
}
