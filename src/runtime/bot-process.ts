import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  BotRuntimeEvent,
  BotSpec,
} from '../kernel/start-bot.js';
import {
  BRIDGE_RUNTIME_WORKER_ARG,
  isBridgeRuntimeChildMessage,
  type BridgeRuntimeAdminOp,
  type BridgeRuntimeChildMessage,
  type BridgeRuntimeParentMessage,
} from './worker-protocol.js';
import type { RuntimeWorker } from './types.js';

export interface BridgeRuntimeChildProcess {
  readonly connected: boolean;
  readonly pid?: number;
  send(
    message: BridgeRuntimeParentMessage,
    callback?: (error: Error | null) => void,
  ): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: 'message', listener: (message: unknown) => void): this;
}

export type BridgeRuntimeBotLauncher = () => BridgeRuntimeChildProcess;

export interface BridgeRuntimeInvocation {
  execPath: string;
  argv: readonly string[];
  packaged: boolean;
}

export interface BridgeRuntimeWorkerInvocation {
  command: string;
  args: string[];
}

export function resolveBridgeRuntimeWorkerInvocation(
  runtime: BridgeRuntimeInvocation = {
    execPath: process.execPath,
    argv: process.argv,
    packaged: Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg),
  },
): BridgeRuntimeWorkerInvocation {
  if (runtime.packaged) {
    return {
      command: runtime.execPath,
      args: [BRIDGE_RUNTIME_WORKER_ARG],
    };
  }
  const sidecarEntry = runtime.argv[1];
  if (!sidecarEntry) {
    throw new Error('Cannot resolve the development sidecar entry point.');
  }
  return {
    command: runtime.execPath,
    args: [sidecarEntry, BRIDGE_RUNTIME_WORKER_ARG],
  };
}

export interface CreateBridgeRuntimeBotLauncherOptions {
  runtime?: BridgeRuntimeInvocation;
  stdio?: SpawnOptions['stdio'];
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => BridgeRuntimeChildProcess;
}

/**
 * The launch command is deliberately identical for every robot. No app id,
 * secret, data path, or robot-derived environment variable crosses argv/env.
 */
export function createBridgeRuntimeBotLauncher(
  options: CreateBridgeRuntimeBotLauncherOptions = {},
): BridgeRuntimeBotLauncher {
  const runtime = options.runtime ?? {
    execPath: process.execPath,
    argv: process.argv,
    packaged: Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg),
  };
  const invocation = resolveBridgeRuntimeWorkerInvocation(runtime);
  const spawnProcess = options.spawnProcess
    ?? ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions) as ChildProcess as BridgeRuntimeChildProcess);
  return () => spawnProcess(invocation.command, invocation.args, {
    ...(runtime.packaged
      ? {
          // pkg patches child_process and otherwise sets this to execPath,
          // which makes the child treat --bridge-runtime-worker as a JS file.
          env: { ...process.env, PKG_EXECPATH: '' },
        }
      : {}),
    stdio: options.stdio ?? ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

export interface BridgeRuntimeScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_SCHEDULER: BridgeRuntimeScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface BridgeRuntimeBotProcessOptions {
  spec: BotSpec;
  /** Re-read protected credentials immediately before every child launch. */
  resolveAppSecret?: () => Promise<string | undefined>;
  launcher?: BridgeRuntimeBotLauncher;
  scheduler?: BridgeRuntimeScheduler;
  restartBaseMs?: number;
  restartMaxMs?: number;
  restartHealthyMs?: number;
  gracefulStopMs?: number;
  termStopMs?: number;
  adminTimeoutMs?: number;
  onRuntimeEvent?: (event: BotRuntimeEvent) => void;
}

export interface RestartableRuntimeWorker extends RuntimeWorker {
  restart(): Promise<void>;
  waitUntilReady(timeoutMs?: number): Promise<void>;
}

export interface BridgeRuntimeBotLiveStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  connection?: Extract<BotRuntimeEvent, { type: 'status' }>['status']['connection'];
}

export interface ManagedBridgeRuntimeWorker extends RestartableRuntimeWorker {
  executeAdmin(op: BridgeRuntimeAdminOp): Promise<void>;
  liveStatus(): BridgeRuntimeBotLiveStatus;
}

interface AdminRequest {
  resolve(): void;
  reject(error: Error): void;
  timeout: unknown;
}

interface InitialReadiness {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  settled: boolean;
  timeout: unknown;
}

export class BridgeRuntimeBotAdminError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'BridgeRuntimeBotAdminError';
    this.code = code;
  }
}

