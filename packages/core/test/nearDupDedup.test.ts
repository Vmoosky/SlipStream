import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CrossTurnDedup } from '../src/compressors/crossTurnDedup.js';
import { CompressionEngine } from '../src/engine.js';

/** A test run whose lines differ only by per-line timings. */
function testRun(baseMs: number, count = 40): string[] {
  return Array.from(
    { length: count },
    (_, i) => ` PASS test/module${i + 1}.spec.ts  (${i + 1} assertions) completed in ${baseMs + i}ms`,
  );
}

/**
 * A build log whose lines each have a *different* shape. The in-output
 * near-dup compressor folds templated repeats within a single output, so a
 * uniform log would be collapsed before cross-turn dedup ever sees it. Varying
 * the shape per line keeps that pass out of the way, isolating the cross-turn
 * behaviour under test.
 */
const VERBS = ['Resolved', 'Bundled', 'Linked', 'Minified', 'Hashed', 'Copied', 'Emitted', 'Inlined'];
const KINDS = ['chunk', 'asset', 'module', 'sourcemap', 'stylesheet', 'worker', 'polyfill', 'manifest'];
function buildLog(baseMs: number, count = 60): string[] {
  return Array.from({ length: count }, (_, i) =>
    `${VERBS[i % 8]} ${KINDS[(i * 3) % 8]} ${(i * 7).toString(36)}-${'abcdefgh'[i % 8]}${i}`
    + ` -> dist/${KINDS[(i * 5) % 8]}/${i}.${['js', 'css', 'map'][i % 3]} in ${baseMs + i * 3}ms`);
}

describe('cross-turn near-duplicate matching', () => {
  it('matches a non-templated run that only differs by varying numbers', () => {
    const dedup = new CrossTurnDedup();
    dedup.register('a'.repeat(12), buildLog(120), 'npm run build');
    const matches = dedup.find(buildLog(377));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.length).toBe(60);
    expect(matches[0]?.exact).toBe(false);
  });

  it('finds nothing in that same run when near-duplicate matching is off', () => {
    const dedup = new CrossTurnDedup({ nearDup: false });
    dedup.register('a'.repeat(12), buildLog(120), 'npm run build');
    expect(dedup.find(buildLog(377))).toEqual([]);
  });

  it('matches a run that only differs by varying numbers', () => {
    const dedup = new CrossTurnDedup();
    dedup.register('a'.repeat(12), testRun(120), 'npm test (run 1)');
    const matches = dedup.find(testRun(377));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.length).toBe(40);
    expect(matches[0]?.exact).toBe(false);
  });

  it('finds nothing when near-duplicate matching is disabled', () => {
    const dedup = new CrossTurnDedup({ nearDup: false });
    dedup.register('a'.repeat(12), testRun(120), 'npm test (run 1)');
    expect(dedup.find(testRun(377))).toEqual([]);
  });

  it('still reports byte-identical repeats as exact', () => {
    const dedup = new CrossTurnDedup();
    dedup.register('a'.repeat(12), testRun(120), 'npm test (run 1)');
    const matches = dedup.find(testRun(120));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.exact).toBe(true);
  });

  it('prefers an exact match over a longer near match', () => {
    const dedup = new CrossTurnDedup();
    // Same lines indexed twice: once byte-identical, once only near-identical
    // but running longer. The exact run must win despite being shorter.
    dedup.register('a'.repeat(12), testRun(120, 8), 'exact source');
    dedup.register('b'.repeat(12), testRun(999, 40), 'near source');
    const matches = dedup.find(testRun(120, 8));
    expect(matches[0]?.exact).toBe(true);
    expect(matches[0]?.sourceArtifactId).toBe('a'.repeat(12));
  });

  it('holds near matches to a higher line bar than exact ones', () => {
    const dedup = new CrossTurnDedup({ minLines: 3, minNearLines: 6 });
    dedup.register('a'.repeat(12), testRun(120, 4), 'npm test (run 1)');
    // 4 near-identical lines clears minLines but not minNearLines.
    expect(dedup.find(testRun(377, 4))).toEqual([]);
    // The identical 4 lines do qualify, because they are exact.
    expect(dedup.find(testRun(120, 4))).toHaveLength(1);
  });

  it('does not match unrelated lines that share a numeric shape', () => {
    const dedup = new CrossTurnDedup();
    dedup.register('a'.repeat(12), [
      'Deleting orphaned record 4171 from the archive table',
      'Deleting orphaned record 4172 from the archive table',
      'Deleting orphaned record 4173 from the archive table',
      'Deleting orphaned record 4174 from the archive table',
      'Deleting orphaned record 4175 from the archive table',
      'Deleting orphaned record 4176 from the archive table',
    ], 'cleanup');
    expect(dedup.find([
      'Compiling source module 4171 for the release target',
      'Compiling source module 4172 for the release target',
      'Compiling source module 4173 for the release target',
      'Compiling source module 4174 for the release target',
      'Compiling source module 4175 for the release target',
      'Compiling source module 4176 for the release target',
    ])).toEqual([]);
  });
});

describe('near-duplicate dedup stays lossless end to end', () => {
  let root: string;
  let engine: CompressionEngine;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-neardup-'));
    engine = new CompressionEngine({ rootDir: root, workspaceRoots: [root] });
  });

  afterEach(() => {
    engine.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function compress(stdout: string) {
    return engine.compressCommandOutput({
      command: 'npx vitest run',
      cwd: root,
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 900,
    });
  }

  it('recovers every marker byte-for-byte from the current output, not the earlier run', () => {
    const second = testRun(377).join('\n');
    compress(testRun(120).join('\n'));
    const output = compress(second);

    const markers = [...output.text.matchAll(/\[\[slipstream:([0-9a-f]{12}) L(\d+)-(\d+)[^\]]*\]\]/g)];
    expect(markers.length).toBeGreaterThan(0);
    // At least one marker must be a near-duplicate pointer, or this test is
    // silently only exercising the pre-existing exact path.
    expect(output.text).toContain('near-identical to');

    const originalLines = second.split('\n');
    for (const [, id, start, end] of markers) {
      const slice = engine.retrieve({
        id: String(id),
        startLine: Number(start),
        endLine: Number(end),
        maxLines: 5000,
      });
      expect(slice.text).toBe(originalLines.slice(Number(start) - 1, Number(end)).join('\n'));
    }
  });

  it('saves tokens on a repeat that neither exact nor in-output dedup would catch', () => {
    // Every line has a distinct shape, so the *within-output* near-dup pass
    // cannot fold them, and the per-line timings defeat exact cross-turn
    // hashing. Only cross-turn near-duplicate matching can collapse this.
    const first = compress(buildLog(120).join('\n'));
    const second = compress(buildLog(377).join('\n'));
    expect(second.text).toContain('near-identical to');
    expect(second.tokensAfter).toBeLessThan(first.tokensAfter / 2);
  });
});
