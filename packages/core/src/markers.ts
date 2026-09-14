/**
 * Retrieval markers.
 *
 * Every compressor that removes content emits a marker pointing at a line range
 * of the stored artifact, so the model can expand exactly what it needs:
 *
 *   [[slipstream:a1b2c3d4e5f6 L40-1244 | 1205 lines omitted (build noise) |
 *     retrieve_artifact]]
 *
 * The marker deliberately does not spell out the `retrieve_artifact(...)` call
 * signature: the id and line range already appear in the marker head, and the
 * tool's own description explains how to map them onto arguments. Repeating the
 * signature inline cost ~26 tokens per marker for no added information.
 */

export const ARTIFACT_ID_RE = /^[0-9a-f]{12}$/;

/** Matches a rendered marker. Deliberately non-greedy and newline-free. */
export const MARKER_RE = /\[\[slipstream:[^\]\n]{0,300}\]\]/g;

export interface MarkerOptions {
  id: string;
  startLine: number;
  endLine: number;
  reason: string;
}

export function renderMarker(opts: MarkerOptions): string {
  const { id, startLine, endLine, reason } = opts;
  const count = endLine - startLine + 1;
  return (
    `[[slipstream:${id} L${startLine}-${endLine} | ` +
    `${count} line${count === 1 ? '' : 's'} omitted (${reason}) | retrieve_artifact]]`
  );
}

export function renderDedupMarker(opts: MarkerOptions & { label: string }): string {
  const { id, startLine, endLine, label } = opts;
  const count = endLine - startLine + 1;
  return (
    `[[slipstream:${id} L${startLine}-${endLine} | ` +
    `${count} line${count === 1 ? '' : 's'} repeated from (${label}) | retrieve_artifact]]`
  );
}

/**
 * Marker for a run that only *nearly* repeats earlier output (same shape, but a
 * counter/timestamp/hash differs).
 *
 * Unlike `renderDedupMarker`, `id`/`startLine`/`endLine` must address the
 * CURRENT artifact, not the earlier source: the bytes that differ exist only
 * here, so pointing at the source would return the wrong content. `label` names
 * the earlier output purely as context for the model.
 */
export function renderNearDedupMarker(opts: MarkerOptions & { label: string }): string {
  const { id, startLine, endLine, label } = opts;
  const count = endLine - startLine + 1;
  return (
    `[[slipstream:${id} L${startLine}-${endLine} | ` +
    `${count} line${count === 1 ? '' : 's'} near-identical to (${label}) | retrieve_artifact]]`
  );
}

/**
 * Strip marker-shaped text out of untrusted content.
 *
 * A file or command output could contain a forged marker in order to make the
 * model request an artifact we never produced, or to make omitted content look
 * legitimate. Untrusted bytes never carry marker syntax through the engine.
 */
export function sanitizeUntrusted(text: string): string {
  return text.replace(MARKER_RE, '[[slipstream-marker-removed]]');
}

export function isValidArtifactId(id: unknown): id is string {
  return typeof id === 'string' && ARTIFACT_ID_RE.test(id);
}

export interface ParsedMarker {
  id: string;
  startLine: number;
  endLine: number;
  raw: string;
}

/** Structured form of every marker in a rendered tool output. */
export function parseMarkers(text: string): ParsedMarker[] {
  const re = /\[\[slipstream:([0-9a-f]{12}) L(\d+)-(\d+)\b[^\]\n]*\]\]/g;
  const found: ParsedMarker[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const [raw, id, start, end] = match;
    if (!id || !start || !end) {
      continue;
    }
    found.push({
      id,
      startLine: Number.parseInt(start, 10),
      endLine: Number.parseInt(end, 10),
      raw,
    });
  }
  return found;
}
