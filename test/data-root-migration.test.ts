import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataRootMigrationError, migrationJournalName, migrationWitnessName, resolveDataRoot } from '../src/config/data-root';
import { relocateOfflineDataRoot } from '../src/config/data-root-migration';

vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>() }));
const homes: string[] = [];
const validate = () => {};
function setup(legacy = true) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'vonvon-relocate-')));
  homes.push(home);
  const source = join(home, '.feishu-codex-bridge');
  const destination = join(home, '.vonvon-bridge');
  const journal = join(home, migrationJournalName);
  if (legacy) fs.mkdirSync(source);
  return { home, source, destination, journal };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
async function pending() {
  const fixture = setup();
  await expect(relocateOfflineDataRoot(fixture.home, () => { throw Error('validation interrupted'); })).rejects.toThrow();
  return fixture;
}

describe('offline data root relocation', () => {
  it('preserves identity, encrypted bytes, permissions and nested files through both names', async () => {
    const { home, source, destination, journal } = setup();
    const bytes = Buffer.from([0, 255, 12, 128, 27]);
    fs.mkdirSync(join(source, 'bots', 'test'), { recursive: true });
    fs.writeFileSync(join(source, 'secrets.enc'), bytes, { mode: 0o600 });
    fs.writeFileSync(join(source, 'bots', 'test', 'sessions.json'), '{"session":"kept"}');
    const original = fs.statSync(source, { bigint: true });
    const callback = vi.fn(({ canonicalPath, legacyPath }) => {
      expect(fs.realpathSync(legacyPath)).toBe(canonicalPath);
      expect(() => resolveDataRoot(home)).toThrow(DataRootMigrationError);
    });
    expect(await relocateOfflineDataRoot(home, callback)).toEqual({ kind: 'linked', canonicalPath: destination, legacyPath: source });
    expect(callback).toHaveBeenCalledOnce();
    expect(fs.statSync(destination, { bigint: true }).ino).toBe(original.ino);
    for (const root of [source, destination]) {
      expect(fs.readFileSync(join(root, 'secrets.enc'))).toEqual(bytes);
      expect(fs.readFileSync(join(root, 'bots', 'test', 'sessions.json'), 'utf8')).toBe('{"session":"kept"}');
    }
    if (process.platform !== 'win32') expect(fs.statSync(join(destination, 'secrets.enc')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(journal)).toBe(false);
    expect(resolveDataRoot(home)).toEqual({ kind: 'canonical', path: destination });
    const entries = fs.readdirSync(home);
    expect(await relocateOfflineDataRoot(home, () => { throw Error('no callback on no-op'); })).toEqual({ kind: 'unchanged', path: destination });
    expect(fs.readdirSync(home)).toEqual(entries);
  });

  it('does not create fresh data directories', async () => {
    const { home, destination } = setup(false);
    expect(await relocateOfflineDataRoot(home, validate)).toEqual({ kind: 'unchanged', path: destination });
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it.each(['journal', 'witness', 'rename', 'link', 'validation', 'remove-witness', 'remove-journal'])('recovers interruption after %s and can retry twice', async (stage) => {
    const { home, source, destination, journal } = setup();
    fs.writeFileSync(join(source, 'kept'), 'bytes');
    const fail = () => { throw Error('interrupted'); };
    if (stage === 'journal' || stage === 'witness') {
      const original = fs.closeSync;
      let count = 0;
      vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
        original(fd);
        count++;
        if (count === (stage === 'journal' ? 1 : process.platform === 'win32' ? 2 : 3)) fail();
      });
    } else if (stage === 'rename') {
      const original = fs.renameSync;
      vi.spyOn(fs, 'renameSync').mockImplementation((a, b) => { original(a, b); fail(); });
    } else if (stage === 'link') {
      const original = fs.symlinkSync;
      vi.spyOn(fs, 'symlinkSync').mockImplementation((a, b, type) => { original(a, b, type); fail(); });
    } else if (stage.startsWith('remove-')) {
      const original = fs.unlinkSync;
      vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
        original(path);
        if (String(path).endsWith(stage === 'remove-witness' ? migrationWitnessName : migrationJournalName)) fail();
      });
    }
    await expect(relocateOfflineDataRoot(home, stage === 'validation' ? fail : validate)).rejects.toThrow(/interrupted/);
    vi.restoreAllMocks();
    if (stage !== 'remove-journal') expect(() => resolveDataRoot(home)).toThrow(DataRootMigrationError);
    await relocateOfflineDataRoot(home, validate);
    await relocateOfflineDataRoot(home, validate);
    expect(fs.readFileSync(join(source, 'kept'), 'utf8')).toBe('bytes');
    expect(fs.realpathSync(source)).toBe(destination);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it.each(['two-stores', 'legacy-external', 'canonical-external', 'orphan-witness'])('preserves rejected topology %s', async (kind) => {
    const { home, source, destination, journal } = setup(kind !== 'canonical-external');
    if (kind === 'two-stores') fs.mkdirSync(destination);
    if (kind.endsWith('external')) {
      const external = join(home, 'external');
      fs.mkdirSync(external);
      if (kind === 'legacy-external') fs.rmdirSync(source);
      fs.symlinkSync(external, kind === 'legacy-external' ? source : destination, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (kind === 'orphan-witness') fs.writeFileSync(join(source, migrationWitnessName), '{}');
    const before = fs.readdirSync(home);
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow();
    expect(fs.readdirSync(home)).toEqual(before);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it.each(['truncated', 'version', 'transaction', 'home', 'source-identity', 'witness-mismatch'])('refuses corrupt intent %s without removing metadata', async (kind) => {
    const { home, journal, destination } = await pending();
    const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (kind === 'version') value.version = 2;
    if (kind === 'transaction') value.transaction = 'unknown';
    if (kind === 'home') value.home = join(home, 'elsewhere');
    if (kind === 'source-identity') value.sourceIdentity.ino = String(BigInt(value.sourceIdentity.ino) + 1n);
    const target = kind === 'witness-mismatch' ? join(destination, migrationWitnessName) : journal;
    if (kind === 'witness-mismatch') value.homeIdentity.ino = '1';
    const bytes = kind === 'truncated' ? '{' : JSON.stringify(value);
    fs.writeFileSync(target, bytes);
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(DataRootMigrationError);
    expect(() => resolveDataRoot(home)).toThrow(DataRootMigrationError);
    expect(fs.readFileSync(target, 'utf8')).toBe(bytes);
  });

  it.skipIf(process.platform === 'win32').each(['journal', 'witness'])('refuses %s metadata symlinks', async (kind) => {
    const { home, journal, destination } = await pending();
    const target = kind === 'journal' ? journal : join(destination, migrationWitnessName);
    const other = join(home, 'metadata-original');
    fs.renameSync(target, other);
    fs.symlinkSync(other, target);
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(/regular file/);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('refuses replacement directory and foreign alias without removing either', async () => {
    const { home, destination, source } = await pending();
    const saved = join(home, 'saved');
    fs.renameSync(destination, saved);
    fs.mkdirSync(destination);
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(/identity changed/);
    fs.rmdirSync(destination);
    fs.renameSync(saved, destination);
    fs.unlinkSync(source);
    fs.mkdirSync(source);
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(/alias/);
    expect(fs.statSync(source).isDirectory()).toBe(true);
  });

  it.each(['rename', 'link', 'access'])('keeps intent after %s errors and recovers on retry', async (operation) => {
    const { home, source } = setup();
    const error = Object.assign(Error(operation), { code: operation === 'rename' ? 'EXDEV' : 'EACCES' });
    if (operation === 'rename') vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw error; });
    else if (operation === 'link') vi.spyOn(fs, 'symlinkSync').mockImplementation(() => { throw error; });
    else vi.spyOn(fs, 'lstatSync').mockImplementation(() => { throw error; });
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(DataRootMigrationError);
    vi.restoreAllMocks();
    expect(fs.existsSync(source) || fs.existsSync(join(home, '.vonvon-bridge'))).toBe(true);
    await relocateOfflineDataRoot(home, validate);
    expect(resolveDataRoot(home).kind).toBe('canonical');
  });

  it('refuses a journal without either recorded root', async () => {
    const { home, destination, source, journal } = await pending();
    fs.unlinkSync(source);
    fs.renameSync(destination, join(home, 'saved'));
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(/physical directory/);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it('refuses a moved directory without a witness before alias creation', async () => {
    const { home, destination, source, journal } = await pending();
    fs.unlinkSync(source);
    fs.unlinkSync(join(destination, migrationWitnessName));
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(/no migration witness/);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(journal)).toBe(true);
  });

  it('keeps a foreign destination observed before rename', async () => {
    const { home, destination, source } = setup();
    const original = fs.closeSync;
    let count = 0;
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      original(fd);
      if (++count === 1) fs.mkdirSync(destination);
    });
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow();
    vi.restoreAllMocks();
    expect(fs.statSync(source).isDirectory()).toBe(true);
    expect(fs.statSync(destination).isDirectory()).toBe(true);
  });

  it('refuses a foreign link after interruption and leaves its target unchanged', async () => {
    const { home, destination, source } = await pending();
    const external = join(home, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(join(external, 'kept'), 'foreign');
    fs.unlinkSync(source);
    fs.symlinkSync(external, source, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(relocateOfflineDataRoot(home, validate)).rejects.toThrow(/alias/);
    expect(fs.realpathSync(source)).toBe(external);
    expect(fs.readFileSync(join(external, 'kept'), 'utf8')).toBe('foreign');
    expect(fs.existsSync(join(destination, migrationWitnessName))).toBe(true);
  });

  it('keeps recovery pending when validation changes an owned witness', async () => {
    const { home, destination, journal } = setup();
    await expect(relocateOfflineDataRoot(home, () => {
      fs.writeFileSync(join(destination, migrationWitnessName), '{}');
    })).rejects.toThrow(/metadata/);
    expect(fs.existsSync(journal)).toBe(true);
    expect(() => resolveDataRoot(home)).toThrow(DataRootMigrationError);
  });

  it('creates private journal and witness metadata', async () => {
    const { home, destination, journal } = setup();
    await expect(relocateOfflineDataRoot(home, () => {
      if (process.platform !== 'win32') {
        expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
        expect(fs.statSync(join(destination, migrationWitnessName)).mode & 0o777).toBe(0o600);
      }
      throw Error('leave pending');
    })).rejects.toThrow(/leave pending/);
  });

  it('recovers in a new process after the moving process exits immediately after rename', () => {
    const { home, source, destination } = setup();
    fs.writeFileSync(join(source, 'kept'), 'child bytes');
    const compile = (name: string) => {
      const sourceCode = fs.readFileSync(join(process.cwd(), 'src/config', `${name}.ts`), 'utf8')
        .replace("'./data-root'", "'./data-root.cjs'");
      fs.writeFileSync(join(home, `${name}.cjs`), ts.transpileModule(sourceCode, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      }).outputText);
    };
    compile('data-root'); compile('data-root-migration');
    const script = join(home, 'child.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs');
if (process.argv[3] === 'crash') { const rename = fs.renameSync; fs.renameSync = (...args) => { rename(...args); process.exit(73); }; }
require('./data-root-migration.cjs').relocateOfflineDataRoot(process.argv[2], () => {}).catch(error => { console.error(error); process.exit(1); });`);
    const childOptions = { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } } as const;
    expect(spawnSync(process.execPath, [script, home, 'crash'], childOptions).status).toBe(73);
    expect(fs.existsSync(source)).toBe(false);
    expect(() => resolveDataRoot(home)).toThrow(DataRootMigrationError);
    const recovery = spawnSync(process.execPath, [script, home, 'recover'], childOptions);
    expect(recovery.stderr).toBe('');
    expect(recovery.status).toBe(0);
    expect(fs.realpathSync(source)).toBe(destination);
    expect(fs.readFileSync(join(source, 'kept'), 'utf8')).toBe('child bytes');
  });
});
