import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { SessionRecord, SessionTitleJob } from '../bot/session-store';
import type { BotEntry, BotsRegistry } from '../config/bots';
import type { AppConfig } from '../config/schema';
import type { Project } from '../project/registry';
import { DEFAULT_BACKEND_ID } from '../agent/types';

export const BRIDGE_BOTS_SCHEMA_VERSION = 1 as const;
export const BRIDGE_PROJECTS_SCHEMA_VERSION = 1 as const;
export const BRIDGE_SESSIONS_SCHEMA_VERSION = 3 as const;

export interface BridgeBotDataPaths {
  readonly dir: string;
  readonly configFile: string;
  readonly projectsFile: string;
  readonly sessionsFile: string;
  readonly processesFile: string;
  readonly commentInstructionsFile: string;
  readonly commentsDir: string;
}

/**
 * Canonical public disk layout shared by Bridge CLI and embedding hosts.
 *
 * The caller owns the root selection. Bridge CLI uses
 * `~/.feishu-codex-bridge`; embedding hosts pass their own app-data root.
 */
export class BridgeDataPaths {
  readonly dataDir: string;
  readonly botsFile: string;
  readonly migrationJournalFile: string;

  constructor(dataDir: string) {
    if (!dataDir || !isAbsolute(dataDir)) {
      throw new Error('Bridge data directory must be a non-empty absolute path.');
    }
    this.dataDir = normalize(dataDir);
    this.botsFile = join(this.dataDir, 'bots.json');
    this.migrationJournalFile = join(this.dataDir, 'runtime', 'data-import.json');
  }

  bot(appId: string): BridgeBotDataPaths {
    assertBridgeBotAppId(appId);
    const dir = join(this.dataDir, 'bots', appId);
    return {
      dir,
      configFile: join(dir, 'config.json'),
      projectsFile: join(dir, 'projects.json'),
      sessionsFile: join(dir, 'sessions.json'),
      processesFile: join(dir, 'processes.json'),
      commentInstructionsFile: join(dir, 'comment-instructions.md'),
      commentsDir: join(dir, 'comments'),
    };
  }
}

export interface BridgeProjectsFile {
  version: typeof BRIDGE_PROJECTS_SCHEMA_VERSION;
  projects: Project[];
}

export interface BridgeSessionsFile {
  version: typeof BRIDGE_SESSIONS_SCHEMA_VERSION;
  sessions: SessionRecord[];
  titleJobs: SessionTitleJob[];
  migrationId?: string;
}

export interface BridgeDataStoreOptions {
  dataDir: string;
  assertWriteAuthority?: () => Promise<void>;
}

export interface BridgeBotDataSnapshot {
  entry: BotEntry;
  config: Partial<AppConfig>;
  projects: Project[];
  sessions: BridgeSessionsFile;
  commentInstructions?: string;
}

export interface BridgeDataSnapshot {
  registry: BotsRegistry;
  bots: BridgeBotDataSnapshot[];
}

interface BridgeDataImportJournal {
  version: 1;
  migrationId: string;
  snapshot: BridgeDataSnapshot;
}

export class UnsupportedBridgeDataVersionError extends Error {
  constructor(
    readonly store: 'bots' | 'projects' | 'sessions',
    readonly version: unknown,
  ) {
    super(`Unsupported Bridge ${store} schema version: ${String(version)}.`);
    this.name = 'UnsupportedBridgeDataVersionError';
  }
}

/**
 * Path-explicit store for the public Bridge data schema.
 *
 * It deliberately contains no desktop records, license state, UI preferences,
 * or OS path discovery. Those are host extensions stored beside this schema.
 */
