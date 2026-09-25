import {mkdtemp, mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it, vi} from 'vitest';

it('imports the desktop Host during a data conflict and recovers in the same process', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-host-import-'));
  await mkdir(join(home, '.feishu-codex-bridge'));
  await mkdir(join(home, '.vonvon-bridge'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.resetModules();
  try {
    const host = await import('../src/host/client');
    expect((await host.inspectHost(home)).kind).toBe('blocked');
    await rename(join(home, '.vonvon-bridge'), join(home, 'held-canonical'));
    expect(await host.inspectHost(home)).toEqual({kind: 'absent'});
    const bin = join(home, 'codex');
    await writeFile(bin, 'fixture', {mode: 0o700});
    expect(await host.resolveCodexBin({home, dataRoot: host.resolveDataRoot(home).path, env: {CODEX_BIN: bin}})).toBe(bin);
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(home, {recursive: true, force: true});
  }
});
