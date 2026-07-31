import {
  startBot as startRuntimeBot,
  type BotEventSink,
  type BotSpec,
  type RunningBot,
} from '../kernel/start-bot.js';
import {
  isBridgeRuntimeParentMessage,
  type BridgeRuntimeChildMessage,
  type BridgeRuntimeParentMessage,
} from './worker-protocol.js';

export interface BridgeRuntimeChildEndpoint {
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  send(message: BridgeRuntimeChildMessage): Promise<void>;
  exit(code: number): void;
}

export interface RunBridgeRuntimeWorkerOptions {
  endpoint?: BridgeRuntimeChildEndpoint;
  startBot?: (
    spec: BotSpec,
    eventSink?: BotEventSink,
  ) => Promise<RunningBot>;
}

/**
 * Runs a single Bridge Runtime kernel behind process IPC.
 *
 * This entry deliberately knows nothing about desktop/data-dir leases. The
 * parent sidecar remains the sole host owner and starts this function before
 * constructing any normal sidecar services.
 */
export function runBridgeRuntimeWorker(
  options: RunBridgeRuntimeWorkerOptions = {},
): void {
  const endpoint = options.endpoint ?? nodeChildEndpoint();
  const startBot = options.startBot ?? startRuntimeBot;
  let bot: RunningBot | undefined;
  let starting: Promise<RunningBot> | undefined;
  let bootstrapped = false;
  let stopping = false;

  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    let error: string | undefined;
    try {
      const running = bot ?? await starting?.catch(() => undefined);
      await running?.stop();
    } catch (cause) {
      error = errorMessage(cause);
    }
    await safeSend(endpoint, {
      type: 'stopped',
      ...(error === undefined ? {} : { error }),
    });
    endpoint.exit(error === undefined ? 0 : 1);
  };

  endpoint.onDisconnect(() => {
    void stop();
  });
  endpoint.onMessage((rawMessage) => {
    if (!isBridgeRuntimeParentMessage(rawMessage)) return;
    void handleMessage(rawMessage);
  });

  async function handleMessage(message: BridgeRuntimeParentMessage): Promise<void> {
    if (message.type === 'stop') {
      await stop();
      return;
    }
    if (message.type === 'admin') {
      if (!bot) {
        await safeSend(endpoint, {
          type: 'admin-result',
          requestId: message.requestId,
          error: { message: 'Bridge Runtime worker is not ready.' },
        });
        return;
      }
      try {
        await bot.executeAdmin(message.op);
        await safeSend(endpoint, {
          type: 'admin-result',
          requestId: message.requestId,
        });
      } catch (cause) {
        const code = errorCode(cause);
        await safeSend(endpoint, {
          type: 'admin-result',
          requestId: message.requestId,
          error: {
            message: errorMessage(cause),
            ...(code === undefined ? {} : { code }),
          },
        });
      }
      return;
    }

    if (bootstrapped || stopping) return;
    bootstrapped = true;
    try {
      starting = startBot(message.spec, (event) => {
        void safeSend(endpoint, { type: 'runtime-event', event });
      });
      const running = await starting;
      if (stopping) return;
      bot = running;
      await safeSend(endpoint, { type: 'ready' });
    } catch (cause) {
      if (stopping) return;
      await safeSend(endpoint, {
        type: 'start-failed',
        error: errorMessage(cause),
      });
      endpoint.exit(1);
    } finally {
      starting = undefined;
    }
  }
}

function nodeChildEndpoint(): BridgeRuntimeChildEndpoint {
  if (typeof process.send !== 'function') {
    throw new Error('Bridge Runtime worker child requires a Node IPC channel.');
  }
  return {
    onMessage(listener) {
      process.on('message', listener);
    },
    onDisconnect(listener) {
      process.once('disconnect', listener);
    },
    send(message) {
      return new Promise((resolve, reject) => {
        if (!process.connected || typeof process.send !== 'function') {
          reject(new Error('Bridge Runtime worker parent IPC is disconnected.'));
          return;
        }
        process.send(message, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    exit(code) {
      process.exit(code);
    },
  };
}

async function safeSend(
  endpoint: BridgeRuntimeChildEndpoint,
  message: BridgeRuntimeChildMessage,
): Promise<void> {
  try {
    await endpoint.send(message);
  } catch {
    // The parent is already gone; never print child output into sidecar stdout.
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function errorCode(cause: unknown): string | undefined {
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
