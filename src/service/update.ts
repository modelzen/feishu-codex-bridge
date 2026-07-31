import { closeSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths';
import {
  currentEmbeddedRuntimeHost,
  isRuntimeCheckout,
  UPSTREAM_BRIDGE_VERSION,
  UPSTREAM_PACKAGE_NAME,
} from '../core/runtime-context';
import { spawnProcess } from '../platform/spawn';
import { getServiceAdapter, isServiceRunning } from './adapter';

// `npm` via cross-spawn: on Windows it's an `npm.cmd` shim that a bare
// spawn/execFile would reject with EINVAL (CVE-2024-27980); cross-spawn runs it,
// and spawnProcess hides the console window (important when the background
// service triggers a one-click update with no console of its own).
const NPM = 'npm';

/**
 * The installed package's own root. After bundling, every source module's
 * `import.meta.url` resolves to dist/cli.js, so its parent is the package root —
 * the same layout in a global install (.../node_modules/<pkg>/) and a local
 * checkout. We read package.json from here for both the current version and the
 * canonical package name (so a rename can't drift the npm target).
 */
export function currentVersion(): string {
  return UPSTREAM_BRIDGE_VERSION;
}

export function packageName(): string {
  return UPSTREAM_PACKAGE_NAME;
}

/**
 * Running from a git checkout (the repo root has a .git) rather than an npm
 * install. `npm i -g` would not update that working copy, so callers should
 * steer the user to `git pull && npm i` instead.
 */
export function isDevSource(): boolean {
  return isRuntimeCheckout();
}

/** semver-ish compare: is `a` strictly newer than `b`? (major.minor.patch) */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** Latest published version on the configured registry, or null if unreachable. */
export async function latestVersion(): Promise<string | null> {
  if (currentEmbeddedRuntimeHost()) return null;
  const v = await new Promise<string | null>((resolveP) => {
    const child = spawnProcess(NPM, ['view', packageName(), 'version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolveP(null);
    }, 20000);
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolveP(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP(code === 0 ? out.trim() : null);
    });
  });
  return v && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

export interface LegacyUpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  dev: boolean;
}

export type DesktopReleaseState =
  | 'unpublished'
  | 'available'
  | 'current'
  | 'unavailable';

export interface DesktopManualUpdateCheck extends LegacyUpdateCheck {
  mode: 'manual';
  state: DesktopReleaseState;
  compatVersion: string;
  dev: false;
  message: string;
  channel?: 'stable' | 'beta';
  releasePageUrl?: string;
  dmgUrl?: string;
  critical?: boolean;
  minimumMacOS?: string;
  sha256?: string;
}

export type UpdateCheck = LegacyUpdateCheck | DesktopManualUpdateCheck;

export async function checkUpdate(): Promise<UpdateCheck> {
  const embeddedHost = currentEmbeddedRuntimeHost();
  if (embeddedHost?.checkUpdate) return await embeddedHost.checkUpdate();
  const current = currentVersion();
  const latest = await latestVersion();
  return { current, latest, hasUpdate: !!latest && isNewer(latest, current), dev: isDevSource() };
}

export interface InstallResult {
  ok: boolean;
  /** tail of npm's combined output (capture mode) or a short status line */
  message: string;
}

/**
 * Run `npm install -g <pkg>@latest`. Async (spawn, never spawnSync) so card
 * callbacks can call it without freezing the bridge's event loop. With
 * `inherit`, npm's progress streams straight to the terminal (CLI use); without
 * it, output is captured and the tail returned for surfacing in a card.
 */
export async function installLatest(opts: { inherit?: boolean } = {}): Promise<InstallResult> {
  if (currentEmbeddedRuntimeHost()) {
    return {
      ok: false,
      message: 'Vonvon Bridge 桌面版由桌面应用管理更新，不会改写旧版全局 CLI。',
    };
  }
  const target = `${packageName()}@latest`;
  return await new Promise<InstallResult>((resolveP) => {
    const child = spawnProcess(NPM, ['install', '-g', target], {
      stdio: opts.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    if (!opts.inherit) {
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (out += d));
    }
    child.on('error', (e) => resolveP({ ok: false, message: e.message }));
    child.on('close', (code) => {
      const tail = out.trim().slice(-600);
      resolveP({ ok: code === 0, message: opts.inherit ? `退出码 ${code}` : tail || `退出码 ${code}` });
    });
  });
}

// ── 更新互斥锁（B）+ 更新结果状态（D）────────────────────────────────────────
// 都落在 appDir，供跨进程协作：Web「升级」跑在 detached helper 里、私聊「更新」跑在
// daemon 里，两者可能并发。锁防止两个 `npm i -g` 并发把全局目录装坏；状态文件给
// helper 的结果一个 daemon 能读、Web 能轮询的落点（否则 helper 失败对网页端静默）。

// 远超任何合理的 `npm i -g` 时长：超时回收只是「pid 被复用成别的进程」的兜底——持有者
// 真的死了会被下面的 livePid 立刻回收，不靠这个时钟。设太短会把一个装得慢的**存活**安装
// 误判成陈旧、抢锁并发跑两个 npm（正是本锁要防的），故取 30min 这种绝不会误伤的大值。
const UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;

function updateLockFile(): string {
  return join(paths.appDir, 'update.lock');
}

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程在、只是本进程无权 signal → 仍算活。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isUpdateLockStale(file: string): boolean {
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number; at?: number };
    if (typeof rec.pid !== 'number') return true; // 无 pid → 损坏，可回收
    if (!livePid(rec.pid)) return true; // 持有者已死 → 优先回收（不受时钟影响）
    // 持有者还活着：只有超时才回收，兜底「pid 被复用成别的进程」这种极少数情形。
    return typeof rec.at === 'number' && Date.now() - rec.at > UPDATE_LOCK_STALE_MS;
  } catch {
    return true; // 损坏/读不出 → 可回收
  }
}

