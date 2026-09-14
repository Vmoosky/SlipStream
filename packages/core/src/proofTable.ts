import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CompressionEngine } from './engine.js';
import { parseMarkers } from './markers.js';
import type { SavingsSummary, ToolOutput } from './types.js';

/**
 * Seeded, offline proof table.
 *
 * Headroom publishes a `benchmarks/index_proof_table.py --seed …` so anyone can
 * reproduce the exact savings numbers it claims. This is the lossless analogue:
 * a deterministic set of representative tool-output scenarios (JSON results, a
 * build log, grep results, a CSV table, a large file read, and a mixed dump),
 * each generated from a single integer seed so the same seed always yields the
 * same bytes — and therefore the same token counts and the same table.
 *
 * Because Slipstream *measures* savings (it owns the raw and the forwarded
 * bytes) rather than estimating them, the table needs no accuracy caveat. Every
 * scenario additionally re-expands each emitted marker and checks it against the
 * stored artifact byte-for-byte, so a good ratio can never be bought with lost
 * information — the run throws if any marker fails to round-trip.
 */

/** One measured scenario row, shaped for the report formatters. */
export interface ProofRow {
  scenario: string;
  /** Tokens the model would have received without Slipstream. */
  before: number;
  /** Tokens actually forwarded after compression. */
  after: number;
  /** before - after. */
  saved: number;
  /** Human-readable note: strategy and/or line + marker counts. */
  detail: string;
}

export interface ProofTable {
  seed: number;
  rows: ProofRow[];
  summary: SavingsSummary;
}

/** A single synthetic payload plus how it should be fed to the engine. */
export interface ProofScenario {
  name: string;
  kind: 'tool' | 'command' | 'file';
  /** Tool name for `kind:'tool'`, or the command for `kind:'command'`. */
  tool: string;
  /** Virtual path for `kind:'file'` (must sit under the engine's root). */
  filePath?: string;
  payload: string;
}

/** The seed used when a caller does not supply one — keep this stable. */
export const DEFAULT_PROOF_SEED = 20260907;

/**
 * mulberry32 — a tiny, fast, fully deterministic 32-bit PRNG. Given the same
 * seed it always produces the same sequence on every platform and Node version,
 * which is what makes the whole proof table reproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a deterministic element from a list. */
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length] as T;
}

/** Deterministic integer in [min, max]. */
function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const WORDS = [
  'auth', 'cache', 'ledger', 'engine', 'router', 'store', 'marker', 'segment',
  'compress', 'retrieve', 'session', 'token', 'artifact', 'fidelity', 'dedup',
] as const;
const CITIES = ['berlin', 'lisbon', 'osaka', 'denver', 'nairobi', 'oslo', 'lima'] as const;
const LEVELS = ['info', 'info', 'info', 'debug', 'warn'] as const;

function timestamp(rng: () => number): string {
  const hh = String(int(rng, 0, 23)).padStart(2, '0');
  const mm = String(int(rng, 0, 59)).padStart(2, '0');
  const ss = String(int(rng, 0, 59)).padStart(2, '0');
  return `2026-09-07T${hh}:${mm}:${ss}Z`;
}

/** A JSON API/search response: a large array of uniform records (minified). */
function genJsonResults(rng: () => number): string {
  const records = Array.from({ length: 160 }, (_, i) => ({
    id: i + 1,
    sku: `SKU-${int(rng, 1000, 9999)}`,
    name: `${pick(rng, WORDS)}-${pick(rng, WORDS)}`,
    priceCents: int(rng, 199, 250_00),
    inStock: rng() > 0.3,
    warehouse: pick(rng, CITIES),
    tags: Array.from({ length: int(rng, 1, 3) }, () => pick(rng, WORDS)),
    updatedAt: timestamp(rng),
  }));
  return JSON.stringify(records);
}

