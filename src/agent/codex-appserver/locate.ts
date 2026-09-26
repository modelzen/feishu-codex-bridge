import { managedCodexBin } from './managed-install';
import { managedToolSelection } from './managed-tools';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { paths } from '../../config/paths';
import { spawnProcess, spawnProcessSync } from '../../platform/spawn';

const IS_WIN = process.platform === 'win32';

// 模块级缓存：bin 路径与版本号在 daemon 生命周期内几乎不变，而每次探测都是
// 一个 spawn（which ~5ms、codex --version ~320ms），startThread/listThreads/
// readHistory 每次都付。只缓存**成功**结果——未找到/失败不缓存（用户随后装好
// codex 要立刻可见）；DM 体检传 force 强制重探（路径/版本可能刚变过）。
let binCache: string | null = null;
const versionCache = new Map<string, string>();

export type CodexResolutionOptions = {
  force?: boolean;
  home?: string;
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
};

export function resolveCodexBin(opts: CodexResolutionOptions = {}): string | null {
  const env = opts.env ?? process.env;
  const root = opts.dataRoot ?? paths.appDir;
  if (env.CODEX_BIN) return existsSync(env.CODEX_BIN) ? env.CODEX_BIN : null;
  const selected = managedToolSelection(root, 'codex');
  if (selected.kind === 'active') return selected.executable;
  if (selected.kind === 'absent') {
    for (const candidate of execCandidates(join(root, 'managed-tools', 'bin'), 'codex', env)) {
      if (existsSync(candidate)) return candidate;
    }
    const managed = managedCodexBin(join(root, 'codex-cli'));
    if (managed) return managed;
  }
  const customContext = opts.home !== undefined || opts.dataRoot !== undefined || opts.env !== undefined;
  if (!customContext && !opts.force && binCache && existsSync(binCache) && (selected.kind === 'absent' || !inLegacyManagedRoot(binCache, root))) return binCache;
  const result = locateBin(opts.home ?? homedir(), root, env, selected.kind !== 'absent');
  if (!customContext) binCache = result;
  return result;
}

function locateBin(home: string, root: string, env: NodeJS.ProcessEnv, blockLegacyManaged: boolean): string | null {
  const onPath = which('codex', env, blockLegacyManaged ? root : undefined);
  if (onPath) return onPath;
  const directories = blockLegacyManaged ? [] : [join(root, 'codex-cli', 'node_modules', '.bin')];
  if (process.platform === 'darwin') {
    directories.push('/Applications/Codex.app/Contents/Resources', join(home, 'Applications/Codex.app/Contents/Resources'));
  }
  try {
    const nvm = join(home, '.nvm', 'versions', 'node');
    const versions = readdirSync(nvm).filter(version => /^v\d+\.\d+\.\d+$/.test(version)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    directories.push(...versions.map(version => join(nvm, version, 'bin')));
  } catch {}
  for (const directory of directories) {
    for (const candidate of execCandidates(directory, 'codex', env)) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function inLegacyManagedRoot(candidate: string, root: string): boolean {
  try {
    const target = realpathSync.native(candidate);
    return [join(root, 'managed-tools'), join(root, 'codex-cli')].some(managed => {
      if (!existsSync(managed)) return false;
      const path = relative(realpathSync.native(managed), target);
      return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
    });
  } catch {
    return true;
  }
}

function execCandidates(dir: string, base: string, env: NodeJS.ProcessEnv): string[] {
  const exact = join(dir, base);
  if (!IS_WIN || extname(base)) return [exact];
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim()).filter(Boolean);
  return [exact, ...exts.map(e => join(dir, base + e.toLowerCase()))];
}

function which(cmd: string, env: NodeJS.ProcessEnv, blockedDataRoot?: string): string | null {
  try {
    const res = spawnProcessSync(IS_WIN ? 'where' : '/usr/bin/which', IS_WIN ? [cmd] : ['-a', cmd], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const first = res.stdout.split('\n').map(l => l.trim()).find(candidate => candidate && existsSync(candidate) && (!blockedDataRoot || !inLegacyManagedRoot(candidate, blockedDataRoot)));
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/** Best-effort version string of the resolved codex binary（同步，CLI 场景用；
 * 卡片回调等事件循环上下文请用 {@link codexVersionAsync}）。 */
export function codexVersion(bin: string, opts?: { force?: boolean }): string | null {
  if (!opts?.force) {
    const hit = versionCache.get(bin);
    if (hit !== undefined) return hit;
  }
  let out: string | null;
  try {
    // cross-spawn so a Windows `.cmd` shim runs (avoids execFile EINVAL).
    const res = spawnProcessSync(bin, ['--version'], { encoding: 'utf8' });
    out = res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : null;
  } catch {
    out = null;
  }
  if (out !== null) versionCache.set(bin, out);
  return out;
}

/** Async counterpart of {@link codexVersion}（共享同一缓存）。卡片回调里
 * **绝不能** spawnSync——同步 `codex --version`（~320ms）会冻结整条 event
 * loop，所有话题的流式 pump、WS 心跳、⏹ 回调一起停摆。 */
export async function codexVersionAsync(bin: string, opts?: { force?: boolean }): Promise<string | null> {
  if (!opts?.force) {
    const hit = versionCache.get(bin);
    if (hit !== undefined) return hit;
  }
  const out = await new Promise<string | null>((resolve) => {
    let child;
    try {
      // 同 codexVersion：cross-spawn 跑 Windows `.cmd` shim（裸 execFile 会 EINVAL）。
      child = spawnProcess(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? stdout.trim() : null));
  });
  if (out !== null) versionCache.set(bin, out);
  return out;
}
