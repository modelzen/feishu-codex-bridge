import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { spawnProcessSync } from '../platform/spawn';

/**
 * Single-instance guard. Two `start` processes sharing one Feishu app both hold
 * a long connection, and Feishu round-robins every `card.action` callback
 * between them — so a click lands on whichever process happens to receive it.
 * The one that didn't send the card has no entity mapping for it (byMessageId is
 * per-process) and silently no-ops, while both race to update the same card with
 * independent `sequence` counters → the client reverts. Net effect: buttons
 * "randomly" dead, "要点两下", 返回菜单失效. We prevent it by refusing to start a
 * second bridge for the same appId while a live one holds the pidfile.
 *
 * 原子化（M-5/F4）：抢锁用 `writeFileSync(file, …, { flag: 'wx' })`（O_EXCL，
 * 创建即占有，daemon 自启与手动 run 同时启动时恰一个成功——消 check-then-write
 * 的 TOCTOU）；残留锁（持有者已死 / pid 被复用）先 unlink 再回到 wx 重抢，并发
 * 抢残留时同样恰一个赢。读锁失败除 ENOENT 外一律 fail-closed（EACCES、损坏
 * JSON 宁可拒启，不可双开抢回调）。
 */

interface LockRecord {
  pid: number;
  appId: string;
  startedAt: number;
}

/** 抢锁重试上限：只覆盖瞬态（持有者刚释放 / wx 抢占者 open→write 的空文件
 * 间隙），活体持有者第一轮就会抛 BridgeAlreadyRunningError，不进重试。 */
const CLAIM_ATTEMPTS = 5;
/** pid 复用判定的时钟余量：ps etime 是秒粒度，再留 NTP 偏差空间。 */
const PID_REUSE_SLACK_MS = 15_000;
/** 空锁文件的瞬态/残留分界：抢占者 open→write 的间隙是毫秒级，超龄的空文件只
 * 可能是写入者在 open 之后、write 之前被 SIGKILL（或 ENOSPC 写失败）留下的残留
 * ——写入者从未注册 exit release（注册发生在写成功之后），没人会清，必须摘掉
 * 重抢，否则之后每次启动都空转重试后误报「稍后重试」。 */
const EMPTY_LOCK_STALE_MS = 2_000;

export class BridgeAlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(
      `另一个 bridge 进程已在运行 (PID ${pid})。先停掉它（kill ${pid}）再启动——` +
        `两个进程会抢同一 App 的卡片回调，导致按钮时灵时不灵。`,
    );
    this.name = 'BridgeAlreadyRunningError';
  }
}

function isAlive(pid: number): boolean {
  try {
    // signal 0: existence check, doesn't actually signal the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `ps -o etime=` 反推进程启动时刻（ms epoch）。拿不到（Windows / ps 失败 /
 * 格式不识）返回 undefined——pid 复用校验是「解除误拒」的缓解项，缺数据时
 * 保守地维持原 isAlive 判定即可。 */
function processStartMs(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const r = spawnProcessSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8' });
    if (r.status !== 0) return undefined;
    // etime: [[dd-]hh:]mm:ss
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(r.stdout).trim());
    if (!m) return undefined;
    const [, d, h, min, s] = m;
    const elapsedSec = Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min) * 60 + Number(s);
    return Date.now() - elapsedSec * 1_000;
  } catch {
    return undefined;
  }
}

/** 锁记录指向一个「活的同 app 持有者」吗？pid 复用缓解：锁是持有者启动后才写
 * 的，真持有者的进程启动时刻必然不晚于 startedAt（+余量）；一个比 startedAt 晚
 * 启动的进程不可能写下这条记录——判为复用了旧 pid 的无关进程，按残留锁处理
 * （否则崩溃残留 + pid 复用会**误拒**启动）。 */
