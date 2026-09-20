import { JsonRpcError } from '../src/agent/codex-appserver/app-server-client';
import { rm, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

vi.mock('../src/config/paths', async (original) => { const old = await original<typeof import('../src/config/paths')>(); return { ...old, paths: { ...old.paths, sessionsFile: `/tmp/feishu-discuss-intake-test-${process.pid}.json` } }; });
const fake = vi.hoisted(() => ({
  backend: { id: 'codex-appserver', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  evict: undefined as undefined | ((chat: string) => Promise<void>),
  discuss: true,
  participation: undefined as undefined | 'all' | 'model' | 'mention',
  action: 'FOLLOW_UP',
  judgeCalls: 0,
  judgeInputs: [] as any[],
  transcribe: vi.fn(async () => '转写后的请求'),
  judgeGate: undefined as Promise<void> | undefined,
  reaction: vi.fn(async () => ({ data: { reaction_id: 'reaction' } })),
  final: vi.fn(async () => true),
  createCard: vi.fn(async () => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/admin/ops', async original => ({
  ...await original<object>(),
  createAdminWriteExecutor: (deps: { evictLiveSessionsForChat(chat: string): Promise<void> }) => {
    fake.evict = deps.evictLiveSessionsForChat; return async () => undefined;
  },
}));
vi.mock('../src/bot/voice', async original => ({ ...await original<object>(), transcribeVoice: fake.transcribe }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', kind: 'single', discuss: fake.discuss, participation: fake.participation, noMention: false }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex-appserver', cwd: '/test', summary: '' }),
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
    forkContext: async () => ({ empty: true }),
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
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: undefined,
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup(policy: 'steer' | 'queue' = 'steer') {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { contextBriefing: { enabled: true }, pendingPolicy: policy, access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: {
    create: fake.reaction, delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks(); fake.participation = undefined; fake.discuss = true; fake.action = 'FOLLOW_UP'; fake.judgeCalls = 0; fake.judgeInputs = []; fake.transcribe.mockReset().mockResolvedValue('转写后的请求'); fake.judgeGate = undefined;
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => { await orchestrator?.shutdown(); for (const suffix of ['.context.json', '.discuss.json', '.discuss.json.messages.jsonl', '.discuss.json.tmp']) await rm(`/tmp/feishu-discuss-intake-test-${process.pid}.json${suffix}`, { force: true }); });
const until = (check: () => void) => vi.waitFor(check);



vi.mock('../src/agent/codex-appserver/discuss-runner', () => ({
  readDiscussSource: async () => ({ path: '/test-rollout' }),
  createDiscussModel: async (opts: { model: string }) => ({ close: async () => undefined,
    ask: async (input: string) => {
      if (opts.model === 'gpt-5.6-luna') return JSON.stringify({ topics: [], requests: [], constraints: [], decisions: [], results: [], uncertain: [] });
      fake.judgeCalls++;
      await fake.judgeGate;
      const data = JSON.parse(input); fake.judgeInputs.push(data);
      return JSON.stringify({ hostId: data.hostId, runId: data.runId, lookup: null,
        decisions: data.messages.map((m: { messageId: string }) => ({ messageId: m.messageId, action: fake.action, reason: 'test' })) });
    },
  }),
}));

describe('Discuss main-thread integration', () => {
  it('routes ordinary messages through judge despite noMention=false', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage({ ...message('please review'), mentionedBot: false });
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1), { timeout: 3500 });
    expect(fake.judgeCalls).toBe(1); expect(run.consumed[0]?.text).toContain('[discuss-delivery:');
    run.turns[0]!.resolve();
  });
  it('shares one delayed host resume between judgment and summary', async () => {
    const run = thread();
    const resumed = deferred<typeof run.t>();
    fake.backend.resumeThread.mockImplementation(() => resumed.promise);
    const o = setup(); await o.onMessage({ ...message('please review'), mentionedBot: false });
    await vi.waitFor(() => expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1), { timeout: 3500 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(fake.backend.resumeThread).toHaveBeenCalledTimes(1);
    resumed.resolve(run.t);
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1), { timeout: 3500 });
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });
  it('@ bypasses judgment and STEER targets the actual active turn', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1)); expect(fake.judgeCalls).toBe(0);
    fake.action = 'STEER';
    await o.onMessage({ ...message('use the second file instead'), mentionedBot: false });
    await vi.waitFor(() => expect(run.t.steer).toHaveBeenCalledOnce(), { timeout: 3500 });
    expect(run.t.steer.mock.calls[0]?.[1]).toBe('turn-1');
    run.turns[0]!.resolve();
  });
  it('off restores the original mention gate', async () => {
    fake.discuss = false;
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage({ ...message('chatter'), mentionedBot: false });
    expect(run.consumed).toHaveLength(0); expect(fake.judgeCalls).toBe(0);
  });
});

