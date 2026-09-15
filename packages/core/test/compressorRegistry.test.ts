import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { CompressorRegistry, DEFAULT_COMPRESSORS, type CompressionInput, type Compressor } from '../src/compressors/compressorRegistry.js';
import { detectContentKind } from '../src/contentRouter.js';
import { DEFAULT_ENGINE_CONFIG } from '../src/engine.js';

function input(patch: Partial<CompressionInput> = {}): CompressionInput {
  return {
    text: 'payload',
    lines: ['payload'],
    source: 'output',
    config: DEFAULT_ENGINE_CONFIG,
    ...patch,
  };
}

function compressor(name: string): Compressor {
  return {
    name,
    detect: vi.fn(() => true),
    compress: vi.fn(() => ({ strategy: name, segments: [] })),
  };
}

describe('detectContentKind', () => {
  it.each(['\n', '\r\n', '\r', '\u2028', '\u2029'])('detects indented stack frames after %j', (separator) => {
    const text = `plain preamble${separator.repeat(3)}\t\u00a0at work (module.js:1)`;
    expect(detectContentKind(text)).toBe('log');
  });

  it.each(['\v\f\ufeffFile "script.py", line 2', '  at work (module.js:1)', 'npm ERR! build failed'])('preserves log detection for %j', (text) => {
    expect(detectContentKind(text)).toBe('log');
  });

  it.each(['plain text at work', 'metadata File "script.py"', 'info about a passing test'])('keeps non-log prose: %s', (text) => {
    expect(detectContentKind(text)).toBe('text');
  });

  it('bounds work across many blank lines without a log marker', () => {
    const text = '\n'.repeat(200_000) + '!';
    expect(runInNewContext('detectContentKind(text)', { detectContentKind, text }, {
      timeout: 1000,
    })).toBe('text');
  });
});

describe('CompressorRegistry', () => {
  it('selects the first successful plan and skips later detectors', () => {
    const first = compressor('first');
    const second = compressor('second');
    const registry = new CompressorRegistry([first, second]);
    expect(registry.compress(input())?.strategy).toBe('first');
    expect(second.detect).not.toHaveBeenCalled();
  });

  it('falls through non-matches and null plans', () => {
    const skipped = compressor('skipped');
    skipped.detect = vi.fn(() => false);
    const declined = compressor('declined');
    declined.compress = vi.fn(() => null);
    const fallback = compressor('fallback');
    const registry = new CompressorRegistry([skipped, declined, fallback]);
    expect(registry.compress(input())?.strategy).toBe('fallback');
    expect(skipped.compress).not.toHaveBeenCalled();
  });

  it('returns null for an empty registry', () => {
    expect(new CompressorRegistry([]).compress(input())).toBeNull();
  });

  it.each([
    ['output', { enabled: false }],
    ['output', { compressLogs: false }],
    ['file', { readLifecycle: false }],
  ] as const)('honours %s disable switches before detection', (source, config) => {
    const candidate = compressor('candidate');
    const registry = new CompressorRegistry([candidate]);
    expect(registry.compress(input({ source, config: { ...DEFAULT_ENGINE_CONFIG, ...config } }))).toBeNull();
    expect(candidate.detect).not.toHaveBeenCalled();
  });

  it('passes detected content and current configuration to the compressor', () => {
    const candidate = compressor('candidate');
    const registry = new CompressorRegistry([candidate]);
    const config = { ...DEFAULT_ENGINE_CONFIG, json: { minItems: 42 } };
    registry.compress(input({ text: '[1,2]', lines: ['[1,2]'], config }));
    expect(candidate.compress).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'json', bigEnough: false, config,
    }));
  });

  it('copies the registration order rather than retaining the caller array', () => {
    const candidates = [compressor('first')];
    const registry = new CompressorRegistry(candidates);
    candidates.unshift(compressor('later'));
    expect(registry.compress(input())?.strategy).toBe('first');
  });

  it('keeps the built-in precedence explicit', () => {
    expect(DEFAULT_COMPRESSORS.map(({ name }) => name)).toEqual([
      'code', 'json', 'diff', 'search', 'tabular', 'config', 'blob', 'log', 'neardup', 'prefix',
    ]);
  });

  it('selects JSON before opaque blobs and forced logs even on a single line', () => {
    const text = JSON.stringify(Array.from({ length: 60 }, (_, index) => ({
      id: index, data: 'abcdef0123456789'.repeat(150),
    })));
    const plan = new CompressorRegistry().compress(input({ text, lines: [text], forceLogCompression: true }));
    expect(plan?.strategy).toMatch(/^json:/);
    expect(JSON.parse(plan!.artifactText!)).toEqual(JSON.parse(text));
  });

  it('selects blob elision before forced log compression', () => {
    const lines = ['INFO starting', 'abcdef0123456789'.repeat(500), 'INFO done'];
    const plan = new CompressorRegistry().compress(input({ text: lines.join('\n'), lines, forceLogCompression: true }));
    expect(plan?.strategy).toBe('blob');
  });

  it('keeps logs ahead of near-duplicate folding', () => {
    const lines = Array.from({ length: 80 }, (_, index) => `INFO processed request ${index}`);
    expect(new CompressorRegistry().compress(input({ text: lines.join('\n'), lines }))?.strategy).toMatch(/^log:/);
  });

  it('falls through a declined structured plan to the opaque-blob fallback', () => {
    const text = JSON.stringify({ payload: 'abcdef0123456789'.repeat(500) });
    expect(new CompressorRegistry().compress(input({ text, lines: [text] }))?.strategy).toBe('blob');
  });

  it('bounds a long non-path that reaches prefix matching after the blob stage declines', () => {
    const prefix = DEFAULT_COMPRESSORS.find((candidate) => candidate.name === 'prefix')!;
    const prefixCompress = vi.fn(prefix.compress);
    const registry = new CompressorRegistry(DEFAULT_COMPRESSORS.map((candidate) => (
      candidate.name === 'prefix' ? { ...candidate, compress: prefixCompress } : candidate
    )));
    const text = '+'.repeat(200_000) + ' '.repeat(100_000) + '!';
    const request = input({ text, lines: [text] });
    expect(runInNewContext('registry.compress(request)', { registry, request }, {
      timeout: 1000,
    })).toBeNull();
    expect(prefixCompress).toHaveBeenCalledOnce();
  });

  it('keeps unsupported file reads out of output-only compressors', () => {
    const text = JSON.stringify(Array.from({ length: 60 }, (_, index) => ({ id: index, value: 'repeated data' })));
    expect(new CompressorRegistry().compress(input({ text, lines: [text], source: 'file', fileExtension: '.json' }))).toBeNull();
  });
});