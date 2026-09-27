import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bots: [] as { name: string; appId: string; tenant: 'feishu'; createdAt: number; active: boolean }[],
  install: vi.fn(async () => {}),
}));
vi.mock('../src/config/bots', () => ({
  loadBots: async () => ({version: 1, bots: mocks.bots, current: mocks.bots[0]?.appId}),
  currentBot: (registry: {bots: typeof mocks.bots; current?: string}) => registry.bots.find(bot => bot.appId === registry.current),
  activeBots: (registry: {bots: typeof mocks.bots}) => registry.bots.filter(bot => bot.active),
}));
vi.mock('../src/cli-bridge/hooks', () => ({
  inspectCliBridgeHooks: async () => ({
    claude: {agent: 'claude', status: 'not_installed', details: []},
    codex: {agent: 'codex', status: 'not_installed', details: []},
  }),
  installCliBridgeHooks: mocks.install,
  resolveBridgeHookCommand: () => 'vonvon-bridge hook',
}));

import { createHostSettings } from '../src/admin/host-settings';

const dirs: string[] = [];
afterEach(async () => {
  mocks.bots = [];
  mocks.install.mockClear();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('zero-Agent status is read-only and per-tool repair is available without a bot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-coffee-'));
  dirs.push(dir);
  const settings = createHostSettings({appDir: dir});
  const view = await settings.read({kind: 'host'});
  if (!('runtime' in view)) throw new Error('Wrong scope');
  expect(view.runtime.coffee?.route).toBe('legacy');
  expect(view.runtime.coffee?.botId).toBeNull();
  await expect(readFile(join(dir, 'cli-bridge-route.json'))).rejects.toMatchObject({code: 'ENOENT'});
  const result = await settings.act({kind: 'repairHostCliHooks', agents: ['codex']});
  expect(result.kind).toBe('saved');
  expect(mocks.install).toHaveBeenCalledWith({command: 'vonvon-bridge hook', agents: {claude: false, codex: true}});
});

it('legacy bot route blocks unpinned repair until recipient is confirmed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-coffee-'));
  dirs.push(dir);
  mocks.bots = [{name: 'B', appId: 'cli_b', tenant: 'feishu', createdAt: 1, active: true}];
  const settings = createHostSettings({appDir: dir});
  const before = await settings.read({kind: 'host'});
  if (!('runtime' in before) || !before.runtime.coffee) throw new Error('Missing route');
  const rejected = await settings.act({kind: 'repairHostCliHooks', agents: ['codex']});
  expect(rejected.kind).toBe('rejected');
  expect(mocks.install).not.toHaveBeenCalled();
  const saved = await settings.act({kind: 'setHostCliRoute', botId: 'cli_b', revision: before.runtime.coffee.revision});
  expect(saved.kind).toBe('saved');
  expect((await settings.act({kind: 'setHostCliRoute', botId: null, revision: before.runtime.coffee.revision})).kind).toBe('conflict');
  expect((await settings.act({kind: 'repairHostCliHooks', agents: ['codex']})).kind).toBe('saved');
  expect(mocks.install).toHaveBeenCalledTimes(1);
});
