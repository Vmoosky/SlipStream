import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CompressionEngine, SavingsLedger } from '@slipstream/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HookSessionManager } from '../src/hook.js';
import type { PostToolUseInput } from '../src/protocol.js';

let storage: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-maint-'));
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

function toolInput(sessionId: string, text = 'hello world'): PostToolUseInput {
  return {
    sessionId,
    timestamp: Date.now(),
    cwd: storage,
    toolName: 'read_file',
    toolArgs: {},
    toolResult: { resultType: 'success', textResultForLlm: text },
  };
}

/** Store a retained artifact on disk under `storage`, independent of any manager. */
function seedArtifact(): void {
  const engine = new CompressionEngine({
    rootDir: storage,
    workspaceRoots: [storage],
    sessionId: 'seed',
    sessionLabel: 'seed',
  });
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n');
  engine.compressFileRead({ path: path.join(storage, 'big.txt'), content: big });
  engine.dispose();
}

describe('CLI reset/purge maintenance', () => {
  it('resetAll forgets seen state on every live session and returns the count', () => {
    const manager = new HookSessionManager(storage);
    manager.process(toolInput('one'));
    manager.process(toolInput('two'));

    expect(manager.resetAll()).toBe(2);

    const strategies = new SavingsLedger({ rootDir: storage }).all().map((entry) => entry.strategy);
    expect(strategies.filter((strategy) => strategy === 'session:reset').length).toBe(2);
    manager.dispose();
  });

  it('resetAll is a no-op count when no session is live', () => {
    const manager = new HookSessionManager(storage);
    expect(manager.resetAll()).toBe(0);
    manager.dispose();
  });

  it('purge deletes stored artifacts even with no live session', () => {
    seedArtifact();

    const manager = new HookSessionManager(storage);
    const { artifacts } = manager.purge();
    expect(artifacts).toBeGreaterThan(0);
    // Everything is gone, so a second purge finds nothing.
    expect(manager.purge().artifacts).toBe(0);
    manager.dispose();
  });

  it('purge routes through a live session and clears artifacts from disk', () => {
    seedArtifact();

    const manager = new HookSessionManager(storage);
    manager.process(toolInput('live'));
    const { artifacts } = manager.purge();
    expect(artifacts).toBeGreaterThan(0);
    expect(manager.purge().artifacts).toBe(0);
    manager.dispose();
  });
});
