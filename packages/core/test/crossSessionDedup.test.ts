import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactStore } from '../src/artifactStore.js';
import { CrossTurnDedup } from '../src/compressors/crossTurnDedup.js';
import { PersistentDedupIndex } from '../src/compressors/persistentDedupIndex.js';
import { CompressionEngine } from '../src/engine.js';

let rootDir: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-xsession-'));
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** A distinctive multi-line block, long enough to clear the dedup thresholds. */
function block(): string[] {
  return [
    'ERROR failed to connect to database at db.internal:5432 after 3 retries',
    'ERROR   caused by: ETIMEDOUT connecting to 10.0.0.5:5432 within 5000ms',
    'ERROR   at Connection.connect (src/db/connection.ts:88:14)',
    'ERROR   at async Pool.acquire (src/db/pool.ts:42:9)',
  ];
}

/** Load a source's lines straight from the shared artifact store. */
function loaderFor(store: ArtifactStore): (id: string) => string[] | undefined {
  return (id) => {
    const content = store.readContent(id);
    return content === undefined ? undefined : content.split('\n');
  };
}

describe('PersistentDedupIndex', () => {
  it('round-trips seed candidates across separate instances (processes)', () => {
    const lines = block();
    const writer = new PersistentDedupIndex({ rootDir });
    writer.record('aaaaaaaaaaaa', 'run-1', lines);

    // A fresh instance simulates another process/producer starting up.
    const reader = new PersistentDedupIndex({ rootDir });
    const hits = reader.candidates(reader.hash(lines[0]!));
    expect(hits).toEqual([{ id: 'aaaaaaaaaaaa', lineNo: 1 }]);
    expect(reader.label('aaaaaaaaaaaa')).toBe('run-1');
  });

  it('drops sources past their idle TTL', () => {
    const idx = new PersistentDedupIndex({ rootDir, config: { idleTtlMs: -1 } });
    idx.record('aaaaaaaaaaaa', 'stale', block());
    const reader = new PersistentDedupIndex({ rootDir, config: { idleTtlMs: -1 } });
    expect(reader.candidates(reader.hash(block()[0]!))).toHaveLength(0);
  });

  it('bounds retained sources to maxSources, dropping the oldest', () => {
    const idx = new PersistentDedupIndex({ rootDir, config: { maxSources: 2 } });
    idx.record('aaaaaaaaaaaa', 'a', ['first shared distinctive line for source a padding padding']);
    idx.record('bbbbbbbbbbbb', 'b', ['second shared distinctive line for source b padding padding']);
    idx.record('cccccccccccc', 'c', ['third shared distinctive line for source c padding padding']);
    const reader = new PersistentDedupIndex({ rootDir, config: { maxSources: 2 } });
    expect(reader.has('aaaaaaaaaaaa')).toBe(false); // oldest evicted
    expect(reader.has('bbbbbbbbbbbb')).toBe(true);
    expect(reader.has('cccccccccccc')).toBe(true);
  });

  it('clear() wipes the on-disk index', () => {
    const idx = new PersistentDedupIndex({ rootDir });
    idx.record('aaaaaaaaaaaa', 'a', block());
    idx.clear();
    expect(fs.existsSync(path.join(rootDir, 'dedup-index.json'))).toBe(false);
    const reader = new PersistentDedupIndex({ rootDir });
    expect(reader.candidates(reader.hash(block()[0]!))).toHaveLength(0);
  });
});

describe('CrossTurnDedup with persistence', () => {
  it('dedups a run first seen by another engine/process', () => {
    const store = new ArtifactStore({ rootDir });
    const lines = block();
    const artifact = store.put(lines.join('\n'), { label: 'run-1', kind: 'log' });

    // Producer 1 registers the output.
    const first = new CrossTurnDedup(
      {},
      { persistence: new PersistentDedupIndex({ rootDir }), loadSource: loaderFor(store) },
    );
    expect(first.find(lines)).toHaveLength(0); // nothing indexed yet
    first.register(artifact.id, lines, 'run-1');

    // Producer 2 is a brand-new set of objects sharing only the storage dir.
    const second = new CrossTurnDedup(
      {},
      { persistence: new PersistentDedupIndex({ rootDir }), loadSource: loaderFor(store) },
    );
    const matches = second.find(['unrelated preamble line goes here', ...lines]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.sourceArtifactId).toBe(artifact.id);
    expect(matches[0]!.length).toBe(lines.length);
    expect(matches[0]!.sourceLabel).toBe('run-1');
  });

  it('never emits a pointer whose source artifact is gone', () => {
    const store = new ArtifactStore({ rootDir });
    const lines = block();
    const artifact = store.put(lines.join('\n'), { label: 'run-1', kind: 'log' });
    const producer = new PersistentDedupIndex({ rootDir });
    const first = new CrossTurnDedup({}, { persistence: producer, loadSource: loaderFor(store) });
    first.register(artifact.id, lines, 'run-1');

    // The artifact is evicted but the index still references it.
    store.purgeAll();

    const second = new CrossTurnDedup(
      {},
      { persistence: new PersistentDedupIndex({ rootDir }), loadSource: loaderFor(store) },
    );
    expect(second.find(lines)).toHaveLength(0);
  });

  it('detachPersistence stops cross-session dedup after a session reset', () => {
    const store = new ArtifactStore({ rootDir });
    const lines = block();
    const artifact = store.put(lines.join('\n'), { label: 'run-1', kind: 'log' });
    new PersistentDedupIndex({ rootDir }).record(artifact.id, 'run-1', lines);

    const dedup = new CrossTurnDedup(
      {},
      { persistence: new PersistentDedupIndex({ rootDir }), loadSource: loaderFor(store) },
    );
    expect(dedup.find(lines)).toHaveLength(1);
    dedup.reset({ detachPersistence: true });
    expect(dedup.find(lines)).toHaveLength(0);
  });
});

describe('CompressionEngine cross-session dedup', () => {
  function noisyLogWithBlock(): string {
    const noise = Array.from(
      { length: 40 },
      (_, i) => `2024-01-01T00:00:${String(i).padStart(2, '0')}Z INFO worker processed item ${i} ok`,
    );
    return [...noise, ...block()].join('\n');
  }

  it('points a second engine at the first engine\'s stored output', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-ws-'));
    try {
      const log = noisyLogWithBlock();
      const first = new CompressionEngine({ rootDir, workspaceRoots: [workspace] });
      const firstOut = first.compressCommandOutput({
        command: 'npm start',
        cwd: workspace,
        exitCode: 1,
        stdout: log,
        stderr: '',
        durationMs: 1000,
      });
      expect(firstOut.text).not.toContain('repeated from');

      // A separate engine over the same storage dir stands in for another
      // producer (or a later process) seeing the same output.
      const second = new CompressionEngine({ rootDir, workspaceRoots: [workspace] });
      const secondOut = second.compressCommandOutput({
        command: 'npm start',
        cwd: workspace,
        exitCode: 1,
        stdout: log,
        stderr: '',
        durationMs: 1000,
      });
      expect(secondOut.text).toContain('repeated from');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
