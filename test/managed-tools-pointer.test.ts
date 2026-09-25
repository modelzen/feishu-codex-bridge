import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { managedToolExecutable, managedToolSelection } from '../src/agent/codex-appserver/managed-tools';
import { resolveCodexBin } from '../src/agent/codex-appserver/locate';

describe('desktop managed tool pointer', () => {
  it('selects only the published complete release and keeps explicit CODEX_BIN first', () => {
    const home = mkdtempSync(join(tmpdir(), 'bridge-pointer-'));
    const toolRoot = join(home, 'managed-tools', 'codex');
    const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const legacy = join(home, 'managed-tools', 'bin', 'codex');
    const external = join(home, 'external-codex');
    try {
      mkdirSync(join(home, 'managed-tools', 'bin'), { recursive: true });
      writeFileSync(legacy, 'legacy', { mode: 0o700 });
      writeFileSync(external, 'external');
      const context = { home, dataRoot: home, env: { PATH: '', CODEX_BIN: undefined, ...(process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD'} : {}) } };
      expect(resolveCodexBin(context)).toBe(legacy);
      expect(managedToolSelection(home, 'codex').kind).toBe('absent');
      const firstBin = managedToolExecutable(join(toolRoot, 'releases', first), 'codex');
      mkdirSync(join(toolRoot, 'releases', first, 'bin'), { recursive: true });
      writeFileSync(firstBin, 'first');
      writeFileSync(join(toolRoot, 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'active', generation: first, version: '1.0.0' }));
      expect(resolveCodexBin(context)).toBe(firstBin);
      const secondBin = managedToolExecutable(join(toolRoot, 'releases', second), 'codex');
      mkdirSync(join(toolRoot, 'releases', second, 'bin'), { recursive: true });
      writeFileSync(secondBin, 'second');
      expect(resolveCodexBin(context)).toBe(firstBin);
      writeFileSync(join(toolRoot, 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'active', generation: second, version: '2.0.0' }));
      expect(resolveCodexBin(context)).toBe(secondBin);
      expect(resolveCodexBin({ ...context, env: { PATH: '', CODEX_BIN: external } })).toBe(external);
      writeFileSync(join(toolRoot, 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'disabled' }));
      expect(resolveCodexBin(context)).toBeNull();
      expect(resolveCodexBin({ ...context, env: { PATH: '', CODEX_BIN: external } })).toBe(external);
      const externalDir = join(home, 'external');
      mkdirSync(externalDir);
      const pathCodex = join(externalDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
      writeFileSync(pathCodex, 'external', { mode: 0o700 });
      const resolved = resolveCodexBin({ ...context, env: { ...context.env, PATH: [join(home, 'managed-tools', 'bin'), externalDir, ...(process.platform === 'win32' && process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter) } });
      expect(resolved && realpathSync.native(resolved)).toBe(realpathSync.native(pathCodex));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('does not rediscover a disabled managed installation through a directory alias', () => {
    const home = mkdtempSync(join(tmpdir(), 'bridge-pointer-alias-'));
    try {
      const root = join(home, 'data');
      const alias = join(home, 'data-alias');
      const bin = join(root, 'managed-tools', 'bin');
      mkdirSync(join(root, 'managed-tools', 'codex'), { recursive: true });
      mkdirSync(bin);
      symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex'), 'legacy', { mode: 0o700 });
      writeFileSync(join(root, 'managed-tools', 'codex', 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'disabled' }));
      const env = {
        PATH: [bin, ...(process.platform === 'win32' && process.env.SystemRoot ? [join(process.env.SystemRoot, 'System32')] : [])].join(delimiter),
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD' } : {}),
      };
      expect(resolveCodexBin({ home, dataRoot: alias, env })).toBeNull();
      const externalDir = join(home, 'external');
      mkdirSync(externalDir);
      const external = join(externalDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
      writeFileSync(external, 'external', { mode: 0o700 });
      const lookup = vi.spyOn(realpathSync, 'native').mockImplementationOnce(() => { throw Object.assign(new Error('removed during lookup'), { code: 'ENOENT' }); });
      try {
        const resolved = resolveCodexBin({ home, dataRoot: alias, env: { ...env, PATH: env.PATH + delimiter + externalDir } });
        expect(resolved && realpathSync.native(resolved)).toBe(realpathSync.native(external));
      } finally { lookup.mockRestore(); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('does not follow a malformed or missing release pointer', () => {
    const home = mkdtempSync(join(tmpdir(), 'bridge-pointer-invalid-'));
    try {
      const root = join(home, 'managed-tools', 'codex');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'active', generation: '../../escape', version: '1.0.0' }));
      expect(managedToolSelection(home, 'codex').kind).toBe('invalid');
      writeFileSync(join(root, 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'active', generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: '1.0.0' }));
      expect(managedToolSelection(home, 'codex').kind).toBe('invalid');
      expect(managedToolExecutable('C:\\tools', 'codex', 'win32')).toMatch(/codex\.cmd$/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
