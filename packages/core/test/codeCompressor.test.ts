import { describe, expect, it } from 'vitest';

import { planCodeCompression, type CodePlan } from '../src/compressors/codeCompressor.js';
import type { Segment } from '../src/types.js';

/** Text of the kept segments, sliced from the original (unreformatted) source. */
function keptText(content: string, plan: CodePlan): string {
  const lines = content.split('\n');
  return plan.segments
    .filter((s): s is Extract<Segment, { kind: 'kept' }> => s.kind === 'kept')
    .map((s) => lines.slice(s.startLine - 1, s.endLine).join('\n'))
    .join('\n');
}

/** Text of the omitted (collapsed body) segments, from the original source. */
function omittedText(content: string, plan: CodePlan): string {
  const lines = content.split('\n');
  return plan.segments
    .filter((s): s is Extract<Segment, { kind: 'omitted'; reason: string }> => s.kind === 'omitted')
    .map((s) => lines.slice(s.startLine - 1, s.endLine).join('\n'))
    .join('\n');
}

/** Segments must tile the whole file with no gaps or overlaps. */
function expectContiguous(content: string, plan: CodePlan): void {
  const total = content.split('\n').length;
  expect(plan.segments[0]?.startLine).toBe(1);
  expect(plan.segments[plan.segments.length - 1]?.endLine).toBe(total);
  for (let i = 1; i < plan.segments.length; i++) {
    expect(plan.segments[i]!.startLine).toBe(plan.segments[i - 1]!.endLine + 1);
  }
}

/** A TS/JS-style file: imports, then top-level functions with large bodies. */
function braceSource(fnCount: number, bodyLines: number): string {
  const out: string[] = ["import { readFile } from 'node:fs';", ''];
  for (let i = 0; i < fnCount; i++) {
    out.push(`// handler ${i}`);
    out.push(`export function handler${i}(input: number): number {`);
    for (let b = 0; b < bodyLines; b++) out.push(`  const v${b} = input + ${b};`);
    out.push('  return input;');
    out.push('}');
    out.push('');
  }
  return out.join('\n');
}

/** A Python file: a class whose methods have large bodies. */
function pySource(methodCount: number, bodyLines: number): string {
  const out: string[] = ['import os', '', 'class Service:'];
  for (let i = 0; i < methodCount; i++) {
    out.push(`    def method${i}(self, x):`);
    for (let b = 0; b < bodyLines; b++) out.push(`        y${b} = x + ${b}`);
    out.push('        return x');
    out.push('');
  }
  return out.join('\n');
}

describe('planCodeCompression', () => {
  it('returns null for an unsupported extension', () => {
    expect(planCodeCompression(braceSource(6, 8), '.txt')).toBeNull();
    expect(planCodeCompression(braceSource(6, 8), '.md')).toBeNull();
  });

  it('returns null for a file shorter than the minimum', () => {
    expect(planCodeCompression(braceSource(1, 4), '.ts')).toBeNull();
  });

  it('outlines a brace-language file: keeps signatures, collapses bodies', () => {
    const content = braceSource(6, 8);
    const plan = planCodeCompression(content, '.ts');
    expect(plan).not.toBeNull();
    expect(plan!.language).toBe('brace');

    const kept = keptText(content, plan!);
    // Imports, comments and signatures stay in the outline.
    expect(kept).toContain("import { readFile } from 'node:fs';");
    expect(kept).toContain('// handler 0');
    expect(kept).toContain('export function handler0(input: number): number {');
    expect(kept).toContain('export function handler5(input: number): number {');
    // Body statements are gone from the outline.
    expect(kept).not.toContain('const v3 = input + 3;');

    // ...but they live in the omitted runs, recoverable by marker.
    expect(omittedText(content, plan!)).toContain('const v3 = input + 3;');
  });

  it('produces contiguous, lossless segments over the original lines', () => {
    const content = braceSource(6, 8);
    const plan = planCodeCompression(content, '.ts')!;
    expectContiguous(content, plan);

    // Reassembling kept + omitted in line order reproduces the file exactly.
    const lines = content.split('\n');
    const rebuilt = plan.segments
      .map((s) => lines.slice(s.startLine - 1, s.endLine).join('\n'))
      .join('\n');
    expect(rebuilt).toBe(content);
  });

  it('keeps the count of omitted lines honest', () => {
    const content = braceSource(6, 8);
    const plan = planCodeCompression(content, '.ts')!;
    const total = content.split('\n').length;
    expect(plan.keptLines + plan.omittedLines).toBe(total);
    expect(plan.omittedLines).toBeGreaterThanOrEqual(12);
  });

  it('returns null when bodies are too small to be worth collapsing', () => {
    // Every function body is a single statement -- below minBlockLines.
    expect(planCodeCompression(braceSource(20, 1), '.ts')).toBeNull();
  });

  it('outlines a Python file: keeps class and def signatures, collapses bodies', () => {
    const content = pySource(6, 8);
    const plan = planCodeCompression(content, '.py');
    expect(plan).not.toBeNull();
    expect(plan!.language).toBe('indent');

    const kept = keptText(content, plan!);
    expect(kept).toContain('import os');
    expect(kept).toContain('class Service:');
    expect(kept).toContain('    def method0(self, x):');
    expect(kept).toContain('    def method5(self, x):');
    expect(kept).not.toContain('        y3 = x + 3');

    expect(omittedText(content, plan!)).toContain('        y3 = x + 3');
  });

  it('bails out when braces do not balance', () => {
    // A stray unclosed brace makes the scan unreliable; better to head-cap.
    const content = braceSource(6, 8) + '\nconst broken = {\n';
    expect(planCodeCompression(content, '.ts')).toBeNull();
  });
});
