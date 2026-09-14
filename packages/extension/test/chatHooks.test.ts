import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeContextStore, validateNativeChatPolicy } from '@slipstream/core';
import { chatHookPath, createChatHookConfig, disableChatHooks, enableChatHooks, synchronizeChatHooks } from '../src/chatHooks.js';

let root: string;
let runtime: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-chat-hooks-'));
  runtime = path.join(root, 'extension with spaces', 'chat-hook.js');
  fs.mkdirSync(path.dirname(runtime));
  fs.writeFileSync(runtime, '');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('workspace chat hook installation', () => {
  it('runs native guards and context handoff through the bundled hook executable', () => {
    const bundle = path.resolve(__dirname, '..', 'dist', 'chat-hook.js');
    const store = path.join(root, 'native-policy-store');
    const policy = validateNativeChatPolicy({ version: 1, mode: 'guard', tokenLimit: 1000, checks: [{ kind: 'test', command: 'npm', args: ['test'] }] });
    const config = createChatHookConfig(root, bundle, store, { policy, profile: 'balanced' });
    const hook = config.hooks.PreToolUse![0];
    const run = (input: string) => spawnSync(hook.command, { shell: true, cwd: hook.cwd, env: { ...process.env, ...hook.env }, input, encoding: 'utf8', timeout: 10_000 });
    const input = { command: 'npm', args: ['test'] };
    const output = run(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'native', tool_use_id: 'host-tool-call', tool_name: 'slipstream_runCommand', tool_input: input }));
    expect(output.status, output.stderr).toBe(0);
    const response = JSON.parse(output.stdout);
    expect(response.continue).toBeUndefined();
    expect(response.hookSpecificOutput.permissionDecision).toBeUndefined();
    const updated = response.hookSpecificOutput.updatedInput;
    expect(new NativeContextStore(store, root).claim(updated.nativeContext, 'slipstream_runCommand', updated, policy)).toMatchObject({ sessionId: 'native', toolCallId: 'host-tool-call', checkKind: 'test' });
    const malformed = run('private malformed input');
    expect(malformed.status).toBe(0);
    expect(JSON.parse(malformed.stdout)).toMatchObject({ continue: false });
    expect(malformed.stderr).not.toContain('private malformed input');
    const stop = run(JSON.stringify({ hook_event_name: 'Stop', session_id: 'native', stop_hook_active: true }));
    expect(JSON.parse(stop.stdout).systemMessage).toContain('Checks: 0 passed');
    expect(JSON.parse(stop.stdout).hookSpecificOutput).toBeUndefined();
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    expect(manifest.contributes.configuration.properties['slipstream.nativeChatPolicy'].default.mode).toBe('off');
    expect(manifest.contributes.languageModelTools.every((tool: { inputSchema: { properties: Record<string, unknown> } }) => tool.inputSchema.properties.nativeContext)).toBe(true);
  });

  it('adds native policy lifecycle hooks only after opt-in and can restore legacy activity-only hooks', () => {
    const state = { trusted: true, enabled: true, available: true };
    synchronizeChatHooks(root, runtime, root, state);
    const legacy = fs.readFileSync(chatHookPath(root), 'utf8');
    const native = { policy: validateNativeChatPolicy({ version: 1, mode: 'guard', tokenLimit: 1000 }), profile: 'balanced' as const };
    expect(synchronizeChatHooks(root, runtime, root, { ...state, native })).toBe(true);
    const config = JSON.parse(fs.readFileSync(chatHookPath(root), 'utf8'));
    expect(Object.keys(config.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    expect(JSON.parse(config.hooks.PreToolUse[0].env.SLIPSTREAM_NATIVE_POLICY)).toEqual(native.policy);
    expect(config.hooks.PreToolUse[0].command).toBe('node chat-hook.js vscode');
    expect(synchronizeChatHooks(root, runtime, root, { ...state, native })).toBe(false);
    expect(synchronizeChatHooks(root, runtime, root, state)).toBe(true);
    expect(fs.readFileSync(chatHookPath(root), 'utf8')).toBe(legacy);
  });

  it('preserves a user-edited native policy hook instead of changing its restrictions', () => {
    const native = { policy: validateNativeChatPolicy({ version: 1, mode: 'observe' }), profile: 'balanced' as const };
    enableChatHooks(root, runtime, root, false, native);
    const changed = JSON.parse(fs.readFileSync(chatHookPath(root), 'utf8'));
    changed.hooks.PreToolUse[0].env.SLIPSTREAM_NATIVE_POLICY = JSON.stringify({ ...native.policy, mode: 'guard' });
    const raw = JSON.stringify(changed);
    fs.writeFileSync(chatHookPath(root), raw);
    expect(() => enableChatHooks(root, runtime, root, false, native)).toThrow('left unchanged');
    expect(() => disableChatHooks(root)).toThrow('left unchanged');
    expect(fs.readFileSync(chatHookPath(root), 'utf8')).toBe(raw);
  });

  it('automatically installs for a trusted workspace and respects a persistent opt-out', () => {
    const state = { trusted: true, enabled: true, available: true };
    expect(synchronizeChatHooks(root, runtime, root, state)).toBe(true);
    expect(fs.existsSync(chatHookPath(root))).toBe(true);
    expect(synchronizeChatHooks(root, runtime, root, state)).toBe(false);
    const disabled = { ...state, enabled: false };
    expect(synchronizeChatHooks(root, runtime, root, disabled)).toBe(true);
    expect(synchronizeChatHooks(root, runtime, root, disabled)).toBe(false);
    expect(fs.existsSync(chatHookPath(root))).toBe(false);
    expect(synchronizeChatHooks(root, runtime, root, state)).toBe(true);
  });

  it('honors hook opt-out without validating disabled native settings', () => {
    enableChatHooks(root, runtime, root);
    expect(synchronizeChatHooks(root, runtime, root, { trusted: true, enabled: false, available: true,
      native: { policy: null as never, profile: 'balanced' } })).toBe(true);
    expect(fs.existsSync(chatHookPath(root))).toBe(false);
  });

  it.each([
    ['untrusted', { trusted: false, enabled: true, available: true }],
    ['disabled', { trusted: true, enabled: false, available: true }],
    ['unavailable', { trusted: true, enabled: true, available: false }],
  ])('does not create hooks when %s', (_reason, state) => {
    expect(synchronizeChatHooks(root, runtime, root, state)).toBe(false);
    expect(fs.existsSync(chatHookPath(root))).toBe(false);
  });

  it('uses native event names and keeps paths out of shell commands', () => {
    const config = createChatHookConfig(root, runtime, path.join(root, 'store'));
    expect(Object.keys(config.hooks)).toEqual(['UserPromptSubmit', 'PostToolUse']);
    expect(config.hooks.UserPromptSubmit[0]).toMatchObject({ command: 'node chat-hook.js vscode', cwd: path.dirname(runtime), timeout: 10 });
    expect(config.hooks.PostToolUse[0].env.SLIPSTREAM_WORKSPACE_ROOT).toBe(root);
  });

  it('is opt-in and idempotent, updates its own config, and leaves unrelated hooks intact', () => {
    const store = path.join(root, 'store');
    expect(enableChatHooks(root, runtime, store, true)).toBe(false);
    expect(fs.existsSync(chatHookPath(root))).toBe(false);
    expect(enableChatHooks(root, runtime, store)).toBe(true);
    expect(enableChatHooks(root, runtime, store)).toBe(false);
    const other = path.join(path.dirname(chatHookPath(root)), 'other.json');
    fs.writeFileSync(other, '{"hooks":{}}');
    const nextStore = path.join(root, 'another-store');
    expect(enableChatHooks(root, runtime, nextStore, true)).toBe(true);
    expect(JSON.parse(fs.readFileSync(chatHookPath(root), 'utf8')).hooks.UserPromptSubmit[0].env.SLIPSTREAM_STORAGE_DIR).toBe(nextStore);
    expect(disableChatHooks(root)).toBe(true);
    expect(disableChatHooks(root)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('{"hooks":{}}');
  });

  it('never overwrites or deletes user-modified hook configurations', () => {
    enableChatHooks(root, runtime, root);
    const changed = JSON.parse(fs.readFileSync(chatHookPath(root), 'utf8'));
    changed.hooks.PostToolUse[0].command = 'custom-command';
    const raw = JSON.stringify(changed);
    fs.writeFileSync(chatHookPath(root), raw);
    expect(() => enableChatHooks(root, runtime, root)).toThrow('left unchanged');
    expect(() => disableChatHooks(root)).toThrow('left unchanged');
    expect(fs.readFileSync(chatHookPath(root), 'utf8')).toBe(raw);
  });

  it('preserves edited paths even when the command itself is unchanged', () => {
    enableChatHooks(root, runtime, root);
    const changed = JSON.parse(fs.readFileSync(chatHookPath(root), 'utf8'));
    for (const hooks of Object.values(changed.hooks) as { env: Record<string, string> }[][]) {
      hooks[0].env.SLIPSTREAM_STORAGE_DIR = path.join(root, 'custom');
    }
    fs.writeFileSync(chatHookPath(root), JSON.stringify(changed));
    expect(() => enableChatHooks(root, runtime, root, true)).toThrow('left unchanged');
  });

  it('runs the bundled native hook from the generated manifest and fails open', () => {
    const bundle = path.resolve(__dirname, '..', 'dist', 'chat-hook.js');
    const store = path.join(root, 'native-store');
    const config = createChatHookConfig(root, bundle, store);
    const hook = config.hooks.UserPromptSubmit[0];
    const run = (input: string, workspaceRoot = root) => spawnSync(hook.command, {
      shell: true, cwd: hook.cwd, env: { ...process.env, ...hook.env, SLIPSTREAM_WORKSPACE_ROOT: workspaceRoot }, input, encoding: 'utf8', timeout: 10_000,
    });
    const common = { session_id: 'native', cwd: hook.cwd };
    const chat = run(JSON.stringify({ ...common, hook_event_name: 'UserPromptSubmit', prompt: 'private prompt' }));
    expect(chat.status, chat.stderr).toBe(0);
    expect(chat.stdout).toBe('{}');
    const tool = run(JSON.stringify({ ...common, hook_event_name: 'PostToolUse', tool_name: 'read_file', tool_response: 'private output' }));
    expect(tool.status, tool.stderr).toBe(0);
    expect(tool.stdout).toBe('{}');
    const raw = fs.readFileSync(path.join(store, 'savings.jsonl'), 'utf8');
    expect(raw).not.toContain('private');
    const entries = raw.trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.strategy)).toEqual(['session:chat', 'session:tool-observed']);
    expect(entries.every((entry) => entry.workspaceRoot === root && entry.tokensBefore === 0 && entry.tokensAfter === 0)).toBe(true);
    expect(entries.every((entry) => entry.workspaceLabel === path.basename(root) && entry.sessionLabel === `VS Code chat: ${path.basename(root)}`)).toBe(true);
    const secondRoot = path.join(root, 'second-workspace');
    for (const workspaceRoot of [secondRoot, '']) {
      const result = run(JSON.stringify({ ...common, hook_event_name: 'UserPromptSubmit' }), workspaceRoot);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('{}');
    }
    const updated = fs.readFileSync(path.join(store, 'savings.jsonl'), 'utf8');
    expect(updated.startsWith(raw)).toBe(true);
    const latest = updated.trim().split('\n').map((line) => JSON.parse(line)).slice(-2);
    expect(latest[0]).toMatchObject({ workspaceRoot: secondRoot, workspaceLabel: 'second-workspace', sessionLabel: 'VS Code chat: second-workspace' });
    expect(latest[1]).toMatchObject({ workspaceLabel: 'Unknown workspace', sessionLabel: 'VS Code chat: Unknown workspace' });
    expect(latest[1].workspaceRoot).toBeUndefined();
    const malformed = run('not-json');
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe('{}');
    expect(fs.readFileSync(path.join(store, 'savings.jsonl'), 'utf8')).toBe(updated);
  });
});