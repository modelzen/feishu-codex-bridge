import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateHostDataOffline } from '../src/host/migration';
import { assertKnownOwnersStopped, stopInstallation } from '../src/service/control';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
const platform = process.platform;
const homes: string[] = [];
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it('retains Windows PID evidence and rejects a failed tree termination', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-stop-')); homes.push(home);
  const root = join(home, '.feishu-codex-bridge'); mkdirSync(root);
  const file = join(root, 'service.pid'); writeFileSync(file, '424242');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(spawnSync).mockImplementation((command) => ({
    pid: 1, output: [], signal: null, status: command === 'taskkill' ? 1 : 0,
    stdout: command === 'powershell.exe' ? 'node C:\\bridge\\feishu-codex-bridge.mjs run' : '', stderr: '',
  }));
  await expect(stopInstallation(home)).rejects.toThrow(/taskkill/);
  expect(readFileSync(file, 'utf8')).toBe('424242');
});
it('refuses to terminate a reused Windows PID with a different command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-stop-')); homes.push(home);
  const root = join(home, '.vonvon-bridge'); mkdirSync(root);
  const file = join(root, 'service.pid'); writeFileSync(file, '424243');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], signal: null, status: 0, stdout: 'other.exe', stderr: '' });
  await expect(stopInstallation(home)).rejects.toThrow(/identity/);
  expect(readFileSync(file, 'utf8')).toBe('424243');
  expect(vi.mocked(spawnSync).mock.calls.some(([command]) => command === 'taskkill')).toBe(false);
});

it.each(['bot init', 'bot use', 'bot list', 'bot rm fixture', 'doctor', 'logs -f', 'web'])('fences supported legacy data client %s', (command) => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-legacy-')); homes.push(home);
  mkdirSync(join(home, '.feishu-codex-bridge'));
  vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], signal: null, status: 0, stdout: `424242 node /installed/bin/feishu-codex-bridge.mjs ${command}`, stderr: '' });
  expect(() => assertKnownOwnersStopped(home)).toThrow(/older Bridge process/);
});
it.each(['runaway', 'botany', 'webhook', '__unrelated', 'secrets-other'])('does not classify unrelated command %s', (command) => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-unrelated-')); homes.push(home);
  vi.mocked(spawnSync).mockReturnValue({ pid: 1, output: [], signal: null, status: 0, stdout: `424242 node /installed/bin/feishu-codex-bridge.mjs ${command}`, stderr: '' });
  expect(() => assertKnownOwnersStopped(home)).not.toThrow();
});

it('defers migration for a shipped legacy bot client before publishing a journal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-bot-migrate-')); homes.push(home);
  mkdirSync(join(home, '.feishu-codex-bridge'));
  vi.mocked(spawnSync).mockImplementation((command, args) => ({ pid: 1, output: [], signal: null, status: 0,
    stdout: command === 'ps' || (command === 'powershell.exe' && args?.some(arg => arg.includes('Get-CimInstance')))
      ? '424242 node /installed/bin/feishu-codex-bridge.mjs bot use' : '', stderr: '' }));
  const result = await migrateHostDataOffline(home, { nodePath: process.execPath, cliPath: import.meta.filename });
  expect(result.kind).toBe('deferred');
  expect(() => readFileSync(join(home, '.vonvon-bridge-migration.json'))).toThrow();
});
