import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { paths } from '../config/paths';

/** undefined: no saved preference; null: explicitly clear the override. */
export type ServiceCodexBin = string | null | undefined;

const FILE_NAME = 'service-environment.json';
const UNSAFE_PATH_CHAR = /[\r\n\0]/;

/** Resolve at installation time, before a service changes the working directory.
 * Keep symlink spelling so upgrading a symlink target still upgrades Codex. */
export function normalizeServiceCodexBin(
  value: ServiceCodexBin,
  cwd: string = process.cwd(),
): ServiceCodexBin {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (UNSAFE_PATH_CHAR.test(value)) {
    throw new Error('CODEX_BIN 路径不能包含换行符或 NUL。');
  }
  const absolute = resolve(cwd, value);
  if (UNSAFE_PATH_CHAR.test(absolute)) {
    throw new Error('CODEX_BIN 路径不能包含换行符或 NUL。');
  }
  return absolute;
}

function isSavedValue(value: unknown): value is string | null {
  return value === null || (
    typeof value === 'string' &&
    value.length > 0 &&
    isAbsolute(value) &&
    !UNSAFE_PATH_CHAR.test(value)
  );
}

/** Only absence means legacy/unconfigured. Broken state must not silently make
 * a restart select a different Codex executable. */
export function readServiceCodexBin(appDir: string = paths.appDir): ServiceCodexBin {
  const file = join(appDir, FILE_NAME);
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('无法读取后台服务 Codex 配置：' + file, { cause: error });
  }
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch (error) {
    throw new Error('后台服务 Codex 配置损坏：' + file, { cause: error });
  }
  if (
    !record || typeof record !== 'object' || Array.isArray(record) ||
    !('version' in record) || record.version !== 1 ||
    !('codexBin' in record) || !isSavedValue(record.codexBin)
  ) {
    throw new Error('后台服务 Codex 配置格式无效（需要版本 1 及绝对路径或 null）：' + file);
  }
  return record.codexBin;
}

/** Only installation may change the saved choice from the caller's environment.
 * Restart callers use readServiceCodexBin instead of their possibly stale env. */
export function selectInstallCodexBin(appDir: string = paths.appDir): ServiceCodexBin {
  const explicit = process.env.CODEX_BIN;
  return explicit === undefined ? readServiceCodexBin(appDir) : normalizeServiceCodexBin(explicit);
}

/** Synchronous, atomic replacement: readers see either complete old or new state.
 * Unset is a no-op; explicit clear is durable null, never deletion of the record. */
export function saveServiceCodexBin(
  value: ServiceCodexBin,
  appDir: string = paths.appDir,
): void {
  if (value === undefined) return;
  if (!isSavedValue(value)) throw new Error('保存的 CODEX_BIN 必须是绝对路径或 null。');
  mkdirSync(appDir, { recursive: true });
  const file = join(appDir, FILE_NAME);
  const temporary = file + '.tmp-' + process.pid + '-' + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, codexBin: value }) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, file);
  } finally {
    // If replacement failed, retain the previous record and remove only our temp.
    try { rmSync(temporary, { force: true }); } catch { /* keep the original error */ }
  }
}
