import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { migrateHostDataOffline } from '../src/host/migration';
import { acquireMutex, closeMutex } from '../src/config/data-access';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

it('requires recovery when journal inspection fails and preserves the data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-journal-inspection-'));
  const root = join(home, '.feishu-codex-bridge');
  mkdirSync(root);
  const config = join(root, 'config.json');
  writeFileSync(config, '{"fixture":true}');
  const lock = await acquireMutex(home, 'admission');
  vi.mocked(lstatSync).mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
  try {
    const result = await migrateHostDataOffline(home, { nodePath: process.execPath, cliPath: import.meta.filename });
    expect(result).toEqual({ kind: 'recovery-required', message: 'Cannot inspect the migration journal: permission denied' });
    expect(readFileSync(config, 'utf8')).toBe('{"fixture":true}');
  } finally {
    await closeMutex(lock);
    rmSync(home, { recursive: true, force: true });
  }
});
