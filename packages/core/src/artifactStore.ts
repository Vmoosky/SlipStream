import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARTIFACT_ID_RE } from './markers.js';
import type { ArtifactMeta } from './types.js';

export interface ArtifactStoreOptions {
  /** Directory that will hold `artifacts/` and `index.json`. */
  rootDir: string;
  /** Evict artifacts untouched for this long. Default 60 minutes. */
  idleTtlMs?: number;
  /** Hard cap on retained artifacts. Default 2000. */
  maxEntries?: number;
  /** Hard cap on retained bytes. Default 256 MiB. */
  maxTotalBytes?: number;
  /**
   * Called with ids dropped by retention. Markers pointing at them can no
   * longer be expanded, which is different from never having been needed.
   */
  onEvict?: (ids: readonly string[]) => void;
}

export interface SliceOptions {
  startLine?: number;
  endLine?: number;
  /** Case-insensitive substring or /regex/ filter applied to lines. */
  grep?: string;
  /** Never return more than this many lines. Default 400. */
  maxLines?: number;
}

export interface SliceResult {
  text: string;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  label: string;
}

export interface ArtifactRetentionPolicy {
  idleTtlMs: number;
  maxEntries: number;
  maxTotalBytes: number;
}

const DEFAULTS = {
  idleTtlMs: 60 * 60 * 1000,
  maxEntries: 2000,
  maxTotalBytes: 256 * 1024 * 1024,
};

/**
 * Content-addressed store for the original, uncompressed bytes.
 *
 * This is what makes compression reversible: every marker we emit points at a
 * line range of an artifact kept here, so the model can recover exactly what
 * was dropped. Storage is local-only and purgeable.
 */
