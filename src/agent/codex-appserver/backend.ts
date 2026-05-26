import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentEvent,
  AgentInput,
  AgentRun,
  AgentThread,
  ModelInfo,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
} from '../types';
import { AppServerClient } from './app-server-client';
import { mapNotification } from './event-map';
import { codexVersion, resolveCodexBin } from './locate';

const APPROVAL_POLICY = 'never';
const SANDBOX = 'danger-full-access';

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
    private readonly model: string | undefined,
    private readonly effort: ReasoningEffort | undefined,
  ) {}

  runStreamed(input: AgentInput): AgentRun {
    const self = this;
    this.currentTurnId = undefined;
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
