import { describe, expect, it } from 'vitest';
import { applyDiscount, subtotal } from '../src/pricing.js';

describe('pricing', () => {
  it('leaves the price alone at 0%', () => {
    expect(applyDiscount(1999, 0)).toBe(1999);
  });

  it('takes 10% off a round price', () => {
    expect(applyDiscount(2000, 10)).toBe(1800);
  });

  it('takes 15% off an odd price', () => {
    expect(applyDiscount(1999, 15)).toBe(1699);
  });

  it('rejects a percent above 100', () => {
    expect(() => applyDiscount(100, 101)).toThrow(RangeError);
  });

  it('sums line items', () => {
    expect(subtotal([{ unitCents: 500, quantity: 2 }, { unitCents: 250, quantity: 1 }])).toBe(1250);
  });
});
