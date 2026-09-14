import { describe, expect, it } from 'vitest';

import { planLogCompression, templateOf } from '../src/compressors/logCompressor.js';
import { jestFailureLog, npmInstallLog, tscRepeatedErrors } from './fixtures.js';

/** Expand a plan back into the lines that survive compression. */
function keptLines(raw: string): string[] {
  const lines = raw.split('\n');
  const plan = planLogCompression(lines);
  const out: string[] = [];
  for (const segment of plan.segments) {
    if (segment.kind === 'kept') {
      out.push(...lines.slice(segment.startLine - 1, segment.endLine));
    }
  }
  return out;
}

describe('planLogCompression', () => {
  it('detects the jest format', () => {
    const plan = planLogCompression(jestFailureLog().split('\n'));
    expect(plan.format).toBe('jest');
  });

  it('keeps the failing test, its assertion and its stack trace', () => {
    const kept = keptLines(jestFailureLog()).join('\n');
    expect(kept).toContain('FAIL src/services/billing/invoice.spec.ts');
    expect(kept).toContain('\u25cf Invoice totals \u203a applies proportional discounts');
    expect(kept).toContain('Expected: 142.5');
    expect(kept).toContain('Received: 150');
    expect(kept).toContain('at Object.<anonymous> (src/services/billing/invoice.spec.ts:48:23)');
  });

  it('keeps the whole trailing summary block', () => {
    const kept = keptLines(jestFailureLog()).join('\n');
    expect(kept).toContain('Test Suites: 1 failed, 40 passed, 41 total');
    expect(kept).toContain('Tests:       1 failed, 120 passed, 121 total');
    expect(kept).toContain('Ran all test suites.');
  });

  it('drops the passing-suite noise', () => {
    const raw = jestFailureLog(40);
    const plan = planLogCompression(raw.split('\n'));
    expect(plan.keptLines).toBeLessThan(plan.totalLines * 0.25);
  });

  it('never separates a stack frame from the error above it', () => {
    const raw = jestFailureLog();
    const lines = raw.split('\n');
    const plan = planLogCompression(lines);
    const kept = new Set<number>();
    for (const segment of plan.segments) {
      if (segment.kind === 'kept') {
        for (let i = segment.startLine; i <= segment.endLine; i++) {
          kept.add(i);
        }
      }
    }
    for (let i = 1; i <= lines.length; i++) {
      const line = lines[i - 1] ?? '';
      if (/^\s+at Object\.<anonymous>/.test(line)) {
        // The frame is kept, and so is the error line that introduced it.
        expect(kept.has(i)).toBe(true);
      }
    }
  });

  it('collapses repeated type errors but keeps the distinct ones', () => {
    const kept = keptLines(tscRepeatedErrors(60)).join('\n');
    const repeats = kept.match(/error TS2339/g) ?? [];
    expect(repeats.length).toBeGreaterThan(0);
    expect(repeats.length).toBeLessThanOrEqual(4);
    expect(kept).toContain('error TS2345');
    expect(kept).toContain('error TS7006');
    expect(kept).toContain('Found 62 errors in 3 files.');
  });

  it('strips install progress noise but keeps the outcome', () => {
    const raw = npmInstallLog(300);
    const plan = planLogCompression(raw.split('\n'));
    const kept = keptLines(raw).join('\n');
    expect(plan.keptLines).toBeLessThan(60);
    expect(kept).toContain('added 1284 packages');
    expect(kept).toContain('found 0 vulnerabilities');
  });

  it('does not treat a clean summary as an error', () => {
    const kept = keptLines(npmInstallLog(300)).join('\n');
    expect(kept).toContain('found 0 vulnerabilities');
  });

  it('handles empty input', () => {
    const plan = planLogCompression([]);
    expect(plan.segments).toEqual([]);
    expect(plan.totalLines).toBe(0);
  });

  it('produces segments that tile the input exactly once', () => {
    const lines = jestFailureLog(12).split('\n');
    const plan = planLogCompression(lines);
    let cursor = 1;
    for (const segment of plan.segments) {
      expect(segment.startLine).toBe(cursor);
      expect(segment.endLine).toBeGreaterThanOrEqual(segment.startLine);
      cursor = segment.endLine + 1;
    }
    expect(cursor - 1).toBe(lines.length);
  });
});

describe('templateOf', () => {
  it('normalizes volatile numbers so repeats group together', () => {
    expect(templateOf('src/a.ts(10,5): error TS2339: nope')).toBe(
      templateOf('src/a.ts(998,12): error TS2339: nope'),
    );
  });

  it('keeps genuinely different messages apart', () => {
    expect(templateOf('src/a.ts(10,5): error TS2339: nope')).not.toBe(
      templateOf('src/b.ts(10,5): error TS2339: nope'),
    );
  });
});
