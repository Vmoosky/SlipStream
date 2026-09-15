import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  planBlobCompression,
  isOpaqueBlobLine,
} from '../src/compressors/blobCompressor.js';

const base64Line = 'A'.repeat(4000);
const hexLine = 'deadbeef'.repeat(600); // 4800 hex chars
const dataUri = `data:image/png;base64,${'Q'.repeat(3000)}`;
const minifiedLine = 'const x=1;a(x);b(y);'.repeat(250); // ~5000 chars, no spaces

/**
 * High-entropy base64 wrapped at 76 columns, as MIME and many MCP image
 * payloads emit it. Entropy matters: a repeated character would be folded by
 * the near-duplicate compressor instead, proving nothing about this path.
 */
function wrappedBase64(bytes: number): string[] {
  let raw = '';
  let seed = 1;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < bytes; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw += alphabet[seed % alphabet.length];
  }
  return raw.match(/.{1,76}/g) ?? [];
}

function keptIndexes(segments: ReturnType<typeof planBlobCompression>): number[] {
  const kept: number[] = [];
  for (const seg of segments!.segments) {
    if (seg.kind === 'kept') {
      for (let i = seg.startLine; i <= seg.endLine; i++) kept.push(i - 1);
    }
  }
  return kept;
}

describe('isOpaqueBlobLine', () => {
  it('flags a long base64 run', () => {
    expect(isOpaqueBlobLine(base64Line)).toBe(true);
  });

  it('flags a long hex dump line', () => {
    expect(isOpaqueBlobLine(hexLine)).toBe(true);
  });

  it('flags a base64 data URI', () => {
    expect(isOpaqueBlobLine(dataUri)).toBe(true);
  });

  it.each([
    'data:;base64,',
    'DATA:image/png;BASE64,',
    'prefixdata:data:image/png;base64,',
  ])('recognizes a data URI header inside prose: %s', (header) => {
    expect(isOpaqueBlobLine('payload description '.repeat(140) + header)).toBe(true);
  });

  it.each([
    'data:image/png ;base64,',
    'data:image/png,other;base64,',
    'data:image/png;charset=utf8;base64,',
    'data:image/png; base64,',
    'data:image/png;base64!',
  ])('does not recognize a malformed data URI header: %s', (header) => {
    expect(isOpaqueBlobLine('payload description '.repeat(140) + header)).toBe(false);
  });

  it('bounds work for repeated data URI prefixes without a terminator', () => {
    const input = 'data:'.repeat(50_000);
    expect(runInNewContext('isOpaqueBlobLine(input)', { isOpaqueBlobLine, input }, {
      timeout: 1000,
    })).toBe(true);
  });

  it('flags a long low-whitespace minified line', () => {
    expect(isOpaqueBlobLine(minifiedLine)).toBe(true);
  });

  it('does not flag ordinary prose even when long', () => {
    const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(120);
    expect(isOpaqueBlobLine(prose)).toBe(false);
  });

  it('does not flag a short opaque token', () => {
    expect(isOpaqueBlobLine('AAAABBBBCCCC')).toBe(false);
  });
});

describe('planBlobCompression', () => {
  it('omits a giant base64 line and keeps the surrounding lines', () => {
    const lines = [
      'header: response payload follows',
      base64Line,
      'footer: end of payload',
    ];
    const plan = planBlobCompression(lines);
    expect(plan).not.toBeNull();
    expect(keptIndexes(plan)).toEqual([0, 2]);
    expect(plan!.omittedLines).toBe(1);
    expect(plan!.omittedChars).toBeGreaterThanOrEqual(4000);
  });

  it('coalesces a block of consecutive opaque lines into one segment', () => {
    const lines = [
      'BEGIN DUMP',
      hexLine,
      hexLine,
      hexLine,
      'END DUMP',
    ];
    const plan = planBlobCompression(lines);
    expect(plan).not.toBeNull();
    // Exactly one omitted segment covering the three hex lines.
    const omitted = plan!.segments.filter((s) => s.kind === 'omitted');
    expect(omitted).toHaveLength(1);
    expect(omitted[0].startLine).toBe(2);
    expect(omitted[0].endLine).toBe(4);
  });

  it('produces contiguous, non-overlapping segments covering all lines', () => {
    const lines = ['a', minifiedLine, 'b', base64Line, 'c'];
    const plan = planBlobCompression(lines);
    expect(plan).not.toBeNull();
    let expected = 1;
    for (const seg of plan!.segments) {
      expect(seg.startLine).toBe(expected);
      expect(seg.endLine).toBeGreaterThanOrEqual(seg.startLine);
      expected = seg.endLine + 1;
    }
    expect(expected - 1).toBe(lines.length);
  });

  it('returns null when there is no oversized opaque line', () => {
    const lines = ['just', 'a few', 'short lines', 'of text'];
    expect(planBlobCompression(lines)).toBeNull();
  });

  it('returns null when the long line is below the length floor', () => {
    const lines = ['x', 'A'.repeat(1500), 'y'];
    expect(planBlobCompression(lines)).toBeNull();
  });

  it('folds a blob wrapped across many short lines', () => {
    // MIME-style base64: high entropy, wrapped at 76 columns, so no single
    // line is oversized and the per-line test alone sees nothing to omit.
    const body = wrappedBase64(45000);
    const lines = ['Content-Type: image/png', '', ...body, 'done'];
    const plan = planBlobCompression(lines);
    expect(plan).not.toBeNull();
    expect(plan!.omittedLines).toBe(body.length);
    // Surrounding context survives; only the payload is omitted.
    expect(keptIndexes(plan)).toEqual([0, 1, lines.length - 1]);
  });

  it('keeps a run of identifiers that are opaque but short', () => {
    // 40-char git SHAs are opaque by character class. Folding a shortlog into
    // a marker would hide exactly the values the model was asked about.
    const lines = Array.from({ length: 40 }, (_, i) =>
      'a'.repeat(39) + String(i % 10),
    );
    expect(planBlobCompression(lines)).toBeNull();
  });

  it('keeps a short run even when the lines are long enough', () => {
    const lines = wrappedBase64(600); // ~8 lines of payload, under the floor
    expect(planBlobCompression(lines.slice(0, 6))).toBeNull();
  });

  it('recovers the wrapped payload byte-for-byte', () => {
    const body = wrappedBase64(45000);
    const lines = ['header', ...body, 'footer'];
    const plan = planBlobCompression(lines)!;
    const rebuilt: string[] = [];
    for (const seg of plan.segments) {
      for (let i = seg.startLine; i <= seg.endLine; i++) rebuilt.push(lines[i - 1]!);
    }
    expect(rebuilt).toEqual(lines);
  });
});
