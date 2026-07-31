import type {
  BotRuntimeEvent,
  BotSpec,
} from '../kernel/start-bot.js';
import {
  BridgeRuntimeBotProcess,
  type BridgeRuntimeBotLauncher,
  type BridgeRuntimeBotLiveStatus,
  type ManagedBridgeRuntimeWorker,
  type RestartableRuntimeWorker,
} from './bot-process.js';
import type { BridgeRuntimeAdminOp } from './worker-protocol.js';
import type {
  BridgeRuntimeHost,
  RunningBridgeRuntime,
  RuntimeWorker,
} from './types.js';

export interface BridgeRuntimeWorkerFactoryInput {
  spec: BotSpec;
  launcher: BridgeRuntimeBotLauncher;
  resolveAppSecret(): Promise<string | undefined>;
  onRuntimeEvent(event: BotRuntimeEvent): void;
}

export interface BridgeRuntimeCompositionOptions {
  /** Test/advanced embedding seam; normal hosts use the built-in process worker. */
  createWorker?(input: BridgeRuntimeWorkerFactoryInput): RuntimeWorker;
}

export class BridgeRuntimeNotConfiguredError extends Error {
  readonly code = 'RUNTIME_NOT_CONFIGURED';

  constructor(message: string) {
    super(message);
    this.name = 'BridgeRuntimeNotConfiguredError';
  }
}

/**
 * Starts the complete public Bridge Runtime for every configured robot.
 *
 * The host supplies only changing external capabilities. Runtime supervision,
 * readiness, credential refresh, restart policy, and administrative routing
 * remain behind this interface.
 */
export async function startBridgeRuntime(
  host: BridgeRuntimeHost,
): Promise<RunningBridgeRuntime> {
  const group = await prepareBridgeRuntime(host);
  await group.start();
  return group;
}

/**
 * Composes the complete Runtime without starting its robot workers.
 *
 * Desktop lifecycle controllers use this seam to perform their own
 * pre-start ownership checks while still sharing the public supervisor.
 */
export async function prepareBridgeRuntime(
  host: BridgeRuntimeHost,
  options: BridgeRuntimeCompositionOptions = {},
): Promise<BridgeRuntimeWorkerGroup> {
  const botSpecs = [...await host.loadBotSpecs()];
  if (botSpecs.length === 0) {
    throw new BridgeRuntimeNotConfiguredError('请先添加并启用至少一个机器人。');
  }
  assertUniqueAppIds(botSpecs);

  const launcher = host.createBotLauncher();
  const workers: RuntimeWorker[] = [];
  const appIds: string[] = [];
  let group: BridgeRuntimeWorkerGroup | undefined;

  const publish = (event: BotRuntimeEvent): void => {
    try {
      host.onRuntimeEvent?.(event);
    } catch {
      // Runtime observation cannot terminate a robot.
    }
    if (event.type !== 'restart-requested') return;
    void group?.restart().catch((cause) => {
      const message = `全组重启失败：${errorMessage(cause)}`;
      for (const appId of appIds) {
        safePublish(host, {
          type: 'status',
          appId,
          status: { connection: 'disconnected', lastError: message },
          at: Date.now(),
        });
      }
    });
  };

  for (const configured of botSpecs) {
    let appSecret: string | undefined;
    try {
      appSecret = await host.resolveAppSecret(
        configured.accountSecretRef,
        configured.appId,
      );
    } catch (cause) {
      publishConfigurationFailure(
        host,
        configured.appId,
        `凭据无法读取：${errorMessage(cause)}`,
      );
      continue;
    }
    if (!appSecret) {
      publishConfigurationFailure(
        host,
        configured.appId,
        '凭据缺失，请重新添加或刷新应用凭据。',
      );
      continue;
    }

    const spec: BotSpec = { ...configured, appSecret };
    let initialSecret: string | undefined = appSecret;
    const resolveAppSecret = async (): Promise<string | undefined> => {
        if (initialSecret !== undefined) {
          const value = initialSecret;
          initialSecret = undefined;
          return value;
        }
        return await host.resolveAppSecret(
          configured.accountSecretRef,
          configured.appId,
        );
      };
    const worker = options.createWorker?.({
      spec,
      launcher,
      resolveAppSecret,
      onRuntimeEvent: publish,
    }) ?? new BridgeRuntimeBotProcess({
      spec,
      launcher,
      onRuntimeEvent: publish,
      resolveAppSecret,
    });
    workers.push(worker);
    appIds.push(configured.appId);
  }

  if (workers.length === 0) {
    throw new BridgeRuntimeNotConfiguredError(
      '所有已启用机器人的凭据都不可用，请重新添加或刷新应用凭据。',
    );
  }

  group = new BridgeRuntimeWorkerGroup(workers, appIds);
  return group;
}

