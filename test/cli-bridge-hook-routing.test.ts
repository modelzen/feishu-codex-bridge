import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { selectCliBridgeHookBot } from '../src/cli-bridge';
import { loadBots, type BotEntry, type BotsRegistry } from '../src/config/bots';
import { configurePathRoots } from '../src/config/paths';
import type { AppConfig } from '../src/config/schema';

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  it('loads the host-root registry and per-bot configs for an embedded global hook', async () => {
    const hostDataDir = await mkdtemp(join(tmpdir(), 'vonvon-hook-host-'));
    const legacyAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-hook-legacy-'));
    const writableAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-hook-assets-'));
    directories.push(hostDataDir, legacyAssetsDir, writableAssetsDir);
    configurePathRoots({
      dataDir: hostDataDir,
      hostDataDir,
      legacyAssetsDir,
      writableAssetsDir,
    });
    await writeFile(join(hostDataDir, 'bots.json'), JSON.stringify({
      version: 1,
      current: 'app_alpha',
      bots,
    }));
    for (const [appId, enabled] of [['app_alpha', false], ['app_beta', true]] as const) {
      const botDataDir = join(hostDataDir, 'bots', appId);
      await mkdir(botDataDir, { recursive: true });
      await writeFile(
        join(botDataDir, 'config.json'),
        JSON.stringify(config(appId, enabled)),
      );
    }

    const selected = await selectCliBridgeHookBot(await loadBots());

    expect(selected?.appId).toBe('app_beta');
  });
});
