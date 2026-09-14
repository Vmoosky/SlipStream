import * as path from 'node:path';

import { isCompressionProfile, isNativeIdentifier, NativeContextStore, NATIVE_TOOL_NAMES, nativeChatMessage, nativeChatStatus,
  nativePolicyRevision, recordNativeEvent, SavingsLedger, validateNativeChatPolicy, type CompressionProfile } from '@slipstream/core';

const EVENTS = {
  SessionStart: { label: 'Conversation started', strategy: 'session:native-start' },
  UserPromptSubmit: { label: 'Chat submitted', strategy: 'session:chat' },
  PreToolUse: { label: 'Tool requested', strategy: 'session:native-tool-start' },
  PostToolUse: { label: 'Tool completed', strategy: 'session:tool-observed' },
  Stop: { label: 'Agent execution stopped', strategy: 'session:native-stop' },
} as const;

export function recordVscodeHook(
  value: unknown,
  options: { storageDir: string; cwd?: string; now?: number },
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('VS Code hook input must be an object.');
  }
  const input = value as Record<string, unknown>;
  const event = input.hook_event_name;
  if (typeof event !== 'string' || !Object.hasOwn(EVENTS, event)) return false;
  const details = EVENTS[event as keyof typeof EVENTS];
  const identity = isNativeIdentifier(input.session_id) ? input.session_id : undefined;
  if (!identity && event !== 'UserPromptSubmit' && event !== 'PostToolUse') return false;

  const toolName = typeof input.tool_name === 'string' ? input.tool_name.trim().slice(0, 256) : '';
  if (event === 'PostToolUse' || event === 'PreToolUse') {
    if (!toolName) throw new Error(`VS Code ${event} input is missing tool_name.`);
    if (toolName.toLowerCase().includes('slipstream')) return false;
  }

  const workspaceRoot = options.cwd && path.isAbsolute(options.cwd) ? options.cwd : undefined;
  const timestamp = typeof input.timestamp === 'string' ? Date.parse(input.timestamp) : NaN;
  const sessionId = identity ? `vscode-chat:${identity}` : undefined;
  const workspaceLabel = workspaceRoot ? path.basename(workspaceRoot) || workspaceRoot : 'Unknown workspace';
  const ledger = new SavingsLedger({ rootDir: options.storageDir });
  ledger.record({
    ts: Number.isFinite(timestamp) ? timestamp : options.now ?? Date.now(),
    sessionId,
    sessionLabel: `VS Code chat: ${workspaceLabel}`,
    workspaceRoot,
    workspaceLabel,
    outcomeReason: 'Session event',
    tool: 'session',
    label: event === 'PostToolUse' ? `Observed tool: ${toolName}` : details.label,
    strategy: details.strategy,
    tokensBefore: 0,
    tokensAfter: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    linesBefore: 0,
    linesAfter: 0,
    durationMs: 0,
  });
  return true;
}

export interface NativeHookOutput {
  continue?: false;
  stopReason?: string;
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: 'PreToolUse'; updatedInput: Record<string, unknown> };
}

export function handleVscodeHook(value: unknown,
  options: { storageDir: string; cwd?: string; now?: number; policy?: unknown; profile?: CompressionProfile }): NativeHookOutput {
  let mode: string | undefined;
  try {
    const policy = validateNativeChatPolicy(options.policy);
    mode = policy.mode;
    recordVscodeHook(value, options);
    if (policy.mode === 'off') return {};
    const input = value as Record<string, unknown>;
    const event = input.hook_event_name;
    if (typeof event !== 'string' || !Object.hasOwn(EVENTS, event)) return {};
    const workspaceRoot = options.cwd;
    const sessionId = input.session_id;
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot) || !isNativeIdentifier(sessionId)) {
      const message = 'Slipstream native policy has no exact conversation or workspace identity. Usage and checks remain unattributed.';
      return policy.mode === 'guard' ? { continue: false, stopReason: message } : { systemMessage: message };
    }
    const ledger = new SavingsLedger({ rootDir: options.storageDir });
    const entries = ledger.all();
    const status = nativeChatStatus(entries, workspaceRoot, sessionId, policy, isCompressionProfile(options.profile) ? options.profile : 'balanced');
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
    const recoveryTool = toolName === 'slipstream_retrieveArtifact' || toolName === 'slipstream_getSavings';
    const revision = nativePolicyRevision(policy);
    const previous = entries.slice().reverse().find((entry) => entry.workspaceRoot === workspaceRoot && entry.nativeChat?.sessionId === sessionId
      && entry.nativeChat.event === 'policy' && entry.nativeChat.policyRevision === revision)?.nativeChat;
    if (status.state !== 'off' && (!previous || previous.state !== status.state || previous.profile !== status.profile || previous.observedTokens !== status.observedTokens)) {
      recordNativeEvent(ledger, workspaceRoot, { event: 'policy', sessionId, policyRevision: revision, state: status.state,
        profile: status.profile, observedTokens: status.observedTokens, ...(status.reason ? { reason: status.reason } : {}) }, options.now);
    }
    const message = nativeChatMessage(status, policy);
    if (status.state === 'paused' && !(event === 'PreToolUse' && recoveryTool) && event !== 'Stop') return { continue: false, stopReason: message, systemMessage: message };
    if (event === 'PreToolUse' && NATIVE_TOOL_NAMES.includes(toolName as typeof NATIVE_TOOL_NAMES[number])) {
      if (!isNativeIdentifier(input.tool_use_id) || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) {
        const warning = 'Slipstream native tool identity is unavailable. Check native hook support before continuing.';
        return policy.mode === 'guard' && !recoveryTool ? { continue: false, stopReason: warning } : { systemMessage: warning };
      }
      const token = new NativeContextStore(options.storageDir, workspaceRoot).issue(sessionId, input.tool_use_id, toolName, input.tool_input, policy);
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, nativeContext: token } },
        ...(previous && previous.profile !== status.profile ? { systemMessage: message } : {}) };
    }
    const check = event === 'PostToolUse' && isNativeIdentifier(input.tool_use_id)
      ? ledger.all().find((entry) => entry.workspaceRoot === workspaceRoot && entry.nativeChat?.event === 'check'
        && entry.nativeChat.sessionId === sessionId && entry.nativeChat.toolCallId === input.tool_use_id)?.nativeChat : undefined;
    if (check) return { systemMessage: `Slipstream designated ${check.checkKind} check: ${check.outcome}. ${message}` };
    if (event === 'SessionStart' || event === 'Stop' || event === 'UserPromptSubmit' || status.reason) return { systemMessage: message };
    return {};
  } catch {
    if (mode === 'off' || options.policy === undefined) return {};
    if (mode === 'observe') return { systemMessage: 'Slipstream native observation is unavailable for this event. No check result or usage was inferred.' };
    return { continue: false, stopReason: 'Slipstream native policy could not be evaluated. Review its settings and hook configuration before retrying.' };
  }
}