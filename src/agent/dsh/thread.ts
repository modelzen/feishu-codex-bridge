import { log } from '../../core/logger';
import type {
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  CompactResult,
  ReasoningEffort,
  TurnOptions,
} from '../types';
import { DshEventMapper, redactSensitive } from './event-map';
import { resolveDshModel, type DshRoute } from './models';
import type { DshNotification, DshSessionEventEnvelope } from './protocol';
import {
  DshJsonRpcTransport,
  DshProtocolError,
  type DshTransportOptions,
} from './transport';

const MAX_USER_ERROR = 2_000;

type TransportFactory = (options: DshTransportOptions) => DshJsonRpcTransport;

export interface DshThreadConfig {
  sessionId: string;
  cwd: string;
  model?: string;
  effort?: ReasoningEffort;
  command: string;
  args: readonly string[];
  profileFile: string;
  sessionsDir: string;
  runtimeEnv?: NodeJS.ProcessEnv;
  systemPrompt: string;
  transportFactory?: TransportFactory;
}

interface RuntimeSelection {
  modelId: string;
  effort: ReasoningEffort;
  dshEffort: 'off' | 'low' | 'high' | 'max';
  route: DshRoute;
  signature: string;
}

interface EventWaiter<T> {
  resolve(result: IteratorResult<T>): void;
}

/** Single-consumer buffer so inference starts before the Feishu run card exists. */
class EventQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: EventWaiter<T>[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push({ resolve }));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

/** One persistent DSH session backed by one warm JSON-RPC process at a time. */
export class DshThread implements AgentThread {
  readonly sessionId: string;
  private readonly cwd: string;
  private model: string | undefined;
  private effort: ReasoningEffort | undefined;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly profileFile: string;
  private readonly sessionsDir: string;
  private readonly runtimeEnv: NodeJS.ProcessEnv;
  private readonly systemPrompt: string;
  private readonly transportFactory: TransportFactory;
  private transport?: DshJsonRpcTransport;
  private runtimeSignature?: string;
  private runActive = false;
  private interruptRequested = false;
  private dead = false;
  private lastActivityAt = Date.now();

  constructor(config: DshThreadConfig) {
    this.sessionId = config.sessionId;
    this.cwd = config.cwd;
    this.model = config.model;
    this.effort = config.effort;
    this.command = config.command;
    this.args = config.args;
    this.profileFile = config.profileFile;
    this.sessionsDir = config.sessionsDir;
    this.runtimeEnv = config.runtimeEnv ?? {};
    this.systemPrompt = config.systemPrompt;
    this.transportFactory = config.transportFactory ?? DshJsonRpcTransport.spawn;
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    if (!this.isAlive()) {
      this.dead = true;
      throw new Error('DSH 会话进程已结束，请在下一条消息中恢复会话');
    }
    if ((input.images?.length ?? 0) > 0) {
      throw new Error('DSH 后端当前不支持图片输入；未发送本轮内容');
    }
    if (this.runActive) throw new Error('DSH 会话已有一轮正在运行，请等待本轮结束');

    const selected = this.selection(turn);
    const queue = new EventQueue<AgentEvent>();
    const runState: { turnId?: string } = {};
    this.runActive = true;
    this.interruptRequested = false;
    this.lastActivityAt = Date.now();

    const emit = (event: AgentEvent): void => {
      if (event.type === 'turn_started') runState.turnId = event.turnId;
      queue.push(event);
    };

    // Start now, not on the first iterator read: model startup overlaps Feishu
    // card creation and every early notification is buffered in `queue`.
    void this.executeTurn(input.text ?? '', selected, emit)
      .catch(async (error: unknown) => {
        if (this.interruptRequested) {
          emit({
            type: 'done',
            turnId: runState.turnId ?? `dsh:${this.sessionId}:interrupted`,
          });
          return;
        }
        this.dead = true;
        const message = safeErrorMessage(error);
        log.info('agent', 'dsh-run-failed', { message });
        await this.terminateRuntime();
        emit({ type: 'error', message, willRetry: false });
      })
      .finally(() => queue.close());

    const self = this;
    async function* events(): AsyncGenerator<AgentEvent> {
      try {
        for await (const event of queue) yield event;
      } finally {
        self.runActive = false;
      }
    }

    return {
      events: events(),
      turnId: () => runState.turnId,
      lastActivity: () => self.transport?.lastActivity() ?? self.lastActivityAt,
    };
  }

  runGoal(): AgentRun {
    throw unsupported('goal');
  }

  async clearGoal(): Promise<void> {
    throw unsupported('goal');
  }

  async steer(): Promise<void> {
    throw unsupported('steer');
  }

  async compact(): Promise<CompactResult> {
    throw unsupported('compact');
  }

  async abort(_turnId: string): Promise<void> {
    this.interruptRequested = true;
    this.dead = true;
    await this.terminateRuntime();
  }

  isAlive(): boolean {
    return !this.dead && (!this.transport || this.transport.isAlive());
  }

  async close(): Promise<void> {
    if (this.dead && !this.transport) return;
    this.dead = true;
    const transport = this.transport;
    this.transport = undefined;
    this.runtimeSignature = undefined;
    if (transport) await transport.close();
  }

  private selection(turn?: TurnOptions): RuntimeSelection {
    const resolved = resolveDshModel(turn?.model ?? this.model, turn?.effort ?? this.effort);
    return {
      modelId: resolved.info.id,
      effort: resolved.effort,
      dshEffort: resolved.dshEffort,
      route: resolved.route,
      signature: `${resolved.info.id}\0${resolved.dshEffort}`,
    };
  }

