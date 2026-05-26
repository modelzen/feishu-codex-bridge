import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

export interface AppServerClientOptions {
  bin: string;
  cwd: string;
  env?: Record<string, string>;
  clientName?: string;
}

/**
 * One `codex app-server --listen stdio://` child process, speaking JSON-RPC 2.0
 * over newline-delimited JSON. One client = one thread/session (per design:
 * a process per session for crash isolation).
 */
export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new AsyncQueue<ServerNotification>();
  private closed = false;

  constructor(private readonly opts: AppServerClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** spawn + initialize handshake. Throws if spawn/handshake fails. */
  async connect(): Promise<void> {
    const child = spawn(this.opts.bin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env, FEISHU_CODEX_BRIDGE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    log.info('agent', 'spawn', { pid: child.pid ?? null, cwd: this.opts.cwd });

    child.stdout.on('data', (d: Buffer) => this.onStdout(d));
    child.stderr.on('data', (d: Buffer) => {
      const line = d.toString('utf8').trim();
      if (line) log.warn('agent', 'stderr', { line: line.slice(0, 200) });
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
      this.failAllPending(new Error(`app-server exited (code=${code} signal=${signal})`));
      this.notifications.close();
    });
    child.on('error', (err) => this.failAllPending(err));

    await this.request('initialize', {
      clientInfo: { name: this.opts.clientName ?? 'feishu-codex-bridge', version: '0.0.1' },
      capabilities: null,
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

  async close(graceMs = 4000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
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
        p.reject(new Error(e.message ?? 'JSON-RPC error'));
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
