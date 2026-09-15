import * as crypto from 'node:crypto';

import {
  buildCurrentBaseline,
  buildDetailPayload,
  buildSummaryPayload,
  renderDashboardHtml,
  parseConfigPatch,
  parseCostPolicyPatch,
  parseModelRecommendationRequest,
  parsePolicyRecommendationRequest,
  costPolicyPermissions,
  policyModelEvidence,
  recommendPolicyModel,
  taskWorkspaceKey,
  runHealthReport,
  validateCostPolicy,
  watchLedgerChanges,
  type CompressionEngine,
  type DashboardCostPolicyControls,
  type DashboardModelTrackingControls,
  type DashboardPolicyModel,
  type EngineConfig,
  type PolicyCandidate,
  type PolicyRecommendation,
} from '@slipstream/core';
import * as vscode from 'vscode';

const costPolicySaves = new WeakSet<CompressionEngine>();

export async function saveWorkspaceCostPolicy(engine: CompressionEngine, value: unknown, expectedRevision: string): Promise<void> {
  if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
    throw new Error('Cost policy requires an open, trusted workspace.');
  }
  if (costPolicySaves.has(engine)) throw new Error('A policy save is already in progress.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A policy object is required.');
  const policy = validateCostPolicy(value);
  if (expectedRevision !== engine.getCostPolicyAssessment().policyRevision) {
    throw new Error('Cost policy changed. Reload the saved settings before applying.');
  }
  costPolicySaves.add(engine);
  try {
    const settings = vscode.workspace.getConfiguration('slipstream');
    await settings.update('costPolicy', policy, vscode.ConfigurationTarget.Workspace);
    const effective = validateCostPolicy(vscode.workspace.getConfiguration('slipstream').get<unknown>('costPolicy'));
    engine.updateConfig({ costPolicy: effective });
    if (JSON.stringify(effective) !== JSON.stringify(policy)) {
      throw new Error('The workspace policy was saved, but another configuration is effective. Review your settings.');
    }
  } finally {
    costPolicySaves.delete(engine);
  }
}

export async function listWorkspaceModels(engine: CompressionEngine,
  canSendRequest: (model: vscode.LanguageModelChat) => boolean | undefined): Promise<DashboardPolicyModel[]> {
  const workspaceKey = taskWorkspaceKey(engine.getWorkspaceRoots());
  const assertCurrent = () => {
    const roots = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath) ?? [];
    if (!vscode.workspace.isTrusted || !roots.length || taskWorkspaceKey(roots) !== workspaceKey || taskWorkspaceKey(engine.getWorkspaceRoots()) !== workspaceKey) {
      throw new Error('Model discovery requires the same open, trusted workspace.');
    }
  };
  assertCurrent();
  const discovered = await vscode.lm.selectChatModels();
  assertCurrent();
  const models: DashboardPolicyModel[] = [];
  for (const model of discovered) {
    const identity = { vendor: model.vendor, id: model.id };
    try { validateCostPolicy({ version: 1, mode: 'off', allowedModels: [identity] }); } catch { continue; }
    if (models.some((candidate) => candidate.vendor === model.vendor && candidate.id === model.id)) continue;
    models.push({ ...identity, name: model.name || model.id, authorized: canSendRequest(model) === true });
  }
  assertCurrent();
  return models.sort((left, right) => left.vendor.localeCompare(right.vendor) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export async function recommendWorkspaceModels(engine: CompressionEngine, value: unknown, expectedRevision: string,
  canSendRequest: (model: vscode.LanguageModelChat) => boolean | undefined): Promise<PolicyRecommendation> {
  const request = parsePolicyRecommendationRequest(value);
  const workspaceKey = taskWorkspaceKey(engine.getWorkspaceRoots());
  const assertCurrent = () => {
    const roots = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath) ?? [];
    if (!vscode.workspace.isTrusted || !roots.length || taskWorkspaceKey(roots) !== workspaceKey || taskWorkspaceKey(engine.getWorkspaceRoots()) !== workspaceKey) {
      throw new Error('Recommendations require the same open, trusted workspace.');
    }
    if (engine.getCostPolicyAssessment().policyRevision !== expectedRevision) throw new Error('Cost policy changed during comparison.');
  };
  assertCurrent();
  const policy = engine.getConfig().costPolicy;
  const context = engine.getCostPolicyContext();
  const permissions = costPolicyPermissions(policy, context);
  const allowedModels = permissions.models.filter((model) => !context.pinnedModel || model.vendor === context.pinnedModel.vendor && model.id === context.pinnedModel.id);
  const effectivePolicy = { ...policy, allowedModels };
  const query = { ...request, pinned: request.pinned === true || !!context.pinnedModel };
  if (policy.mode === 'off' || !allowedModels.length) return recommendPolicyModel(effectivePolicy, [], query);
  const discoveryStart = performance.now();
  const discovered = await vscode.lm.selectChatModels();
  const discoveryMs = performance.now() - discoveryStart;
  assertCurrent();
  const evidence = policyModelEvidence(engine.ledger.all(), workspaceKey, request.category);
  const candidates: PolicyCandidate[] = [];
  for (const model of discovered) {
    if (!allowedModels.some((allowed) => allowed.vendor === model.vendor && allowed.id === model.id) || canSendRequest(model) !== true ||
      candidates.some((candidate) => candidate.model.vendor === model.vendor && candidate.model.id === model.id)) continue;
    const rates = engine.pricing.snapshot({ mode: 'automatic' }, 0, { vendor: model.vendor, id: model.id, name: model.name });
    candidates.push({ model: { vendor: model.vendor, id: model.id }, inputTokens: request.inputTokens ?? null, maxInputTokens: model.maxInputTokens,
      toolCalling: rates.toolCalling === true && !rates.stale && !(model.vendor === 'copilot' && model.family.startsWith('o1')), rates,
      ...evidence.get(`${model.vendor}\0${model.id}`) ?? { verifiedPasses: 0, verifiedFailures: 0 } });
  }
  assertCurrent();
  const evaluationStart = performance.now();
  const result = recommendPolicyModel(effectivePolicy, candidates, query);
  return { ...result, timings: { discoveryMs, evaluationMs: performance.now() - evaluationStart } };
}

