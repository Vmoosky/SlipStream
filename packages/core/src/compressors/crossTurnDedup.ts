import type { LineRange } from '../types.js';
import { lineTemplate } from './nearDupCompressor.js';

export interface CrossTurnDedupConfig {
  /** A repeat must span at least this many lines to be worth a pointer. */
  minLines: number;
  /** ...and at least this many characters. */
  minChars: number;
  /**
   * A *near*-duplicate run (template-equal, not byte-equal) must span at least
   * this many lines. Held higher than `minLines` because a near match tells the
   * model less than an exact one, so it has to save more to be worth a marker.
   */
  minNearLines: number;
  /** When false, only byte-identical runs are matched. */
  nearDup: boolean;
  /** Bound the work done per seed line. */
  maxCandidatesPerSeed: number;
  /** Bound total memory held by the session index. */
  maxIndexedLines: number;
}

export const DEFAULT_DEDUP_CONFIG: CrossTurnDedupConfig = {
  minLines: 3,
  minChars: 120,
  minNearLines: 6,
  nearDup: true,
  maxCandidatesPerSeed: 12,
  maxIndexedLines: 200_000,
};

export interface DedupMatch {
  /** 0-based offset into the lines passed to `find`. */
  start: number;
  length: number;
  sourceArtifactId: string;
  sourceLabel: string;
  /** 1-based inclusive range within the source artifact. */
  source: LineRange;
  /**
   * True when every matched line is byte-identical to the source.
   *
   * This distinction is a correctness boundary, not a cosmetic one. An exact
   * run may be replaced by a pointer *into the source artifact*, because
   * retrieving the source returns precisely the bytes that were removed. A near
   * run must NOT be: the differing bytes (a counter, timestamp or hash) exist
   * only in the current output, so its marker has to point at the current
   * artifact instead. Callers must branch on this.
   */
  exact: boolean;
}

interface IndexedSource {
  id: string;
  label: string;
  lines: string[];
}

export interface DedupPersistence {
  hash(line: string): string;
  candidates(hash: string): Array<{ id: string; lineNo: number }>;
  label(id: string): string | undefined;
  record(id: string, label: string, lines: readonly string[]): void;
  touch(id: string): void;
  clear(): void;
  /**
   * Optional near-duplicate lookup, keyed by normalized line template.
   *
   * Both are optional so an index written by an older build (which has no
   * template seeds on disk) still works: it simply yields no near candidates
   * and cross-session dedup falls back to exact matching. No migration needed.
   */
  templateHash?(template: string): string;
  templateCandidates?(hash: string): Array<{ id: string; lineNo: number }>;
}

export interface DedupDeps {
  /**
   * Durable index shared across processes/producers. When present, `find` also
   * consults it and `register` writes to it, so dedup reaches across sessions.
   */
  persistence?: DedupPersistence;
  /**
   * Load a persisted source's lines (from the shared artifact store) so a
   * cross-session run can be verified byte-for-byte. Returning undefined means
   * the source is gone, so no pointer is emitted for it.
   */
  loadSource?: (id: string) => string[] | undefined;
}

/**
 * Replaces text we have already handed to the model with a pointer to where it
 * was first returned.
 *
 * Invariants:
 *  - keep-earliest: the first occurrence is never rewritten;
 *  - prefix-monotonic: a run can only reference output produced earlier;
 *  - every match is verified line by line against the source before it is
 *    emitted — nothing is matched on a hash alone.
 *
 * Matches come in two flavours and the difference is a correctness boundary:
 *  - `exact` runs are byte-identical to the source, so they may be replaced by
 *    a pointer *into the source artifact*;
 *  - near runs are only template-identical (a counter, timestamp or hash
 *    differs). Those differing bytes exist nowhere but the current output, so a
 *    near run must be pointed at the *current* artifact. See `DedupMatch.exact`.
 *
 * The in-memory index covers the current process. An optional persistence
 * backend extends the same guarantees across sessions and producers: persisted
 * candidates are verified against source lines lazily loaded from the shared
 * artifact store, so a pointer is only emitted when its source still exists.
 */
export class CrossTurnDedup {
  private readonly config: CrossTurnDedupConfig;
  private readonly sources = new Map<string, IndexedSource>();
  private readonly lineIndex = new Map<string, Array<{ id: string; lineNo: number }>>();
  private readonly templateIndex = new Map<string, Array<{ id: string; lineNo: number }>>();
  private readonly order: string[] = [];
  private indexedLines = 0;
  private persistence: DedupPersistence | undefined;
  private readonly loadSource: ((id: string) => string[] | undefined) | undefined;