it.each(['', '请处理刚才的请求'])('@ interrupts an in-flight verdict and transfers history: %s', async text => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const verdict = deferred<void>(); fake.judgeGate = verdict.promise;
  const o = setup();
  const prior = { ...message('请检查图片查看能力'), mentionedBot: false };
  await o.onMessage(prior);
  await vi.waitFor(() => expect(fake.judgeCalls).toBe(1), { timeout: 3500 });
  fake.reaction.mockClear();
  const at = message(text);
  await o.onMessage(at);
  await until(() => expect(run.consumed).toHaveLength(1));
  expect(fake.reaction).toHaveBeenCalledOnce();
  expect(run.consumed[0]!.text).toContain(`[discuss-delivery:${prior.messageId}]`);
  expect(run.consumed[0]!.text).toContain('请检查图片查看能力');
  expect(run.consumed[0]!.text).toContain(text || '请结合本条 @ 前的群聊消息');
  verdict.resolve();
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(fake.judgeCalls).toBe(1);
  expect(run.t.steer).not.toHaveBeenCalled();
  run.turns[0]!.resolve();
});
it('awaits the processing reaction before main history preparation', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const reaction = deferred<{ data: { reaction_id: string } }>();
  fake.reaction.mockImplementationOnce(() => reaction.promise);
  const o = setup(); const handling = o.onMessage(message('do it'));
  await until(() => expect(fake.reaction).toHaveBeenCalledOnce());
  expect(fake.backend.resumeThread).not.toHaveBeenCalled();
  reaction.resolve({ data: { reaction_id: 'early' } }); await handling;
  await until(() => expect(run.consumed).toHaveLength(1));
  expect(fake.reaction).toHaveBeenCalledOnce(); run.turns[0]!.resolve();
});

it('closes an obsolete in-flight restore after permission eviction', async () => {
  const old = thread(), fresh = thread(); const delayed = deferred<typeof old.t>();
  fake.backend.resumeThread.mockReturnValueOnce(delayed.promise).mockResolvedValue(fresh.t);
  const o = setup(); await o.onMessage({ ...message('ordinary'), mentionedBot: false });
  await vi.waitFor(() => expect(fake.backend.resumeThread).toHaveBeenCalledOnce(), { timeout: 3500 });
  await fake.evict!('chat'); delayed.resolve(old.t);
  await until(() => expect(old.t.close).toHaveBeenCalled());
  await o.onMessage(message('new permission request'));
  await until(() => expect(fresh.consumed).toHaveLength(1));
  expect(old.consumed).toHaveLength(0);
  expect(fake.backend.startThread).not.toHaveBeenCalled(); fresh.turns[0]!.resolve();
});
it('retries a definitive Discuss STEER rejection instead of stranding unknown', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup(); await o.onMessage(message('first'));
  await until(() => expect(run.consumed).toHaveLength(1));
  fake.action = 'STEER'; run.t.steer.mockRejectedValueOnce(new JsonRpcError('no active turn'));
  await o.onMessage({ ...message('correction'), mentionedBot: false });
  await vi.waitFor(() => expect(run.t.steer).toHaveBeenCalledTimes(2), { timeout: 3500 });
  run.turns[0]!.resolve();
});


