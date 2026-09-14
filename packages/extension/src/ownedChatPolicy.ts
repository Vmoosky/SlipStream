import {
  activeCompressionTrial, choosePolicyProfile, compressionProfileEvidence, compressionTrialState, costPolicyPermissions,
  evaluateCompressionFeedback, guardedInputTokens, isTokenCount, planOwnedCall, PolicyPauseError,
  policyModelEvidence, selectPolicyModel, taskWorkspaceKey, COMPRESSION_PROFILES,
  type CompressionEngine, type CompressionProfile, type CompressionTrialState, type CostPolicyAssessment,
  type OwnedPolicyReason, type OwnedTaskCategory, type OwnedTaskUsage, type PolicyCandidate,
} from '@slipstream/core';
import * as vscode from 'vscode';

export class OwnedChatPolicy {
  private selection?: Promise<vscode.LanguageModelChat>;
  private selectedModel: vscode.LanguageModelChat;
  private reason: OwnedPolicyReason = 'pinned';
  private recoveryNeeded = false;
  private recoveryFailures = 0;
  private readonly permissions;
  private readonly evidence;
  private readonly compressionEvidence;
  private trial: CompressionTrialState | null;
  private lastFeedback?: string;
  pauseError?: PolicyPauseError;

  constructor(private readonly engine: CompressionEngine, private readonly task: OwnedTaskUsage,
    private readonly assessment: CostPolicyAssessment, private readonly requested: vscode.LanguageModelChat,
    private readonly options: {
      category?: OwnedTaskCategory;
      isCurrent(): boolean;
      canSendRequest(model: vscode.LanguageModelChat): boolean | undefined;
      progress(message: string): void;
    }) {
    this.selectedModel = requested;
    this.permissions = costPolicyPermissions(engine.getConfig().costPolicy, engine.getCostPolicyContext());
    const workspaceKey = taskWorkspaceKey(engine.getWorkspaceRoots());
    const history = engine.ledger.all();
    this.evidence = policyModelEvidence(history, workspaceKey, options.category);
    // Evidence is read once, before this task contributes to it, so the loop
    // cannot react to its own in-flight samples.
    this.compressionEvidence = compressionProfileEvidence(history, workspaceKey, options.category);
    this.trial = compressionTrialState(history, workspaceKey);
    if (task.resumed) {
      this.recoveryFailures = task.resumed.recoveryFailures ?? 0;
      this.recoveryNeeded = this.recoveryFailures > 0 || (task.resumed.retrievals ?? 0) > 0;
      const profile = task.resumed.policyDecision?.profile;
      if (profile && this.permissions.profiles.includes(profile)) engine.updateConfig({ profile });
    }
  }

  get model() { return this.selectedModel; }
  get outputTokenAllowance() { return this.permissions.outputTokenAllowance; }

  assertCurrent(token?: vscode.CancellationToken): void {
    if (this.pauseError) throw this.pauseError;
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    this.task.assertActive();
    if (this.recoveryFailures > 1) throw new PolicyPauseError('recovery-failure', 'Automatic task remains paused after repeated artifact recovery failures.');
    if (!this.options.isCurrent()) throw new PolicyPauseError('policy-changed', 'Automatic task paused: workspace trust, roots, or policy changed. Start a new request under the current policy.');
  }

  async prepare(messages: vscode.LanguageModelChatMessage[], requestOptions: vscode.LanguageModelChatRequestOptions | undefined, token?: vscode.CancellationToken) {
    this.assertCurrent(token);
    if (this.assessment.taskBudget === null) throw new PolicyPauseError('budget-required', 'Automatic task paused: configure a compatible task budget before starting owned calls.');
    if (!messages.every((message) => message.content.every((part) => part instanceof vscode.LanguageModelTextPart ||
      part instanceof vscode.LanguageModelToolCallPart || part instanceof vscode.LanguageModelToolResultPart &&
      part.content.every((content) => content instanceof vscode.LanguageModelTextPart)))) {
      throw new PolicyPauseError('no-compatible-model', 'Automatic task paused: model compatibility for this non-text input is unknown.');
    }
    this.selection ??= this.select(messages, requestOptions, token);
    const model = await this.selection;
    const candidate = await this.candidate(model, messages, requestOptions, token);
    this.assertCurrent(token);
    if (!candidate.toolCalling || this.options.canSendRequest(model) === false) throw new PolicyPauseError('no-compatible-model', 'Automatic task paused: model access or tool compatibility is unavailable.');
    const plan = planOwnedCall(candidate, this.assessment.budgetUnit, this.assessment.taskBudget, this.task.getAllowanceUsed(), this.outputTokenAllowance);
    const pressure = Math.max(plan.pressure, guardedInputTokens(candidate.inputTokens) / candidate.maxInputTokens);
    const profile = this.resolveProfile(pressure);
    if (profile !== this.engine.getConfig().profile) {
      this.engine.updateConfig({ profile });
      this.options.progress(`Task compression: ${profile}.`);
    }
    this.recordDecision('active', this.reason);
    return { model, inputTokens: candidate.inputTokens!, rates: candidate.rates, reserved: plan.reservation };
  }