export class BridgeRuntimeWorkerGroup implements RunningBridgeRuntime {
  readonly #workers: readonly RuntimeWorker[];
  readonly #workersByAppId: ReadonlyMap<string, RuntimeWorker>;
  #started: RuntimeWorker[] = [];
  #running = false;
  #restartOperation: Promise<void> | undefined;

  constructor(
    workers: readonly RuntimeWorker[],
    appIds: readonly string[] = [],
  ) {
    this.#workers = workers;
    this.#workersByAppId = new Map(
      workers.flatMap((worker, index) => {
        const appId = appIds[index];
        return appId === undefined ? [] : [[appId, worker] as const];
      }),
    );
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#started.length > 0) {
      throw new Error('Bridge Runtime robot cleanup is still pending.');
    }
    const results = await Promise.allSettled(
      this.#workers.map((worker) => worker.start()),
    );
    this.#started = [...this.#workers];
    const readiness = this.#workers.map((worker, index) => {
      if (isReadyRuntimeWorker(worker)) return worker.waitUntilReady();
      const result = results[index]!;
      return result.status === 'fulfilled'
        ? Promise.resolve()
        : Promise.reject(result.reason);
    });
    try {
      await Promise.any(readiness);
    } catch (cause) {
      const failures = cause instanceof AggregateError
        ? [...cause.errors]
        : [cause];
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [...failures, cleanupError],
          '所有机器人都未能连接飞书，且部分子进程未能回滚。',
        );
      }
      throw new AggregateError(failures, '所有机器人都未能连接飞书。');
    }
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    const workers = [...this.#started].reverse();
    const results = await Promise.allSettled(
      workers.map((worker) => worker.stop()),
    );
    const failedWorkers = new Set<RuntimeWorker>();
    const failures: unknown[] = [];
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      failedWorkers.add(workers[index]!);
      failures.push(result.reason);
    });
    this.#started = this.#started.filter((worker) => failedWorkers.has(worker));
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        '一个或多个机器人子进程未能干净停止。',
      );
    }
  }

  restart(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    this.#restartOperation ??= this.#restartAll().finally(() => {
      this.#restartOperation = undefined;
    });
    return this.#restartOperation;
  }

  executeAdmin(appId: string, operation: BridgeRuntimeAdminOp): Promise<void> {
    const worker = this.#workersByAppId.get(appId);
    if (!worker) {
      return Promise.reject(new Error(`机器人 ${appId} 当前未由 Bridge Runtime 托管。`));
    }
    if (!isManagedRuntimeWorker(worker)) {
      return Promise.reject(new Error(`机器人 ${appId} 当前不支持管理写操作。`));
    }
    return worker.executeAdmin(operation);
  }

  status(appId: string): BridgeRuntimeBotLiveStatus | undefined {
    const worker = this.#workersByAppId.get(appId);
    if (!worker || !isManagedRuntimeWorker(worker)) return undefined;
    return worker.liveStatus();
  }

  async #restartAll(): Promise<void> {
    const workers = this.#started.filter(isRestartableRuntimeWorker);
    const results = await Promise.allSettled(
      workers.map((worker) => worker.restart()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, '一个或多个机器人未能完成全组重启。');
    }
  }
}

function isRestartableRuntimeWorker(
  worker: RuntimeWorker,
): worker is RestartableRuntimeWorker {
  return 'restart' in worker
    && typeof (worker as Partial<RestartableRuntimeWorker>).restart === 'function';
}

function isReadyRuntimeWorker(
  worker: RuntimeWorker,
): worker is RuntimeWorker & Pick<RestartableRuntimeWorker, 'waitUntilReady'> {
  return 'waitUntilReady' in worker
    && typeof (worker as Partial<RestartableRuntimeWorker>).waitUntilReady === 'function';
}

function isManagedRuntimeWorker(
  worker: RuntimeWorker,
): worker is ManagedBridgeRuntimeWorker {
  const candidate = worker as Partial<ManagedBridgeRuntimeWorker>;
  return typeof candidate.executeAdmin === 'function'
    && typeof candidate.liveStatus === 'function'
    && typeof candidate.restart === 'function'
    && typeof candidate.waitUntilReady === 'function';
}

function assertUniqueAppIds(
  specs: readonly Pick<BotSpec, 'appId'>[],
): void {
  const appIds = new Set<string>();
  for (const spec of specs) {
    if (appIds.has(spec.appId)) {
      throw new BridgeRuntimeNotConfiguredError(
        `机器人 ${spec.appId} 被重复配置。`,
      );
    }
    appIds.add(spec.appId);
  }
}

function publishConfigurationFailure(
  host: BridgeRuntimeHost,
  appId: string,
  message: string,
): void {
  safePublish(host, {
    type: 'status',
    appId,
    status: { connection: 'disconnected', lastError: message },
    at: Date.now(),
  });
}

function safePublish(
  host: BridgeRuntimeHost,
  event: BotRuntimeEvent,
): void {
  try {
    host.onRuntimeEvent?.(event);
  } catch {
    // Diagnostics must not prevent healthy robots from starting.
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