export class BridgeRuntimeBotProcess implements ManagedBridgeRuntimeWorker {
  readonly #spec: BotSpec;
  readonly #resolveAppSecret: (() => Promise<string | undefined>) | undefined;
  readonly #launcher: BridgeRuntimeBotLauncher;
  readonly #scheduler: BridgeRuntimeScheduler;
  readonly #restartBaseMs: number;
  readonly #restartMaxMs: number;
  readonly #restartHealthyMs: number;
  readonly #gracefulStopMs: number;
  readonly #termStopMs: number;
  readonly #adminTimeoutMs: number;
  readonly #onRuntimeEvent: ((event: BotRuntimeEvent) => void) | undefined;
  readonly #adminRequests = new Map<string, AdminRequest>();
  #child: BridgeRuntimeChildProcess | undefined;
  #restartTimer: unknown;
  #healthyTimer: unknown;
  #restartAttempt = 0;
  #desired = false;
  #stopping: Promise<void> | undefined;
  #childExitOperation:
    | { child: BridgeRuntimeChildProcess; promise: Promise<void> }
    | undefined;
  #generation = 0;
  #ready = false;
  #startedAt: number | undefined;
  #lastStatus: Extract<BotRuntimeEvent, { type: 'status' }>['status'] | undefined;
  #activeAppSecret: string;
  readonly #initialReadiness: InitialReadiness;

  constructor(options: BridgeRuntimeBotProcessOptions) {
    this.#spec = options.spec;
    this.#resolveAppSecret = options.resolveAppSecret;
    this.#activeAppSecret = options.spec.appSecret;
    this.#launcher = options.launcher ?? createBridgeRuntimeBotLauncher();
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.#restartBaseMs = positive(options.restartBaseMs, 500);
    this.#restartMaxMs = positive(options.restartMaxMs, 30_000);
    this.#restartHealthyMs = positive(options.restartHealthyMs, 60_000);
    this.#gracefulStopMs = positive(options.gracefulStopMs, 5_000);
    this.#termStopMs = positive(options.termStopMs, 2_000);
    this.#adminTimeoutMs = positive(options.adminTimeoutMs, 15_000);
    this.#onRuntimeEvent = options.onRuntimeEvent;
    this.#initialReadiness = createInitialReadiness(this.#scheduler);
  }

  start(): Promise<void> {
    if (this.#desired) return Promise.resolve();
    this.#stopping = undefined;
    this.#desired = true;
    return this.#launch(true);
  }

  async restart(): Promise<void> {
    if (!this.#desired) return;
    const child = this.#child;
    if (!child) return;
    await this.#requestChildExit(child);
  }

  waitUntilReady(timeoutMs = 45_000): Promise<void> {
    const readiness = this.#initialReadiness;
    if (!readiness.settled && readiness.timeout === undefined) {
      readiness.timeout = this.#scheduler.setTimeout(() => {
        readiness.reject(new Error('机器人连接飞书超时，未收到就绪状态。'));
      }, positive(timeoutMs, 45_000));
    }
    return readiness.promise;
  }

