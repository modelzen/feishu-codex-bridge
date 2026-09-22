import type { SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  appDir: '',
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: boundary.spawn,
  spawnSync: boundary.spawnSync,
}));

vi.mock('../src/config/paths', () => ({
  paths: { get appDir() { return boundary.appDir; } },
}));

import { installWinStartup, restartWinStartup, runWinRelaunch } from '../src/service/win-startup';

// Only OS registration, process creation and liveness are mocked. The install,
// restart, serialized request, atomic claim and startNow environment merge all
// use production code and real files in an isolated directory on every OS.
const alive = new Set<number>();
const openDescriptors = new Set<number>();
const daemonEnvs: NodeJS.ProcessEnv[] = [];
let installed = false;
let nextPid = 900_100;
let selectedBin: string;

beforeEach(() => {
  boundary.appDir = mkdtempSync(join(tmpdir(), 'win-codex-bin-'));
  selectedBin = join(boundary.appDir, 'selected Codex', 'codex.exe');
  mkdirSync(join(boundary.appDir, 'selected Codex'));
  writeFileSync(selectedBin, 'test executable selection; never executed');
  installed = false;
  alive.clear();
  daemonEnvs.length = 0;
  boundary.spawn.mockReset();
  boundary.spawnSync.mockReset();
  // Force the Scheduled Task submission branch without discovering a real
  // PowerShell installation. The task commands themselves are mocked below.
  vi.stubEnv('SystemRoot', join(boundary.appDir, 'mock-system-root'));
  vi.stubEnv('USERPROFILE', join(boundary.appDir, 'original-profile'));
  vi.stubEnv('CODEX_BIN', selectedBin);

  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error('Tests must never send a real process signal');
    if (!alive.has(pid)) throw Object.assign(new Error('no such fake process'), { code: 'ESRCH' });
    return true;
  });

  boundary.spawn.mockImplementation((executable: string, args: string[], options: SpawnOptions) => {
    expect(executable).toBe(process.execPath);
    expect(args.at(-1)).toBe('run');
    daemonEnvs.push({ ...options.env });
    // startNow opens log handles for the child. No OS child takes ownership in
    // this test, so close those handles during teardown (also on Windows).
    if (Array.isArray(options.stdio)) {
      for (const fd of options.stdio) if (typeof fd === 'number') openDescriptors.add(fd);
    }
    const pid = ++nextPid;
    alive.add(pid);
    return { pid, unref: vi.fn() };
  });

  boundary.spawnSync.mockImplementation((executable: string, args: string[]) => {
    let status = 0;
    if (executable === 'reg') {
      if (args[0] === 'add') installed = true;
      else if (args[0] === 'query') status = installed ? 0 : 1;
      else if (args[0] === 'delete') installed = false;
      else throw new Error(`Unexpected registry operation: ${args[0]}`);
    } else if (executable === 'taskkill') {
      const pid = Number(args[args.indexOf('/pid') + 1]);
      alive.delete(pid);
    } else if (executable !== 'schtasks') {
      throw new Error(`Unexpected OS executable: ${executable}`);
    }
    return { status, stdout: '', stderr: '' };
  });
});

afterEach(() => {
  for (const fd of openDescriptors) {
    try { closeSync(fd); } catch { /* production may already have closed it */ }
  }
  openDescriptors.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(boundary.appDir, { recursive: true, force: true });
});

async function installWithSelectedCodex(): Promise<number> {
  await installWinStartup();
  expect(daemonEnvs).toHaveLength(1);
  expect(daemonEnvs[0]?.CODEX_BIN).toBe(selectedBin);
  const installedPid = Number(readFileSync(join(boundary.appDir, 'service.pid'), 'utf8'));
  expect(alive.has(installedPid)).toBe(true);
  return installedPid;
}

describe('Windows installed CODEX_BIN survives restarts', () => {
  it('restores the installed executable when restarting a dead daemon from a clean terminal', async () => {
    const oldPid = await installWithSelectedCodex();
    alive.delete(oldPid);
    vi.stubEnv('CODEX_BIN', undefined);

    await restartWinStartup();

    expect(daemonEnvs).toHaveLength(2);
    expect(daemonEnvs[1]?.CODEX_BIN).toBe(selectedBin);
  });

  it.each([
    { environment: 'clean', foreignOverride: undefined },
    { environment: 'foreign', foreignOverride: 'C:\\foreign-profile\\unselected-codex.exe' },
  ])('carries the installed selection through a live restart and a $environment relauncher', async ({ foreignOverride }) => {
    const oldPid = await installWithSelectedCodex();
    vi.stubEnv('CODEX_BIN', undefined);
    await restartWinStartup();

    // Follow the real on-disk handoff rather than inject a fabricated request
    // or a replacement start function: this catches either half dropping data.
    const requestPath = join(boundary.appDir, 'relaunch.json');
    expect(JSON.parse(readFileSync(requestPath, 'utf8')).oldPid).toBe(oldPid);
    expect(daemonEnvs).toHaveLength(1);
    vi.stubEnv('CODEX_BIN', foreignOverride);
    vi.stubEnv('USERPROFILE', join(boundary.appDir, 'foreign-profile'));
    await runWinRelaunch({ requestPath, sleep: async () => undefined });

    expect(alive.has(oldPid)).toBe(false);
    expect(existsSync(requestPath)).toBe(false);
    expect(existsSync(`${requestPath}.claim.${process.pid}`)).toBe(false);
    expect(daemonEnvs).toHaveLength(2);
    expect(daemonEnvs[1]?.USERPROFILE).toBe(join(boundary.appDir, 'original-profile'));
    expect(daemonEnvs[1]?.CODEX_BIN).toBe(selectedBin);
  });
});
