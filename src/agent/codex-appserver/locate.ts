import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { paths } from '../../config/paths';
import { spawnProcess, spawnProcessSync } from '../../platform/spawn';
import { appServerChildEnvironment } from './app-server-client';

const IS_WIN = process.platform === 'win32';

// 模块级缓存：bin 路径与版本号在 daemon 生命周期内几乎不变，而每次探测都是
// 一个 spawn（which ~5ms、codex --version ~320ms），startThread/listThreads/
// readHistory 每次都付。只缓存**成功**结果——未找到/失败不缓存（用户随后装好
// codex 要立刻可见）；DM 体检传 force 强制重探（路径/版本可能刚变过）。
let binCache: string | null = null;
const versionCache = new Map<string, string>();

/**
 * Resolve the codex CLI binary, in priority order:
 *   1. $CODEX_BIN (explicit override)
 *   2. Vonvon-managed Codex
 *   3. PATH (`codex`, via `where`/`which`)
 *   4. macOS Homebrew locations (Finder launches with a minimal PATH)
 *   5. bridge private install (~/.feishu-codex-bridge/codex-cli/node_modules/.bin/codex)
 *   6. macOS Codex.app bundled binary
 * Returns null if none found.
 *
 * On Windows an npm-installed bin is a `codex.cmd`/`codex.exe` shim, never a
 * bare `codex`, so the private-install probe enumerates PATHEXT variants.
 */
export function resolveCodexBin(opts?: { force?: boolean }): string | null {
  // 命中后仍 existsSync 复验（零 spawn）：codex 被卸载/移动时自动失效重探。
  if (!opts?.force && binCache && existsSync(binCache)) return binCache;
  binCache = locateBin();
  return binCache;
}

function locateBin(): string | null {
  const env = process.env.CODEX_BIN;
  if (env && existsSync(env)) return env;

  if (paths.managedCodexBin && existsSync(paths.managedCodexBin)) {
    return paths.managedCodexBin;
  }

  const onPath = which('codex');
  if (onPath) return onPath;

  if (process.platform === 'darwin') {
    for (const candidate of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']) {
      if (existsSync(candidate)) return candidate;
    }
  }

  for (const cand of execCandidates(paths.codexCliBinDir, 'codex')) {
    if (existsSync(cand)) return cand;
  }

  const appBundle = '/Applications/Codex.app/Contents/Resources/codex';
  if (process.platform === 'darwin' && existsSync(appBundle)) return appBundle;

  return null;
}

/**
 * Candidate file paths for a bare command in `dir`. On Windows a shim carries a
 * PATHEXT extension (`.cmd`/`.exe`/`.bat`), so probe `codex`, `codex.cmd`,
 * `codex.exe`, … On POSIX the bare name is the only candidate.
 */
function execCandidates(dir: string, base: string): string[] {
  const exact = join(dir, base);
  if (!IS_WIN || extname(base)) return [exact];
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  return [exact, ...exts.map((e) => join(dir, base + e.toLowerCase()))];
}

function which(cmd: string): string | null {
  try {
    // `where` (win) / `which` (posix) are real executables; cross-spawn runs
    // them uniformly. `where` may return multiple lines — take the first.
    const res = spawnProcessSync(IS_WIN ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const first = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
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
    const res = spawnProcessSync(bin, ['--version'], {
      encoding: 'utf8',
      env: appServerChildEnvironment(bin),
    });
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
      child = spawnProcess(bin, ['--version'], {
        env: appServerChildEnvironment(bin),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
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