/** A chatty build/test log: lots of routine lines, a few real failures. */
function genBuildLog(rng: () => number): string {
  const lines: string[] = ['> app@1.0.0 build', '> tsc -p . && vite build', ''];
  for (let i = 0; i < 380; i += 1) {
    const roll = rng();
    if (roll < 0.04) {
      lines.push(`FAIL  src/${pick(rng, WORDS)}/${pick(rng, WORDS)}.test.ts > case ${int(rng, 1, 40)}`);
      lines.push(`  AssertionError: expected ${int(rng, 1, 9)} to equal ${int(rng, 10, 20)}`);
    } else if (roll < 0.1) {
      lines.push(`warning: '${pick(rng, WORDS)}' is declared but never used (TS6133)`);
    } else {
      lines.push(
        `[${timestamp(rng)}] ${pick(rng, LEVELS)}: compiled module ${pick(rng, WORDS)}/${pick(rng, WORDS)} in ${int(rng, 1, 240)}ms`,
      );
    }
  }
  lines.push('Tests: 3 failed, 377 passed, 380 total');
  return lines.join('\n');
}

/** ripgrep-style search results: file:line:content across many files. */
function genGrepResults(rng: () => number): string {
  const lines: string[] = [];
  for (let f = 0; f < 18; f += 1) {
    const file = `src/${pick(rng, WORDS)}/${pick(rng, WORDS)}.ts`;
    const hits = int(rng, 18, 34);
    for (let h = 0; h < hits; h += 1) {
      const lineNo = int(rng, 1, 900);
      lines.push(`${file}:${lineNo}:    logger.debug('${pick(rng, WORDS)} step', { id, phase });`);
    }
  }
  return lines.join('\n');
}

/** A CSV export with a header row and many uniform data rows. */
function genCsv(rng: () => number): string {
  const rows: string[] = ['id,sku,warehouse,quantity,price_cents,updated_at'];
  for (let i = 0; i < 260; i += 1) {
    rows.push(
      `${i + 1},SKU-${int(rng, 1000, 9999)},${pick(rng, CITIES)},${int(rng, 0, 5000)},${int(rng, 199, 250_00)},${timestamp(rng)}`,
    );
  }
  return rows.join('\n');
}

/** A realistically sized generated module for the file-read path. */
function genModule(rng: () => number): string {
  const parts = ['// Generated reporting helpers.', ''];
  for (let i = 0; i < 130; i += 1) {
    const name = `${pick(rng, WORDS)}${i}`;
    parts.push(
      `export function ${name}(rows) {`,
      `  const total = rows.reduce((sum, row) => sum + row.amountCents, 0);`,
      `  return { index: ${i}, label: '${name}', total, average: rows.length ? total / rows.length : 0 };`,
      `}`,
      '',
    );
  }
  return parts.join('\n');
}

/** A mixed dump: a short log, an embedded JSON blob, and a small table. */
function genMixed(rng: () => number): string {
  const log = Array.from(
    { length: 60 },
    () => `[${timestamp(rng)}] ${pick(rng, LEVELS)}: synced ${pick(rng, WORDS)} (${int(rng, 1, 999)} items)`,
  );
  const json = JSON.stringify(
    Array.from({ length: 40 }, (_, i) => ({ id: i, city: pick(rng, CITIES), n: int(rng, 0, 9999) })),
  );
  const table = ['name,city,score', ...Array.from({ length: 40 }, (_, i) => `${pick(rng, WORDS)}${i},${pick(rng, CITIES)},${int(rng, 0, 100)}`)];
  return [...log, '', '--- payload.json ---', json, '', '--- scores.csv ---', ...table].join('\n');
}

/**
 * Build the full, deterministic scenario set for a seed. Exposed on its own so
 * tests can assert byte-for-byte determinism independent of the engine.
 */
