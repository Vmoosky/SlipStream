import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isCompressionProfile, type CompressionProfile } from './compressionProfiles.js';
import { choosePolicyProfile } from './ownedPolicy.js';
import { SavingsLedger } from './savingsLedger.js';
import type { LedgerEntry } from './types.js';

export interface NativeChatCheck {
  kind: 'test' | 'build';
  command: string;
  args: string[];
  cwd?: string;
}

export interface NativeChatPolicy {
  version: 1;
  mode: 'off' | 'observe' | 'guard';
  tokenLimit?: number;
  compressionProfiles: CompressionProfile[];
  checks: NativeChatCheck[];
}

export interface NativeChatEvent {
  event: 'check' | 'recovery' | 'policy';
  sessionId: string;
  policyRevision: string;
  toolCallId?: string;
  checkKey?: string;
  checkKind?: 'test' | 'build';
  outcome?: 'pass' | 'fail' | 'cancelled' | 'timeout' | 'error';
  exitCode?: number | null;
  durationMs?: number;
  state?: 'observing' | 'active' | 'paused';
  reason?: 'observed-limit' | 'recovery-failure';
  profile?: CompressionProfile;
  observedTokens?: number | null;
}

export interface NativeToolContext {
  version: 1;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  workspaceKey: string;
  inputHash: string;
  policyRevision: string;
  createdAt: number;
  checkKey?: string;
  checkKind?: 'test' | 'build';
}

export const NATIVE_TOOL_NAMES = ['slipstream_runCommand', 'slipstream_readFile', 'slipstream_retrieveArtifact', 'slipstream_getSavings'] as const;
const CONTEXT_TTL_MS = 15 * 60_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native chat settings must be an object.');
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Unknown native chat setting.');
}

export function isNativeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function validateNativeChatPolicy(value?: unknown): NativeChatPolicy {
  const input = value === undefined ? { version: 1, mode: 'off' } : object(value);
  onlyKeys(input, ['version', 'mode', 'tokenLimit', 'compressionProfiles', 'checks']);
  if (input.version !== 1 || typeof input.mode !== 'string' || !['off', 'observe', 'guard'].includes(input.mode)) throw new Error('Invalid native chat mode or version.');
  if (input.tokenLimit !== undefined && (!Number.isSafeInteger(input.tokenLimit) || (input.tokenLimit as number) < 0)) throw new Error('Native conversation token limit must be a nonnegative integer.');
  const profiles = input.compressionProfiles === undefined ? ['conservative', 'balanced', 'aggressive'] : input.compressionProfiles;
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 3 || !profiles.every(isCompressionProfile)
    || new Set(profiles).size !== profiles.length) throw new Error('Choose distinct native compression profiles.');
  const checks = input.checks === undefined ? [] : input.checks;
  if (!Array.isArray(checks) || checks.length > 32) throw new Error('Native checks must be an array of at most 32 commands.');
  const normalizedChecks = checks.map((value): NativeChatCheck => {
    const check = object(value);
    onlyKeys(check, ['kind', 'command', 'args', 'cwd']);
    if (check.kind !== 'test' && check.kind !== 'build') throw new Error('Native check kind must be test or build.');
    if (typeof check.command !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(check.command)) throw new Error('Native checks require a bare executable, not a shell command.');
    const args = check.args === undefined ? [] : check.args;
    if (!Array.isArray(args) || args.length > 128 || !args.every((arg) => typeof arg === 'string' && arg.length <= 2048)) throw new Error('Invalid native check arguments.');
    if (check.cwd !== undefined && (typeof check.cwd !== 'string' || !check.cwd.length || check.cwd.length > 4096)) throw new Error('Invalid native check working directory.');
    return { kind: check.kind, command: check.command, args: [...args], ...(check.cwd !== undefined ? { cwd: check.cwd as string } : {}) };
  });
  const result: NativeChatPolicy = { version: 1, mode: input.mode as NativeChatPolicy['mode'], compressionProfiles: [...profiles], checks: normalizedChecks,
    ...(input.tokenLimit !== undefined ? { tokenLimit: input.tokenLimit as number } : {}) };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 8192) throw new Error('Native chat settings exceed 8 KiB.');
  return result;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function nativePolicyRevision(policy: NativeChatPolicy): string {
  return hash(validateNativeChatPolicy(policy));
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function nativeCommandKey(value: unknown, workspaceRoot: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.command !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.command)) return undefined;
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return undefined;
  if (input.cwd !== undefined && typeof input.cwd !== 'string') return undefined;
  return hash({ command: input.command, args, cwd: normalizedPath(path.resolve(workspaceRoot, input.cwd as string ?? '.')) });
}