  /**
   * The pressure guard protects the headroom of the call that is about to be
   * sent, so its escalation always wins. Outside an escalation the outcome-driven
   * loop chooses, which keeps a quality signal from ever raising compression
   * above what this call's headroom allows.
   */
  private resolveProfile(pressure: number): CompressionProfile {
    const current = this.engine.getConfig().profile;
    const guard = choosePolicyProfile(current, this.permissions.profiles, pressure, this.recoveryNeeded, this.permissions.pressureThresholds);
    const feedback = this.feedbackProfile();
    return COMPRESSION_PROFILES.indexOf(guard) > COMPRESSION_PROFILES.indexOf(current) ? guard
      : COMPRESSION_PROFILES.indexOf(feedback) < COMPRESSION_PROFILES.indexOf(guard) ? feedback : guard;
  }

  private feedbackProfile(): CompressionProfile {
    const decision = evaluateCompressionFeedback({
      policy: this.permissions.compressionFeedback, permitted: this.permissions.profiles,
      current: this.engine.getConfig().profile, evidence: this.compressionEvidence,
      trial: this.trial, recoveryFailed: this.recoveryFailures > 0,
    });
    this.trial = decision.trial;
    const fingerprint = `${decision.action}/${decision.reason}/${decision.profile}`;
    if (decision.action !== 'disabled' && fingerprint !== this.lastFeedback) {
      this.lastFeedback = fingerprint;
      this.task.recordCompressionFeedback(decision);
      if (decision.action !== 'hold') {
        this.options.progress(`Task compression feedback: ${decision.action} to ${decision.profile} (${decision.reason})` +
          `${activeCompressionTrial(decision.trial) ? '. Bounded trial; the selected model stays fixed.' : '.'}`);
      }
    }
    return decision.profile;
  }

  recordRecovery(success: boolean): void {
    this.recoveryNeeded = true;
    if (!success) this.recoveryFailures++;
    if (this.recoveryFailures > 1) this.pause(new PolicyPauseError('recovery-failure', 'Automatic task paused after repeated artifact recovery failures. Retrieve the original content before continuing.'));
    const guard = choosePolicyProfile(this.engine.getConfig().profile, this.permissions.profiles, 0, true, this.permissions.pressureThresholds);
    const feedback = this.feedbackProfile();
    const profile = COMPRESSION_PROFILES.indexOf(feedback) < COMPRESSION_PROFILES.indexOf(guard) ? feedback : guard;
    if (profile !== this.engine.getConfig().profile) {      this.engine.updateConfig({ profile });
      this.recordDecision(this.pauseError ? 'paused' : 'active', this.pauseError?.reason ?? this.reason);
      this.options.progress(`Task compression: ${profile} after artifact recovery.`);
    }
  }

  pause(error: PolicyPauseError): void {
    if (this.pauseError) return;
    this.recordDecision('paused', error.reason);
    this.pauseError = error;
    this.options.progress(error.message);
  }

  private recordDecision(state: 'active' | 'paused', reason: OwnedPolicyReason): void {
    this.task.recordPolicyDecision({ state, reason,
      requestedModel: { vendor: this.requested.vendor, id: this.requested.id },
      selectedModel: { vendor: this.model.vendor, id: this.model.id }, profile: this.engine.getConfig().profile,
    });
  }

