import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage, CardActionEvent } from '@larksuiteoapi/node-sdk';
import type { SessionRecord } from '../src/bot/session-store';
import type { Project } from '../src/project/registry';
import type { AppConfig } from '../src/config/schema';
const fake = vi.hoisted(() => ({
  rec: undefined as SessionRecord | undefined,
  project: {} as Project,
  send: vi.fn(async () => ({ messageId: 'model-card' })),
  update: vi.fn(async () => true),
  patch: vi.fn(),
  start: vi.fn(),
  resume: vi.fn(),
  close: vi.fn(async () => undefined),
  goal: vi.fn(),
  models: [{ id: 'only', displayName: 'Only', description: '', supportedEfforts: ['medium'], defaultEffort: 'medium', hidden: false, isDefault: true }],
}));
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => ({
  id: 'codex-appserver', listModels: async () => fake.models,
  startThread: fake.start, resumeThread: fake.resume,
}) }));
vi.mock('../src/project/registry', async original => ({ ...await original<object>(),
  getProjectByName: async () => fake.project,
  getProjectByChatId: async () => fake.project,
  updateProject: async (_name: string, patch: Partial<Project>) => { Object.assign(fake.project, patch); },
}));
vi.mock('../src/bot/session-store', async original => ({ ...await original<object>(),
  getSession: async () => fake.rec,
  upsertSession: async (rec: SessionRecord) => { fake.rec = rec; },
  patchSession: async (_id: string, patch: Partial<SessionRecord> | ((r: SessionRecord) => Partial<SessionRecord>)) => {
    fake.patch(patch);
    if (fake.rec) Object.assign(fake.rec, typeof patch === 'function' ? patch(fake.rec) : patch);
  },
}));
vi.mock('../src/bot/session-title-coordinator', () => ({ SessionTitleCoordinator: class { startRecovery() {} async register() { return undefined; } async shutdown() {} } }));
vi.mock('../src/card/managed', () => ({ sendManagedCard: fake.send, updateManagedCard: fake.update }));
import { createOrchestrator } from '../src/bot/handle-message';
import { MC } from '../src/card/command-cards';
import { DM, GS } from '../src/card/dm-cards';
let orchestrator: ReturnType<typeof createOrchestrator>;
const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' }, completionReminder: { mode: 'manual' } } };
function event(a: string, option?: string, user = 'owner', form?: Record<string, unknown>): CardActionEvent {
  return { messageId: 'model-card', chatId: 'chat', operator: { openId: user }, action: { value: { a, n: 'p' }, option }, raw: { action: { form_value: form } } } as unknown as CardActionEvent;
}
async function message(content: string) {
  await orchestrator.onMessage({ messageId: content, chatId: 'chat', chatType: 'group', threadId: 'topic', content, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false } as NormalizedMessage);
}
async function openModel() {
  const before = fake.send.mock.calls.length;
  await message('/model');
  await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(before + 1));
}
beforeEach(() => {
  vi.clearAllMocks();
  const makeThread = (opts: { fastMode?: boolean | null }) => ({
    getPreferences: () => opts,
    sessionId: 'host', isAlive: () => true, close: fake.close,
    clearGoal: async () => undefined,
    runGoal: (objective: string) => {
      fake.goal(objective);
      return { events: (async function* () {})(), turnId: () => undefined };
    },
  });
  fake.start.mockImplementation(async opts => makeThread(opts));
  fake.resume.mockImplementation(async opts => makeThread(opts));
  fake.project = { name: 'p', chatId: 'chat', cwd: '/tmp', blank: false, createdAt: 1, backend: 'codex-appserver', defaultFastMode: true };
  fake.rec = { threadId: 'topic', chatId: 'chat', cwd: '/tmp', sessionId: 'host', backend: 'codex-appserver', model: 'only', effort: 'medium', fastMode: true, summary: '', createdAt: 1, updatedAt: 1 };
  orchestrator = createOrchestrator({ send: vi.fn(async () => ({})), rawClient: { im: { v1: { messageReaction: { create: async () => ({ data: {} }) } } } } } as never, cfg, '/tmp');
});
afterEach(async () => { await orchestrator.shutdown(); });