function inputHash(value: unknown): string {
  const input = object(value);
  const keys = Object.keys(input).filter((key) => key !== 'nativeContext' && input[key] !== undefined).sort();
  const encoded = JSON.stringify(Object.fromEntries(keys.map((key) => [key, input[key]])));
  if (encoded.length > 65_536) throw new Error('Native tool input is too large.');
  return hash(encoded);
}

export class NativeContextStore {
  private readonly directory: string;
  private readonly workspaceKey: string;

  constructor(storageDir: string, private readonly workspaceRoot: string, private readonly now: () => number = Date.now) {
    this.workspaceKey = hash(normalizedPath(workspaceRoot));
    this.directory = path.join(storageDir, 'native-contexts', this.workspaceKey);
  }

  issue(sessionId: string, toolCallId: string, toolName: string, input: unknown, policy: NativeChatPolicy): string {
    if (!isNativeIdentifier(sessionId) || !isNativeIdentifier(toolCallId) || !NATIVE_TOOL_NAMES.includes(toolName as typeof NATIVE_TOOL_NAMES[number]) || policy.mode === 'off') throw new Error('Native tool context requires an enabled policy and exact host identifiers.');
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const pending = fs.readdirSync(this.directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    for (const name of pending) {
      try {
        const filename = path.join(this.directory, name);
        if (this.now() - fs.statSync(filename).mtimeMs > CONTEXT_TTL_MS) fs.unlinkSync(filename);
      } catch {}
    }
    if (fs.readdirSync(this.directory).length >= 256) throw new Error('Too many pending native tool approvals.');
    const checkKey = toolName === 'slipstream_runCommand' ? nativeCommandKey(input, this.workspaceRoot) : undefined;
    const check = checkKey ? policy.checks.find((candidate) => nativeCommandKey(candidate, this.workspaceRoot) === checkKey) : undefined;
    const context: NativeToolContext = { version: 1, sessionId, toolCallId, toolName, workspaceKey: this.workspaceKey,
      inputHash: inputHash(input), policyRevision: nativePolicyRevision(policy), createdAt: this.now(),
      ...(check ? { checkKey, checkKind: check.kind } : {}) };
    const token = randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(this.directory, `${token}.json`), JSON.stringify(context), { flag: 'wx', mode: 0o600 });
    return token;
  }

  claim(token: unknown, toolName: string, input: unknown, policy: NativeChatPolicy): NativeToolContext {
    const message = 'Native chat context is missing, expired, already used, or changed. Retry the tool after reviewing the policy.';
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || policy.mode === 'off') throw new Error(message);
    const filename = path.join(this.directory, `${token}.json`);
    const claimed = `${filename}.${randomBytes(8).toString('hex')}.claimed`;
    try {
      fs.renameSync(filename, claimed);
      if (fs.statSync(claimed).size > 4096) throw new Error(message);
      const context = JSON.parse(fs.readFileSync(claimed, 'utf8')) as NativeToolContext;
      if (context.version !== 1 || context.workspaceKey !== this.workspaceKey || !isNativeIdentifier(context.sessionId)
        || !isNativeIdentifier(context.toolCallId) || context.toolName !== toolName || context.inputHash !== inputHash(input)
        || context.policyRevision !== nativePolicyRevision(policy) || !Number.isFinite(context.createdAt)
        || context.createdAt > this.now() || this.now() - context.createdAt > CONTEXT_TTL_MS) throw new Error(message);
      return context;
    } catch {
      throw new Error(message);
    } finally {
      try { fs.unlinkSync(claimed); } catch {}
    }
  }
}

export function recordNativeEvent(ledger: SavingsLedger, workspaceRoot: string, event: NativeChatEvent, now = Date.now()): void {
  const prior = ledger.all();
  if (event.toolCallId && prior.some((entry) => entry.workspaceRoot === workspaceRoot && entry.nativeChat?.sessionId === event.sessionId
    && entry.nativeChat.event === event.event && entry.nativeChat.toolCallId === event.toolCallId)) return;
  ledger.record({ ts: now, sessionId: `vscode-chat:${event.sessionId}`, sessionLabel: `VS Code chat: ${path.basename(workspaceRoot)}`,
    workspaceRoot, workspaceLabel: path.basename(workspaceRoot), nativeChat: event, tool: 'session',
    label: event.event === 'check' ? `Native ${event.checkKind} check: ${event.outcome}` : 'Native chat policy',
    strategy: `session:native-${event.event}`, outcomeReason: 'Session event',
    tokensBefore: 0, tokensAfter: 0, bytesBefore: 0, bytesAfter: 0, linesBefore: 0, linesAfter: 0, durationMs: 0 });
}

