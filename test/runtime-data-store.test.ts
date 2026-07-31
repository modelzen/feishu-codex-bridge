import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_SESSIONS_SCHEMA_VERSION,
  BridgeDataPaths,
  BridgeDataStore,
  UnsupportedBridgeDataVersionError,
} from '../src/runtime';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => (
    rm(dir, { recursive: true, force: true })
  )));
});

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-public-data-'));
  temporaryDirectories.push(dir);
  return dir;
}

describe('public Bridge data schema', () => {
  it('uses one cross-host root with per-bot native shards', async () => {
    const root = await fixture();
    const paths = new BridgeDataPaths(root);

    expect(paths.botsFile).toBe(join(root, 'bots.json'));
    expect(paths.bot('cli_alpha')).toEqual({
      dir: join(root, 'bots', 'cli_alpha'),
      configFile: join(root, 'bots', 'cli_alpha', 'config.json'),
      projectsFile: join(root, 'bots', 'cli_alpha', 'projects.json'),
      sessionsFile: join(root, 'bots', 'cli_alpha', 'sessions.json'),
      processesFile: join(root, 'bots', 'cli_alpha', 'processes.json'),
      commentInstructionsFile: join(root, 'bots', 'cli_alpha', 'comment-instructions.md'),
      commentsDir: join(root, 'bots', 'cli_alpha', 'comments'),
    });
    expect(() => paths.bot('../escape')).toThrow('appId');
  });

  it('round-trips the same registry, config, project, and session schema', async () => {
    const root = await fixture();
    const store = new BridgeDataStore({ dataDir: root });
    const createdAt = Date.now();

    await store.writeBots({
      version: 1,
      current: 'cli_alpha',
      bots: [{
        name: 'alpha',
        appId: 'cli_alpha',
        tenant: 'feishu',
        createdAt,
        active: true,
      }],
    });
    await store.writeConfig('cli_alpha', {
      accounts: {
        app: {
          id: 'cli_alpha',
          tenant: 'feishu',
          secret: { source: 'file', id: 'app-cli_alpha' },
        },
      },
      preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_owner'] } },
    });
    await store.writeProjects('cli_alpha', [{
      name: 'alpha',
      chatId: 'oc_alpha',
      cwd: root,
      blank: false,
      createdAt,
      backend: 'codex-appserver',
    }]);
    await store.writeSessions('cli_alpha', {
      version: BRIDGE_SESSIONS_SCHEMA_VERSION,
      sessions: [{
        threadId: 'omt_alpha',
        chatId: 'oc_alpha',
        cwd: root,
        sessionId: 'session-alpha',
        backend: 'codex-appserver',
        summary: 'hello',
        createdAt,
        updatedAt: createdAt,
      }],
      titleJobs: [],
    });

    await expect(store.readBots()).resolves.toMatchObject({ current: 'cli_alpha' });
    await expect(store.readConfig('cli_alpha')).resolves.toMatchObject({
      accounts: { app: { id: 'cli_alpha' } },
    });
    await expect(store.readProjects('cli_alpha')).resolves.toMatchObject([
      { chatId: 'oc_alpha', cwd: root },
    ]);
    await expect(store.readSessions('cli_alpha')).resolves.toMatchObject({
      version: 3,
      sessions: [{ threadId: 'omt_alpha', sessionId: 'session-alpha' }],
    });

    expect(JSON.parse(await readFile(store.paths.bot('cli_alpha').sessionsFile, 'utf8')))
      .toMatchObject({ version: 3 });
  });

  it('checks write authority before mutating shared files', async () => {
    const root = await fixture();
    const assertWriteAuthority = vi.fn(async () => {
      throw new Error('not runtime owner');
    });
    const store = new BridgeDataStore({ dataDir: root, assertWriteAuthority });

    await expect(store.writeBots({ version: 1, bots: [] }))
      .rejects.toThrow('not runtime owner');
    expect(assertWriteAuthority).toHaveBeenCalledOnce();
  });

  it('reads v1 sessions through the public migration semantics', async () => {
    const root = await fixture();
    const store = new BridgeDataStore({ dataDir: root });
    const paths = store.paths.bot('cli_alpha');
    const legacy = {
      version: 1,
      sessions: [{
        threadId: 'omt_old',
        chatId: 'oc_old',
        cwd: root,
        codexThreadId: 'legacy-session',
        summary: '',
        createdAt: 1,
        updatedAt: 1,
      }],
    };
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.sessionsFile, JSON.stringify(legacy), 'utf8');

    await expect(store.readSessions('cli_alpha')).resolves.toMatchObject({
      version: 3,
      sessions: [{
        sessionId: 'legacy-session',
        backend: 'codex-appserver',
      }],
      titleJobs: [],
    });
  });

  it('rejects future public schemas instead of guessing their meaning', async () => {
    const root = await fixture();
    const store = new BridgeDataStore({ dataDir: root });
    await mkdir(root, { recursive: true });
    await writeFile(store.paths.botsFile, JSON.stringify({ version: 99, bots: [] }), 'utf8');

    await expect(store.readBots()).rejects.toEqual(
      expect.objectContaining<Partial<UnsupportedBridgeDataVersionError>>({
        name: 'UnsupportedBridgeDataVersionError',
        store: 'bots',
        version: 99,
      }),
    );
  });

  it('imports an inspected snapshot without mutating any source byte', async () => {
    const sourceRoot = await fixture();
    const targetRoot = await fixture();
    const source = new BridgeDataStore({ dataDir: sourceRoot });
    const target = new BridgeDataStore({ dataDir: targetRoot });
    const createdAt = 123;
    await source.writeBots({
      version: 1,
      current: 'cli_source',
      bots: [{
        name: 'source',
        appId: 'cli_source',
        tenant: 'lark',
        createdAt,
      }],
    });
    await source.writeConfig('cli_source', {
      accounts: {
        app: {
          id: 'cli_source',
          tenant: 'lark',
          secret: { source: 'file', id: 'app-cli_source' },
        },
      },
    });
    await source.writeProjects('cli_source', [{
      name: 'source-project',
      chatId: 'oc_source',
      cwd: sourceRoot,
      blank: false,
      createdAt,
    }]);
    await source.writeSessions('cli_source', {
      version: 3,
      sessions: [],
      titleJobs: [],
    });
    await writeFile(
      source.paths.bot('cli_source').commentInstructionsFile,
      'source instructions\n',
      'utf8',
    );
    const sourceFiles = [
      source.paths.botsFile,
      source.paths.bot('cli_source').configFile,
      source.paths.bot('cli_source').projectsFile,
      source.paths.bot('cli_source').sessionsFile,
      source.paths.bot('cli_source').commentInstructionsFile,
    ];
    const before = await Promise.all(sourceFiles.map((file) => readFile(file)));

    await target.importSnapshot(await source.inspect(), 'migration_001');

    const after = await Promise.all(sourceFiles.map((file) => readFile(file)));
    expect(after.map((value) => value.toString('hex')))
      .toEqual(before.map((value) => value.toString('hex')));
    await expect(target.inspect()).resolves.toEqual(await source.inspect());
    await expect(readFile(target.paths.migrationJournalFile))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a journaled import idempotently', async () => {
    const sourceRoot = await fixture();
    const targetRoot = await fixture();
    const source = new BridgeDataStore({ dataDir: sourceRoot });
    const target = new BridgeDataStore({ dataDir: targetRoot });
    await source.writeBots({ version: 1, bots: [] });
    const snapshot = await source.inspect();
    await mkdir(join(targetRoot, 'runtime'), { recursive: true });
    await writeFile(target.paths.migrationJournalFile, JSON.stringify({
      version: 1,
      migrationId: 'recover_001',
      snapshot,
    }), 'utf8');

    await expect(target.recoverImport()).resolves.toBe(true);
    await expect(target.recoverImport()).resolves.toBe(false);
    await expect(target.inspect()).resolves.toEqual(snapshot);
  });
});