  constructor(config: Partial<CrossTurnDedupConfig> = {}, deps: DedupDeps = {}) {
    this.config = { ...DEFAULT_DEDUP_CONFIG, ...config };
    this.persistence = deps.persistence;
    this.loadSource = deps.loadSource;
  }

  /** Index an output so later outputs can point back at it. */
  register(artifactId: string, lines: readonly string[], label: string): void {
    if (this.sources.has(artifactId)) {
      return;
    }
    const copy = [...lines];
    this.sources.set(artifactId, { id: artifactId, label, lines: copy });
    this.order.push(artifactId);
    for (let i = 0; i < copy.length; i++) {
      const line = copy[i] ?? '';
      if (!isSeedable(line)) {
        continue;
      }
      pushEntry(this.lineIndex, line, { id: artifactId, lineNo: i + 1 });
      if (this.config.nearDup) {
        const template = lineTemplate(line);
        // Only index templates that still carry enough real content to be a
        // selective key; `Processed # of #` would otherwise match everything.
        if (template !== line && isSeedableTemplate(template)) {
          pushEntry(this.templateIndex, template, { id: artifactId, lineNo: i + 1 });
        }
      }
    }
    this.indexedLines += copy.length;
    this.evictIfNeeded();
    this.persistence?.record(artifactId, label, copy);
  }

  /** Find non-overlapping runs of `lines` that were already returned earlier. */
  find(lines: readonly string[]): DedupMatch[] {
    const matches: DedupMatch[] = [];
    const { minLines, minNearLines, minChars, maxCandidatesPerSeed, nearDup } = this.config;
    // Cache lazily-loaded persisted sources for the span of this call. `null`
    // records a source that could not be loaded (evicted) so we skip it once.
    const loadedSources = new Map<string, string[] | null>();
    const sourceLines = (id: string): string[] | undefined => {
      const inMemory = this.sources.get(id);
      if (inMemory) return inMemory.lines;
      if (loadedSources.has(id)) return loadedSources.get(id) ?? undefined;
      const loaded = this.loadSource?.(id);
      loadedSources.set(id, loaded ?? null);
      return loaded;
    };
    // Templates of the incoming lines, computed once and reused across
    // candidates, since near matching compares them repeatedly.
    const templates: Array<string | undefined> = new Array(lines.length);
    const templateAt = (index: number): string => {
      const cached = templates[index];
      if (cached !== undefined) return cached;
      const computed = lineTemplate(lines[index] ?? '');
      templates[index] = computed;
      return computed;
    };

    let i = 0;
    while (i < lines.length) {
      const seed = lines[i] ?? '';
      if (!isSeedable(seed)) {
        i++;
        continue;
      }

      const candidates: Array<{ id: string; lineNo: number }> = [];
      const inMemory = this.lineIndex.get(seed);
      if (inMemory) {
        for (const candidate of inMemory) candidates.push(candidate);
      }
      if (this.persistence) {
        for (const candidate of this.persistence.candidates(this.persistence.hash(seed))) {
          candidates.push(candidate);
        }
      }
      if (nearDup) {
        const seedTemplate = templateAt(i);
        if (isSeedableTemplate(seedTemplate)) {
          const nearMemory = this.templateIndex.get(seedTemplate);
          if (nearMemory) {
            for (const candidate of nearMemory) candidates.push(candidate);
          }
          const templateHash = this.persistence?.templateHash;
          const templateCandidates = this.persistence?.templateCandidates;
          if (templateHash && templateCandidates) {
            const hash = templateHash.call(this.persistence, seedTemplate);
            for (const candidate of templateCandidates.call(this.persistence, hash)) {
              candidates.push(candidate);
            }
          }
        }
      }
      if (candidates.length === 0) {
        i++;
        continue;
      }

      let bestExact: DedupMatch | undefined;
      let bestNear: DedupMatch | undefined;
      const tried = new Set<string>();
      for (const candidate of candidates) {
        if (tried.size >= maxCandidatesPerSeed) break;
        const key = `${candidate.id}:${candidate.lineNo}`;
        if (tried.has(key)) continue;
        tried.add(key);

        const source = sourceLines(candidate.id);
        if (!source) {
          continue;
        }

        // Extend twice from the same origin: `exactLength` requires byte
        // equality, `nearLength` only template equality. Byte equality implies
        // template equality, so nearLength >= exactLength always.
        let exactLength = 0;
        let nearLength = 0;
        let stillExact = true;
        while (i + nearLength < lines.length && candidate.lineNo - 1 + nearLength < source.length) {
          const mine = lines[i + nearLength] ?? '';
          const theirs = source[candidate.lineNo - 1 + nearLength] ?? '';
          if (stillExact && mine === theirs) {
            exactLength++;
          } else {
            stillExact = false;
            if (!nearDup) break;
            if (templateAt(i + nearLength) !== lineTemplate(theirs)) break;
          }
          nearLength++;
        }

        const label = this.sources.get(candidate.id)?.label ?? this.persistence?.label(candidate.id) ?? '';
        if (exactLength > 0 && (!bestExact || exactLength > bestExact.length)) {
          bestExact = {
            start: i,
            length: exactLength,
            sourceArtifactId: candidate.id,
            sourceLabel: label,
            source: { startLine: candidate.lineNo, endLine: candidate.lineNo + exactLength - 1 },
            exact: true,
          };
        }
        if (nearDup && nearLength > 0 && (!bestNear || nearLength > bestNear.length)) {
          bestNear = {
            start: i,
            length: nearLength,
            sourceArtifactId: candidate.id,
            sourceLabel: label,
            source: { startLine: candidate.lineNo, endLine: candidate.lineNo + nearLength - 1 },
            exact: false,
          };
        }
      }

      // Prefer an exact match whenever one qualifies: it points straight at the
      // source artifact and tells the model strictly more. A near match has to
      // clear a higher line bar to be worth its (weaker) marker.
      const qualifies = (match: DedupMatch | undefined, minRun: number): match is DedupMatch =>
        match !== undefined && match.length >= minRun && charSpan(lines, i, match.length) >= minChars;

      let best: DedupMatch | undefined;
      if (qualifies(bestExact, minLines)) {
        best = bestExact;
      } else if (qualifies(bestNear, minNearLines)) {
        best = bestNear;
      }

      if (best) {
        // Keep the referenced source alive: retention must not drop a source we
        // just pointed at, or the pointer would dangle.
        if (!this.sources.has(best.sourceArtifactId)) {
          this.persistence?.touch(best.sourceArtifactId);
        }
        matches.push(best);
        i += best.length;
      } else {
        i++;
      }
    }

    return matches;
  }

