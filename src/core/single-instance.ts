import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../config/paths';

/**
 * Single-instance guard. Two `start` processes sharing one Feishu app both hold
 * a long connection, and Feishu round-robins every `card.action` callback
 * between them — so a click lands on whichever process happens to receive it.
 * The one that didn't send the card has no entity mapping for it (byMessageId is
 * per-process) and silently no-ops, while both race to update the same card with
 * independent `sequence` counters → the client reverts. Net effect: buttons
 * "randomly" dead, "要点两下", 返回菜单失效. We prevent it by refusing to start a
 * second bridge for the same appId while a live one holds the pidfile.
 */

interface LockRecord {
  pid: number;
  appId: string;
  startedAt: number;
}

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

/**
 * Claim the single-instance lock for `appId`. Throws {@link BridgeAlreadyRunningError}
 * if a live process already holds it. Returns a `release()` to drop the lock on
 * shutdown; it's also wired to `process.on('exit')` as a best-effort fallback.
 */
export function acquireSingleInstanceLock(appId: string): () => void {
  const file = paths.processesFile;
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockRecord>;
    if (rec.pid && rec.pid !== process.pid && rec.appId === appId && isAlive(rec.pid)) {
      throw new BridgeAlreadyRunningError(rec.pid);
    }
  } catch (err) {
    if (err instanceof BridgeAlreadyRunningError) throw err;
    // ENOENT / malformed / stale (dead pid) → no live holder; fall through.
  }

  mkdirSync(dirname(file), { recursive: true });
  const record: LockRecord = { pid: process.pid, appId, startedAt: Date.now() };
  writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');

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
}
