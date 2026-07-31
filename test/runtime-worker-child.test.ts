import type {
  BotEventSink,
  BotSpec,
  RunningBot,
} from '../src/kernel/start-bot';
import { describe, expect, it, vi } from 'vitest';
import {
  runBridgeRuntimeWorker,
  type BridgeRuntimeChildEndpoint,
} from '../src/runtime/worker-child';
import type {
  BridgeRuntimeChildMessage,
} from '../src/runtime/worker-protocol';

const SPEC: BotSpec = {
  appId: 'cli_child',
  appSecret: 'child-only-secret',
  accountSecretRef: 'secret-ref',
  tenant: 'feishu',
  ownerOpenId: 'ou_owner',
  admins: [],
  dataDir: '/tmp/vonvon/bots/cli_child',
  legacyAssetsDir: '/Users/test/.feishu-codex-bridge',
  writableAssetsDir: '/Users/test/Library/Application Support/Vonvon Bridge/compat-assets',
  fallbackCwd: '/Users/test',
};

class FakeEndpoint implements BridgeRuntimeChildEndpoint {
  readonly sent: BridgeRuntimeChildMessage[] = [];
  readonly exitCodes: number[] = [];
  #messageListener: ((message: unknown) => void) | undefined;
  #disconnectListener: (() => void) | undefined;

  onMessage(listener: (message: unknown) => void): void {
    this.#messageListener = listener;
  }

  onDisconnect(listener: () => void): void {
    this.#disconnectListener = listener;
  }

  async send(message: BridgeRuntimeChildMessage): Promise<void> {
    this.sent.push(message);
  }

  exit(code: number): void {
    this.exitCodes.push(code);
  }

  message(message: unknown): void {
    this.#messageListener?.(message);
  }

  disconnect(): void {
    this.#disconnectListener?.();
  }
}

describe('runBridgeRuntimeWorker', () => {
  it('boots the complete kernel from IPC and forwards lifecycle without stdout', async () => {
    const endpoint = new FakeEndpoint();
    let eventSink: BotEventSink | undefined;
    const stop = vi.fn(async () => undefined);
    const startBot = vi.fn(async (_spec: BotSpec, sink?: BotEventSink): Promise<RunningBot> => {
      eventSink = sink;
      return {
        status: () => ({ connection: 'connected' }),
        executeAdmin: vi.fn(async () => undefined),
        stop,
      };
    });
    runBridgeRuntimeWorker({ endpoint, startBot });

    endpoint.message({ type: 'bootstrap', spec: SPEC });
    await vi.waitFor(() => expect(startBot).toHaveBeenCalledWith(SPEC, expect.any(Function)));
    await vi.waitFor(() => expect(endpoint.sent).toContainEqual({ type: 'ready' }));

    eventSink?.({
      type: 'status',
      appId: SPEC.appId,
      status: { connection: 'reconnecting' },
      at: 1,
    });
    await vi.waitFor(() => expect(endpoint.sent).toContainEqual({
      type: 'runtime-event',
      event: {
        type: 'status',
        appId: SPEC.appId,
        status: { connection: 'reconnecting' },
        at: 1,
      },
    }));

    endpoint.message({ type: 'stop' });
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(endpoint.exitCodes).toEqual([0]));
  });

  it('reports kernel startup failure only over IPC and exits the child', async () => {
    const endpoint = new FakeEndpoint();
    runBridgeRuntimeWorker({
      endpoint,
      startBot: vi.fn(async () => {
        throw new Error('Feishu connect failed');
      }),
    });

    endpoint.message({ type: 'bootstrap', spec: SPEC });
    await vi.waitFor(() => expect(endpoint.sent).toContainEqual({
      type: 'start-failed',
      error: 'Feishu connect failed',
    }));
    expect(endpoint.exitCodes).toEqual([1]);
  });

  it('stops the running kernel when the parent IPC disconnects', async () => {
    const endpoint = new FakeEndpoint();
    const stop = vi.fn(async () => undefined);
    runBridgeRuntimeWorker({
      endpoint,
      startBot: vi.fn(async () => ({
        status: () => ({ connection: 'connected' as const }),
        executeAdmin: vi.fn(async () => undefined),
        stop,
      })),
    });
    endpoint.message({ type: 'bootstrap', spec: SPEC });
    await vi.waitFor(() => expect(endpoint.sent).toContainEqual({ type: 'ready' }));
    endpoint.disconnect();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(endpoint.exitCodes).toEqual([0]));
  });

  it('waits for an in-flight kernel start and tears it down without sending ready after stop', async () => {
    const endpoint = new FakeEndpoint();
    const stop = vi.fn(async () => undefined);
    let resolveStart: ((bot: RunningBot) => void) | undefined;
    runBridgeRuntimeWorker({
      endpoint,
      startBot: vi.fn(() => new Promise<RunningBot>((resolve) => {
        resolveStart = resolve;
      })),
    });

    endpoint.message({ type: 'bootstrap', spec: SPEC });
    endpoint.disconnect();
    resolveStart?.({
      status: () => ({ connection: 'connected' }),
      executeAdmin: vi.fn(async () => undefined),
      stop,
    });

    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(endpoint.exitCodes).toEqual([0]));
    expect(endpoint.sent).not.toContainEqual({ type: 'ready' });
  });
});
