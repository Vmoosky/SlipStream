import { describe, expect, it } from 'vitest';
import { BENCHMARK_REFERENCE } from '../src/benchmarkReference.js';

import {
  DEFAULT_PROOF_SEED,
  generateProofScenarios,
  runProofTable,
} from '../src/proofTable.js';

describe('proof table', () => {
  it('generates byte-identical scenarios for the same seed', () => {
    const a = generateProofScenarios(4242);
    const b = generateProofScenarios(4242);
    expect(a).toEqual(b);
  });

  it('generates different payloads for different seeds', () => {
    const a = generateProofScenarios(1);
    const b = generateProofScenarios(2);
    expect(a.map((s) => s.payload)).not.toEqual(b.map((s) => s.payload));
  });

  it('produces the same measured table for the same seed (reproducible)', () => {
    const first = runProofTable({ seed: 777 });
    const second = runProofTable({ seed: 777 });
    expect(second.rows).toEqual(first.rows);
    expect(second.summary.tokensSaved).toBe(first.summary.tokensSaved);
  });

  it('covers all six scenarios and saves tokens overall', () => {
    const { rows, summary } = runProofTable({ seed: DEFAULT_PROOF_SEED });
    const before = rows.reduce((total, row) => total + row.before, 0);
    const after = rows.reduce((total, row) => total + row.after, 0);
    expect(BENCHMARK_REFERENCE).toEqual({
      kind: 'synthetic',
      seed: DEFAULT_PROOF_SEED,
      profile: 'balanced',
      scenarios: rows.length,
      tokensBefore: before,
      tokensAfter: after,
      tokensSaved: before - after,
      percentSaved: ((before - after) / before) * 100,
      retrievalRate: null,
      totalOverheadMs: null,
    });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.saved).toBeGreaterThan(0);
      expect(row.after).toBeLessThan(row.before);
    }
    expect(summary.tokensSaved).toBeGreaterThan(0);
    expect(summary.percentSaved).toBeGreaterThan(0);
  });

  it('enforces byte-for-byte recoverability (throws if a marker cannot round-trip)', () => {
    // runProofTable asserts every marker internally; a clean run is the proof.
    expect(() => runProofTable({ seed: 9001 })).not.toThrow();
  });
});
