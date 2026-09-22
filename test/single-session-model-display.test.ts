import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/config/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput, TurnOptions } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  record: undefined as any,
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  final: vi.fn(async () => true),
  createCard: vi.fn(async () => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', kind: 'single', defaultModel: 'chosen-model', defaultEffort: 'xhigh' }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => fake.record,
  patchSession: async (_key: string, patch: object) => { Object.assign(fake.record, patch); },
  upsertSession: async (record: object) => { fake.record = record; },
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async register() {} async shutdown() {} },
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = fake.createCard;
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced() {}
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
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
  const options: (TurnOptions | undefined)[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    runStreamed(input: AgentInput, turn?: TurnOptions) {
      consumed.push(input);
      options.push(turn);
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
  return { t, turns, consumed, options };
}
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup(showModel: 'off' | 'running' | 'always' = 'always') {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { showModel, access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
let historyDirectory: string;
let restoreHistoryPath: () => void;
beforeEach(async () => {
  historyDirectory = await mkdtemp(join(tmpdir(), 'model-display-history-'));
  const spy = vi.spyOn(paths, 'processHistoryDir', 'get').mockReturnValue(historyDirectory);
  restoreHistoryPath = () => spy.mockRestore();
  vi.clearAllMocks();
  fake.record = undefined;
  fake.backend.listModels.mockResolvedValue([{ id: 'chosen-model', displayName: 'Chosen', description: '', supportedEfforts: ['medium', 'xhigh'], defaultEffort: 'medium', isDefault: true, hidden: false }] as never);
  fake.backend.capabilities.steer = true;
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => {
  await orchestrator?.shutdown();
  restoreHistoryPath();
  await rm(historyDirectory, { recursive: true, force: true });
});
const until = (check: () => void) => vi.waitFor(check);

describe('single-session model display', () => {
  it.each(['always', 'running', 'off'] as const)('passes and persists new session defaults with display=%s', async (display) => {
    const run = thread();
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup(display);
    await o.onMessage(message('first'));
    await until(() => expect(fake.createCard).toHaveBeenCalledTimes(1));
    const selected = { model: 'chosen-model', effort: 'xhigh' };
    expect(fake.backend.startThread).toHaveBeenCalledWith(expect.objectContaining(selected));
    expect(run.options[0]).toEqual(selected);
    expect(fake.record).toMatchObject(selected);
    const running = JSON.stringify(fake.createCard.mock.calls[0]);
    expect(running.includes('chosen-model')).toBe(display !== 'off');
    if (display !== 'off') expect(running).toContain('极高');
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    const terminal = JSON.stringify(fake.final.mock.calls.at(-1));
    expect(terminal.includes('chosen-model')).toBe(display === 'always');
    await o.onMessage(message('second'));
    await until(() => expect(run.options).toHaveLength(2));
    expect(run.options[1]).toEqual(selected);
    expect(fake.backend.startThread).toHaveBeenCalledTimes(1);
    run.turns[1]!.resolve();
  });

  it.each([false, true])('repairs missing metadata without replacing an existing selection (hasSelection=%s)', async (hasSelection) => {
    const selected = hasSelection ? { model: 'existing-model', effort: 'high' } : {};
    fake.record = { threadId: 'chat', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '', ...selected };
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('continue'));
    await until(() => expect(fake.createCard).toHaveBeenCalledTimes(1));
    const expected = hasSelection ? selected : { model: 'chosen-model', effort: 'xhigh' };
    expect(run.options[0]).toEqual(expected);
    expect(fake.record).toMatchObject(expected);
    expect(JSON.stringify(fake.createCard.mock.calls[0])).toContain(expected.model);
    run.turns[0]!.resolve();
  });
});