  async outputTokens(part: unknown, token?: vscode.CancellationToken): Promise<number> {
    this.assertCurrent(token);
    const text = typeof part === 'string' ? part : part instanceof vscode.LanguageModelTextPart ? part.value
      : part instanceof vscode.LanguageModelToolCallPart ? JSON.stringify({ name: part.name, input: part.input }) : undefined;
    if (text === undefined) throw new PolicyPauseError('output-limit', 'Automatic task paused: the output token allowance cannot be checked for this response type.');
    let tokens: number;
    try { tokens = await this.model.countTokens(text, token); }
    catch {
      this.assertCurrent(token);
      throw new PolicyPauseError('output-limit', 'Automatic task paused: output token counting is unavailable.');
    }
    this.assertCurrent(token);
    if (!isTokenCount(tokens)) throw new PolicyPauseError('output-limit', 'Automatic task paused: output token counting is invalid.');
    return Math.max(1, tokens);
  }

  private async candidate(model: vscode.LanguageModelChat, messages: vscode.LanguageModelChatMessage[], requestOptions: vscode.LanguageModelChatRequestOptions | undefined, token?: vscode.CancellationToken): Promise<PolicyCandidate> {
    this.assertCurrent(token);
    let inputTokens: number | null = null;
    try {
      const counts = await Promise.all([
        ...messages.map((message) => model.countTokens(message, token)),
        ...(requestOptions?.tools?.length ? [model.countTokens(JSON.stringify(requestOptions.tools), token)] : []),
      ]);
      const total = counts.reduce((sum, count) => sum + count, 0);
      if (counts.every(isTokenCount) && isTokenCount(total)) inputTokens = total;
    } catch { }
    this.assertCurrent(token);
    const rates = this.engine.pricing.snapshot({ mode: 'automatic' }, 0, { vendor: model.vendor, id: model.id, name: model.name });
    return { model: { vendor: model.vendor, id: model.id }, inputTokens, maxInputTokens: model.maxInputTokens,
      toolCalling: rates.toolCalling === true && !rates.stale && !(model.vendor === 'copilot' && model.family.startsWith('o1')),
      rates, ...this.evidence.get(`${model.vendor}\0${model.id}`) ?? { verifiedPasses: 0, verifiedFailures: 0 },
    };
  }

  private async select(messages: vscode.LanguageModelChatMessage[], requestOptions: vscode.LanguageModelChatRequestOptions | undefined, token?: vscode.CancellationToken) {
    const permitted = (model: vscode.LanguageModelChat) => this.permissions.models.some((allowed) => allowed.vendor === model.vendor && allowed.id === model.id);
    const pinned = this.engine.getCostPolicyContext().pinnedModel;
    if (!permitted(this.requested) || pinned && (pinned.vendor !== this.requested.vendor || pinned.id !== this.requested.id)) {
      throw new PolicyPauseError('no-compatible-model', 'Automatic task paused: the selected model conflicts with the permitted set or user pin. No substitute was sent.');
    }
    const models = [this.requested];
    const current = await this.candidate(this.requested, messages, requestOptions, token);
    if (current.inputTokens === null) throw new PolicyPauseError('unknown-input', 'Automatic task paused: input token count is unavailable.');
    const candidates = [current];
    const canSelect = !this.task.resumed && this.permissions.canSelectModel && !requestOptions?.modelOptions;
    if (canSelect && current.verifiedPasses >= 3 && current.verifiedFailures === 0) {
      let discovered: vscode.LanguageModelChat[] = [];
      try { discovered = await vscode.lm.selectChatModels(); } catch { }
      this.assertCurrent(token);
      for (const model of discovered) {
        if (!permitted(model) || this.options.canSendRequest(model) !== true || models.some((existing) => existing.vendor === model.vendor && existing.id === model.id)) continue;
        const evidence = this.evidence.get(`${model.vendor}\0${model.id}`);
        if (!evidence || evidence.verifiedPasses < 3 || evidence.verifiedFailures !== 0) continue;
        models.push(model);
        candidates.push(await this.candidate(model, messages, requestOptions, token));
      }
    }
    const selected = selectPolicyModel(candidates, { vendor: this.requested.vendor, id: this.requested.id }, this.outputTokenAllowance, canSelect);
    this.reason = selected.reason;
    this.selectedModel = models.find((model) => model.vendor === selected.candidate.model.vendor && model.id === selected.candidate.model.id)!;
    this.engine.setRequestModel({ vendor: this.model.vendor, id: this.model.id, name: this.model.name });
    this.options.progress(`Task model: ${this.model.name}. ${this.reason === 'lower-reference-cost' ? 'Lower reference cost with verified task evidence.'
      : this.reason === 'insufficient-evidence' ? 'Current model retained; comparable prices or verified task evidence are incomplete.' : 'Selected model retained.'}`);
    return this.model;
  }
}