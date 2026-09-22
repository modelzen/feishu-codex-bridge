import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeServiceCodexBin, readServiceCodexBin, saveServiceCodexBin, selectInstallCodexBin,
} from '../src/service/codex-bin';

let root: string;
let appDir: string;
const recordPath = (): string => join(appDir, 'service-environment.json');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service-codex-bin-'));
  appDir = join(root, 'state');
  vi.stubEnv('CODEX_BIN', undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('saved service Codex selection', () => {
  it('leaves an unconfigured installation unchanged without creating state', () => {
    expect(readServiceCodexBin(appDir)).toBeUndefined();
    expect(selectInstallCodexBin(appDir)).toBeUndefined();
    saveServiceCodexBin(undefined, appDir);
    expect(existsSync(appDir)).toBe(false);
  });

  it('preserves a saved choice when a new terminal has no override', () => {
    const selected = join(root, 'Codex & Tools 中文 %USER% !new!', 'codex');
    saveServiceCodexBin(selected, appDir);
    expect(selectInstallCodexBin(appDir)).toBe(selected);
    saveServiceCodexBin(undefined, appDir);
    expect(readServiceCodexBin(appDir)).toBe(selected);
    expect(JSON.parse(readFileSync(recordPath(), 'utf8'))).toEqual({ version: 1, codexBin: selected });
    if (process.platform !== 'win32') expect(statSync(recordPath()).mode & 0o777).toBe(0o600);
  });

  it('resolves a relative explicit override at installation and retains it across cwd changes', () => {
    const installationCwd = join(root, 'project');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(installationCwd);
    vi.stubEnv('CODEX_BIN', './tools/codex');
    const selected = selectInstallCodexBin(appDir);
    expect(selected).toBe(join(installationCwd, 'tools', 'codex'));
    saveServiceCodexBin(selected, appDir);
    cwd.mockReturnValue(join(root, 'service-working-directory'));
    vi.stubEnv('CODEX_BIN', undefined);
    expect(selectInstallCodexBin(appDir)).toBe(join(installationCwd, 'tools', 'codex'));
  });

  it('replaces a saved choice only with a new explicit install override', () => {
    const old = join(root, 'old', 'codex');
    const updated = join(root, 'new', 'codex');
    saveServiceCodexBin(old, appDir);
    vi.stubEnv('CODEX_BIN', updated);
    expect(selectInstallCodexBin(appDir)).toBe(updated);
    // Reading for a restart ignores the caller's environment until installed.
    expect(readServiceCodexBin(appDir)).toBe(old);
    saveServiceCodexBin(selectInstallCodexBin(appDir), appDir);
    vi.stubEnv('CODEX_BIN', old); // the still-running daemon's stale environment
    expect(readServiceCodexBin(appDir)).toBe(updated);
  });

  it('persists explicit empty as clear, without reviving a stale daemon override', () => {
    const old = join(root, 'old', 'codex');
    saveServiceCodexBin(old, appDir);
    vi.stubEnv('CODEX_BIN', '');
    expect(selectInstallCodexBin(appDir)).toBeNull();
    saveServiceCodexBin(selectInstallCodexBin(appDir), appDir);
    vi.stubEnv('CODEX_BIN', old);
    expect(readServiceCodexBin(appDir)).toBeNull();
    vi.stubEnv('CODEX_BIN', undefined);
    expect(selectInstallCodexBin(appDir)).toBeNull();
    expect(existsSync(recordPath())).toBe(true);
  });

  it('preserves a symlink entrypoint so later target upgrades remain effective', () => {
    const target = join(root, 'version-1');
    const link = join(root, 'current');
    mkdirSync(target);
    writeFileSync(join(target, 'codex'), 'fixture');
    // Windows directory junctions need no developer-mode symlink privilege.
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const logical = join(link, 'codex');
    expect(realpathSync.native(logical)).not.toBe(logical);
    expect(normalizeServiceCodexBin(logical)).toBe(logical);
    saveServiceCodexBin(normalizeServiceCodexBin(logical), appDir);
    expect(readServiceCodexBin(appDir)).toBe(logical);
  });

  it.each(['\r', '\n', '\0'])('rejects control character %j before touching saved state', (control) => {
    const selected = join(root, 'codex');
    saveServiceCodexBin(selected, appDir);
    expect(() => normalizeServiceCodexBin(selected + control)).toThrow(/CODEX_BIN/);
    // OS environment strings cannot contain NUL; Node truncates it on assignment.
    if (control !== '\0') {
      vi.stubEnv('CODEX_BIN', selected + control);
      expect(() => selectInstallCodexBin(appDir)).toThrow(/CODEX_BIN/);
    }
    expect(readServiceCodexBin(appDir)).toBe(selected);
  });

  it.each([
    '{broken',
    '{}',
    '{"version":2,"codexBin":null}',
    '{"version":1,"codexBin":"relative/codex"}',
    '{"version":1,"codexBin":""}',
    '{"version":1,"codexBin":42}',
    '{"version":1,"codexBin":[]}',
  ])('refuses invalid saved configuration instead of falling back: %s', (content) => {
    mkdirSync(appDir);
    writeFileSync(recordPath(), content);
    expect(() => readServiceCodexBin(appDir)).toThrow(/配置/);
    expect(() => selectInstallCodexBin(appDir)).toThrow(/配置/);
    expect(readFileSync(recordPath(), 'utf8')).toBe(content);
  });

  it('distinguishes an unreadable record from an absent record', () => {
    mkdirSync(recordPath(), { recursive: true }); // readFile fails with EISDIR on both platforms
    expect(() => readServiceCodexBin(appDir)).toThrow(/无法读取/);
  });

  it('does not leave temporary files when replacement fails', () => {
    mkdirSync(recordPath(), { recursive: true });
    expect(() => saveServiceCodexBin(join(root, 'codex'), appDir)).toThrow();
    expect(statSync(recordPath()).isDirectory()).toBe(true);
    expect(readdirSync(appDir)).toEqual(['service-environment.json']);
  });
});
