import type { SpawnOptions } from 'node:child_process';
import { closeSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ appDir: '', spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: boundary.spawn,
  spawnSync: boundary.spawnSync,
}));
vi.mock('../src/config/paths', () => ({ paths: { get appDir() { return boundary.appDir; } } }));

import { installWinStartup, restartWinStartup, runWinRelaunch } from '../src/service/win-startup';

// Additional settings transitions supplement the unchanged before/after
// regression in win-codex-bin.test.ts. All process/OS effects remain mocked.
const alive = new Set<number>();
const handles = new Set<number>();
const launched: NodeJS.ProcessEnv[] = [];
let nextPid = 800_000;
let originalBin: string;

beforeEach(() => {
  boundary.appDir = mkdtempSync(join(tmpdir(), 'win-codex-settings-'));
  originalBin = join(boundary.appDir, 'original', 'codex.exe');
  alive.clear();
  launched.length = 0;
  vi.stubEnv('CODEX_BIN', originalBin);
  vi.stubEnv('SystemRoot', join(boundary.appDir, 'mock-system-root'));
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal !== 0) throw new Error('Only fake liveness probes are allowed');
    if (!alive.has(pid)) throw Object.assign(new Error('fake process exited'), { code: 'ESRCH' });
    return true;
  });
  boundary.spawn.mockImplementation((_exe: string, _args: string[], options: SpawnOptions) => {
    launched.push({ ...options.env });
    if (Array.isArray(options.stdio)) {
      for (const fd of options.stdio) if (typeof fd === 'number') handles.add(fd);
    }
    const pid = ++nextPid;
    alive.add(pid);
    return { pid, unref: vi.fn() };
  });
  boundary.spawnSync.mockImplementation((exe: string, args: string[]) => {
    if (!['reg', 'schtasks', 'taskkill'].includes(exe)) throw new Error(`Unexpected OS command: ${exe}`);
    if (exe === 'taskkill') alive.delete(Number(args[args.indexOf('/pid') + 1]));
    return { status: 0, stdout: '', stderr: '' };
  });
});

afterEach(() => {
  for (const fd of handles) {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  handles.clear();
  boundary.spawn.mockReset();
  boundary.spawnSync.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(boundary.appDir, { recursive: true, force: true });
});

async function completeRelaunch(): Promise<void> {
  await runWinRelaunch({
    requestPath: join(boundary.appDir, 'relaunch.json'),
    sleep: async () => undefined,
  });
}

describe('Windows Codex selection settings transitions', () => {
  it('retains the installed choice when start is repeated without CODEX_BIN', async () => {
    await installWinStartup();
    vi.stubEnv('CODEX_BIN', undefined);
    await installWinStartup();
    expect(launched).toHaveLength(1); // reconfiguration never starts a duplicate

    alive.clear();
    await restartWinStartup();
    expect(launched).toHaveLength(2);
    expect(launched[1]?.CODEX_BIN).toBe(originalBin);
  });

  it('a still-running daemon with an old environment cannot undo a newly saved choice', async () => {
    await installWinStartup();
    const originalPid = readFileSync(join(boundary.appDir, 'service.pid'), 'utf8');
    const updatedBin = join(boundary.appDir, 'updated', 'codex.exe');
    vi.stubEnv('CODEX_BIN', updatedBin);
    await installWinStartup();
    expect(launched).toHaveLength(1);
    expect(readFileSync(join(boundary.appDir, 'service.pid'), 'utf8')).toBe(originalPid);

    vi.stubEnv('CODEX_BIN', originalBin); // update/restart requested by the old daemon
    await restartWinStartup();
    vi.stubEnv('CODEX_BIN', join(boundary.appDir, 'foreign', 'codex.exe'));
    await completeRelaunch();
    expect(launched).toHaveLength(2);
    expect(launched[1]?.CODEX_BIN).toBe(updatedBin);
  });

  it('an explicit clear removes even a differently cased foreign override after relaunch', async () => {
    await installWinStartup();
    vi.stubEnv('CODEX_BIN', '');
    await installWinStartup();

    vi.stubEnv('CODEX_BIN', originalBin);
    await restartWinStartup();
    vi.stubEnv('cOdEx_BiN', join(boundary.appDir, 'foreign', 'codex.exe'));
    await completeRelaunch();
    expect(launched).toHaveLength(2);
    expect(Object.keys(launched[1]!).filter((key) => key.toLowerCase() === 'codex_bin')).toEqual([]);
  });

  it('keeps environment inheritance for legacy installations with no saved preference', async () => {
    vi.stubEnv('CODEX_BIN', undefined);
    await installWinStartup();
    alive.clear();

    vi.stubEnv('CODEX_BIN', originalBin);
    await restartWinStartup();
    expect(launched).toHaveLength(2);
    expect(launched[1]?.CODEX_BIN).toBe(originalBin);
  });
});
