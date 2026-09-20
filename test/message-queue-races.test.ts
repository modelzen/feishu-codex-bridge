import { UnsentRequestError } from '../src/agent/types';
import { JsonRpcError } from '../src/agent/codex-appserver/app-server-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  steerDeadlineMs: 6000,
  final: vi.fn(async () => true),
  createCard: vi.fn(async () => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/bot/steer-delivery', async original => { const real = await original<typeof import('../src/bot/steer-delivery')>(); return { ...real, steerWithDeadline: (thread: any, input: any, id: string) => real.steerWithDeadline(thread, input, id, undefined, fake.steerDeadlineMs) }; });
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
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: policy, access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.steerDeadlineMs = 6000;
  fake.backend.capabilities.steer = true;
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => { await orchestrator?.shutdown(); });
const until = (check: () => void) => vi.waitFor(check);

describe('message queue lifecycle', () => {
  it('starts the follow-up when steer rejects after its original consumer has finished', async () => {
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const steer = deferred<void>();
    run.t.steer.mockReturnValueOnce(steer.promise);
    await o.onMessage(message('follow-up'));
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(1));
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    steer.reject(new JsonRpcError('turn already completed'));
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('follow-up');
    run.turns[1]!.resolve();
  });

  it('queues on the replacement owner if another run starts before steer rejects', async () => {
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const steer = deferred<void>();
    run.t.steer.mockReturnValueOnce(steer.promise);
    await o.onMessage(message('late follow-up'));
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(1));
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    await o.onMessage(message('replacement'));
    await until(() => expect(run.consumed).toHaveLength(2));
    steer.reject(new JsonRpcError('no active turn'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    run.turns[1]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(3));
    expect(run.consumed[2]!.text).toContain('late follow-up');
    run.turns[2]!.resolve();
  });

  it('queues during final-card I/O instead of steering into a completed turn', async () => {
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const card = deferred<boolean>();
    fake.final.mockReturnValueOnce(card.promise);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
    await until(() => expect(fake.final).toHaveBeenCalled());
    await o.onMessage(message('second'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    expect(run.t.steer).not.toHaveBeenCalled();
    card.resolve(true);
    await until(() => expect(run.consumed).toHaveLength(2));
    run.turns[1]!.resolve();
  });

  it('reports queued inputs on stream failure and cannot remove a replacement reservation', async () => {
    const first = thread();
    const replacement = thread();
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValue(replacement.t);
    const o = setup('queue');
    await o.onMessage(message('first'));
    await until(() => expect(first.consumed).toHaveLength(1));
    await o.onMessage(message('queued'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    const feedback = deferred<object>();
    fake.send.mockReturnValueOnce(feedback.promise);
    first.turns[0]!.reject(new Error('stream failed'));
    await until(() => expect(fake.send).toHaveBeenCalledWith('chat', { markdown: expect.stringContaining('1 条排队消息未执行') }, expect.anything()));
    expect(first.t.close).toHaveBeenCalled();
    await o.onMessage(message('replacement'));
    await until(() => expect(replacement.consumed).toHaveLength(1));
    feedback.resolve({});
    await Promise.resolve();
    await o.onMessage(message('replacement follow-up'));
    await until(() => expect(fake.log.info.mock.calls.filter(c => c[1] === 'queued')).toHaveLength(2));
    expect(replacement.consumed).toHaveLength(1);
    replacement.turns[0]!.resolve();
    await until(() => expect(replacement.consumed).toHaveLength(2));
    replacement.turns[1]!.resolve();
  });

  it('reports follow-ups queued while initial session resolution fails', async () => {
    const resume = deferred<never>();
    fake.backend.resumeThread.mockReturnValueOnce(resume.promise);
    fake.backend.startThread.mockRejectedValue(new Error('backend unavailable'));
    const o = setup('queue');
    await o.onMessage(message('first'));
    await until(() => expect(fake.backend.resumeThread).toHaveBeenCalled());
    await o.onMessage(message('queued during startup'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    resume.reject(new Error('resume failed'));
    await until(() => expect(fake.send).toHaveBeenCalledWith('chat', {
      markdown: expect.stringContaining('1 条排队消息未执行'),
    }, expect.anything()));
  });

});

it.each(['disconnect', 'missing-response'])('does not replay uncertain steer delivery: %s', async failure => {
 fake.steerDeadlineMs = 150;
 const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 const pending = deferred<void>();
 run.t.steer.mockImplementationOnce(async () => { if (failure === 'disconnect') throw new Error('connection lost after write'); await pending.promise; });
 await o.onMessage(message('perform exactly once'));
 await until(() => expect(fake.send.mock.calls.some(c => JSON.stringify(c).includes('未自动重投'))).toBe(true));
 run.turns[0]!.resolve(); pending.resolve();
 await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
 await o.onMessage(message('next request'));
 await until(() => expect(run.consumed).toHaveLength(2));
 expect(run.consumed[1]!.text).toContain('next request');
 expect(run.consumed[1]!.text).not.toContain('perform exactly once');
 run.turns[1]!.resolve();
});

it('queues directly when the backend does not support steer', async () => {
 fake.backend.capabilities.steer = true; // project default differs from the actual thread
 const run = thread(); Object.assign(run.t, { supportsSteer: false }); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 await o.onMessage(message('second'));
 expect(run.t.steer).not.toHaveBeenCalled();
 run.turns[0]!.resolve();
 await until(() => expect(run.consumed).toHaveLength(2));
 expect(run.consumed[1]!.text).toContain('second');
 run.turns[1]!.resolve();
});

it('resubmits a definitely unsent message on a fresh thread after a process exit', async () => {
 const first = thread(), next = thread();
 fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValue(next.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(first.consumed).toHaveLength(1));
 first.t.isAlive = () => false;
 first.t.steer.mockRejectedValueOnce(new UnsentRequestError('app-server client closed'));
 await o.onMessage(message('unsent followup'));
 await until(() => expect(next.consumed).toHaveLength(1));
 expect(next.consumed[0]!.text).toContain('unsent followup');
 first.turns[0]!.resolve(); next.turns[0]!.resolve();
});
it('keeps the healthy thread and queued messages after terminal card failure', async () => {
 const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup('queue'); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 await o.onMessage(message('second'));
 fake.final.mockRejectedValueOnce(new Error('Feishu 503'));
 run.turns[0]!.resolve();
 await until(() => expect(run.consumed).toHaveLength(2));
 expect(run.t.close).not.toHaveBeenCalled();
 run.turns[1]!.resolve();
});
