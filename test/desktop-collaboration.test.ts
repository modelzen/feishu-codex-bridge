import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { rm, mkdir, realpath } from 'node:fs/promises';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { addProject, getProjectByName, removeProject } from '../src/project/registry';
import { getSession, listSessions, upsertSession } from '../src/bot/session-store';
import { createOrchestrator } from '../src/bot/handle-message';
import { parseCollaborationRequest, projectRevision } from '../src/admin/collaboration';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'desktop-collaboration-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') } };
});
const fixture = vi.hoisted(() => ({ backend: undefined as unknown, leave: vi.fn(), send: vi.fn(async () => ({ messageId: 'om_sent' })), usage: vi.fn(async () => ({ profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: { name: 'main', windows: [] }, extras: [], fetchedAt: 1 } })) }));
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
  await rm(paths.projectsFile, { force: true }); await rm(paths.sessionsFile, { force: true });
  fixture.leave.mockReset(); fixture.send.mockClear();
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: paths.appDir, kind: 'single', blank: false, origin: 'joined', createdAt: 1, backend: 'codex-appserver' });
  await upsertSession({ threadId: 'oc_demo', chatId: 'oc_demo', cwd: paths.appDir, sessionId: 'old', backend: 'codex-appserver', summary: 'old', createdAt: 1, updatedAt: 1 });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));
it('rejects untrusted identity, extra fields and relative paths at the HTTP boundary', () => {
  expect(() => parseCollaborationRequest({ action: 'context', ...target, threadId: 'oc_demo', owner: 'ou_fake' })).toThrow();
  expect(() => parseCollaborationRequest({ action: 'editProject', ...target, expectedRevision: 'revision', directory: '../escape' })).toThrow();
  expect(parseCollaborationRequest({ action: 'usage', force: true })).toEqual({ action: 'usage', force: true });
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
    expect(await getProjectByName('created')).toMatchObject({ cwd: `${paths.projectsRootDir}/created`, creationRequestId: request.requestId });
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
