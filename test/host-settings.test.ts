import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSettings } from '../src/admin/host-settings';
import { readServiceCodexBin, saveServiceCodexBin } from '../src/service/codex-bin';
import type { HostSettingsView } from '../src/admin/settings-types';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const appDir = await mkdtemp(join(tmpdir(), 'vonvon-host-settings-'));
  homes.push(appDir);
  const first = join(appDir, process.platform === 'win32' ? 'codex-first.cmd' : 'codex-first');
  const second = join(appDir, process.platform === 'win32' ? 'codex-second.cmd' : 'codex-second');
  await writeFile(first, '', { mode: 0o700 });
  await writeFile(second, '', { mode: 0o700 });
  const settings = createHostSettings({ appDir, runningCodexBin: first });
  const read = async (): Promise<HostSettingsView> => {
    const value = await settings.read({ kind: 'host' });
    if (!('runtime' in value)) throw new Error('Expected host view');
    return value;
  };
  const save = (revision: string, codexBin: string | null) => settings.save({ scope: { kind: 'host' }, section: 'execution', revision, patch: { codexBin } });
  return { appDir, first, second, settings, read, save };
}

describe('Host executable settings', () => {
  it('persists a selection without pretending the running executable changed', async () => {
    const f = await fixture();
    const initial = await f.read();
    const result = await f.save(initial.sections.execution.revision, f.second);
    expect(result.kind).toBe('saved');
    if (result.kind === 'saved') expect(result.effects.map(effect => effect.when)).toEqual(['restart']);
    expect(readServiceCodexBin(f.appDir)).toBe(f.second);
    expect((await f.read()).sections.execution.effective.codexBin).toBe(f.first);
    const reopened = createHostSettings({ appDir: f.appDir, runningCodexBin: f.second });
    const value = await reopened.read({ kind: 'host' });
    if (!('runtime' in value)) throw new Error('Expected host view');
    expect(value.sections.execution.stored.codexBin).toBe(f.second);
    expect(value.sections.execution.effective.codexBin).toBe(f.second);
  });

  it('persists an explicit reset even when no previous service selection exists', async () => {
    const f = await fixture();
    const initial = await f.read();
    expect(readServiceCodexBin(f.appDir)).toBeUndefined();
    expect((await f.save(initial.sections.execution.revision, null)).kind).toBe('saved');
    expect(readServiceCodexBin(f.appDir)).toBeNull();
    expect((await f.read()).runtime.codexBin).toBe(f.first);
  });

  it('rejects a stale competing edit and accepts an identical retry', async () => {
    const f = await fixture();
    const initial = await f.read();
    const results = await Promise.all([
      f.save(initial.sections.execution.revision, f.first),
      f.save(initial.sections.execution.revision, f.second),
    ]);
    expect(results.map(result => result.kind)).toEqual(['saved', 'conflict']);
    expect(readServiceCodexBin(f.appDir)).toBe(f.first);
    const retry = await f.save(initial.sections.execution.revision, f.first);
    expect(retry.kind).toBe('saved');
    if (retry.kind === 'saved') expect(retry.effects).toEqual([]);
  });

  it('refuses missing, relative, directory and malformed paths without overwriting selection', async () => {
    const f = await fixture();
    saveServiceCodexBin(f.first, f.appDir);
    for (const path of ['relative/codex', join(f.appDir, 'missing'), f.appDir, `${f.second}\nother`]) {
      const before = await f.read();
      expect((await f.save(before.sections.execution.revision, path)).kind).toBe('rejected');
      expect(readServiceCodexBin(f.appDir)).toBe(f.first);
    }
  });

  it('refuses preview mutations and leaves the service record absent', async () => {
    const f = await fixture();
    const preview = createHostSettings({ appDir: f.appDir, readonly: true });
    const initial = await f.read();
    expect((await preview.save({ scope: { kind: 'host' }, section: 'execution', revision: initial.sections.execution.revision, patch: { codexBin: f.first } })).kind).toBe('unavailable');
    expect(readServiceCodexBin(f.appDir)).toBeUndefined();
  });
});