  liveStatus(): BridgeRuntimeBotLiveStatus {
    const child = this.#child;
    return {
      running: child !== undefined,
      ...(child?.pid === undefined ? {} : { pid: child.pid }),
      ...(this.#startedAt === undefined ? {} : { startedAt: this.#startedAt }),
      ...(this.#lastStatus?.connection === undefined
        ? (this.#desired ? { connection: 'connecting' as const } : {})
        : { connection: this.#lastStatus.connection }),
    };
  }

  async executeAdmin(op: BridgeRuntimeAdminOp): Promise<void> {
    const child = this.#child;
    if (!this.#desired || !this.#ready || !child?.connected) {
      throw new Error('Bridge Runtime worker is not connected.');
    }
    const requestId = randomUUID();
    const result = new Promise<void>((resolve, reject) => {
      const timeout = this.#scheduler.setTimeout(() => {
        this.#adminRequests.delete(requestId);
        reject(new Error('Bridge Runtime worker admin IPC timed out.'));
      }, this.#adminTimeoutMs);
      this.#adminRequests.set(requestId, { resolve, reject, timeout });
    });
    this.#send(child, { type: 'admin', requestId, op }, (error) => {
      if (!error) return;
      const request = this.#adminRequests.get(requestId);
      this.#adminRequests.delete(requestId);
      if (request) this.#scheduler.clearTimeout(request.timeout);
      request?.reject(new Error('Bridge Runtime worker admin IPC failed.'));
    });
    return result;
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    this.#desired = false;
    if (this.#restartTimer !== undefined) {
      this.#scheduler.clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    this.#clearHealthyTimer();
    this.#rejectAdminRequests('Bridge Runtime worker stopped.');
    const child = this.#child;
    if (!child) return;
    await this.#requestChildExit(child);
  }

  #requestChildExit(child: BridgeRuntimeChildProcess): Promise<void> {
    if (this.#childExitOperation?.child === child) {
      return this.#childExitOperation.promise;
    }
    let operation!: Promise<void>;
    operation = new Promise<void>((resolve, reject) => {
      let settled = false;
      let termTimer: unknown;
      let killTimer: unknown;
      let finishTimer: unknown;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (termTimer !== undefined) this.#scheduler.clearTimeout(termTimer);
        if (killTimer !== undefined) this.#scheduler.clearTimeout(killTimer);
        if (finishTimer !== undefined) this.#scheduler.clearTimeout(finishTimer);
        resolve();
      };
      child.once('exit', finish);
      if (child.connected) {
        this.#send(child, { type: 'stop' });
      } else {
        child.kill('SIGTERM');
      }
      termTimer = this.#scheduler.setTimeout(() => {
        child.kill('SIGTERM');
        killTimer = this.#scheduler.setTimeout(() => {
          child.kill('SIGKILL');
          finishTimer = this.#scheduler.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('机器人子进程在 SIGKILL 后仍未报告退出。'));
          }, this.#termStopMs);
        }, this.#termStopMs);
      }, this.#gracefulStopMs);
    });
    this.#childExitOperation = { child, promise: operation };
    const clearOperation = (): void => {
      if (this.#childExitOperation?.promise === operation) {
        this.#childExitOperation = undefined;
      }
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }

  async #launch(initial: boolean): Promise<void> {
    const generation = ++this.#generation;
    this.#ready = false;
    let appSecret = this.#spec.appSecret;
    if (this.#resolveAppSecret) {
      try {
        appSecret = await this.#resolveAppSecret() ?? '';
        if (!appSecret) throw new Error('empty credential');
      } catch {
        const error = new Error('机器人动态凭据当前无法安全解析。');
        this.#publishLocalFailure(error);
        if (initial) this.#initialReadiness.reject(error);
        this.#scheduleRestart();
        if (initial) throw error;
        return;
      }
    }
    if (!this.#desired || this.#generation !== generation) return;
    const launchSpec: BotSpec = { ...this.#spec, appSecret };
    this.#activeAppSecret = appSecret;
    let child: BridgeRuntimeChildProcess;
    try {
      child = this.#launcher();
    } catch (cause) {
      this.#publishLocalFailure(cause);
      if (initial) this.#initialReadiness.reject(asError(cause));
      if (initial) {
        this.#scheduleRestart();
        throw cause;
      }
      this.#scheduleRestart();
      return;
    }
    this.#child = child;

    return await new Promise<void>((resolve, reject) => {
      let spawned = false;
      let settled = false;
      const resolveSpawn = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const rejectSpawn = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      child.on('message', (message) => {
        if (this.#generation !== generation || !isBridgeRuntimeChildMessage(message)) return;
        this.#handleChildMessage(message);
      });
      child.once('spawn', () => {
        if (this.#generation !== generation) return;
        spawned = true;
        this.#startedAt = Date.now();
        this.#send(child, { type: 'bootstrap', spec: launchSpec }, (error) => {
          if (error) child.kill('SIGTERM');
        });
        resolveSpawn();
      });
      child.once('error', (error) => {
        if (this.#generation !== generation) return;
        if (!spawned) {
          this.#child = undefined;
          this.#publishLocalFailure(error);
          if (initial) this.#initialReadiness.reject(error);
          this.#scheduleRestart();
          if (initial) rejectSpawn(error);
          else resolveSpawn();
        }
      });
      child.once('exit', () => {
        if (this.#generation !== generation) return;
        this.#child = undefined;
        this.#startedAt = undefined;
        this.#ready = false;
        this.#clearHealthyTimer();
        this.#rejectAdminRequests('Bridge Runtime worker process exited.');
        if (!spawned) {
          const error = new Error('Bridge Runtime worker process failed before spawn.');
          this.#publishLocalFailure(error);
          if (initial) this.#initialReadiness.reject(error);
          this.#scheduleRestart();
          if (initial) rejectSpawn(error);
          else resolveSpawn();
          return;
        }
        resolveSpawn();
        if (initial && !this.#initialReadiness.settled) {
          this.#initialReadiness.reject(
            new Error('机器人进程在连接飞书前退出。'),
          );
        }
        if (this.#desired) {
          if (this.#lastStatus?.connection !== 'disconnected') {
            this.#publishStatus({
              connection: 'disconnected',
              lastError: '机器人进程意外退出，正在自动重试。',
            });
          }
          this.#scheduleRestart();
        }
      });
    });
  }

  #handleChildMessage(message: BridgeRuntimeChildMessage): void {
    if (message.type === 'ready') {
      this.#ready = true;
      this.#initialReadiness.resolve();
      this.#clearHealthyTimer();
      const generation = this.#generation;
      this.#healthyTimer = this.#scheduler.setTimeout(() => {
        this.#healthyTimer = undefined;
        if (this.#desired && this.#ready && this.#generation === generation) {
          this.#restartAttempt = 0;
        }
      }, this.#restartHealthyMs);
      return;
    }
    if (message.type === 'start-failed') {
      this.#ready = false;
      const failure = redactText(message.error, this.#activeAppSecret);
      this.#publishStatus({
        connection: 'disconnected',
        lastError: failure,
      });
      this.#initialReadiness.reject(new Error(failure));
      return;
    }
    if (message.type === 'runtime-event') {
      const event = redactRuntimeEvent(message.event, this.#activeAppSecret);
      if (event.type === 'status') {
        this.#lastStatus = { ...event.status };
      }
      try {
        this.#onRuntimeEvent?.(event);
      } catch {
        // Runtime observation cannot terminate a robot.
      }
      return;
    }
    if (message.type !== 'admin-result') return;
    const request = this.#adminRequests.get(message.requestId);
    if (!request) return;
    this.#adminRequests.delete(message.requestId);
    this.#scheduler.clearTimeout(request.timeout);
    if (message.error === undefined) request.resolve();
    else request.reject(new BridgeRuntimeBotAdminError(message.error.message, message.error.code));
  }

  #scheduleRestart(): void {
    if (!this.#desired || this.#restartTimer !== undefined) return;
    const delay = Math.min(
      this.#restartMaxMs,
      this.#restartBaseMs * (2 ** this.#restartAttempt),
    );
    this.#restartAttempt += 1;
    this.#restartTimer = this.#scheduler.setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#desired) return;
      void this.#launch(false);
    }, delay);
  }

  #send(
    child: BridgeRuntimeChildProcess,
    message: BridgeRuntimeParentMessage,
    onComplete?: (error: Error | null) => void,
  ): void {
    try {
      child.send(message, onComplete);
    } catch {
      onComplete?.(new Error('Bridge Runtime worker IPC send failed.'));
    }
  }

  #rejectAdminRequests(message: string): void {
    for (const request of this.#adminRequests.values()) {
      this.#scheduler.clearTimeout(request.timeout);
      request.reject(new Error(message));
    }
    this.#adminRequests.clear();
  }

  #clearHealthyTimer(): void {
    if (this.#healthyTimer === undefined) return;
    this.#scheduler.clearTimeout(this.#healthyTimer);
    this.#healthyTimer = undefined;
  }

  #publishLocalFailure(cause: unknown): void {
    this.#publishStatus({
      connection: 'disconnected',
      lastError: `无法创建机器人进程：${errorMessage(cause)}`,
    });
  }

  #publishStatus(
    status: Extract<BotRuntimeEvent, { type: 'status' }>['status'],
  ): void {
    this.#lastStatus = { ...status };
    try {
      this.#onRuntimeEvent?.({
        type: 'status',
        appId: this.#spec.appId,
        status: { ...status },
        at: Date.now(),
      });
    } catch {
      // Runtime observation cannot terminate a robot.
    }
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function redactRuntimeEvent(
  event: BotRuntimeEvent,
  appSecret: string,
): BotRuntimeEvent {
  if (
    event.type !== 'status'
    || !appSecret
    || (!event.status.lastError && !event.status.eventSubscriptionWarning)
  ) {
    return event;
  }
  return {
    ...event,
    status: {
      ...event.status,
      ...(event.status.lastError === undefined
        ? {}
        : { lastError: event.status.lastError.split(appSecret).join('[REDACTED]') }),
      ...(event.status.eventSubscriptionWarning === undefined
        ? {}
        : {
            eventSubscriptionWarning:
              event.status.eventSubscriptionWarning.split(appSecret).join('[REDACTED]'),
          }),
    },
  };
}

function redactText(value: string, appSecret: string): string {
  return appSecret ? value.split(appSecret).join('[REDACTED]') : value;
}

function createInitialReadiness(scheduler: BridgeRuntimeScheduler): InitialReadiness {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const readiness: InitialReadiness = {
    promise: Promise.resolve(),
    resolve() {
      if (readiness.settled) return;
      readiness.settled = true;
      if (readiness.timeout !== undefined) {
        scheduler.clearTimeout(readiness.timeout);
        readiness.timeout = undefined;
      }
      resolvePromise();
    },
    reject(error) {
      if (readiness.settled) return;
      readiness.settled = true;
      if (readiness.timeout !== undefined) {
        scheduler.clearTimeout(readiness.timeout);
        readiness.timeout = undefined;
      }
      rejectPromise(error);
    },
    settled: false,
    timeout: undefined,
  };
  readiness.promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Initial failures may arrive before the group asks for readiness.
  void readiness.promise.catch(() => undefined);
  return readiness;
}
