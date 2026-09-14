import { describe, it, expect } from 'vitest';
import { stripAnsi, hasAnsi } from '../src/compressors/ansiCompressor.js';

const ESC = '\u001B';

describe('stripAnsi', () => {
  it('removes basic SGR colour codes', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red');
  });

  it('removes multi-attribute SGR codes', () => {
    expect(stripAnsi(`${ESC}[1;32mok${ESC}[0m`)).toBe('ok');
  });

  it('removes cursor-movement and erase-line sequences', () => {
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gprogress`)).toBe('progress');
  });

  it('removes OSC window-title sequences (BEL terminated)', () => {
    expect(stripAnsi(`${ESC}]0;my title${'\u0007'}body`)).toBe('body');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('preserves newlines and interior content', () => {
    const input = `${ESC}[32mline one${ESC}[0m\nplain\n${ESC}[31mline three${ESC}[0m`;
    expect(stripAnsi(input)).toBe('line one\nplain\nline three');
  });

  it('does not touch a literal "[31m" that has no escape byte', () => {
    expect(stripAnsi('color code [31m is literal')).toBe('color code [31m is literal');
  });

  it('is idempotent', () => {
    const once = stripAnsi(`${ESC}[33mwarn${ESC}[0m ${ESC}[2Kx`);
    expect(stripAnsi(once)).toBe(once);
  });

  it('returns an empty string unchanged', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('hasAnsi', () => {
  it('is true when escape sequences are present', () => {
    expect(hasAnsi(`${ESC}[31mred${ESC}[0m`)).toBe(true);
  });

  it('is false for plain text', () => {
    expect(hasAnsi('no colours here [31m literal')).toBe(false);
  });

  it('is false for an empty string', () => {
    expect(hasAnsi('')).toBe(false);
  });
});
