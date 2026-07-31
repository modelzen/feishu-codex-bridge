import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  botDir,
  configurePathRoots,
  paths,
  useBotDir,
} from '../src/config/paths';

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('compat kernel explicit path roots', () => {
  it('separates Vonvon bot state from legacy user assets without changing HOME', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-data-'));
    const hostDataDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-host-'));
    const legacyAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-assets-'));
    const writableAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-writable-assets-'));
    const managedToolsDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-tools-'));
    const systemNodeModulesDir = await mkdtemp(join(tmpdir(), 'vonvon-system-node-modules-'));
    directories.push(
      dataDir,
      hostDataDir,
      legacyAssetsDir,
      writableAssetsDir,
      managedToolsDir,
      systemNodeModulesDir,
    );
    const originalHome = process.env.HOME;

    configurePathRoots({
      dataDir,
      hostDataDir,
      legacyAssetsDir,
      writableAssetsDir,
      managedToolsDir,
      systemNodeModulesDirs: [systemNodeModulesDir],
    });
    useBotDir('cli_alpha');

    expect(process.env.HOME).toBe(originalHome);
    expect(paths.appDir).toBe(dataDir);
    expect(paths.hostDataDir).toBe(hostDataDir);
    expect(paths.legacyAssetsDir).toBe(legacyAssetsDir);
    expect(paths.writableAssetsDir).toBe(writableAssetsDir);
    expect(botDir('cli_alpha')).toBe(dataDir);
    expect(paths.configFile).toBe(join(dataDir, 'config.json'));
    expect(paths.projectsFile).toBe(join(dataDir, 'projects.json'));
    expect(paths.sessionsFile).toBe(join(dataDir, 'sessions.json'));
    expect(paths.commentInstructionsFile).toBe(
      join(dataDir, 'comment-instructions.md'),
    );
    expect(paths.commentsRootDir).toBe(
      join(dataDir, 'comments'),
    );

    expect(paths.cacheDir).toBe(writableAssetsDir);
    expect(paths.npmCacheDir).toBe(join(writableAssetsDir, 'npm-cache'));
    expect(paths.projectsRootDir).toBe(join(writableAssetsDir, 'projects'));
    expect(paths.backendsDir).toBe(join(writableAssetsDir, 'backends'));
    expect(paths.legacyBackendsDir).toBe(join(legacyAssetsDir, 'backends'));
    expect(paths.managedToolsDir).toBe(managedToolsDir);
    expect(paths.managedBackendsDir).toBe(managedToolsDir);
    expect(paths.systemNodeModulesDirs).toEqual([systemNodeModulesDir]);
    expect(paths.managedCodexBin).toBe(
      join(managedToolsDir, 'node_modules', '.bin', 'codex'),
    );
    expect(paths.larkCliDir).toBe(join(legacyAssetsDir, 'lark-cli'));
    expect(paths.codexCliDir).toBe(join(legacyAssetsDir, 'codex-cli'));
    expect(paths.secretsGetterScript).toBe(join(writableAssetsDir, 'secrets-getter'));
    expect(paths.mediaDir).toBe(join(writableAssetsDir, 'media'));
    expect(paths.inboundDir).toBe(join(writableAssetsDir, 'inbound'));
    expect(paths.webConsoleFile).toBe(join(hostDataDir, 'web-console.json'));
    expect(paths.webTokenFile).toBe(join(hostDataDir, 'web-token'));
    if (process.platform !== 'win32') {
      expect(paths.cliBridgeSocket).toBe(
        join(writableAssetsDir, 'bots', 'cli_alpha', 'cli-bridge.sock'),
      );
    }
  });

  it('defaults shared host artifacts to the process data root', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-default-host-'));
    const legacyAssetsDir = await mkdtemp(join(tmpdir(), 'vonvon-kernel-assets-'));
    directories.push(dataDir, legacyAssetsDir);

    configurePathRoots({ dataDir, legacyAssetsDir });

    expect(paths.hostDataDir).toBe(dataDir);
    expect(paths.writableAssetsDir).toBe(legacyAssetsDir);
    expect(paths.backendsDir).toBe(join(legacyAssetsDir, 'backends'));
    expect(paths.webConsoleFile).toBe(join(dataDir, 'web-console.json'));
    expect(paths.webTokenFile).toBe(join(dataDir, 'web-token'));
  });

  it('rejects relative roots instead of resolving them through process state', () => {
    expect(() =>
      configurePathRoots({
        dataDir: 'relative/data',
        legacyAssetsDir: '/absolute/assets',
      }),
    ).toThrow('dataDir must be a non-empty absolute path');
    expect(() =>
      configurePathRoots({
        dataDir: '/absolute/data',
        legacyAssetsDir: 'relative/assets',
      }),
    ).toThrow('legacyAssetsDir must be a non-empty absolute path');
    expect(() =>
      configurePathRoots({
        dataDir: '/absolute/data',
        hostDataDir: 'relative/host',
        legacyAssetsDir: '/absolute/assets',
      }),
    ).toThrow('hostDataDir must be a non-empty absolute path');
    expect(() =>
      configurePathRoots({
        dataDir: '/absolute/data',
        legacyAssetsDir: '/absolute/assets',
        writableAssetsDir: 'relative/writable-assets',
      }),
    ).toThrow('writableAssetsDir must be a non-empty absolute path');
    expect(() =>
      configurePathRoots({
        dataDir: '/absolute/data',
        legacyAssetsDir: '/absolute/assets',
        managedToolsDir: 'relative/tools',
      }),
    ).toThrow('managedToolsDir must be a non-empty absolute path');
    expect(() =>
      configurePathRoots({
        dataDir: '/absolute/data',
        legacyAssetsDir: '/absolute/assets',
        systemNodeModulesDirs: ['relative/node_modules'],
      }),
    ).toThrow('systemNodeModulesDirs must be a non-empty absolute path');
  });
});
