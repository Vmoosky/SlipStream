import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveConfig } from '../src/config.js';
afterEach(() => vi.unstubAllEnvs());

/**
 * Each MCP host on a machine is a separate producer writing to one shared
 * ledger, so the label has to be settable per host rather than derived only
 * from the workspace name.
 */
describe('MCP server config', () => {
  it('reads exact model selection and zero overrides for retrieval-only producers', () => {
    vi.stubEnv('SLIPSTREAM_PRICING_MODE', 'catalog');
    vi.stubEnv('SLIPSTREAM_PRICING_PROVIDER', 'anthropic');
    vi.stubEnv('SLIPSTREAM_PRICING_MODEL', 'claude-sonnet-4-6');
    vi.stubEnv('SLIPSTREAM_PRICING_INPUT_OVERRIDE', '0');
    vi.stubEnv('SLIPSTREAM_USD_PER_MILLION', '0');
    expect(resolveConfig(['--retrieval-only'])).toMatchObject({ usdPerMillionTokens: 0, pricing: {
      mode: 'catalog', providerId: 'anthropic', modelId: 'claude-sonnet-4-6', inputRateOverride: 0,
    } });
    vi.stubEnv('SLIPSTREAM_PRICING_INPUT_OVERRIDE', '');
    expect(resolveConfig([]).pricing.inputRateOverride).toBeUndefined();
    vi.stubEnv('SLIPSTREAM_PRICING_MODEL', '');
    expect(() => resolveConfig([])).toThrow('Select a pricing provider and model');
  });

  it('labels the producer from --label ahead of the environment', () => {
    const previous = process.env['SLIPSTREAM_SESSION_LABEL'];
    process.env['SLIPSTREAM_SESSION_LABEL'] = 'From env';
    try {
      const config = resolveConfig(['--root', os.tmpdir(), '--label', 'Copilot CLI: demo']);
      expect(config.sessionLabel).toBe('Copilot CLI: demo');
    } finally {
      if (previous === undefined) delete process.env['SLIPSTREAM_SESSION_LABEL'];
      else process.env['SLIPSTREAM_SESSION_LABEL'] = previous;
    }
  });

  it('falls back to the environment, then to the workspace name', () => {
    const previous = process.env['SLIPSTREAM_SESSION_LABEL'];
    process.env['SLIPSTREAM_SESSION_LABEL'] = 'Copilot CLI: from env';
    try {
      expect(resolveConfig(['--root', os.tmpdir()]).sessionLabel).toBe('Copilot CLI: from env');
    } finally {
      if (previous === undefined) delete process.env['SLIPSTREAM_SESSION_LABEL'];
      else process.env['SLIPSTREAM_SESSION_LABEL'] = previous;
    }

    const inherited = process.env['SLIPSTREAM_SESSION_LABEL'];
    delete process.env['SLIPSTREAM_SESSION_LABEL'];
    try {
      const root = path.join(os.tmpdir(), 'slipstream-label-fallback');
      expect(resolveConfig(['--root', root]).sessionLabel).toBe('MCP: slipstream-label-fallback');
    } finally {
      if (inherited !== undefined) process.env['SLIPSTREAM_SESSION_LABEL'] = inherited;
    }
  });

  it('keeps --label from being read as a workspace root', () => {
    const config = resolveConfig(['--root', os.tmpdir(), '--label', 'Copilot CLI: demo']);
    expect(config.workspaceRoots).toEqual([path.resolve(os.tmpdir())]);
  });

  it('supports a retrieval-only tool surface for the Copilot hook plugin', () => {
    expect(resolveConfig(['--retrieval-only']).retrievalOnly).toBe(true);
    expect(resolveConfig([]).retrievalOnly).toBe(false);
  });

  describe('CLI and environment precedence', () => {
    beforeEach(() => {
      for (const key of [
        'SLIPSTREAM_WORKSPACE_ROOTS',
        'SLIPSTREAM_HOME',
        'SLIPSTREAM_ALLOWED_COMMANDS',
        'SLIPSTREAM_DASHBOARD',
        'SLIPSTREAM_DASHBOARD_PORT',
        'SLIPSTREAM_ENABLED',
      ]) {
        vi.stubEnv(key, undefined);
      }
    });

    it('combines CLI and environment roots while removing blanks and duplicates', () => {
      const first = path.join(os.tmpdir(), 'slipstream-first-workspace');
      const second = path.join(os.tmpdir(), 'slipstream-second-workspace');
      vi.stubEnv('SLIPSTREAM_WORKSPACE_ROOTS', [' ', ` ${first} `, second, ''].join(path.delimiter));

      expect(resolveConfig(['--root', first, '--root', first]).workspaceRoots).toEqual([
        path.resolve(first),
        path.resolve(second),
      ]);
    });

    it('uses the working directory when roots are blank and a CLI value is missing', () => {
      vi.stubEnv('SLIPSTREAM_WORKSPACE_ROOTS', [' ', ''].join(path.delimiter));
      expect(resolveConfig(['--root']).workspaceRoots).toEqual([path.resolve(process.cwd())]);
    });

    it('prefers CLI storage over the environment and falls back to the user directory', () => {
      const configured = path.join(os.tmpdir(), 'slipstream-configured-storage');
      vi.stubEnv('SLIPSTREAM_HOME', configured);
      expect(resolveConfig(['--storage', 'relative-artifacts']).storageDir).toBe(
        path.resolve('relative-artifacts'),
      );
      expect(resolveConfig([]).storageDir).toBe(configured);

      vi.stubEnv('SLIPSTREAM_HOME', undefined);
      expect(resolveConfig([]).storageDir).toBe(path.join(os.homedir(), '.slipstream'));
    });

    it('trims command allowlists without retaining empty entries', () => {
      vi.stubEnv('SLIPSTREAM_ALLOWED_COMMANDS', ' node, git ,, dotnet, ');
      expect(resolveConfig([]).allowedCommands).toEqual(['node', 'git', 'dotnet']);
    });

    it.each(['', ' , , '])('leaves an empty command allowlist unspecified: %j', (value) => {
      vi.stubEnv('SLIPSTREAM_ALLOWED_COMMANDS', value);
      expect(resolveConfig([]).allowedCommands).toBeUndefined();
    });

    it('reads dashboard enablement and the preferred port from the environment', () => {
      vi.stubEnv('SLIPSTREAM_DASHBOARD', '1');
      vi.stubEnv('SLIPSTREAM_DASHBOARD_PORT', '8081');
      expect(resolveConfig([])).toMatchObject({ dashboard: true, dashboardPort: 8081 });
    });

    it('does not consume the next option after a portless dashboard flag', () => {
      expect(resolveConfig(['--dashboard', '--retrieval-only'])).toMatchObject({
        dashboard: true,
        dashboardPort: 7331,
        retrievalOnly: true,
      });
    });

    it.each(['0', '8080'])('prefers the explicit dashboard port %s over the environment', (port) => {
      vi.stubEnv('SLIPSTREAM_DASHBOARD_PORT', '8081');
      expect(resolveConfig(['--dashboard', port, '--retrieval-only'])).toMatchObject({
        dashboard: true,
        dashboardPort: Number(port),
        retrievalOnly: true,
      });
    });

    it.each(['not-a-port', 'Infinity'])('uses the default for a non-finite port: %s', (port) => {
      vi.stubEnv('SLIPSTREAM_DASHBOARD_PORT', port);
      expect(resolveConfig(['--dashboard'])).toMatchObject({ dashboard: true, dashboardPort: 7331 });
    });

    it('disables compression only when explicitly configured as zero', () => {
      vi.stubEnv('SLIPSTREAM_ENABLED', '0');
      expect(resolveConfig([]).enabled).toBe(false);
      vi.stubEnv('SLIPSTREAM_ENABLED', 'false');
      expect(resolveConfig([]).enabled).toBe(true);
    });
  });
});
