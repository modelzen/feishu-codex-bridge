import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bots: [] as { name: string; appId: string; tenant: 'feishu'; createdAt: number; active: boolean }[],
  targets: {codex: [] as (string | null)[], claude: [] as (string | null)[]},
  install: vi.fn(async () => {}),
}));
vi.mock('../src/config/bots', () => ({
  loadBots: async () => ({version: 1, bots: mocks.bots, current: mocks.bots[0]?.appId}),
  currentBot: (registry: {bots: typeof mocks.bots; current?: string}) => registry.bots.find(bot => bot.appId === registry.current),
  findBot: (registry: {bots: typeof mocks.bots}, id: string) => registry.bots.find(bot => bot.appId === id || bot.name === id),
  activeBots: (registry: {bots: typeof mocks.bots}) => registry.bots.filter(bot => bot.active),
}));
vi.mock('../src/cli-bridge/hooks', () => ({
  inspectCliBridgeHookTargets: async () => mocks.targets,
  inspectCliBridgeHooks: async () => ({
    claude: {agent: 'claude', status: 'not_installed', details: []},
    codex: {agent: 'codex', status: 'not_installed', details: []},
  }),
  installCliBridgeHooks: mocks.install,
  resolveBridgeHookCommand: (id?: string) => 'vonvon-bridge hook' + (id ? ` --bot ${id}` : ''),
}));

import { createHostSettings } from '../src/admin/host-settings';

const dirs: string[] = [];
afterEach(async () => {
  mocks.bots = [];
  mocks.targets = {codex: [], claude: []};
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

it('existing settings resolve immediately and repair preserves the installed target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-coffee-'));
  dirs.push(dir);
  mocks.bots = [{name: 'B', appId: 'cli_b', tenant: 'feishu', createdAt: 1, active: true}];
  const settings = createHostSettings({appDir: dir});
  const before = await settings.read({kind: 'host'});
  if (!('runtime' in before) || !before.runtime.coffee) throw new Error('Missing route');
  expect(before.runtime.coffee.botId).toBe('cli_b');
  await expect(readFile(join(dir, 'cli-bridge-route.json'))).rejects.toMatchObject({code: 'ENOENT'});
  mocks.targets.codex = ['cli_b'];
  const repaired = await settings.act({kind: 'repairHostCliHooks', agents: ['codex']});
  expect(repaired.kind).toBe('saved');
  expect(mocks.install).toHaveBeenCalledWith({command: 'vonvon-bridge hook --bot cli_b', agents: {claude: false, codex: true}});
  const saved = await settings.act({kind: 'setHostCliRoute', botId: 'cli_b', revision: before.runtime.coffee.revision});
  expect(saved.kind).toBe('saved');
  expect((await settings.act({kind: 'setHostCliRoute', botId: null, revision: before.runtime.coffee.revision})).kind).toBe('conflict');
  expect((await settings.act({kind: 'repairHostCliHooks', agents: ['codex']})).kind).toBe('saved');
  expect(mocks.install).toHaveBeenCalledTimes(2);
});

it('stopping delivery keeps a readable dormant editor and does not silently select another target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-coffee-'));
  dirs.push(dir);
  mocks.bots = ['a', 'b'].map(name => ({name, appId: `cli_${name}`, tenant: 'feishu', createdAt: 1, active: true}));
  const settings = createHostSettings({appDir: dir});
  const initial = await settings.read({kind: 'host'});
  if (!('runtime' in initial) || !initial.runtime.coffee) throw new Error('Missing coffee');
  await settings.act({kind: 'setHostCliRoute', botId: null, revision: initial.runtime.coffee.revision});
  const stopped = await settings.read({kind: 'host'});
  if (!('runtime' in stopped)) throw new Error('Wrong scope');
  expect(stopped.runtime.coffee).toMatchObject({route: 'none', botId: null, editorBotId: 'cli_a', targets: {codex: [], claude: []}});
});

it('conflicting installed pins remain visible and are not overwritten by repair', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-coffee-'));
  dirs.push(dir);
  mocks.bots = ['a', 'b'].map(name => ({name, appId: `cli_${name}`, tenant: 'feishu', createdAt: 1, active: true}));
  mocks.targets.codex = ['cli_a', 'cli_b'];
  const settings = createHostSettings({appDir: dir});
  const result = await settings.act({kind: 'repairHostCliHooks', agents: ['codex']});
  expect(mocks.install).not.toHaveBeenCalled();
  if (result.kind !== 'saved') throw new Error('Unexpected result');
  expect(result.warnings).toHaveLength(1);
  expect(result.view).toMatchObject({runtime: {coffee: {targets: {codex: ['cli_a', 'cli_b']}}}});
});
