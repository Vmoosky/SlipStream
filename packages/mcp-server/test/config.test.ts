import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