export class BridgeDataStore {
  readonly paths: BridgeDataPaths;
  readonly #assertWriteAuthority: (() => Promise<void>) | undefined;
  #operations: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeDataStoreOptions) {
    this.paths = new BridgeDataPaths(options.dataDir);
    this.#assertWriteAuthority = options.assertWriteAuthority;
  }

  readBots(): Promise<BotsRegistry> {
    return readBridgeBotsFile(this.paths.botsFile);
  }

  writeBots(registry: BotsRegistry): Promise<void> {
    return this.#write(() => writeBridgeBotsFile(this.paths.botsFile, registry));
  }

  readConfig(appId: string): Promise<Partial<AppConfig>> {
    return readBridgeConfigFile(this.paths.bot(appId).configFile);
  }

  writeConfig(appId: string, config: AppConfig): Promise<void> {
    return this.#write(() => writeBridgeConfigFile(this.paths.bot(appId).configFile, config));
  }

  readProjects(appId: string): Promise<Project[]> {
    return readBridgeProjectsFile(this.paths.bot(appId).projectsFile);
  }

  writeProjects(appId: string, projects: readonly Project[]): Promise<void> {
    return this.#write(() => writeBridgeProjectsFile(
      this.paths.bot(appId).projectsFile,
      projects,
    ));
  }

  readSessions(appId: string): Promise<BridgeSessionsFile> {
    return readBridgeSessionsFile(this.paths.bot(appId).sessionsFile);
  }

  writeSessions(appId: string, store: BridgeSessionsFile): Promise<void> {
    return this.#write(() => writeBridgeSessionsFile(
      this.paths.bot(appId).sessionsFile,
      store,
    ));
  }

  async inspect(): Promise<BridgeDataSnapshot> {
    const registry = await this.readBots();
    const bots = await Promise.all(registry.bots.map(async (entry) => {
      const paths = this.paths.bot(entry.appId);
      const commentInstructions = await readTextIfExists(paths.commentInstructionsFile);
      return {
        entry: structuredClone(entry),
        config: await this.readConfig(entry.appId),
        projects: await this.readProjects(entry.appId),
        sessions: await this.readSessions(entry.appId),
        ...(commentInstructions === undefined ? {} : { commentInstructions }),
      };
    }));
    return { registry, bots };
  }

  /**
   * Imports a previously inspected public snapshot without touching its source.
   *
   * A durable journal makes an interrupted multi-file write explicitly
   * recoverable with {@link recoverImport}.
   */
  importSnapshot(snapshot: BridgeDataSnapshot, migrationId: string): Promise<void> {
    return this.#write(async () => {
      validateMigrationId(migrationId);
      const current = await this.readBots();
      if (current.bots.length > 0) {
        throw new Error('Bridge data target must not contain robots before import.');
      }
      const journal: BridgeDataImportJournal = {
        version: 1,
        migrationId,
        snapshot: structuredClone(snapshot),
      };
      await atomicWriteJson(this.paths.migrationJournalFile, journal, 0o600);
      await this.#applyImport(journal);
      await rm(this.paths.migrationJournalFile, { force: true });
    });
  }

  recoverImport(): Promise<boolean> {
    return this.#write(async () => {
      const value = await readJsonIfExists(this.paths.migrationJournalFile);
      if (value === undefined) return false;
      const journal = validateImportJournal(value);
      await this.#applyImport(journal);
      await rm(this.paths.migrationJournalFile, { force: true });
      return true;
    });
  }

  async #applyImport(journal: BridgeDataImportJournal): Promise<void> {
    validateMigrationId(journal.migrationId);
    const entries = new Map(journal.snapshot.registry.bots.map((entry) => [entry.appId, entry]));
    if (entries.size !== journal.snapshot.registry.bots.length) {
      throw new Error('Bridge import robot appIds must be unique.');
    }
    if (
      journal.snapshot.bots.length !== entries.size
      || journal.snapshot.bots.some(({ entry }) => entries.get(entry.appId) === undefined)
    ) {
      throw new Error('Bridge import snapshot does not match its robot registry.');
    }
    for (const bot of journal.snapshot.bots) {
      assertBridgeBotAppId(bot.entry.appId);
      if (bot.config.accounts?.app?.id !== bot.entry.appId) {
        throw new Error(`Bridge import config identity does not match ${bot.entry.appId}.`);
      }
      await writeBridgeConfigFile(
        this.paths.bot(bot.entry.appId).configFile,
        bot.config as AppConfig,
      );
      await writeBridgeProjectsFile(
        this.paths.bot(bot.entry.appId).projectsFile,
        bot.projects,
      );
      await writeBridgeSessionsFile(
        this.paths.bot(bot.entry.appId).sessionsFile,
        bot.sessions,
      );
      if (bot.commentInstructions !== undefined) {
        await atomicWriteText(
          this.paths.bot(bot.entry.appId).commentInstructionsFile,
          bot.commentInstructions,
        );
      }
    }
    await writeBridgeBotsFile(this.paths.botsFile, journal.snapshot.registry);
  }

  #write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(async () => {
      await this.#assertWriteAuthority?.();
      return await operation();
    });
    this.#operations = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function assertBridgeBotAppId(appId: string): void {
  if (
    !appId
    || appId === '.'
    || appId === '..'
    || appId.includes('/')
    || appId.includes('\\')
    || appId.includes('\0')
  ) {
    throw new Error('Robot appId cannot be used as a data-directory name.');
  }
}

export async function readBridgeConfigFile(file: string): Promise<Partial<AppConfig>> {
  return readJsonFile(file, {});
}

export function writeBridgeConfigFile(file: string, config: AppConfig): Promise<void> {
  return atomicWriteJson(file, config, 0o600);
}

