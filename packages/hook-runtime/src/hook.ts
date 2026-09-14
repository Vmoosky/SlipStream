import * as os from 'node:os';
import * as path from 'node:path';

import { CompressionEngine } from '@slipstream/core';
import { parseProducerPricing, type ProducerPricing } from './protocol.js';

import type {
  PostToolUseInput,
  PostToolUseOutput,
  UserPromptSubmittedInput,
} from './protocol.js';

const BYPASS_TOOL_FRAGMENTS = ['retrieve_artifact', 'retrieveartifact', 'get_savings', 'getsavings'];

export class HookSessionManager {
  private readonly engines = new Map<string, CompressionEngine>();

  constructor(private readonly storageDir = defaultStorageDir()) {}

  process(input: PostToolUseInput, pricing?: ProducerPricing): PostToolUseOutput {
    if (shouldBypass(input.toolName)) {
      return {};
    }
    const engine = this.engineFor(input, pricing);
    const output = engine.compressToolResult({
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      cwd: input.cwd,
      text: input.toolResult.textResultForLlm,
    });
    if (output.strategy.startsWith('passthrough')) {
      return {};
    }
    const percent =
      output.tokensBefore > 0
        ? Math.round((output.tokensSaved / output.tokensBefore) * 100)
        : 0;
    return {
      modifiedResult: {
        resultType: 'success',
        textResultForLlm:
          `${output.text}\n--- slipstream: ${output.tokensBefore.toLocaleString()} -> ` +
          `${output.tokensAfter.toLocaleString()} tokens (${percent}% saved) ---`,
      },
    };
  }

  recordChat(input: UserPromptSubmittedInput, pricing?: ProducerPricing): void {
    this.engineFor(input, pricing).recordChatSubmitted(input.timestamp);
  }

  release(sessionId: string): void {
    this.engines.get(sessionId)?.dispose();
    this.engines.delete(sessionId);
  }

  /**
   * Forget what the model has already been shown on every live session, so the
   * next read of a file is full again. Artifacts are kept. Mirrors the VS Code
   * `slipstream.resetSession` command, applied across all active CLI sessions.
   * Returns how many live sessions were reset.
   */
  resetAll(): number {
    const count = this.engines.size;
    for (const engine of this.engines.values()) engine.resetSession();
    return count;
  }

  /**
   * Delete every stored artifact and clear the shared dedup index. Live sessions
   * keep serving but forget what they had seen, so no retrieval marker is left
   * pointing at deleted content. Mirrors VS Code's `slipstream.purgeArtifacts`.
   */
  purge(): { artifacts: number } {
    const engines = [...this.engines.values()];
    const primary = engines[0];
    if (primary) {
      const result = primary.purge();
      for (const engine of engines.slice(1)) engine.resetSession();
      return result;
    }
    const engine = this.maintenanceEngine();
    try {
      return engine.purge();
    } finally {
      engine.dispose();
    }
  }

  dispose(): void {
    for (const engine of this.engines.values()) engine.dispose();
    this.engines.clear();
  }

  /** A short-lived engine over the shared storage, used when no session is live. */
  private maintenanceEngine(): CompressionEngine {
    return new CompressionEngine({
      rootDir: this.storageDir,
      workspaceRoots: [this.storageDir],
      sessionId: 'cli-maintenance',
      sessionLabel: 'Copilot CLI maintenance',
    });
  }

  private engineFor(input: Pick<PostToolUseInput, 'sessionId' | 'cwd'>, pricing?: ProducerPricing): CompressionEngine {
    const config = parseProducerPricing(pricing);
    const existing = this.engines.get(input.sessionId);
    if (existing) {
      existing.updateConfig(config);
      existing.setWorkspaceRoots([input.cwd]);
      return existing;
    }
    const engine = new CompressionEngine({
      rootDir: this.storageDir,
      workspaceRoots: [input.cwd],
      sessionId: input.sessionId,
      sessionLabel: `Copilot CLI: ${path.basename(input.cwd) || 'workspace'}`,
      config,
    });
    this.engines.set(input.sessionId, engine);
    return engine;
  }
}

export function shouldBypass(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[-_.]/g, '');
  return BYPASS_TOOL_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment.replace(/_/g, '')),
  );
}

export function defaultStorageDir(): string {
  return process.env.SLIPSTREAM_STORAGE_DIR?.trim() || path.join(os.homedir(), '.slipstream');
}
