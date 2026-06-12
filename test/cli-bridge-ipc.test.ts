import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { startCliBridgeIpcServer } from '../src/cli-bridge/ipc';
import type { CliHookMessage } from '../src/cli-bridge/types';

const sampleMsg: CliHookMessage = {
  type: 'permission_request',
  source: 'codex',
  sessionId: 's',
  cwd: '/repo',
  toolInput: {},
  bridgeOwned: false,
  rawPayloadBytes: 2,
};

describe('cli bridge ipc resilience', () => {
  it('restricts Unix socket permissions to the current user', async () => {
    if (process.platform === 'win32') return;
    const dir = await mkdtemp(join(tmpdir(), 'fcb-ipc-mode-'));
    const socketPath = join(dir, 'sock');
    const server = await startCliBridgeIpcServer({
      socketPath,
      handleMessage: async () => ({ decision: 'allow' }),
    });
    try {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });

  // Regression: a hook client that dies while the daemon is blocked waiting for a
  // human approval used to (a) crash the whole daemon — the per-connection socket
  // had no 'error' listener and there is no global uncaughtException net — and
  // (b) wedge graceful shutdown, because server.close() never fires its callback
  // while a connection is still held open inside handleMessage.
  it('survives a client that disconnects mid-wait and still closes promptly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fcb-ipc-res-'));
    const socketPath = join(dir, 'sock');

    let releaseHandler = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerEntered = (): void => {};
    const entered = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });

    const server = await startCliBridgeIpcServer({
      socketPath,
      handleMessage: async () => {
        handlerEntered();
        await blocked; // simulate a long human approval
        return { decision: 'allow' };
      },
    });

    const client = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    // Swallow the inevitable ECONNRESET on the client side after we destroy it.
    client.on('error', () => undefined);
    client.write(JSON.stringify(sampleMsg) + '\n');

    await entered; // the server is now blocked inside handleMessage, socket held open
    client.destroy(); // abrupt disconnect during the pending wait — must not crash

    // close() must resolve even though a handler is still blocked on that socket.
    await expect(server.close()).resolves.toBeUndefined();

    releaseHandler();
  });
});