export function recordNativeCheck(ledger: SavingsLedger, workspaceRoot: string, context: NativeToolContext,
  result: { exitCode: number | null; durationMs: number; timedOut?: boolean; cancelled?: boolean; error?: boolean }): boolean {
  if (!context.checkKey || !context.checkKind) return false;
  const completed = !result.timedOut && !result.cancelled && !result.error && Number.isSafeInteger(result.exitCode);
  const outcome = result.cancelled ? 'cancelled' : result.timedOut ? 'timeout' : !completed ? 'error' : result.exitCode === 0 ? 'pass' : 'fail';
  recordNativeEvent(ledger, workspaceRoot, { event: 'check', sessionId: context.sessionId, toolCallId: context.toolCallId,
    policyRevision: context.policyRevision, checkKey: context.checkKey, checkKind: context.checkKind, outcome,
    exitCode: completed ? result.exitCode : null, durationMs: Math.max(0, Math.round(result.durationMs)) });
  return true;
}

export interface NativeChatStatus {
  state: 'off' | 'observing' | 'active' | 'paused';
  reason?: 'observed-limit' | 'recovery-failure';
  observedTokens: number | null;
  usage: 'unknown' | 'partial' | 'reported';
  profile: CompressionProfile;
  passed: number;
  failed: number;
  incomplete: number;
}

export function nativeChatStatus(entries: readonly LedgerEntry[], workspaceRoot: string, sessionId: string,
  policy: NativeChatPolicy, currentProfile: CompressionProfile): NativeChatStatus {
  const observations = new Map<string, NonNullable<LedgerEntry['modelObservation']>>();
  for (const entry of entries) {
    const observation = entry.modelObservation;
    if (observation && (observation.chatSessionId ?? observation.conversationId) === sessionId) observations.set(`${observation.traceId}:${observation.spanId}`, observation);
  }
  let total = 0;
  let known = false;
  let complete = observations.size > 0;
  for (const observation of observations.values()) {
    for (const count of [observation.inputTokens, observation.outputTokens]) {
      if (Number.isSafeInteger(count) && count! >= 0) { total = Math.min(Number.MAX_SAFE_INTEGER, total + count!); known = true; }
      else complete = false;
    }
  }
  const revision = nativePolicyRevision(policy);
  const events = entries.filter((entry) => entry.workspaceRoot === workspaceRoot && entry.nativeChat?.sessionId === sessionId).map((entry) => entry.nativeChat!);
  const checks = events.filter((event) => event.event === 'check');
  const recovery = events.filter((event) => event.event === 'recovery' && event.policyRevision === revision);
  const exceeded = policy.tokenLimit !== undefined && (policy.tokenLimit === 0 || known && total >= policy.tokenLimit);
  const paused = policy.mode === 'guard' && (exceeded || recovery.filter((event) => event.outcome === 'fail').length > 1
    || events.some((event) => event.event === 'policy' && event.state === 'paused' && event.policyRevision === revision));
  const reason = exceeded ? 'observed-limit' : recovery.filter((event) => event.outcome === 'fail').length > 1 ? 'recovery-failure'
    : events.slice().reverse().find((event) => event.event === 'policy' && event.state === 'paused' && event.policyRevision === revision)?.reason;
  return { state: policy.mode === 'off' ? 'off' : paused ? 'paused' : policy.mode === 'observe' ? 'observing' : 'active',
    ...(reason ? { reason } : {}), observedTokens: known ? total : null, usage: !known ? 'unknown' : complete ? 'reported' : 'partial',
    profile: policy.mode === 'guard' ? choosePolicyProfile(currentProfile, policy.compressionProfiles,
      policy.tokenLimit ? total / policy.tokenLimit : 0, recovery.length > 0) : currentProfile,
    passed: checks.filter((event) => event.outcome === 'pass').length,
    failed: checks.filter((event) => event.outcome === 'fail').length,
    incomplete: checks.filter((event) => event.outcome !== 'pass' && event.outcome !== 'fail').length };
}

export function nativeChatMessage(status: NativeChatStatus, policy: NativeChatPolicy): string {
  const usage = status.observedTokens === null ? 'unknown' : `${status.observedTokens}${status.usage === 'partial' ? ' (partial)' : ''}`;
  const reason = status.reason === 'observed-limit' ? ' Observed token limit reached.' : status.reason === 'recovery-failure' ? ' Repeated retrieval failures.' : '';
  return `Slipstream native chat: ${status.state}.${reason} Reported tokens: ${usage}${policy.tokenLimit !== undefined ? ` / ${policy.tokenLimit}` : ''}.`
    + ` Compression: ${status.profile}. Checks: ${status.passed} passed, ${status.failed} failed, ${status.incomplete} incomplete.`
    + ' Model selection remains with Copilot. Usage can arrive late; this is not a billing cap.';
}