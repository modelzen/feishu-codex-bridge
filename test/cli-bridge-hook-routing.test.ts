import { describe, expect, it } from 'vitest';
import { selectCliBridgeHookBot } from '../src/cli-bridge';
import type { BotEntry, BotsRegistry } from '../src/config/bots';
import type { AppConfig } from '../src/config/schema';

const bots: BotEntry[] = [
  { name: 'alpha', appId: 'app_alpha', tenant: 'feishu', createdAt: 1, active: true },
  { name: 'beta', appId: 'app_beta', tenant: 'feishu', createdAt: 2, active: true },
];

function registry(current: string = 'app_alpha'): BotsRegistry {
  return { version: 1, current, bots: bots.map((bot) => ({ ...bot })) };
}

function config(appId: string, enabled: boolean): AppConfig {
  return {
    accounts: { app: { id: appId, secret: 'secret', tenant: 'feishu' } },
    preferences: {
      access: { ownerOpenId: 'ou_owner' },
      cliBridge: { enabled },
    },
  };
}

function loader(enabled: Record<string, boolean>) {
  return async (appId: string) => (appId in enabled ? config(appId, enabled[appId] ?? false) : {});
}

describe('cli bridge hook bot routing', () => {
  it('honors an explicit bot selector from the installed hook command', async () => {
    const selected = await selectCliBridgeHookBot(registry(), {
      requested: 'beta',
      loadConfigForBot: loader({ app_alpha: true, app_beta: false }),
    });
    expect(selected?.appId).toBe('app_beta');
  });

  it('can route an explicit appId even when the registry cannot resolve it', async () => {
    const selected = await selectCliBridgeHookBot(registry(), {
      requested: 'app_unknown',
      loadConfigForBot: loader({ app_alpha: true, app_beta: true }),
    });
    expect(selected?.appId).toBe('app_unknown');
  });

  it('keeps the current bot when it has cli bridge enabled', async () => {
    const selected = await selectCliBridgeHookBot(registry(), {
      loadConfigForBot: loader({ app_alpha: true, app_beta: true }),
    });
    expect(selected?.appId).toBe('app_alpha');
  });

  it('routes to another active bot when the current bot has cli bridge disabled', async () => {
    const selected = await selectCliBridgeHookBot(registry(), {
      loadConfigForBot: loader({ app_alpha: false, app_beta: true }),
    });
    expect(selected?.appId).toBe('app_beta');
  });
});
