import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  HistoryTool,
  HistoryTurn,
  ModelInfo,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
  TurnOptions,
} from '../types';
import { AppServerClient } from './app-server-client';
import { mapNotification } from './event-map';
import { codexVersion, resolveCodexBin } from './locate';
import type { Thread, ThreadItem, Turn } from './protocol';

const APPROVAL_POLICY = 'never';
const SANDBOX = 'danger-full-access';
/** Hard ceiling on a history read so a wedged codex can't hang the resume card. */
const READ_HISTORY_TIMEOUT_MS = 20_000;

/** Reject `p` if it hasn't settled within `ms` (the timer never keeps the event
 * loop alive past resolution). */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function toUserInput(input: AgentInput): unknown[] {
  const out: unknown[] = [];
  if (input.text) out.push({ type: 'text', text: input.text, text_elements: [] });
  for (const path of input.images ?? []) out.push({ type: 'localImage', path });
  return out;
}

class CodexThread implements AgentThread {
  private currentTurnId: string | undefined;

  constructor(
    private readonly client: AppServerClient,
    readonly codexThreadId: string,
    private model: string | undefined,
    private effort: ReasoningEffort | undefined,
  ) {}

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    const self = this;
    this.currentTurnId = undefined;
    // Per-turn overrides persist for subsequent turns (matches turn/start semantics).
    if (turn?.model) this.model = turn.model;
    if (turn?.effort) this.effort = turn.effort;
    async function* gen(): AsyncGenerator<AgentEvent> {
      // Fire turn/start; events arrive via notifications while it's in flight.
      const params: Record<string, unknown> = {
        threadId: self.codexThreadId,
        input: toUserInput(input),
      };
      if (self.model) params.model = self.model;
      if (self.effort) params.effort = self.effort;
      void self.client.request('turn/start', params).catch((err) => {
        log.fail('agent', err, { phase: 'turn/start' });
      });

      for await (const n of self.client.stream()) {
        const ev = mapNotification(n);
        if (!ev) continue;
        if (ev.type === 'turn_started') self.currentTurnId = ev.turnId;
        yield ev;
        if (ev.type === 'done') return;
        if (ev.type === 'error' && !ev.willRetry) return;
      }
    }
    return { events: gen(), turnId: () => self.currentTurnId };
  }

  async steer(input: AgentInput, expectedTurnId: string): Promise<void> {
    await this.client.request('turn/steer', {
      threadId: this.codexThreadId,
      expectedTurnId,
      input: toUserInput(input),
    });
  }

  async abort(turnId: string): Promise<void> {
    await this.client.request('turn/interrupt', { threadId: this.codexThreadId, turnId });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class CodexAppServerBackend implements AgentBackend {
  readonly id = 'codex-appserver';
  readonly displayName = 'Codex (app-server)';
  private modelCache: ModelInfo[] | null = null;

  async isAvailable(): Promise<boolean> {
    const bin = resolveCodexBin();
    return bin !== null && codexVersion(bin) !== null;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    const bin = resolveCodexBin();
    if (!bin) return STATIC_MODELS;
    const client = new AppServerClient({ bin, cwd: process.cwd(), clientName: 'feishu-codex-bridge-models' });
    try {
      await client.connect();
      const res = await client.request<{ data?: RawModel[] }>('model/list', { limit: 50 });
      const models = (res.data ?? []).map(mapModel);
      this.modelCache = models.length ? models : STATIC_MODELS;
      return this.modelCache;
    } catch (err) {
      log.fail('agent', err, { phase: 'model/list' });
      return STATIC_MODELS;
    } finally {
      await client.close();
    }
  }

  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    const bin = resolveCodexBin();
    if (!bin) return [];
    const client = new AppServerClient({ bin, cwd, clientName: 'feishu-codex-bridge-threads' });
    try {
      await client.connect();
      const res = await client.request<{ data?: RawThread[] }>('thread/list', {
        cwd,
        limit,
        sortKey: 'created_at',
        sortDirection: 'desc',
      });
      return (res.data ?? [])
        .filter((t) => !t.ephemeral)
        .map((t) => ({
          codexThreadId: t.id,
          preview: t.preview ?? '',
          createdAt: t.createdAt ?? 0,
          updatedAt: t.updatedAt ?? t.createdAt ?? 0,
          name: t.name ?? undefined,
        }));
    } catch (err) {
      log.fail('agent', err, { phase: 'thread/list' });
      return [];
    } finally {
      await client.close();
    }
  }

  async readHistory(cwd: string, codexThreadId: string, maxTurns = 10): Promise<ThreadHistory> {
    const empty: ThreadHistory = { turns: [], totalTurns: 0 };
    const bin = resolveCodexBin();
    if (!bin) return empty;
    // Short-lived client (same spawn→connect→request→close shape as listThreads).
    // thread/read does NOT start a turn or load the thread live — it just reads
    // the rollout, so there's no process to keep and no token cost. The session
    // is resumed lazily on the topic's first message via resolveThread.
    const client = new AppServerClient({ bin, cwd, clientName: 'feishu-codex-bridge-history' });
    try {
      // Bound the whole connect+read: if codex hangs, time out → catch → finally
      // close() (which SIGKILLs the child), so no orphan and the card resolves.
      const read = (async () => {
        await client.connect();
        return client.request<{ thread: Thread }>('thread/read', { threadId: codexThreadId, includeTurns: true });
      })();
      read.catch(() => undefined); // close() may reject this late; swallow it
      const res = await withDeadline(read, READ_HISTORY_TIMEOUT_MS, 'thread/read');
      const thread = res.thread;
      const all = (Array.isArray(thread?.turns) ? thread.turns : [])
        .map(mapTurn)
        .filter((t) => t.userText || t.assistantText || t.tools.length);
      const totalTurns = all.length;
      const turns = totalTurns > maxTurns ? all.slice(totalTurns - maxTurns) : all;
      return {
        turns,
        totalTurns,
        name: thread?.name ?? undefined,
        preview: thread?.preview ?? undefined,
        createdAt: thread?.createdAt,
        updatedAt: thread?.updatedAt,
      };
    } catch (err) {
      log.fail('agent', err, { phase: 'thread/read', codexThreadId });
      return empty;
    } finally {
      await client.close();
    }
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const client = await this.spawn(opts.cwd);
    const res = await client.request<{ thread: { id: string } }>('thread/start', {
      cwd: opts.cwd,
      approvalPolicy: APPROVAL_POLICY,
      sandbox: SANDBOX,
      ...(opts.model ? { model: opts.model } : {}),
    });
    return new CodexThread(client, res.thread.id, opts.model, opts.effort);
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const client = await this.spawn(opts.cwd);
    const res = await client.request<{ thread: { id: string } }>('thread/resume', {
      threadId: opts.codexThreadId,
      cwd: opts.cwd,
      approvalPolicy: APPROVAL_POLICY,
      sandbox: SANDBOX,
      ...(opts.model ? { model: opts.model } : {}),
    });
    return new CodexThread(client, res.thread.id, opts.model, opts.effort);
  }

  private async spawn(cwd: string): Promise<AppServerClient> {
    const bin = resolveCodexBin();
    if (!bin) throw new Error('codex CLI not found (set CODEX_BIN or install @openai/codex)');
    const client = new AppServerClient({ bin, cwd });
    await client.connect();
    return client;
  }
}