  private async ensureRuntime(selected: RuntimeSelection): Promise<DshJsonRpcTransport> {
    if (this.transport) {
      if (!this.transport.isAlive()) throw new DshProtocolError('DSH 子进程已退出');
      if (this.runtimeSignature === selected.signature) return this.transport;

      const previous = this.transport;
      this.transport = undefined;
      this.runtimeSignature = undefined;
      await previous.close();
    }

    const transport = this.transportFactory({
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      env: {
        ...this.runtimeEnv,
        FEISHU_CODEX_BRIDGE: '1',
        DSH_CORDIS_CONFIG: this.profileFile,
        DSH_CWD: this.cwd,
        DSH_SESSION_ROOT: this.sessionsDir,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TOOLS_MODE: 'native',
        DSH_TELEMETRY_DISABLED: '1',
        FEISHU_CODEX_BRIDGE_DSH_EFFORT: selected.dshEffort,
        DSH_SYSTEM_PROMPT: this.systemPrompt,
      },
    });
    this.transport = transport;
    try {
      const initialized = await transport.request<unknown>('initialize', {
        cwd: this.cwd,
        provider: selected.route.provider,
        model: selected.route.model,
      });
      if (!isInitializeResult(initialized)) {
        throw new DshProtocolError('DSH initialize 返回了无效的 serverInfo');
      }
      this.model = selected.modelId;
      this.effort = selected.effort;
      this.runtimeSignature = selected.signature;
      return transport;
    } catch (error) {
      if (this.transport === transport) this.transport = undefined;
      await transport.terminate();
      throw error;
    }
  }

  private async executeTurn(
    text: string,
    selected: RuntimeSelection,
    emit: (event: AgentEvent) => void,
  ): Promise<void> {
    const transport = await this.ensureRuntime(selected);
    const mapper = new DshEventMapper(this.sessionId);
    const iterator = transport.notifications()[Symbol.asyncIterator]();
    let activeTurnId: string | undefined;
    let turnEnded = false;
    let idle = false;
    let promptDone = false;

    type PromptResult =
      | { kind: 'prompt-ok'; value: unknown }
      | { kind: 'prompt-error'; error: unknown };
    type NotificationResult =
      | { kind: 'notification'; value: IteratorResult<DshNotification> }
      | { kind: 'notification-error'; error: unknown };

    const promptResult: Promise<PromptResult> = transport
      .request<unknown>('session/prompt', {
        sessionId: this.sessionId,
        contentBlocks: [{ type: 'text', text }],
      })
      .then<PromptResult, PromptResult>(
        (value) => ({ kind: 'prompt-ok', value }),
        (error: unknown) => ({ kind: 'prompt-error', error }),
      );

    const readNotification = (): Promise<NotificationResult> =>
      iterator.next().then<NotificationResult, NotificationResult>(
        (value) => ({ kind: 'notification', value }),
        (error: unknown) => ({ kind: 'notification-error', error }),
      );
    let notificationResult = readNotification();

    const acceptPrompt = (result: PromptResult): void => {
      if (result.kind === 'prompt-error') throw result.error;
      if (!isPromptResult(result.value)) {
        throw new DshProtocolError('DSH session/prompt 返回了无效的 messageId');
      }
      promptDone = true;
    };

    try {
      while (true) {
        const next = await Promise.race(
          promptDone ? [notificationResult] : [notificationResult, promptResult],
        );
        if (next.kind === 'prompt-ok' || next.kind === 'prompt-error') {
          acceptPrompt(next);
          if (turnEnded && idle) return;
          continue;
        }
        if (next.kind === 'notification-error') throw next.error;
        if (next.value.done) {
          throw new DshProtocolError('DSH 通知流在本轮完成前关闭');
        }

        this.lastActivityAt = Date.now();
        const notification = next.value.value;
        if (notification.params.sessionId === this.sessionId) {
          if (notification.method === 'session.status') {
            if (notification.params.status === 'idle') idle = true;
          } else if (notification.method === 'session.event') {
            const envelope = asSessionEvent(notification.params.event);
            if (envelope) {
              for (const event of mapper.map(envelope)) {
                if (event.type === 'turn_started') {
                  if (activeTurnId && activeTurnId !== event.turnId) continue;
                  activeTurnId ??= event.turnId;
                } else if (!activeTurnId) {
                  // A cold-loaded interrupted turn may be replayed before the new
                  // prompt's turn/start. It belongs to persistence recovery, not
                  // to the Feishu turn being rendered now.
                  continue;
                }
                if (event.type === 'done' && event.turnId !== activeTurnId) continue;
                emit(event);
                if (event.type === 'done') turnEnded = true;
              }
            }
          }
        }

        if (turnEnded && idle) {
          if (!promptDone) acceptPrompt(await promptResult);
          return;
        }
        notificationResult = readNotification();
      }
    } catch (error) {
      if (this.transport === transport) {
        this.transport = undefined;
        this.runtimeSignature = undefined;
      }
      await transport.terminate();
      throw error;
    }
  }

  private async terminateRuntime(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.runtimeSignature = undefined;
    if (transport) await transport.terminate();
  }
}

function unsupported(name: string): Error {
  return new Error(`DSH 后端暂不支持 ${name}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInitializeResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.serverInfo) &&
    value.serverInfo.name === 'deepseek-harness-sdk-runtime' &&
    typeof value.serverInfo.version === 'string'
  );
}

function isPromptResult(value: unknown): boolean {
  return isRecord(value) && typeof value.messageId === 'string' && value.messageId.length > 0;
}

function asSessionEvent(value: unknown): DshSessionEventEnvelope | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  return value as unknown as DshSessionEventEnvelope;
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = redactSensitive(raw.trim()) || 'DSH 运行失败';
  return safe.length > MAX_USER_ERROR ? `${safe.slice(0, MAX_USER_ERROR)}…` : safe;
}