/**
 * Live savings dashboard, with a before/after view of each compression.
 *
 * The markup and client script live in `@slipstream/core` so this panel and the
 * local HTTP dashboard cannot drift apart. Everything displayed comes from tool
 * output, i.e. untrusted text: the page runs under a strict CSP with a per-load
 * nonce, receives data only as JSON, and writes every string with textContent.
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly engine: CompressionEngine,
    private readonly modelTracking?: DashboardModelTrackingControls,
    private readonly costPolicy?: DashboardCostPolicyControls,
  ) {
    this.panel.webview.html = renderDashboardHtml(crypto.randomBytes(16).toString('base64'));
    this.disposables.push(
      { dispose: this.engine.ledger.onRecord(() => this.post()) },
      { dispose: watchLedgerChanges(this.engine.ledger.path(), () => this.post()) },
      { dispose: this.engine.pricing.onChange(() => this.post()) },
      this.panel.webview.onDidReceiveMessage((message: { type?: string; ts?: number; eventId?: unknown; patch?: Partial<EngineConfig>; action?: unknown; policy?: unknown; expectedRevision?: unknown; request?: unknown; requestId?: unknown }) => {
        if (message?.type === 'ready') this.post();
        if (message?.type === 'inspect' && typeof message.ts === 'number' && Number.isFinite(message.ts)) {
          if (message.eventId !== undefined && typeof message.eventId !== 'string') return;
          this.postDetail(message.ts, message.eventId);
        }
        if (message?.type === 'config' && message.patch) {
          void this.applyConfigPatch(message.patch).catch((error: unknown) => {
            void this.panel.webview.postMessage({ type: 'configError', error: String(error) });
          });
        }
        if (message?.type === 'costPolicy') {
          void this.applyCostPolicyChange(message).then(() => {
            this.post();
            void this.panel.webview.postMessage({ type: 'costPolicyResult' });
          }, () => {
            this.post();
            void this.panel.webview.postMessage({ type: 'costPolicyResult', error: 'Policy could not be applied. Check workspace settings and reload the saved policy.' });
          });
        }
        if (message?.type === 'modelRecommendation') {
          if (!Number.isSafeInteger(message.requestId)) return;
          void this.compareModels(message).then((result) => {
            void this.panel.webview.postMessage({ type: 'modelRecommendationResult', requestId: message.requestId, policyRevision: message.expectedRevision, result });
          }, () => {
            void this.panel.webview.postMessage({ type: 'modelRecommendationResult', requestId: message.requestId, error: 'Recommendation unavailable. Check workspace access and the saved policy.' });
          });
        }
        if (message?.type === 'policyModels') {
          if (!Number.isSafeInteger(message.requestId)) return;
          void this.listModels().then((models) => {
            void this.panel.webview.postMessage({ type: 'policyModelsResult', requestId: message.requestId, models });
          }, () => {
            void this.panel.webview.postMessage({ type: 'policyModelsResult', requestId: message.requestId, error: 'Model list unavailable. Retry from the trusted VS Code workspace.' });
          });
        }
        if (message?.type === 'baseline') {
          this.engine.baseline.save(
            buildCurrentBaseline(
              this.engine,
              this.engine.ledger.all(),
              `Baseline ${new Date().toLocaleString()}`,
            ),
          );
          this.post();
        }
        if (message?.type === 'health') {
          this.postHealth();
        }
        if (message?.type === 'refreshCatalog') {
          void this.engine.pricing.refresh(true).then(() => {
            this.post();
            void this.panel.webview.postMessage({ type: 'catalogRefreshResult' });
          }, () => {
            void this.panel.webview.postMessage({ type: 'catalogRefreshResult', error: 'Catalog refresh could not be completed.' });
          });
        }
        if (message?.type === 'modelTracking' && this.modelTracking && (message.action === 'connect' || message.action === 'disconnect')) {
          void this.modelTracking[message.action]().then(() => this.post(), () => this.post());
        }
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  static show(context: vscode.ExtensionContext, engine: CompressionEngine, modelTracking?: DashboardModelTrackingControls, costPolicy?: DashboardCostPolicyControls): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      DashboardPanel.current.post();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'slipstream.dashboard',
      'Slipstream Savings',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // No local resources are loaded, so grant access to nothing.
        localResourceRoots: [],
      },
    );
    panel.iconPath = new vscode.ThemeIcon('zap');
    DashboardPanel.current = new DashboardPanel(panel, engine, modelTracking, costPolicy);
    context.subscriptions.push(panel);
  }

  static refresh(): void {
    DashboardPanel.current?.post();
  }

  private post(): void {
    void this.panel.webview.postMessage(buildSummaryPayload(this.engine, {
      viewerConnections: 0,
      modelTracking: this.modelTracking?.status(),
      canEditCostPolicy: this.costPolicy?.canEdit() === true,
      canRecommendModels: this.costPolicy?.canEdit() === true && !!this.costPolicy.recommend,
      canListPolicyModels: this.costPolicy?.canEdit() === true && !!this.costPolicy.listModels,
    }));
  }

  private postDetail(ts: number, eventId?: string): void {
    const payload = buildDetailPayload(this.engine, ts, eventId);
    if (payload) void this.panel.webview.postMessage(payload);
  }

  private postHealth(): void {
    const report = runHealthReport({ storageDir: this.engine.getStorageDir() });
    void this.panel.webview.postMessage({ type: 'health', ...report });
  }

  private async applyConfigPatch(patch: Partial<EngineConfig>): Promise<void> {
    patch = parseConfigPatch(patch);
    this.engine.updateConfig(patch);
    const settings = vscode.workspace.getConfiguration('slipstream');
    for (const [key, value] of Object.entries(patch)) {
      await settings.update(key, value, vscode.ConfigurationTarget.Global);
    }
    this.post();
  }

  private async compareModels(message: { request?: unknown; expectedRevision?: unknown }): Promise<PolicyRecommendation> {
    if (!this.costPolicy?.canEdit() || !this.costPolicy.recommend) throw new Error('Model recommendations are unavailable.');
    const query = parseModelRecommendationRequest({ request: message.request, expectedRevision: message.expectedRevision });
    if (query.expectedRevision !== this.engine.getCostPolicyAssessment().policyRevision) throw new Error('Cost policy changed.');
    const result = await this.costPolicy.recommend(query.request, query.expectedRevision);
    if (!this.costPolicy.canEdit() || query.expectedRevision !== this.engine.getCostPolicyAssessment().policyRevision) throw new Error('Cost policy changed.');
    return result;
  }

  private async applyCostPolicyChange(message: { policy?: unknown; expectedRevision?: unknown }): Promise<void> {
    if (!this.costPolicy?.canEdit()) throw new Error('Workspace policy editing is unavailable.');
    const change = parseCostPolicyPatch({ policy: message.policy, expectedRevision: message.expectedRevision });
    if (change.expectedRevision !== this.engine.getCostPolicyAssessment().policyRevision) throw new Error('Cost policy changed.');
    await this.costPolicy.save(change.policy, change.expectedRevision);
  }

  private async listModels(): Promise<DashboardPolicyModel[]> {
    if (!this.costPolicy?.canEdit() || !this.costPolicy.listModels) throw new Error('Model discovery is unavailable.');
    const models = await this.costPolicy.listModels();
    if (!this.costPolicy.canEdit()) throw new Error('Workspace access changed.');
    return models;
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
  }
}
