import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

vi.mock('../src/config/paths', async (original) => { const old = await original<typeof import('../src/config/paths')>(); return { ...old, paths: { ...old.paths, sessionsFile: `/tmp/feishu-intake-test-${process.pid}.json` } }; });
const fake = vi.hoisted(() => ({
  backend: { id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  final: vi.fn(async () => true),
  createCard: vi.fn(async () => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/bot/steer-delivery', async original => { const real = await original<typeof import('../src/bot/steer-delivery')>(); return { ...real, steerWithDeadline: (thread: any, input: any, id: string, signal?: AbortSignal) => real.steerWithDeadline(thread, input, id, signal, 100) }; });
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', groupMode: 'single' }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '' }),
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
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { contextBriefing: { enabled: true }, pendingPolicy: policy, access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => { await orchestrator?.shutdown(); await rm(`/tmp/feishu-intake-test-${process.pid}.json.context.json`, { force: true }); });
const until = (check: () => void) => vi.waitFor(check);


describe('conditional context intake', () => {
  it('cannot resurrect a task when an in-flight steer rejects after shutdown', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const pending = deferred<void>(); run.t.steer.mockReturnValueOnce(pending.promise);
    await o.onMessage(message('second'));
    await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
    await o.shutdown(); pending.reject(new Error('late rejection'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(run.consumed).toHaveLength(1);
  });
  it('delivers new group chatter with sender identity, then advances after host acceptance', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    const background = { ...message('项目已经开始'), threadId: undefined, mentionedBot: false, senderName: '张三', senderId: 'ou_zhang' };
    await o.onMessage(background);
    await o.onMessage(message('现在怎么样'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('项目已经开始');
    expect(run.consumed[0]!.text).toContain('"user_name":"张三"');
    expect(run.consumed[0]!.text).toContain('"user_id":"ou_zhang"');
    await o.onMessage(message('请继续'));
    await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
    const second = run.t.steer.mock.calls[0]![0];
    expect(second.text).toContain('请继续');
    expect(second.text).not.toContain('项目已经开始');
    run.turns[0]!.resolve();
  });
  it('holds later preparation until an earlier queued input is accepted', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('queue');
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('second'));
    await o.onMessage(message('third'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    expect(run.consumed).toHaveLength(1);
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('second');
    expect(run.consumed[1]!.text).not.toContain('third');
    run.turns[1]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(3));
    expect(run.consumed[2]!.text).toContain('third');
    expect(run.consumed[2]!.text).not.toContain('second');
    run.turns[2]!.resolve();
  });
});

it.each([false, true])('releases intake after compact drops a queued message (failure=%s)', async failure => {
 const run = thread(); const compactEnd = deferred<{usage?: never}>();
 Object.assign(run.t, { compact: vi.fn(() => compactEnd.promise) });
 fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup('queue');
 await o.onMessage(message('/compact'));
 await until(() => expect((run.t as any).compact).toHaveBeenCalledOnce());
 await o.onMessage(message('during compact'));
 await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', {depth:1}));
 if (failure) compactEnd.reject(new Error('compact failed')); else compactEnd.resolve({});
 await until(() => expect(fake.send.mock.calls.some(c => JSON.stringify(c).includes('压缩期间收到的 1 条'))).toBe(true));
 await o.onMessage(message('after compact resend'));
 await new Promise(r => setTimeout(r, 150));
 expect(run.consumed).toHaveLength(1);
});

it('does not retry uncertain steer delivery', async () => {
 const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 const accepted: AgentInput[] = [];
 run.t.steer.mockImplementationOnce(async input => { accepted.push(input); throw new Error('app-server exited before steer response'); });
 await o.onMessage(message('perform exactly once'));
 await until(() => expect(fake.send.mock.calls.some(c => JSON.stringify(c).includes('未自动重投'))).toBe(true));
 run.turns[0]!.resolve();
 await new Promise(r => setTimeout(r, 30));
 expect(accepted.length + run.consumed.slice(1).length).toBe(1);
});

it('releases intake on a missing steer acknowledgment', async () => {
 const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 const pending = deferred<void>(); run.t.steer.mockReturnValueOnce(pending.promise);
 await o.onMessage(message('second'));
 await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
 run.turns[0]!.resolve();
 await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
 await o.onMessage(message('third after current finished'));
 await new Promise(r => setTimeout(r, 150));
 const count = run.consumed.length;
 await o.shutdown(); pending.reject(new Error('cleanup'));
 expect(count).toBeGreaterThan(1);
});
