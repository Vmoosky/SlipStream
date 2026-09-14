#!/usr/bin/env node
import * as fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CommandRejectedError,
  CompressionEngine,
  formatCost,
  PathAccessError,
  renderCommandLine,
  runCommand,
  startDashboardServer,
  type ToolOutput,
} from '@slipstream/core';
import { z } from 'zod';

import { resolveConfig } from './config.js';

const VERSION = '0.1.0';

/**
 * stdout carries the MCP protocol. Everything diagnostic must go to stderr or
 * the transport is corrupted.
 */
function log(message: string): void {
  process.stderr.write(`[slipstream] ${message}\n`);
}

/**
 * Instructions are paid on every request, so they carry only what the model
 * cannot infer from the tool list. The retrieval-only variant is what the
 * Copilot CLI plugin runs: there the hook compresses tool output in-process and
 * `run_command`/`read_file` are never registered, so advertising them would be
 * both wasted tokens and actively misleading.
 */
const RETRIEVAL_INSTRUCTIONS = `
Slipstream compresses high-volume tool output before it reaches your context window.

Nothing removed is lost. A marker [[slipstream:<id> L<start>-<end> | ... ]] means content
was omitted there: call retrieve_artifact with id=<id>, startLine=<start>, endLine=<end>
to get the exact original bytes back.
`.trim();

const FULL_INSTRUCTIONS = `
Slipstream compresses high-volume tool output before it reaches your context window.

Prefer these tools over the built-in equivalents:
  - run_command   instead of the terminal tool, for builds, tests, linters and installs
  - read_file     instead of the file reader, for files you may read more than once

Nothing removed is lost. A marker [[slipstream:<id> L<start>-<end> | ... ]] means content
was omitted there: call retrieve_artifact with id=<id>, startLine=<start>, endLine=<end>
to get the exact original bytes back.
`.trim();

