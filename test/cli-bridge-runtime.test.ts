import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/store', () => ({
  saveConfig: vi.fn(async () => undefined),
}));

vi.mock('../src/core/logger', () => ({
  log: {
    info: () => undefined,
    warn: () => undefined,
    fail: () => undefined,
  },
  withTrace: async (_ctx: unknown, fn: () => Promise<void> | void) => fn(),
}));

import { createOrchestrator, type CliBridgeRuntimeHooks } from '../src/bot/handle-message';
import { CLI } from '../src/cli-bridge/cards';
import type { AppConfig } from '../src/config/schema';

function cfg(enabled: boolean): AppConfig {
  return {
    accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
    preferences: {
      access: { ownerOpenId: 'ou_owner' },
      cliBridge: { enabled },
    },
  };
}

function channel() {
  let nextCard = 0;
  let nextMessage = 0;
  return {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: vi.fn(async () => {
              nextCard += 1;
              return { data: { card_id: `card_${nextCard}` } };
            }),
            update: vi.fn(async () => ({})),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: vi.fn(async () => {
              nextMessage += 1;
              return { data: { message_id: `message_${nextMessage}` } };
            }),
          },
        },
      },
    },
  } as never;
}

function cliBridge(overrides: Partial<CliBridgeRuntimeHooks> = {}): CliBridgeRuntimeHooks {
  return {
    onMessage: vi.fn(() => false),
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('cli bridge runtime settings', () => {
  it('starts the runtime service when Local agents is enabled from settings', async () => {
    const appCfg = cfg(false);
    const bridge = cliBridge();
    const orchestrator = createOrchestrator(channel(), appCfg, '/repo', bridge);

    await orchestrator.dispatcher.handle({
      chatId: 'ou_owner',
      messageId: 'settings-card',
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.toggleEnabled, v: 'on' } },
    } as never);

    expect(appCfg.preferences?.cliBridge?.enabled).toBe(true);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(bridge.shutdown).not.toHaveBeenCalled();
  });

  it('stops the runtime service when Local agents is disabled from settings', async () => {
    const appCfg = cfg(true);
    const bridge = cliBridge();
    const orchestrator = createOrchestrator(channel(), appCfg, '/repo', bridge);

    await orchestrator.dispatcher.handle({
      chatId: 'ou_owner',
      messageId: 'settings-card',
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.toggleEnabled, v: 'off' } },
    } as never);

    expect(appCfg.preferences?.cliBridge?.enabled).toBe(false);
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
    expect(bridge.start).not.toHaveBeenCalled();
  });

  it('does not persist enabled=true when starting the runtime service fails', async () => {
    const appCfg = cfg(false);
    const bridge = cliBridge({ start: vi.fn(async () => { throw new Error('bind failed'); }) });
    const orchestrator = createOrchestrator(channel(), appCfg, '/repo', bridge);

    await orchestrator.dispatcher.handle({
      chatId: 'ou_owner',
      messageId: 'settings-card',
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.toggleEnabled, v: 'on' } },
    } as never);

    expect(appCfg.preferences?.cliBridge?.enabled).toBe(false);
  });
});
