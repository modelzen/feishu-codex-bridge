import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { DataRootMigrationError, migrationJournalName, migrationWitnessName, resolveDataRoot } from './data-root';

type Identity = { dev: string; ino: string };
type Intent = { version: 1; transaction: string; home: string; homeIdentity: Identity; sourceIdentity: Identity };
export type LinkedDataRoot = { canonicalPath: string; legacyPath: string };
export type DataRootRelocation = { kind: 'unchanged'; path: string } | ({ kind: 'linked' } & LinkedDataRoot);

function inspect(path: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function identity(stat: fs.BigIntStats): Identity {
  if (stat.ino <= 0n || stat.dev < 0n) throw new DataRootMigrationError('Filesystem directory identity is unavailable.');
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function physicalDirectory(path: string, expected?: Identity): Identity {
  const stat = inspect(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new DataRootMigrationError(`Expected a physical directory at ${path}.`);
  const found = identity(stat);
  if (expected && !sameIdentity(found, expected)) throw new DataRootMigrationError(`Directory identity changed at ${path}.`);
  return found;
}

function isIdentity(value: unknown): value is Identity {
  return typeof value === 'object' && value !== null && 'dev' in value && 'ino' in value
    && typeof value.dev === 'string' && /^(0|[1-9]\d*)$/.test(value.dev)
    && typeof value.ino === 'string' && /^[1-9]\d*$/.test(value.ino)
    && Object.keys(value).length === 2;
}

function readIntent(path: string): Intent {
  const stat = inspect(path);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new DataRootMigrationError(`Migration metadata must be a private regular file at ${path}.`);
  }
  const value: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null
    || !('version' in value) || value.version !== 1
    || !('transaction' in value) || typeof value.transaction !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.transaction)
    || !('home' in value) || typeof value.home !== 'string'
    || !('homeIdentity' in value) || !isIdentity(value.homeIdentity)
    || !('sourceIdentity' in value) || !isIdentity(value.sourceIdentity)
    || Object.keys(value).length !== 5) {
    throw new DataRootMigrationError(`Invalid migration metadata at ${path}.`);
  }
  return { version: 1, transaction: value.transaction, home: value.home, homeIdentity: value.homeIdentity, sourceIdentity: value.sourceIdentity };
}

function verifyIntent(path: string, expected: Intent): void {
  const actual = readIntent(path);
  if (actual.transaction !== expected.transaction || actual.home !== expected.home
    || !sameIdentity(actual.homeIdentity, expected.homeIdentity)
    || !sameIdentity(actual.sourceIdentity, expected.sourceIdentity)) {
    throw new DataRootMigrationError(`Migration metadata does not match this transaction at ${path}.`);
  }
}

function flushDirectory(path: string): void {
  // Windows does not support opening directories for fsync through Node.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(path, 'r');
  try {
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'EINVAL' || error.code === 'ENOTSUP'))) throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
}

function writeIntent(path: string, intent: Intent, parent: string): void {
  const fd = fs.openSync(path, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(intent)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  flushDirectory(parent);
}

function verifyLinked(paths: LinkedDataRoot, intent: Intent): void {
  physicalDirectory(paths.canonicalPath, intent.sourceIdentity);
  if (!inspect(paths.legacyPath)?.isSymbolicLink()
    || fs.realpathSync(paths.legacyPath) !== fs.realpathSync(paths.canonicalPath)) {
    throw new DataRootMigrationError(`Legacy path is not the canonical directory alias at ${paths.legacyPath}.`);
  }
  if (!sameIdentity(identity(fs.statSync(paths.legacyPath, { bigint: true })), intent.sourceIdentity)) {
    throw new DataRootMigrationError('Legacy alias directory identity changed.');
  }
}

/** Caller must hold exclusive offline access throughout recovery and validation.
 * Recovery handles process interruption, not arbitrary writers or guaranteed power-loss durability.
 */
export async function relocateOfflineDataRoot(
  home: string,
  validateLinkedRoot: (paths: LinkedDataRoot) => void | Promise<void>,
): Promise<DataRootRelocation> {
  try {
    const actualHome = fs.realpathSync(resolve(home));
    const homeIdentity = physicalDirectory(actualHome);
    const paths = { canonicalPath: join(actualHome, '.vonvon-bridge'), legacyPath: join(actualHome, '.feishu-codex-bridge') };
    const journal = join(actualHome, migrationJournalName);
    let intent: Intent;
    if (inspect(journal)) {
      intent = readIntent(journal);
      if (intent.home !== actualHome || !sameIdentity(intent.homeIdentity, homeIdentity)) {
        throw new DataRootMigrationError('Migration home identity does not match.');
      }
    } else {
      const selected = resolveDataRoot(actualHome);
      if (selected.kind === 'fresh') return { kind: 'unchanged', path: selected.path };
      if (selected.kind === 'canonical') {
        physicalDirectory(paths.canonicalPath);
        if (inspect(paths.legacyPath) && !inspect(paths.legacyPath)?.isSymbolicLink()) {
          throw new DataRootMigrationError('Legacy path is not a directory alias.');
        }
        return { kind: 'unchanged', path: selected.path };
      }
      const sourceIdentity = physicalDirectory(paths.legacyPath);
      intent = { version: 1, transaction: randomUUID(), home: actualHome, homeIdentity, sourceIdentity };
      writeIntent(journal, intent, actualHome);
    }

    physicalDirectory(actualHome, intent.homeIdentity);
    if (!inspect(paths.canonicalPath)) {
      physicalDirectory(paths.legacyPath, intent.sourceIdentity);
      const witness = join(paths.legacyPath, migrationWitnessName);
      if (inspect(witness)) verifyIntent(witness, intent);
      else writeIntent(witness, intent, paths.legacyPath);
      verifyIntent(journal, intent);
      physicalDirectory(paths.legacyPath, intent.sourceIdentity);
      if (inspect(paths.canonicalPath)) throw new DataRootMigrationError('Canonical destination appeared during migration.');
      fs.renameSync(paths.legacyPath, paths.canonicalPath);
      flushDirectory(actualHome);
    }

    physicalDirectory(paths.canonicalPath, intent.sourceIdentity);
    const witness = join(paths.canonicalPath, migrationWitnessName);
    const witnessPresent = inspect(witness) !== null;
    if (witnessPresent) verifyIntent(witness, intent);
    if (!inspect(paths.legacyPath)) {
      if (!witnessPresent) throw new DataRootMigrationError('Moved directory has no migration witness.');
      fs.symlinkSync(paths.canonicalPath, paths.legacyPath, process.platform === 'win32' ? 'junction' : 'dir');
      flushDirectory(actualHome);
    }
    verifyLinked(paths, intent);
    await validateLinkedRoot(paths);
    physicalDirectory(actualHome, intent.homeIdentity);
    verifyLinked(paths, intent);
    verifyIntent(journal, intent);
    if (inspect(witness)) {
      verifyIntent(witness, intent);
      fs.unlinkSync(witness);
      flushDirectory(paths.canonicalPath);
    } else if (witnessPresent) {
      throw new DataRootMigrationError('Migration witness disappeared during validation.');
    }
    verifyIntent(journal, intent);
    fs.unlinkSync(journal);
    flushDirectory(actualHome);
    return { kind: 'linked', ...paths };
  } catch (error) {
    if (error instanceof DataRootMigrationError) throw error;
    throw new DataRootMigrationError(`Cannot relocate Bridge data: ${String(error)}.`, { cause: error });
  }
}