async function main(): Promise<void> {
  const config = resolveConfig(process.argv.slice(2));
  fs.mkdirSync(config.storageDir, { recursive: true });

  const engine = new CompressionEngine({
    rootDir: config.storageDir,
    workspaceRoots: config.workspaceRoots,
    sessionLabel: config.sessionLabel,
    config: {
      enabled: config.enabled,
      usdPerMillionTokens: config.usdPerMillionTokens,
      pricing: config.pricing,
    },
  });

  const server = new McpServer(
    { name: 'slipstream', version: VERSION },
    { instructions: config.retrievalOnly ? RETRIEVAL_INSTRUCTIONS : FULL_INSTRUCTIONS },
  );

  if (!config.retrievalOnly) {
    server.registerTool(
      'run_command',
      {
        title: 'Run a command (compressed output)',
        description:
          'Run a build, test, lint or install command and return its output with the noise ' +
          'removed. PREFER THIS over the built-in terminal tool for anything that prints a lot: ' +
          'it preserves every distinct error, stack trace and summary while using far fewer ' +
          'tokens, and everything omitted stays recoverable via retrieve_artifact. Pass the ' +
          'program in "command" and each argument separately in "args"; shell operators such as ' +
          '&&, |, > and $() are not supported, so run one program per call.',
        inputSchema: {
          command: z
            .string()
            .describe('Bare executable name, for example "npm", "cargo" or "pytest". Not a path.'),
          args: z
            .array(z.string())
            .optional()
            .describe('Arguments, one array element each. Example: ["run", "test"].'),
          cwd: z
            .string()
            .optional()
            .describe('Absolute working directory. Defaults to the first workspace folder.'),
          timeoutSeconds: z
            .number()
            .int()
            .positive()
            .max(600)
            .optional()
            .describe('Kill the command after this many seconds. Default 120.'),
        },
        annotations: {
          title: 'Run a command (compressed output)',
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async ({ command, args, cwd, timeoutSeconds }) => {
        try {
          const result = await runCommand({
            command,
            args: args ?? [],
            cwd: cwd ?? config.workspaceRoots[0] ?? process.cwd(),
            workspaceRoots: engine.getWorkspaceRoots(),
            allowedCommands: config.allowedCommands,
            timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
          });
          const output = engine.compressCommandOutput({
            command: renderCommandLine(result.command, result.args),
            cwd: result.cwd,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
          });
          return textResult(withFooter(output));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    server.registerTool(
      'read_file',
      {
        title: 'Read a file (lifecycle aware)',
        description:
          'Read a workspace file. PREFER THIS over the built-in file reader whenever you might ' +
          'read the same file more than once: if the file is unchanged since you last read it in ' +
          'this session you get a one-line marker instead of the whole file, and if it changed ' +
          'you get a unified diff instead of a full re-send. The complete current contents are ' +
          'always recoverable with retrieve_artifact.',
        inputSchema: {
          path: z.string().describe('Absolute path to a file inside an open workspace folder.'),
        },
        annotations: {
          title: 'Read a file (lifecycle aware)',
          readOnlyHint: true,
          openWorldHint: false,
        },
      },
      async ({ path: filePath }) => {
        try {
          const resolved = engine.resolveReadPath(filePath);
          const stat = fs.statSync(resolved);
          if (!stat.isFile()) {
            return errorResult(new Error(`"${resolved}" is not a file.`));
          }
          const content = fs.readFileSync(resolved, 'utf8');
          const output = engine.compressFileRead({ path: resolved, content });
          return textResult(withFooter(output));
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }

  server.registerTool(
    'retrieve_artifact',
    {
      title: 'Retrieve omitted content',
      description:
        'Expand content an earlier slipstream tool omitted. Omissions appear inline as ' +
        '[[slipstream:<id> L<start>-<end> | ... ]] — pass id=<id>, startLine=<start>, ' +
        'endLine=<end> to get the exact original bytes back. Use "grep" to return only ' +
        'matching lines. Nothing slipstream removes is ever lost.',
      inputSchema: {
        id: z.string().describe('The 12-character hex id from a [[slipstream:...]] marker.'),
        startLine: z.number().int().positive().optional().describe('First line to return (1-based).'),
        endLine: z.number().int().positive().optional().describe('Last line to return, inclusive.'),
        grep: z
          .string()
          .optional()
          .describe('Return only matching lines. A literal substring, or /regex/flags.'),
        maxLines: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe('Cap on returned lines. Default 400.'),
      },
      annotations: {
        title: 'Retrieve omitted content',
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, startLine, endLine, grep, maxLines }) => {
      try {
        const slice = engine.retrieve({ id, startLine, endLine, grep, maxLines });
        const header =
          `--- slipstream: ${slice.label} (${slice.returnedLines} of ${slice.totalLines} lines` +
          `${slice.truncated ? ', truncated' : ''}) ---`;
        return textResult(`${header}\n${slice.text}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_savings',
    {
      title: 'Slipstream savings report',
      description:
        'Report how many tokens slipstream has saved so far in this session, broken down by ' +
        'tool, plus how often omitted content actually had to be retrieved.',
      inputSchema: {},
      annotations: {
        title: 'Slipstream savings report',
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const summary = engine.summary();
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
            `  ${tool.tool.padEnd(20)} ${tool.calls} call(s), ` +
            `${tool.tokensSaved.toLocaleString()} tokens saved`,
        ),
      ];
      return textResult(lines.join('\n'));
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.server.onclose = () => engine.dispose();
  log(
    `ready (roots: ${config.workspaceRoots.join(', ')}; storage: ${config.storageDir}; ` +
      `compression ${config.enabled ? 'on' : 'off'})`,
  );

  if (config.dashboard) {
    try {
      const handle = await startDashboardServer(engine, { port: config.dashboardPort });
      // stderr only: stdout carries the MCP protocol.
      log(`dashboard: ${handle.url}`);
    } catch (error) {
      log(`dashboard failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function withFooter(output: ToolOutput): string {
  const pct =
    output.tokensBefore > 0
      ? Math.round((output.tokensSaved / output.tokensBefore) * 100)
      : 0;
  if (output.strategy.startsWith('passthrough')) {
    return output.text;
  }
  return (
    `${output.text}\n` +
    `--- slipstream: ${output.tokensBefore.toLocaleString()} -> ` +
    `${output.tokensAfter.toLocaleString()} tokens (${pct}% saved) ---`
  );
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Return errors as tool results rather than throwing, so the model sees the
 * explanation and can correct itself instead of just seeing a failure.
 */
function errorResult(error: unknown) {
  const message =
    error instanceof CommandRejectedError || error instanceof PathAccessError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
