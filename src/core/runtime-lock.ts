import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type RuntimeOwnerKind = 'cli' | 'desktop';

export interface RuntimeOwnerRecord {
  schemaVersion: 1;
  kind: RuntimeOwnerKind;
  product: string;
  pid: number;
  processStartedAt: number;
  acquiredAt: number;
  leaseId: string;
}

export interface HostRuntimeLease {
  readonly owner: RuntimeOwnerRecord;
  release(): void;
}

export interface AcquireHostRuntimeLeaseOptions {
  owner: Pick<RuntimeOwnerRecord, 'kind' | 'product'>;
  lockFile?: string;
}

const PID_START_SLACK_MS = 15_000;

export class RuntimeAlreadyOwnedError extends Error {
  constructor(public readonly owner: RuntimeOwnerRecord) {
    const holder = owner.kind === 'desktop' ? '桌面端' : 'CLI';
    super(`Bridge Runtime 已由${holder}占用 (PID ${owner.pid})。请先在持有端停止 Bridge。`);
    this.name = 'RuntimeAlreadyOwnedError';
  }
}

export function defaultHostRuntimeLockFile(): string {
  return join(homedir(), '.feishu-codex-bridge-runtime', 'runtime-owner.json');
}

function readOwner(lockFile: string): RuntimeOwnerRecord {
  if (lstatSync(lockFile).isSymbolicLink()) {
    throw new Error(`Bridge Runtime 所有权文件不能是符号链接：${lockFile}`);
  }
  chmodSync(lockFile, 0o600);
  const owner = JSON.parse(readFileSync(lockFile, 'utf8')) as Partial<RuntimeOwnerRecord>;
  if (
    owner.schemaVersion !== 1 ||
    (owner.kind !== 'cli' && owner.kind !== 'desktop') ||
    typeof owner.product !== 'string' ||
    typeof owner.pid !== 'number' ||
    typeof owner.processStartedAt !== 'number' ||
    typeof owner.acquiredAt !== 'number' ||
    typeof owner.leaseId !== 'string'
  ) {
    throw new Error(`无法识别 Bridge Runtime 所有权记录：${lockFile}`);
  }
  return owner as RuntimeOwnerRecord;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processStartMs(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8' });
    if (result.status !== 0) return undefined;
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(result.stdout).trim());
    if (!match) return undefined;
    const [, days, hours, minutes, seconds] = match;
    const elapsedSeconds =
      Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes) * 60 + Number(seconds);
    return Date.now() - elapsedSeconds * 1_000;
  } catch {
    return undefined;
  }
}

function isCurrentHolder(owner: RuntimeOwnerRecord): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  const actualStart = processStartMs(owner.pid);
  return actualStart === undefined || Math.abs(actualStart - owner.processStartedAt) <= PID_START_SLACK_MS;
}

function reclaimStaleOwner(lockFile: string): void {
  const guardDirectory = `${lockFile}.reclaiming`;
  try {
    mkdirSync(guardDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Bridge Runtime 所有权回收正在进行：${lockFile}`);
    }
    throw error;
  }

  const releaseGuard = (): void => {
    try {
      rmdirSync(guardDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  const releaseGuardOnExit = (): void => {
    try {
      releaseGuard();
    } catch {
      // Process exit is already the final cleanup boundary.
    }
  };
  process.once('exit', releaseGuardOnExit);
  try {
    let current: RuntimeOwnerRecord;
    try {
      current = readOwner(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (isCurrentHolder(current)) throw new RuntimeAlreadyOwnedError(current);
    try {
      unlinkSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } finally {
    process.off('exit', releaseGuardOnExit);
    releaseGuard();
  }
}

export function acquireHostRuntimeLease(options: AcquireHostRuntimeLeaseOptions): HostRuntimeLease {
  const lockFile = options.lockFile ?? defaultHostRuntimeLockFile();
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  chmodSync(dirname(lockFile), 0o700);

  const now = Date.now();
  const owner: RuntimeOwnerRecord = {
    schemaVersion: 1,
    kind: options.owner.kind,
    product: options.owner.product,
    pid: process.pid,
    processStartedAt: now - Math.floor(process.uptime() * 1_000),
    acquiredAt: now,
    leaseId: randomUUID(),
  };

  let acquired = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockFile, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      reclaimStaleOwner(lockFile);
    }
  }
  if (!acquired) {
    throw new Error(`Bridge Runtime 所有权竞争未完成：${lockFile}。请稍后重试。`);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    try {
      const current = readOwner(lockFile);
      if (current.leaseId === owner.leaseId) unlinkSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    released = true;
    process.off('exit', releaseOnExit);
  };
  const releaseOnExit = (): void => {
    try {
      release();
    } catch {
      // Process exit is already the final cleanup boundary.
    }
  };
  process.once('exit', releaseOnExit);

  return { owner, release };
}
