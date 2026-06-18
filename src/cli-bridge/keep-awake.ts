import { spawn } from 'node:child_process';

/** The slice of a spawned process the controller drives — narrowed so tests can
 *  inject a fake without a real child. */
export interface KeepAwakeProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface KeepAwakeController {
  /** Register one reason to keep the machine awake (e.g. a pending Feishu wait).
   *  The first held reason spawns caffeinate; balance every acquire with a release. */
  acquire(): void;
  /** Drop one reason. The last release (count → 0) terminates caffeinate. */
  release(): void;
  /** Force-release everything and kill caffeinate — for daemon shutdown. */
  shutdown(): void;
  /** True while a caffeinate assertion is held (for tests / inspection). */
  isActive(): boolean;
}

export interface KeepAwakeOptions {
  /** Live read of whether keep-awake is enabled; checked on each acquire so a
   *  runtime toggle takes effect from the next held reason. Default: always on. */
  enabled?: () => boolean;
  /** Spawn the OS keep-awake process; return undefined to no-op (non-macOS /
   *  unsupported). Injectable for tests. Default: {@link spawnCaffeinate}. */
  spawnProcess?: () => KeepAwakeProcess | undefined;
}

/**
 * Spawn `caffeinate -i` on macOS to hold a power assertion that prevents idle
 * *system* sleep while leaving display sleep alone — i.e. the screen can turn
 * off (locked / dimmed) but the CPU keeps running so a local agent task carries
 * on. We deliberately do NOT pass `-d` (that would force the display on, the
 * opposite of "screen off, still working").
 *
 * `-w <daemon pid>` ties the assertion to this process: if the daemon dies
 * without a clean shutdown, caffeinate exits on its own and the Mac can sleep
 * again — a crash-safety net on top of the explicit kill in {@link release}.
 *
 * Lid-closed (clamshell) sleep on battery is a separate OS mechanism that
 * caffeinate cannot override; that case is intentionally out of scope.
 */
export function spawnCaffeinate(): KeepAwakeProcess | undefined {
  if (process.platform !== 'darwin') return undefined;
  const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  // A spawn failure (missing binary / EPERM) emits 'error' asynchronously; swallow
  // it so it never surfaces as an unhandled error event that crashes the daemon.
  child.on('error', () => undefined);
  return child;
}

/**
 * Ref-counted keep-awake controller. The bridge calls {@link KeepAwakeController.acquire}
 * around every Feishu wait that blocks a local agent (approval / question /
 * Stop 续聊) and releases it when the wait ends — so the Mac stays awake exactly
 * while you're away with work pending, and is free to sleep the moment nothing
 * is outstanding. Multiple concurrent waits share a single caffeinate process.
 */
export function createKeepAwakeController(opts: KeepAwakeOptions = {}): KeepAwakeController {
  const enabled = opts.enabled ?? (() => true);
  const spawnProcess = opts.spawnProcess ?? spawnCaffeinate;
  let count = 0;
  let proc: KeepAwakeProcess | undefined;

  const stop = (): void => {
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      // already exited — nothing to clean up
    }
    proc = undefined;
  };

  return {
    acquire(): void {
      count += 1;
      // Spawn on the first held reason; if it was disabled when first acquired,
      // a later acquire (after the toggle flips on) still starts it.
      if (!proc && enabled()) proc = spawnProcess();
    },
    release(): void {
      if (count === 0) return;
      count -= 1;
      if (count === 0) stop();
    },
    shutdown(): void {
      count = 0;
      stop();
    },
    isActive(): boolean {
      return Boolean(proc);
    },
  };
}