/** Skip codex's injected boilerplate so it never shows as a "user message". */
function isBoilerplateUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<environment_context>') || t.startsWith('# AGENTS.md instructions');
}

/**
 * Fold one codex {@link Turn}'s items into a renderable {@link HistoryTurn}.
 * Mirrors event-map.ts's item handling but also captures `userMessage` (the
 * stream path never emits the user's own input, so that case is unique here).
 */
function mapTurn(turn: Turn): HistoryTurn {
  const userParts: string[] = [];
  const assistantParts: string[] = [];
  const reasoningParts: string[] = [];
  const tools: HistoryTool[] = [];
  for (const item of (turn.items ?? []) as ThreadItem[]) {
    switch (item.type) {
      case 'userMessage': {
        const text = item.content
          .map((c) => (c.type === 'text' ? c.text : c.type === 'mention' ? `@${c.name}` : ''))
          .join('')
          .trim();
        if (text && !isBoilerplateUserText(text)) userParts.push(text);
        break;
      }
      case 'agentMessage':
        if (item.text.trim()) assistantParts.push(item.text);
        break;
      case 'reasoning': {
        const r = (item.content.length ? item.content : item.summary).join('\n').trim();
        if (r) reasoningParts.push(r);
        break;
      }
      case 'commandExecution':
        tools.push({
          title: item.command,
          output: item.aggregatedOutput ?? undefined,
          exitCode: item.exitCode,
          failed: item.status === 'failed' || item.status === 'declined' || (item.exitCode ?? 0) !== 0,
        });
        break;
      case 'fileChange':
        tools.push({ title: '编辑文件', failed: item.status === 'failed' || item.status === 'declined' });
        break;
      case 'webSearch':
        tools.push({ title: `联网搜索：${item.query}` });
        break;
      case 'mcpToolCall':
        tools.push({ title: `${item.server} / ${item.tool}`, failed: item.status === 'failed' || Boolean(item.error) });
        break;
      case 'dynamicToolCall':
        tools.push({ title: item.tool, failed: item.status === 'failed' || item.success === false });
        break;
      // plan / contextCompaction / review-mode / image* — omitted from the digest
      default:
        break;
    }
  }
  return {
    userText: userParts.join('\n\n'),
    assistantText: assistantParts.join('\n\n'),
    reasoning: reasoningParts.join('\n\n'),
    tools,
    startedAt: turn.startedAt ?? undefined,
  };
}

interface RawThread {
  id: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  name?: string | null;
  ephemeral?: boolean;
}

interface RawModel {
  id: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: ReasoningEffort }[];
  defaultReasoningEffort?: ReasoningEffort;
}

function mapModel(m: RawModel): ModelInfo {
  return {
    id: m.id,
    displayName: m.displayName ?? m.id,
    description: m.description ?? '',
    hidden: m.hidden ?? false,
    isDefault: m.isDefault ?? false,
    supportedEfforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
    defaultEffort: m.defaultReasoningEffort ?? 'medium',
  };
}

const STATIC_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: '默认模型',
    hidden: false,
    isDefault: true,
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];
