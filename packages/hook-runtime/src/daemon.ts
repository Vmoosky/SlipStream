import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  CompressionEngine,
  recordModelObservation,
  startModelTelemetryReceiver,
  type ModelTelemetryReceiver,
} from '@slipstream/core';

import { HookSessionManager, defaultStorageDir } from './hook.js';
import { persistBoundPort, readConnection } from './modelTracking.js';
import type { DaemonRequest, DaemonResponse } from './protocol.js';
import { parsePostToolUseInput, parseUserPromptSubmittedInput } from './protocol.js';

/**
 * When the user has opted in (`slipstream model-tracking enable`), host the
 * local Copilot telemetry receiver inside the daemon — the CLI's long-lived
 * shared process — and record observations into the same storage directory the
 * hooks compress against. Any failure is swallowed so hook serving is never
 * affected. Returns a disposer, or undefined when tracking is off/unavailable.
 */
export async function startModelTracking(storageDir: string): Promise<(() => Promise<void>) | undefined> {
  const connection = readConnection(storageDir);
  if (!connection || !connection.consented) return undefined;
  const engine = new CompressionEngine({
    rootDir: storageDir,
    workspaceRoots: [storageDir],
    sessionId: 'copilot-otel',
    sessionLabel: 'Copilot CLI model tracking',
    config: { pricing: { mode: 'automatic' } },
  });
  const onObservation = (observation: Parameters<typeof recordModelObservation>[1]): void => {
    try {
      recordModelObservation(engine, observation, 'cli');
    } catch {
      // A single malformed or duplicate observation must not stop the receiver.
    }
  };
  let receiver: ModelTelemetryReceiver;
  try {
    receiver = await startModelTelemetryReceiver({ token: connection.token, port: connection.port || undefined, onObservation });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && connection.port) {
      try {
        receiver = await startModelTelemetryReceiver({ token: connection.token, onObservation });
      } catch {
        engine.dispose();
        return undefined;
      }
    } else {
      engine.dispose();
      return undefined;
    }
  }
  persistBoundPort(storageDir, Number(new URL(receiver.endpoint).port));
  return async () => {
    await receiver.close();
    engine.dispose();
  };
}

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export function socketPath(): string {
  const owner = createHash('sha256').update(os.homedir()).digest('hex').slice(0, 12);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\slipstream-hook-${owner}`
    : path.join(os.tmpdir(), `slipstream-hook-${owner}.sock`);
}

export async function runDaemon(): Promise<void> {
  const storageDir = defaultStorageDir();
  const sessions = new HookSessionManager(storageDir);
  const socket = socketPath();
  let stopModelTracking: (() => Promise<void>) | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    resetIdleTimer();
    let body = '';
    let bytes = 0;
    let handled = false;
    connection.setEncoding('utf8');
    connection.on('error', () => {
      connection.destroy();
    });
    connection.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_MESSAGE_BYTES) {
        connection.destroy(new Error('Hook request exceeds the maximum size.'));
        return;
      }
      body += chunk;
      if (!handled && body.includes('\n')) {
        handled = true;
        respond(connection, body.slice(0, body.indexOf('\n')));
      }
    });
    connection.on('end', () => {
      if (!handled && body.length > 0) {
        handled = true;
        respond(connection, body);
      }
    });

    function respond(client: net.Socket, requestBody: string): void {
      let request: DaemonRequest;
      try {
        request = JSON.parse(requestBody) as DaemonRequest;
      } catch (error) {
        finish(client, { ok: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (request.type === 'sync-model-tracking') {
        reloadModelTracking()
          .then((port) => finish(client, { ok: true, modelTracking: { port } }))
          .catch((error) => finish(client, { ok: false, error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      let response: DaemonResponse;
      try {
        if (request.type === 'release') {
          sessions.release(String(request.sessionId ?? ''));
          response = { ok: true, output: {} };
        } else if (request.type === 'reset') {
          response = { ok: true, reset: { sessions: sessions.resetAll() } };
        } else if (request.type === 'purge') {
          response = { ok: true, purge: sessions.purge() };
        } else if (request.type === 'compress') {
          response = { ok: true, output: sessions.process(parsePostToolUseInput(request.input), request.producerPricing) };
        } else if (request.type === 'chat') {
          sessions.recordChat(parseUserPromptSubmittedInput(request.input), request.producerPricing);
          response = { ok: true, output: {} };
        } else {
          throw new Error('Unknown hook daemon request.');
        }
      } catch (error) {
        response = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      finish(client, response);
    }

    function finish(client: net.Socket, response: DaemonResponse): void {
      client.end(JSON.stringify(response));
      resetIdleTimer();
    }
  });

  server.on('close', () => {
    sessions.dispose();
    void stopModelTracking?.();
  });

  async function reloadModelTracking(): Promise<number> {
    await stopModelTracking?.();
    stopModelTracking = await startModelTracking(storageDir);
    return readConnection(storageDir)?.port ?? 0;
  }

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => server.close(), IDLE_TIMEOUT_MS);
    idleTimer.unref();
  }

  if (process.platform !== 'win32') {
    const fs = await import('node:fs');
    fs.rmSync(socket, { force: true });
  }
  // The telemetry receiver must be bound before the pipe accepts its first
  // request. Copilot CLI starts exporting spans as soon as the prompt is
  // submitted, and the userPromptSubmitted hook returns the moment the pipe
  // accepts — so binding the receiver afterwards loses every model call the CLI
  // makes before it comes up, which on a short session is all of them.
  // `startModelTracking` swallows its own failures and returns undefined, so a
  // receiver that cannot start still leaves hook serving unaffected.
  stopModelTracking = await startModelTracking(storageDir);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.off('error', reject);
      resetIdleTimer();
      resolve();
    });
  });
}

export function sendRequest(request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(socketPath());
    let body = '';
    connection.setEncoding('utf8');
    connection.once('error', reject);
    connection.on('data', (chunk: string) => {
      body += chunk;
    });
    connection.on('end', () => {
      try {
        resolve(JSON.parse(body) as DaemonResponse);
      } catch (error) {
        reject(error);
      }
    });
    connection.on('connect', () => {
      connection.write(`${JSON.stringify(request)}\n`);
    });
  });
}