export class ArtifactStore {
  private readonly rootDir: string;
  private readonly artifactDir: string;
  private readonly indexPath: string;
  private idleTtlMs: number;
  private maxEntries: number;
  private maxTotalBytes: number;
  private index = new Map<string, ArtifactMeta>();
  private readonly onEvict: ((ids: readonly string[]) => void) | undefined;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.artifactDir = path.join(this.rootDir, 'artifacts');
    this.indexPath = path.join(this.rootDir, 'index.json');
    this.idleTtlMs = options.idleTtlMs ?? DEFAULTS.idleTtlMs;
    this.maxEntries = options.maxEntries ?? DEFAULTS.maxEntries;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULTS.maxTotalBytes;
    this.onEvict = options.onEvict;
    fs.mkdirSync(this.artifactDir, { recursive: true });
    this.loadIndex();
  }

  /** Store content and return its metadata. Identical content is deduplicated. */
  put(content: string, opts: { label: string; kind: string }): ArtifactMeta {
    this.loadIndex();
    const id = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 12);
    const now = Date.now();
    const existing = this.index.get(id);
    if (existing && fs.existsSync(this.pathFor(id))) {
      existing.lastAccessAt = now;
      this.saveIndex();
      return existing;
    }
    const meta: ArtifactMeta = {
      id,
      label: opts.label.slice(0, 200),
      kind: opts.kind,
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: countLines(content),
      createdAt: now,
      lastAccessAt: now,
    };
    fs.writeFileSync(this.pathFor(id), content, { encoding: 'utf8', mode: 0o600 });
    this.index.set(id, meta);
    this.sweep();
    this.saveIndex();
    return meta;
  }

  get(id: string): string | undefined {
    const meta = this.stat(id);
    if (!meta) {
      return undefined;
    }
    try {
      const content = fs.readFileSync(this.pathFor(id), 'utf8');
      meta.lastAccessAt = Date.now();
      this.saveIndex();
      return content;
    } catch {
      this.index.delete(id);
      this.saveIndex();
      return undefined;
    }
  }

  /**
   * Read stored content without recording an access or mutating the index.
   *
   * Used by cross-session dedup to verify a candidate source byte-for-byte
   * before pointing at it. Returning undefined when the file is gone is what
   * guarantees a dedup pointer never outlives its source: an evicted artifact
   * simply fails to load, so no marker is emitted for it.
   */
  readContent(id: string): string | undefined {
    if (!ARTIFACT_ID_RE.test(id)) {
      return undefined;
    }
    try {
      return fs.readFileSync(this.pathFor(id), 'utf8');
    } catch {
      return undefined;
    }
  }

  stat(id: string): ArtifactMeta | undefined {
    // Guard before the id ever reaches the filesystem.
    if (!ARTIFACT_ID_RE.test(id)) {
      return undefined;
    }
    this.loadIndex();
    return this.index.get(id);
  }

  retentionPolicy(): ArtifactRetentionPolicy {
    return {
      idleTtlMs: this.idleTtlMs,
      maxEntries: this.maxEntries,
      maxTotalBytes: this.maxTotalBytes,
    };
  }

  updateRetention(policy: Partial<ArtifactRetentionPolicy>): void {
    if (policy.idleTtlMs !== undefined) {
      this.idleTtlMs = policy.idleTtlMs;
    }
    if (policy.maxEntries !== undefined) {
      this.maxEntries = policy.maxEntries;
    }
    if (policy.maxTotalBytes !== undefined) {
      this.maxTotalBytes = policy.maxTotalBytes;
    }
    this.sweep();
    this.saveIndex();
  }

  /** Read a bounded window of an artifact, optionally filtered. */
  slice(id: string, opts: SliceOptions = {}): SliceResult | undefined {
    const meta = this.stat(id);
    const content = this.get(id);
    if (!meta || content === undefined) {
      return undefined;
    }
    const all = content.split('\n');
    const maxLines = clampInt(opts.maxLines ?? 400, 1, 5000);

    const start = clampInt(opts.startLine ?? 1, 1, Math.max(all.length, 1));
    const end = clampInt(opts.endLine ?? all.length, start, Math.max(all.length, 1));
    let window = all.slice(start - 1, end);
    let offset = start;

    if (opts.grep) {
      const match = buildMatcher(opts.grep);
      const filtered: string[] = [];
      for (let i = 0; i < window.length; i++) {
        const line = window[i] ?? '';
        if (match(line)) {
          filtered.push(`${offset + i}: ${line}`);
        }
      }
      window = filtered;
      const truncated = window.length > maxLines;
      return {
        text: window.slice(0, maxLines).join('\n'),
        totalLines: all.length,
        returnedLines: Math.min(window.length, maxLines),
        truncated,
        label: meta.label,
      };
    }

    const truncated = window.length > maxLines;
    return {
      text: window.slice(0, maxLines).join('\n'),
      totalLines: all.length,
      returnedLines: Math.min(window.length, maxLines),
      truncated,
      label: meta.label,
    };
  }

  size(): { entries: number; bytes: number } {
    this.loadIndex();
    return this.currentSize();
  }

  private currentSize(): { entries: number; bytes: number } {
    let bytes = 0;
    for (const meta of this.index.values()) {
      bytes += meta.bytes;
    }
    return { entries: this.index.size, bytes };
  }

  /** Delete every stored artifact. Exposed as a user-facing command. */
  purgeAll(): number {
    this.loadIndex();
    const count = this.index.size;
    const purged = [...this.index.keys()];
    for (const id of purged) {
      this.unlink(id);
    }
    this.index.clear();
    this.saveIndex();
    // Purged content is unretrievable for the same reason evicted content is,
    // so markers pointing at it must not look like they were never needed.
    if (purged.length > 0) {
      this.onEvict?.(purged);
    }
    return count;
  }

  private pathFor(id: string): string {
    if (!ARTIFACT_ID_RE.test(id)) {
      throw new Error(`Invalid artifact id: ${JSON.stringify(id)}`);
    }
    return path.join(this.artifactDir, `${id}.txt`);
  }

  private unlink(id: string): void {
    try {
      fs.rmSync(this.pathFor(id), { force: true });
    } catch {
      /* best effort */
    }
  }

  /** Evict by idle TTL, then by count, then by total bytes (oldest access first). */
  private sweep(): void {
    const now = Date.now();
    const evicted: string[] = [];
    const drop = (id: string): void => {
      this.unlink(id);
      this.index.delete(id);
      evicted.push(id);
    };

    for (const [id, meta] of this.index) {
      if (now - meta.lastAccessAt > this.idleTtlMs) {
        drop(id);
      }
    }
    const byAge = () =>
      [...this.index.entries()].sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt);

    while (this.index.size > this.maxEntries) {
      const oldest = byAge()[0];
      if (!oldest) {
        break;
      }
      drop(oldest[0]);
    }

    let total = this.currentSize().bytes;
    while (total > this.maxTotalBytes) {
      const oldest = byAge()[0];
      if (!oldest) {
        break;
      }
      total -= oldest[1].bytes;
      drop(oldest[0]);
    }

    if (evicted.length > 0) {
      this.onEvict?.(evicted);
    }
  }

  private loadIndex(): void {
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const next = new Map<string, ArtifactMeta>();
      for (const item of parsed) {
        const meta = item as ArtifactMeta;
        if (meta && ARTIFACT_ID_RE.test(String(meta.id))) {
          next.set(meta.id, meta);
        }
      }
      this.index = next;
    } catch {
      // Missing or corrupt index is not fatal; artifacts are just unreachable.
    }
  }

  private saveIndex(): void {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify([...this.index.values()]), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      /* best effort */
    }
  }
}

function countLines(content: string): number {
  if (content === '') {
    return 0;
  }
  let n = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) {
      n++;
    }
  }
  return n;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(Math.max(n, min), max);
}

/**
 * Build a line matcher from a user-supplied pattern.
 *
 * `/foo/i` is treated as a regex, anything else as a literal substring, so a
 * plain search string containing regex metacharacters cannot be misread as a
 * pattern. Invalid regexes fall back to substring matching.
 */
function buildMatcher(pattern: string): (line: string) => boolean {
  const delimited = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  if (delimited) {
    const [, source = '', flags = ''] = delimited;
    try {
      const re = new RegExp(source, flags.replace(/g/g, ''));
      return (line) => re.test(line);
    } catch {
      /* fall through to substring */
    }
  }
  const needle = pattern.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}
