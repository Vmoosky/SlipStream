import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * "Update available" notice — a well-mannered, non-blocking check.
 *
 * Modeled on Headroom's proxy notice: it runs at most once a day in the
 * background, never blocks the caller, prints a single line when a newer version
 * exists, is opt-out via `SLIPSTREAM_UPDATE_CHECK=off`, and is skipped in CI.
 *
 * Everything here is defensive: no path in this module is allowed to throw into
 * a caller (a broken update check must never degrade compression or a hook), and
 * the network fetch is injectable so the whole thing is testable offline.
 */

/** Persisted between runs so the check honours the once-a-day budget. */
export interface UpdateCheckState {
  /** Epoch ms of the last completed check (successful or not). */
  lastCheckMs: number;
  /** Latest version seen on the last successful fetch, or null if unknown. */
  latestVersion: string | null;
}

/** Returned when — and only when — a strictly newer version is available. */
export interface UpdateNotice {
  currentVersion: string;
  latestVersion: string;
}

export interface UpdateCheckOptions {
  /** The version currently running (e.g. the plugin/extension package version). */
  currentVersion: string;
  /** Directory to persist the throttle state in (the artifact storage dir). */
  stateDir: string;
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
  /** Injected for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Minimum gap between network checks. Defaults to 24h. */
  minIntervalMs?: number;
  /**
   * Resolves the latest published version, or null if it cannot be determined.
   * Defaults to a short, timeout-guarded fetch of `SLIPSTREAM_UPDATE_URL`.
   */
  fetchLatest?: () => Promise<string | null>;
}

/** How often the network check may run, at most. */
const DEFAULT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STATE_FILE = 'update-check.json';

/** Truthy env values that turn the check off. */
const OFF_VALUES = new Set(['off', '0', 'false', 'no']);

/** True when the user opted out or we are running in CI. */
export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.SLIPSTREAM_UPDATE_CHECK ?? '').trim().toLowerCase();
  if (OFF_VALUES.has(flag)) return true;
  // Standard CI signal (GitHub Actions, most providers set CI=true).
  const ci = (env.CI ?? '').trim().toLowerCase();
  return ci !== '' && ci !== '0' && ci !== 'false';
}

/** Parse `x.y.z` (ignoring any pre-release/build suffix) into three numbers. */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 / 0 / 1 comparing two dotted versions; unparseable versions sort last. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i += 1) {
    const na = pa[i] as number;
    const nb = pb[i] as number;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/** True when `latest` is a strictly newer release than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

function readState(stateDir: string): UpdateCheckState | undefined {
  try {
    const raw = fs.readFileSync(path.join(stateDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdateCheckState>;
    if (typeof parsed.lastCheckMs !== 'number') return undefined;
    return {
      lastCheckMs: parsed.lastCheckMs,
      latestVersion: typeof parsed.latestVersion === 'string' ? parsed.latestVersion : null,
    };
  } catch {
    return undefined;
  }
}

function writeState(stateDir: string, state: UpdateCheckState): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, STATE_FILE), JSON.stringify(state), 'utf8');
  } catch {
    /* best effort — a failed write only means we re-check sooner */
  }
}

/**
 * Default network probe: fetch `SLIPSTREAM_UPDATE_URL` (JSON) and read a version
 * from `version` or a `tag_name` (GitHub releases shape). Times out fast and
 * returns null on any problem — the caller treats null as "don't know".
 */
export async function defaultFetchLatest(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const url = (env.SLIPSTREAM_UPDATE_URL ?? '').trim();
  if (url === '' || typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: unknown; tag_name?: unknown };
    const raw =
      typeof data.version === 'string'
        ? data.version
        : typeof data.tag_name === 'string'
          ? data.tag_name
          : null;
    return raw ? raw.replace(/^v/, '') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the update check, honouring opt-out, CI, and the once-a-day budget.
 *
 * Resolves to an {@link UpdateNotice} only when a strictly newer version is
 * known, otherwise undefined. Never rejects.
 */
export async function maybeCheckForUpdate(options: UpdateCheckOptions): Promise<UpdateNotice | undefined> {
  try {
    const env = options.env ?? process.env;
    if (isUpdateCheckDisabled(env)) return undefined;

    const now = options.now ?? Date.now();
    const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    const fetchLatest = options.fetchLatest ?? (() => defaultFetchLatest(env));

    const state = readState(options.stateDir);
    let latest = state?.latestVersion ?? null;

    const due = !state || now - state.lastCheckMs >= minInterval;
    if (due) {
      let fetched: string | null = null;
      try {
        fetched = await fetchLatest();
      } catch {
        // Swallow fetch failures; we still record the attempt below.
      }
      latest = fetched ?? latest;
      writeState(options.stateDir, { lastCheckMs: now, latestVersion: latest });
    }

    if (latest && isNewerVersion(latest, options.currentVersion)) {
      return { currentVersion: options.currentVersion, latestVersion: latest };
    }
    return undefined;
  } catch {
    // An update check must never break its caller.
    return undefined;
  }
}

/** One-line, user-facing notice. */
export function formatUpdateNotice(notice: UpdateNotice): string {
  return (
    `Slipstream update available: ${notice.currentVersion} \u2192 ${notice.latestVersion}. ` +
    `Update the extension/plugin to get the latest compressors. ` +
    `(set SLIPSTREAM_UPDATE_CHECK=off to silence)`
  );
}
