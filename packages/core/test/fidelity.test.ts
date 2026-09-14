import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CompressionEngine } from '../src/engine.js';
import {
  reconstructFromArtifacts,
  verifyMarkerFidelity,
} from '../src/fidelity.js';
import { expandPrefixFold } from '../src/compressors/prefixCompressor.js';

let rootDir: string;
let workspace: string;
let engine: CompressionEngine;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-fidelity-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-fws-'));
  engine = new CompressionEngine({ rootDir, workspaceRoots: [workspace] });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function compress(text: string, toolName = 'shell') {
  return engine.compressToolResult({ toolName, cwd: workspace, text });
}

// --- representative triggering inputs ------------------------------------

function npmInstallLog(packages = 300): string {
  const lines: string[] = ['> npm install'];
  for (let i = 0; i < packages; i++) {
    lines.push(`npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} ${20 + (i % 400)}ms`);
  }
  lines.push('added 1284 packages in 41s');
  return lines.join('\n');
}

function jsonArray(n = 200): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ id: i, name: `item-${i}`, status: 'ok', score: i % 7 })),
  );
}

function grepOutput(files = 6, matchesPerFile = 30): string {
  const lines: string[] = [];
  for (let f = 0; f < files; f++) {
    for (let i = 1; i <= matchesPerFile; i++) {
      lines.push(`src/module${f}/file.ts:${i}:  const value${i} = compute(${i});`);
    }
  }
  return lines.join('\n');
}

function blobOutput(): string {
  const blob = 'A'.repeat(4000);
  return ['header line', `data:application/octet-stream;base64,${blob}`, 'footer line'].join('\n');
}

function nearDupOutput(n = 40): string {
  return Array.from({ length: n }, (_, i) => `Processed record ${1000 + i} in ${i} ms`).join('\n');
}

function pathListing(): string {
  const prefix = '/home/user/dev/workspace/my-project/packages/core/src/';
  return [
    'engine.ts',
    'contentRouter.ts',
    'markers.ts',
    'tokenizer.ts',
    'compressors/logCompressor.ts',
    'compressors/jsonCompressor.ts',
    'compressors/searchCompressor.ts',
    'compressors/tabularCompressor.ts',
    'compressors/blobCompressor.ts',
    'compressors/prefixCompressor.ts',
  ]
    .map((f) => `${prefix}${f}`)
    .join('\n');
}

// --- byte-exact (line-omission) strategies -------------------------------

describe('retrieval fidelity — byte-exact strategies', () => {
  const cases: Array<{ name: string; input: string }> = [
    { name: 'log', input: npmInstallLog() },
    { name: 'search', input: grepOutput() },
    { name: 'blob', input: blobOutput() },
    { name: 'neardup', input: nearDupOutput() },
  ];

  for (const { name, input } of cases) {
    it(`${name}: every marked range reads back byte-for-byte`, () => {
      const result = compress(input);
      const report = verifyMarkerFidelity(result.text, engine.store);
      expect(report.ok).toBe(true);
      expect(report.markersChecked).toBeGreaterThan(0);
    });

    it(`${name}: reconstruction reproduces the original input exactly`, () => {
      const result = compress(input);
      expect(reconstructFromArtifacts(result.text, engine.store)).toBe(input);
    });
  }
});

// --- semantically-lossless (whole-text) strategies -----------------------

describe('retrieval fidelity — transforming strategies', () => {
  it('json: the stored artifact parses back to the same data', () => {
    const input = jsonArray();
    const result = compress(input);
    expect(result.strategy.startsWith('json')).toBe(true);
    const report = verifyMarkerFidelity(result.text, engine.store);
    expect(report.ok).toBe(true);
    const stored = engine.store.get(result.artifactId);
    expect(JSON.parse(stored ?? '')).toEqual(JSON.parse(input));
  });

  it('prefix: the folded artifact expands back to the original', () => {
    const input = pathListing();
    const result = compress(input, 'ls');
    expect(result.strategy).toBe('prefix');
    const stored = engine.store.get(result.artifactId);
    expect(expandPrefixFold(stored ?? '')).toBe(input);
  });
});

// --- the guard actually catches a lost source ----------------------------

describe('retrieval fidelity — guard detects a pointer outliving its source', () => {
  it('reports artifact-missing after the source is evicted', () => {
    const result = compress(npmInstallLog());
    const before = verifyMarkerFidelity(result.text, engine.store);
    expect(before.ok).toBe(true);
    expect(before.markersChecked).toBeGreaterThan(0);

    // Force eviction of every artifact, simulating aggressive retention.
    engine.store.updateRetention({ maxEntries: 0, maxTotalBytes: 0 });

    const after = verifyMarkerFidelity(result.text, engine.store);
    expect(after.ok).toBe(false);
    expect(after.failures.every((f) => f.reason === 'artifact-missing')).toBe(true);
    // reconstruction cannot fabricate the lost bytes — it must fail loudly.
    expect(() => reconstructFromArtifacts(result.text, engine.store)).toThrow();
  });
});

describe('verifyMarkerFidelity — payloads with no markers', () => {
  it('passes vacuously when nothing was omitted', () => {
    const report = verifyMarkerFidelity('plain output\nwith no markers', engine.store);
    expect(report.ok).toBe(true);
    expect(report.markersChecked).toBe(0);
  });
});