function isLiveHolder(rec: Partial<LockRecord>, appId: string): boolean {
  if (!rec.pid || rec.pid === process.pid || rec.appId !== appId) return false;
  if (!isAlive(rec.pid)) return false;
  if (typeof rec.startedAt === 'number') {
    const started = processStartMs(rec.pid);
    if (started !== undefined && started > rec.startedAt + PID_REUSE_SLACK_MS) return false;
  }
  return true;
}

export function readSingleInstanceHolder(appId: string, file: string = paths.processesFile): { pid: number; startedAt: number } | undefined {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const record: unknown = JSON.parse(raw);
  if (typeof record !== 'object' || record === null ||
      !('pid' in record) || typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0 ||
      !('appId' in record) || typeof record.appId !== 'string' ||
      !('startedAt' in record) || typeof record.startedAt !== 'number') {
    throw new Error('无法确认 Agent 进程状态，锁文件格式无效。');
  }
  const holder = { pid: record.pid, appId: record.appId, startedAt: record.startedAt };
  return isLiveHolder(holder, appId) ? { pid: holder.pid, startedAt: holder.startedAt } : undefined;
}

/**
 * Claim the single-instance lock for `appId`. Throws {@link BridgeAlreadyRunningError}
 * if a live process already holds it. Returns a `release()` to drop the lock on
 * shutdown; it's also wired to `process.on('exit')` as a best-effort fallback.
 *
 * `file` 仅测试注入用，生产固定 {@link paths.processesFile}。
 */
export function acquireSingleInstanceLock(appId: string, file: string = paths.processesFile): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const record: LockRecord = { pid: process.pid, appId, startedAt: Date.now() };

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    // O_EXCL 原子抢占：文件不存在则「创建即占有」，存在则原子失败。
    try {
      writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx' });
      const release = (): void => {
        try {
          const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockRecord>;
          if (rec.pid === process.pid) unlinkSync(file);
        } catch {
          /* already removed or replaced by another instance */
        }
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; // fail-closed（EACCES 等）
    }

    // 已有锁文件 → 读出来判定持有者死活。
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // 持有者刚释放 → 重抢
      throw new Error(
        `无法读取单实例锁文件 ${file}：${String(err)}。为避免两个 bridge 进程抢同一 App 的卡片回调，` +
          `拒绝启动；请修复该文件的读权限后重试。`,
      );
    }
    if (raw.trim() === '') {
      // 新鲜空文件 = 抢占者 open→write 的瞬时间隙 → 重读即可；超龄空文件 =
      // 不可恢复的残留（见 EMPTY_LOCK_STALE_MS）→ 摘掉后回到循环顶重抢。
      let stale = true;
      try {
        stale = Date.now() - statSync(file).mtimeMs > EMPTY_LOCK_STALE_MS;
      } catch {
        // 文件已被并发方摘掉/接管 —— 直接重抢
      }
      if (stale) {
        try {
          unlinkSync(file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      continue;
    }
    let rec: Partial<LockRecord>;
    try {
      rec = JSON.parse(raw) as Partial<LockRecord>;
    } catch {
      // 写入已原子（wx 单次落盘），半截 JSON 只可能是旧版本残留或外部损坏——
      // fail-closed：看不懂持有者状态绝不放行。
      throw new Error(
        `单实例锁文件已损坏（${file}）。为避免两个 bridge 进程抢同一 App 的卡片回调，拒绝启动；` +
          `确认没有其他 bridge 进程在跑后，手动删除该文件再重试。`,
      );
    }
    if (isLiveHolder(rec, appId)) throw new BridgeAlreadyRunningError(rec.pid!);
    // 残留锁（持有者已死 / pid 被无关进程复用 / 其他 app 的旧记录）→ 摘掉后回到
    // 循环顶用 wx 重抢；两个进程同时清残留时，恰一个抢到，另一个下一轮读到新
    // 活体记录后被正常拒绝。
    try {
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new Error(
    `单实例锁竞争 ${CLAIM_ATTEMPTS} 次未果（${file}）。多为并发启动的瞬态，请稍后重试；` +
      `若反复出现，确认没有其他 bridge 进程在跑后，手动删除该文件再启动。`,
  );
}