  /**
   * Forget in-memory session state.
   *
   * `detachPersistence` also stops this engine from consulting or writing the
   * shared cross-session index for the rest of the process, so a user-triggered
   * "forget" genuinely stops deduplicating against earlier sessions.
   */
  reset(opts: { detachPersistence?: boolean } = {}): void {
    this.sources.clear();
    this.lineIndex.clear();
    this.templateIndex.clear();
    this.order.length = 0;
    this.indexedLines = 0;
    if (opts.detachPersistence) {
      this.persistence = undefined;
    }
  }

  /** Wipe the shared on-disk index (used when all artifacts are purged). */
  clearPersistent(): void {
    this.persistence?.clear();
  }

  private evictIfNeeded(): void {
    while (this.indexedLines > this.config.maxIndexedLines && this.order.length > 1) {
      const oldest = this.order.shift();
      if (!oldest) {
        break;
      }
      const source = this.sources.get(oldest);
      if (!source) {
        continue;
      }
      for (const line of source.lines) {
        removeEntry(this.lineIndex, line, oldest);
        if (this.config.nearDup) {
          const template = lineTemplate(line);
          if (template !== line) removeEntry(this.templateIndex, template, oldest);
        }
      }
      this.indexedLines -= source.lines.length;
      this.sources.delete(oldest);
    }
  }
}

function pushEntry(
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

function removeEntry(
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

/** Short or structural lines (`}`, blank, `---`) make useless match seeds. */
export function isSeedable(line: string): boolean {
  return line.trim().length >= 12;
}

/**
 * A template is only a useful near-dup key if enough of it is real content
 * rather than `#` placeholders — otherwise a line like `[#] #% (#/#)` would
 * match wildly unrelated output.
 */
export function isSeedableTemplate(template: string): boolean {
  let content = 0;
  for (const ch of template) {
    if (ch !== '#' && !/\s/.test(ch)) content++;
  }
  return content >= 12;
}

function charSpan(lines: readonly string[], start: number, length: number): number {
  let total = 0;
  for (let i = start; i < start + length; i++) {
    total += (lines[i] ?? '').length;
  }
  return total;
}
