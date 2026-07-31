import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type {
  BridgeRuntimeAdminOp,
  BridgeRuntimeBotSpec,
  BridgeRuntimeChildProcess,
  BridgeRuntimeParentMessage,
  BotRuntimeEvent,
} from '../src/runtime/index';
import {
  BridgeRuntimeNotConfiguredError,
  startBridgeRuntime,
} from '../src/runtime/index';

const BOT: BridgeRuntimeBotSpec = {
  appId: 'cli_first',
  accountSecretRef: 'secret/first',
  tenant: 'feishu',
  ownerOpenId: 'ou_owner',
  admins: ['ou_admin'],
  dataDir: '/tmp/bridge/bots/cli_first',
  legacyAssetsDir: '/tmp/legacy',
  writableAssetsDir: '/tmp/bridge/assets',
  fallbackCwd: '/tmp',
};

class FakeChild extends EventEmitter implements BridgeRuntimeChildProcess {
  connected = true;
  readonly pid: number;
  readonly sent: BridgeRuntimeParentMessage[] = [];
  readonly signals: NodeJS.Signals[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  send(
    message: BridgeRuntimeParentMessage,
    callback?: (error: Error | null) => void,
  ): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    return true;
  }
}

describe('public Bridge Runtime interface', () => {
  it('starts all robots, becomes ready when one connects, and routes admin operations', async () => {
    const children: FakeChild[] = [];
    const specs: BridgeRuntimeBotSpec[] = [
      BOT,
      {
        ...BOT,
        appId: 'cli_second',
        accountSecretRef: 'secret/second',
        dataDir: '/tmp/bridge/bots/cli_second',
      },
    ];
    const started = startBridgeRuntime({
      loadBotSpecs: async () => specs,
      resolveAppSecret: async (_secretRef, appId) => `secret-for-${appId}`,
      createBotLauncher: () => () => {
        const child = new FakeChild(4_000 + children.length);
        children.push(child);
        return child;
      },
    });

    await vi.waitFor(() => expect(children).toHaveLength(2));
    children.forEach((child) => child.emit('spawn'));
    await vi.waitFor(() => {
      expect(children.every((child) => child.sent[0]?.type === 'bootstrap')).toBe(true);
    });
    children[0]!.emit('message', { type: 'ready' });
    const runtime = await started;

    expect(runtime.status('cli_first')).toMatchObject({
      running: true,
      connection: 'connecting',
    });

    const operation = { kind: 'test-operation' } as unknown as BridgeRuntimeAdminOp;
    const admin = runtime.executeAdmin('cli_first', operation);
    await vi.waitFor(() => {
      expect(children[0]!.sent.some((message) => message.type === 'admin')).toBe(true);
    });
    const request = children[0]!.sent.find((message) => message.type === 'admin');
    children[0]!.emit('message', {
      type: 'admin-result',
      requestId: request?.type === 'admin' ? request.requestId : '',
    });
    await admin;

    const stopping = runtime.stop();
    children.forEach((child) => child.emit('exit', 0, null));
    await stopping;
  });

  it('keeps healthy robots running when another credential is unavailable', async () => {
    const children: FakeChild[] = [];
    const events: BotRuntimeEvent[] = [];
    const started = startBridgeRuntime({
      loadBotSpecs: async () => [
        BOT,
        {
          ...BOT,
          appId: 'cli_missing',
          accountSecretRef: 'secret/missing',
          dataDir: '/tmp/bridge/bots/cli_missing',
        },
      ],
      resolveAppSecret: async (secretRef) => (
        secretRef === 'secret/missing' ? undefined : 'healthy-secret'
      ),
      createBotLauncher: () => () => {
        const child = new FakeChild(5_000);
        children.push(child);
        return child;
      },
      onRuntimeEvent: (event) => events.push(event),
    });

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit('spawn');
    await vi.waitFor(() => expect(children[0]!.sent[0]?.type).toBe('bootstrap'));
    children[0]!.emit('message', { type: 'ready' });
    const runtime = await started;

    expect(events).toContainEqual(expect.objectContaining({
      type: 'status',
      appId: 'cli_missing',
      status: expect.objectContaining({
        connection: 'disconnected',
        lastError: expect.stringContaining('凭据缺失'),
      }),
    }));

    const stopping = runtime.stop();
    children[0]!.emit('exit', 0, null);
    await stopping;
  });

  it('rejects duplicate robot identities before starting processes', async () => {
    await expect(startBridgeRuntime({
      loadBotSpecs: async () => [BOT, { ...BOT }],
      resolveAppSecret: async () => 'secret',
      createBotLauncher: () => {
        throw new Error('launcher must not be created');
      },
    })).rejects.toBeInstanceOf(BridgeRuntimeNotConfiguredError);
  });
});
