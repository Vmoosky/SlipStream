import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARTIFACT_ID_RE } from '../markers.js';
import { isSeedable, isSeedableTemplate } from './crossTurnDedup.js';
import { lineTemplate } from './nearDupCompressor.js';

export interface PersistentDedupConfig {
  /** Hard cap on retained source outputs. Oldest-accessed dropped first. */
  maxSources: number;
  /** Drop a source whose last use is older than this. Aligns with artifacts. */
  idleTtlMs: number;
  /** Bound seed lines indexed per source so one huge output cannot dominate. */
  maxSeedsPerSource: number;
}

export const DEFAULT_PERSISTENT_DEDUP_CONFIG: PersistentDedupConfig = {
  maxSources: 800,
  idleTtlMs: 60 * 60 * 1000,
  maxSeedsPerSource: 5000,
};

interface PersistedSource {
  id: string;
  label: string;
  lineCount: number;
  createdAt: number;
  lastAccessAt: number;
  /** [seedHash, 1-based lineNo] for each seedable line. */
  seeds: Array<[string, number]>;
  /**
   * [templateHash, 1-based lineNo] for lines whose normalized template is a
   * useful near-dup key. Optional on disk: an index written by an older build
   * simply has none, which degrades to exact-only matching rather than needing
   * a schema version bump and migration.
   */
  templateSeeds: Array<[string, number]>;
}

/**
 * Durable, shared index of seed-line hashes -> {artifactId, lineNo}, backing
 * cross-session / cross-producer dedup.
 *
 * The artifact store already holds the source *content* on disk, shared and
 * content-addressed; this file only holds the lightweight lookup index so a
 * later process (or a different front-end pointed at the same storage dir) can
 * find that a run was already returned earlier. Source lines themselves are
 * lazy-loaded from the artifact store and verified byte-for-byte, so this index
 * never has to store text and a stale entry is harmless: if the source artifact
 * is gone the candidate simply fails to load and no pointer is emitted.
 *
 * Bounded by `maxSources` and an idle TTL that mirrors artifact retention, so it
 * cannot grow without limit or outlive the artifacts it references.
 */
export class PersistentDedupIndex {
  private readonly filePath: string;
  private config: PersistentDedupConfig;
  private sources = new Map<string, PersistedSource>();
  private byHash = new Map<string, Array<{ id: string; lineNo: number }>>();
  private byTemplateHash = new Map<string, Array<{ id: string; lineNo: number }>>();
  private loaded = false;
  private cacheStamp = '';

  constructor(opts: { rootDir: string; config?: Partial<PersistentDedupConfig> }) {
    this.filePath = path.join(opts.rootDir, 'dedup-index.json');
    this.config = { ...DEFAULT_PERSISTENT_DEDUP_CONFIG, ...opts.config };
  }

  /** Stable, process-independent hash used as the seed-line key. */
  hash(line: string): string {
    return seedHash(line);
  }

  candidates(hash: string): Array<{ id: string; lineNo: number }> {
    this.ensureLoaded();
    return this.byHash.get(hash) ?? [];
  }

  /** Stable key for a normalized line template, used for near-dup lookup. */
  templateHash(template: string): string {
    return `t:${seedHash(template)}`;
  }

  templateCandidates(hash: string): Array<{ id: string; lineNo: number }> {
    this.ensureLoaded();
    return this.byTemplateHash.get(hash) ?? [];
  }

  label(id: string): string | undefined {
    this.ensureLoaded();
    return this.sources.get(id)?.label;
  }

  has(id: string): boolean {
    this.ensureLoaded();
    return this.sources.has(id);
  }

  /** Note that a source was just used, so retention keeps it around. */
  touch(id: string): void {
    this.ensureLoaded();
    const source = this.sources.get(id);
    if (!source) return;
    source.lastAccessAt = Date.now();
    this.persist();
  }

  /** Persist an output's seed lines so later processes can dedup against it. */
  record(id: string, label: string, lines: readonly string[]): void {
    if (!ARTIFACT_ID_RE.test(id)) return;
    this.ensureLoaded();
    const now = Date.now();
    const existing = this.sources.get(id);
    if (existing) {
      existing.lastAccessAt = now;
      this.persist();
      return;
    }
    const seeds: Array<[string, number]> = [];
    const templateSeeds: Array<[string, number]> = [];
    for (let i = 0; i < lines.length && seeds.length < this.config.maxSeedsPerSource; i++) {
      const line = lines[i] ?? '';
      if (!isSeedable(line)) continue;
      seeds.push([seedHash(line), i + 1]);
      const template = lineTemplate(line);
      if (template !== line && isSeedableTemplate(template)) {
        templateSeeds.push([this.templateHash(template), i + 1]);
      }
    }
    this.addSource({
      id,
      label: label.slice(0, 200),
      lineCount: lines.length,
      createdAt: now,
      lastAccessAt: now,
      seeds,
      templateSeeds,
    });
    this.evict();
    this.persist();
  }

