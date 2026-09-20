import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  mode: 'full' as 'full' | 'qa',
  transcribe: vi.fn(),
  backend: { id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  final: vi.fn(async () => true),
  createCard: vi.fn(async () => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/bot/voice', async original => ({ ...await original<object>(), transcribeVoice: fake.transcribe }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', kind: 'single', mode: fake.mode }),
  getProjectByName: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', kind: 'single', mode: fake.mode }),
  updateProject: async (_name: string, patch: { mode?: 'full' | 'qa' }) => { if (patch.mode) fake.mode = patch.mode; },
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '' }),
  listSessions: async () => [],
  patchSession: async () => undefined,
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} },
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = fake.createCard;
    streamCoalesced() {}
    async drain() {}
    updateCard = fake.final;
    finalizeCard = fake.final;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function thread() {
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const id = `turn-${turns.push(end)}`;
      return {
        turnId: () => id, // deliberately keep backend ID stale during final-card I/O
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: id };
          await end.promise;
          yield { type: 'done', turnId: id };
        })(),
      };
    },
  };
  return { t, turns, consumed };
}
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup(policy: 'steer' | 'queue' = 'steer') {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: policy, access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.mode = 'full';
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => { await orchestrator?.shutdown(); });
const until = (check: () => void) => vi.waitFor(check);


const voice = () => ({ ...message('<audio key="file-1"/>'), rawContentType: 'audio', resources: [{ type: 'audio', fileKey: 'file-1' }] }) as NormalizedMessage;
describe('voice queue integration', () => {
  it('queues transcribed voice under steer policy, retaining sender and prefix', async () => {
    fake.transcribe.mockResolvedValue('语音消息：检查报表');
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('steer'); await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(voice());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    expect(run.t.steer).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('语音消息：检查报表');
    expect(run.consumed[1]!.text).toContain('owner');
    expect(run.consumed[1]!.text).not.toContain('<audio');
  });
  it('holds later text behind slow voice preparation without blocking onMessage', async () => {
    const pending = deferred<string>(); fake.transcribe.mockReturnValue(pending.promise);
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('steer'); await o.onMessage(voice()); await o.onMessage(message('later'));
    await until(() => expect(fake.transcribe).toHaveBeenCalled());
    expect(run.consumed).toHaveLength(0);
    pending.resolve('语音消息：先做这个');
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('语音消息：先做这个');
    expect(run.t.steer).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('later');
  });
  it('reports ASR failure and continues with the next message', async () => {
    fake.transcribe.mockRejectedValue(new Error('ASR unavailable'));
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(voice()); await o.onMessage(message('later'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('later');
    expect(fake.send.mock.calls.some(call => JSON.stringify(call).includes('本条语音未提交给模型'))).toBe(true);
  });
  it('deduplicates the incoming message before requesting ASR', async () => {
    fake.transcribe.mockResolvedValue('语音消息：只执行一次');
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); const msg = voice(); await o.onMessage(msg); await o.onMessage(msg);
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(fake.transcribe).toHaveBeenCalledTimes(1);
  });
  it('never resurrects a voice message after shutdown', async () => {
    const pending = deferred<string>(); fake.transcribe.mockReturnValue(pending.promise);
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(voice());
    await until(() => expect(fake.transcribe).toHaveBeenCalled());
    await o.shutdown(); pending.resolve('语音消息：迟到结果');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(run.consumed).toHaveLength(0);
  });
});

describe('voice preparation lifecycle', () => {
  it('rejects a stale permission snapshot even if the registry changes outside eviction', async () => {
    const pending = deferred<string>(); fake.transcribe.mockReturnValue(pending.promise);
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(voice());
    await until(() => expect(fake.transcribe).toHaveBeenCalled());
    fake.mode = 'qa';
    pending.resolve('语音消息：旧权限命令');
    await until(() => expect(fake.send.mock.calls.some(call => JSON.stringify(call).includes('项目权限或会话设置已变更'))).toBe(true));
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    expect(run.consumed).toHaveLength(0);
    await o.onMessage(message('new request'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(fake.backend.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ mode: 'qa' }));
  });

  it('permission eviction cancels unloaded preparation lanes and their later text', async () => {
    const pending = deferred<string>(); fake.transcribe.mockReturnValue(pending.promise);
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(voice()); await o.onMessage(message('old later text'));
    await until(() => expect(fake.transcribe).toHaveBeenCalled());
    await o.adminExecute({ kind: 'setPermissionMode', project: 'test', mode: 'qa' });
    expect(fake.transcribe.mock.calls[0]![2].aborted).toBe(true);
    pending.resolve('语音消息：旧权限命令');
    await o.onMessage(message('new request'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('new request');
    expect(fake.backend.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ mode: 'qa' }));
    expect(fake.log.info.mock.calls.some(call => call[1] === 'queued')).toBe(false);
  });

  it('clear aborts pending ASR and old text before binding a replacement session', async () => {
    const pending = deferred<string>(); fake.transcribe.mockReturnValue(pending.promise);
    const fresh = thread(); fresh.t.sessionId = 'fresh'; fake.backend.startThread.mockResolvedValue(fresh.t);
    const o = setup(); await o.onMessage(voice()); await o.onMessage(message('old later text'));
    await until(() => expect(fake.transcribe).toHaveBeenCalled());
    await o.onMessage(message('/clear'));
    expect(fake.transcribe.mock.calls[0]![2].aborted).toBe(true);
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'clear', expect.anything()));
    pending.resolve('语音消息：清空前旧命令');
    await o.onMessage(message('new request'));
    await until(() => expect(fresh.consumed).toHaveLength(1));
    expect(fresh.consumed[0]!.text).toContain('new request');
    expect(fake.log.info.mock.calls.some(call => call[1] === 'queued')).toBe(false);
  });
});
