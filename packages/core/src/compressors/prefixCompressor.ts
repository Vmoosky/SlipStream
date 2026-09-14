/**
 * Prefix / path folding.
 *
 * Path-heavy output — file listings, dependency trees, stack traces, compiler
 * errors — repeats the same long directory prefix on line after line. This
 * compressor detects the most valuable shared path prefixes, defines each once
 * in a small legend, and substitutes a short placeholder for every occurrence in
 * the body.
 *
 * Unlike the line-omission compressors this is a whole-text substitution, so it
 * follows the JSON path's model rather than the segment model: the engine stores
 * the folded rendering (legend + body) as the artifact. That is semantically
 * lossless — the legend maps each placeholder to a fixed literal string, so the
 * original is fully reconstructable with `expandPrefixFold`. The compressor bails
 * out (returns null) rather than risk an ambiguous fold whenever the input
 * already contains the placeholder character.
 */

export interface PrefixCompressorConfig {
  /** A prefix must appear on at least this many paths to be folded. */
  minOccurrences: number;
  /** Only prefixes at least this many characters long are worth a legend entry. */
  minPrefixLength: number;
  /** At most this many prefixes are folded (legend size cap). */
  maxLegend: number;
  /** A plan must save at least this many characters overall to be worthwhile. */
  minSavedChars: number;
}

export const DEFAULT_PREFIX_CONFIG: PrefixCompressorConfig = {
  minOccurrences: 3,
  minPrefixLength: 12,
  maxLegend: 6,
  minSavedChars: 40,
};

export interface PrefixLegendEntry {
  placeholder: string;
  value: string;
}

export interface PrefixPlan {
  /** The folded rendering: legend block followed by the substituted body. */
  text: string;
  /** Number of lines in `text` (for the engine's kept-segment bookkeeping). */
  lineCount: number;
  legend: PrefixLegendEntry[];
  savedChars: number;
}

/** Placeholder character (section sign) — chosen because it is rare in tool output. */
const PLACEHOLDER_CHAR = '\u00A7';
const LEGEND_START = '\u27E6slipstream path legend\u27E7';
const LEGEND_END = '\u27E6end path legend\u27E7';

/** Matches path-like runs (at least two path separators), unix or windows. */
const PATH_RE = /(?:[A-Za-z]:)?[\w.@+-]*(?:[\\/][\w.@+-]+){2,}/g;

interface Candidate {
  prefix: string;
  count: number;
  net: number;
}

/** Enumerate directory-boundary prefixes of a path (each ending at a separator). */
function ancestorPrefixes(pathToken: string): string[] {
  const prefixes: string[] = [];
  for (let i = 1; i < pathToken.length; i++) {
    const ch = pathToken[i];
    if (ch === '/' || ch === '\\') {
      prefixes.push(pathToken.slice(0, i + 1));
    }
  }
  return prefixes;
}

/**
 * Plan a prefix fold. Returns null when no shared prefix is common or long
 * enough to pay for its legend entry, or when folding would be unsafe.
 */
export function planPrefixFold(
  text: string,
  config: Partial<PrefixCompressorConfig> = {},
): PrefixPlan | null {
  const cfg = { ...DEFAULT_PREFIX_CONFIG, ...config };
  if (text === '' || text.includes(PLACEHOLDER_CHAR)) return null;

  const paths = text.match(PATH_RE) ?? [];
  if (paths.length < cfg.minOccurrences) return null;

  // Count how many path tokens start with each candidate directory prefix.
  const counts = new Map<string, number>();
  for (const pathToken of paths) {
    for (const prefix of ancestorPrefixes(pathToken)) {
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }

  const placeholderLen = PLACEHOLDER_CHAR.length + 1; // e.g. "§1"
  const candidates: Candidate[] = [];
  for (const [prefix, count] of counts) {
    if (count < cfg.minOccurrences || prefix.length < cfg.minPrefixLength) continue;
    // Net saving: every occurrence drops (prefixLen - placeholderLen) chars, minus
    // the one-time legend line cost (`§k = <prefix>\n`).
    const legendCost = prefix.length + placeholderLen + 4;
    const net = count * (prefix.length - placeholderLen) - legendCost;
    if (net > 0) candidates.push({ prefix, count, net });
  }
  if (candidates.length === 0) return null;

  // Greedily take the most valuable, non-nested prefixes so their occurrence
  // counts stay disjoint and each legend entry is independently worthwhile.
  candidates.sort((a, b) => b.net - a.net);
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (selected.length >= cfg.maxLegend) break;
    const nested = selected.some(
      (s) => s.prefix.startsWith(candidate.prefix) || candidate.prefix.startsWith(s.prefix),
    );
    if (!nested) selected.push(candidate);
  }
  if (selected.length === 0) return null;

  const savedChars = selected.reduce((sum, s) => sum + s.net, 0);
  if (savedChars < cfg.minSavedChars) return null;

  // Substitute longest prefixes first so a shorter one never eats a longer one's
  // occurrences (they are non-nested here, but this stays correct regardless).
  const byLength = [...selected].sort((a, b) => b.prefix.length - a.prefix.length);
  const legend: PrefixLegendEntry[] = [];
  let body = text;
  byLength.forEach((candidate, index) => {
    const placeholder = `${PLACEHOLDER_CHAR}${index + 1}`;
    body = body.split(candidate.prefix).join(placeholder);
    legend.push({ placeholder, value: candidate.prefix });
  });

  const legendBlock = [
    LEGEND_START,
    ...legend.map((entry) => `${entry.placeholder} = ${entry.value}`),
    LEGEND_END,
  ].join('\n');
  const folded = `${legendBlock}\n${body}`;

  return {
    text: folded,
    lineCount: folded === '' ? 0 : folded.split('\n').length,
    legend,
    savedChars,
  };
}

/**
 * Reverse a prefix fold produced by planPrefixFold, reconstructing the original
 * text byte-for-byte. Text without a legend block is returned unchanged.
 */
export function expandPrefixFold(text: string): string {
  if (!text.startsWith(LEGEND_START)) return text;
  const endIndex = text.indexOf(`${LEGEND_END}\n`);
  if (endIndex === -1) return text;

  const legendText = text.slice(LEGEND_START.length + 1, endIndex).replace(/\n$/, '');
  const body = text.slice(endIndex + LEGEND_END.length + 1);

  const entries: PrefixLegendEntry[] = [];
  for (const line of legendText.split('\n')) {
    if (line === '') continue;
    const sep = line.indexOf(' = ');
    if (sep === -1) continue;
    entries.push({ placeholder: line.slice(0, sep), value: line.slice(sep + 3) });
  }

  let restored = body;
  for (const entry of entries) {
    restored = restored.split(entry.placeholder).join(entry.value);
  }
  return restored;
}
