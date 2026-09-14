import { createHash } from 'node:crypto';

import { COMPRESSION_PROFILES, isCompressionProfile, type CompressionProfile } from './compressionProfiles.js';
import { DEFAULT_COMPRESSION_FEEDBACK_POLICY, validateCompressionFeedbackPolicy, type CompressionFeedbackPolicy } from './adaptiveCompression.js';

export const COST_POLICY_MODES = ['off', 'recommend-only', 'automatic-owned-request'] as const;
export type CostPolicyMode = typeof COST_POLICY_MODES[number];

export interface PolicyModel {
  vendor: string;
  id: string;
}

export interface PolicyPressureThresholds {
  balanced: number;
  aggressive: number;
}

export const DEFAULT_PRESSURE_THRESHOLDS: Readonly<PolicyPressureThresholds> = Object.freeze({ balanced: 0.5, aggressive: 0.8 });

export interface CostPolicy {
  version: 1;
  mode: CostPolicyMode;
  allowedModels: PolicyModel[];
  allowedCompressionProfiles: CompressionProfile[];
  budgetUnit: 'tokens' | 'reference-usd';
  taskBudget?: number;
  modelSelection?: 'pinned' | 'policy';
  outputTokenAllowance?: number;
  pressureThresholds?: PolicyPressureThresholds;
  compressionFeedback?: CompressionFeedbackPolicy;
}

export function validateCostPolicy(value: unknown = { version: 1, mode: 'off' }): CostPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cost policy');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !['version', 'mode', 'allowedModels', 'allowedCompressionProfiles', 'budgetUnit', 'taskBudget', 'modelSelection', 'outputTokenAllowance', 'pressureThresholds', 'compressionFeedback'].includes(key))) {
    throw new Error('Unknown cost policy setting');
  }
  if (raw.version !== 1) throw new Error('Unsupported cost policy version');
  if (!COST_POLICY_MODES.includes(raw.mode as CostPolicyMode)) throw new Error('Unknown cost policy mode');
  const models = raw.allowedModels ?? [];
  if (!Array.isArray(models) || models.length > 64 || raw.allowedModels === null) throw new Error('Invalid allowed policy models');
  const allowedModels = models.map((value): PolicyModel => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid policy model');
    const model = value as Record<string, unknown>;
    if (Object.keys(model).some((key) => key !== 'vendor' && key !== 'id') ||
      !validModelId(model.vendor) || !validModelId(model.id)) throw new Error('Invalid policy model');
    return { vendor: model.vendor, id: model.id };
  });
  if (new Set(allowedModels.map((model) => `${model.vendor}\0${model.id}`)).size !== allowedModels.length) {
    throw new Error('Duplicate policy model');
  }
  const profiles = raw.allowedCompressionProfiles ?? [...COMPRESSION_PROFILES];
  if (!Array.isArray(profiles) || raw.allowedCompressionProfiles === null || profiles.length === 0 ||
    !profiles.every(isCompressionProfile) || new Set(profiles).size !== profiles.length) throw new Error('Invalid policy compression profiles');
  const budgetUnit = raw.budgetUnit ?? 'tokens';
  if (raw.budgetUnit === null || (budgetUnit !== 'tokens' && budgetUnit !== 'reference-usd')) throw new Error('Unknown policy budget unit');
  const taskBudget = raw.taskBudget;
  if (taskBudget !== undefined && (typeof taskBudget !== 'number' || !Number.isFinite(taskBudget) || taskBudget < 0 ||
    taskBudget > Number.MAX_SAFE_INTEGER || (budgetUnit === 'tokens' && !Number.isSafeInteger(taskBudget)))) throw new Error('Invalid task budget');
  if (raw.modelSelection !== undefined && raw.modelSelection !== 'pinned' && raw.modelSelection !== 'policy') throw new Error('Invalid policy model selection');
  if (raw.outputTokenAllowance !== undefined && (typeof raw.outputTokenAllowance !== 'number' ||
    !Number.isSafeInteger(raw.outputTokenAllowance) || raw.outputTokenAllowance < 1 || raw.outputTokenAllowance > 32768)) throw new Error('Invalid output token allowance');
  const pressureThresholds = raw.pressureThresholds === undefined ? undefined : validatePressureThresholds(raw.pressureThresholds);
  const compressionFeedback = raw.compressionFeedback === undefined ? undefined : validateCompressionFeedbackPolicy(raw.compressionFeedback);
  return {
    version: 1, mode: raw.mode as CostPolicyMode, allowedModels,
    allowedCompressionProfiles: [...profiles], budgetUnit,
    ...(taskBudget === undefined ? {} : { taskBudget }),
    ...(raw.modelSelection === undefined ? {} : { modelSelection: raw.modelSelection }),
    ...(raw.outputTokenAllowance === undefined ? {} : { outputTokenAllowance: raw.outputTokenAllowance }),
    ...(pressureThresholds === undefined ? {} : { pressureThresholds }),
    ...(compressionFeedback === undefined ? {} : { compressionFeedback }),
  };
}

