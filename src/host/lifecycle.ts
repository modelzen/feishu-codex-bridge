import { spawn, type ChildProcess } from 'node:child_process';

export interface ShutdownControl {
  readonly requested: boolean;
  waitForRequest(): Promise<void>;
  dispose(): void;
}

export function observeShutdown(parentControl = false): ShutdownControl {
  let requested = false;
  let wake: () => void = () => {};
  const pending = new Promise<void>((resolve) => { wake = resolve; });
  const request = (): void => { requested = true; wake(); };
  const message = (value: unknown): void => {
    if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'bridge:shutdown') request();
  };
  let input = '';
  const data = (chunk: Buffer): void => {
    input += chunk.toString('utf8');
    if (input.length > 1024 || input.includes('\n')) {
      if (input.trim() === 'shutdown') request();
      input = '';
    }
  };
  process.on('SIGINT', request);
  process.on('SIGTERM', request);
  if (process.send) {
    process.on('message', message);
    process.on('disconnect', request);
  }
  if (parentControl) {
    process.stdin.on('data', data);
    process.stdin.on('end', request);
    process.stdin.on('error', request);
    process.stdin.resume();
    if (process.stdin.readableEnded || process.stdin.destroyed) request();
  }
  return {
    get requested() { return requested; },
    waitForRequest: () => pending,
    dispose() {
      process.off('SIGINT', request); process.off('SIGTERM', request);
      process.off('message', message); process.off('disconnect', request);
      if (parentControl) {
        process.stdin.off('data', data); process.stdin.off('end', request); process.stdin.off('error', request);
        process.stdin.pause();
      }
    },
  };
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean): void => { clearTimeout(timer); child.off('exit', exitedEvent); resolve(exited); };
    const exitedEvent = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', exitedEvent);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

export const CHILD_SHUTDOWN_GRACE_MS = 8000;
const FORCE_EXIT_MS = 3000;
const HOST_SHUTDOWN_GRACE_MS = CHILD_SHUTDOWN_GRACE_MS + FORCE_EXIT_MS + 1000;
const stops = new WeakMap<ChildProcess, Promise<void>>();

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

async function reapGroup(pid: number): Promise<boolean> {
  if (!groupExists(pid)) return false;
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  const deadline = Date.now() + FORCE_EXIT_MS;
  while (groupExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`Host process group ${pid} has not exited after forced termination.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

export function stopChild(child: ChildProcess, graceMs = HOST_SHUTDOWN_GRACE_MS, ownsProcessGroup = false): Promise<void> {
  const existing = stops.get(child);
  if (existing) return existing;
  const stopping = stop(child, graceMs, ownsProcessGroup);
  stops.set(child, stopping);
  return stopping;
}

async function stop(child: ChildProcess, graceMs: number, ownsProcessGroup: boolean): Promise<void> {
  let forced = false;
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.pid) throw new Error('Cannot terminate a child without a process identity.');
    if (child.connected) {
      child.send({ type: 'bridge:shutdown' }, () => {});
      if (process.platform !== 'win32') child.kill('SIGTERM');
    }
    else if (child.stdin && !child.stdin.destroyed) child.stdin.end('shutdown\n');
    else if (process.platform !== 'win32') child.kill('SIGTERM');
    if (!await waitForExit(child, graceMs)) {
      forced = true;
      const forceDeadline = Date.now() + FORCE_EXIT_MS;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        let killError: Error | undefined;
        killer.once('error', (error) => { killError = error; });
        if (!await waitForExit(killer, FORCE_EXIT_MS)) {
          killer.kill();
          throw new Error(`Host tree termination timed out for ${child.pid}.`, { cause: killError });
        }
        if (killError) throw killError;
        if (killer.exitCode !== 0 && child.exitCode === null && child.signalCode === null) throw new Error(`Host tree termination failed for ${child.pid}.`);
      } else if (ownsProcessGroup) {
        await reapGroup(child.pid);
      } else child.kill('SIGKILL');
      if (!await waitForExit(child, Math.max(0, forceDeadline - Date.now()))) throw new Error(`Host process ${child.pid} has not exited after forced termination.`);
    }
  }
  if (ownsProcessGroup && process.platform !== 'win32' && child.pid) forced = await reapGroup(child.pid) || forced;
  if (forced) throw new Error(`Host process ${child.pid} required forced termination; graceful cleanup was not confirmed.`);
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error(`Host process ${child.pid} exited with ${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`}; graceful cleanup failed.`);
  }
}
