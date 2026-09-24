import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureStore = vi.hoisted(() => ({ config: {} as unknown }));
const createdCards = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/config/store', () => ({
  saveConfig: vi.fn(async (config: unknown) => { fixtureStore.config = structuredClone(config); }),
  loadConfig: vi.fn(async () => structuredClone(fixtureStore.config)),
}));
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'cli-settings-runtime-'));
  return { paths: { appDir, commentInstructionsFile: join(appDir, 'comment-instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') } };
});
vi.mock('../src/cli-bridge/hooks', () => ({
  inspectCliBridgeHooks: async () => ({ claude: { agent: 'claude', status: 'installed', details: [] }, codex: { agent: 'codex', status: 'installed', details: [] } }),
  installCliBridgeHooks: vi.fn(), resolveBridgeHookCommand: () => 'fixture',
}));
import { paths } from '../src/config/paths';
import { rm } from 'node:fs/promises';
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

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
import { saveConfig } from '../src/config/store';
import { installCliBridgeHooks } from '../src/cli-bridge/hooks';

function cfg(enabled: boolean): AppConfig {
  const result: AppConfig = {
    accounts: { app: { id: 'cli_fixture', secret: 'secret', tenant: 'feishu' } },
    preferences: {
      access: { ownerOpenId: 'ou_owner' },
      cliBridge: { enabled },
    },
  };
  fixtureStore.config = structuredClone(result);
  return result;
}

function channel() {
  let nextCard = 0;
  let nextMessage = 0;
  return {
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: vi.fn(async (request: unknown) => {
              createdCards.push(request);
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
  beforeEach(() => {
    createdCards.length = 0;
    vi.mocked(installCliBridgeHooks).mockReset();
    vi.mocked(saveConfig).mockReset().mockImplementation(async config => { fixtureStore.config = structuredClone(config); });
  });

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

  it('rolls the runtime service back when persisting enabled=true fails', async () => {
    vi.mocked(saveConfig).mockRejectedValueOnce(new Error('disk full'));
    const appCfg = cfg(false);
    const bridge = cliBridge();
    const orchestrator = createOrchestrator(channel(), appCfg, '/repo', bridge);

    await orchestrator.dispatcher.handle({
      chatId: 'ou_owner',
      messageId: 'settings-card',
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.toggleEnabled, v: 'on' } },
    } as never);

    await vi.waitFor(() => expect(bridge.shutdown).toHaveBeenCalledTimes(1));
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(appCfg.preferences?.cliBridge?.enabled).toBe(false);
  });

  it('serializes rapid on/off transitions so runtime follows the final persisted flag', async () => {
    const appCfg = cfg(false);
    const bridge = cliBridge();
    const orchestrator = createOrchestrator(channel(), appCfg, '/repo', bridge);
    const event = (value: 'on' | 'off') => ({
      chatId: 'ou_owner',
      messageId: 'settings-card',
      operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.toggleEnabled, v: value } },
    });

    await Promise.all([
      orchestrator.dispatcher.handle(event('on') as never),
      orchestrator.dispatcher.handle(event('off') as never),
    ]);

    await vi.waitFor(() => expect(bridge.shutdown).toHaveBeenCalledTimes(1));
    expect(appCfg.preferences?.cliBridge?.enabled).toBe(false);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(bridge.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shows partial hook repair failures in the returned settings card', async () => {
    vi.mocked(installCliBridgeHooks).mockRejectedValueOnce(new Error('fixture readonly hook file'));
    const orchestrator = createOrchestrator(channel(), cfg(false), '/repo', cliBridge());
    await orchestrator.dispatcher.handle({
      chatId: 'ou_owner', messageId: 'repair-settings-card', operator: { openId: 'ou_owner' },
      action: { tag: 'button', value: { a: CLI.repairHooks } },
    } as never);
    await vi.waitFor(() => expect(JSON.stringify(createdCards)).toContain('修复失败'));
    expect(installCliBridgeHooks).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(createdCards)).not.toContain('Hooks 已修复。');
  });
});
