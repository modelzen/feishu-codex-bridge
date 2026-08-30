import type { ChildProcess } from 'node:child_process';
import { killProcessGroup, mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import type { DshNotification, DshRequestMethod } from './protocol';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;

type KillGroup = (
  pid: number | undefined,
  hasExited: () => boolean,
) => Promise<void>;

export interface DshTransportOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxLineBytes?: number;
  maxStderrBytes?: number;
  killGroup?: KillGroup;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface QueueWaiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private ended = false;
  private failure?: Error;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export class DshProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshProtocolError';
  }
}

export class DshRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'DshRpcError';
  }
}

export class DshProcessExitError extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(`DSH 进程意外退出（code ${code ?? 'null'}${signal ? `，signal ${signal}` : ''}）`);
    this.name = 'DshProcessExitError';
  }
}

export class DshJsonRpcTransport {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationQueue = new AsyncQueue<DshNotification>();
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxStderrBytes: number;
  private readonly killGroup: KillGroup;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private stdoutBuffer = '';
  private stderrBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private activityAt = Date.now();
  private fatalError?: Error;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private terminatePromise?: Promise<void>;

  static spawn(options: DshTransportOptions): DshJsonRpcTransport {
    const child = spawnProcess(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: mergeProcessEnv(process.env, options.env ?? {}),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new DshJsonRpcTransport(child, options);
  }

  private constructor(
    private readonly child: ChildProcess,
    options: DshTransportOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.killGroup = options.killGroup ?? killProcessGroup;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      void this.killGroup(child.pid, () => child.exitCode !== null || child.signalCode !== null);
      throw new DshProtocolError('DSH 子进程没有完整的 stdio 管道');
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stdout.on('error', (error) => this.fail(new DshProtocolError(`DSH stdout 读取失败：${error.message}`)));
    child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.stderr.on('error', (error) => {
      if (!this.closing) this.fail(new DshProtocolError(`DSH stderr 读取失败：${error.message}`));
    });
    child.stdin.on('error', (error) => {
      if (!this.closing) this.fail(new DshProtocolError(`DSH stdin 写入失败：${error.message}`));
    });
    child.on('error', (error) => this.fail(new DshProtocolError(`DSH 进程启动失败：${error.message}`)));
    child.on('close', (code, signal) => this.onClose(code, signal));
  }

  request<T = unknown>(
    method: DshRequestMethod,
    params?: unknown,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<T> {
    return this.sendRequest<T>(method, params, timeoutMs, false);
  }

  notifications(): AsyncIterable<DshNotification> {
    return this.notificationQueue;
  }

  lastActivity(): number {
    return this.activityAt;
  }

  stderrTail(): string {
    return redactSensitive(this.stderrBuffer.toString('utf8'));
  }

  isAlive(): boolean {
    return !this.fatalError && !this.closing && this.processRunning();
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeGracefully();
    return this.closePromise;
  }

  terminate(): Promise<void> {
    if (this.terminatePromise) return this.terminatePromise;
    this.terminatePromise = this.forceTerminate();
    return this.terminatePromise;
  }

  private async closeGracefully(): Promise<void> {
    if (!this.processRunning()) return;
    this.closing = true;
    try {
      await this.sendRequest('shutdown', undefined, this.shutdownTimeoutMs, true);
      await Promise.race([this.exitPromise, delay(this.shutdownTimeoutMs)]);
    } catch {
      /* forced cleanup below */
    }
    if (this.processRunning()) await this.terminate();
  }

  private async forceTerminate(): Promise<void> {
    this.closing = true;
    if (!this.processRunning()) return;
    await this.killGroup(this.child.pid, () => this.child.exitCode !== null || this.child.signalCode !== null);
    await Promise.race([this.exitPromise, delay(1_000)]);
    if (this.processRunning()) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await Promise.race([this.exitPromise, delay(1_000)]);
    }
  }

  private sendRequest<T>(
    method: DshRequestMethod,
    params: unknown,
    timeoutMs: number,
    allowClosing: boolean,
  ): Promise<T> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.processRunning() || (this.closing && !allowClosing)) {
      return Promise.reject(new DshProtocolError('DSH transport 已关闭'));
    }
    const stdin = this.child.stdin;
    if (!stdin) return Promise.reject(new DshProtocolError('DSH stdin 不可用'));

    const id = this.nextRequestId++;
    const frame = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DshProtocolError(`DSH JSON-RPC 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new DshProtocolError(`DSH stdin 写入失败：${error.message}`));
      });
    });
  }

  private onStdout(chunk: string): void {
    if (this.fatalError) return;
    this.activityAt = Date.now();
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxLineBytes && !this.stdoutBuffer.includes('\n')) {
      this.fail(new DshProtocolError(`DSH stdout 单帧超过 ${this.maxLineBytes} bytes`));
      return;
    }

    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.fail(new DshProtocolError(`DSH stdout 单帧超过 ${this.maxLineBytes} bytes`));
        return;
      }
      try {
        this.handleFrame(JSON.parse(line) as unknown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(new DshProtocolError(`DSH stdout 不是合法 JSON-RPC：${message}`));
        return;
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    this.activityAt = Date.now();
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, chunk]);
    if (this.stderrBuffer.length > this.maxStderrBytes) {
      this.stderrBuffer = this.stderrBuffer.subarray(this.stderrBuffer.length - this.maxStderrBytes);
    }
  }

  private handleFrame(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== '2.0') {
      throw new Error('缺少 jsonrpc=2.0');
    }

    if ('id' in value) {
      if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) throw new Error('响应 id 非整数');
      const pending = this.pending.get(value.id);
      if (!pending) throw new Error(`未知响应 id ${value.id}`);
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if ('error' in value) {
        const rpcError = value.error;
        if (!isRecord(rpcError) || typeof rpcError.code !== 'number' || typeof rpcError.message !== 'string') {
          pending.reject(new DshProtocolError('JSON-RPC error 结构无效'));
        } else {
          pending.reject(new DshRpcError(rpcError.code, rpcError.message, rpcError.data));
        }
        return;
      }
      if (!('result' in value)) {
        pending.reject(new DshProtocolError('JSON-RPC 响应缺少 result/error'));
        return;
      }
      pending.resolve(value.result);
      return;
    }

    if (typeof value.method !== 'string' || !isRecord(value.params)) {
      throw new Error('通知 method/params 结构无效');
    }
    this.notificationQueue.push({ method: value.method, params: value.params });
  }

  private fail(error: Error): void {
    if (this.fatalError || this.closed) return;
    this.fatalError = error;
    this.rejectPending(error);
    this.notificationQueue.close(error);
    void this.terminate();
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    const unexpected = !this.closing && !this.fatalError;
    if (unexpected) this.fatalError = new DshProcessExitError(code, signal);
    const pendingError = this.fatalError ?? new DshProcessExitError(code, signal);
    this.rejectPending(pendingError);
    this.closed = true;
    this.notificationQueue.close(this.fatalError);
    this.resolveExit();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private processRunning(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}
