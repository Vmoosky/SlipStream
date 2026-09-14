import { describe, expect, it } from 'vitest';
import { catalogTotal, catalogLabel, catalogNormalize } from '../src/catalog.js';

describe('catalog', () => {
  it('sums 1 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 1 }, (_, n) => n + 1))).toBe(1);
  });

  it('sums 2 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 2 }, (_, n) => n + 1))).toBe(3);
  });

  it('sums 3 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 3 }, (_, n) => n + 1))).toBe(6);
  });

  it('sums 4 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 4 }, (_, n) => n + 1))).toBe(10);
  });

  it('sums 5 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 5 }, (_, n) => n + 1))).toBe(15);
  });

  it('sums 6 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 6 }, (_, n) => n + 1))).toBe(21);
  });

  it('sums 7 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 7 }, (_, n) => n + 1))).toBe(28);
  });

  it('sums 8 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 8 }, (_, n) => n + 1))).toBe(36);
  });

  it('sums 9 value(s)', () => {
    expect(catalogTotal(Array.from({ length: 9 }, (_, n) => n + 1))).toBe(45);
  });

  it('pads the label', () => {
    expect(catalogLabel(7)).toBe('catalog-0007');
  });

  it('normalizes whitespace and case', () => {
    expect(catalogNormalize('  MiXeD  ')).toBe('mixed');
  });

  it('normalizes null to an empty string', () => {
    expect(catalogNormalize(null)).toBe('');
  });
});
