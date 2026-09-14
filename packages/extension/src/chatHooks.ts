import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isCompressionProfile, validateNativeChatPolicy, type CompressionProfile, type NativeChatPolicy } from '@slipstream/core';

export const CHAT_HOOK_FILENAME = 'slipstream-activity.json';

export interface NativeHookSettings {
  policy: NativeChatPolicy;
  profile: CompressionProfile;
}

export function createChatHookConfig(workspaceRoot: string, runtimePath: string, storageDir: string, native?: NativeHookSettings) {
  const runtimeDir = path.resolve(path.dirname(runtimePath));
  const policy = validateNativeChatPolicy(native?.policy);
  if (native && !isCompressionProfile(native.profile)) throw new Error('Invalid native compression profile.');
  const active = policy.mode !== 'off' ? { policy, profile: native!.profile } : undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify([workspaceRoot, runtimeDir, storageDir, ...(active ? [active] : [])])).digest('hex');
  const hook = () => ({
    type: 'command',
    command: 'node chat-hook.js vscode',
    cwd: runtimeDir,
    timeout: 10,
    env: {
      SLIPSTREAM_STORAGE_DIR: storageDir,
      SLIPSTREAM_WORKSPACE_ROOT: workspaceRoot,
      SLIPSTREAM_ACTIVITY_CONFIG: fingerprint,
      ...(active ? { SLIPSTREAM_NATIVE_POLICY: JSON.stringify(active.policy), SLIPSTREAM_NATIVE_PROFILE: active.profile } : {}),
    },
  });
  return { hooks: { ...(active ? { SessionStart: [hook()], PreToolUse: [hook()], Stop: [hook()] } : {}),
    UserPromptSubmit: [hook()], PostToolUse: [hook()] } };
}

function isManagedConfig(value: unknown): boolean {
  const config = value as ReturnType<typeof createChatHookConfig> | undefined;
  const hook = config?.hooks?.UserPromptSubmit?.[0];
  if (typeof hook?.cwd !== 'string' || typeof hook.env?.SLIPSTREAM_STORAGE_DIR !== 'string' || typeof hook.env?.SLIPSTREAM_WORKSPACE_ROOT !== 'string') return false;
  const native = hook.env.SLIPSTREAM_NATIVE_POLICY !== undefined
    ? { policy: validateNativeChatPolicy(JSON.parse(hook.env.SLIPSTREAM_NATIVE_POLICY)), profile: hook.env.SLIPSTREAM_NATIVE_PROFILE! } : undefined;
  return isDeepStrictEqual(value, createChatHookConfig(hook.env.SLIPSTREAM_WORKSPACE_ROOT, path.join(hook.cwd, 'chat-hook.js'), hook.env.SLIPSTREAM_STORAGE_DIR, native));
}

export function chatHookPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.github', 'hooks', CHAT_HOOK_FILENAME);
}

function readManagedConfig(workspaceRoot: string): string | undefined {
  for (const candidate of [path.join(workspaceRoot, '.github'), path.join(workspaceRoot, '.github', 'hooks'), chatHookPath(workspaceRoot)]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('Chat hook paths must not be symbolic links.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let raw: string;
  try { raw = fs.readFileSync(chatHookPath(workspaceRoot), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let managed = false;
  try { managed = isManagedConfig(JSON.parse(raw)); } catch { }
  if (!managed) throw new Error(`${CHAT_HOOK_FILENAME} already exists and was edited or is not managed by Slipstream. It was left unchanged.`);
  return raw;
}

export function enableChatHooks(workspaceRoot: string, runtimePath: string, storageDir: string, onlyIfEnabled = false, native?: NativeHookSettings): boolean {
  const current = readManagedConfig(workspaceRoot);
  if (onlyIfEnabled && current === undefined) return false;
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(runtimePath) || !path.isAbsolute(storageDir)) throw new Error('Chat hook paths must be absolute.');
  if (path.basename(runtimePath) !== 'chat-hook.js' || !fs.statSync(runtimePath).isFile()) throw new Error('The bundled chat hook is missing. Rebuild or reinstall Slipstream.');
  const next = JSON.stringify(createChatHookConfig(workspaceRoot, runtimePath, storageDir, native), null, 2) + '\n';
  if (current === next) return false;
  const filePath = chatHookPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } finally { fs.rmSync(temporary, { force: true }); }
  return true;
}

export function disableChatHooks(workspaceRoot: string): boolean {
  if (readManagedConfig(workspaceRoot) === undefined) return false;
  fs.unlinkSync(chatHookPath(workspaceRoot));
  return true;
}

export function synchronizeChatHooks(
  workspaceRoot: string,
  runtimePath: string,
  storageDir: string,
  state: { trusted: boolean; enabled: boolean; available: boolean; native?: NativeHookSettings },
): boolean {
  if (!state.trusted) return false;
  if (!state.enabled) return disableChatHooks(workspaceRoot);
  if (!state.available) return false;
  return enableChatHooks(workspaceRoot, runtimePath, storageDir, false, state.native);
}