describe('Fast card callbacks', () => {
  it('persists off from /model and echoes it without changing the project default', async () => {
    await openModel();
    await orchestrator.dispatcher.handle(event(MC.fast, 'off'));
    await vi.waitFor(() => expect(fake.rec?.fastMode).toBe(false), { timeout: 2000 });
    expect(fake.project.defaultFastMode).toBe(true);
    expect(JSON.stringify(fake.update.mock.calls)).toContain('Fast 已关闭');
  });
  it('rejects another user and invalid options', async () => {
    await openModel();
    await orchestrator.dispatcher.handle(event(MC.fast, 'off', 'other'));
    await orchestrator.dispatcher.handle(event(MC.fast, 'invalid'));
    expect(fake.patch).not.toHaveBeenCalled();
  });
  it('rejects a stale card after the session binding changes', async () => {
    await openModel();
    fake.rec!.sessionId = 'replacement';
    await orchestrator.dispatcher.handle(event(MC.fast, 'off'));
    await vi.waitFor(() => expect(fake.update).toHaveBeenCalled(), { timeout: 2000 });
    expect(fake.patch).not.toHaveBeenCalled();
    expect(fake.rec?.fastMode).toBe(true);
  });
  it.each([DM.modelDefaultSubmit, GS.modelDefaultSubmit])('saves Fast-only single-model form through %s', async action => {
    await orchestrator.dispatcher.handle(event(action, undefined, 'owner', { fastMode: 'off', effort: 'medium' }));
    await vi.waitFor(() => expect(fake.project.defaultFastMode).toBe(false));
    expect(fake.project.defaultModel).toBe('only');
    expect(fake.rec?.fastMode).toBe(true);
  });
  it('does not let non-admins change project Fast defaults', async () => {
    await orchestrator.dispatcher.handle(event(GS.modelDefaultSubmit, undefined, 'other', { fastMode: 'off' }));
    expect(fake.project.defaultFastMode).toBe(true);
  });
});


describe('Fast session lifecycle', () => {
  it.each([true, false])('inherits project Fast=%s when /clear creates the first session', async fastMode => {
    fake.project.kind = 'single';
    fake.project.defaultFastMode = fastMode;
    fake.rec = undefined;
    await message('/clear');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ fastMode }));
    expect(fake.rec).toEqual(expect.objectContaining({ fastMode }));
  });

  it('preserves an existing unconfigured session on /clear', async () => {
    fake.project.kind = 'single';
    fake.rec!.fastMode = undefined;
    await message('/clear');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ fastMode: undefined }));
    expect(fake.rec?.fastMode).toBeUndefined();
  });

  it.each([true, false])('applies /model Fast=%s before a goal on a live session', async fastMode => {
    fake.project.kind = 'single';
    fake.rec!.fastMode = !fastMode;
    // /clear establishes the same parked live thread an ordinary turn leaves.
    await message('/clear');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    await openModel();
    await orchestrator.dispatcher.handle(event(MC.fast, fastMode ? 'on' : 'off'));
    await vi.waitFor(() => expect(fake.rec?.fastMode).toBe(fastMode));
    await message('/goal finish the task');
    await vi.waitFor(() => expect(fake.goal).toHaveBeenCalledWith(expect.stringContaining('finish the task')));
    expect(fake.resume).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'host', fastMode }));
    expect(fake.close.mock.invocationCallOrder[0]).toBeLessThan(fake.resume.mock.invocationCallOrder[0]!);
    expect(fake.resume.mock.invocationCallOrder[0]).toBeLessThan(fake.goal.mock.invocationCallOrder[0]!);
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(2));
  });
});


describe('Fast inheritance and unchanged goals', () => {
  it('restores inherited Fast on the current session', async () => {
    await openModel();
    await orchestrator.dispatcher.handle(event(MC.fast, 'default'));
    await vi.waitFor(() => expect(fake.rec?.fastMode).toBeNull());
    expect(JSON.stringify(fake.update.mock.calls)).toContain('已恢复沿用 Codex 设置');
  });
  it.each([GS.modelDefaultSubmit, DM.modelDefaultSubmit])('saves only Fast without pinning a model through %s', async action => {
    await orchestrator.dispatcher.handle(event(action, undefined, 'owner', { fastMode: 'default' }));
    await vi.waitFor(() => expect(fake.project.defaultFastMode).toBeNull());
    expect(fake.project.defaultModel).toBeUndefined();
    expect(fake.project.defaultEffort).toBeUndefined();
  });
  it.each([true, false, null, undefined])('keeps a live thread for a goal when Fast=%s is unchanged', async fastMode => {
    fake.project.kind = 'single';
    fake.rec!.fastMode = fastMode;
    await message('/clear');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    await message('/goal continue');
    await vi.waitFor(() => expect(fake.goal).toHaveBeenCalled());
    expect(fake.resume).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(1));
  });
});


it.each(['model', 'effort'] as const)('refreshes a goal only when the applied %s changed', async key => {
  fake.project.kind = 'single';
  await message('/clear');
  await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
  if (key === 'model') fake.rec!.model = 'other';
  else fake.rec!.effort = 'high';
  await message('/goal use new preferences');
  await vi.waitFor(() => expect(fake.goal).toHaveBeenCalled());
  expect(fake.resume).toHaveBeenCalledWith(expect.objectContaining({ [key]: fake.rec![key] }));
  await vi.waitFor(() => expect(fake.close).toHaveBeenCalledTimes(2));
});

it('saves Fast while model discovery is empty without changing explicit model defaults', async () => {
  const previous = fake.models;
  fake.models = [];
  fake.project.defaultModel = 'keep-model';
  fake.project.defaultEffort = 'high';
  try {
    await orchestrator.dispatcher.handle(event(GS.modelDefaultSubmit, undefined, 'owner', { fastMode: 'off' }));
    await vi.waitFor(() => expect(fake.project.defaultFastMode).toBe(false));
    expect(fake.project.defaultModel).toBe('keep-model');
    expect(fake.project.defaultEffort).toBe('high');
  } finally { fake.models = previous; }
});
