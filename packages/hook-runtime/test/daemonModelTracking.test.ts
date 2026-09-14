import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startModelTracking } from '../src/daemon.js';
import { enableTracking, readConnection } from '../src/modelTracking.js';

let storage: string;

beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'slipstream-daemon-mt-'));
});

afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

function traceBatch(token: string) {
  const span = {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
    startTimeUnixNano: '1789202408000000000', endTimeUnixNano: '1789202409000000000',
    attributes: Object.entries({
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'github',
      'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'gpt-5.4',
      'gen_ai.conversation.id': 'conversation-one',
    }).map(([key, value]) => ({ key, value: { stringValue: value } })),
  };
  return { body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }), token };
}

describe('daemon-hosted model tracking', () => {
  it('does nothing when tracking is not consented', async () => {
    expect(await startModelTracking(storage)).toBeUndefined();
  });

  it('binds a receiver, persists the port, and records observations into the ledger', async () => {
    const connection = enableTracking(storage);
    const stop = await startModelTracking(storage);
    expect(stop).toBeDefined();
    try {
      const bound = readConnection(storage);
      expect(bound?.port).toBeGreaterThan(0);
      const endpoint = `http://127.0.0.1:${bound!.port}`;

      const { body, token } = traceBatch(connection.token);
      const response = await fetch(`${endpoint}/v1/traces`, {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await stop!();
    }

    const ledger = fs.readFileSync(path.join(storage, 'savings.jsonl'), 'utf8');
    expect(ledger).toContain('gpt-5.4');
    expect(ledger).toContain('copilot-otel:conversation-one');
  });

  it('reuses the persisted port on a later start', async () => {
    enableTracking(storage);
    const first = await startModelTracking(storage);
    const port = readConnection(storage)!.port;
    await first!();
    const second = await startModelTracking(storage);
    try {
      expect(readConnection(storage)!.port).toBe(port);
    } finally {
      await second!();
    }
  });
});
