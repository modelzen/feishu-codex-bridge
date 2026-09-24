import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { bridgePipeName, getterContents, isBridgeGetter, repairLinkedCompatibility } from '../src/config/data-compatibility';
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it('keeps old Windows pipe identity only for a validated directory alias', () => {
  const home = mkdtempSync(join(tmpdir(), 'vonvon-pipes-')); homes.push(home);
  const root = join(home, '.vonvon-bridge'); mkdirSync(root);
  const bot = join(root, 'bots', 'fixture');
  const expected = (path: string): string => `\\\\.\\pipe\\feishu-cli-bridge-${createHash('sha1').update(path).digest('hex').slice(0, 16)}`;
  expect(bridgePipeName(home, root, bot)).toBe(expected(bot));
  const legacy = join(home, '.feishu-codex-bridge');
  symlinkSync(root, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  expect(bridgePipeName(home, root, bot)).toBe(expected(join(legacy, 'bots', 'fixture')));
  const wrapper = join(root, 'secrets-getter'); writeFileSync(wrapper, 'fixture');
  expect(isBridgeGetter(join(legacy, 'secrets-getter'), [], home, wrapper)).toBe(true);
  expect(isBridgeGetter('/arbitrary/program', ['secrets', 'get'], home, wrapper)).toBe(false);
});

it('recognizes only a Node provider proven by the exact generated wrapper and refreshes Windows providers', () => {
  const home = mkdtempSync(join(tmpdir(), 'vonvon-provider-')); homes.push(home);
  const root = join(home, '.vonvon-bridge'); mkdirSync(root);
  const wrapper = join(root, 'secrets-getter');
  const old = { nodePath: 'C:\\removed\\node.exe', cliPath: "C:\\runtime A's\\cli.mjs" };
  const args = [old.cliPath, 'secrets', 'get'];
  writeFileSync(wrapper, getterContents(old));
  expect(isBridgeGetter(old.nodePath, args, home, wrapper)).toBe(true);
  expect(isBridgeGetter(old.nodePath, ['C:\\custom\\cli.mjs', 'secrets', 'get'], home, wrapper)).toBe(false);
  const custom = { command: old.nodePath, args: ['custom-cli.mjs', 'secrets', 'get'] };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ secrets: { providers: { bridge: { command: old.nodePath, args, env: { KEEP: 'yes' } }, custom } } }));
  const runtime = { nodePath: join(home, 'node.exe'), cliPath: join(home, 'cli.mjs') };
  writeFileSync(runtime.nodePath, 'fixture'); writeFileSync(runtime.cliPath, 'fixture');
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { repairLinkedCompatibility(home, root, runtime); } finally { Object.defineProperty(process, 'platform', { value: platform }); }
  const providers = JSON.parse(readFileSync(configPath, 'utf8')).secrets.providers;
  expect(providers.bridge).toEqual({ command: runtime.nodePath, args: [runtime.cliPath, 'secrets', 'get'], env: { KEEP: 'yes', HOME: home, USERPROFILE: home } });
  expect(providers.custom).toEqual(custom);
  expect(isBridgeGetter(runtime.nodePath, providers.bridge.args, home, wrapper)).toBe(true);
  expect(isBridgeGetter(old.nodePath, args, home, wrapper)).toBe(false);
});
