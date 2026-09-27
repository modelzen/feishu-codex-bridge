import { pendingGroupsFile, readPendingGroups } from '../src/project/pending-groups';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { rm, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AccountUsageBundle } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { addProject, getProjectByName, removeProject, updateProject } from '../src/project/registry';
import { getSession, listSessions, upsertSession } from '../src/bot/session-store';
import { createOrchestrator } from '../src/bot/handle-message';
import { parseCollaborationRequest, projectRevision } from '../src/admin/collaboration';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'desktop-collaboration-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') } };
});
const fixture = vi.hoisted(() => ({ failProjectsWrite: false, backend: undefined as unknown, leave: vi.fn(), send: vi.fn(async () => ({ messageId: 'om_sent' })), usage: vi.fn<() => Promise<AccountUsageBundle>>(async () => ({ profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: {}, extras: [], fetchedAt: 1 } })) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fixture.failProjectsWrite && basename(String(args[1])) === 'projects.json') throw new Error('project disk failure');
    return actual.rename(...args);
  } };
});
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fixture.backend }));
vi.mock('../src/agent/usage', () => ({ fetchUsageBundle: fixture.usage }));
vi.mock('../src/project/group-ops', () => ({ leaveChat: fixture.leave, transferOwnership: vi.fn() }));
vi.mock('../src/card/managed', () => ({ sendManagedCard: fixture.send, updateManagedCard: vi.fn(async () => true) }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
const target = { projectName: 'demo', chatId: 'oc_demo' };
const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } };
function backend() {
  const thread = { sessionId: 'fresh', isAlive: () => true, close: vi.fn(async () => {}), compact: vi.fn(async () => ({ usage: { usedTokens: 20, contextWindow: 100 } })) };
  const backend = { id: 'codex-appserver', displayName: 'Codex', listModels: async () => [], startThread: vi.fn(async () => thread), resumeThread: vi.fn(async () => thread), listThreads: vi.fn(async () => [{ sessionId: 'past', preview: 'historic', createdAt: 1, updatedAt: 2 }]), readHistory: vi.fn(async () => ({ name: 'historic', preview: '', turns: [], totalTurns: 0 })) };
  fixture.backend = backend;
  return { ...backend, thread };
}
function orchestrator(channel: unknown = { send: fixture.send }) { return createOrchestrator(channel as never, cfg, paths.appDir); }
beforeEach(async () => {
  await rm(pendingGroupsFile(paths.projectsFile), { force: true });
  await rm(paths.projectsFile, { force: true }); await rm(paths.sessionsFile, { force: true });
  fixture.failProjectsWrite = false;
  fixture.leave.mockReset(); fixture.send.mockClear();
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: paths.appDir, kind: 'single', blank: false, origin: 'joined', createdAt: 1, backend: 'codex-appserver' });
  await upsertSession({ threadId: 'oc_demo', chatId: 'oc_demo', cwd: paths.appDir, sessionId: 'old', backend: 'codex-appserver', summary: 'old', createdAt: 1, updatedAt: 1 });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));
it('rejects untrusted identity, extra fields and relative paths at the HTTP boundary', () => {
  expect(() => parseCollaborationRequest({ action: 'context', ...target, threadId: 'oc_demo', owner: 'ou_fake' })).toThrow();
  expect(() => parseCollaborationRequest({ action: 'editProject', ...target, expectedRevision: 'revision', directory: '../escape' })).toThrow();
  expect(parseCollaborationRequest({ action: 'usage', force: true })).toEqual({ action: 'usage', force: true });
  expect(parseCollaborationRequest({ action: 'shareUsage', ...target, sections: ['stats', 'heatmap'] })).toMatchObject({ sections: ['stats', 'heatmap'] });
  expect(() => parseCollaborationRequest({ action: 'shareUsage', ...target, sections: ['unknown'] })).toThrow('分享区块无效');
  expect(() => parseCollaborationRequest({ action: 'shareUsage', ...target, sections: 'stats' })).toThrow('分享区块无效');
});

