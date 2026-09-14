/**
 * Retrieval fidelity guard.
 *
 * Slipstream's core promise is different from lossy context compressors: every
 * range it omits behind a `[[slipstream:… L…-…]]` marker must be recoverable
 * **byte-for-byte** from the artifact store. This module turns that implicit
 * invariant into something checkable — by a test suite over representative
 * output, and (later) by a `slipstream doctor` round-trip probe.
 *
 * Two entry points:
 *   - `verifyMarkerFidelity` audits a rendered payload: for every marker it
 *     confirms the referenced artifact is still present and that reading the
 *     marked range back returns exactly the artifact's own bytes for that range.
 *     It surfaces the failure the retention system must never allow — a marker
 *     that outlives (or mismatches) its source.
 *   - `reconstructFromArtifacts` expands every marker inline, rebuilding the full
 *     pre-omission text so callers can assert it equals the original input.
 */

import type { ArtifactStore } from './artifactStore.js';
import { parseMarkers } from './markers.js';

/** The subset of the store the guard needs; keeps it easy to stub in tests. */
export type FidelityStore = Pick<ArtifactStore, 'get' | 'slice'>;

export type FidelityFailureReason =
  | 'artifact-missing'
  | 'range-mismatch'
  | 'truncated';

export interface FidelityFailure {
  artifactId: string;
  startLine: number;
  endLine: number;
  reason: FidelityFailureReason;
  /** The bytes the store holds for the range (present for a mismatch). */
  expected?: string;
  /** The bytes retrieval returned for the range (present for a mismatch). */
  actual?: string;
}

export interface FidelityReport {
  ok: boolean;
  markersChecked: number;
  failures: FidelityFailure[];
}

/** Store slices are capped per call; page through larger ranges. */
const MAX_SLICE_LINES = 5000;

const BANNER_RE = /^--- slipstream:.*---$/;

/** Read a full line range from the store, paging around the per-call slice cap. */
function readRange(
  store: FidelityStore,
  id: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const parts: string[] = [];
  let cursor = startLine;
  while (cursor <= endLine) {
    const chunkEnd = Math.min(endLine, cursor + MAX_SLICE_LINES - 1);
    const result = store.slice(id, {
      startLine: cursor,
      endLine: chunkEnd,
      maxLines: MAX_SLICE_LINES,
    });
    if (!result || result.truncated) return undefined;
    parts.push(result.text);
    cursor = chunkEnd + 1;
  }
  return parts.join('\n');
}

/** The exact bytes the artifact holds for a line range (its own source of truth). */
function artifactRange(
  store: FidelityStore,
  id: string,
  startLine: number,
  endLine: number,
): string | undefined {
  const content = store.get(id);
  if (content === undefined) return undefined;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

/**
 * Audit every marker in a rendered payload. Returns `ok: true` only when each
 * marked range is still present and reads back byte-for-byte from its artifact.
 */
export function verifyMarkerFidelity(text: string, store: FidelityStore): FidelityReport {
  const markers = parseMarkers(text);
  const failures: FidelityFailure[] = [];

  for (const marker of markers) {
    const { id, startLine, endLine } = marker;
    const expected = artifactRange(store, id, startLine, endLine);
    if (expected === undefined) {
      failures.push({ artifactId: id, startLine, endLine, reason: 'artifact-missing' });
      continue;
    }
    const actual = readRange(store, id, startLine, endLine);
    if (actual === undefined) {
      failures.push({ artifactId: id, startLine, endLine, reason: 'truncated' });
      continue;
    }
    if (actual !== expected) {
      failures.push({
        artifactId: id,
        startLine,
        endLine,
        reason: 'range-mismatch',
        expected,
        actual,
      });
    }
  }

  return { ok: failures.length === 0, markersChecked: markers.length, failures };
}

/**
 * Rebuild the full pre-omission text by expanding every marker line back to its
 * stored range. The leading `--- slipstream: … ---` banner is dropped so the
 * result lines up with the original input. Throws if a referenced range cannot
 * be recovered — callers proving losslessness want that to be loud.
 */
export function reconstructFromArtifacts(text: string, store: FidelityStore): string {
  const lines = text.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    if (BANNER_RE.test(line)) continue;
    const markers = parseMarkers(line);
    // Only treat a line as expandable when it *is* the marker (our renderer puts
    // each marker on its own line); leave incidental matches inside prose alone.
    if (markers.length === 1 && markers[0]!.raw === line) {
      const { id, startLine, endLine } = markers[0]!;
      const recovered = readRange(store, id, startLine, endLine);
      if (recovered === undefined) {
        throw new Error(`fidelity: cannot recover ${id} L${startLine}-${endLine}`);
      }
      out.push(recovered);
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}