export function validatePressureThresholds(value: unknown): PolicyPressureThresholds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid pressure thresholds');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'balanced' && key !== 'aggressive') ||
    typeof raw.balanced !== 'number' || !Number.isFinite(raw.balanced) || raw.balanced < 0 ||
    typeof raw.aggressive !== 'number' || !Number.isFinite(raw.aggressive) || raw.aggressive > 1 ||
    raw.balanced >= raw.aggressive) throw new Error('Pressure thresholds must satisfy 0 <= balanced < aggressive <= 1');
  return { balanced: raw.balanced, aggressive: raw.aggressive };
}

function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,299}$/.test(value);
}

export type CostPolicyHost = 'native-copilot' | 'owned-chat' | 'external-tools';
export type CostPolicyAction = 'select-model' | 'change-compression' | 'enforce-budget';

export interface CostPolicyConstraints {
  allowAutomation?: boolean;
  allowedModels?: PolicyModel[];
  allowedCompressionProfiles?: CompressionProfile[];
}

export interface CostPolicyContext {
  host: CostPolicyHost;
  scope: 'workspace' | 'task';
  automaticExecutors?: boolean;
  pinnedModel?: PolicyModel;
  profile?: CompressionProfile;
  taskPolicy?: CostPolicy;
  constraints?: CostPolicyConstraints;
}

export function costPolicyPermissions(value: unknown, context: CostPolicyContext) {
  const workspace = validateCostPolicy(value);
  const task = context.taskPolicy === undefined ? undefined : validateCostPolicy(context.taskPolicy);
  const constraints = validateConstraints(context.constraints);
  const workspaceThresholds = workspace.pressureThresholds ?? DEFAULT_PRESSURE_THRESHOLDS;
  const taskThresholds = task?.pressureThresholds ?? workspaceThresholds;
  return {
    models: workspace.allowedModels.filter((model) => (!task || includesModel(task.allowedModels, model)) &&
      (!constraints.allowedModels || includesModel(constraints.allowedModels, model))),
    profiles: workspace.allowedCompressionProfiles.filter((profile) => (!task || task.allowedCompressionProfiles.includes(profile)) &&
      (!constraints.allowedCompressionProfiles || constraints.allowedCompressionProfiles.includes(profile))),
    canSelectModel: workspace.modelSelection === 'policy' && task?.modelSelection !== 'pinned' && context.pinnedModel === undefined,
    outputTokenAllowance: Math.min(workspace.outputTokenAllowance ?? 2048, task?.outputTokenAllowance ?? workspace.outputTokenAllowance ?? 2048),
    pressureThresholds: { balanced: Math.min(workspaceThresholds.balanced, taskThresholds.balanced),
      aggressive: Math.min(workspaceThresholds.aggressive, taskThresholds.aggressive) },
    compressionFeedback: mergeCompressionFeedback(workspace.compressionFeedback, task?.compressionFeedback, constraints.allowAutomation),
  };
}

