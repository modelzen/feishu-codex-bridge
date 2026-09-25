import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';

vi.mock('../src/config/paths', () => {
  const appDir = mkdtempSync(join(tmpdir(), 'no-mention-parity-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json'), commentsRootDir: join(appDir, 'comments') } };
});
afterAll(() => rmSync(paths.appDir, { recursive: true, force: true }));

const fake = vi.hoisted(() => ({
  kind: 'multi' as 'multi' | 'single',
  noMention: true,
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  startThread: vi.fn(async () => ({
    sessionId: 'native-fixture',
    isAlive: () => true,
    close: async () => {},
    runStreamed: () => ({
      turnId: () => 'turn-fixture',
      events: (async function* () { yield { type: 'done', turnId: 'turn-fixture' }; })(),
    }),
  })),
}));

vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
vi.mock('../src/project/registry', async original => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', kind: fake.kind, noMention: fake.noMention, mode: 'qa', guestMode: 'qa', network: false }),
}));
vi.mock('../src/agent', async original => ({
  ...await original<object>(),
  createBackend: () => ({ id: 'codex-appserver', listModels: async () => [], startThread: fake.startThread }),
}));
vi.mock('../src/bot/session-store', async original => ({
  ...await original<object>(),
  getSession: async () => undefined,
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} } }));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    async create() { return 'card'; }
    getCardId() { return 'card'; }
    async updateElement() { return true; }
    async drain() {}
    async settleImages() { return new Map(); }
    async updateCard() { return true; }
    async finalizeCard() { return true; }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));

import { createOrchestrator } from '../src/bot/handle-message';

const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' }, completionReminder: { mode: 'manual' } } };
const channel = { send: fake.send, rawClient: { im: { v1: { messageReaction: { create: async () => ({ data: {} }), delete: async () => ({}) } } } } };
let orchestrator: ReturnType<typeof createOrchestrator>;
let sequence = 0;
function message(content: string, threadId?: string, mentionedBot = false): NormalizedMessage {
  return { messageId: `om_fixture_${++sequence}`, chatId: 'oc_demo', chatType: 'group', content, threadId,
    senderId: 'ou_owner', senderName: 'Owner', mentionedBot, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.kind = 'multi';
  fake.noMention = true;
  orchestrator = createOrchestrator(channel as never, cfg, '/tmp/demo');
});
afterEach(async () => { await orchestrator.shutdown(); });

it('CARD-010 ignores ordinary unmentioned multi-group main-area text even when noMention is on', async () => {
  await orchestrator.onMessage(message('ordinary main-area chatter'));
  expect(fake.startThread).not.toHaveBeenCalled();
  expect(fake.send).not.toHaveBeenCalled();
});

it('CARD-010 accepts an unmentioned supported command in the multi-group main area', async () => {
  await orchestrator.onMessage(message('/model'));
  expect(fake.send).toHaveBeenCalledWith('oc_demo', expect.objectContaining({ markdown: expect.stringContaining('话题') }), expect.anything());
  expect(fake.startThread).not.toHaveBeenCalled();
});

it('CARD-010 accepts ordinary unmentioned text inside a multi-group topic', async () => {
  await orchestrator.onMessage(message('continue the topic', 'omt_topic'));
  await vi.waitFor(() => expect(fake.startThread).toHaveBeenCalledOnce());
});

it('CARD-010 accepts ordinary unmentioned text in a single-session group', async () => {
  fake.kind = 'single';
  await orchestrator.onMessage(message('continue the group'));
  await vi.waitFor(() => expect(fake.startThread).toHaveBeenCalledOnce());
});

it('CARD-010 rejects unmentioned text when the project switch is off', async () => {
  fake.kind = 'single';
  fake.noMention = false;
  await orchestrator.onMessage(message('continue the group'));
  expect(fake.startThread).not.toHaveBeenCalled();
});
