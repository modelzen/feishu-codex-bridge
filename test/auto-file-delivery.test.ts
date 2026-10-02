import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

const fake = vi.hoisted(() => ({
  project: undefined as any, record: undefined as any, outcome: 'done', terminalDelivered: true, revoke: false,
  backend: { id: 'codex', capabilities: {}, listModels: vi.fn(async () => []), startThread: vi.fn() },
  upload: vi.fn(async (_: any) => ({ file_key: 'file_test' })),
  reply: vi.fn(async (_: any) => ({ code: 0, data: { message_id: 'file_msg', message_position: '12' } })),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({ ...await original<object>(), getProjectByChatId: async (id: string) => id === 'chat' ? fake.project : undefined }));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(), getSession: async () => fake.record,
  patchSession: async (_: string, patch: object) => Object.assign(fake.record, patch),
  upsertSession: async (record: object) => { fake.record = record; },
}));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async register() {} async shutdown() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create() { return 'result_card'; }
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced() {} async drain() {} setImageWorker() {}
    async settleImages() { return new Map(); }
    async updateCard() { return fake.terminalDelivered; }
    async finalizeCard() { if (fake.revoke) fake.project = undefined; return fake.terminalDelivered; }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

let root: string;
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
beforeEach(async () => {
  vi.clearAllMocks();
  fake.record = undefined; fake.outcome = 'done'; fake.terminalDelivered = true; fake.revoke = false;
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-auto-')));
  await mkdir(join(root, 'outputs'));
  await writeFile(join(root, 'outputs', 'result.txt'), 'safe test deliverable');
  fake.project = { name: 'test', chatId: 'chat', cwd: root, kind: 'single', mode: 'full', fileDelivery: { mode: 'auto', directories: ['outputs'] } };
  fake.backend.startThread.mockResolvedValue({
    sessionId: 'host', isAlive: () => true, close: async () => {}, abort: async () => {},
    clearGoal: async () => {},
    runGoal: () => ({ events: (async function* () {
      yield { type: 'turn_started', turnId: 'goal-turn' };
      yield { type: 'text_delta', delta: '[result](outputs/result.txt)' };
      if (fake.outcome === 'done') yield { type: 'done', turnId: 'goal-turn' };
      else if (fake.outcome === 'error') yield { type: 'error', message: 'failed' };
      yield { type: 'goal_update', status: 'complete', tokensUsed: 10, timeUsedSeconds: 1 };
    })() }),
    runStreamed: () => ({ turnId: () => 'turn', events: (async function* () {
      yield { type: 'turn_started', turnId: 'turn' };
      yield { type: 'text_delta', delta: '[result](outputs/result.txt)' };
      if (fake.outcome === 'done') yield { type: 'done', turnId: 'turn' };
      else if (fake.outcome === 'error') yield { type: 'error', message: 'failed' };
    })() }),
  });
});
afterEach(async () => { await orchestrator?.shutdown(); await rm(root, { recursive: true, force: true }); });

async function run(goal = false) {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test-fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { im: { v1: {
    file: { create: fake.upload }, message: { reply: fake.reply },
    messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) },
  } } } };
  orchestrator = createOrchestrator(channel as never, cfg, root);
  await orchestrator.onMessage({ messageId: `request-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: goal ? '/goal test' : 'test', senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false } as NormalizedMessage);
  await vi.waitFor(() => expect(fake.log.info).toHaveBeenCalledWith('card', goal ? 'goal-final' : 'final', expect.anything()), { timeout: 5000 });
}

it('sends the referenced output through the same bot after the terminal card lands', async () => {
  await run();
  expect(fake.upload).toHaveBeenCalledTimes(1);
  expect(fake.upload.mock.calls[0]![0].data.file).toEqual(Buffer.from('safe test deliverable'));
  expect(fake.reply.mock.calls[0]![0]).toMatchObject({ path: { message_id: 'result_card' }, data: { msg_type: 'file', reply_in_thread: false } });
});

it.each(['manual', 'error', 'no-done-event', 'card-failed', 'revoked'])('does not publish for %s', async (reason) => {
  if (reason === 'manual') delete fake.project.fileDelivery;
  if (reason === 'error') fake.outcome = 'error';
  if (reason === 'no-done-event') fake.outcome = 'closed';
  if (reason === 'card-failed') fake.terminalDelivered = false;
  if (reason === 'revoked') fake.revoke = true;
  await run();
  expect(fake.upload).not.toHaveBeenCalled();
  expect(fake.reply.mock.calls.filter(([request]) => request.data.msg_type === 'file')).toHaveLength(0);
});

it.each(['done', 'error', 'closed'])('publishes goal-turn deliverables only with a successful completion event (%s)', async (outcome) => {
  fake.outcome = outcome;
  await run(true);
  expect(fake.upload).toHaveBeenCalledTimes(outcome === 'done' ? 1 : 0);
  expect(fake.reply.mock.calls.filter(([request]) => request.data.msg_type === 'file')).toHaveLength(outcome === 'done' ? 1 : 0);
});