/** Task policies and managed constraints may only tighten the feedback loop, never loosen it. */
function mergeCompressionFeedback(workspace: CompressionFeedbackPolicy | undefined, task: CompressionFeedbackPolicy | undefined,
  allowAutomation: boolean | undefined): CompressionFeedbackPolicy {
  const base = workspace ?? DEFAULT_COMPRESSION_FEEDBACK_POLICY;
  const other = task ?? base;
  const minNetBenefitRatio = Math.min(1, Math.max(base.minNetBenefitRatio, other.minNetBenefitRatio));
  return {
    version: 1,
    enabled: base.enabled && other.enabled && allowAutomation !== false,
    minSamples: Math.max(base.minSamples, other.minSamples),
    maxRetrievalRate: Math.min(base.maxRetrievalRate, other.maxRetrievalRate),
    maxOverheadMs: Math.min(base.maxOverheadMs, other.maxOverheadMs),
    minNetBenefitRatio,
    hysteresis: Math.min(Math.max(base.hysteresis, other.hysteresis), 1 - minNetBenefitRatio),
    cooldownMs: Math.max(base.cooldownMs, other.cooldownMs),
    trialTasks: Math.max(base.trialTasks, other.trialTasks),
  };
}

export interface CostPolicyAssessment {
  policyVersion: 1;
  policyRevision: string;
  requestedMode: CostPolicyMode;
  effectiveMode: CostPolicyMode;
  host: CostPolicyHost;
  scope: CostPolicyContext['scope'];
  budgetUnit: CostPolicy['budgetUnit'];
  taskBudget: number | null;
  coverage: 'not-measured';
  capabilities: {
    toolOutputCompression: true;
    ownedModelRequests: boolean;
    automaticModelSelection: boolean;
    budgetEnforcement: boolean;
    adaptiveCompression: boolean;
    /** Whether the bounded outcome-driven feedback loop is enabled, not merely available. */
    adaptiveCompressionFeedback: boolean;
  };
  decisions: { action: CostPolicyAction; status: 'off' | 'advisory' | 'blocked' | 'automatic'; reason: string }[];
}

