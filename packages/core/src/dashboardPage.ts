/**
 * Dashboard page markup: the single HTML document served to both the VS Code
 * webview and the local HTTP server, plus its inline icon rendering.
 *
 * This module is presentation only. It builds no payloads and reads no ledger
 * state; `dashboard.ts` owns that and its payload types. Keeping the document
 * here keeps the data-shaping module small enough to read and review.
 */

import { Activity, Check, ChevronDown, Download, Info, Palette, Plug, RefreshCw, RotateCcw, Settings2, TriangleAlert, Unplug, X, type IconNode } from 'lucide';

function renderIcon(node: IconNode): string {
  const shapes = node.map(([tag, attributes]) => {
    const values = Object.entries(attributes).map(([name, value]) => `${name}="${value}"`).join(' ');
    return `<${tag} ${values}></${tag}>`;
  }).join('');
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes}</svg>`;
}

/**
 * The dashboard page, used unchanged by the VS Code webview and the local HTTP
 * server. The script detects which one it is running in and either talks over
 * `postMessage` or uses a local event stream backed by the JSON endpoints.
 *
 * Every value it displays comes from tool output, which is untrusted. Nothing is
 * ever interpolated into this HTML and nothing is written with innerHTML; the
 * only substitutions are the generated nonce and trusted, bundled Lucide icons.
 */
export function renderDashboardHtml(nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Slipstream Savings</title>
<style nonce="${nonce}">
  /* Inside VS Code these resolve to theme colours; in a browser the fallbacks apply. */
  :root {
    color-scheme: light dark;
    --ss-fg: var(--vscode-foreground, #1f2328);
    --ss-bg: var(--vscode-editor-background, #ffffff);
    --ss-muted: var(--vscode-descriptionForeground, #656d76);
    --ss-border: var(--vscode-panel-border, #d8dee4);
    --ss-green: var(--vscode-charts-green, #1a7f37);
    --ss-blue: var(--vscode-charts-blue, #0969da);
    --ss-input: var(--vscode-input-background, #eff2f5);
    --ss-badge-bg: var(--vscode-badge-background, #eaeef2);
    --ss-badge-fg: var(--vscode-badge-foreground, #1f2328);
    --ss-widget: var(--vscode-editorWidget-background, #f6f8fa);
    --ss-quote: var(--vscode-textBlockQuote-background, #f6f8fa);
    --ss-hover: var(--vscode-list-hoverBackground, #eef1f4);
    --ss-sel-bg: var(--vscode-list-activeSelectionBackground, #0969da);
    --ss-sel-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
    --ss-cut: var(--vscode-diffEditor-removedTextBackground, rgba(255,129,130,.22));
    --ss-warn-bg: var(--vscode-inputValidation-warningBackground, #fff8c5);
    --ss-warn-border: var(--vscode-inputValidation-warningBorder, #d4a72c);
    --ss-font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --ss-mono: var(--vscode-editor-font-family, ui-monospace, "Cascadia Code", Consolas, monospace);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ss-fg: var(--vscode-foreground, #e6edf3);
      --ss-bg: var(--vscode-editor-background, #0d1117);
      --ss-muted: var(--vscode-descriptionForeground, #8b949e);
      --ss-border: var(--vscode-panel-border, #30363d);
      --ss-green: var(--vscode-charts-green, #3fb950);
      --ss-blue: var(--vscode-charts-blue, #58a6ff);
      --ss-input: var(--vscode-input-background, #161b22);
      --ss-badge-bg: var(--vscode-badge-background, #21262d);
      --ss-badge-fg: var(--vscode-badge-foreground, #e6edf3);
      --ss-widget: var(--vscode-editorWidget-background, #161b22);
      --ss-quote: var(--vscode-textBlockQuote-background, #161b22);
      --ss-hover: var(--vscode-list-hoverBackground, #21262d);
      --ss-warn-bg: var(--vscode-inputValidation-warningBackground, #341a00);
    }
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --ss-fg: #1f2328;
    --ss-bg: #ffffff;
    --ss-muted: #656d76;
    --ss-border: #d8dee4;
    --ss-green: #1a7f37;
    --ss-blue: #0969da;
    --ss-input: #eff2f5;
    --ss-badge-bg: #eaeef2;
    --ss-badge-fg: #1f2328;
    --ss-widget: #f6f8fa;
    --ss-quote: #f6f8fa;
    --ss-hover: #eef1f4;
    --ss-sel-bg: #0969da;
    --ss-sel-fg: #ffffff;
    --ss-cut: rgba(255,129,130,.22);
    --ss-warn-bg: #fff8c5;
    --ss-warn-border: #d4a72c;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --ss-fg: #e6edf3;
    --ss-bg: #0d1117;
    --ss-muted: #8b949e;
    --ss-border: #30363d;
    --ss-green: #3fb950;
    --ss-blue: #58a6ff;
    --ss-input: #161b22;
    --ss-badge-bg: #21262d;
    --ss-badge-fg: #e6edf3;
    --ss-widget: #161b22;
    --ss-quote: #161b22;
    --ss-hover: #21262d;
    --ss-sel-bg: #1f6feb;
    --ss-sel-fg: #ffffff;
    --ss-cut: rgba(255,129,130,.22);
    --ss-warn-bg: #341a00;
    --ss-warn-border: #bb8009;
  }
  body {
    font-family: var(--ss-font); font-size: 13px; color: var(--ss-fg);
    background: var(--ss-bg); margin: 0; padding: 20px 24px 48px;
    max-width: 1400px;
  }
  .masthead { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 20px;
    position: sticky; top: 0; z-index: 5; padding: 12px 0; background: var(--ss-bg); }
  .mastheadText { min-width: 0; }
  .mastheadActions { display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: var(--ss-muted); font-size: 12px; }
  .hero { display: flex; gap: 28px; align-items: baseline; flex-wrap: wrap; margin-bottom: 18px; }
  .pct { font-size: 46px; font-weight: 650; line-height: 1; color: var(--ss-green); }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat .v { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--ss-muted); }
  .bar { height: 22px; border-radius: 4px; overflow: hidden; display: flex;
         background: var(--ss-input); margin-bottom: 6px; }
  .bar .kept { background: var(--ss-blue); transition: width .3s ease; }
  .bar .saved { background: var(--ss-green); transition: width .3s ease; }
  .legend { font-size: 11px; color: var(--ss-muted); margin-bottom: 22px; }
  .legend span { margin-right: 16px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
  /* Not inline style attributes: a nonce-based style-src blocks those. */
  .dot.forwarded { background: var(--ss-blue); }
  .dot.removed { background: var(--ss-green); }
    .dashboardTabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 18px 0 12px; }
    .dashboardTab { border: 1px solid var(--ss-border); border-radius: 999px; padding: 5px 10px;
      background: var(--ss-widget); color: var(--ss-fg); font: inherit; font-size: 12px; cursor: pointer; }
    .dashboardTab.active { background: var(--ss-sel-bg); color: var(--ss-sel-fg); border-color: var(--ss-sel-bg); }
    .dashboardPanel[hidden] { display: none; }
    .dashboardPanel { margin-top: 4px; }
    .healthChecks { display: flex; flex-direction: column; gap: 6px; margin: 4px 0; }
    .healthChecks:empty { display: none; }
    .healthCheck { display: flex; align-items: flex-start; gap: 8px; font-size: 12px;
        border: 1px solid var(--ss-border); border-radius: 6px; padding: 6px 10px; background: var(--ss-widget); }
    .healthCheck .healthIcon { font-weight: 700; line-height: 1.4; }
    .healthCheck .healthName { font-weight: 600; }
    .healthCheck .healthDetail { color: var(--ss-muted); }
    .healthCheck.pass .healthIcon { color: var(--ss-green); }
    .healthCheck.warn .healthIcon { color: var(--ss-warn-border); }
    .healthCheck.fail .healthIcon { color: #cf222e; }
    .dashboardDetails { border-top: 1px solid var(--ss-border); padding-top: 8px; margin-top: 14px; }
    .dashboardDetails > summary { cursor: pointer; color: var(--ss-muted); font-size: 12px; font-weight: 600;
      text-transform: uppercase; letter-spacing: .5px; list-style-position: inside; }
    .dashboardDetails > summary h2 { display: inline; margin: 0 0 0 4px; }
    .dashboardDetails > summary:hover { color: var(--ss-fg); }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .5px;
       color: var(--ss-muted); margin: 24px 0 8px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; font-weight: 600; padding: 5px 8px 5px 0;
       border-bottom: 1px solid var(--ss-border); color: var(--ss-muted); }
  td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--ss-border); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.num:last-child, th.num:last-child { padding-right: 0; }
  td.label { max-width: 380px; overflow-wrap: anywhere; font-family: var(--ss-mono); font-size: 11.5px; }
  tr.event { cursor: pointer; }
  tr.event:hover td { background: var(--ss-hover); }
  tr.event.active td { background: var(--ss-sel-bg); color: var(--ss-sel-fg); }
  .tag { font-size: 10.5px; padding: 1px 6px; border-radius: 10px;
         background: var(--ss-badge-bg); color: var(--ss-badge-fg); }
    .statusPill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--ss-border);
        border-radius: 999px; padding: 4px 8px; background: var(--ss-widget); color: var(--ss-muted);
        font-size: 11.5px; }
    .statusPill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--ss-muted); }
    .statusPill.connected::before { background: var(--ss-green); }
    .statusPill.error::before { background: #cf222e; }
    .statusPill.inactive::before { background: var(--ss-warn-border); }
    .outputTabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0 0 8px; }
    .outputTab { border: 1px solid var(--ss-border); border-radius: 999px; padding: 4px 9px;
       background: var(--ss-widget); color: var(--ss-fg); font: inherit; font-size: 11.5px; cursor: pointer; }
    .outputTab.active { background: var(--ss-sel-bg); color: var(--ss-sel-fg); border-color: var(--ss-sel-bg); }
    .outputMeta { color: var(--ss-muted); font-size: 11.5px; margin: 0 0 8px; }
  .note { margin-top: 18px; padding: 10px 12px; border-radius: 5px; font-size: 12px;
          background: var(--ss-quote); border-left: 3px solid var(--ss-green); }
  .empty { color: var(--ss-muted); font-size: 12px; padding: 12px 0; }
  .off { background: var(--ss-warn-bg); border-left-color: var(--ss-warn-border); }
  .timeline { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--ss-border); }
  .timelineItem { display: grid; grid-template-columns: 78px 116px minmax(0, 1fr) auto;
                  gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--ss-border);
                  align-items: baseline; }
  .timelineItem.inspectable { cursor: pointer; }
  .timelineItem.inspectable:hover { background: var(--ss-hover); }
  .timelineTime { color: var(--ss-muted); font-variant-numeric: tabular-nums; font-size: 11px; }
  .timelineTitle { font-family: var(--ss-mono); font-size: 11.5px; overflow-wrap: anywhere; }
  .timelineDetail { color: var(--ss-muted); font-size: 11.5px; margin-top: 2px; }
  .timelineSaved { color: var(--ss-green); font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 11.5px; }
  .auditCallout { margin: 0 0 8px; padding: 8px 10px; border: 1px solid var(--ss-border);
                  border-left: 3px solid var(--ss-green); border-radius: 5px; background: var(--ss-quote);
                  font-size: 12px; color: var(--ss-muted); }
  .auditCallout strong { color: var(--ss-green); font-weight: 650; }
  .auditStatus { color: var(--ss-muted); font-size: 11.5px; }
  .auditStatus strong { color: var(--ss-green); font-weight: 600; }
  .configGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 8px; margin-bottom: 18px; }
  .configItem { border: 1px solid var(--ss-border); border-radius: 5px; padding: 7px 9px;
                background: var(--ss-widget); min-width: 0; }
  .configItem .k { display: block; color: var(--ss-muted); font-size: 10.5px;
                   text-transform: uppercase; letter-spacing: .5px; }
  .configItem .v { display: block; margin-top: 5px; font-size: 12px; overflow-wrap: anywhere; }
  .configItem input, .configItem select { width: 100%; min-width: 0; box-sizing: border-box; margin-top: 5px; border: 1px solid var(--ss-border);
                      border-radius: 4px; padding: 4px 6px; background: var(--ss-input); color: var(--ss-fg);
                      font: inherit; font-size: 12px; }
  .configItem input[type="checkbox"] { width: auto; margin: 6px 6px 0 0; }
  .configItem.checkbox .v { display: flex; align-items: center; gap: 4px; }
  .configMessage { margin: -10px 0 18px; min-height: 16px; }
  .modelTrackingPanel { border-top: 1px solid var(--ss-border); border-bottom: 1px solid var(--ss-border);
    padding: 16px 0; margin: 20px 0 18px; }
  .modelTrackingHead { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px 20px; }
  .modelTrackingHead h2 { margin: 0; font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--ss-fg); }
  .modelTrackingActions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
  #modelTrackingDetail, #pricingStatus { overflow-wrap: anywhere; margin: 8px 0 0; }
  .cliTracking { margin: 10px 0 0; }
  .cliTracking[hidden] { display: none; }
  .cliTrackingLead { margin: 0 0 8px; font-size: 12px; color: var(--ss-fg); }
  .cliTrackingSteps { margin: 0; padding-left: 18px; font-size: 12px; color: var(--ss-muted); }
  .cliTrackingSteps li { margin: 0 0 6px; }
  .cliTrackingCmd { display: block; margin: 4px 0 0; padding: 5px 8px; border: 1px solid var(--ss-border);
    border-radius: 4px; font-family: var(--ss-mono, monospace); font-size: 11px; color: var(--ss-fg);
    background: var(--ss-surface, transparent); overflow-wrap: anywhere; user-select: all; }
  .cliTrackingNote { margin: 8px 0 0; }
  .modelPricing { display: grid; grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr));
    gap: 16px 24px; margin: 16px 0 0; overflow-wrap: anywhere; }
  .modelPricing > div, .receiverHealthMetrics > div, .catalogMetrics > div { min-width: 0; }
  .modelPricing dt, .receiverHealthMetrics dt, .catalogMetrics dt { color: var(--ss-muted); font-size: 11.5px; margin-bottom: 4px; }
  .modelPricing dd, .receiverHealthMetrics dd, .catalogMetrics dd { margin: 0; font-size: 12px; line-height: 1.5; font-variant-numeric: tabular-nums; }
  .receiverHealth, .catalogHealth { border-bottom: 1px solid var(--ss-border); padding-bottom: 16px; margin-bottom: 20px; }
  .receiverHealthMetrics, .catalogMetrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr));
    gap: 16px 24px; margin: 16px 0 0; overflow-wrap: anywhere; }
  .receiverHealthMetrics[hidden] { display: none; }
  .catalogHead { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .catalogHead h2 { margin: 0; }
  #catalogRefreshStatus { min-height: 18px; margin: 12px 0 0; overflow-wrap: anywhere; }
  #receiverLastAcceptedAge { display: block; min-height: 18px; color: var(--ss-muted); }
  #receiverHealthStatus, #receiverRejections { overflow-wrap: anywhere; }
  .modelPricingWarning { display: flex; align-items: flex-start; gap: 8px; padding: 9px 12px; margin: 12px 0 0;
    border-left: 2px solid var(--ss-warn-border); background: color-mix(in srgb, var(--ss-warn-bg) 35%, var(--ss-bg));
    font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .modelPricingWarning[hidden] { display: none; }
  .modelPricingWarning .icon { color: var(--ss-warn-border); margin-top: 1px; }
  .modelPricingWarning.info { border-left-color: var(--ss-border); background: transparent; color: var(--ss-muted); }
  .modelPricingWarning.info .icon { color: var(--ss-muted); }
  .modelPricingIcon { flex: 0 0 auto; }
  .comparisonScroll { overflow-x: auto; max-width: 100%; }
  .comparisonScroll table { min-width: 620px; }
  .modelUsageScroll table { min-width: 960px; }
  .modelUsageScroll td { vertical-align: top; }
  .modelUsageScroll td.label { min-width: 160px; max-width: 240px; }
  .modelUsageScroll td.modelRate { min-width: 140px; max-width: 180px; white-space: normal; overflow-wrap: anywhere; }
  .modelUsageDetail { display: block; color: var(--ss-muted); font-size: 10.5px; line-height: 1.5; }
  .modelObservationsScroll table { min-width: 1440px; }
  .modelObservationsScroll td { vertical-align: top; }
  .modelObservationsScroll td.label { min-width: 160px; max-width: 240px; white-space: normal; overflow-wrap: anywhere; }
  .modelInputBreakdown { min-width: 190px; }
  .modelInputBreakdown > div { display: grid; grid-template-columns: auto minmax(90px, 1fr); gap: 12px; font-size: 11px; line-height: 1.6; }
  .modelInputBreakdown > div > span:first-child { color: var(--ss-muted); }
  .modelInputBreakdown > div > span:last-child { text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .modelInputTotal { min-width: 140px; max-width: 190px; white-space: normal; overflow-wrap: anywhere; }
  .contextGrowth, .policySettings, .costPolicy, .taskUsage { border-bottom: 1px solid var(--ss-border); padding-bottom: 20px; margin-bottom: 20px; min-width: 0; }
  .costPolicy .hint { overflow-wrap: anywhere; }
  .costPolicyScroll table { min-width: 0; table-layout: fixed; }
  .costPolicyScroll th, .costPolicyScroll td { white-space: normal; overflow-wrap: anywhere; vertical-align: top; }
  .costPolicyScroll th:nth-child(-n+2) { width: 27%; }
  .costPolicyScroll .policyReason { min-width: 0; }
  .taskUsageScroll table { min-width: 1320px; table-layout: fixed; }
  .taskUsageScroll th, .taskUsageScroll td { white-space: normal; overflow-wrap: anywhere; vertical-align: top; }
  .taskUsageScroll th:first-child { width: 14%; }
  .taskUsageScroll th:nth-child(2) { width: 18%; }
  .taskOutcomeStatus { font-weight: 600; }
  .taskEvidence { margin-top: 6px; }
  .taskEvidence summary { cursor: pointer; font-size: 11px; }
  #taskOutcomeNote { overflow-wrap: anywhere; }
  #contextWindow, #contextCoverage { overflow-wrap: anywhere; }
  #contextGrowthChart { display: block; width: 100%; height: 360px; margin: 16px 0 8px; }
  #contextGrowthChart[hidden] { display: none; }
  .contextCallsScroll table { min-width: 700px; }
  .contextCallsScroll td.label { min-width: 150px; max-width: 260px; }
  .proofGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
               gap: 8px; margin-bottom: 18px; }
  .proofItem { border: 1px solid var(--ss-border); border-radius: 5px; padding: 8px 10px;
               background: var(--ss-widget); min-width: 0; }
  .proofItem .k { display: block; color: var(--ss-muted); font-size: 10.5px;
                  text-transform: uppercase; letter-spacing: .5px; }
  .proofItem .v { display: block; margin-top: 3px; font-size: 12px; line-height: 1.4; }
  #trafficStatus .proofItem { padding: 12px 14px; overflow-wrap: anywhere; }
  #trafficStatus .k { font-size: 11.5px; text-transform: none; letter-spacing: 0; }
  #trafficStatus .v { margin-top: 6px; font-size: 20px; font-variant-numeric: tabular-nums; }
  .trafficScope { margin-top: 6px; font-size: 11px; color: var(--ss-muted); }
  @media (max-width: 760px) {
    .timelineItem { grid-template-columns: 72px 1fr; }
    .timelineSaved { grid-column: 2; }
  }

  /* before / after inspector */
  .detailHead { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
  .detailHead .name { font-family: var(--ss-mono); font-size: 12px; overflow-wrap: anywhere; }
  .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .panes[hidden] { display: none; }
  @media (max-width: 900px) { .panes { grid-template-columns: 1fr; } }
  .pane { border: 1px solid var(--ss-border); border-radius: 5px; overflow: hidden;
          display: flex; flex-direction: column; min-width: 0; }
  .paneHead { padding: 6px 10px; font-size: 11px; font-weight: 600;
              background: var(--ss-widget); border-bottom: 1px solid var(--ss-border);
              display: flex; justify-content: space-between; gap: 8px; }
  .paneHead .count { font-weight: 400; color: var(--ss-muted); }
  .paneBody { max-height: 460px; overflow: auto; }
  .payloadActions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .button { border: 1px solid var(--ss-border); border-radius: 4px; padding: 4px 8px;
            background: var(--ss-widget); color: var(--ss-fg); font: inherit; font-size: 11.5px;
            text-decoration: none; cursor: pointer; }
  .masthead .button { flex: 0 0 auto; margin-top: 1px; }
  .button:hover { background: var(--ss-hover); }
  .button[hidden] { display: none; }
  .themePicker { display: inline-flex; align-items: center; gap: 6px; color: var(--ss-muted); font-size: 11.5px; }
  .themePicker select { border: 1px solid var(--ss-border); border-radius: 4px; padding: 4px 24px 4px 8px;
                        background: var(--ss-widget); color: var(--ss-fg); font: inherit; font-size: 11.5px; }
  .payloadMeta { color: var(--ss-muted); font-size: 11.5px; }
  .modeSwitch { display: inline-flex; border: 1px solid var(--ss-border); border-radius: 5px;
                overflow: hidden; margin-bottom: 10px; }
  .modeSwitch button { border: 0; border-right: 1px solid var(--ss-border); padding: 4px 8px;
                       background: var(--ss-widget); color: var(--ss-fg); font: inherit; font-size: 11.5px;
                       cursor: pointer; }
  .modeSwitch button:last-child { border-right: 0; }
  .modeSwitch button.active { background: var(--ss-sel-bg); color: var(--ss-sel-fg); }
  .diffView { border: 1px solid var(--ss-border); border-radius: 5px; overflow: hidden; }
  .diffView[hidden] { display: none; }
  .diffSummary { padding: 6px 10px; font-size: 11.5px; background: var(--ss-widget);
                 border-bottom: 1px solid var(--ss-border); color: var(--ss-muted); }
  .diffLine { margin: 0; padding: 2px 10px; white-space: pre; overflow-x: auto;
              font-family: var(--ss-mono); font-size: 12px; line-height: 1.45; }
  .diffLine.keep { color: var(--ss-muted); }
  .diffLine.remove { background: var(--ss-cut); color: var(--ss-fg); }
  .diffLine.payload { color: var(--ss-green); }
  pre { margin: 0; padding: 6px 10px; white-space: pre; overflow-x: auto;
        font-family: var(--ss-mono); font-size: 12px; line-height: 1.45; }
  .cut { padding: 5px 10px; font-size: 11.5px; cursor: pointer; background: var(--ss-cut);
         border-top: 1px solid var(--ss-border); border-bottom: 1px solid var(--ss-border);
         color: var(--ss-muted); }
  .cut:hover { color: var(--ss-fg); }
  .marker { color: var(--ss-green); }
  .hint { font-size: 11.5px; color: var(--ss-muted); margin: 8px 0 0; }
  code { font-family: var(--ss-mono); font-size: 11.5px; }
  .icon { width: 17px; height: 17px; flex: 0 0 17px; vertical-align: middle; }
  .iconButton { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px;
    box-sizing: border-box; padding: 0; border: 1px solid var(--ss-border); border-radius: 6px;
    background: var(--ss-widget); color: var(--ss-fg); cursor: pointer; }
  .iconButton:hover { background: var(--ss-hover); }
  :is(button, a, select, input, summary):focus-visible { outline: 2px solid var(--ss-blue); outline-offset: 3px; }
  :root:has(.utilityDrawer[open]) { overflow: hidden; }
  .utilityDrawer { position: fixed; inset: 0 0 0 auto; width: min(420px, 100vw); height: 100dvh;
    max-width: 100vw; max-height: 100dvh; margin: 0; padding: 0; box-sizing: border-box; overflow: hidden;
    border: 0; border-left: 1px solid var(--ss-border); border-radius: 0; color: var(--ss-fg); background: var(--ss-bg);
    box-shadow: -12px 0 32px rgba(0,0,0,.12); }
  .utilityDrawer[open] { display: flex; flex-direction: column; animation: drawerEnter .18s ease-out; }
  .utilityDrawer::backdrop { background: rgba(0,0,0,.24); }
  .utilityHead { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 16px 20px; border-bottom: 1px solid var(--ss-border); flex-shrink: 0; }
  .utilityDrawer h2 { display: flex; align-items: center; gap: 9px; margin: 0; font-size: 12px;
    color: var(--ss-fg); text-transform: none; letter-spacing: 0; font-weight: 600; }
  .utilityHead h2 { font-size: 14px; }
  .utilityBody { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 20px 24px; }
  .utilitySection { padding: 18px 0; border-bottom: 1px solid var(--ss-border); }
  .utilitySection[hidden] { display: none; }
  .utilitySection > h2 { margin-bottom: 12px; }
  .utilitySection > summary { display: flex; justify-content: space-between; align-items: center; gap: 12px;
    cursor: pointer; list-style: none; min-height: 24px; }
  .utilitySection > summary::-webkit-details-marker { display: none; }
  .utilitySection > summary > .icon { color: var(--ss-muted); transition: transform .18s ease; }
  .utilitySection[open] > summary { margin-bottom: 14px; }
  .utilitySection[open] > summary > .icon { transform: rotate(180deg); }
  .utilityDrawer .themePicker { display: flex; justify-content: space-between; font-size: 12px; }
  .utilityDrawer .themePicker select { min-height: 34px; min-width: 150px; }
  .utilityExports { display: flex; flex-wrap: wrap; gap: 8px; }
  .utilityDrawer .button, .modelTrackingPanel .button, .policyActions .button { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 34px; box-sizing: border-box; }
  .utilityDrawer .button[hidden], .modelTrackingPanel .button[hidden] { display: none; }
  .utilityDrawer .configGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 16px; margin: 0; }
  .utilityDrawer .configItem { border: 0; border-bottom: 1px solid var(--ss-border); border-radius: 0;
    padding: 12px 0; background: transparent; }
  .utilityDrawer .configItem .k { text-transform: none; letter-spacing: 0; font-size: 11.5px; }
  .utilityDrawer .configItem input:not([type="checkbox"]), .utilityDrawer .configItem select { min-height: 34px; }
  #policyForm { max-width: 680px; }
  .policyFields { border: 0; padding: 0; margin: 12px 0; min-width: 0; }
  .policyGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px; }
  .policyField { display: grid; gap: 6px; min-width: 0; font-size: 11.5px; }
  .policyWide { grid-column: 1 / -1; }
  .policyField input, .policyField select { width: 100%; min-width: 0; min-height: 34px; box-sizing: border-box;
    border: 1px solid var(--ss-border); border-radius: 4px; padding: 6px 8px; color: var(--ss-fg); background: var(--ss-bg); font: inherit; }
  .policyAdvanced { margin-top: 16px; }
  .policyAdvanced > summary { font-size: 12px; cursor: pointer; min-height: 28px; }
  .policyGroup { margin-top: 12px; }
  .policyGroupTitle { margin-bottom: 8px; font-size: 11.5px; }
  .policyModelHeading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .policyModelToolbar { display: grid; grid-template-columns: minmax(0, 1fr) 34px; align-items: end; gap: 8px; margin-bottom: 8px; }
  .policyModelToolbar .iconButton { width: 34px; height: 34px; }
  .policyModelList { max-height: 264px; min-height: 48px; overflow-y: auto; scrollbar-gutter: stable; }
  .policyModelOption { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start;
    min-height: 44px; box-sizing: border-box; padding: 8px 4px; border-bottom: 1px solid var(--ss-border); cursor: pointer; }
  .policyModelOption input { margin: 2px 0 0; width: 16px; height: 16px; }
  .policyModelOption > span { min-width: 0; overflow-wrap: anywhere; }
  .policyModelName { display: block; font-size: 12px; font-weight: 600; }
  .policyModelDetail { display: block; font-size: 11px; color: var(--ss-muted); overflow-wrap: anywhere; }
  #policyModelsStatus { min-height: 18px; margin-top: 6px; overflow-wrap: anywhere; }
  .policyProfiles { display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .policyProfile { display: flex; align-items: center; gap: 6px; min-height: 28px; font-size: 12px; }
  .policyActions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .policyActions .button { min-width: 84px; }
  .policyStatus { min-height: 18px; margin-top: 10px; overflow-wrap: anywhere; }
  .policyFields:disabled { opacity: .65; }
  #recommendationForm { max-width: 680px; }
  .recommendationActions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
  .recommendationActions .iconButton { width: 34px; height: 34px; flex: 0 0 34px; }
  #recommendationStatus { min-height: 20px; margin-top: 12px; overflow-wrap: anywhere; }
  #recommendationSelection { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  #recommendationSelection:empty, #recommendationTiming:empty { display: none; }
  .recommendationScroll table { min-width: 800px; }
  .recommendationScroll th:first-child, .recommendationScroll td:first-child { min-width: 160px; max-width: 240px; white-space: normal; overflow-wrap: anywhere; }
  .recommendationScroll td:last-child { min-width: 160px; max-width: 240px; white-space: normal; overflow-wrap: anywhere; }
  .utilityDrawer .healthCheck { border: 0; border-bottom: 1px solid var(--ss-border); border-radius: 0;
    background: transparent; padding: 10px 0; overflow-wrap: anywhere; }
  .utilityDrawer .healthCheck > div { min-width: 0; }
  .utilityDrawer .configMessage { margin: 0; min-height: 0; flex-shrink: 0; overflow-wrap: anywhere; }
  .utilityDrawer .configMessage:not(:empty) { padding: 12px 20px; border-top: 1px solid var(--ss-border); }
  @keyframes drawerEnter { from { transform: translateX(24px); opacity: .5; } to { transform: translateX(0); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    .utilityDrawer[open] { animation: none; }
    .utilitySection > summary > .icon { transition: none; }
  }
  @media (max-width: 480px) {
    body { padding: 12px 16px 32px; }
    .masthead { gap: 10px; }
    .mastheadActions { gap: 6px; }
    .utilityDrawer { border-left: 0; }
    .modelPricing { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .modelPricing > div:first-child { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
  <div class="masthead">
    <div class="mastheadText">
      <h1>Slipstream</h1>
    </div>
    <div class="mastheadActions">
      <span class="statusPill inactive" id="connectionStatus">Inactive</span>
      <button class="iconButton" type="button" id="openUtilities" title="Dashboard settings" aria-label="Dashboard settings"
        aria-haspopup="dialog" aria-controls="utilityDrawer" aria-expanded="false">${renderIcon(Settings2)}</button>
    </div>
  </div>
  <dialog class="utilityDrawer" id="utilityDrawer" aria-labelledby="utilityTitle">
    <header class="utilityHead">
      <h2 id="utilityTitle">Dashboard settings</h2>
      <button class="iconButton" type="button" id="closeUtilities" title="Close dashboard settings" aria-label="Close dashboard settings" autofocus>${renderIcon(X)}</button>
    </header>
    <div class="utilityBody">
      <section class="utilitySection" aria-labelledby="appearanceTitle">
        <h2 id="appearanceTitle">${renderIcon(Palette)}Appearance</h2>
        <label class="themePicker" for="themeMode">Theme
          <select id="themeMode" aria-label="Dashboard theme">
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>
      <section class="utilitySection" id="exportSettings" aria-labelledby="exportTitle">
        <h2 id="exportTitle">${renderIcon(Download)}Exports</h2>
        <div class="utilityExports">
          <a class="button" id="shareSnapshotLink" download="slipstream-savings-snapshot.md" rel="noreferrer">${renderIcon(Download)}Export snapshot</a>
          <a class="button" id="shareJsonLink" download="slipstream-savings-snapshot.json" rel="noreferrer">${renderIcon(Download)}Export JSON</a>
          <a class="button" id="shareCsvLink" download="slipstream-savings-snapshot.csv" rel="noreferrer">${renderIcon(Download)}Export CSV</a>
        </div>
      </section>
      <details class="utilitySection" id="runtimeSettings">
        <summary><h2>${renderIcon(Settings2)}Runtime config</h2>${renderIcon(ChevronDown)}</summary>
        <form class="configGrid" id="configStatus"></form>
      </details>
      <details class="utilitySection" id="healthSettings">
        <summary><h2>${renderIcon(Activity)}Health check</h2>${renderIcon(ChevronDown)}</summary>
        <div class="payloadActions">
          <button class="button" type="button" id="runHealth">${renderIcon(Activity)}Run health check</button>
          <span class="payloadMeta" id="healthMeta" role="status"></span>
        </div>
        <div class="healthChecks" id="healthChecks"></div>
      </details>
    </div>
    <div class="hint configMessage" id="configMessage" role="status"></div>
  </dialog>
  <div id="off" class="note off" hidden>Compression is currently disabled. Tools are returning raw output.</div>

  <div class="hero">
    <div class="stat" role="group" aria-labelledby="pctLabel" title="Share of tool-output tokens removed before forwarding.">
      <span class="pct" id="pct">0%</span><span class="k" id="pctLabel">Tool-output reduction</span>
    </div>
    <div class="stat"><span class="v" id="chats">0</span><span class="k">chats observed</span></div>
    <div class="stat"><span class="v" id="observedTools">0</span><span class="k">tool events observed</span></div>
    <div class="stat"><span class="v" id="saved">0</span><span class="k">tokens saved</span></div>
    <div class="stat"><span class="v" id="before">0</span><span class="k">tokens in</span></div>
    <div class="stat"><span class="v" id="after">0</span><span class="k">forwarded</span></div>
    <div class="stat"><span class="v" id="cost">$0.00</span><span class="k" id="costLabel">est. saved</span></div>
    <div class="stat" title="100% minus retrieval calls per compression, bounded at zero. Repeat retrievals count separately."><span class="v" id="retrievalAvoidance">N/A</span><span class="k">retrieval avoidance</span></div>
  </div>

  <div class="bar"><div class="kept" id="barKept"></div><div class="saved" id="barSaved"></div></div>
  <div class="legend">
    <span><i class="dot forwarded"></i>forwarded to the model</span>
    <span><i class="dot removed"></i>compressed away</span>
  </div>

  <section class="modelTrackingPanel" aria-labelledby="modelTrackingTitle">
    <div class="modelTrackingHead">
      <h2 id="modelTrackingTitle">Model tracking</h2>
      <div class="modelTrackingActions">
        <span class="statusPill inactive" id="modelTrackingStatus" role="status">Not connected</span>
        <button class="button" type="button" id="connectModelTracking" title="Connect local model tracking">${renderIcon(Plug)}<span id="connectModelTrackingLabel">Connect</span></button>
        <button class="button" type="button" id="disconnectModelTracking" title="Disconnect local model tracking" hidden>${renderIcon(Unplug)}Disconnect</button>
      </div>
    </div>
    <div class="hint" id="modelTrackingDetail" role="status"></div>
    <div class="cliTracking" id="cliTrackingSetup" hidden>
      <p class="cliTrackingLead" id="cliTrackingLead"></p>
      <ol class="cliTrackingSteps">
        <li>
          <span id="cliTrackingStep1Label">Record consent and start the local receiver:</span>
          <code class="cliTrackingCmd" id="cliTrackingEnableCmd">npm run install:copilot-plugin:tracking</code>
        </li>
        <li>
          Print the exporter variables and add them to the shell profile you start
          <code>copilot</code> from:
          <code class="cliTrackingCmd" id="cliTrackingEnvCmd">slipstream model-tracking env</code>
        </li>
        <li>Start a new <code>copilot</code> session — Copilot reads this configuration at startup, so sessions already running stay untracked.</li>
      </ol>
      <p class="hint cliTrackingNote">The exporter variables include a local credential, so they are printed in your terminal and never shown here.</p>
    </div>
    <div class="modelPricingWarning" id="modelPricingWarning" role="status" hidden><span class="modelPricingIcon" id="modelPricingWarningIcon">${renderIcon(TriangleAlert)}</span><span class="modelPricingIcon" id="modelPricingInfoIcon" hidden>${renderIcon(Info)}</span><span id="modelPricingWarningText"></span></div>
    <dl class="modelPricing" aria-label="Automatic model pricing">
      <div><dt>Last detected model</dt><dd id="lastDetectedModel">Not detected</dd></div>
      <div><dt>Cached input rate</dt><dd id="detectedInputRate" title="Estimated value at public API input rates, not a Copilot bill.">Unavailable</dd></div>
      <div><dt>Model source</dt><dd id="detectedModelSource">Not detected</dd></div>
      <div><dt>Last call input</dt><dd id="modelInputTokens">N/A</dd></div>
      <div><dt>Last call output</dt><dd id="modelOutputTokens">N/A</dd></div>
      <div><dt>Cached input tokens</dt><dd id="modelCachedInputTokens">N/A</dd></div>
    </dl>
    <div class="hint" id="pricingStatus" role="status"></div>
  </section>

  <div class="dashboardTabs" role="tablist" aria-label="Dashboard sections">
    <button class="dashboardTab active" type="button" role="tab" aria-selected="true" data-panel-target="overview">Overview</button>
    <button class="dashboardTab" type="button" role="tab" aria-selected="false" data-panel-target="models">Models</button>
    <button class="dashboardTab" type="button" role="tab" aria-selected="false" data-panel-target="cost-policy">Cost policy</button>
    <button class="dashboardTab" type="button" role="tab" aria-selected="false" data-panel-target="evidence">Evidence</button>
    <button class="dashboardTab" type="button" role="tab" aria-selected="false" data-panel-target="storage">Storage</button>
    <button class="dashboardTab" type="button" role="tab" aria-selected="false" data-panel-target="activity">Activity</button>
    <button class="dashboardTab" type="button" role="tab" aria-selected="false" data-panel-target="history">History</button>
  </div>

  <section class="dashboardPanel" data-panel="overview">
  <h2>Traffic</h2>
  <div class="proofGrid" id="trafficStatus"></div>

  <h2>Workspace attribution</h2>
  <div class="hint" id="workspaceAttributionWindow"></div>
  <table><thead><tr>
    <th>Workspace</th><th class="num" title="Compressed tool calls">Calls</th><th class="num" title="Tokens received before compression">Tokens in</th><th class="num" title="Tokens forwarded to the model after compression">Tokens out</th><th class="num" title="Tokens removed from context (in - out)">Saved</th><th class="num" title="Share of input tokens saved (saved / in)">% saved</th><th>Last activity</th>
  </tr></thead><tbody id="workspaceAttribution"></tbody></table>
  <div class="empty" id="workspaceAttributionEmpty">Workspace attribution appears once Slipstream tools run from a workspace root.</div>

  <h2>Token flow</h2>
  <div class="hint" id="tokenFlowWindow"></div>
  <div class="proofGrid" id="tokenFlow"></div>
  </section>

  <section class="dashboardPanel" data-panel="cost-policy" hidden>
  <section class="policySettings" id="policySettings" aria-labelledby="policySettingsTitle">
    <h2 id="policySettingsTitle">Workspace policy</h2>
    <div class="hint">Automatic controls: @slipstream only. Native Copilot stays advisory. Local allowances are not billing caps.</div>
    <form id="policyForm" novalidate>
      <fieldset class="policyFields" id="policyFields" disabled>
        <div class="policyGrid">
          <label class="policyField policyWide" for="policyMode">Mode
            <select id="policyMode"><option value="off">Off</option><option value="recommend-only">Recommend only</option><option value="automatic-owned-request">Automatic (@slipstream)</option></select>
          </label>
          <label class="policyField" for="policyBudget">Task budget
            <input id="policyBudget" type="number" min="0" max="9007199254740991" step="1" placeholder="Not configured">
          </label>
          <label class="policyField" for="policyUnit">Budget unit
            <select id="policyUnit" title="Reference USD uses public API prices, not Copilot subscription charges."><option value="tokens">Tokens</option><option value="reference-usd">Reference USD</option></select>
          </label>
          <label class="policyField" for="policyModelSelection">Model choice
            <select id="policyModelSelection" title="Keep picker model retains the user selection. Policy chooses permits routing to compatible authorized models with verified task evidence."><option value="pinned">Keep picker model</option><option value="policy">Policy chooses</option></select>
          </label>
          <label class="policyField" for="policyOutputAllowance">Output allowance (tokens)
            <input id="policyOutputAllowance" type="number" min="1" max="32768" step="1" value="2048" title="Reserved per call and checked during streaming. Not a provider-enforced output limit.">
          </label>
          <label class="policyField" for="policyBalancedPressure">Balanced pressure (%)
            <input id="policyBalancedPressure" type="number" min="0" max="100" step="any" value="50" title="Budget or context pressure at which balanced compression is requested.">
          </label>
          <label class="policyField" for="policyAggressivePressure">Aggressive pressure (%)
            <input id="policyAggressivePressure" type="number" min="0" max="100" step="any" value="80" title="Must exceed balanced pressure. Only permitted compression profiles can be used.">
          </label>
        </div>
        <details class="policyAdvanced" id="policyAdvanced">
          <summary>Permitted models and profiles</summary>
          <div class="policyGroup" role="group" aria-labelledby="policyModelsTitle">
            <div class="policyModelHeading">
              <div class="policyGroupTitle" id="policyModelsTitle">Permitted models</div>
              <span class="hint" id="policyModelsCount">0 selected</span>
            </div>
            <div class="policyModelToolbar">
              <label class="policyField" for="policyModelSearch">Find models
                <input id="policyModelSearch" type="search" placeholder="Name, vendor or model ID" autocomplete="off" spellcheck="false">
              </label>
              <button class="iconButton" type="button" id="refreshPolicyModels" title="Refresh available models" aria-label="Refresh available models">${renderIcon(RefreshCw)}</button>
            </div>
            <div class="policyModelList" id="policyModels" aria-busy="false"></div>
            <div class="hint" id="policyModelsEmpty" hidden></div>
            <div class="hint" id="policyModelsStatus" role="status"></div>
          </div>
          <div class="policyGroup" role="group" aria-labelledby="policyProfilesTitle">
            <div class="policyGroupTitle" id="policyProfilesTitle">Permitted compression profiles</div>
            <div class="policyProfiles" id="policyProfiles"></div>
          </div>
        </details>
      </fieldset>
      <div class="policyActions">
        <button class="button" type="submit" id="applyPolicy" title="Apply to subsequent tasks in this workspace" disabled>${renderIcon(Check)}Apply</button>
        <button class="iconButton" type="button" id="reloadPolicy" title="Reload saved policy" aria-label="Reload saved policy" disabled>${renderIcon(RotateCcw)}</button>
      </div>
      <div class="hint policyStatus" id="policyStatus" role="status"></div>
    </form>
  </section>
  <section class="costPolicy" aria-labelledby="costPolicyTitle">
    <h2 id="costPolicyTitle">Cost policy</h2>
    <div class="hint" id="costPolicyMode" role="status">Unavailable</div>
    <div class="hint" id="costPolicyScope"></div>
    <div class="hint" id="costPolicyCoverage"></div>
    <div class="comparisonScroll costPolicyScroll" role="region" aria-label="Cost policy capabilities" tabindex="0">
      <table><thead><tr><th>Action</th><th>Automatic capability</th><th>Policy decision</th></tr></thead><tbody id="costPolicyDecisions"></tbody></table>
    </div>
  </section>
  <section class="modelRecommendations" aria-labelledby="recommendationTitle">
    <h2 id="recommendationTitle">Model recommendations</h2>
    <div class="hint" id="recommendationBasis">Advisory | Saved policy | Public API estimates, not Copilot billing</div>
    <form id="recommendationForm">
      <fieldset class="policyFields" id="recommendationFields" disabled>
        <div class="policyGrid">
          <label class="policyField" for="recommendationCategory">Task category
            <select id="recommendationCategory" required><option value="">Not specified</option><option value="code">Code changes</option><option value="triage">Log triage</option><option value="summarize">Summarization</option></select>
          </label>
          <label class="policyField" for="recommendationBaseline">Baseline model
            <select id="recommendationBaseline" required><option value="">Not specified</option></select>
          </label>
          <label class="policyField" for="recommendationInput">Estimated input tokens
            <input id="recommendationInput" type="number" min="0" max="9007199254740991" step="1" placeholder="Not estimated" required>
          </label>
          <label class="policyField" for="recommendationOutput">Estimated output tokens
            <input id="recommendationOutput" type="number" min="1" max="32768" step="1" value="2048" required>
          </label>
        </div>
        <div class="recommendationActions">
          <label class="policyProfile"><input id="recommendationPinned" type="checkbox">Hold baseline</label>
          <button class="iconButton" type="submit" id="compareModels" title="Compare permitted models" aria-label="Compare permitted models" aria-describedby="recommendationStatus">${renderIcon(RefreshCw)}</button>
        </div>
      </fieldset>
    </form>
    <div id="recommendationStatus" role="status">Waiting for saved policy.</div>
    <div id="recommendationSelection"></div>
    <div class="hint" id="recommendationTiming"></div>
    <div class="comparisonScroll recommendationScroll" id="recommendationTable" role="region" aria-label="Model recommendation candidates" tabindex="0" hidden>
      <table><thead><tr><th>Model / vendor</th><th>Availability</th><th class="num">Input capacity</th><th>Tool support</th>
        <th title="Verified owned tasks in the same workspace and category: latest 20 verified tasks within 30 days. Native checks are not model-qualification evidence.">Quality evidence</th>
        <th class="num" title="One-call estimate using cached input/output reference rates and input headroom; not reported usage or subscription billing.">Reference estimate</th><th>Eligibility</th>
      </tr></thead><tbody id="recommendationCandidates"></tbody></table>
    </div>
  </section>
  <section class="taskUsage" aria-labelledby="taskUsageTitle">
    <h2 id="taskUsageTitle">Owned tasks</h2>
    <div class="hint" id="taskUsageNote"></div>
    <div class="hint" id="taskOutcomeNote" role="status" title="Latest recorded outcome per task across all owned tasks. User reports and unverified outcomes are excluded from verified-pass counts."></div>
    <div class="comparisonScroll taskUsageScroll" role="region" aria-label="Owned task accounting" tabindex="0">
      <table><thead><tr>
        <th>Task</th><th>Outcome</th><th class="num">Calls</th><th class="num">Reported tokens</th>
        <th class="num" title="Local payload estimate, separate from reported usage. Input-only counts are partial and exclude unreported output and provider overhead.">Payload estimate</th>
        <th class="num" title="Cache-aware public API reference prices recorded at each call, not Copilot subscription charges.">Reference cost</th>
        <th class="num">Budget</th><th class="num" title="Unreconciled provisional allowance, not measured spend or a spending guarantee.">Provisional</th><th class="num">Reported balance</th><th>Automatic policy</th>
      </tr></thead><tbody id="taskUsage"></tbody></table>
    </div>
    <div class="empty" id="taskUsageEmpty">No owned tasks recorded.</div>
  </section>
  </section>

  <section class="dashboardPanel" data-panel="models" hidden>
  <section class="receiverHealth" aria-labelledby="receiverHealthTitle">
    <h2 id="receiverHealthTitle">Receiver health</h2>
    <div class="hint" id="receiverHealthStatus" role="status">Receiver health is unavailable.</div>
    <dl class="receiverHealthMetrics" id="receiverHealthMetrics" aria-label="Receiver health since window reload" hidden>
      <div><dt>Last observation</dt><dd title="Local acceptance time, not the model call's completion time."><span id="receiverLastAccepted">Not received</span><span id="receiverLastAcceptedAge"></span></dd></div>
      <div><dt>Authenticated exports</dt><dd id="receiverExports" title="Authenticated trace, metric, and log export requests since window reload. Health checks are excluded.">0</dd></div>
      <div><dt>Accepted observations</dt><dd id="receiverAccepted" title="Model observations accepted by this window since reload; retried spans are excluded.">0</dd></div>
      <div><dt>Rejected requests</dt><dd id="receiverRejected" title="Rejected requests by fixed reason; request contents and credentials are not retained.">0</dd></div>
    </dl>
    <div class="hint" id="receiverRejections" hidden></div>
  </section>
  <section class="catalogHealth" aria-labelledby="catalogTitle">
    <div class="catalogHead">
      <h2 id="catalogTitle">Price catalog</h2>
      <button class="iconButton" type="button" id="refreshCatalog" title="Refresh price catalog" aria-label="Refresh price catalog" aria-describedby="catalogRefreshStatus" disabled>${renderIcon(RefreshCw)}</button>
    </div>
    <dl class="catalogMetrics">
      <div><dt>Source</dt><dd id="catalogSource">Models.dev</dd></div>
      <div><dt>Model rates</dt><dd id="catalogModelCount">0</dd></div>
      <div><dt>Cache status</dt><dd id="catalogFreshness">Unknown</dd></div>
      <div><dt>Cache age</dt><dd id="catalogAge">Not cached</dd></div>
    </dl>
    <div class="hint" id="catalogRefreshStatus" role="status"></div>
  </section>
  <section class="contextGrowth" aria-labelledby="contextGrowthTitle">
    <h2 id="contextGrowthTitle">Context growth versus savings</h2>
    <div class="hint" id="contextWindow"></div>
    <div class="hint" id="contextCoverage" role="status"></div>
    <canvas id="contextGrowthChart" width="900" height="360" role="img" aria-label="Observed model input, cache share, and independent savings intervals" aria-describedby="contextWindow contextCoverage" hidden></canvas>
    <div class="empty" id="contextGrowthEmpty">No recorded model or tool activity.</div>
    <details class="dashboardDetails" id="contextCallsDetails" hidden>
      <summary>Model call samples</summary>
      <div class="comparisonScroll contextCallsScroll" role="region" aria-label="Context model calls" tabindex="0">
        <table><thead><tr><th>Completed</th><th>Model / provider</th><th>Scope</th><th class="num">Input</th><th class="num">Cached input</th><th class="num">Cache share</th></tr></thead><tbody id="contextObservations"></tbody></table>
      </div>
      <div class="empty" id="contextObservationsEmpty">No model observations in this window.</div>
    </details>
    <details class="dashboardDetails" id="contextSavingsDetails" hidden>
      <summary>Savings intervals</summary>
      <div class="comparisonScroll" role="region" aria-label="Independent savings intervals" tabindex="0">
        <table><thead><tr><th>Interval</th><th class="num">Tool outputs</th><th class="num" title="Input minus output tokens before retrieval; expansion can be negative.">Saved</th><th class="num">Retrieved</th><th class="num" title="Saved tokens minus retrieved tokens across all producers; no model-call attribution.">Net saved</th></tr></thead><tbody id="contextSavings"></tbody></table>
      </div>
    </details>
  </section>
  <section aria-labelledby="modelUsageTitle">
    <h2 id="modelUsageTitle">Per-model usage</h2>
    <div class="hint" id="modelUsageNote"></div>
    <div class="comparisonScroll modelUsageScroll" role="region" aria-label="Lifetime per-model usage" tabindex="0">
      <table><thead><tr>
        <th>Model / provider</th><th class="num" title="All recorded model observations, including chat and background calls.">Calls</th><th class="num">Input</th><th class="num">Output</th><th class="num" title="Reported cached-input tokens; these are part of input, not additional tokens.">Cached input</th><th>First seen</th><th>Last seen</th><th class="num" title="Current cached input rate; historical prices and savings are unchanged.">Catalog input rate</th>
      </tr></thead><tbody id="modelUsage"></tbody></table>
    </div>
    <div class="empty" id="modelUsageEmpty">No model observations recorded.</div>
  </section>
  <h2>Observed model calls</h2>
  <div class="hint" id="modelObservationsNote"></div>
  <div class="comparisonScroll modelObservationsScroll" role="region" aria-label="Observed model calls" aria-describedby="modelObservationsNote" tabindex="0">
    <table><thead><tr>
      <th>Time</th><th>Model</th><th title="Which Copilot surface made the call">Source</th><th title="Conversation turns update the detected model; background housekeeping calls never do">Scope</th><th class="num">Input</th><th class="num">Output</th><th class="num" title="Cache-read tokens are part of total input, not additional tokens.">Cached input</th><th title="Input components priced with the rates recorded for this call.">Input cost breakdown</th><th class="num" title="Uncached input, cache reads, and cache writes; excludes output. Incomplete data shows only the known subtotal.">Cache-aware input</th><th class="num" title="Default comparison: all reported input at the recorded standard uncached rate. This is not an additional charge.">Standard uncached</th><th class="num" title="Standard input rate recorded when this observation arrived.">Input rate</th>
    </tr></thead><tbody id="modelObservations"></tbody></table>
  </div>
  <div class="empty" id="modelObservationsEmpty">Observed calls appear once model tracking is connected and a Copilot call completes.</div>
  </section>

  <section class="dashboardPanel" data-panel="evidence" hidden>
  <details class="dashboardDetails" open>
  <summary><h2>Waste removed</h2></summary>
  <table><thead><tr>
    <th>What was avoided</th><th class="num">Times</th><th class="num">Saved</th>
  </tr></thead><tbody id="wasteSignals"></tbody></table>
  <div class="empty" id="wasteSignalsEmpty">Waste signals appear once Slipstream compresses tool output.</div>
  </details>

  <details class="dashboardDetails" open>
  <summary><h2>Outcome reasons</h2></summary>

  <table><thead><tr>
    <th>Reason</th><th class="num">Calls</th><th class="num">In</th><th class="num">Out</th><th class="num">Saved</th>
  </tr></thead><tbody id="outcomeReasons"></tbody></table>
  <div class="empty" id="outcomeReasonsEmpty">Outcome reasons appear once Slipstream tools run.</div>
  </details>

  <details class="dashboardDetails" open>
  <summary><h2>Strategy timing</h2></summary>
  <table><thead><tr>
    <th>Strategy</th><th>Variants</th><th class="num">Calls</th><th class="num">Avg</th><th class="num">Min</th><th class="num">Max</th><th class="num">P95</th><th class="num">Total</th>
  </tr></thead><tbody id="timingBreakdown"></tbody></table>
  <div class="empty" id="timingBreakdownEmpty">Timing appears once Slipstream records new tool-output events.</div>
  </details>

  <details class="dashboardDetails" open>
  <summary><h2>By strategy</h2></summary>
  <table><thead><tr>
    <th>Strategy</th><th>Variants</th><th class="num" title="Compressed tool calls">Calls</th><th class="num" title="Tokens received before compression">Tokens in</th>
    <th class="num" title="Tokens forwarded to the model after compression">Tokens out</th><th class="num" title="Tokens removed from context (in - out)">Saved</th><th class="num" title="Share of input tokens saved (saved / in)">% saved</th>
  </tr></thead><tbody id="strategies"></tbody></table>
  <div class="empty" id="strategiesEmpty">Compression strategies will appear here once tools run.</div>
  </details>
  </section>

  <section class="dashboardPanel" data-panel="storage" hidden>
  <details class="dashboardDetails" open>
  <summary><h2>Retrieval audit</h2></summary>
  <div class="auditCallout" id="retrievalAuditCallout">No omitted markers yet.</div>
  <table><thead><tr>
    <th>Output</th><th>Strategy</th><th class="num">Omitted</th><th class="num">Retrieved</th><th>Status</th>
  </tr></thead><tbody id="retrievalAudit"></tbody></table>
  <div class="empty" id="retrievalAuditEmpty">Retrieval audit appears once compressed outputs contain expandable markers.</div>
  </details>

  <details class="dashboardDetails" open>
  <summary><h2>Retrieval lifecycle</h2></summary>
  <div class="proofGrid" id="retrievalLifecycle"></div>
  </details>

  <details class="dashboardDetails" open>
  <summary><h2>Reuse health</h2></summary>
  <div class="proofGrid" id="reuseHealth"></div>
  </details>
  </section>

  <section class="dashboardPanel" data-panel="activity" hidden>
  <details class="dashboardDetails">
  <summary><h2>Session timeline</h2></summary>
  <ol class="timeline" id="timeline"></ol>
  <div class="empty" id="timelineEmpty">Run Slipstream tools to see the session timeline here.</div>
  </details>

  <details class="dashboardDetails">
  <summary><h2>By tool</h2></summary>
  <table><thead><tr>
    <th>Tool</th><th class="num" title="Compressed tool calls">Calls</th><th class="num" title="Tokens received before compression">Tokens in</th>
    <th class="num" title="Tokens forwarded to the model after compression">Tokens out</th><th class="num" title="Tokens removed from context (in - out)">Saved</th><th class="num" title="Share of input tokens saved (saved / in)">% saved</th>
  </tr></thead><tbody id="tools"></tbody></table>
  </details>

  <h2>Outputs</h2>
  <div class="outputTabs" id="outputTabs" role="tablist" aria-label="Output sessions"></div>
  <div class="outputMeta" id="outputMeta"></div>
  <table><thead><tr>
    <th>What</th><th>Strategy</th><th class="num">Lines</th><th class="num">Tokens</th>
  </tr></thead><tbody id="events"></tbody></table>
  <div class="empty" id="eventsEmpty">Run a build or test through Slipstream to see activity here.</div>
  <p class="hint" id="eventsHint" hidden>Select a row to see exactly what was removed.</p>

  <div id="detail" hidden>
    <h2>What was removed</h2>
    <div class="detailHead">
      <span class="name" id="dName"></span>
      <span class="tag" id="dStrategy"></span>
    </div>
    <div class="payloadActions">
      <button class="button" type="button" id="copyModelPayload">Copy model payload</button>
      <a class="button" id="modelPayloadLink" target="_blank" rel="noreferrer">Open exact payload</a>
      <span class="payloadMeta" id="modelPayloadMeta"></span>
    </div>
    <div class="modeSwitch" role="group" aria-label="Detail view mode">
      <button type="button" class="active" id="sideBySideMode">Side by side</button>
      <button type="button" id="diffMode">Diff mode</button>
    </div>
    <div class="panes" id="sideBySideView">
      <div class="pane">
        <div class="paneHead"><span>Before &mdash; raw tool output</span><span class="count" id="dBeforeCount"></span></div>
        <div class="paneBody" id="dBefore"></div>
      </div>
      <div class="pane">
        <div class="paneHead"><span>After &mdash; what the model received</span><span class="count" id="dAfterCount"></span></div>
        <div class="paneBody" id="dAfter"></div>
      </div>
    </div>
    <div class="diffView" id="diffView" hidden>
      <div class="diffSummary" id="diffSummary"></div>
      <div id="diffBody"></div>
    </div>
    <p class="hint">Shaded blocks on the left were removed. Click one to expand it &mdash; that is the same content the model gets back from <code>retrieve_artifact</code> whenever it needs it.</p>
  </div>
  </section>

  <section class="dashboardPanel" data-panel="history" hidden>
  <h2>Lifetime</h2>
  <div class="proofGrid" id="lifetimeTotals"></div>

  <h2>Compare</h2>
  <div class="payloadActions">
    <button class="button" type="button" id="saveBaseline">Save current as baseline</button>
    <span class="payloadMeta" id="baselineMeta"></span>
  </div>
  <div class="payloadMeta" id="benchmarkMeta"></div>
  <div class="comparisonScroll">
  <table><thead><tr>
    <th>Metric</th><th class="num">Saved baseline</th><th class="num">Live totals</th><th class="num">Change vs baseline</th><th class="num">Synthetic benchmark</th>
  </tr></thead><tbody id="comparison"></tbody></table>
  </div>
  <div class="empty" id="comparisonEmpty">Save a baseline to compare a later run against it.</div>

  <h2>Cost attribution</h2>
  <table><thead><tr>
    <th>Bucket</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Estimated</th>
  </tr></thead><tbody id="costAttribution"></tbody></table>
  <div class="hint" id="costAttributionNote"></div>

  <h2>Daily savings</h2>
  <table><thead><tr>
    <th>Date</th><th class="num" title="Compressed tool calls">Calls</th><th class="num" title="Tokens received before compression">Tokens in</th><th class="num" title="Tokens forwarded to the model after compression">Tokens out</th><th class="num" title="Tokens removed from context (in - out)">Saved</th><th class="num" title="Share of input tokens saved (saved / in)">% saved</th>
  </tr></thead><tbody id="history"></tbody></table>
  <div class="empty" id="historyEmpty">Daily savings appear once Slipstream records tool output.</div>
  </section>

<script nonce="${nonce}">
(function () {
  // Two hosts, one page: a VS Code webview talks over postMessage, a browser uses SSE.
  const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = (id) => document.getElementById(id);
  const num = (n) => Number(n || 0).toLocaleString();
  const ms = (n) => Math.max(0, Number(n || 0)).toFixed(1) + ' ms';
  const bytes = (n) => {
    const value = Math.max(0, Number(n || 0));
    if (value < 1024) return num(value) + ' B';
    const kib = value / 1024;
    if (kib < 1024) return kib.toFixed(1) + ' KiB';
    return (kib / 1024).toFixed(1) + ' MiB';
  };
  let selected = null;
  let signature = '';
  let configSignature = '';
  let currentModelPayload = '';
  let currentDetail = null;
  let selectedOutputGroup = 'global';
  let selectedDashboardPanel = 'overview';
  let lastConnectionAt = 0;
  let inactiveTimer = null;
  let managedModelTracking = false;
  let catalogStatus = {};
  let catalogRefreshPending = false;
  let catalogRefreshError = '';
  let contextGrowthData = null;
  let contextHitAreas = [];
  const themeStorageKey = 'slipstream.dashboard.theme';

  function storedTheme() {
    try {
      return localStorage.getItem(themeStorageKey) || 'system';
    } catch {
      return 'system';
    }
  }

  function applyTheme(theme) {
    const value = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    document.documentElement.dataset.theme = value;
    const select = $('themeMode');
    if (select) select.value = value;
    try {
      localStorage.setItem(themeStorageKey, value);
    } catch {
      /* localStorage may be disabled in some webview contexts */
    }
    drawContextChart();
  }

  function api(path, params) {
    const query = new URLSearchParams(params || {});
    query.set('t', token);
    return fetch('api/' + path + '?' + query.toString(), { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null));
  }

  function postApi(path, body) {
    const query = new URLSearchParams();
    query.set('t', token);
    return fetch('api/' + path + '?' + query.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    }).then((response) => (response.ok ? response.json() : null));
  }

  function requestSummary() {
    if (vscodeApi) {
      setConnectionState('connected', 'Connected: VS Code');
      vscodeApi.postMessage({ type: 'ready' });
    } else {
      api('summary')
        .then((data) => {
          if (data) {
            setConnectionState('connected', 'Connected');
            applySummary(data);
          }
        })
        .catch(() => setConnectionState('error', 'Error'));
    }
  }

  function requestDetail(ts, eventId) {
    if (vscodeApi) vscodeApi.postMessage({ type: 'inspect', ts: ts, eventId: eventId });
    else {
      const query = { ts: String(ts) };
      if (typeof eventId === 'string') query.eventId = eventId;
      api('detail', query).then((data) => { if (data) renderDetail(data); }).catch(() => {});
    }
  }

  function updateConfig(patch) {
    $('configMessage').textContent = 'Saving local dashboard config...';
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'config', patch: patch });
      return;
    }
    postApi('config', patch)
      .then((data) => {
        if (data) {
          $('configMessage').textContent = 'Saved local dashboard config.';
          applySummary(data);
        } else {
          $('configMessage').textContent = 'Config update failed.';
        }
      })
      .catch(() => { $('configMessage').textContent = 'Config update failed.'; });
  }

  let policyView = null;
  let policyDraftRevision = '';
  let policyDraftLoaded = false;
  let policyDirty = false;
  let policySaving = false;
  let policyMessage = '';
  let policySelectedModels = [];
  let policyModelChoices = [];
  let policyModelHostAvailable = false;
  let policyModelsLoaded = false;
  let policyModelsBusy = false;
  let policyModelsMessage = '';
  let policyModelsRequestId = 0;
  let policyModelsTimer = null;

  function policyModelKey(model) {
    return JSON.stringify([model.vendor, model.id]);
  }

  function syncPolicyModelControls() {
    $('policyModelsCount').textContent = policySelectedModels.length + ' selected';
    $('refreshPolicyModels').disabled = !policyModelHostAvailable || policyModelsBusy;
    $('policyModels').setAttribute('aria-busy', String(policyModelsBusy));
    for (const input of $('policyModels').querySelectorAll('input')) input.disabled = !input.checked && policySelectedModels.length >= 64;
    $('policyModelsEmpty').hidden = $('policyModels').children.length > 0 || policyModelsBusy || !policyModelsLoaded;
    $('policyModelsEmpty').textContent = $('policyModelSearch').value.trim() ? 'No models match your search.' : 'No models available from VS Code.';
    $('policyModelsStatus').textContent = !policyModelHostAvailable ? 'Model discovery requires an available, trusted VS Code host.'
      : policyModelsBusy ? 'Loading models...' : policyModelsMessage;
  }

  function renderPolicyModels() {
    const choices = new Map(policyModelChoices.map((model) => [policyModelKey(model), { ...model, available: true }]));
    for (const model of [...(policyView ? policyView.value.allowedModels : []), ...policySelectedModels]) {
      if (!choices.has(policyModelKey(model))) choices.set(policyModelKey(model), { ...model, name: model.id, available: false });
    }
    const selected = new Set(policySelectedModels.map(policyModelKey));
    const search = $('policyModelSearch').value.trim().toLowerCase();
    $('policyModels').textContent = '';
    const ordered = [...choices].sort(([leftKey, left], [rightKey, right]) => Number(selected.has(rightKey)) - Number(selected.has(leftKey)) ||
      left.vendor.localeCompare(right.vendor) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    for (const [key, model] of ordered) {
      if (!(model.name + ' ' + model.vendor + ' ' + model.id).toLowerCase().includes(search)) continue;
      const row = document.createElement('label');
      row.className = 'policyModelOption';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selected.has(key);
      input.setAttribute('aria-label', model.name + ' (' + model.vendor + '/' + model.id + ')');
      input.addEventListener('change', () => {
        if (!policyView || !policyView.editable || policySaving) return;
        if (input.checked && policySelectedModels.length < 64) policySelectedModels.push({ vendor: model.vendor, id: model.id });
        else {
          input.checked = false;
          policySelectedModels = policySelectedModels.filter((candidate) => policyModelKey(candidate) !== key);
        }
        markPolicyDirty();
      });
      const text = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'policyModelName';
      name.textContent = model.name;
      const detail = document.createElement('span');
      detail.className = 'policyModelDetail';
      detail.textContent = model.vendor + ' / ' + model.id;
      text.append(name, detail);
      const availability = !model.available ? policyModelsLoaded ? 'Not currently available' : 'Availability not checked'
        : !model.authorized ? 'Access not granted' : '';
      if (availability) {
        const status = document.createElement('span');
        status.className = 'policyModelDetail';
        status.textContent = availability;
        text.appendChild(status);
      }
      row.append(input, text);
      $('policyModels').appendChild(row);
    }
    syncPolicyModelControls();
  }

  function finishPolicyModels(data) {
    if (data.requestId !== policyModelsRequestId || !policyModelsBusy || !policyModelHostAvailable) return;
    clearTimeout(policyModelsTimer);
    policyModelsBusy = false;
    policyModelsLoaded = !data.error && Array.isArray(data.models) && data.models.every((model) => model &&
      typeof model.vendor === 'string' && typeof model.id === 'string' && typeof model.name === 'string' && typeof model.authorized === 'boolean');
    policyModelChoices = policyModelsLoaded ? data.models : [];
    policyModelsMessage = policyModelsLoaded ? '' : 'Model list unavailable. Refresh to retry.';
    renderPolicyModels();
  }

  function requestPolicyModels() {
    if (!policyModelHostAvailable || policyModelsBusy) return;
    const requestId = ++policyModelsRequestId;
    policyModelsBusy = true;
    policyModelsMessage = '';
    syncPolicyModelControls();
    policyModelsTimer = setTimeout(() => finishPolicyModels({ requestId, error: true }), 15000);
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'policyModels', requestId });
      return;
    }
    api('policy-models').then((data) => finishPolicyModels({ ...data, requestId }))
      .catch(() => finishPolicyModels({ requestId, error: true }));
  }

  function readPolicyDraft() {
    const mode = $('policyMode').value;
    if (!['off', 'recommend-only', 'automatic-owned-request'].includes(mode)) throw new Error('Unknown policy mode.');
    const budgetUnit = $('policyUnit').value;
    const budget = $('policyBudget');
    if (budget.validity.badInput) throw new Error('Enter a valid task budget.');
    const taskBudget = budget.value.trim() === '' ? undefined : Number(budget.value);
    if (taskBudget !== undefined && (!Number.isFinite(taskBudget) || taskBudget < 0 || taskBudget > Number.MAX_SAFE_INTEGER)) throw new Error('Task budget must be between 0 and ' + Number.MAX_SAFE_INTEGER + '.');
    if (taskBudget !== undefined && budgetUnit === 'tokens' && !Number.isSafeInteger(taskBudget)) throw new Error('Token budgets must be whole numbers.');
    if (mode === 'automatic-owned-request' && taskBudget === undefined) throw new Error('Automatic requests require a task budget.');
    const modelSelection = $('policyModelSelection').value;
    if (modelSelection !== 'pinned' && modelSelection !== 'policy') throw new Error('Select a model choice.');
    const outputTokenAllowance = Number($('policyOutputAllowance').value);
    if ($('policyOutputAllowance').validity.badInput || !Number.isSafeInteger(outputTokenAllowance) || outputTokenAllowance < 1 || outputTokenAllowance > 32768) throw new Error('Output allowance must be a whole number from 1 to 32768.');
    const pressureInputs = [$('policyBalancedPressure'), $('policyAggressivePressure')];
    const [balanced, aggressive] = pressureInputs.map((input) => Number(input.value) / 100);
    if (pressureInputs.some((input) => input.validity.badInput || input.value.trim() === '') ||
      !Number.isFinite(balanced) || !Number.isFinite(aggressive) || balanced < 0 || aggressive > 1 || balanced >= aggressive) throw new Error('Pressure thresholds must satisfy 0% <= balanced < aggressive <= 100%.');
    const models = policySelectedModels.map((model) => ({ vendor: model.vendor, id: model.id }));
    const modelId = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,299}$/;
    if (models.some((model) => !modelId.test(model.vendor) || !modelId.test(model.id))) throw new Error('Each permitted model needs a valid vendor and model ID.');
    if (models.length > 64 || new Set(models.map((model) => JSON.stringify(model))).size !== models.length) throw new Error('Use up to 64 distinct permitted models.');
    if (mode === 'automatic-owned-request' && !models.length) throw new Error('Automatic requests require at least one permitted model.');
    const profiles = [...$('policyProfiles').querySelectorAll('input:checked')].map((input) => input.value);
    if (!profiles.length) throw new Error('Select at least one compression profile.');
    return {
      version: 1, mode: mode, allowedModels: models, allowedCompressionProfiles: profiles, budgetUnit: budgetUnit,
      ...(taskBudget === undefined ? {} : { taskBudget: taskBudget }),
      ...(modelSelection === 'pinned' && policyView && policyView.value.modelSelection === undefined ? {} : { modelSelection: modelSelection }),
      ...(outputTokenAllowance === 2048 && policyView && policyView.value.outputTokenAllowance === undefined ? {} : { outputTokenAllowance: outputTokenAllowance }),
      ...(balanced === 0.5 && aggressive === 0.8 && policyView && policyView.value.pressureThresholds === undefined ? {} : { pressureThresholds: { balanced: balanced, aggressive: aggressive } }),
      // The editor has no control for the feedback loop, so an edit here must
      // never silently drop or re-enable a configured compressionFeedback block.
      ...(policyView && policyView.value.compressionFeedback ? { compressionFeedback: policyView.value.compressionFeedback } : {}),
    };
  }

  function syncPolicyEditor() {
    const editable = !!(policyView && policyView.editable);
    const stale = !!(policyView && policyDirty && policyDraftRevision !== policyView.revision);
    $('policyBudget').step = $('policyUnit').value === 'tokens' ? '1' : 'any';
    let invalid = '';
    if (policyView) {
      try { readPolicyDraft(); } catch (error) { invalid = error.message; }
    }
    $('policyFields').disabled = !editable || policySaving;
    $('applyPolicy').disabled = !editable || policySaving || !policyDirty || stale || !!invalid;
    $('reloadPolicy').disabled = !policyView || policySaving;
    syncPolicyModelControls();
    $('policyStatus').textContent = !editable ? 'Read-only: an open, trusted VS Code workspace is required.'
      : policySaving ? 'Saving workspace policy...'
      : stale ? 'Policy changed elsewhere. Reload saved values before applying.'
      : invalid || policyMessage || (policyDirty ? 'Unsaved changes.' : 'Saved workspace policy.');
  }

  function loadPolicyDraft(message) {
    if (!policyView) return;
    const policy = policyView.value;
    $('policyMode').value = policy.mode;
    $('policyUnit').value = policy.budgetUnit;
    $('policyBudget').value = policy.taskBudget == null ? '' : String(policy.taskBudget);
    $('policyModelSelection').value = policy.modelSelection || 'pinned';
    $('policyOutputAllowance').value = String(policy.outputTokenAllowance == null ? 2048 : policy.outputTokenAllowance);
    $('policyBalancedPressure').value = String((policy.pressureThresholds ? policy.pressureThresholds.balanced : 0.5) * 100);
    $('policyAggressivePressure').value = String((policy.pressureThresholds ? policy.pressureThresholds.aggressive : 0.8) * 100);
    policySelectedModels = (policy.allowedModels || []).map((model) => ({ vendor: model.vendor, id: model.id }));
    renderPolicyModels();
    $('policyProfiles').textContent = '';
    for (const profile of policyView.profiles) {
      const label = document.createElement('label');
      label.className = 'policyProfile';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = profile;
      input.checked = policy.allowedCompressionProfiles.includes(profile);
      label.appendChild(input);
      label.appendChild(document.createTextNode(profile.charAt(0).toUpperCase() + profile.slice(1)));
      $('policyProfiles').appendChild(label);
    }
    policyDraftRevision = policyView.revision;
    policyDraftLoaded = true;
    policyDirty = false;
    policyMessage = message || '';
    syncPolicyEditor();
  }

  function renderPolicyEditor(data) {
    const settings = data.costPolicySettings;
    policyView = settings && data.costPolicy ? { ...settings, revision: data.costPolicy.policyRevision, profiles: data.profileOptions || [] } : null;
    const available = !!(policyView && policyView.editable && data.canListPolicyModels === true);
    const hostChanged = available !== policyModelHostAvailable;
    policyModelHostAvailable = available;
    if (hostChanged) {
      policyModelsRequestId++;
      clearTimeout(policyModelsTimer);
      policyModelsBusy = false;
      policyModelsLoaded = false;
      policyModelsMessage = '';
      policyModelChoices = [];
    }
    if (policyView && !policySaving && (!policyDraftLoaded || (!policyDirty && policyDraftRevision !== policyView.revision))) loadPolicyDraft();
    else syncPolicyEditor();
    if (hostChanged) renderPolicyModels();
    if ($('policyAdvanced').open && !policyModelsLoaded && !policyModelsMessage) requestPolicyModels();
  }

  function markPolicyDirty(event) {
    if (event && (event.target.id === 'policyModelSearch' || event.target.closest('.policyModelOption'))) return;
    policyDirty = true;
    policyMessage = '';
    syncPolicyEditor();
  }

  function finishPolicySave(error) {
    policySaving = false;
    if (error) {
      policyMessage = error;
      syncPolicyEditor();
      requestSummary();
    } else loadPolicyDraft('Applied to workspace.');
  }

  function applyPolicy(event) {
    event.preventDefault();
    syncPolicyEditor();
    if ($('applyPolicy').disabled) return;
    const change = { policy: readPolicyDraft(), expectedRevision: policyDraftRevision };
    policySaving = true;
    policyMessage = '';
    syncPolicyEditor();
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'costPolicy', ...change });
      return;
    }
    const failure = 'Policy could not be applied. Check workspace settings and reload the saved policy.';
    postApi('cost-policy', change).then((data) => {
      if (data) { applySummary(data); finishPolicySave(); }
      else finishPolicySave(failure);
    }).catch(() => finishPolicySave(failure));
  }

  let recommendationView = null;
  let recommendationSource = '';
  let recommendationRows = '';
  let recommendationResult = null;
  let recommendationMessage = '';
  let recommendationBusy = false;
  let recommendationRequestId = 0;
  let recommendationTimer;
  const recommendationReasons = {
    'policy-off': 'Cost Policy is off.', 'no-permitted-models': 'No permitted models in the saved policy.',
    'task-details-required': 'Task details required.', 'model-required': 'Baseline model required.',
    'no-compatible-model': 'No eligible baseline: permission, availability, context capacity, or tool support is missing.',
    'unknown-input': 'Input estimate unavailable.', 'unknown-price': 'Baseline reference pricing is incomplete or stale.',
    'insufficient-evidence': 'Insufficient verified task evidence. Baseline retained.', 'pinned': 'Baseline held. No alternative recommended.',
    'current-retained': 'Baseline retained. No qualified candidate has a lower comparable reference estimate.',
    'lower-reference-cost': 'Lower reference-cost candidate with qualifying task evidence.',
  };
  const recommendationGaps = {
    'unavailable': 'Unavailable or not authorized', 'unknown-input': 'Input estimate missing', 'context-limit': 'Insufficient or unknown context capacity',
    'tool-unsupported': 'Tool support not established', 'unknown-price': 'Incomplete or stale price', 'incomparable-price': 'Different price snapshot',
    'insufficient-evidence': 'Insufficient verified evidence', 'verified-failure': 'Verified failure in evidence window',
  };

  function syncModelRecommendation() {
    const view = recommendationView;
    const models = view ? view.policy.allowedModels || [] : [];
    const enabled = !!(view && view.available && view.policy.mode !== 'off' && models.length);
    $('recommendationFields').disabled = !enabled;
    $('compareModels').disabled = !enabled || recommendationBusy;
    $('recommendationForm').setAttribute('aria-busy', String(recommendationBusy));
    $('recommendationStatus').textContent = !view ? 'Waiting for saved policy.' : view.policy.mode === 'off' ? recommendationReasons['policy-off']
      : !view.available ? 'Model recommendations are unavailable on this host.' : !models.length ? recommendationReasons['no-permitted-models']
      : recommendationBusy ? 'Comparing permitted models...' : recommendationMessage
      || (recommendationResult ? recommendationReasons[recommendationResult.reason] || 'No recommendation available.' : 'Task details required.');
    const selected = recommendationResult && recommendationResult.selectedModel;
    $('recommendationSelection').textContent = selected ? (recommendationResult.state === 'recommend' ? 'Suggested model: ' : 'Retained baseline: ') + selected.vendor + '/' + selected.id : '';
    const timing = recommendationResult && recommendationResult.timings;
    $('recommendationTiming').textContent = timing ? 'Local rules: ' + timing.evaluationMs.toFixed(2) + ' ms | Host discovery: ' + timing.discoveryMs.toFixed(2) + ' ms' : '';
    const rows = recommendationResult ? recommendationResult.candidates : models.map((model) => ({ model: model }));
    const key = JSON.stringify(rows);
    $('recommendationTable').hidden = rows.length === 0;
    if (key === recommendationRows) return;
    recommendationRows = key;
    $('recommendationCandidates').textContent = '';
    for (const candidate of rows) {
      const row = document.createElement('tr');
      const evaluated = typeof candidate.available === 'boolean';
      const gaps = (candidate.gaps || []).map((gap) => recommendationGaps[gap] || 'Not established');
      const values = [candidate.model.vendor + '/' + candidate.model.id,
        !evaluated ? 'Not evaluated' : candidate.available ? 'Available and authorized' : 'Unavailable or not authorized',
        candidate.maxInputTokens == null ? 'Unknown' : num(candidate.maxInputTokens),
        candidate.toolCalling == null ? 'Unknown' : candidate.toolCalling ? 'Supported' : 'Not established',
        candidate.verifiedPasses == null ? 'Not established' : num(candidate.verifiedPasses) + ' pass / ' + num(candidate.verifiedFailures) + ' fail',
        candidate.referenceUsd == null ? 'Unavailable' : '$' + candidate.referenceUsd.toFixed(6),
        !evaluated ? 'Not evaluated' : gaps.length ? gaps.join('; ') : 'Qualified'];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      $('recommendationCandidates').appendChild(row);
    }
  }

  function invalidateModelRecommendation(message) {
    const hadResult = recommendationBusy || !!recommendationResult;
    recommendationRequestId++;
    clearTimeout(recommendationTimer);
    recommendationBusy = false;
    recommendationResult = null;
    recommendationMessage = hadResult ? message : '';
    syncModelRecommendation();
  }

  function renderModelRecommendation(data) {
    const previous = recommendationView;
    const settings = data.costPolicySettings;
    recommendationView = settings && data.costPolicy ? { policy: settings.value, revision: data.costPolicy.policyRevision, available: data.canRecommendModels === true } : null;
    const prices = data.pricingStatus || {};
    const usage = data.taskUsage || {};
    const evidence = (usage.tasks || []).map((task) => [task.taskId, task.state, task.category, task.model, task.outcome]);
    const source = JSON.stringify([recommendationView, (data.pricingSnapshot || {}).revision, prices.fetchedAt, prices.freshness, usage.outcomes, evidence]);
    if (recommendationView && (!previous || previous.revision !== recommendationView.revision)) {
      const selected = $('recommendationBaseline').value;
      $('recommendationBaseline').textContent = '';
      const empty = document.createElement('option');
      empty.value = ''; empty.textContent = 'Not specified';
      $('recommendationBaseline').appendChild(empty);
      for (const model of recommendationView.policy.allowedModels || []) {
        const option = document.createElement('option');
        option.value = JSON.stringify({ vendor: model.vendor, id: model.id });
        option.textContent = model.vendor + '/' + model.id;
        $('recommendationBaseline').appendChild(option);
      }
      $('recommendationBaseline').value = selected;
      if (!previous) $('recommendationOutput').value = String(recommendationView.policy.outputTokenAllowance || 2048);
    }
    if (source !== recommendationSource) {
      recommendationSource = source;
      invalidateModelRecommendation('Result expired: saved policy, prices, evidence, or host access changed.');
    } else syncModelRecommendation();
  }

  function finishModelRecommendation(data) {
    if (data.requestId !== recommendationRequestId || !recommendationBusy) return;
    clearTimeout(recommendationTimer);
    recommendationBusy = false;
    recommendationResult = null;
    recommendationMessage = data.error || '';
    if (!data.error && recommendationView && data.policyRevision === recommendationView.revision && data.result) recommendationResult = data.result;
    else if (!recommendationMessage) recommendationMessage = 'Recommendation unavailable. Saved policy may have changed.';
    syncModelRecommendation();
  }

  function compareModels(event) {
    event.preventDefault();
    if ($('compareModels').disabled || !$('recommendationForm').reportValidity()) return;
    const requestId = ++recommendationRequestId;
    const query = { expectedRevision: recommendationView.revision, request: {
      category: $('recommendationCategory').value, requestedModel: JSON.parse($('recommendationBaseline').value),
      inputTokens: Number($('recommendationInput').value), outputTokens: Number($('recommendationOutput').value), pinned: $('recommendationPinned').checked,
    } };
    recommendationBusy = true;
    recommendationMessage = '';
    recommendationResult = null;
    syncModelRecommendation();
    recommendationTimer = setTimeout(() => finishModelRecommendation({ requestId: requestId, error: 'Model discovery timed out. No recommendation available.' }), 15000);
    if (vscodeApi) vscodeApi.postMessage({ type: 'modelRecommendation', requestId: requestId, ...query });
    else postApi('model-recommendation', query).then((data) => finishModelRecommendation({ requestId: requestId, ...(data || { error: 'Recommendation unavailable. Check workspace access and the saved policy.' }) }))
      .catch(() => finishModelRecommendation({ requestId: requestId, error: 'Recommendation request failed.' }));
  }

  function renderPricing(data) {
    const snapshot = data.pricingSnapshot || {};
    const status = data.pricingStatus || {};
    const model = snapshot.detectedModel;
    $('lastDetectedModel').textContent = model ? model.name + ' (' + model.vendor + '/' + model.id + ')' : 'Not detected';
    $('detectedInputRate').textContent = snapshot.inputUsdPerMillion == null ? 'Unavailable' : '$' + snapshot.inputUsdPerMillion + ' / 1M input';
    $('pricingStatus').textContent = (status.loading ? 'Refreshing rates' : snapshot.reason || 'Cached') +
      (data.modelDetectedAt ? ' | Detected ' + new Date(data.modelDetectedAt).toLocaleString() : '') +
      (snapshot.fetchedAt ? ' | Rates ' + new Date(snapshot.fetchedAt).toLocaleString() : '') +
      (snapshot.stale ? ' | Stale' : '') + (status.error ? ' | ' + status.error : '');
    $('pricingStatus').title = snapshot.source || '';
    const observation = data.modelObservation;
    $('detectedModelSource').textContent = observation ? 'Copilot telemetry' : model ? 'Slipstream chat' : 'Not detected';
    $('modelInputTokens').textContent = observation && observation.inputTokens != null ? num(observation.inputTokens) : 'N/A';
    $('modelOutputTokens').textContent = observation && observation.outputTokens != null ? num(observation.outputTokens) : 'N/A';
    $('modelCachedInputTokens').textContent = observation && observation.cacheReadInputTokens != null ? num(observation.cacheReadInputTokens) : 'N/A';
  }

  function updateCatalogAge() {
    const element = $('catalogAge');
    const fetchedAt = catalogStatus.fetchedAt;
    if (fetchedAt == null) {
      element.textContent = 'Not cached';
      element.title = '';
      return;
    }
    const age = Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));
    element.textContent = age < 60 ? age + 's' : age < 3600 ? Math.floor(age / 60) + 'm'
      : age < 86400 ? Math.floor(age / 3600) + 'h' : Math.floor(age / 86400) + 'd';
    element.title = new Date(fetchedAt).toLocaleString();
  }

  function renderCatalog(status) {
    catalogStatus = status || {};
    const loading = catalogRefreshPending || !!catalogStatus.loading;
    const error = catalogRefreshError || catalogStatus.error;
    const labels = { missing: 'Not cached', fresh: 'Fresh', stale: 'Stale', expired: 'Expired' };
    $('catalogFreshness').textContent = labels[catalogStatus.freshness] || 'Unknown';
    $('catalogModelCount').textContent = num(catalogStatus.modelCount);
    $('catalogSource').title = catalogStatus.source || '';
    $('refreshCatalog').disabled = loading;
    $('refreshCatalog').setAttribute('aria-busy', String(loading));
    $('catalogRefreshStatus').textContent = loading ? 'Refreshing catalog...'
      : error ? 'Refresh failed: ' + error : catalogStatus.fetchedAt == null ? 'No successful fetch yet.'
        : 'Last successful fetch: ' + new Date(catalogStatus.fetchedAt).toLocaleString();
    updateCatalogAge();
  }

  async function refreshCatalog() {
    if (catalogRefreshPending || catalogStatus.loading) return;
    catalogRefreshPending = true;
    catalogRefreshError = '';
    renderCatalog(catalogStatus);
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'refreshCatalog' });
      return;
    }
    try {
      const data = await postApi('pricing/refresh', {});
      if (!data || data.type !== 'summary') throw new Error('Refresh failed');
      applySummary(data);
    } catch {
      catalogRefreshError = 'Catalog refresh could not be completed.';
    } finally {
      catalogRefreshPending = false;
      renderCatalog(catalogStatus);
    }
  }

  function renderCliTrackingSetup(cli, cliOn) {
    const panel = $('cliTrackingSetup');
    panel.hidden = !cli;
    if (!cli) return;
    $('cliTrackingLead').textContent = cliOn
      ? 'Tracking is on. If models still are not appearing, the exporter variables are usually the missing step:'
      : 'Copilot CLI usage is not recorded until you turn tracking on:';
    $('cliTrackingStep1Label').textContent = cliOn
      ? 'Consent is already recorded. To re-run or repair the install:'
      : 'Record consent and start the local receiver:';
  }

  let modelTrackingManagePending = false;
  let modelTrackingManageMessage = '';

  function renderModelTracking(status, pricing, cost, configuredRate, cli) {
    managedModelTracking = !!status;
    const labels = { disconnected: 'Not connected', connecting: 'Connecting', connected: 'Connected', blocked: 'Tracking paused', error: 'Connection error' };
    const cliOn = !status && !!cli && cli.consented;
    const cliOff = !status && !!cli && !cli.consented;
    $('modelTrackingStatus').textContent = status ? labels[status.state] || 'Not connected'
      : cliOn ? 'Enabled (CLI)' : cli ? 'Off' : 'Managed in VS Code';
    $('modelTrackingStatus').classList.toggle('connected', (!!status && status.state === 'connected') || cliOn);
    $('modelTrackingStatus').classList.toggle('error', !!status && (status.state === 'blocked' || status.state === 'error'));
    $('modelTrackingStatus').classList.toggle('inactive', cliOff || (!status && !cli) || (!!status && (status.state === 'disconnected' || status.state === 'connecting')));
    $('modelTrackingDetail').textContent = status ? status.detail
      : modelTrackingManageMessage ? modelTrackingManageMessage
      : cliOn ? 'Consent recorded. The local receiver listens on 127.0.0.1' + (cli.port ? ':' + cli.port : '') + ' and records model identity, timing, and token counts only.'
      : cliOff ? 'Nothing is being recorded. Copilot CLI usage stays invisible to this dashboard until you enable tracking.'
      : 'Connection status is available in the extension dashboard.';
    renderCliTrackingSetup(cli, cliOn);
    $('connectModelTrackingLabel').textContent = status ? 'Connect' : 'Connect to VS Code';
    $('connectModelTracking').hidden = !!(status && status.canDisconnect);
    $('connectModelTracking').disabled = modelTrackingManagePending || !!(status && !status.canConnect);
    $('disconnectModelTracking').hidden = !(status && status.canDisconnect);
    $('disconnectModelTracking').disabled = !!(status && status.state === 'connecting');
    const snapshot = pricing || {};
    const fallbackRate = configuredRate == null ? 3 : configuredRate;
    const fallback = 'Missing rates use the default $' + fallbackRate + ' / 1M tokens; recorded savings are retained. ';
    const usingFallback = !!(cost && cost.unpricedEvents > 0);
    let warning = '';
    if (!status) {
      if (!snapshot.detectedModel || snapshot.inputUsdPerMillion == null || usingFallback) {
        warning = fallback + (cli && !cli.consented ? 'Enable CLI model tracking to detect your model.'
          : cli ? 'If no model is detected, check the exporter variables below.'
          : 'Open model tracking in VS Code to connect.');
      }
    } else if (status.state !== 'connected') {
      warning = fallback + (status.canConnect ? 'Connect model tracking to detect your model.'
        : status.state === 'connecting' ? 'Model tracking is connecting.' : 'Resolve the tracking issue to reconnect.');
    } else if (!snapshot.detectedModel) {
      warning = 'No model detected yet. ' + fallback;
    } else if (snapshot.inputUsdPerMillion == null) {
      warning = 'No cached input rate is available for this model. ' + fallback;
    } else if (usingFallback) {
      warning = 'Est. saved includes $' + cost.fallbackUsd.toFixed(2) + ' estimated at the default $' + fallbackRate + ' / 1M tokens. Recorded savings are retained.';
    }
    const informational = !!status && status.state === 'connected';
    $('modelPricingWarning').classList.toggle('info', informational);
    $('modelPricingWarningIcon').hidden = informational;
    $('modelPricingInfoIcon').hidden = !informational;
    $('modelPricingWarning').hidden = !warning;
    if ($('modelPricingWarningText').textContent !== warning) $('modelPricingWarningText').textContent = warning;
  }

  function modelTrackingAction(action) {
    if (!managedModelTracking && !vscodeApi) {
      if (modelTrackingManagePending) return;
      modelTrackingManagePending = true;
      modelTrackingManageMessage = 'Connecting to the VS Code runtime...';
      $('modelTrackingDetail').textContent = modelTrackingManageMessage;
      $('connectModelTracking').disabled = true;
      postApi('model-tracking', { action: 'manage' }).catch(() => null).then((data) => {
        modelTrackingManagePending = false;
        if (data && data.dashboardUrl) {
          window.location.href = data.dashboardUrl;
          return;
        }
        modelTrackingManageMessage = 'The VS Code tracking runtime is unavailable. Check that the Slipstream dashboard server is enabled in VS Code.';
        $('modelTrackingDetail').textContent = modelTrackingManageMessage;
        $('connectModelTracking').disabled = false;
      });
      return;
    }
    $('connectModelTracking').disabled = true;
    $('disconnectModelTracking').disabled = true;
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'modelTracking', action: action });
      return;
    }
    postApi('model-tracking', { action: action }).then((data) => {
      if (data) applySummary(data);
      else { requestSummary(); $('modelTrackingDetail').textContent = 'Model tracking update failed.'; }
    }).catch(() => { requestSummary(); $('modelTrackingDetail').textContent = 'Model tracking update failed.'; });
  }

  function modelPayloadUrl(ts, eventId) {
    const query = new URLSearchParams({ ts: String(ts) });
    if (typeof eventId === 'string') query.set('eventId', eventId);
    query.set('t', token);
    return 'api/model-payload?' + query.toString();
  }

  function reportUrl(extension) {
    const query = new URLSearchParams();
    query.set('t', token);
    return 'api/report.' + extension + '?' + query.toString();
  }

  function eventStreamUrl() {
    const query = new URLSearchParams();
    query.set('t', token);
    return 'api/events?' + query.toString();
  }

  function setConnectionState(state, label) {
    const status = $('connectionStatus');
    status.classList.remove('connected', 'error', 'inactive');
    status.classList.add(state);
    status.textContent = label;
    if (state === 'connected') {
      lastConnectionAt = Date.now();
      armInactiveTimer();
    }
  }

  function armInactiveTimer() {
    if (inactiveTimer) clearTimeout(inactiveTimer);
    inactiveTimer = setTimeout(() => {
      if (Date.now() - lastConnectionAt >= 15000) {
        setConnectionState('inactive', 'Inactive');
      }
    }, 16000);
  }

  function cell(row, text, className) {
    const td = document.createElement('td');
    td.textContent = text;          // never innerHTML: tool output is untrusted
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  /**
   * Rebuilding the tables replaces their DOM nodes, which cancels an in-flight
   * click and resets scroll position. Only do it when something changed.
   */
  function applySummary(data) {
    renderPolicyEditor(data);
    renderModelRecommendation(data);
    renderModelTracking(data.modelTracking, data.pricingSnapshot, data.summary.cost, (data.config || {}).usdPerMillionTokens, data.cliModelTracking);
    renderReceiverHealth(data.modelTracking);
    renderCatalog(data.pricingStatus);
    const s = data.summary;
    const last = data.events && data.events.length ? data.events[data.events.length - 1].ts : 0;
    const c = data.config || {};
    const next = [
      data.enabled,
      data.modelDetectedAt,
      JSON.stringify(data.pricingSnapshot || {}),
      JSON.stringify(data.pricingStatus || {}),
      JSON.stringify(data.modelObservation || {}),
      JSON.stringify(data.modelUsage || []),
      JSON.stringify(data.contextGrowth || {}),
      JSON.stringify(data.costPolicy || {}),
      JSON.stringify(data.taskUsage || {}),
      (data.modelObservations || []).length,
      (data.modelObservations || []).length ? data.modelObservations[0].ts : 0,
      s.calls,
      s.tokensAfter,
      s.tokensBefore,
      last,
      c.profile,
      c.enabled,
      c.compressLogs,
      c.readLifecycle,
      c.crossTurnDedup,
      c.maxFileLines,
      c.usdPerMillionTokens,
      c.artifactIdleTtlMinutes,
      c.artifactMaxEntries,
      c.artifactMaxTotalMiB,
      JSON.stringify(data.tokenFlow || {}),
      JSON.stringify(data.traffic || {}),
      JSON.stringify(data.workspaceAttribution || []),
      JSON.stringify(data.lifetime || {}),
      JSON.stringify(data.history || []),
      JSON.stringify(data.wasteSignals || []),
      JSON.stringify(data.costAttribution || {}),
      JSON.stringify(data.comparison || {}),
      JSON.stringify(data.outcomeBreakdown || []),
      JSON.stringify(data.reuseHealth || {}),
      JSON.stringify(data.timingBreakdown || []),
      JSON.stringify((data.outputGroups || []).map((group) => [group.id, group.calls, group.tokensSaved])),
      selectedOutputGroup,
    ].join(':');
    if (next === signature) return;
    signature = next;
    renderSummary(data);
  }

  function renderSummary(data) {
    const s = data.summary;
    $('off').hidden = data.enabled;
    $('exportSettings').hidden = !!vscodeApi;
    const snapshot = $('shareSnapshotLink');
    snapshot.hidden = !!vscodeApi;
    snapshot.href = reportUrl('md');
    const json = $('shareJsonLink');
    json.hidden = !!vscodeApi;
    json.href = reportUrl('json');
    const csv = $('shareCsvLink');
    csv.hidden = !!vscodeApi;
    csv.href = reportUrl('csv');
    $('pct').textContent = (s.percentSaved || 0).toFixed(0) + '%';
    $('chats').textContent = num((data.lifetime && data.lifetime.chatsObserved) || 0);
    $('observedTools').textContent = num((data.lifetime && data.lifetime.observedToolCalls) || 0);
    $('saved').textContent = num(s.tokensSaved);
    $('before').textContent = num(s.tokensBefore);
    $('after').textContent = num(s.tokensAfter);
    const priceBreakdown = s.cost || {};
    const estimatedUsd = s.estimatedCostSavedUsd == null ? priceBreakdown.knownUsd || 0 : s.estimatedCostSavedUsd;
    $('cost').textContent = '$' + estimatedUsd.toFixed(2);
    $('costLabel').textContent = priceBreakdown.unpricedEvents > 0
      ? priceBreakdown.pricedEvents > 0 ? 'est. saved (mixed rates)' : 'est. saved @ $' + priceBreakdown.fallbackUsdPerMillion + '/1M'
      : 'est. saved';
    $('cost').title = 'Recorded-rate savings: $' + (priceBreakdown.knownUsd || 0).toFixed(2) +
      '; default-rate estimate: $' + (priceBreakdown.fallbackUsd || 0).toFixed(2);
    $('retrievalAvoidance').textContent = s.compressions > 0
      ? Math.max(0, 100 - (s.retrievalRate || 0)).toFixed(1) + '%'
      : 'N/A';

    const pct = Math.max(0, Math.min(100, s.percentSaved || 0));
    $('barKept').style.width = (100 - pct) + '%';
    $('barSaved').style.width = pct + '%';
    renderConfigStatus(data.config, data.profileOptions);
    renderPricing(data);
    const recentWindow = (data.lifetime && data.lifetime.recentWindow) || 40;
    const windowNote = 'Most recent ' + recentWindow + ' tool events across all producers, not lifetime totals.';
    $('workspaceAttributionWindow').textContent = windowNote;
    $('tokenFlowWindow').textContent = windowNote;
    renderTrafficStatus(data.traffic || {});
    renderCostPolicy(data.costPolicy);
    renderTaskUsage(data.taskUsage);
    renderModelUsage(data.modelUsage || []);
    renderContextGrowth(data.contextGrowth);
    renderModelObservations(data.modelObservations || []);
    renderWorkspaceAttribution(data.workspaceAttribution || []);
    renderLifetime(data.lifetime || {});
    renderHistory(data.history || []);
    renderWasteSignals(data.wasteSignals || []);
    renderCostAttribution(data.costAttribution || {});
    renderComparison(data.comparison || {});
    renderTokenFlow(data.tokenFlow || {});
    renderOutcomeBreakdown(data.outcomeBreakdown || []);
    renderTimingBreakdown(data.timingBreakdown || []);

    const tools = $('tools');
    tools.textContent = '';
    for (const t of s.byTool || []) {
      const row = document.createElement('tr');
      cell(row, t.tool);
      cell(row, num(t.calls), 'num');
      cell(row, num(t.tokensBefore), 'num');
      cell(row, num(t.tokensAfter), 'num');
      cell(row, num(t.tokensSaved), 'num');
      const p = t.tokensBefore > 0 ? (t.tokensSaved / t.tokensBefore) * 100 : 0;
      cell(row, p.toFixed(0) + '%', 'num');
      tools.appendChild(row);
    }

    renderRetrievalAudit(data.retrievalAudit);
    renderRetrievalLifecycle((data.retrievalAudit && data.retrievalAudit.lifecycle) || {});
    renderReuseHealth(data.reuseHealth || {});
    renderStrategyBreakdown(data.strategyBreakdown || []);
    renderTimeline(data.timeline || []);
    const groups = data.outputGroups || [{ id: 'global', label: 'Global outputs', calls: (data.events || []).length, tokensSaved: s.tokensSaved, events: data.events || [] }];
    renderOutputTabs(groups);
    const group = groups.find((item) => item.id === selectedOutputGroup) || groups[0] ||
      { id: 'global', label: 'Global outputs', calls: 0, tokensSaved: 0, events: [] };

    const events = $('events');
    events.textContent = '';
    const list = (group.events || []).slice().reverse();
    $('eventsEmpty').hidden = list.length > 0;
    $('eventsHint').hidden = list.length === 0;
    $('outputMeta').textContent = group.label + ': ' + num(group.calls) + ' output(s), ' + num(group.tokensSaved) + ' token(s) saved.';
    for (const e of list) {
      const row = document.createElement('tr');
      row.className = 'event';
      if ((e.eventId || e.ts) === selected) row.classList.add('active');
      row.addEventListener('click', () => {
        selected = e.eventId || e.ts;
        for (const other of events.children) other.classList.remove('active');
        row.classList.add('active');
        requestDetail(e.ts, e.eventId);
      });
      cell(row, e.label, 'label');
      const strategy = cell(row, '');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = e.strategy;
      strategy.appendChild(tag);
      cell(row, num(e.linesBefore) + ' \\u2192 ' + num(e.linesAfter), 'num');
      cell(row, num(e.tokensBefore) + ' \\u2192 ' + num(e.tokensAfter), 'num');
      events.appendChild(row);
    }
  }

  function renderOutputTabs(groups) {
    const tabs = $('outputTabs');
    tabs.textContent = '';
    if (!groups.some((group) => group.id === selectedOutputGroup)) {
      selectedOutputGroup = 'global';
    }
    for (const group of groups) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outputTab';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', group.id === selectedOutputGroup ? 'true' : 'false');
      button.classList.toggle('active', group.id === selectedOutputGroup);
      button.textContent = group.label + ' (' + num(group.calls) + ')';
      button.addEventListener('click', () => {
        selectedOutputGroup = group.id;
        signature = '';
        requestSummary();
      });
      tabs.appendChild(button);
    }
  }

  function selectDashboardPanel(id) {
    selectedDashboardPanel = id;
    for (const panel of document.querySelectorAll('[data-panel]')) {
      panel.hidden = panel.getAttribute('data-panel') !== id;
    }
    for (const tab of document.querySelectorAll('[data-panel-target]')) {
      const active = tab.getAttribute('data-panel-target') === id;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  function renderConfigStatus(config, profiles) {
    const next = JSON.stringify([config, profiles]);
    if (next === configSignature) return;
    configSignature = next;
    const status = $('configStatus');
    status.textContent = '';
    const profile = configShell('profile', 'Compression profile');
    const select = document.createElement('select');
    select.id = 'config-profile';
    select.setAttribute('aria-label', 'Compression profile');
    for (const name of profiles || []) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name.charAt(0).toUpperCase() + name.slice(1);
      select.appendChild(option);
    }
    select.value = config.profile || 'balanced';
    select.addEventListener('change', () => updateConfig({ profile: select.value }));
    profile.appendChild(select);
    status.appendChild(profile);
    status.appendChild(configCheckbox('enabled', 'Compression', config.enabled, 'Enabled'));
    status.appendChild(configCheckbox('compressLogs', 'Log compression', config.compressLogs, 'On'));
    status.appendChild(configCheckbox('readLifecycle', 'Read lifecycle', config.readLifecycle, 'On'));
    status.appendChild(configCheckbox('crossTurnDedup', 'Cross-turn dedup', config.crossTurnDedup, 'On'));
    status.appendChild(configNumber('maxFileLines', 'Max file read', config.maxFileLines, 'lines', 50, 20000, 1));
    status.appendChild(configNumber('usdPerMillionTokens', 'Fallback input rate', config.usdPerMillionTokens, 'USD / 1M tokens', 0, Number.MAX_VALUE, 'any'));
    status.appendChild(configNumber('artifactIdleTtlMinutes', 'Artifact idle TTL', config.artifactIdleTtlMinutes, 'min', 1, 1440, 1));
    status.appendChild(configNumber('artifactMaxEntries', 'Artifact entries cap', config.artifactMaxEntries, 'entries', 1, 100000, 1));
    status.appendChild(configNumber('artifactMaxTotalMiB', 'Artifact size cap', config.artifactMaxTotalMiB, 'MiB', 1, 10240, 1));
  }

  function configShell(key, label, extraClass) {
    const block = document.createElement('label');
    block.className = 'configItem' + (extraClass ? ' ' + extraClass : '');
    block.setAttribute('for', 'config-' + key);
    const name = document.createElement('span');
    name.className = 'k';
    name.textContent = label;
    block.appendChild(name);
    return block;
  }

  function configCheckbox(key, label, checked, suffix) {
    const block = configShell(key, label, 'checkbox');
    const value = document.createElement('span');
    value.className = 'v';
    const input = document.createElement('input');
    input.id = 'config-' + key;
    input.type = 'checkbox';
    input.checked = !!checked;
    const text = document.createElement('span');
    text.textContent = checked ? suffix : 'Off';
    input.addEventListener('change', () => updateConfig({ [key]: input.checked }));
    value.appendChild(input);
    value.appendChild(text);
    block.appendChild(value);
    return block;
  }

  function configNumber(key, label, current, suffix, min, max, step) {
    const block = configShell(key, label);
    const input = document.createElement('input');
    input.id = 'config-' + key;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Number(current || 0));
    input.setAttribute('aria-label', label + ' (' + suffix + ')');
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (!Number.isFinite(next)) {
        $('configMessage').textContent = label + ' must be a number.';
        return;
      }
      updateConfig({ [key]: next });
    });
    const value = document.createElement('span');
    value.className = 'v';
    value.textContent = num(current) + ' ' + suffix;
    block.appendChild(input);
    block.appendChild(value);
    return block;
  }

  let receiverLastAcceptedAt = null;

  function updateReceiverAge() {
    let age = '';
    if (receiverLastAcceptedAt != null) {
      const seconds = Math.max(0, Math.floor((Date.now() - receiverLastAcceptedAt) / 1000));
      age = seconds < 1 ? 'Just now' : seconds < 60 ? seconds + 's ago'
        : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago'
        : seconds < 86400 ? Math.floor(seconds / 3600) + 'h ago' : Math.floor(seconds / 86400) + 'd ago';
    }
    if ($('receiverLastAcceptedAge').textContent !== age) $('receiverLastAcceptedAge').textContent = age;
  }

  function renderReceiverHealth(status) {
    const shared = status && status.receiverHealthScope === 'shared';
    const health = !shared && status && status.receiverHealth;
    $('receiverHealthMetrics').hidden = !health;
    $('receiverRejections').hidden = !health;
    $('receiverHealthStatus').textContent = !health
      ? shared ? 'Receiver is hosted in another VS Code window. Local health is unavailable.'
        : status ? 'Receiver has not started in this window.' : 'Receiver health is unavailable in this dashboard.'
      : status.state !== 'connected' ? 'Receiver is not running. Counts are from this window since reload.'
        : !health.receivedExports ? 'No authenticated exports received since this window reloaded.'
          : !health.acceptedObservations ? 'Exports received; no model observations accepted since reload.'
            : 'Observations received since this window reloaded.';
    receiverLastAcceptedAt = health && health.lastAcceptedAt != null ? health.lastAcceptedAt : null;
    $('receiverLastAccepted').textContent = receiverLastAcceptedAt == null ? 'Not received' : new Date(receiverLastAcceptedAt).toLocaleString();
    $('receiverExports').textContent = health ? num(health.receivedExports) : 'Unavailable';
    $('receiverAccepted').textContent = health ? num(health.acceptedObservations) : 'Unavailable';
    const reasons = { authorization: 'Authentication', origin: 'Origin', host: 'Host', route: 'Route',
      protocol: 'Unsupported protocol', tooLarge: 'Body too large', malformed: 'Malformed JSON', processing: 'Processing failure' };
    let rejected = 0;
    const details = [];
    for (const reason of Object.keys(reasons)) {
      const count = health && health.rejectedExports[reason] || 0;
      rejected += count;
      if (count) details.push(reasons[reason] + ': ' + num(count));
    }
    $('receiverRejected').textContent = health ? num(rejected) : 'Unavailable';
    $('receiverRejections').textContent = health ? details.length ? details.join('; ') : 'No rejected requests since reload.' : '';
    updateReceiverAge();
  }

  setInterval(() => { updateReceiverAge(); updateCatalogAge(); }, 1000);

  function contextCacheShare(item) {
    if (item.cacheSharePercent != null) return item.cacheSharePercent.toFixed(1) + '%';
    if (item.inputTokens == null || item.cacheReadInputTokens == null) return 'Not reported';
    if (item.cacheReadInputTokens > item.inputTokens) return 'Inconsistent counts';
    return 'Not defined (zero input)';
  }

  function contextTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderCostPolicy(policy) {
    const body = $('costPolicyDecisions');
    body.textContent = '';
    if (!policy) {
      $('costPolicyMode').textContent = 'Unavailable';
      $('costPolicyScope').textContent = '';
      $('costPolicyCoverage').textContent = '';
      return;
    }
    const modes = { off: 'Off', 'recommend-only': 'Recommend only', 'automatic-owned-request': 'Automatic owned request' };
    const hosts = { 'native-copilot': 'Native Copilot', 'owned-chat': 'Slipstream chat', 'external-tools': 'External tools' };
    const actions = { 'select-model': 'Model selection', 'change-compression': 'Compression adaptation', 'enforce-budget': 'Call admission guardrails' };
    const capabilityKeys = { 'select-model': 'automaticModelSelection', 'change-compression': 'adaptiveCompression', 'enforce-budget': 'budgetEnforcement' };
    const statuses = { off: 'Off', advisory: 'Advisory', blocked: 'Blocked', automatic: 'Automatic' };
    const capabilities = policy.capabilities || {};
    $('costPolicyMode').textContent = 'Requested: ' + (modes[policy.requestedMode] || 'Unknown') + ' | Effective: ' + (modes[policy.effectiveMode] || 'Unknown');
    $('costPolicyScope').textContent = (hosts[policy.host] || 'Unknown host') + ' | ' + (policy.scope === 'task' ? 'Task' : 'Workspace') +
      ' | Model requests: ' + (capabilities.ownedModelRequests ? 'owned' : 'not owned');
    $('costPolicyCoverage').textContent = 'Policy v' + policy.policyVersion + ' | Budget unit: ' + (policy.budgetUnit === 'reference-usd' ? 'Reference USD' : 'Tokens') + ' | Usage: not measured';
    $('costPolicyCoverage').title = 'Policy revision: ' + policy.policyRevision;
    for (const decision of policy.decisions || []) {
      const row = document.createElement('tr');
      cell(row, actions[decision.action] || decision.action);
      cell(row, capabilities[capabilityKeys[decision.action]] ? 'Available' : capabilities.ownedModelRequests ? 'Unavailable' : 'Unsupported host');
      cell(row, (statuses[decision.status] || 'Unknown') + ': ' + decision.reason, 'policyReason');
      body.appendChild(row);
    }
  }

  function renderTaskUsage(data) {
    const tasks = data && data.tasks || [];
    const body = $('taskUsage');
    const expanded = new Set([...body.querySelectorAll('.taskEvidence[open]')].map((element) => element.closest('tr').dataset.taskId));
    body.textContent = '';
    $('taskUsageEmpty').hidden = tasks.length > 0;
    $('taskUsageNote').textContent = 'Owned requests only | ' + num(data && data.totalTasks || 0) + ' tasks' +
      (data && data.totalTasks > tasks.length ? ' | Latest ' + num(tasks.length) + ' shown' : '') +
      (tasks.some((task) => task.enforcement === 'local-allowance') ? ' | Local allowances, not billing caps' : ' | Not enforced');
    const outcomes = data && data.outcomes || {};
    const outcomeNames = { 'verified-pass': 'Verified pass', 'verified-fail': 'Verified fail', 'user-reported': 'User-reported', cancelled: 'Cancelled', unverified: 'Unverified' };
    $('taskOutcomeNote').textContent = Object.keys(outcomeNames).map((status) => outcomeNames[status] + ': ' + num(outcomes[status] || 0)).join(' | ');
    const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 });
    const dollars = (value) => value !== 0 && Math.abs(value) < 0.000001 ? '$' + value.toExponential(2) : currency.format(value);
    const amount = (value, unit) => value == null ? 'Unknown' : unit === 'reference-usd' ? dollars(value) : num(value) + ' tokens';
    const covered = (total, known, coverage, format) => total != null ? format(total) : coverage === 'partial' && known != null ? format(known) + ' known (partial)' : 'Unknown';
    const elapsed = (value) => value == null ? 'Unknown' : value < 1000 ? ms(value) : (value / 1000).toFixed(1) + ' s';
    const metric = (value) => value == null ? 'Unknown' : num(value);
    const detail = (parent, text) => {
      const label = document.createElement('span');
      label.className = 'modelUsageDetail';
      label.textContent = text;
      parent.appendChild(label);
    };
    const states = { running: 'Running', finished: 'Finished', failed: 'Failed', cancelled: 'Cancelled', paused: 'Paused' };
    const reasons = { pinned: 'Picker model retained', 'current-retained': 'Current model retained', 'lower-reference-cost': 'Lower reference cost',
      'insufficient-evidence': 'Insufficient comparison evidence', 'no-compatible-model': 'No compatible permitted model', 'unknown-input': 'Input count unavailable',
      'context-limit': 'Context allowance exceeded', 'unknown-price': 'Fresh prices unavailable', 'budget-limit': 'Task allowance exhausted',
      'budget-required': 'Task budget required', 'output-limit': 'Output allowance reached', 'policy-changed': 'Policy changed', 'recovery-failure': 'Recovery failed' };
    const budgets = { within: 'Within budget', exceeded: 'Exceeded', unknown: 'Unknown coverage', 'not-configured': 'Not configured' };
    for (const task of tasks) {
      const row = document.createElement('tr');
      row.dataset.taskId = task.taskId;
      const identity = cell(row, task.taskId.slice(0, 8));
      identity.title = task.taskId;
      detail(identity, new Date(task.startedAt).toLocaleString());
      detail(identity, states[task.state] || 'Unknown');
      if (task.resumes) detail(identity, 'Resumes: ' + num(task.resumes));
      if (task.category) detail(identity, 'Category: ' + task.category);
      detail(identity, 'Duration: ' + elapsed(task.durationMs));
      const outcome = task.outcome || { status: 'unverified', result: null, evidence: null, verificationAttempts: 0 };
      const outcomeCell = cell(row, '');
      const status = document.createElement('span');
      status.className = 'taskOutcomeStatus';
      status.textContent = outcomeNames[outcome.status] || 'Unverified';
      outcomeCell.appendChild(status);
      if (outcome.status === 'user-reported') detail(outcomeCell, outcome.result === 'pass' ? 'Reported successful' : 'Reported unsuccessful');
      if (outcome.evidence) {
        const evidence = document.createElement('details');
        evidence.className = 'taskEvidence';
        evidence.open = expanded.has(task.taskId);
        const heading = document.createElement('summary');
        heading.textContent = 'Evidence';
        evidence.appendChild(heading);
        const recorded = outcome.evidence.detail;
        if (recorded.source === 'command') {
          const checks = { test: 'Test check', build: 'Build check', custom: 'Command check' };
          detail(evidence, (checks[recorded.check] || 'Command check') + ' | ' + (recorded.exitCode == null ? recorded.execution === 'cancelled' ? 'Cancelled' : 'No exit result' : 'Exit ' + recorded.exitCode));
          detail(evidence, 'Check duration: ' + elapsed(recorded.durationMs));
          if (recorded.checkKey) {
            detail(evidence, 'Check: ' + recorded.checkKey.slice(0, 12));
            evidence.lastChild.title = recorded.checkKey;
          }
        } else detail(evidence, 'Source: user confirmation');
        detail(evidence, new Date(outcome.evidence.recordedAt).toLocaleString());
        detail(evidence, 'Verification attempts: ' + num(outcome.verificationAttempts));
        outcomeCell.appendChild(evidence);
      }
      const calls = cell(row, num(task.calls), 'num');
      detail(calls, num(task.reportedCalls) + '/' + num(task.calls) + ' complete reports');
      if (task.interruptedCalls) detail(calls, 'Interrupted: ' + num(task.interruptedCalls));
      detail(calls, 'Retries: ' + metric(task.modelRetries));
      detail(calls, 'Retrievals: ' + metric(task.retrievals));
      detail(calls, 'Recovery failures: ' + metric(task.recoveryFailures));
      cell(row, covered(task.totalTokens, task.knownTokens, task.usageCoverage, num), 'num');
      cell(row, task.estimatedTokens == null ? 'Unknown' : num(task.estimatedTokens) + (task.estimateCoverage === 'complete' ? '' : ' (partial)'), 'num');
      cell(row, covered(task.referenceUsd, task.knownReferenceUsd, task.costCoverage, dollars), 'num');
      cell(row, task.limit == null ? 'Not set' : amount(task.limit, task.unit), 'num');
      cell(row, amount(task.reserved, task.unit), 'num');
      const balance = cell(row, task.limit == null ? 'Not configured' : amount(task.remaining, task.unit), 'num');
      const guarded = task.enforcement === 'local-allowance';
      detail(balance, (budgets[task.budgetStatus] || 'Unknown') + (guarded ? ' | Reported usage only' : ' | Not enforced'));
      const automation = cell(row, guarded ? 'Local guardrails' : 'Advisory', 'policyReason');
      if (guarded) detail(automation, 'Allowance left: ' + amount(task.allowanceRemaining, task.unit));
      if (task.policyDecision) {
        const decision = task.policyDecision;
        detail(automation, (decision.state === 'paused' ? 'Paused: ' : '') + (reasons[decision.reason] || 'Unknown decision'));
        if (decision.selectedModel) detail(automation, 'Model: ' + decision.selectedModel.vendor + '/' + decision.selectedModel.id);
        if (decision.profile) detail(automation, 'Profile: ' + decision.profile);
      }
      body.appendChild(row);
    }
  }

  function renderContextGrowth(data) {
    contextGrowthData = data || null;
    const available = !!data && data.startAt != null;
    $('contextGrowthChart').hidden = !available;
    $('contextGrowthEmpty').hidden = available;
    $('contextCallsDetails').hidden = !available;
    $('contextSavingsDetails').hidden = !available;
    $('contextWindow').textContent = available ? 'All producers | ' + new Date(data.startAt).toLocaleString() +
      ' - ' + new Date(data.endAt).toLocaleString() + ' | Latest ' + data.windowMinutes + '-minute window | Time alignment only' : '';
    const observations = data && data.observations || [];
    const inputCount = observations.filter((item) => item.inputTokens != null).length;
    const cacheCount = observations.filter((item) => item.cacheSharePercent != null).length;
    $('contextCoverage').textContent = available ? num(data.observationCount) + ' observed calls | ' +
      (data.observationCount > observations.length ? 'Latest ' + num(observations.length) + ' shown | ' : '') +
      'Input reported: ' + num(inputCount) + '/' + num(observations.length) + ' | Cache share available: ' + num(cacheCount) + '/' + num(observations.length) : '';
    $('contextObservationsEmpty').hidden = observations.length > 0;
    const calls = $('contextObservations');
    calls.textContent = '';
    for (const item of observations) {
      const row = document.createElement('tr');
      cell(row, new Date(item.ts).toLocaleTimeString()).title = new Date(item.ts).toISOString();
      cell(row, item.model + ' (' + item.vendor + ')', 'label');
      cell(row, item.scope === 'chat' ? 'Chat-associated' : 'Background');
      cell(row, item.inputTokens == null ? 'Not reported' : num(item.inputTokens), 'num');
      cell(row, item.cacheReadInputTokens == null ? 'Not reported' : num(item.cacheReadInputTokens), 'num');
      cell(row, contextCacheShare(item), 'num');
      calls.appendChild(row);
    }
    const savings = $('contextSavings');
    savings.textContent = '';
    for (const item of data && data.savings || []) {
      const row = document.createElement('tr');
      cell(row, contextTime(item.startAt) + ' - ' + contextTime(item.endAt)).title =
        new Date(item.startAt).toISOString() + ' <= time < ' + new Date(item.endAt).toISOString();
      cell(row, num(item.toolOutputs), 'num');
      cell(row, num(item.tokensSaved), 'num');
      cell(row, num(item.retrievalTokens), 'num');
      cell(row, num(item.netTokensSaved), 'num');
      savings.appendChild(row);
    }
    drawContextChart();
  }

  function drawContextChart() {
    const canvas = $('contextGrowthChart');
    const data = contextGrowthData;
    if (!data || data.startAt == null || canvas.hidden || !canvas.clientWidth) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    contextHitAreas = [];
    const styles = getComputedStyle(canvas);
    const color = (name) => styles.getPropertyValue(name).trim();
    const foreground = color('--ss-fg');
    const muted = color('--ss-muted');
    const border = color('--ss-border');
    const inputColor = color('--ss-blue');
    const savedColor = color('--ss-green');
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    context.font = '11px ' + styles.fontFamily;
    const left = 8;
    const right = width - 8;
    const timePosition = (timestamp) => left + (timestamp - data.startAt) / (data.endAt - data.startAt) * (right - left);
    const inputMaximum = Math.max(1, ...data.observations.map((item) => item.inputTokens || 0));
    const netMinimum = Math.min(0, ...data.savings.map((item) => item.netTokensSaved));
    const netMaximum = Math.max(0, ...data.savings.map((item) => item.netTokensSaved));
    const lanes = [
      { label: 'Input tokens / call', minimum: 0, maximum: inputMaximum, color: inputColor, field: 'inputTokens' },
      { label: 'Cache share / call', minimum: 0, maximum: 100, color: muted, field: 'cacheSharePercent' },
      { label: 'Net saved / ' + data.bucketMinutes + ' min', minimum: netMinimum, maximum: netMaximum || (netMinimum < 0 ? 0 : 1), color: savedColor },
    ];
    const tickCount = width < 500 ? 3 : 6;
    for (const [index, lane] of lanes.entries()) {
      const top = index * 110 + 28;
      const bottom = top + 64;
      const valuePosition = (value) => bottom - (value - lane.minimum) / (lane.maximum - lane.minimum) * (bottom - top);
      context.textAlign = 'left';
      context.fillStyle = foreground;
      context.fillText(lane.label, left, top - 12);
      context.textAlign = 'right';
      context.fillStyle = muted;
      context.fillText(compact.format(lane.minimum) + ' - ' + compact.format(lane.maximum) + (index === 1 ? '%' : ''), right, top - 12);
      context.strokeStyle = border;
      context.lineWidth = 1;
      for (let tick = 0; tick <= tickCount; tick++) {
        const position = left + tick / tickCount * (right - left);
        context.beginPath();
        context.moveTo(position, top);
        context.lineTo(position, bottom);
        context.stroke();
      }
      const baseline = valuePosition(0);
      context.beginPath();
      context.moveTo(left, baseline);
      context.lineTo(right, baseline);
      context.stroke();
      context.fillStyle = lane.color;
      if (lane.field) {
        let points = 0;
        for (const item of data.observations) {
          const value = item[lane.field];
          if (value == null) continue;
          const horizontal = timePosition(item.ts);
          const vertical = valuePosition(value);
          context.beginPath();
          context.arc(horizontal, vertical, 3, 0, Math.PI * 2);
          context.fill();
          points++;
          contextHitAreas.push({ left: horizontal - 7, top: vertical - 7, width: 14, height: 14,
            label: new Date(item.ts).toLocaleString() + ' | ' + item.model + ' (' + item.vendor + ') | ' +
              (lane.field === 'inputTokens' ? num(value) + ' input tokens' : contextCacheShare(item) + ' cached input') });
        }
        if (!points) {
          context.textAlign = 'center';
          context.fillStyle = muted;
          context.fillText(!data.observations.length ? 'No model observations' : index === 0 ? 'Input not reported' : 'Cache share unavailable', width / 2, top + 36);
        }
      } else {
        for (const item of data.savings) {
          const horizontal = timePosition(item.startAt) + 2;
          const barWidth = Math.max(1, timePosition(item.endAt) - horizontal - 2);
          const vertical = valuePosition(item.netTokensSaved);
          const barHeight = Math.max(1, Math.abs(baseline - vertical));
          if (item.toolOutputs) context.fillRect(horizontal, Math.min(vertical, baseline), barWidth, barHeight);
          contextHitAreas.push({ left: horizontal, top, width: barWidth, height: bottom - top,
            label: contextTime(item.startAt) + ' - ' + contextTime(item.endAt) + ' | ' + num(item.tokensSaved) + ' saved - ' +
              num(item.retrievalTokens) + ' retrieved = ' + num(item.netTokensSaved) + ' net tokens | All producers, no call attribution' });
        }
      }
    }
    context.fillStyle = muted;
    for (let tick = 0; tick <= tickCount; tick++) {
      context.textAlign = tick === 0 ? 'left' : tick === tickCount ? 'right' : 'center';
      context.fillText(contextTime(data.startAt + tick / tickCount * (data.endAt - data.startAt)), left + tick / tickCount * (right - left), height - 10);
    }
  }

  new ResizeObserver(drawContextChart).observe($('contextGrowthChart'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawContextChart);
  $('contextGrowthChart').addEventListener('pointermove', (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const horizontal = event.clientX - bounds.left;
    const vertical = event.clientY - bounds.top;
    const hit = contextHitAreas.find((area) => horizontal >= area.left && horizontal <= area.left + area.width && vertical >= area.top && vertical <= area.top + area.height);
    event.currentTarget.title = hit ? hit.label : '';
  });
  $('contextGrowthChart').addEventListener('pointerleave', (event) => { event.currentTarget.title = ''; });

  function renderModelUsage(items) {
    const body = $('modelUsage');
    body.textContent = '';
    $('modelUsageEmpty').hidden = items.length > 0;
    const calls = items.reduce((total, item) => total + item.calls, 0);
    $('modelUsageNote').textContent = 'Lifetime | ' + num(calls) + ' observed calls | ' + num(items.length) + ' models';
    const usageCell = (row, tokens, reported, total) => {
      const element = cell(row, tokens == null ? 'Not reported' : num(tokens), 'num');
      if (tokens != null && reported < total) {
        const coverage = document.createElement('span');
        coverage.className = 'modelUsageDetail';
        coverage.textContent = 'Partial (' + num(reported) + '/' + num(total) + ' calls)';
        element.appendChild(coverage);
      }
      return element;
    };
    for (const item of items) {
      const row = document.createElement('tr');
      const identity = cell(row, item.model, 'label');
      const vendor = document.createElement('span');
      vendor.className = 'modelUsageDetail';
      vendor.textContent = item.vendor;
      identity.appendChild(vendor);
      cell(row, num(item.calls), 'num');
      usageCell(row, item.inputTokens, item.inputReportedCalls, item.calls);
      usageCell(row, item.outputTokens, item.outputReportedCalls, item.calls);
      usageCell(row, item.cacheReadInputTokens, item.cacheReadReportedCalls, item.calls);
      for (const timestamp of [item.firstSeenAt, item.lastSeenAt]) {
        const date = new Date(timestamp);
        cell(row, date.toLocaleString()).title = date.toISOString();
      }
      cell(row, item.inputUsdPerMillion == null ? item.inputRateReason || 'No cached rate' : '$' + item.inputUsdPerMillion + ' / 1M', 'num modelRate');
      body.appendChild(row);
    }
  }

  function renderModelObservations(items) {
    const body = $('modelObservations');
    body.textContent = '';
    $('modelObservationsEmpty').hidden = items.length > 0;
    const chat = items.filter((item) => item.scope === 'chat').length;
    const cli = items.filter((item) => item.source === 'cli').length;
    $('modelObservationsNote').textContent = items.length
      ? 'Last ' + items.length + ' observed call(s): ' + chat + ' conversation turn(s), ' +
        (items.length - chat) + ' background. Only conversation turns update the detected model. ' +
        'By source: ' + (items.length - cli) + ' VS Code, ' + cli + ' CLI. ' +
        'Costs: input-only public API reference estimates at recorded rates, not Copilot bills or tool-output savings.'
      : '';
    const referenceUsd = (value) => {
      if (value == null || !Number.isFinite(value) || value < 0) return 'Unavailable';
      if (value > 0 && value < 0.000001) return '<$0.000001';
      return '$' + value.toFixed(6);
    };
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, new Date(item.ts).toLocaleTimeString());
      cell(row, item.model + ' (' + item.vendor + ')', 'label');
      cell(row, item.source === 'cli' ? 'Copilot CLI' : 'VS Code');
      cell(row, item.scope === 'chat' ? 'Conversation' : item.nested ? 'Background (nested)' : 'Background');
      cell(row, item.inputTokens == null ? 'N/A' : num(item.inputTokens), 'num');
      cell(row, item.outputTokens == null ? 'N/A' : num(item.outputTokens), 'num');
      cell(row, item.cacheReadInputTokens == null ? 'N/A' : num(item.cacheReadInputTokens), 'num');
      const cost = item.inputCost || {};
      const breakdown = cell(row, '', 'modelInputBreakdown');
      for (const [label, amount, tokens] of [
        ['Uncached', cost.uncachedUsd, cost.uncachedInputTokens],
        ['Cache read', cost.cacheReadUsd, item.cacheReadInputTokens],
        ['Cache write', cost.cacheWriteUsd, item.cacheCreationInputTokens],
      ]) {
        const component = document.createElement('div');
        const name = document.createElement('span');
        name.textContent = label;
        const value = document.createElement('span');
        value.textContent = referenceUsd(amount);
        component.title = (tokens == null ? 'Token count not reported' : num(tokens) + ' tokens') +
          (amount == null ? ' | Cost unavailable' : ' | ' + referenceUsd(amount));
        component.append(name, value);
        breakdown.appendChild(component);
      }
      const adjusted = cell(row, referenceUsd(cost.coverage === 'partial' ? cost.knownUsd : cost.usd), 'num modelInputTotal cacheAwareInput');
      const coverage = document.createElement('span');
      coverage.className = 'modelUsageDetail';
      coverage.textContent = cost.coverage === 'complete' ? 'Complete' : cost.coverage === 'partial' ? 'Partial subtotal' : 'Not priced';
      adjusted.title = cost.reason || 'Input-only reference cost at recorded rates';
      adjusted.appendChild(coverage);
      const standard = cell(row, referenceUsd(cost.standardUncachedUsd), 'num modelInputTotal standardUncachedInput');
      const assumption = document.createElement('span');
      assumption.className = 'modelUsageDetail';
      assumption.textContent = 'Default estimate';
      standard.appendChild(assumption);
      cell(row, item.inputUsdPerMillion == null ? 'Unavailable' : '$' + item.inputUsdPerMillion + ' / 1M', 'num');
      body.appendChild(row);
    }
  }

  function renderTrafficStatus(traffic) {
    const grid = $('trafficStatus');
    const minutes = traffic.activeWindowMinutes || 15;
    const metrics = [
      ['Connected dashboard views', num(traffic.viewerConnections), 'Live now'],
      ['Recently active sessions', num(traffic.producerSessions), 'Last ' + minutes + ' minutes'],
      ['Recorded tool operations', num(traffic.totalOutputs), 'All retained history | Shared store'],
    ];
    grid.textContent = '';
    for (const [label, value, scope] of metrics) {
      const item = metricCard(label, value);
      const scopeText = document.createElement('div');
      scopeText.className = 'trafficScope';
      scopeText.textContent = scope;
      item.appendChild(scopeText);
      grid.appendChild(item);
    }
  }

  function renderWorkspaceAttribution(items) {
    const body = $('workspaceAttribution');
    body.textContent = '';
    $('workspaceAttributionEmpty').hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, item.label || 'Unknown workspace', 'label');
      cell(row, num(item.calls), 'num');
      cell(row, num(item.tokensBefore), 'num');
      cell(row, num(item.tokensAfter), 'num');
      cell(row, num(item.tokensSaved), 'num');
      cell(row, ((item.percentSaved || 0).toFixed(0)) + '%', 'num');
      cell(row, item.lastActivity ? new Date(item.lastActivity).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
      body.appendChild(row);
    }
  }

  function renderLifetime(lifetime) {
    const grid = $('lifetimeTotals');
    grid.textContent = '';
    grid.appendChild(metricCard('Chats observed', num(lifetime.chatsObserved)));
    grid.appendChild(metricCard('Tool events observed', num(lifetime.observedToolCalls)));
    grid.appendChild(metricCard('Tokens saved', num(lifetime.tokensSaved)));
    grid.appendChild(metricCard('Percent saved', ((lifetime.percentSaved || 0).toFixed(1)) + '%'));
    grid.appendChild(metricCard('Est. saved', '$' + (lifetime.estimatedCostSavedUsd || 0).toFixed(2)));
    grid.appendChild(metricCard('Recorded events', num(lifetime.events)));
    grid.appendChild(metricCard('Compressions', num(lifetime.compressions)));
    grid.appendChild(metricCard('Retrievals', num(lifetime.retrievals)));
    grid.appendChild(metricCard('First event', lifetime.firstEventAt ? new Date(lifetime.firstEventAt).toLocaleString() : '--'));
    grid.appendChild(metricCard(
      'Session panels show',
      'last ' + num(lifetime.recentWindow) + ' events',
    ));
  }

  function renderHistory(buckets) {
    const body = $('history');
    body.textContent = '';
    $('historyEmpty').hidden = buckets.length > 0;
    for (const bucket of buckets) {
      const row = document.createElement('tr');
      cell(row, bucket.date);
      cell(row, num(bucket.calls), 'num');
      cell(row, num(bucket.tokensBefore), 'num');
      cell(row, num(bucket.tokensAfter), 'num');
      cell(row, num(bucket.tokensSaved), 'num');
      cell(row, ((bucket.percentSaved || 0).toFixed(0)) + '%', 'num');
      body.appendChild(row);
    }
  }

  function renderWasteSignals(signals) {
    const body = $('wasteSignals');
    body.textContent = '';
    $('wasteSignalsEmpty').hidden = signals.length > 0;
    for (const signal of signals) {
      const row = document.createElement('tr');
      const what = cell(row, '');
      const label = document.createElement('span');
      label.textContent = signal.label;
      const detail = document.createElement('span');
      detail.className = 'timelineDetail';
      detail.textContent = signal.detail;
      what.appendChild(label);
      what.appendChild(document.createElement('br'));
      what.appendChild(detail);
      cell(row, num(signal.calls), 'num');
      cell(row, num(signal.tokensSaved), 'num');
      body.appendChild(row);
    }
  }

  function renderCostAttribution(cost) {
    const body = $('costAttribution');
    body.textContent = '';
    const usd = (value) => value == null ? 'N/A' : '$' + Number(value).toFixed(2);

    for (const bucket of cost.buckets || []) {
      const row = document.createElement('tr');
      cell(row, bucket.label);
      cell(row, num(bucket.calls), 'num');
      cell(row, num(bucket.tokens), 'num');
      cell(row, usd(bucket.usd), 'num');
      body.appendChild(row);
    }

    if (cost.retrievalTokens > 0) {
      const row = document.createElement('tr');
      cell(row, 'Retrieval paid back');
      cell(row, '', 'num');
      cell(row, '-' + num(cost.retrievalTokens), 'num');
      cell(row, usd(cost.retrievalUsd == null ? null : -cost.retrievalUsd), 'num');
      body.appendChild(row);
    }

    const net = document.createElement('tr');
    cell(net, 'Net saved');
    cell(net, '', 'num');
    cell(net, num(cost.netTokensSaved), 'num');
    cell(net, usd(cost.netUsd), 'num');
    body.appendChild(net);

    for (const model of cost.models || []) {
      const row = document.createElement('tr');
      cell(row, model.label);
      cell(row, '', 'num');
      cell(row, model.cost.coverage, 'num');
      cell(row, usd(model.cost.usd), 'num');
      body.appendChild(row);
    }

    $('costAttributionNote').textContent =
      'Standard uncached input estimate; not a Copilot bill. ' +
      'Recorded-rate coverage: ' + ((cost.cost || {}).coverage || 'unpriced') + '; known net subtotal: ' + usd((cost.cost || {}).knownUsd) +
      '; default-rate net estimate: ' + usd((cost.cost || {}).fallbackUsd) + ' at $' + cost.usdPerMillionTokens + ' / 1M tokens. ' +
      'Cross-turn dedup ran on ' + num(cost.dedupCalls) +
      ' call(s); its saving is already counted in the bucket for that call.';
  }

  function renderComparison(comparison) {
    const body = $('comparison');
    body.textContent = '';
    const deltas = comparison.deltas || [];
    const benchmark = comparison.benchmark;
    const current = comparison.current;
    $('comparisonEmpty').hidden = !!comparison.baseline;
    $('baselineMeta').textContent = comparison.baseline
      ? 'Baseline saved ' + new Date(comparison.baseline.savedAt).toLocaleString() +
        ' (' + num(comparison.baseline.events) + ' events).'
      : 'No baseline saved yet.';

    $('benchmarkMeta').textContent = benchmark
      ? 'Synthetic reference: ' + num(benchmark.scenarios) + ' scenarios; seed ' + benchmark.seed +
        '; ' + benchmark.profile + ' profile. Pre-retrieval savings; different workload from live totals. ' +
        'N/A: retrieval rate and timing are not benchmarked.'
      : 'Synthetic reference unavailable.';

    const format = (value, unit) => {
      if (value === undefined || value === null) return 'N/A';
      if (unit === 'percent') return Number(value || 0).toFixed(1) + '%';
      if (unit === 'ms') return ms(value);
      return num(value);
    };

    const metrics = [
      { metric: 'Tokens saved', key: 'tokensSaved', unit: 'tokens' },
      { metric: 'Percent saved', key: 'percentSaved', unit: 'percent' },
      { metric: 'Retrieval rate', key: 'retrievalRate', unit: 'percent' },
      { metric: 'Compression overhead', key: 'totalOverheadMs', unit: 'ms' },
    ];
    for (const item of metrics) {
      const delta = deltas.find((entry) => entry.metric === item.metric);
      const row = document.createElement('tr');
      cell(row, item.metric);
      cell(row, format(comparison.baseline && comparison.baseline[item.key], item.unit), 'num');
      cell(row, format(current && current[item.key], item.unit), 'num');
      const sign = delta && delta.change > 0 ? '+' : '';
      const percent = !delta || delta.percentChange === undefined || delta.percentChange === null
          ? ''
          : ' (' + (delta.percentChange > 0 ? '+' : '') + delta.percentChange.toFixed(1) + '%)';
      cell(row, delta ? sign + format(delta.change, item.unit) + percent : 'N/A', 'num');
      cell(row, format(benchmark && benchmark[item.key], item.unit), 'num');
      body.appendChild(row);
    }
  }

  function renderTokenFlow(flow) {
    const grid = $('tokenFlow');
    grid.textContent = '';
    grid.appendChild(metricCard('Raw tool output', num(flow.rawTokens) + ' tokens'));
    grid.appendChild(metricCard('Returned to model', num(flow.returnedTokens) + ' tokens'));
    grid.appendChild(metricCard('Omitted behind markers', num(flow.omittedTokens) + ' tokens'));
    grid.appendChild(metricCard('Reintroduced by retrieval', num(flow.retrievedTokens) + ' tokens'));
    grid.appendChild(metricCard('Net saved after retrieval', num(flow.netSavedTokens) + ' tokens'));
  }

  function renderOutcomeBreakdown(items) {
    const body = $('outcomeReasons');
    body.textContent = '';
    $('outcomeReasonsEmpty').hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, item.reason);
      cell(row, num(item.calls), 'num');
      cell(row, num(item.tokensBefore), 'num');
      cell(row, num(item.tokensAfter), 'num');
      cell(row, num(item.tokensSaved), 'num');
      body.appendChild(row);
    }
  }

  function renderRetrievalLifecycle(lifecycle) {
    const grid = $('retrievalLifecycle');
    grid.textContent = '';
    grid.appendChild(metricCard('Shown to model', num(lifecycle.shownToModel)));
    grid.appendChild(metricCard('Retrieved by id', num(lifecycle.retrievedById)));
    grid.appendChild(metricCard('Retrieved by grep', num(lifecycle.retrievedByGrep)));
    grid.appendChild(metricCard('Expired or evicted', num(lifecycle.expired)));
    grid.appendChild(metricCard('Still retrievable', num(lifecycle.stillRetrievable)));
  }

  function renderReuseHealth(health) {
    const grid = $('reuseHealth');
    grid.textContent = '';
    grid.appendChild(metricCard('Markers emitted', num(health.markersEmitted)));
    grid.appendChild(metricCard('Markers retrieved', num(health.markersRetrieved)));
    grid.appendChild(metricCard('Retrieval rate', ((health.retrievalRate || 0).toFixed(1)) + '%'));
    grid.appendChild(metricCard('Omitted vs retrieved lines', num(health.omittedLines) + ' / ' + num(health.retrievedLines)));
    grid.appendChild(metricCard('Dedup markers', num(health.dedupMarkers)));
    grid.appendChild(metricCard('Repeat-read hits', num(health.unchangedReadHits) + ' unchanged, ' + num(health.diffReadHits) + ' diff'));
    grid.appendChild(metricCard('Artifact entries', num(health.artifactEntries) + ' / ' + num(health.artifactMaxEntries) + ' (' + ((health.artifactEntryPercent || 0).toFixed(1)) + '%)'));
    grid.appendChild(metricCard('Artifact storage', bytes(health.artifactBytes) + ' / ' + bytes(health.artifactMaxBytes) + ' (' + ((health.artifactBytePercent || 0).toFixed(1)) + '%)'));
  }

  function renderTimingBreakdown(items) {
    const body = $('timingBreakdown');
    body.textContent = '';
    $('timingBreakdownEmpty').hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, item.name);
      cell(row, (item.strategies || []).join(', '), 'label');
      cell(row, num(item.calls), 'num');
      cell(row, ms(item.avgMs), 'num');
      cell(row, ms(item.minMs), 'num');
      cell(row, ms(item.maxMs), 'num');
      cell(row, ms(item.p95Ms), 'num');
      cell(row, ms(item.totalMs), 'num');
      body.appendChild(row);
    }
  }

  function metricCard(label, value, title) {
    const block = document.createElement('div');
    block.className = 'proofItem';
    if (title) block.title = title;
    const name = document.createElement('span');
    name.className = 'k';
    name.textContent = label;
    const stat = document.createElement('span');
    stat.className = 'v';
    stat.textContent = value;
    block.appendChild(name);
    block.appendChild(stat);
    return block;
  }

  function renderStrategyBreakdown(items) {
    const strategies = $('strategies');
    strategies.textContent = '';
    $('strategiesEmpty').hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, item.name);
      cell(row, (item.strategies || []).join(', '), 'label');
      cell(row, num(item.calls), 'num');
      cell(row, num(item.tokensBefore), 'num');
      cell(row, num(item.tokensAfter), 'num');
      cell(row, num(item.tokensSaved), 'num');
      cell(row, (item.percentSaved || 0).toFixed(0) + '%', 'num');
      strategies.appendChild(row);
    }
  }

  function renderRetrievalAudit(audit) {
    const body = $('retrievalAudit');
    body.textContent = '';
    const items = (audit && audit.items) || [];
    const callout = $('retrievalAuditCallout');
    callout.textContent = '';
    if (audit && audit.totalMarkers > 0) {
      const strong = document.createElement('strong');
      strong.textContent = ((audit.percentUnretrieved || 0).toFixed(0)) + '%';
      callout.appendChild(strong);
      callout.appendChild(
        document.createTextNode(
          ' of expandable markers were never needed by the model (' +
            num(audit.unretrievedMarkers) + ' of ' + num(audit.totalMarkers) +
            ' stayed compressed; ' + num(audit.retrievedMarkers) + ' expanded).',
        ),
      );
    } else {
      callout.textContent = 'No omitted markers yet.';
    }
    $('retrievalAuditEmpty').hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, item.label, 'label');
      const strategy = cell(row, '');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = item.strategy;
      strategy.appendChild(tag);
      cell(row, num(item.omittedLines) + ' line(s) / ' + num(item.markerCount) + ' marker(s)', 'num');
      cell(row, num(item.retrievedLines) + ' line(s) / ' + num(item.retrievedMarkers) + ' marker(s)', 'num');
      const status = cell(row, '', 'auditStatus');
      const strong = document.createElement('strong');
      strong.textContent = num(item.unretrievedMarkers);
      status.appendChild(strong);
      status.appendChild(document.createTextNode(' marker(s) stayed compressed'));
      body.appendChild(row);
    }
  }

  function renderTimeline(items) {
    const timeline = $('timeline');
    timeline.textContent = '';
    $('timelineEmpty').hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      row.className = 'timelineItem';
      if (item.inspectable) {
        row.classList.add('inspectable');
        row.addEventListener('click', () => requestDetail(item.ts, item.eventId));
      }

      const time = document.createElement('span');
      time.className = 'timelineTime';
      time.textContent = item.time;
      row.appendChild(time);

      const tagWrap = document.createElement('span');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = item.kind;
      tagWrap.appendChild(tag);
      row.appendChild(tagWrap);

      const body = document.createElement('span');
      const title = document.createElement('span');
      title.className = 'timelineTitle';
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.className = 'timelineDetail';
      detail.textContent = item.detail + (Number.isFinite(item.durationMs) ? ' Slipstream: ' + ms(item.durationMs) + '.' : '');
      body.appendChild(title);
      body.appendChild(document.createElement('br'));
      body.appendChild(detail);
      row.appendChild(body);

      const saved = document.createElement('span');
      saved.className = 'timelineSaved';
      saved.textContent = item.tokensSaved > 0 ? num(item.tokensSaved) + ' saved' : '';
      row.appendChild(saved);

      timeline.appendChild(row);
    }
  }

  /** Left pane: kept runs as code, omitted runs as a shaded, expandable block. */
  function renderBefore(container, text, omitted) {
    container.textContent = '';
    if (text === undefined || text === null) {
      const gone = document.createElement('pre');
      gone.textContent = 'This content is no longer in the artifact store.';
      container.appendChild(gone);
      return;
    }
    const lines = text.split('\\n');
    let cursor = 1;

    const addKept = (from, to) => {
      if (to < from) return;
      const pre = document.createElement('pre');
      pre.textContent = lines.slice(from - 1, to).join('\\n');
      container.appendChild(pre);
    };

    for (const range of omitted || []) {
      if (range.startLine > cursor) addKept(cursor, range.startLine - 1);

      const count = range.endLine - range.startLine + 1;
      const label = (open) =>
        (open ? '\\u25be ' : '\\u2212 ') + num(count) + ' lines removed (' +
        range.startLine + '\\u2013' + range.endLine + ')' + (open ? '' : ' \\u2014 click to expand');

      const block = document.createElement('div');
      block.className = 'cut';
      block.textContent = label(false);

      const body = document.createElement('pre');
      body.hidden = true;
      body.textContent = lines.slice(range.startLine - 1, range.endLine).join('\\n');

      let open = false;
      block.addEventListener('click', () => {
        open = !open;
        body.hidden = !open;
        block.textContent = label(open);
      });
      container.appendChild(block);
      container.appendChild(body);
      cursor = Math.max(cursor, range.endLine + 1);
    }
    addKept(cursor, lines.length);
  }

  /** Right pane: what was sent, with the retrieval markers picked out. */
  function renderAfter(container, text) {
    container.textContent = '';
    const pre = document.createElement('pre');
    if (text === undefined || text === null) {
      pre.textContent = 'This content is no longer in the artifact store.';
      container.appendChild(pre);
      return;
    }
    const re = /\\[\\[slipstream:[0-9a-f]{12} L\\d+-\\d+[^\\]\\n]*\\]\\]/g;
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        pre.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const span = document.createElement('span');
      span.className = 'marker';
      span.textContent = match[0];
      pre.appendChild(span);
      last = match.index + match[0].length;
    }
    pre.appendChild(document.createTextNode(text.slice(last)));
    container.appendChild(pre);
  }

  function setDetailMode(mode) {
    const diff = mode === 'diff';
    $('sideBySideView').hidden = diff;
    $('diffView').hidden = !diff;
    $('sideBySideMode').classList.toggle('active', !diff);
    $('diffMode').classList.toggle('active', diff);
    if (diff && currentDetail) renderDiff(currentDetail);
  }

  function renderDiff(d) {
    const body = $('diffBody');
    body.textContent = '';
    $('diffSummary').textContent =
      'Raw vs compressed: ' + num((d.diffSummary && d.diffSummary.keptLines) || 0) +
      ' raw line(s) kept, ' + num((d.diffSummary && d.diffSummary.removedLines) || 0) +
      ' raw line(s) removed, ' + num((d.diffSummary && d.diffSummary.tokensSaved) || 0) +
      ' tokens saved (' + (((d.diffSummary && d.diffSummary.percentSaved) || 0).toFixed(0)) + '%).';

    if (d.before === undefined || d.before === null || d.after === undefined || d.after === null) {
      const line = document.createElement('pre');
      line.className = 'diffLine keep';
      line.textContent = 'Diff is unavailable because one side is no longer in the artifact store.';
      body.appendChild(line);
      return;
    }

    const lines = d.before.split('\\n');
    let cursor = 1;
    const addLine = (prefix, text, className) => {
      const line = document.createElement('pre');
      line.className = 'diffLine ' + className;
      line.textContent = prefix + text;
      body.appendChild(line);
    };
    const addKept = (from, to) => {
      for (let i = from; i <= to; i++) addLine('  ', lines[i - 1] || '', 'keep');
    };

    for (const range of d.omitted || []) {
      if (range.startLine > cursor) addKept(cursor, range.startLine - 1);
      for (let i = range.startLine; i <= range.endLine; i++) addLine('- ', lines[i - 1] || '', 'remove');
      cursor = Math.max(cursor, range.endLine + 1);
    }
    addKept(cursor, lines.length);

    addLine('', '', 'keep');
    addLine('> ', 'Model received:', 'payload');
    for (const line of d.after.split('\\n')) addLine('> ', line, 'payload');
  }

  function renderHealth(report) {
    const button = $('runHealth');
    if (button) button.disabled = false;
    const container = $('healthChecks');
    container.textContent = '';
    const checks = (report && report.checks) || [];
    const icons = { pass: '\u2714', warn: '!', fail: '\u2717' };
    for (const check of checks) {
      const row = document.createElement('div');
      row.className = 'healthCheck ' + (check.status || 'warn');
      const icon = document.createElement('span');
      icon.className = 'healthIcon';
      icon.textContent = icons[check.status] || '?';
      const body = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'healthName';
      name.textContent = check.name + ': ';
      const detail = document.createElement('span');
      detail.className = 'healthDetail';
      detail.textContent = check.detail || '';
      body.appendChild(name);
      body.appendChild(detail);
      row.appendChild(icon);
      row.appendChild(body);
      container.appendChild(row);
    }
    const meta = $('healthMeta');
    if (!checks.length) {
      meta.textContent = 'No checks returned.';
    } else if (report.ok) {
      meta.textContent = 'All critical checks passed.';
    } else {
      meta.textContent = 'One or more checks failed.';
    }
  }

  function renderDetail(d) {
    $('detail').hidden = false;
    selectDashboardPanel('activity');
    currentDetail = d;
    currentModelPayload = d.after || '';
    const hasModelPayload = typeof d.after === 'string';
    $('dName').textContent = d.label;
    $('dStrategy').textContent = d.strategy;
    $('dBeforeCount').textContent = num(d.tokensBefore) + ' tokens';
    const pct = d.tokensBefore > 0
      ? Math.round(((d.tokensBefore - d.tokensAfter) / d.tokensBefore) * 100)
      : 0;
    $('dAfterCount').textContent = num(d.tokensAfter) + ' tokens (' + pct + '% less)';
    $('modelPayloadMeta').textContent = hasModelPayload
      ? 'Exact payload: ' + num((d.modelPayload && d.modelPayload.lines) || 0) + ' line(s), ' +
        num((d.modelPayload && d.modelPayload.tokens) || d.tokensAfter) + ' tokens, ' +
        num((d.modelPayload && d.modelPayload.markerCount) || 0) + ' retrieval marker(s).'
      : 'Exact payload is no longer in the artifact store.';
    $('copyModelPayload').disabled = !hasModelPayload;
    const link = $('modelPayloadLink');
    link.hidden = !!vscodeApi || !hasModelPayload;
    link.href = modelPayloadUrl(d.ts, d.eventId);
    renderBefore($('dBefore'), d.before, d.omitted);
    renderAfter($('dAfter'), d.after);
    renderDiff(d);
  }

  const utilityDrawer = $('utilityDrawer');
  const utilityOpener = $('openUtilities');
  utilityOpener.addEventListener('click', () => {
    utilityDrawer.showModal();
    utilityOpener.setAttribute('aria-expanded', 'true');
  });
  $('closeUtilities').addEventListener('click', () => utilityDrawer.close());
  utilityDrawer.addEventListener('close', () => {
    utilityOpener.setAttribute('aria-expanded', 'false');
    utilityOpener.focus({ preventScroll: true });
  });
  utilityDrawer.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...utilityDrawer.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
      .filter((element) => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  utilityDrawer.addEventListener('click', (event) => {
    if (event.target !== utilityDrawer) return;
    const bounds = utilityDrawer.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) utilityDrawer.close();
  });

  $('copyModelPayload').addEventListener('click', () => {
    if (!navigator.clipboard || !currentModelPayload) return;
    navigator.clipboard.writeText(currentModelPayload).catch(() => {});
  });
  $('sideBySideMode').addEventListener('click', () => setDetailMode('sideBySide'));
  $('saveBaseline').addEventListener('click', () => {
    const button = $('saveBaseline');
    button.disabled = true;
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'baseline' });
      button.disabled = false;
      return;
    }
    postApi('baseline', {})
      .then((data) => {
        if (data) {
          signature = '';
          applySummary(data);
        }
      })
      .catch(() => {})
      .then(() => { button.disabled = false; });
  });
  $('diffMode').addEventListener('click', () => setDetailMode('diff'));
  $('connectModelTracking').addEventListener('click', () => modelTrackingAction('connect'));
  $('disconnectModelTracking').addEventListener('click', () => modelTrackingAction('disconnect'));
  $('refreshCatalog').addEventListener('click', refreshCatalog);
  $('runHealth').addEventListener('click', () => {
    const button = $('runHealth');
    button.disabled = true;
    $('healthMeta').textContent = 'Running…';
    if (vscodeApi) {
      vscodeApi.postMessage({ type: 'health' });
      return;
    }
    postApi('health', {})
      .then((data) => { if (data) renderHealth(data); })
      .catch(() => { $('healthMeta').textContent = 'Health check failed to run.'; })
      .then(() => { button.disabled = false; });
  });
  $('configStatus').addEventListener('submit', (event) => event.preventDefault());
  $('policyForm').addEventListener('submit', applyPolicy);
  $('recommendationForm').addEventListener('submit', compareModels);
  $('recommendationFields').addEventListener('input', () => invalidateModelRecommendation('Inputs changed. Previous comparison expired.'));
  $('recommendationFields').addEventListener('change', () => invalidateModelRecommendation('Inputs changed. Previous comparison expired.'));
  $('policyFields').addEventListener('input', markPolicyDirty);
  $('policyFields').addEventListener('change', markPolicyDirty);
  $('policyModelSearch').addEventListener('input', renderPolicyModels);
  $('refreshPolicyModels').addEventListener('click', requestPolicyModels);
  $('policyAdvanced').addEventListener('toggle', () => {
    if ($('policyAdvanced').open && !policyModelsLoaded) requestPolicyModels();
  });
  $('reloadPolicy').addEventListener('click', () => {
    loadPolicyDraft('Saved values restored.');
    requestSummary();
  });
  $('themeMode').addEventListener('change', (event) => applyTheme(event.target.value));
  for (const tab of document.querySelectorAll('[data-panel-target]')) {
    tab.addEventListener('click', () => selectDashboardPanel(tab.getAttribute('data-panel-target') || 'overview'));
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'detail') renderDetail(data);
    else if (data.type === 'configError') $('configMessage').textContent = data.error;
    else if (data.type === 'costPolicyResult') finishPolicySave(data.error);
    else if (data.type === 'policyModelsResult') finishPolicyModels(data);
    else if (data.type === 'modelRecommendationResult') finishModelRecommendation(data);
    else if (data.type === 'health') renderHealth(data);
    else if (data.type === 'catalogRefreshResult') {
      catalogRefreshPending = false;
      catalogRefreshError = data.error || '';
      renderCatalog(catalogStatus);
    }
    else applySummary(data);
  });

  applyTheme(storedTheme());
  selectDashboardPanel(selectedDashboardPanel);
  setConnectionState('inactive', 'Inactive');
  requestSummary();

  if (!vscodeApi) {
    const stream = new EventSource(eventStreamUrl());
    stream.addEventListener('open', () => setConnectionState('connected', 'Connected'));
    stream.addEventListener('summary', (event) => {
      try {
        setConnectionState('connected', 'Connected');
        applySummary(JSON.parse(event.data));
      } catch {
        /* ignore malformed event stream frames */
      }
    });
    stream.addEventListener('heartbeat', () => setConnectionState('connected', 'Connected'));
    stream.addEventListener('error', () => {
      setConnectionState('error', 'Error');
      requestSummary();
    });
  }
}());
</script>
</body>
</html>`;
}