it('generates a share card with only the requested sections', async () => {
  backend(); const app = orchestrator();
  fixture.usage.mockResolvedValueOnce({
    profile: { displayName: 'Tester', lifetimeTokens: 12345, topInvocations: [], dailyBuckets: [] },
    usage: { main: { primary: { usedPercent: 25 } }, extras: [], fetchedAt: Date.now() },
  });
  try {
    await app.collaboration({ action: 'shareUsage', ...target, sections: ['stats'] });
    const card = JSON.stringify(fixture.send.mock.calls.at(-1));
    expect(card).toContain('累计 Token 数');
    expect(card).not.toContain('限额进度');
    expect(card).not.toContain('剩余 75%');
  } finally { await app.shutdown(); }
});
it('returns backend-wide history and only compacts the matching bound session', async () => {
  const be = backend(); const app = orchestrator();
  try {
    expect(await app.collaboration({ action: 'history', ...target })).toMatchObject({ threads: [{ sessionId: 'past' }], sessions: [{ sessionId: 'old' }] });
    await expect(app.collaboration({ action: 'compact', ...target, threadId: 'oc_other' })).rejects.toThrow('不属于');
    await app.collaboration({ action: 'compact', ...target, threadId: 'oc_demo' });
    expect(be.thread.compact).toHaveBeenCalledOnce();
    expect(await app.collaboration({ action: 'context', ...target, threadId: 'oc_demo' })).toMatchObject({ usage: { used: 20, window: 100 }, run: null });
  } finally { await app.shutdown(); }
});
it('clears a flat binding with its model settings and keeps old backend history resumable', async () => {
  const be = backend(); const app = orchestrator();
  try {
    await app.collaboration({ action: 'clear', ...target, threadId: 'oc_demo' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'fresh' });
    expect(be.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: paths.appDir }));
    await app.collaboration({ action: 'resume', ...target, sessionId: 'past', backend: 'codex-appserver' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'past' });
    await expect(app.collaboration({ action: 'resume', ...target, sessionId: 'foreign', backend: 'codex-appserver' })).rejects.toThrow('不属于');
  } finally { await app.shutdown(); }
});
it('reserves a compacting session against clear and rejects stale run controls', async () => {
  const be = backend(); let finish!: () => void;
  be.thread.compact.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ usage: { usedTokens: 1, contextWindow: 100 } }); }));
  const app = orchestrator();
  try {
    const compact = app.collaboration({ action: 'compact', ...target, threadId: 'oc_demo' });
    await vi.waitFor(() => expect(be.thread.compact).toHaveBeenCalled());
    await expect(app.collaboration({ action: 'clear', ...target, threadId: 'oc_demo' })).rejects.toThrow('正在运行');
    await expect(app.collaboration({ action: 'stop', ...target, threadId: 'oc_demo', runId: 'obsolete' })).rejects.toThrow('已经结束');
    finish(); await compact;
  } finally { await app.shutdown(); }
});
it('changes directory only after checking revision and archives old bindings without deleting history', async () => {
  backend(); const app = orchestrator();
  const directory = `${paths.appDir}/new`; await mkdir(directory, { recursive: true });
  try {
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision: 'stale', directory })).rejects.toThrow('已改变');
    const revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, directory, enabled: false });
    expect(await getProjectByName('demo')).toMatchObject({ cwd: await realpath(directory), enabled: false });
    expect(await getSession('oc_demo')).toBeUndefined();
    expect(await listSessions()).toMatchObject([{ sessionId: 'old', detached: true }]);
  } finally { await app.shutdown(); }
});
it('unbinds a joined project, preserves sessions and reports failed external leave honestly', async () => {
  backend(); const app = orchestrator(); fixture.leave.mockRejectedValueOnce(new Error('permission denied'));
  try {
    const expectedRevision = projectRevision((await getProjectByName('demo'))!);
    expect(await app.collaboration({ action: 'removeProject', ...target, expectedRevision })).toEqual({ ok: true, groupEffect: 'failed', warning: 'permission denied' });
    expect(await getProjectByName('demo')).toBeUndefined();
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'old' });
  } finally { await app.shutdown(); }
});
it('never applies a stale project target to another binding and refreshes actual usage', async () => {
  backend(); const app = orchestrator();
  try {
    await removeProject('demo');
    await addProject({ name: 'demo', chatId: 'oc_replacement', cwd: paths.appDir, blank: false, createdAt: 2 });
    await expect(app.collaboration({ action: 'history', ...target })).rejects.toThrow('已改变');
    expect(await app.collaboration({ action: 'usage', force: true })).toHaveProperty('data');
    expect(fixture.usage).toHaveBeenCalledWith(true);
  } finally { await app.shutdown(); }
});