  /** Drop the whole on-disk index (used when all artifacts are purged). */
  clear(): void {
    this.sources = new Map();
    this.byHash = new Map();
    this.byTemplateHash = new Map();
    this.loaded = true;
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* best effort */
    }
    this.cacheStamp = '';
  }

  updateTtl(idleTtlMs: number): void {
    this.config.idleTtlMs = idleTtlMs;
  }

  // --- internals -------------------------------------------------------

  private addSource(source: PersistedSource): void {
    this.sources.set(source.id, source);
    for (const [h, lineNo] of source.seeds) {
      pushBucket(this.byHash, h, { id: source.id, lineNo });
    }
    for (const [h, lineNo] of source.templateSeeds) {
      pushBucket(this.byTemplateHash, h, { id: source.id, lineNo });
    }
  }

  private removeSource(id: string): void {
    const source = this.sources.get(id);
    if (!source) return;
    for (const [h] of source.seeds) {
      removeBucket(this.byHash, h, id);
    }
    for (const [h] of source.templateSeeds) {
      removeBucket(this.byTemplateHash, h, id);
    }
    this.sources.delete(id);
  }

  private evict(): void {
    const now = Date.now();
    for (const [id, source] of [...this.sources]) {
      if (now - source.lastAccessAt > this.config.idleTtlMs) {
        this.removeSource(id);
      }
    }
    while (this.sources.size > this.config.maxSources) {
      let oldestId: string | undefined;
      let oldest = Infinity;
      for (const [id, source] of this.sources) {
        if (source.lastAccessAt < oldest) {
          oldest = source.lastAccessAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      this.removeSource(oldestId);
    }
  }

  private ensureLoaded(): void {
    let stamp = '';
    try {
      const st = fs.statSync(this.filePath);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      // No file on disk. Keep an already-loaded empty state instead of churning.
      if (this.loaded && this.cacheStamp === '') return;
    }
    if (this.loaded && stamp === this.cacheStamp) return;
    this.load(stamp);
  }

  private load(stamp: string): void {
    this.sources = new Map();
    this.byHash = new Map();
    this.byTemplateHash = new Map();
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const arr =
        parsed && typeof parsed === 'object' && Array.isArray((parsed as { sources?: unknown }).sources)
          ? ((parsed as { sources: unknown[] }).sources)
          : [];
      for (const item of arr) {
        const src = item as Partial<PersistedSource>;
        if (!src || !ARTIFACT_ID_RE.test(String(src.id))) continue;
        this.addSource({
          id: String(src.id),
          label: String(src.label ?? ''),
          lineCount: Number(src.lineCount ?? 0),
          createdAt: Number(src.createdAt ?? Date.now()),
          lastAccessAt: Number(src.lastAccessAt ?? Date.now()),
          seeds: readSeedPairs(src.seeds),
          // Absent in indexes written before near-dup support; an empty list
          // just means this source can only be matched exactly.
          templateSeeds: readSeedPairs(src.templateSeeds),
        });
      }
      this.evict();
    } catch {
      // Missing or corrupt index is not fatal; dedup just misses cross-session.
    }
    this.loaded = true;
    this.cacheStamp = stamp;
  }

  private persist(): void {
    try {
      const payload = { version: 1, sources: [...this.sources.values()] };
      fs.writeFileSync(this.filePath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      const st = fs.statSync(this.filePath);
      this.cacheStamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      /* best effort */
    }
  }
}

function pushBucket(
  index: Map<string, Array<{ id: string; lineNo: number }>>,
  key: string,
  entry: { id: string; lineNo: number },
): void {
  const bucket = index.get(key);
  if (bucket) {
    bucket.push(entry);
  } else {
    index.set(key, [entry]);
  }
}

function removeBucket(
  index: Map<string, Array<{ id: string; lineNo: number }>>,
  key: string,
  id: string,
): void {
  const bucket = index.get(key);
  if (!bucket) return;
  const filtered = bucket.filter((entry) => entry.id !== id);
  if (filtered.length === 0) {
    index.delete(key);
  } else {
    index.set(key, filtered);
  }
}

/** Tolerantly read `[hash, lineNo]` pairs from untrusted on-disk JSON. */
function readSeedPairs(value: unknown): Array<[string, number]> {
  return Array.isArray(value)
    ? value.filter(
        (s): s is [string, number] =>
          Array.isArray(s) && s.length === 2 && typeof s[0] === 'string' && typeof s[1] === 'number',
      )
    : [];
}

/**
 * FNV-1a over the line, salted with its length. Non-cryptographic and fast; a
 * collision only costs a byte-for-byte verification that then fails, so it is
 * never a correctness risk. Length in the key makes accidental collisions rare.
 */
function seedHash(line: string): string {  let h = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    h ^= line.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}:${line.length}`;
}
