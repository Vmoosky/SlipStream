import { describe, it, expect } from 'vitest';
import {
  planNearDupCompression,
  lineTemplate,
} from '../src/compressors/nearDupCompressor.js';

function keptIndexes(plan: ReturnType<typeof planNearDupCompression>): number[] {
  const kept: number[] = [];
  for (const seg of plan!.segments) {
    if (seg.kind === 'kept') {
      for (let i = seg.startLine; i <= seg.endLine; i++) kept.push(i - 1);
    }
  }
  return kept;
}

describe('lineTemplate', () => {
  it('normalizes varying digit runs to a shared template', () => {
    expect(lineTemplate('Downloading package foo-12')).toBe(
      lineTemplate('Downloading package foo-345'),
    );
  });

  it('keeps genuinely different lines distinct', () => {
    expect(lineTemplate('installing alpha')).not.toBe(lineTemplate('removing beta'));
  });

  it('normalizes varying UUIDs to a shared template', () => {
    expect(lineTemplate('Processed item 123e4567-e89b-12d3-a456-426614174000')).toBe(
      lineTemplate('Processed item 9f8e7d6c-5b4a-3210-fedc-ba9876543210'),
    );
  });

  it('normalizes varying hex ids (e.g. commit SHAs) to a shared template', () => {
    expect(lineTemplate('Building commit 1a2b3c4d5e6f')).toBe(
      lineTemplate('Building commit deadbeef01'),
    );
  });

  it('does not fold ordinary alphabetic words that happen to be hex-safe', () => {
    expect(lineTemplate('applying facade pattern')).not.toBe(
      lineTemplate('applying decaf pattern'),
    );
  });
});

describe('planNearDupCompression', () => {
  function repeated(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `Downloading package number ${i + 1} of many`);
  }

  it('folds a long run of near-identical lines, keeping head and tail', () => {
    const lines = ['start', ...repeated(30), 'done'];
    const plan = planNearDupCompression(lines);
    expect(plan).not.toBeNull();
    // head (2) + tail (1) representatives of the run survive, plus the bookends.
    const kept = keptIndexes(plan);
    expect(kept).toContain(0); // 'start'
    expect(kept).toContain(1); // first repeated
    expect(kept).toContain(2); // second repeated
    expect(kept).toContain(30); // last repeated (index 1 + 30 - 1)
    expect(kept).toContain(31); // 'done'
    expect(plan!.omittedLines).toBeGreaterThan(20);
  });

  it('collapses the run into a single omitted segment', () => {
    const lines = ['start', ...repeated(30), 'done'];
    const plan = planNearDupCompression(lines);
    const omitted = plan!.segments.filter((s) => s.kind === 'omitted');
    expect(omitted).toHaveLength(1);
  });

  it('folds an exact-duplicate run too', () => {
    const lines = ['header', ...Array(20).fill('retrying connection to server'), 'footer'];
    const plan = planNearDupCompression(lines);
    expect(plan).not.toBeNull();
    expect(plan!.omittedLines).toBeGreaterThan(0);
  });

  it('folds a run that varies only by hash/uuid ids', () => {
    const ids = [
      '1a2b3c4d5e6f',
      'deadbeef0011',
      'cafebabe1234',
      '0123456789ab',
      'fedcba987654',
      '00ff11ee22dd',
    ];
    const lines = ['start', ...ids.map((id) => `Uploaded blob ${id} to store`), 'done'];
    const plan = planNearDupCompression(lines, { minRun: 4, minOmitted: 1 });
    expect(plan).not.toBeNull();
    expect(plan!.omittedLines).toBeGreaterThan(0);
  });

  it('produces contiguous, non-overlapping segments covering all lines', () => {
    const lines = ['a', ...repeated(30), 'b'];
    const plan = planNearDupCompression(lines);
    let expected = 1;
    for (const seg of plan!.segments) {
      expect(seg.startLine).toBe(expected);
      expect(seg.endLine).toBeGreaterThanOrEqual(seg.startLine);
      expected = seg.endLine + 1;
    }
    expect(expected - 1).toBe(lines.length);
  });

  it('returns null when a run is shorter than the minimum', () => {
    const lines = ['x', ...repeated(3), 'y'];
    expect(planNearDupCompression(lines)).toBeNull();
  });

  it('returns null for non-repetitive prose', () => {
    const lines = [
      'The build completed successfully.',
      'Three artifacts were produced.',
      'No warnings were emitted.',
      'Total time was under a minute.',
    ];
    expect(planNearDupCompression(lines)).toBeNull();
  });

  it('does not fold low-content lines such as blanks or separators of digits', () => {
    const lines = ['', '', '', '', '', '', '', ''];
    expect(planNearDupCompression(lines)).toBeNull();
  });
});