it('creates under the configured root once and preserves idempotency across owner restart', async () => {
  backend();
  const create = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_created' } }));
  const channel = { send: fixture.send, rawClient: { im: { v1: { chat: { create }, chatManagers: { addManagers: vi.fn(async () => ({ code: 0 })) } } } } };
  let app = orchestrator(channel);
  const request = { action: 'createProject' as const, requestId: 'c848d29f-69db-4f53-849d-577453388ac7', name: 'created', kind: 'single' as const, backend: 'codex-appserver' as const };
  try {
    const replies = await Promise.all([app.collaboration(request), app.collaboration(request)]);
    expect(replies[0]).toEqual(replies[1]);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ params: { user_id_type: 'open_id', uuid: request.requestId }, data: { name: 'created', user_id_list: ['ou_owner'] } });
    expect(await getProjectByName('created')).toMatchObject({ cwd: join(paths.projectsRootDir, 'created'), creationRequestId: request.requestId });
    await app.shutdown(); app = orchestrator(channel);
    expect(await app.collaboration(request)).toEqual(replies[0]);
    expect(create).toHaveBeenCalledOnce();
    await expect(app.collaboration({ ...request, name: 'changed' })).rejects.toThrow('其他参数');
  } finally { await app.shutdown(); }
});
it('preserves role-separated guest context and refuses unsupported goal before posting to Feishu', async () => {
  const be = backend(); fixture.backend = { ...be, capabilities: { goal: false, compact: true, resume: true } };
  await upsertSession({ threadId: 'oc_demo#guest', chatId: 'oc_demo', cwd: paths.appDir, sessionId: 'guest-native', backend: 'codex-appserver', summary: 'guest', createdAt: 1, updatedAt: 1 });
  const app = orchestrator();
  try {
    await expect(app.collaboration({ action: 'compact', ...target, threadId: 'oc_demo#guest' })).rejects.toThrow('管理员会话');
    await expect(app.collaboration({ action: 'startGoal', ...target, threadId: 'oc_demo', objective: 'do work' })).rejects.toThrow('不支持');
    expect(fixture.send).not.toHaveBeenCalled();
    expect(await getSession('oc_demo#guest')).toMatchObject({ sessionId: 'guest-native' });
  } finally { await app.shutdown(); }
});

it('retains bound history when the backend history source is unavailable', async () => {
  const be = backend(); be.listThreads.mockRejectedValueOnce(new Error('backend offline'));
  const app = orchestrator();
  try { expect(await app.collaboration({ action: 'history', ...target })).toMatchObject({ sessions: [{ threadId: 'oc_demo' }], threads: [], threadsError: 'backend offline' }); }
  finally { await app.shutdown(); }
});