export function assessCostPolicy(value: unknown, context: CostPolicyContext): CostPolicyAssessment {
  const workspace = validateCostPolicy(value);
  if (!['native-copilot', 'owned-chat', 'external-tools'].includes(context.host) ||
    !['workspace', 'task'].includes(context.scope)) throw new Error('Invalid cost policy context');
  if (context.automaticExecutors !== undefined && typeof context.automaticExecutors !== 'boolean') throw new Error('Invalid automatic executor capability');
  if (context.taskPolicy && context.scope !== 'task') throw new Error('A task policy requires task scope');
  if (context.profile !== undefined && !isCompressionProfile(context.profile)) throw new Error('Invalid policy profile');
  const task = context.taskPolicy === undefined ? undefined : validateCostPolicy(context.taskPolicy);
  const constraints = validateConstraints(context.constraints);
  const pinned = context.pinnedModel === undefined ? undefined : validateCostPolicy({
    version: 1, mode: 'off', allowedModels: [context.pinnedModel],
  }).allowedModels[0];
  const requested = task ?? workspace;
  const disabled = workspace.mode === 'off' || requested.mode === 'off';
  const recommendOnly = workspace.mode === 'recommend-only' || requested.mode === 'recommend-only';
  const { models, profiles, compressionFeedback } = costPolicyPermissions(workspace, context);
  const automaticAvailable = context.host === 'owned-chat' && context.scope === 'task' && context.automaticExecutors === true;
  const automatic = !disabled && !recommendOnly && automaticAvailable && constraints.allowAutomation !== false;
  const capabilities = {
    toolOutputCompression: true as const, ownedModelRequests: context.host === 'owned-chat',
    automaticModelSelection: automaticAvailable, budgetEnforcement: automaticAvailable, adaptiveCompression: automaticAvailable,
    adaptiveCompressionFeedback: automatic && compressionFeedback.enabled && profiles.length > 1,
  };
  const decisions: CostPolicyAssessment['decisions'] = (['select-model', 'change-compression', 'enforce-budget'] as const).map((action) => {
    if (disabled) return { action, status: 'off', reason: 'Cost policy is off; existing behavior is unchanged.' };
    if (action === 'select-model' && pinned) return {
      action, status: 'blocked', reason: includesModel(models, pinned)
        ? 'User-pinned model is retained; no substitute was selected.'
        : 'User-pinned model conflicts with the permitted model set; no substitute was selected.',
    };
    if (action === 'select-model' && models.length === 0) return {
      action, status: 'blocked', reason: 'No model is permitted by the workspace, task, and managed constraints.',
    };
    if (action === 'change-compression' && (profiles.length === 0 || (!automatic && context.profile && !profiles.includes(context.profile)))) return {
      action, status: 'blocked', reason: 'The current compression profile is not permitted; no profile was changed.',
    };
    if (action === 'enforce-budget' && task && task.budgetUnit !== workspace.budgetUnit) return {
      action, status: 'blocked', reason: 'Task and workspace budget units conflict; no budget was enforced.',
    };
    if (constraints.allowAutomation === false) return {
      action, status: 'advisory', reason: 'Managed constraints prohibit automatic actions.',
    };
    if (recommendOnly) return { action, status: 'advisory', reason: 'Recommend-only policy; no automatic action is permitted.' };
    if (!capabilities.ownedModelRequests) return {
      action, status: 'advisory', reason: 'This host does not own the model request; automatic actions are unavailable.',
    };
    if (automatic) return {
      action, status: 'automatic', reason: action === 'enforce-budget'
        ? 'Owned-call admission uses conservative local allowances, not a guaranteed billing cap.'
        : 'Automatic action is limited to this owned task and its permitted choices.',
    };
    return { action, status: 'advisory', reason: 'The request is owned, but this automatic executor is not implemented.' };
  });
  const limits = [workspace.taskBudget, task?.taskBudget].filter((limit): limit is number => limit !== undefined);
  return {
    policyVersion: 1,
    policyRevision: createHash('sha256').update(JSON.stringify({ workspace, task, constraints })).digest('hex'),
    requestedMode: requested.mode, effectiveMode: disabled ? 'off' : automatic ? 'automatic-owned-request' : 'recommend-only',
    host: context.host, scope: context.scope, budgetUnit: workspace.budgetUnit, coverage: 'not-measured',
    taskBudget: disabled || (task && task.budgetUnit !== workspace.budgetUnit) || !limits.length ? null : Math.min(...limits),
    capabilities, decisions,
  };
}

function includesModel(models: readonly PolicyModel[], selected: PolicyModel): boolean {
  return models.some((model) => model.vendor === selected.vendor && model.id === selected.id);
}

function validateConstraints(value: CostPolicyConstraints | undefined): CostPolicyConstraints {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some((key) => !['allowAutomation', 'allowedModels', 'allowedCompressionProfiles'].includes(key)) ||
    (value.allowAutomation !== undefined && typeof value.allowAutomation !== 'boolean')) throw new Error('Invalid managed cost policy constraints');
  const validated = validateCostPolicy({
    version: 1, mode: 'off', allowedModels: value.allowedModels,
    allowedCompressionProfiles: value.allowedCompressionProfiles?.length === 0 ? ['balanced'] : value.allowedCompressionProfiles,
  });
  return {
    allowAutomation: value.allowAutomation,
    allowedModels: value.allowedModels === undefined ? undefined : validated.allowedModels,
    allowedCompressionProfiles: value.allowedCompressionProfiles === undefined ? undefined
      : value.allowedCompressionProfiles.length === 0 ? [] : validated.allowedCompressionProfiles,
  };
}