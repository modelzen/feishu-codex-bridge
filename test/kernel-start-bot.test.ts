import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configurePathRoots: vi.fn(),
  useBotDir: vi.fn(),
  loadConfig: vi.fn(),
  provideRuntimeFileSecret: vi.fn(),
  revokeRuntimeSecret: vi.fn(),
  startBridge: vi.fn(),
  diagnoseEventSubscription: vi.fn(),
  summarizeEventDiagnosis: vi.fn(),
}));

vi.mock('../src/config/paths', () => ({
  configurePathRoots: mocks.configurePathRoots,
  useBotDir: mocks.useBotDir,
}));

vi.mock('../src/bot/bridge', () => ({
  startBridge: mocks.startBridge,
}));

vi.mock('../src/config/store', () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock('../src/config/secret-resolver', () => ({
  provideRuntimeFileSecret: mocks.provideRuntimeFileSecret,
}));

vi.mock('../src/utils/event-diagnosis', () => ({
  diagnoseEventSubscription: mocks.diagnoseEventSubscription,
  summarizeEventDiagnosis: mocks.summarizeEventDiagnosis,
}));

import {
  startBot,
  type BotRuntimeEvent,
} from '../src/kernel/start-bot';
import { restartDaemon } from '../src/service/update';

const spec = {
  appId: 'cli_alpha',
  appSecret: 'secret-alpha',
  accountSecretRef: 'robot/alpha/app-secret',
  tenant: 'feishu' as const,
  ownerOpenId: 'ou_owner',
  admins: ['ou_admin', 'ou_owner', 'ou_admin'],
  preferences: {
    messageReply: 'markdown' as const,
    access: {
      allowedChats: ['oc_project'],
    },
  },
  dataDir: '/tmp/vonvon-data',
  hostDataDir: '/tmp/vonvon-host',
  legacyAssetsDir: '/tmp/feishu-assets',
  writableAssetsDir: '/tmp/vonvon-assets',
  managedToolsDir: '/tmp/vonvon-managed-tools',
  fallbackCwd: '/tmp/projects',
};

beforeEach(() => {
  mocks.configurePathRoots.mockReset();
  mocks.useBotDir.mockReset();
  mocks.loadConfig.mockReset();
  mocks.loadConfig.mockResolvedValue({});
  mocks.provideRuntimeFileSecret.mockReset();
  mocks.revokeRuntimeSecret.mockReset();
  mocks.provideRuntimeFileSecret.mockReturnValue(mocks.revokeRuntimeSecret);
  mocks.startBridge.mockReset();
  mocks.diagnoseEventSubscription.mockReset();
  mocks.diagnoseEventSubscription.mockResolvedValue({
    state: 'ok',
    missingOptional: [],
  });
  mocks.summarizeEventDiagnosis.mockReset();
  mocks.summarizeEventDiagnosis.mockImplementation(
    (diagnosis: { state: string }) => diagnosis.state,
  );
});

describe('startBot compatibility seam', () => {
  it('selects the per-bot directory and forces owner/admins into AppConfig', async () => {
    const adminExecute = vi.fn(async () => undefined);
    const shutdown = vi.fn(async () => undefined);
    mocks.startBridge.mockResolvedValue({
      channel: {},
      adminExecute,
      shutdown,
    });
    const events: BotRuntimeEvent[] = [];

    const running = await startBot(spec, (event) => events.push(event));

    expect(mocks.configurePathRoots).toHaveBeenCalledWith({
      dataDir: spec.dataDir,
      hostDataDir: spec.hostDataDir,
      legacyAssetsDir: spec.legacyAssetsDir,
      writableAssetsDir: spec.writableAssetsDir,
      managedToolsDir: spec.managedToolsDir,
    });
    expect(mocks.useBotDir).toHaveBeenCalledWith(spec.appId);
    const bridgeOptions = mocks.startBridge.mock.calls[0]?.[0];
    expect(bridgeOptions).toMatchObject({
      appSecret: spec.appSecret,
      fallbackCwd: spec.fallbackCwd,
      cfg: {
        accounts: {
          app: {
            id: spec.appId,
            secret: {
              source: 'file',
              id: spec.accountSecretRef,
            },
            tenant: spec.tenant,
          },
        },
        preferences: {
          messageReply: 'markdown',
          access: {
            allowedChats: ['oc_project'],
            ownerOpenId: 'ou_owner',
            admins: ['ou_admin'],
          },
        },
      },
    });
    expect(running.status()).toEqual({ connection: 'connected' });
    expect(statusEvents(events).map((event) => event.status.connection)).toEqual([
      'connecting',
      'connected',
    ]);

    await running.executeAdmin({
      kind: 'setNoMention',
      project: 'alpha',
      on: true,
    });
    expect(adminExecute).toHaveBeenCalledWith({
      kind: 'setNoMention',
      project: 'alpha',
      on: true,
    });

    const lifecycle = bridgeOptions?.onLifecycleEvent;
    lifecycle?.({ type: 'reconnecting' });
    expect(running.status()).toEqual({ connection: 'reconnecting' });
    lifecycle?.({ type: 'error', error: new Error('socket lost') });
    expect(running.status()).toEqual({
      connection: 'reconnecting',
      lastError: 'socket lost',
    });
    lifecycle?.({ type: 'reconnected' });
    expect(running.status()).toEqual({ connection: 'connected' });

    await restartDaemon();
    expect(events).toContainEqual({
      type: 'restart-requested',
      appId: spec.appId,
      at: expect.any(Number),
    });

    await Promise.all([running.stop(), running.stop()]);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(mocks.revokeRuntimeSecret).toHaveBeenCalledTimes(1);
    expect(running.status()).toEqual({ connection: 'disconnected' });
  });

  it('reports startup failures and rethrows them', async () => {
    mocks.startBridge.mockRejectedValue(new Error('credential rejected'));
    const events: BotRuntimeEvent[] = [];

    await expect(startBot(spec, (event) => events.push(event))).rejects.toThrow(
      'credential rejected',
    );
    expect(statusEvents(events).map((event) => event.status)).toEqual([
      { connection: 'connecting' },
      { connection: 'disconnected', lastError: 'credential rejected' },
    ]);
  });

  it('reports a connected-but-unpublished event subscription as the reason DMs stay silent', async () => {
    mocks.startBridge.mockResolvedValue({
      channel: {},
      adminExecute: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    });
    mocks.diagnoseEventSubscription.mockResolvedValue({
      state: 'missing',
      version: '1.0.0',
      missingRequired: ['im.message.receive_v1'],
      missingOptional: [],
    });
    const events: BotRuntimeEvent[] = [];

    const running = await startBot(spec, (event) => events.push(event));

    await vi.waitFor(() => {
      expect(running.status()).toMatchObject({
        connection: 'connected',
        eventSubscriptionWarning: expect.stringContaining('私聊和群聊消息都会没有响应'),
      });
    });
    expect(running.status().eventSubscriptionWarning).toContain('im.message.receive_v1');
    expect(running.status().eventSubscriptionWarning).toContain(
      'https://open.feishu.cn/app/cli_alpha/event',
    );
    expect(statusEvents(events).at(-1)?.status).toEqual(running.status());

    await running.stop();
  });
});

function statusEvents(
  events: readonly BotRuntimeEvent[],
): Extract<BotRuntimeEvent, { type: 'status' }>[] {
  return events.filter(
    (event): event is Extract<BotRuntimeEvent, { type: 'status' }> => event.type === 'status',
  );
}