function incoming(threadId?: string) {
  return { messageId: `message-${Date.now()}-${Math.random()}`, chatId: target.chatId, chatType: 'group' as const, threadId,
    content: 'hello', senderId: 'ou_owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
it('restores live bindings when the project commit fails after archiving', async () => {
  backend(); const app = orchestrator();
  const expectedRevision = projectRevision((await getProjectByName('demo'))!);
  try {
    fixture.failProjectsWrite = true;
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision, kind: 'multi' })).rejects.toThrow('project disk failure');
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'old' });
    expect((await listSessions())[0]?.detached).not.toBe(true);
  } finally { fixture.failProjectsWrite = false; await app.shutdown(); }
});
it('fences detached topic preparation against directory, disable and remove mutations', async () => {
  const be = backend();
  await updateProject('demo', { kind: 'multi' });
  let rejectStart!: (error: Error) => void;
  be.startThread.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStart = reject; }));
  const app = orchestrator();
  try {
    await app.onMessage(incoming());
    await vi.waitFor(() => expect(be.startThread).toHaveBeenCalledOnce());
    const expectedRevision = projectRevision((await getProjectByName('demo'))!);
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision, directory: paths.appDir })).rejects.toThrow('正在执行');
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision, enabled: false })).rejects.toThrow('正在执行');
    await expect(app.collaboration({ action: 'removeProject', ...target, expectedRevision })).rejects.toThrow('正在执行');
    rejectStart(new Error('controlled start failure'));
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await app.collaboration({ action: 'editProject', ...target, expectedRevision, enabled: false })).toHaveProperty('ok', true));
  } finally { await app.shutdown(); }
});
it('fences visible topic replies until resume owns the resolved topic key', async () => {
  const be = backend(); await updateProject('demo', { kind: 'multi' });
  let resolveTopic!: (value: unknown) => void;
  const get = vi.fn(() => new Promise(resolve => { resolveTopic = resolve; }));
  const app = orchestrator({ send: fixture.send, rawClient: { im: { v1: { message: { get } } } } });
  try {
    const resuming = app.collaboration({ action: 'resume', ...target, sessionId: 'past', backend: be.id });
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    await app.onMessage(incoming('omt_published'));
    expect(be.startThread).not.toHaveBeenCalled();
    expect(be.resumeThread).not.toHaveBeenCalled();
    resolveTopic({ data: { items: [{ thread_id: 'omt_published' }] } });
    await expect(resuming).resolves.toMatchObject({ threadId: 'omt_published' });
    expect(await getSession('omt_published')).toMatchObject({ sessionId: 'past' });
    expect(be.thread.close).not.toHaveBeenCalled();
  } finally { await app.shutdown(); }
});
it('closes prepared backend work when a concurrent settings writer changes the project revision', async () => {
  const be = backend(); await updateProject('demo', { kind: 'multi' });
  let release!: (value: typeof be.thread) => void;
  be.startThread.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const app = orchestrator();
  try {
    await app.onMessage(incoming());
    await vi.waitFor(() => expect(be.startThread).toHaveBeenCalledOnce());
    await updateProject('demo', { enabled: false });
    release(be.thread);
    await vi.waitFor(() => expect(be.thread.close).toHaveBeenCalledOnce());
    expect(await listSessions()).toMatchObject([{ sessionId: 'old' }]);
    expect(fixture.send).not.toHaveBeenCalled();
  } finally { await app.shutdown(); }
});
it('recovers backend history after a kind change archives its old topic binding', async () => {
  const be = backend(); await updateProject('demo', { kind: 'multi' });
  const app = orchestrator();
  try {
    const expectedRevision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision, kind: 'single' });
    expect(await app.collaboration({ action: 'history', ...target })).toMatchObject({ sessions: [{ detached: true }], threads: [{ sessionId: 'past' }] });
    await app.collaboration({ action: 'resume', ...target, backend: be.id, sessionId: 'past' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'past' });
  } finally { await app.shutdown(); }
});

it('captures real bot-added events for desktop while retaining DM binding and clearing unbound removals', async () => {
  backend();
  const membership = vi.fn(async () => ({ code: 0, data: { is_in_chat: true } }));
  const chatInfo = vi.fn(async (chatId: string) => ({ chatId, name: 'New research group', chatType: 'group', ownerId: 'ou_owner' }));
  const channel = { send: fixture.send, botIdentity: { openId: 'ou_bot' }, getChatInfo: chatInfo, rawClient: { im: { v1: { chatMembers: { isInChat: membership } } } } };
  const app = orchestrator(channel);
  const file = pendingGroupsFile(paths.projectsFile);
  try {
    await app.onBotAddedToChat({ chatId: 'oc_nonadmin', operator: { openId: 'ou_guest' } });
    await app.onBotAddedToChat({ chatId: 'oc_demo', operator: { openId: 'ou_owner' } });
    expect(await readPendingGroups(file)).toEqual([]);
    expect(fixture.send).not.toHaveBeenCalled();
    await app.onBotAddedToChat({ chatId: 'oc_new_event', operator: { openId: 'ou_owner' } });
    await vi.waitFor(async () => expect(await readPendingGroups(file)).toEqual([
      expect.objectContaining({ chatId: 'oc_new_event', operator: 'ou_owner', state: 'ready', name: 'New research group', addedAt: expect.any(Number) }),
    ]));
    expect(membership).toHaveBeenCalledWith({ path: { chat_id: 'oc_new_event' } });
    expect(fixture.send).toHaveBeenCalledWith(channel, 'ou_owner', expect.any(Object), undefined, false, 'open_id');
    expect(JSON.stringify(fixture.send.mock.calls)).toContain('oc_new_event');
    expect(JSON.stringify(fixture.send.mock.calls)).toContain('New research group');
    await app.onBotRemovedFromChat('oc_new_event');
    expect(await readPendingGroups(file)).toEqual([]);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    await writeFile(file, '{');
    await app.onBotAddedToChat({ chatId: 'oc_queue_failure', operator: { openId: 'ou_owner' } });
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fixture.send.mock.calls.at(-1))).toContain('oc_queue_failure');
  } finally { await app.shutdown(); }
});