it.each(['all', 'model', 'mention'] as const)('routes ordinary messages according to explicit %s policy despite legacy discuss=true', async policy => {
  fake.participation = policy;
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup(); const pending = o.onMessage({ ...message('please review'), mentionedBot: false });
  if (policy === 'mention') { await pending; expect(run.consumed).toHaveLength(0); expect(fake.judgeCalls).toBe(0); }
  else {
    await vi.waitFor(() => expect(run.consumed).toHaveLength(1), { timeout: 3500 });
    expect(fake.judgeCalls).toBe(policy === 'model' ? 1 : 0);
    run.turns[0]!.resolve(); await pending;
  }
});


it('transcribes unmentioned voice before judgment and preserves following message order', async () => {
  fake.action = 'IGNORE';
  const asr = deferred<string>(); fake.transcribe.mockReturnValueOnce(asr.promise);
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup();
  await o.onMessage({ ...message('[audio]'), mentionedBot: false, rawContentType: 'audio' });
  await until(() => expect(fake.transcribe).toHaveBeenCalledTimes(1));
  await o.onMessage({ ...message('后续文字'), mentionedBot: false });
  expect(fake.judgeCalls).toBe(0);
  asr.resolve('请检查机器故障');
  await vi.waitFor(() => expect(fake.judgeInputs.flatMap(d => d.messages).map(m => m.text)).toEqual(['请检查机器故障', '后续文字']), { timeout: 3500 });
  expect(run.consumed).toHaveLength(0);
});

it('does not judge a voice preparation invalidated by permission eviction', async () => {
  fake.action = 'IGNORE';
  const asr = deferred<string>(); fake.transcribe.mockReturnValueOnce(asr.promise);
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup();
  await o.onMessage({ ...message('[audio]'), mentionedBot: false, rawContentType: 'audio' });
  await until(() => expect(fake.transcribe).toHaveBeenCalledTimes(1));
  await fake.evict!('chat'); asr.resolve('不得执行');
  await new Promise(r => setTimeout(r, 1100));
  expect(fake.judgeCalls).toBe(0);
});

async function durableEntries() {
  const state = JSON.parse(await readFile(`/tmp/feishu-discuss-intake-test-${process.pid}.json.discuss.json`, 'utf8'));
  return Object.values(state.lanes).flatMap((lane: any) => lane.entries) as {msg: {messageId: string}; state: string}[];
}
it('rejects oversized automatic delivery without accepting messages or notifying repeatedly', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup(); const msg = {...message('汉'.repeat(90000)), mentionedBot: false};
  await o.onMessage(msg);
  await vi.waitFor(() => expect(fake.log.warn).toHaveBeenCalledWith('intake', 'discuss-delivery-over-budget', expect.anything()), {timeout:3500});
  await vi.waitFor(async () => expect((await durableEntries()).find(e=>e.msg.messageId===msg.messageId)?.state).toBe('followup'));
  expect(run.consumed).toHaveLength(0); expect(run.t.steer).not.toHaveBeenCalled();
  expect(fake.send).not.toHaveBeenCalled();
});
it('rejects oversized mention takeover, releases every message and leaves the preparation lane usable', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup();
  const prior = {...message('汉'.repeat(50000)), mentionedBot:false};
  const direct = message('字'.repeat(50000));
  await o.onMessage(prior); await o.onMessage(direct);
  await vi.waitFor(() => expect(fake.send).toHaveBeenCalledWith('chat', {markdown: expect.stringContaining('分批')}, {replyTo:direct.messageId, replyInThread:false}));
  await vi.waitFor(async () => {
    const entries = await durableEntries();
    for (const msg of [prior,direct]) expect(entries.find(e=>e.msg.messageId===msg.messageId)?.state).toBe('pending');
  });
  expect(run.consumed).toHaveLength(0);
  // Another explicit request completes preparation instead of hanging on an unsettled receipt.
  const again = message('再试'); await o.onMessage(again);
  await vi.waitFor(()=>expect(fake.send.mock.calls.filter(call=>JSON.stringify(call).includes('分批'))).toHaveLength(2));
  expect(run.consumed).toHaveLength(0);
});
