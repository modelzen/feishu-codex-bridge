import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMock = vi.hoisted(() => ({
  startBridge: vi.fn(),
}));

vi.mock('../src/bot/bridge', () => ({
  startBridge: bridgeMock.startBridge,
}));

import { createAppPreferencesWriter } from '../src/admin/ops';
import type { BridgeOptions } from '../src/bot/bridge';
import { resolveAppSecret } from '../src/config/secret-resolver';
import { startBot } from '../src/kernel/start-bot';

const directories: string[] = [];

beforeEach(() => {
  bridgeMock.startBridge.mockReset();
});

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('startBot config persistence compatibility', () => {
  it('keeps Vonvon metadata and never persists the plaintext app secret after an admin save', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-config-'));
    const legacyAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-assets-'));
    const writableAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-writable-assets-'));
    directories.push(dataDir, legacyAssetsDir, writableAssetsDir);
    const configFile = join(dataDir, 'config.json');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      configFile,
      JSON.stringify({
        accounts: {
          metadata: 'keep-accounts',
          app: {
            id: 'cli_old',
            tenant: 'lark',
            secret: 'LEGACY-PLAINTEXT',
            displayName: 'keep-app',
          },
        },
        preferences: {
          showModel: 'always',
          futurePreference: { enabled: true },
          access: {
            ownerOpenId: 'ou_old_owner',
            admins: ['ou_old_admin'],
            allowedChats: ['oc_old'],
            futureAccess: 'keep-access',
          },
        },
        vonvon: {
          version: 1,
          robot: { id: 'robot-1', marker: 'keep-vonvon' },
        },
        futureRoot: { enabled: true },
      }),
      'utf8',
    );

    let liveConfig: BridgeOptions['cfg'] | undefined;
    bridgeMock.startBridge.mockImplementation(async (options: BridgeOptions) => {
      liveConfig = options.cfg;
      const writePreferences = createAppPreferencesWriter({ cfg: options.cfg });
      return {
        channel: {},
        adminExecute: async () => {
          await writePreferences((preferences) => {
            preferences.showToolCalls = false;
          });
        },
        shutdown: async () => undefined,
      };
    });

    const running = await startBot({
      appId: 'cli_alpha',
      appSecret: 'CURRENT-PLAINTEXT',
      accountSecretRef: 'robot/robot-1/app-secret',
      tenant: 'feishu',
      ownerOpenId: 'ou_owner',
      admins: ['ou_admin'],
      preferences: {
        messageReply: 'markdown',
        access: { allowedChats: ['oc_new'] },
      },
      dataDir,
      legacyAssetsDir,
      writableAssetsDir,
      fallbackCwd: join(writableAssetsDir, 'projects'),
    });

    await expect(resolveAppSecret(liveConfig!)).resolves.toBe('CURRENT-PLAINTEXT');
    await running.executeAdmin({
      kind: 'setNoMention',
      project: 'alpha',
      on: true,
    });

    const persistedText = await readFile(configFile, 'utf8');
    const persisted = JSON.parse(persistedText);
    expect(persisted).toMatchObject({
      accounts: {
        metadata: 'keep-accounts',
        app: {
          id: 'cli_alpha',
          tenant: 'feishu',
          secret: {
            source: 'file',
            id: 'robot/robot-1/app-secret',
          },
          displayName: 'keep-app',
        },
      },
      preferences: {
        showModel: 'always',
        showToolCalls: false,
        messageReply: 'markdown',
        futurePreference: { enabled: true },
        access: {
          ownerOpenId: 'ou_owner',
          admins: ['ou_admin'],
          allowedChats: ['oc_new'],
          futureAccess: 'keep-access',
        },
      },
      vonvon: {
        version: 1,
        robot: { id: 'robot-1', marker: 'keep-vonvon' },
      },
      futureRoot: { enabled: true },
    });
    expect(persistedText).not.toContain('CURRENT-PLAINTEXT');
    expect(persistedText).not.toContain('LEGACY-PLAINTEXT');

    await running.stop();
  });
});
