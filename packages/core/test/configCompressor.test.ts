import { describe, it, expect } from 'vitest';
import {
  looksLikeConfig,
  planConfigCompression,
} from '../src/compressors/configCompressor.js';

function line(n: number, body: string): string[] {
  return Array.from({ length: n }, () => body);
}

describe('looksLikeConfig', () => {
  it('detects a YAML file with a comment header and several keys', () => {
    const lines = [
      ...line(20, '# generated file -- do not edit by hand'),
      'name: my-service',
      'version: 1.2.3',
      'replicas: 3',
      'image: registry.example.com/my-service:latest',
      'port: 8080',
      ...line(20, '# more documentation about the settings above'),
    ];
    expect(looksLikeConfig(lines)).toBe(true);
  });

  it('detects an INI/TOML file with [section] headers', () => {
    const lines = [
      '[core]',
      'editor = vim',
      'pager = less',
      ...line(20, '; commented-out default value'),
      '[user]',
      'name = Example',
      'email = user@example.com',
      ...line(20, '; trailing notes'),
    ];
    expect(looksLikeConfig(lines)).toBe(true);
  });

  it('rejects prose text', () => {
    const lines = line(50, 'This is an ordinary sentence of running prose text.');
    expect(looksLikeConfig(lines)).toBe(false);
  });

  it('rejects input below the minimum line floor', () => {
    const lines = ['name: x', 'version: 1', '[a]', 'b = c'];
    expect(looksLikeConfig(lines)).toBe(false);
  });
});

describe('planConfigCompression', () => {
  it('collapses long comment/blank runs and keeps every setting', () => {
    const lines = [
      ...line(12, '# license header line'),
      'name: my-service',
      'version: 1.2.3',
      '',
      '',
      ...line(10, '# commented-out defaults'),
      'replicas: 3',
      'port: 8080',
    ];
    const plan = planConfigCompression(lines, { minLines: 10 });
    expect(plan).not.toBeNull();
    expect(plan!.format).toBe('yaml');

    const kept: number[] = [];
    for (const seg of plan!.segments) {
      if (seg.kind === 'kept') {
        for (let i = seg.startLine; i <= seg.endLine; i++) kept.push(i - 1);
      }
    }
    // Every non-collapsible setting line survives.
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*[\w.$-]+\s*[:=]/.test(lines[i])) {
        expect(kept).toContain(i);
      }
    }
    expect(plan!.omittedLines).toBeGreaterThan(0);
  });

  it('reports ini format when [section] headers are present', () => {
    const lines = [
      '[core]',
      'editor = vim',
      ...line(12, '; commented-out default'),
      '[user]',
      'name = Example',
      ...line(12, '; more comments'),
    ];
    const plan = planConfigCompression(lines, { minLines: 10 });
    expect(plan).not.toBeNull();
    expect(plan!.format).toBe('ini');
  });

  it('produces contiguous, non-overlapping segments covering all lines', () => {
    const lines = [
      ...line(12, '# header'),
      'a: 1',
      'b: 2',
      ...line(12, '# footer'),
    ];
    const plan = planConfigCompression(lines, { minLines: 10 });
    expect(plan).not.toBeNull();
    let expected = 1;
    for (const seg of plan!.segments) {
      expect(seg.startLine).toBe(expected);
      expect(seg.endLine).toBeGreaterThanOrEqual(seg.startLine);
      expected = seg.endLine + 1;
    }
    expect(expected - 1).toBe(lines.length);
  });

  it('returns null when too little would be omitted', () => {
    const lines = [
      '# short comment',
      '# short comment',
      'a: 1',
      'b: 2',
      'c: 3',
      ...line(40, 'd: value'),
    ];
    expect(planConfigCompression(lines)).toBeNull();
  });

  it('returns null below the minimum line floor', () => {
    const lines = [...line(6, '# comment'), 'a: 1'];
    expect(planConfigCompression(lines)).toBeNull();
  });
});
