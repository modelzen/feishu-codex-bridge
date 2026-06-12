import { chmod, rm } from 'node:fs/promises';
import net from 'node:net';
import type { CliHookMessage, CliHookResponse } from './types';

export interface CliBridgeIpcServer {
  close: () => Promise<void>;
}

export async function startCliBridgeIpcServer(opts: {
  socketPath: string;
  handleMessage: (msg: CliHookMessage) => Promise<CliHookResponse>;
}): Promise<CliBridgeIpcServer> {
  // Unix sockets leave a stale file to clear before re-binding; Windows named
  // pipes aren't files (and `\\.\pipe\…` isn't a removable path), so skip it.
  if (process.platform !== 'win32') {
    await rm(opts.socketPath, { force: true }).catch(() => undefined);
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A hook client that dies mid-wait (Ctrl-C during a pending approval), or a
    // broken pipe when we socket.end() the response, emits 'error'. Without this
    // listener Node rethrows it as an uncaught exception and crashes the whole
    // bot daemon (there is no global uncaughtException net).
    socket.on('error', () => sockets.delete(socket));
    let data = '';
    let handled = false;
    socket.on('data', (chunk) => {
      // One request per connection: ignore any bytes that arrive after the first
      // complete line so a second chunk can't re-fire handleMessage on the same line.
      if (handled) return;
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      handled = true;
      const line = data.split('\n')[0] ?? '';
      void (async () => {
        try {
          const msg = JSON.parse(line) as CliHookMessage;
          const response = await opts.handleMessage(msg);
          socket.end(JSON.stringify(response) + '\n');
        } catch (err) {
          socket.end(JSON.stringify({ decision: 'fallback_local', reason: err instanceof Error ? err.message : String(err) }) + '\n');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.off('error', reject);
      if (process.platform === 'win32') {
        resolve();
        return;
      }
      chmod(opts.socketPath, 0o600).then(resolve, (err) => {
        server.close(() => reject(err));
      });
    });
  });
  return {
    close: () =>
      new Promise((resolve) => {
        // Destroy in-flight connections first: a socket whose handleMessage is
        // still blocked on a human approval keeps server.close()'s callback from
        // ever firing, which would wedge graceful shutdown / restart.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

export async function sendCliHookMessage(socketPath: string, msg: CliHookMessage): Promise<CliHookResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setTimeout(86400_000);
    socket.on('connect', () => socket.write(JSON.stringify(msg) + '\n'));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      socket.end();
      try {
        resolve(JSON.parse(data.split('\n')[0] ?? '') as CliHookResponse);
      } catch (err) {
        reject(err);
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('cli bridge IPC timeout'));
    });
    socket.on('error', reject);
  });
}
