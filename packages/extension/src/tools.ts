import * as fs from 'node:fs';

import {
  CommandRejectedError,
  CompressionEngine,
  formatCost,
  PathAccessError,
  renderCommandLine,
  runCommand,
  validateCommand,
  type ToolOutput,
} from '@slipstream/core';
import * as vscode from 'vscode';

import { readSettings } from './config.js';
import { NativeToolController, type NativeCommandOutcome } from './nativeChat.js';

export const TOOL_NAMES = {
  run: 'slipstream_runCommand',
  read: 'slipstream_readFile',
  retrieve: 'slipstream_retrieveArtifact',
  savings: 'slipstream_getSavings',
} as const;

interface RunCommandInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutSeconds?: number;
}

interface ReadFileInput {
  path: string;
}

interface RetrieveInput {
  id: string;
  startLine?: number;
  endLine?: number;
  grep?: string;
  maxLines?: number;
}

function result(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

/** Append the savings line the demo leans on, unless nothing was compressed. */
function withFooter(output: ToolOutput): string {
  if (output.strategy.startsWith('passthrough')) {
    return output.text;
  }
  const pct =
    output.tokensBefore > 0 ? Math.round((output.tokensSaved / output.tokensBefore) * 100) : 0;
  return (
    `${output.text}\n--- slipstream: ${output.tokensBefore.toLocaleString()} -> ` +
    `${output.tokensAfter.toLocaleString()} tokens (${pct}% saved) ---`
  );
}

/**
 * Surface failures as text the model can act on. Throwing would show the user a
 * generic error; a sentence explaining the rule lets the model retry correctly.
 */
function explain(error: unknown): string {
  if (error instanceof CommandRejectedError || error instanceof PathAccessError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export class RunCommandTool implements vscode.LanguageModelTool<RunCommandInput> {
  constructor(private readonly engine: CompressionEngine, private readonly onComplete?: (outcome: NativeCommandOutcome) => void) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunCommandInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const settings = readSettings();
    const roots = [...this.engine.getWorkspaceRoots()];
    const cwd = options.input.cwd ?? roots[0] ?? '';
    const line = renderCommandLine(options.input.command ?? '', options.input.args ?? []);

    // Validate before asking, so an obviously refused command explains itself
    // instead of prompting the user for permission we would then deny.
    let problem: string | undefined;
    try {
      validateCommand({
        command: options.input.command,
        args: options.input.args ?? [],
        cwd,
        workspaceRoots: roots,
        allowedCommands: settings.allowedCommands,
      });
    } catch (error) {
      problem = explain(error);
    }

    const message = new vscode.MarkdownString();
    if (problem) {
      message.appendMarkdown(`**This command will be refused.**\n\n${problem}\n\n`);
    }
    message.appendMarkdown(`Run in \`${cwd}\`:\n\n`);
    // appendCodeblock escapes the content, so a hostile argument cannot inject
    // markdown or break out of the fence.
    message.appendCodeblock(line, 'shellscript');

    return {
      invocationMessage: `Running ${line}`,
      confirmationMessages: { title: 'Run a command', message },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunCommandInput>,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const settings = readSettings();
    const roots = [...this.engine.getWorkspaceRoots()];
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    let completed = false;

    try {
      const outcome = await runCommand({
        command: options.input.command,
        args: options.input.args ?? [],
        cwd: options.input.cwd ?? roots[0] ?? process.cwd(),
        workspaceRoots: roots,
        allowedCommands: settings.allowedCommands,
        timeoutMs: (options.input.timeoutSeconds ?? settings.commandTimeoutSeconds) * 1000,
        signal: controller.signal,
      });
      completed = true;
      this.onComplete?.({ exitCode: outcome.exitCode, durationMs: outcome.durationMs, timedOut: outcome.timedOut, cancelled: token.isCancellationRequested });
      const compressed = this.engine.compressCommandOutput({
        command: renderCommandLine(outcome.command, outcome.args),
        cwd: outcome.cwd,
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        durationMs: outcome.durationMs,
      });
      return result(withFooter(compressed));
    } catch (error) {
      if (!completed) this.onComplete?.({ exitCode: null, durationMs: 0, error: true, cancelled: token.isCancellationRequested });
      return result(explain(error));
    } finally {
      subscription.dispose();
    }
  }
}

export class ReadFileTool implements vscode.LanguageModelTool<ReadFileInput> {
  constructor(private readonly engine: CompressionEngine) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ReadFileInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: `Reading ${options.input.path}` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      const resolved = this.engine.resolveReadPath(options.input.path);
      if (!fs.statSync(resolved).isFile()) {
        return result(`"${resolved}" is not a file.`);
      }
      const content = fs.readFileSync(resolved, 'utf8');
      return result(withFooter(this.engine.compressFileRead({ path: resolved, content })));
    } catch (error) {
      return result(explain(error));
    }
  }
}

export class RetrieveArtifactTool implements vscode.LanguageModelTool<RetrieveInput> {
  constructor(private readonly engine: CompressionEngine, private readonly onRetrieval?: (success: boolean) => void) {}

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RetrieveInput>,
  ): Promise<vscode.PreparedToolInvocation> {
    const range =
      options.input.startLine && options.input.endLine
        ? ` lines ${options.input.startLine}-${options.input.endLine}`
        : '';
    return { invocationMessage: `Expanding omitted content${range}` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RetrieveInput>,
  ): Promise<vscode.LanguageModelToolResult> {
    let success = false;
    try {
      const slice = this.engine.retrieve(options.input);
      const header =
        `--- slipstream: ${slice.label} (${slice.returnedLines} of ${slice.totalLines} lines` +
        `${slice.truncated ? ', truncated' : ''}) ---`;
      const output = result(`${header}\n${slice.text}`);
      success = true;
      return output;
    } catch (error) {
      return result(explain(error));
    } finally {
      this.onRetrieval?.(success);
    }
  }
}

export class GetSavingsTool implements vscode.LanguageModelTool<Record<string, unknown>> {
  constructor(private readonly engine: CompressionEngine) {}

  async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
    return { invocationMessage: 'Reading Slipstream savings' };
  }

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const summary = this.engine.summary();
    const lines = [
      `Compressions:      ${summary.compressions}`,
      `Tokens in:         ${summary.tokensBefore.toLocaleString()}`,
      `Tokens forwarded:  ${summary.tokensAfter.toLocaleString()}`,
      `Tokens saved:      ${summary.tokensSaved.toLocaleString()} (${summary.percentSaved.toFixed(1)}%)`,
      `Public API reference saving: ${formatCost(summary.estimatedCostSavedUsd, 4)} (${summary.cost.coverage}; not Copilot billing)`,
      `Known priced subtotal: ${formatCost(summary.cost.knownUsd, 4)}`,
      `Retrievals:        ${summary.retrievals} (${summary.retrievalRate.toFixed(1)}% of compressions)`,
      '',
      'By tool:',
      ...summary.byTool.map(
        (tool) =>
          `  ${tool.tool.padEnd(20)} ${tool.calls} call(s), ${tool.tokensSaved.toLocaleString()} tokens saved`,
      ),
    ];
    return result(lines.join('\n'));
  }
}

export function registerTools(
  context: vscode.ExtensionContext,
  engine: CompressionEngine,
): void {
  const native = new NativeToolController(engine);
  context.subscriptions.push(
    native,
    vscode.lm.registerTool(TOOL_NAMES.run, native.wrap(TOOL_NAMES.run, (scoped, callbacks) => new RunCommandTool(scoped, callbacks?.commandComplete))),
    vscode.lm.registerTool(TOOL_NAMES.read, native.wrap(TOOL_NAMES.read, (scoped) => new ReadFileTool(scoped))),
    vscode.lm.registerTool(TOOL_NAMES.retrieve, native.wrap(TOOL_NAMES.retrieve, (scoped, callbacks) => new RetrieveArtifactTool(scoped, callbacks?.retrievalComplete))),
    vscode.lm.registerTool(TOOL_NAMES.savings, native.wrap(TOOL_NAMES.savings, (scoped) => new GetSavingsTool(scoped))),
  );
}
