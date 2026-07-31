import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, dirname, isAbsolute } from 'node:path';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import { log } from '../../core/logger';
import type { ServerNotification } from './protocol';

/** Simple async queue: push() from the reader, async-iterate from consumers. */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  /** Drop everything buffered but not yet consumed (consumers/waiters keep working). */
  clear(): void {
    this.items.length = 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** 应用层 JSON-RPC error 应答——进程本身是健康的（它好好地回了包）。按失败
 * 弃置/重建进程的调用方（client-pool 的 utilityRequest）必须把它与超时/传输层
 * 失败区分开：杀掉健康的共享进程会 failAllPending 殃及并发在飞的其他请求。 */
export class JsonRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export interface AppServerClientOptions {
  bin: string;
  cwd: string;
  env?: Record<string, string>;
  clientName?: string;
}

export function appServerChildEnvironment(
  executable: string,
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged = mergeProcessEnv(base, {
    ...overrides,
    FEISHU_CODEX_BRIDGE: '1',
  });
  const inheritedPath = Object.entries(merged)
    .find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const executableDirectory = isAbsolute(executable) ? dirname(executable) : undefined;
  const pathEntries = [
    executableDirectory,
    ...inheritedPath.split(delimiter),
  ].filter((entry): entry is string => Boolean(entry));
  return mergeProcessEnv(merged, {
    PATH: [...new Set(pathEntries)].join(delimiter),
  });
}

/**
 * One `codex app-server --listen stdio://` child process, speaking JSON-RPC 2.0
 * over newline-delimited JSON. One client = one thread/session (per design:
 * a process per session for crash isolation). The one exception is the shared
 * metadata utility client (client-pool.ts), which hosts no threads at all.
 */
export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new AsyncQueue<ServerNotification>();
  private closed = false;
  private hasExited = false;

  constructor(private readonly opts: AppServerClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** true once the child process has exited (crash or close) — the client is
   * dead and every further request would just EPIPE. Callers (CodexThread.
   * isAlive) use this to evict the thread so resolveThread's resume fallback
   * can take over instead of reusing a corpse. */
  get exited(): boolean {
    return this.hasExited;
  }

  /** spawn + initialize handshake. Throws if spawn/handshake fails. */
  async connect(): Promise<void> {
    // Launch via cross-spawn (platform/spawn) so a Windows `.cmd` codex shim
    // runs instead of throwing EINVAL (CVE-2024-27980). With stdio all-piped the
    // streams are non-null, so the cast to *WithoutNullStreams is sound.
    const child = spawnProcess(this.opts.bin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.opts.cwd,
      env: appServerChildEnvironment(this.opts.bin, process.env, this.opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    log.info('agent', 'spawn', { pid: child.pid ?? null, cwd: this.opts.cwd });

    child.stdout.on('data', (d: Buffer) => this.onStdout(d));
    child.stderr.on('data', (d: Buffer) => {
      const line = d.toString('utf8').trim();
      if (line) log.warn('agent', 'stderr', { line: line.slice(0, 200) });
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      // Mark the client dead so later request()/notify() reject fast instead of
      // writing into a broken pipe (and isAlive() reports the truth).
      this.hasExited = true;
      this.closed = true;
      this.failAllPending(new Error(`app-server exited (code=${code} signal=${signal})`));
      this.notifications.close();
    });
    child.on('error', (err) => this.failAllPending(err));

    await this.request('initialize', {
      clientInfo: { name: this.opts.clientName ?? 'feishu-codex-bridge', version: '0.0.1' },
      // experimentalApi opts into experimental JSON-RPC methods + fields — REQUIRED
      // for the goal RPCs (thread/goal/set|get|clear). Verified against codex 0.139:
      // without it, thread/goal/set is rejected. The `goals` feature itself is
      // stable+on by default there, so no experimentalFeature/enablement/set needed.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized');
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new Error('app-server client closed'));
    const id = ++this.nextId;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
  }

  /** async-iterate server notifications (closes when the process exits). */
  stream(): AsyncIterable<ServerNotification> {
    return this.notifications;
  }

  /** Drop buffered, un-consumed notifications. Used when a prewarmed pool client
   * is taken for a real session: notifications buffered while it idled in the
   * pool (MCP startup progress, the ephemeral warmup thread/started, …) belong
   * to the warmup thread and must never leak into the session's event stream. */
  clearNotifications(): void {
    this.notifications.clear();
  }

  async close(graceMs = 4000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;

    if (process.platform === 'win32' && child.pid) {
      // Windows has no POSIX signals, and child.kill() can't reap codex's
      // grandchildren (MCP / tool subprocesses) — they'd orphan. `taskkill /T`
      // terminates the whole process tree; wait for exit with graceMs fallback.
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(done, graceMs);
        child.once('exit', done);
        spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
          'error',
          () => {
            child.kill();
            done();
          },
        );
      });
      return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private onStdout(d: Buffer): void {
    this.buf += d.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn('agent', 'nonjson', { line: line.slice(0, 120) });
      return;
    }

    // response to one of our requests
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg)) && !('method' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg && msg.error) {
        const e = msg.error as { message?: string };
        p.reject(new JsonRpcError(e.message ?? 'JSON-RPC error'));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    // server-initiated request (e.g. approval). With approvalPolicy:never these
    // shouldn't arrive, but reply method-not-found so the server never blocks.
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.child?.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled' } })}\n`,
      );
      return;
    }

    // notification
    if (typeof msg.method === 'string') {
      this.notifications.push(msg as unknown as ServerNotification);
    }
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