/**
 * 跨进程互斥：给 `npm i -g` 上锁，防止 Web「升级」与私聊「更新」（或双击）并发跑两个
 * 全局安装、把同一目录装坏。拿到锁返回 release()；已有**新鲜且存活**的更新在跑则返回
 * null（调用方应提示「更新已在进行」并**不**继续）。陈旧锁（持有者已死 / 超 30min 的
 * 崩溃残留）会被回收。O_EXCL('wx') 原子创建，与单例锁同套路。任何**非**「已存在」的
 * fs 异常也一律返回 null（当作拿不到锁）而**不** throw——否则 fire-and-forget 的调用方
 * 会 unhandled rejection、卡片定格无反馈。需要 appDir 已存在（调用方都在服务目录建好后跑）。
 */
export function acquireUpdateLock(): (() => void) | null {
  const file = updateLockFile();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx'); // O_EXCL：创建即占有，创建失败即已存在
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return releaseUpdateLock(file); // 只删「属于自己」的锁，绝不误删他人的
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return null; // EACCES/ENOSPC/… → 当作拿不到锁，绝不 throw
      if (!isUpdateLockStale(file)) return null; // 活体新鲜持有者 → 更新进行中
      try {
        rmSync(file, { force: true }); // 回收陈旧锁后重试 wx 创建
      } catch {
        /* 可能被别人抢先回收，交给下一轮 */
      }
    }
  }
  return null; // 连续抢回收都输 → 当作进行中（安全：绝不并发 npm）
}

/** release：只在锁文件仍指向自己时删——避免删掉「回收了本进程陈旧锁后的新持有者」的锁。 */
function releaseUpdateLock(file: string): () => void {
  return () => {
    try {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
      if (rec.pid !== process.pid) return; // 不是自己的锁（已被回收/换主）→ 别动
    } catch {
      /* 损坏/已不存在 → 落到下面尽力删（force 对不存在无害） */
    }
    try {
      rmSync(file, { force: true });
    } catch {
      /* best-effort */
    }
  };
}

export type UpdatePhase = 'installing' | 'restarting' | 'done' | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  ok?: boolean;
  message?: string;
  from?: string;
  to?: string;
  /** epoch ms；Web 端提交升级前会 clear，故读到的即本次结果。 */
  at: number;
}

function updateStatusFile(): string {
  return join(paths.appDir, 'update-status.json');
}

/**
 * 记录更新进度/结果，供 Web 控制台轮询显示（尤其失败——否则 detached helper 的失败对
 * 网页端完全静默）。同步、尽力而为、绝不抛。
 */
export function writeUpdateStatus(status: UpdateStatus): void {
  try {
    writeFileSync(updateStatusFile(), JSON.stringify(status), 'utf8');
  } catch {
    /* best-effort */
  }
}

export function readUpdateStatus(): UpdateStatus | null {
  try {
    const s = JSON.parse(readFileSync(updateStatusFile(), 'utf8')) as UpdateStatus;
    return s && typeof s.phase === 'string' && typeof s.at === 'number' ? s : null;
  } catch {
    return null;
  }
}

/** 清掉上一次的更新结果——Web 提交新升级前调用，之后读到的状态才确定属于本次。 */
export function clearUpdateStatus(): void {
  try {
    rmSync(updateStatusFile(), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Is the OS background service currently running? Platform-aware (launchd on
 * macOS, Task Scheduler on Windows); false on platforms without a service.
 */
export function daemonRunning(): boolean {
  if (currentEmbeddedRuntimeHost()) return true;
  return isServiceRunning();
}

/**
 * Restart the background daemon so it reloads the freshly-installed code. When
 * invoked from a card handler the running process *is* that daemon, so this kill
 * terminates the caller — send any "done" UI before calling it.
 */
export async function restartDaemon(): Promise<void> {
  const embedded = currentEmbeddedRuntimeHost();
  if (embedded) {
    await embedded.requestRestart();
    return;
  }
  await getServiceAdapter().restart();
}
