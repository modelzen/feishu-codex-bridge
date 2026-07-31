import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configurePathRoots, paths } from '../src/config/paths';
import { resolveProjectsRootDir } from '../src/project/lifecycle';

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveProjectsRootDir', () => {
  it('keeps the historical default when the setting is omitted or blank', () => {
    expect(resolveProjectsRootDir()).toBe(paths.projectsRootDir);
    expect(resolveProjectsRootDir('   ')).toBe(paths.projectsRootDir);
  });

  it('supports absolute paths and trims surrounding whitespace', () => {
    const customRoot = resolve(homedir(), 'custom-feishu-projects');
    expect(resolveProjectsRootDir(`  ${customRoot}  `)).toBe(customRoot);
    expect(resolveProjectsRootDir(paths.legacyAssetsDir)).toBe(paths.legacyAssetsDir);
  });

  it('expands ~ paths from the user home directory', () => {
    expect(resolveProjectsRootDir('~')).toBe(homedir());
    expect(resolveProjectsRootDir('~/code/feishu-projects')).toBe(join(homedir(), 'code', 'feishu-projects'));
  });

  it('rejects relative paths and invalid manually-edited values', () => {
    expect(() => resolveProjectsRootDir('relative/projects')).toThrow(/绝对路径/);
    expect(() => resolveProjectsRootDir(123)).toThrow(/必须是字符串/);
  });

  it('redirects imported project roots under a split read-only legacy root', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vonvon-project-data-'));
    const legacyAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-project-legacy-'));
    const writableAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-project-writable-'));
    const customRoot = await mkdtemp(join(tmpdir(), 'vonvon-project-custom-'));
    directories.push(dataDir, legacyAssetsDir, writableAssetsDir, customRoot);
    configurePathRoots({ dataDir, legacyAssetsDir, writableAssetsDir });

    expect(resolveProjectsRootDir(legacyAssetsDir)).toBe(join(writableAssetsDir, 'projects'));
    expect(resolveProjectsRootDir(join(legacyAssetsDir, 'projects'))).toBe(
      join(writableAssetsDir, 'projects'),
    );
    expect(resolveProjectsRootDir(join(legacyAssetsDir, '..', 'outside'))).toBe(
      resolve(legacyAssetsDir, '..', 'outside'),
    );
    expect(resolveProjectsRootDir(customRoot)).toBe(customRoot);
  });
});
