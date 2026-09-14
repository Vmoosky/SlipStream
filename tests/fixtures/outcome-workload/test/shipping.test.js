import { describe, expect, it } from 'vitest';
import { shippingCents } from '../src/shipping.js';

describe('shipping', () => {
  it('charges the flat standard rate under 1kg', () => {
    expect(shippingCents(800, 'standard')).toBe(599);
  });

  it('adds 2 cents per kilogram over the first', () => {
    expect(shippingCents(3000, 'standard')).toBe(603);
  });

  it('charges the express rate', () => {
    expect(shippingCents(500, 'express')).toBe(1299);
  });

  it('rejects an unknown tier', () => {
    expect(() => shippingCents(500, 'teleport')).toThrow(/unknown shipping tier/);
  });
});
