import * as os from 'node:os';
import * as path from 'node:path';
import { pricingFromEnvironment, type PricingConfig } from '@slipstream/core';

export interface ServerConfig {
  /** Where artifacts and the savings ledger live. */
  storageDir: string;
  /** Absolute paths the tools may read from and run in. */
  workspaceRoots: string[];
  allowedCommands?: string[];
  usdPerMillionTokens: number;
  pricing: PricingConfig;
  enabled: boolean;
  /** Serve the savings dashboard on loopback. Off unless asked for. */
  dashboard: boolean;
  /** Preferred dashboard port; a free port is used if it is taken. */
  dashboardPort: number;
  /**
   * Human-readable producer label shown in dashboard session tabs. Hosts that
   * share one machine (VS Code, Copilot CLI, other MCP clients) should each set
   * their own so the dashboard can tell their traffic apart.
   */
  sessionLabel: string;
  /** Expose only artifact retrieval and savings tools for hook-based clients. */
  retrievalOnly: boolean;
}

/**
 * Resolve configuration from CLI flags and environment.
 *
 * The VS Code extension passes `--root` for every workspace folder. When run
 * standalone (for example from `.vscode/mcp.json`) we fall back to the process
 * working directory, which the MCP host sets to the workspace.
 */
export function resolveConfig(argv: readonly string[]): ServerConfig {
  const roots: string[] = [];
  let storageDir: string | undefined;
  let sessionLabel: string | undefined;
  let dashboard = process.env.SLIPSTREAM_DASHBOARD === '1';
  let dashboardPort = Number(process.env.SLIPSTREAM_DASHBOARD_PORT ?? 7331);
  let retrievalOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' && value) {
      roots.push(path.resolve(value));
      i++;
    } else if (flag === '--storage' && value) {
      storageDir = path.resolve(value);
      i++;
    } else if (flag === '--label' && value) {
      sessionLabel = value;
      i++;
    } else if (flag === '--dashboard') {
      dashboard = true;
      // Optional port: `--dashboard 8080`. A bare flag keeps the default.
      if (value && /^\d+$/.test(value)) {
        dashboardPort = Number(value);
        i++;
      }
    } else if (flag === '--retrieval-only') {
      retrievalOnly = true;
    }
  }

  const fromEnv = process.env.SLIPSTREAM_WORKSPACE_ROOTS;
  if (fromEnv) {
    for (const entry of fromEnv.split(path.delimiter)) {
      if (entry.trim()) {
        roots.push(path.resolve(entry.trim()));
      }
    }
  }

  if (roots.length === 0) {
    roots.push(path.resolve(process.cwd()));
  }

  const allowed = process.env.SLIPSTREAM_ALLOWED_COMMANDS?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    storageDir:
      storageDir ??
      process.env.SLIPSTREAM_HOME ??
      path.join(os.homedir(), '.slipstream'),
    workspaceRoots: dedupe(roots),
    allowedCommands: allowed && allowed.length > 0 ? allowed : undefined,
    ...pricingFromEnvironment(process.env),
    enabled: process.env.SLIPSTREAM_ENABLED !== '0',
    dashboard,
    dashboardPort: Number.isFinite(dashboardPort) ? dashboardPort : 7331,
    sessionLabel:
      sessionLabel ||
      process.env.SLIPSTREAM_SESSION_LABEL ||
      `MCP: ${path.basename(roots[0] ?? process.cwd())}`,
    retrievalOnly,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function numberFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
