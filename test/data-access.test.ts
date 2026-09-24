import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireMutex, assertNoDataLeases, closeMutex, enterDataAccess } from '../src/config/data-access';
import { migrateHostDataOffline } from '../src/host/migration';
import { getterContents } from '../src/config/data-compatibility';
import { inspectInstallation, assertKnownOwnersStopped } from '../src/service/control';

vi.mock('../src/service/control', async (original) => ({
  ...await original<typeof import('../src/service/control')>(),
  inspectInstallation: vi.fn(() => ({ kind: 'absent' })),
  assertKnownOwnersStopped: vi.fn(),
}));
const homes: string[] = [];
const home = (): string => { const path = mkdtempSync(join(tmpdir(), 'bridge-admission-')); homes.push(path); return path; };
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); vi.clearAllMocks(); });
const runtime = { nodePath: process.execPath, cliPath: import.meta.filename };

describe('offline access admission', () => {
  it('blocks relocation while a data user owns a lifetime lease', async () => {
    const dir = home(); mkdirSync(join(dir, '.feishu-codex-bridge'));
    const lease = await enterDataAccess(dir);
    const result = await migrateHostDataOffline(dir, runtime);
    expect(result.kind).toBe('deferred');
    expect(readdirSync(dir)).not.toContain('.vonvon-bridge-migration.json');
    lease.release();
    expect((await migrateHostDataOffline(dir, runtime)).kind).toBe('linked');
  });
  it('fails closed on partial durable publication', () => {
    const dir = home(); mkdirSync(join(dir, '.vonvon-bridge-access'));
    writeFileSync(join(dir, '.vonvon-bridge-access', 'partial.json'), '{');
    expect(() => assertNoDataLeases(dir)).toThrow();
    expect(readFileSync(join(dir, '.vonvon-bridge-access', 'partial.json'), 'utf8')).toBe('{');
  });
  it('does not bypass a bound coordination port', async () => {
    const dir = home(); const owner = await acquireMutex(dir, 'admission');
    try { await expect(acquireMutex(dir, 'admission', 30)).rejects.toThrow(/busy/); }
    finally { await closeMutex(owner); }
  });
  it('defers registered and unknown service state before writing a journal', async () => {
    const dir = home(); mkdirSync(join(dir, '.feishu-codex-bridge'));
    vi.mocked(inspectInstallation).mockReturnValueOnce({ kind: 'registered', detail: 'fixture' });
    expect((await migrateHostDataOffline(dir, runtime)).kind).toBe('deferred');
    vi.mocked(inspectInstallation).mockImplementationOnce(() => { throw new Error('query failed'); });
    expect((await migrateHostDataOffline(dir, runtime)).kind).toBe('deferred');
    expect(readdirSync(dir)).toEqual(['.feishu-codex-bridge']);
    expect(assertKnownOwnersStopped).not.toHaveBeenCalled();
  });
  it('retains a lease when process liveness is unknown', () => {
    const dir = home(); mkdirSync(join(dir, '.vonvon-bridge-access'));
    const file = join(dir, '.vonvon-bridge-access', 'unknown.json');
    writeFileSync(file, JSON.stringify({ version: 1, pid: 424242 }));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    try {
      expect(() => assertNoDataLeases(dir)).toThrow(/Cannot establish/);
      expect(readFileSync(file, 'utf8')).toContain('424242');
    } finally { kill.mockRestore(); }
  });

});

it.each(['.feishu-codex-bridge', '.vonvon-bridge'])('refreshes runtime paths for offline %s data after an app update', async (name) => {
  const dir = home(); const root = join(dir, name); mkdirSync(root);
  writeFileSync(join(root, 'secrets-getter'), getterContents({ nodePath: '/removed/runtime-A/node', cliPath: '/removed/runtime-A/cli' }));
  const result = await migrateHostDataOffline(dir, runtime);
  expect(result.kind).toBe(name === '.vonvon-bridge' ? 'unchanged' : 'linked');
  expect(readFileSync(join(dir, '.vonvon-bridge', 'secrets-getter'), 'utf8')).toBe(getterContents(runtime));
  const runtimeB = { ...runtime, cliPath: process.execPath };
  expect((await migrateHostDataOffline(dir, runtimeB)).kind).toBe('unchanged');
  expect(readFileSync(join(dir, '.vonvon-bridge', 'secrets-getter'), 'utf8')).toBe(getterContents(runtimeB));
});

it('keeps runtime refresh behind leases, service and owner checks', async () => {
  const dir = home(); const root = join(dir, '.vonvon-bridge'); mkdirSync(root);
  const wrapper = join(root, 'secrets-getter'); const old = getterContents({ nodePath: '/old/node', cliPath: '/old/cli' });
  writeFileSync(wrapper, old);
  const lease = await enterDataAccess(dir);
  try { expect((await migrateHostDataOffline(dir, runtime)).kind).toBe('deferred'); }
  finally { lease.release(); }
  vi.mocked(inspectInstallation).mockReturnValueOnce({ kind: 'registered', detail: 'fixture' });
  expect((await migrateHostDataOffline(dir, runtime)).kind).toBe('deferred');
  vi.mocked(assertKnownOwnersStopped).mockImplementationOnce(() => { throw new Error('live owner'); });
  expect((await migrateHostDataOffline(dir, runtime)).kind).toBe('deferred');
  expect(readFileSync(wrapper, 'utf8')).toBe(old);
  expect(readdirSync(dir)).not.toContain('.vonvon-bridge-migration.json');
});