export function generateProofScenarios(seed: number = DEFAULT_PROOF_SEED): ProofScenario[] {
  const rng = mulberry32(seed);
  return [
    { name: 'JSON API results (160 records)', kind: 'tool', tool: 'fetch', payload: genJsonResults(rng) },
    { name: 'build/test log (380 lines)', kind: 'command', tool: 'npm run build', payload: genBuildLog(rng) },
    { name: 'grep results (~18 files)', kind: 'tool', tool: 'grep', payload: genGrepResults(rng) },
    { name: 'CSV export (260 rows)', kind: 'tool', tool: 'shell', payload: genCsv(rng) },
    { name: 'file re-read (unchanged 650-line module)', kind: 'file', tool: 'read_file', filePath: 'src/generated-report.js', payload: genModule(rng) },
    { name: 'mixed dump (log + json + csv)', kind: 'command', tool: 'cat dump.txt', payload: genMixed(rng) },
  ];
}

/** Re-expand every marker and confirm the bytes come back exactly. */
function assertRecoverable(engine: CompressionEngine, scenario: string, text: string): number {
  const markers = parseMarkers(text);
  for (const marker of markers) {
    const slice = engine.retrieve({
      id: marker.id,
      startLine: marker.startLine,
      endLine: marker.endLine,
      maxLines: 1_000_000,
    });
    const source = engine.store.get(marker.id);
    if (source === undefined) {
      throw new Error(`${scenario}: artifact ${marker.id} is missing from the store`);
    }
    const expected = source
      .split('\n')
      .slice(marker.startLine - 1, marker.endLine)
      .join('\n');
    if (slice.text !== expected) {
      throw new Error(
        `${scenario}: retrieving ${marker.id} lines ${marker.startLine}-${marker.endLine} did not round-trip`,
      );
    }
  }
  return markers.length;
}

/**
 * Run the seeded proof table end-to-end and return the measured rows plus the
 * ledger summary. Creates an isolated, temporary artifact store so it never
 * touches the user's real ledger, and cleans it up before returning.
 *
 * @throws if any emitted marker fails to reconstruct byte-for-byte.
 */
export function runProofTable(options: { seed?: number; rootDir?: string } = {}): ProofTable {
  const seed = options.seed ?? DEFAULT_PROOF_SEED;
  const ownRoot = options.rootDir === undefined;
  const rootDir = options.rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-proof-'));
  // Fixed, machine-independent virtual paths. The engine renders the file path
  // and the command cwd into its output, so using the volatile temp `rootDir`
  // there would make the token counts depend on the random directory name.
  // A constant, forward-slashed root keeps the numbers identical on every
  // machine and OS (compressFileRead consumes the path verbatim).
  const PROOF_CWD = '/slipstream-proof';
  try {
    const engine = new CompressionEngine({ rootDir, workspaceRoots: [rootDir] });
    const rows: ProofRow[] = [];

    for (const scenario of generateProofScenarios(seed)) {
      let output: ToolOutput;
      if (scenario.kind === 'file') {
        const filePath = `${PROOF_CWD}/${scenario.filePath ?? 'generated.txt'}`;
        // A first read warms the store; the recorded pass is the unchanged
        // re-read, which is where the read lifecycle actually pays (the model
        // has already been given these bytes, so they collapse to a pointer).
        engine.compressFileRead({ path: filePath, content: scenario.payload });
        output = engine.compressFileRead({ path: filePath, content: scenario.payload });
      } else if (scenario.kind === 'command') {
        output = engine.compressCommandOutput({
          command: scenario.tool,
          cwd: PROOF_CWD,
          exitCode: 0,
          stdout: scenario.payload,
          stderr: '',
          durationMs: 0,
        });
      } else {
        output = engine.compressToolResult({ toolName: scenario.tool, cwd: PROOF_CWD, text: scenario.payload });
      }

      const markers = assertRecoverable(engine, scenario.name, output.text);
      const detail =
        output.strategy.startsWith('passthrough')
          ? output.strategy
          : `${output.strategy}; ${output.linesBefore}\u2192${output.linesAfter} lines, ${markers} marker(s)`;
      rows.push({
        scenario: scenario.name,
        before: output.tokensBefore,
        after: output.tokensAfter,
        saved: output.tokensBefore - output.tokensAfter,
        detail,
      });
    }

    return { seed, rows, summary: engine.summary() };
  } finally {
    if (ownRoot) fs.rmSync(rootDir, { recursive: true, force: true });
  }
}
