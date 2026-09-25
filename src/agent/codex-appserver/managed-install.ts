import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { paths } from '../../config/paths';
import { mergeProcessEnv } from '../../platform/spawn';
import lock from './codex-install-lock.json';
import { CodexProcessCleanupError, OwnedCodexProcess } from './owned-process';

export const CODEX_INSTALL_VERSION = '0.156.1';
export const privateCodexBin = (prefix: string): string => join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');

export function managedCodexBin(codexCliDir = paths.codexCliDir): string | null {
  try {
    const data: unknown = JSON.parse(readFileSync(join(codexCliDir, 'current.json'), 'utf8'));
    if (!data || typeof data !== 'object' || !('generation' in data) || typeof data.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(data.generation)) return null;
    const bin = privateCodexBin(join(codexCliDir, 'releases', data.generation));
    return existsSync(bin) ? bin : null;
  } catch { return null; }
}

export async function runSetupChild(command: string, args: string[], options: { cwd: string; signal: AbortSignal; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string> {
  options.signal.throwIfAborted();
  const owned = new OwnedCodexProcess(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stop: () => void = () => {};
  const interrupted = new Promise<undefined>(resolve => { stop = () => resolve(undefined); });
  let timedOut = false;
  owned.child.stdout?.on('data', data => { if (output.length < 8192) output += String(data).slice(0, 8192 - output.length); });
  owned.child.stderr?.resume();
  const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 300_000);
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  try {
    const result = await Promise.race([owned.exited, interrupted]);
    await owned.close();
    options.signal.throwIfAborted();
    if (timedOut) throw new Error('安装工具运行超时');
    if (result?.kind === 'error') throw result.error;
    if (result?.code !== 0) throw new Error(`安装工具退出，状态码 ${result?.code}`);
    return output.trim();
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
  }
}

export async function installManagedCodex(signal: AbortSignal): Promise<void> {
  if (process.env.CODEX_BIN) throw new Error('当前使用显式 CODEX_BIN，请先移除此覆盖再安装托管 Codex');
  const npmCli = process.env.VONVON_NPM_CLI;
  if (!npmCli || !isAbsolute(npmCli)) throw new Error('缺少桌面应用提供的可信 npm 路径');
  const npm = await realpath(npmCli);
  if (!(await stat(npm)).isFile()) throw new Error('可信 npm 路径不是文件');
  const parent = await realpath(dirname(paths.appDir));
  const live = await realpath(paths.appDir);
  const stage = await mkdtemp(join(parent, '.vonvon-codex-stage-'));
  const stagePath = await realpath(stage);
  if (stagePath === live || stagePath.startsWith(live + sep)) throw new Error('安装暂存目录不能位于运行数据目录内');
  const prefix = join(stagePath, 'install');
  const generation = randomUUID();
  let committed = false;
  let cleanupVerified = true;
  let release: string | undefined;
  try {
    await mkdir(prefix, { mode: 0o700 });
    await writeFile(join(prefix, 'package.json'), JSON.stringify({ private: true, dependencies: { '@openai/codex': CODEX_INSTALL_VERSION } }));
    await writeFile(join(prefix, 'package-lock.json'), JSON.stringify(lock));
    await writeFile(join(stagePath, 'npmrc'), '');
    const env = mergeProcessEnv(process.env, { npm_config_userconfig: join(stagePath, 'npmrc'), npm_config_cache: join(stagePath, 'cache'), npm_config_update_notifier: 'false' });
    await runSetupChild(process.execPath, [npm, 'ci', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--cache', join(stagePath, 'cache')], { cwd: prefix, signal, env });
    const bin = privateCodexBin(prefix);
    const executable = await realpath(bin);
    const rel = relative(prefix, executable);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('安装的 Codex 可执行文件越出私有目录');
    const version = await runSetupChild(bin, ['--version'], { cwd: prefix, signal, timeoutMs: 20_000 });
    if (version !== `codex-cli ${CODEX_INSTALL_VERSION}`) throw new Error('安装的 Codex 版本校验失败');
    signal.throwIfAborted();
    const releases = join(paths.codexCliDir, 'releases');
    await mkdir(releases, { recursive: true, mode: 0o700 });
    const releasesPath = await realpath(releases);
    if (!releasesPath.startsWith(live + sep)) throw new Error('私有安装目录越出运行数据目录');
    release = join(releasesPath, generation);
    await rename(prefix, release);
    signal.throwIfAborted();
    const pointer = join(paths.codexCliDir, `current-${generation}.json`);
    await writeFile(pointer, JSON.stringify({ generation, version: CODEX_INSTALL_VERSION }), { mode: 0o600 });
    try {
      signal.throwIfAborted();
      await rename(pointer, join(paths.codexCliDir, 'current.json'));
      committed = true;
    } finally { await rm(pointer, { force: true }); }
  } catch (error) {
    if (error instanceof CodexProcessCleanupError) cleanupVerified = false;
    throw error;
  } finally {
    if (cleanupVerified) {
      if (!committed && release) await rm(release, { recursive: true, force: true });
      await rm(stagePath, { recursive: true, force: true });
    }
  }
}
