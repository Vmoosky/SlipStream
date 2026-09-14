import { describe, expect, it } from 'vitest';

import { planJsonCompression, type JsonPlan } from '../src/compressors/jsonCompressor.js';
import type { Segment } from '../src/types.js';

/** Reassemble the text of the kept segments only. */
function keptText(plan: JsonPlan): string {
  const lines = plan.text.split('\n');
  return plan.segments
    .filter((s): s is Extract<Segment, { kind: 'kept' }> => s.kind === 'kept')
    .map((s) => lines.slice(s.startLine - 1, s.endLine).join('\n'))
    .join('\n');
}

/** Segments must tile the whole text with no gaps or overlaps. */
function expectContiguous(plan: JsonPlan): void {
  const total = plan.text.split('\n').length;
  expect(plan.segments[0]?.startLine).toBe(1);
  expect(plan.segments[plan.segments.length - 1]?.endLine).toBe(total);
  for (let i = 1; i < plan.segments.length; i++) {
    expect(plan.segments[i]!.startLine).toBe(plan.segments[i - 1]!.endLine + 1);
  }
}

function uniformArray(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    status: 'ok',
    score: i % 7,
  }));
}

describe('planJsonCompression', () => {
  it('returns null for non-JSON', () => {
    expect(planJsonCompression('not json at all')).toBeNull();
  });

  it('returns null for a scalar or a small array', () => {
    expect(planJsonCompression('42')).toBeNull();
    expect(planJsonCompression(JSON.stringify(uniformArray(5)))).toBeNull();
  });

  it('compresses a large uniform array losslessly', () => {
    const input = uniformArray(40);
    const plan = planJsonCompression(JSON.stringify(input));
    expect(plan).not.toBeNull();
    expect(plan!.format).toBe('array');
    expect(plan!.omittedItems).toBeGreaterThanOrEqual(30);
    // The stored text is a reformatting, so it must parse back to the original.
    expect(JSON.parse(plan!.text)).toEqual(input);
    expectContiguous(plan!);
  });

  it('keeps boundary items', () => {
    const input = uniformArray(40);
    const plan = planJsonCompression(JSON.stringify(input))!;
    const kept = keptText(plan);
    expect(kept).toContain('"name": "item-0"');
    expect(kept).toContain('"name": "item-39"');
    expect(kept).not.toContain('"name": "item-20"');
  });

  it('keeps an error item buried in the middle', () => {
    const input = uniformArray(40);
    (input[20] as Record<string, unknown>).status = 'error';
    (input[20] as Record<string, unknown>).error = 'disk full';
    const plan = planJsonCompression(JSON.stringify(input))!;
    expect(keptText(plan)).toContain('"error": "disk full"');
  });

  it('keeps a structurally unusual item', () => {
    const input = uniformArray(40);
    (input[15] as Record<string, unknown>).unexpectedField = 'surprise';
    const plan = planJsonCompression(JSON.stringify(input))!;
    expect(keptText(plan)).toContain('"unexpectedField": "surprise"');
  });

  it('keeps a size outlier', () => {
    const input = uniformArray(40);
    (input[25] as Record<string, unknown>).name = 'x'.repeat(4000);
    const plan = planJsonCompression(JSON.stringify(input))!;
    expect(keptText(plan)).toContain('x'.repeat(4000));
  });

  it('compresses the bulk array inside an object and keeps scalars', () => {
    const input = { total_count: 40, incomplete_results: false, items: uniformArray(40) };
    const plan = planJsonCompression(JSON.stringify(input));
    expect(plan).not.toBeNull();
    expect(plan!.format).toBe('object');
    expect(JSON.parse(plan!.text)).toEqual(input);
    const kept = keptText(plan!);
    expect(kept).toContain('"total_count": 40');
    expect(kept).toContain('"incomplete_results": false');
    expectContiguous(plan!);
  });

  it('compresses an array of primitives', () => {
    const input = Array.from({ length: 50 }, (_, i) => i * 3);
    const plan = planJsonCompression(JSON.stringify(input));
    expect(plan).not.toBeNull();
    expect(JSON.parse(plan!.text)).toEqual(input);
    expectContiguous(plan!);
  });

  it('returns null when too few items would be omitted', () => {
    // Every item is a distinct shape, so all are kept as outliers and nothing
    // is worth a marker.
    const input = Array.from({ length: 10 }, (_, i) => ({ [`k${i}`]: i }));
    expect(planJsonCompression(JSON.stringify(input))).toBeNull();
  });
});
