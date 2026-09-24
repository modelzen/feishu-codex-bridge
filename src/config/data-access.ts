import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { resolveDataRoot } from './data-root';

export class DataAccessError extends Error {}
export interface DataLease { release(): void }

export function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
    throw new DataAccessError(`Cannot establish whether process ${pid} has exited.`, { cause: error });
  }
}

export function coordinationPort(home: string, role: 'admission' | 'host'): number {
  const path = realpathSync(home);
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path;
  const hash = createHash('sha256').update(`vonvon-bridge-v1:${role}:${normalized}`).digest().readUInt32BE(0);
  return 20000 + hash % 30000;
}

export async function acquireMutex(home: string, role: 'admission' | 'host', timeoutMs = 1500): Promise<Server> {
  const port = coordinationPort(home, role);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return server;
    } catch (error) {
      server.close();
      if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error;
      if (Date.now() >= deadline) throw new DataAccessError(`Bridge ${role} is busy on local coordination port ${port}.`);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}

export function closeMutex(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const leaseDirectory = (home: string): string => join(realpathSync(home), '.vonvon-bridge-access');

function requirePrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DataAccessError(`Invalid admission directory ${path}.`);
}

export function assertNoDataLeases(home: string): void {
  const dir = leaseDirectory(home);
  let files: string[];
  try { requirePrivateDirectory(dir); files = readdirSync(dir); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const file of files) {
    const path = join(dir, file);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DataAccessError(`Invalid admission record ${path}.`);
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof record !== 'object' || record === null || !('version' in record) || record.version !== 1
      || !('pid' in record) || typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || Object.keys(record).length !== 2) throw new DataAccessError(`Incomplete admission record ${path}.`);
    if (!isDead(record.pid)) throw new DataAccessError(`Bridge data is in use by process ${record.pid}.`);
    unlinkSync(path);
  }
}

export async function enterDataAccess(home: string): Promise<DataLease> {
  const mutex = await acquireMutex(home, 'admission');
  try {
    resolveDataRoot(home);
    const dir = leaseDirectory(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    requirePrivateDirectory(dir);
    const path = join(dir, `${process.pid}-${randomUUID()}.json`);
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ version: 1, pid: process.pid })); fsyncSync(fd); }
    finally { closeSync(fd); }
    let released = false;
    const release = (): void => {
      if (released) return;
      unlinkSync(path);
      released = true;
      process.removeListener('exit', onExit);
    };
    const onExit = (): void => {
      try { release(); }
      catch (error) { console.error('Unable to release Bridge data lease:', error instanceof Error ? error.message : String(error)); }
    };
    process.once('exit', onExit);
    return { release };
  } finally { await closeMutex(mutex); }
}