export async function readBridgeBotsFile(file: string): Promise<BotsRegistry> {
  const parsed = await readJsonFile<Partial<BotsRegistry>>(file, {});
  if (parsed.version !== undefined && parsed.version !== BRIDGE_BOTS_SCHEMA_VERSION) {
    throw new UnsupportedBridgeDataVersionError('bots', parsed.version);
  }
  return {
    version: BRIDGE_BOTS_SCHEMA_VERSION,
    ...(typeof parsed.current === 'string' ? { current: parsed.current } : {}),
    bots: Array.isArray(parsed.bots) ? parsed.bots.map(cloneBotEntry) : [],
  };
}

export function writeBridgeBotsFile(file: string, registry: BotsRegistry): Promise<void> {
  const body: BotsRegistry = {
    version: BRIDGE_BOTS_SCHEMA_VERSION,
    ...(registry.current === undefined ? {} : { current: registry.current }),
    bots: registry.bots.map(cloneBotEntry),
  };
  return atomicWriteJson(file, body, 0o600);
}

export async function readBridgeProjectsFile(file: string): Promise<Project[]> {
  const parsed = await readJsonFile<Partial<BridgeProjectsFile>>(file, {});
  if (
    parsed.version !== undefined
    && parsed.version !== BRIDGE_PROJECTS_SCHEMA_VERSION
  ) {
    throw new UnsupportedBridgeDataVersionError('projects', parsed.version);
  }
  return Array.isArray(parsed.projects) ? structuredClone(parsed.projects) : [];
}

export function writeBridgeProjectsFile(
  file: string,
  projects: readonly Project[],
): Promise<void> {
  return atomicWriteJson(file, {
    version: BRIDGE_PROJECTS_SCHEMA_VERSION,
    projects: projects.map((project) => structuredClone(project)),
  } satisfies BridgeProjectsFile);
}

export async function readBridgeSessionsFile(file: string): Promise<BridgeSessionsFile> {
  const parsed = await readJsonFile<Partial<BridgeSessionsFile>>(file, {});
  if (
    typeof parsed.version === 'number'
    && parsed.version > BRIDGE_SESSIONS_SCHEMA_VERSION
  ) {
    throw new UnsupportedBridgeDataVersionError('sessions', parsed.version);
  }
  const sessions = Array.isArray(parsed.sessions)
    ? (parsed.sessions as unknown as Record<string, unknown>[]).map(migrateSession)
    : [];
  const titleJobs = (
    typeof parsed.version === 'number'
    && parsed.version >= BRIDGE_SESSIONS_SCHEMA_VERSION
    && Array.isArray(parsed.titleJobs)
  )
    ? structuredClone(parsed.titleJobs)
    : [];
  return {
    version: BRIDGE_SESSIONS_SCHEMA_VERSION,
    sessions,
    titleJobs,
    ...(typeof parsed.migrationId === 'string' ? { migrationId: parsed.migrationId } : {}),
  };
}

export function writeBridgeSessionsFile(
  file: string,
  store: BridgeSessionsFile,
): Promise<void> {
  return atomicWriteJson(file, {
    version: BRIDGE_SESSIONS_SCHEMA_VERSION,
    sessions: structuredClone(store.sessions),
    titleJobs: structuredClone(store.titleJobs),
    ...(store.migrationId === undefined ? {} : { migrationId: store.migrationId }),
  } satisfies BridgeSessionsFile);
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWriteJson(file: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (mode !== undefined) await chmod(temporary, mode);
  await rename(temporary, file);
}

async function atomicWriteText(file: string, value: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, value, 'utf8');
  await rename(temporary, file);
}

function cloneBotEntry(entry: BotEntry): BotEntry {
  return structuredClone(entry);
}

const LEGACY_V1_SESSION_FIELD = 'codexThread' + 'Id';

function migrateSession(raw: Record<string, unknown>): SessionRecord {
  const record = structuredClone(raw) as unknown as SessionRecord;
  if (typeof record.sessionId !== 'string') {
    const legacy = raw[LEGACY_V1_SESSION_FIELD];
    if (typeof legacy === 'string') record.sessionId = legacy;
  }
  if (typeof record.backend !== 'string') record.backend = DEFAULT_BACKEND_ID;
  return record;
}

function validateMigrationId(migrationId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(migrationId)) {
    throw new Error('Bridge data migration id is invalid.');
  }
}

function validateImportJournal(value: unknown): BridgeDataImportJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Bridge data import journal is invalid.');
  }
  const journal = value as Partial<BridgeDataImportJournal>;
  if (
    journal.version !== 1
    || typeof journal.migrationId !== 'string'
    || !journal.snapshot
    || typeof journal.snapshot !== 'object'
    || !journal.snapshot.registry
    || !Array.isArray(journal.snapshot.bots)
  ) {
    throw new Error('Bridge data import journal is invalid.');
  }
  validateMigrationId(journal.migrationId);
  return structuredClone(journal as BridgeDataImportJournal);
}
