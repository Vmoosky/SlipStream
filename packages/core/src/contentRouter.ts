import { looksLikeSearchResults } from './compressors/searchCompressor.js';
import { looksLikeTabular } from './compressors/tabularCompressor.js';
import { looksLikeConfig } from './compressors/configCompressor.js';
import type { ContentKind } from './types.js';

const DIFF_RE = /^diff --git |^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m;
const LOGGY_RE =
  /(^|\n)\s*(at |File ")|\b(ERROR|WARN|INFO|DEBUG|FAIL|PASS)\b|\berror TS\d{4}\b|^npm (ERR!|WARN)/m;

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
  '.scala', '.sh', '.ps1', '.sql', '.vue', '.svelte',
]);

/** Cheap content sniffing. Only needs to be right enough to pick a strategy. */
export function detectContentKind(text: string, fileExtension?: string): ContentKind {
  if (DIFF_RE.test(text)) {
    return 'diff';
  }
  const trimmed = text.trimStart();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && text.length < 2_000_000) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      /* not JSON after all */
    }
  }
  if (fileExtension && CODE_EXTENSIONS.has(fileExtension.toLowerCase())) {
    return 'code';
  }
  // grep/ripgrep `path:line:content` output is a strong, distinctive signal, so
  // it is checked before the looser log heuristic (match content may contain
  // words like "error" that would otherwise route it to `log`).
  if (looksLikeSearchResults(text.split('\n'))) {
    return 'search';
  }
  // A delimited table (markdown / CSV / TSV) is a distinctive, redundant shape;
  // detect it before the log heuristic so tabular data is not read as a log.
  if (looksLikeTabular(text.split('\n'))) {
    return 'tabular';
  }
  if (LOGGY_RE.test(text)) {
    return 'log';
  }
  // Config (YAML/TOML/INI) is checked after log so structured logs are not
  // mistaken for config; it collapses comment/blank blocks the log path ignores.
  if (looksLikeConfig(text.split('\n'))) {
    return 'config';
  }
  return 'text';
}

/** Below these thresholds a marker costs more than the content it replaces. */
export function isWorthCompressing(text: string, lineCount: number): boolean {
  return lineCount >= 40 || text.length >= 4000;
}
