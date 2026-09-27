import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { paths } from '../src/config/paths';
import { saveConfig, loadConfig } from '../src/config/store';
import { createAppPreferencesWriter, createAdminWriteExecutor } from '../src/admin/ops';
import { createSettingsOwner, type SettingsOwnerDeps } from '../src/admin/settings';
import { parseSettingsEdit, parseSettingsAction } from '../src/admin/settings-parse';
import type { AgentSettingsView, ProjectSettingsView, SessionSettingsView } from '../src/admin/settings-types';
import { addProject, getProjectByName, updateProject } from '../src/project/registry';
import { getSession, upsertSession } from '../src/bot/session-store';
import { createAdminIpcCaller, createAdminIpcResponder } from '../src/admin/ipc';
import type { AppConfig } from '../src/config/schema';
import type { AgentBackend } from '../src/agent/types';

vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'settings-owner-'));
  return { paths: { appDir, configFile: join(appDir, 'config.json'), projectsFile: join(appDir, 'projects.json'), sessionsFile: join(appDir, 'sessions.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments') } };
});
const botId = 'cli_fixture';
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const session = { kind: 'session' as const, botId, threadId: 'omt_fixture' };
const backend = { id: 'codex-appserver', doctor: async () => ({ ok: true }), supportedModes: ['qa', 'write', 'full'], listModels: async () => [{ id: 'fixture-model', displayName: 'Fixture', description: '', defaultEffort: 'high', supportedEfforts: ['low', 'high'], isDefault: true, hidden: false }] } as unknown as AgentBackend;
const hooks = { inspect: async () => ({ claude: { agent: 'claude' as const, status: 'installed' as const, details: [] }, codex: { agent: 'codex' as const, status: 'installed' as const, details: [] } }), install: vi.fn(async () => {}) };
let cfg: AppConfig;
async function fixture(overrides: Partial<SettingsOwnerDeps> = {}) {
  const writer = createAppPreferencesWriter({ cfg });
  return { writer, owner: createSettingsOwner({ cfg, writePreferences: writer, backendFor: () => backend, evictLiveSessionsForChat: vi.fn(async () => {}), hooks, ...overrides }) };
}
beforeEach(async () => {
  await rm(paths.appDir, { recursive: true, force: true }); await mkdir(paths.appDir, { recursive: true });
  cfg = JSON.parse(JSON.stringify({ accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 'fixture-secret' } } }, secrets: { providers: { sentinel: { source: 'env', allowlist: ['SECRET'] } } }, futureRoot: 17, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_admin'], unknownAccess: 'preserve' }, completionReminder: { mode: 'long', longTaskMinutes: 3, future: true }, cliBridge: { enabled: false, presence: { future: 8 } }, sessionTitles: { future: 'keep', byBackend: { 'codex-appserver': { enabled: true, model: 'custom-title', effort: 'high', future: 3 } } }, futurePreference: true } }));
  await saveConfig(cfg);
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', createdAt: 1, blank: false });
  await upsertSession({ threadId: session.threadId, chatId: 'oc_demo', sessionId: 'native-one', backend: 'codex-appserver', cwd: '/tmp/demo', model: 'fixture-model', effort: 'high', createdAt: 1, updatedAt: 1, summary: '' });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));
describe('strict boundaries', () => {
  it.each([{ maxConcurrentRuns: '2' }, { runIdleTimeoutSeconds: 1 }, { runIdleTimeoutSeconds: 3601 }, { pendingPolicy: 'other' }, { ownerOpenId: 'ou_steal' }])('rejects malformed run edits %j', patch => expect(() => parseSettingsEdit({ scope: agent, section: 'run', revision: 'x', patch })).toThrow());
  it('rejects wrong action values and arbitrary fields', () => {
    expect(() => parseSettingsAction({ kind: 'setCliBridgeEnabled', botId, enabled: 'true', revision: 'x' })).toThrow();
    expect(() => parseSettingsAction({ kind: 'adminMember', botId, openId: 'bad', membership: 'present', revision: 'x' })).toThrow();
    expect(() => parseSettingsEdit({ scope: agent, section: 'cliBridge', revision: 'x', patch: { includeBridgeOwnedSessionsForDebugging: true } })).toThrow();
  });
});
it('serializes card and HTTP preference edits, preserves unknown nested keys and secrets, reports running concurrency', async () => {
  const { owner, writer } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  const [save] = await Promise.all([owner.save({ scope: agent, section: 'run', revision: view.sections.run.revision, patch: { maxConcurrentRuns: 7 } }), writer(p => { p.showToolCalls = false; })]);
  expect(save.kind).toBe('saved');
  const fresh = await owner.read(agent) as AgentSettingsView;
  expect(fresh.sections.run.stored.maxConcurrentRuns).toBe(7); expect(fresh.sections.run.effective.maxConcurrentRuns).toBe(10);
  expect(fresh.sections.cards.effective.showToolCalls).toBe(false);
  await owner.save({ scope: agent, section: 'completion', revision: fresh.sections.completion.revision, patch: { mode: 'always' } });
  await owner.save({ scope: agent, section: 'cliBridge', revision: fresh.sections.cliBridge.revision, patch: { presence: { enabled: true, platform: 'auto', idleThresholdSeconds: 77 } } });
  await owner.save({ scope: agent, section: 'titles', revision: fresh.sections.titles.revision, patch: { byBackend: { 'codex-appserver': { enabled: false } } } });
  const disk = await loadConfig() as AppConfig & { futureRoot: number };
  expect(disk.accounts).toEqual(cfg.accounts); expect(disk.secrets).toEqual(cfg.secrets); expect(disk.futureRoot).toBe(17);
  expect(disk.preferences?.completionReminder).toMatchObject({ future: true, mode: 'always' });
  expect(disk.preferences?.cliBridge?.presence).toMatchObject({ future: 8, idleThresholdSeconds: 77 });
  expect(disk.preferences?.sessionTitles?.byBackend?.['codex-appserver']).toMatchObject({ model: 'custom-title', future: 3, enabled: false });
  expect(JSON.stringify(fresh)).not.toMatch(/fixture-secret|SECRET|futurePreference|futureRoot/);
});
it('checks same-section revision inside owner queue', async () => {
  const { owner } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  const results = await Promise.all([5, 6].map(maxConcurrentRuns => owner.save({ scope: agent, section: 'run', revision: view.sections.run.revision, patch: { maxConcurrentRuns } })));
  expect(results.map(r => r.kind)).toEqual(['saved', 'conflict']);
});
it('rejects external file changes and leaves LIVE untouched', async () => {
  const { owner } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  await saveConfig({ ...cfg, preferences: { ...cfg.preferences, showToolCalls: false } });
  const result = await owner.save({ scope: agent, section: 'run', revision: view.sections.run.revision, patch: { maxConcurrentRuns: 5 } });
  expect(result.kind).toBe('rejected'); expect(cfg.preferences?.maxConcurrentRuns).toBeUndefined(); expect((await loadConfig()).preferences?.showToolCalls).toBe(false);
});
it('failed persistence cannot mutate nested live preferences', async () => {
  const write = createAppPreferencesWriter({ cfg, persistConfig: async () => { throw new Error('disk'); } });
  await expect(write(p => { p.cliBridge!.presence!.enabled = false; })).rejects.toThrow();
  expect(cfg.preferences?.cliBridge?.presence?.enabled).toBeUndefined();
});
it('validates models, allows custom title ids, resets actual project and session overrides', async () => {
  const { owner } = await fixture(); let p = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'missing', effort: 'high' } } })).kind).toBe('rejected');
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'high' } } })).kind).toBe('saved');
  p = await owner.read(project) as ProjectSettingsView;
  await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'default' } } });
  expect((await getProjectByName('demo'))?.defaultModel).toBeUndefined();
  const s = await owner.read(session) as SessionSettingsView;
  await owner.save({ scope: session, section: 'model', revision: s.sections.model.revision, patch: { selection: { kind: 'default' } } });
  expect(await getSession(session.threadId)).not.toHaveProperty('model'); expect(await getSession(session.threadId)).not.toHaveProperty('effort');
  const a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.save({ scope: agent, section: 'titles', revision: a.sections.titles.revision, patch: { byBackend: { 'codex-appserver': { enabled: true, model: 'third-party-custom', effort: 'ultra' } } } })).kind).toBe('saved');
});
it('stale resume identity conflicts and cannot change the replacement session', async () => {
  const { owner } = await fixture(); const old = await owner.read(session) as SessionSettingsView;
  const rec = (await getSession(session.threadId))!; await upsertSession({ ...rec, sessionId: 'native-two' });
  expect((await owner.save({ scope: session, section: 'model', revision: old.sections.model.revision, patch: { selection: { kind: 'default' } } })).kind).toBe('conflict');
  expect((await getSession(session.threadId))?.model).toBe('fixture-model');
});
it('membership operations retain owner and preserve concurrent project edits', async () => {
  const { owner } = await fixture(); const a = await owner.read(agent) as AgentSettingsView;
  expect((await owner.act({ kind: 'adminMember', botId, openId: 'ou_owner', membership: 'absent', revision: a.administrators.revision })).kind).toBe('rejected');
  const p = await owner.read(project) as ProjectSettingsView;
  await updateProject('demo', { autoCompact: false });
  expect((await owner.act({ kind: 'projectMember', botId, projectName: 'demo', openId: 'ou_member', membership: 'present', revision: p.members.revision })).kind).toBe('saved');
  const now = await owner.read(project) as ProjectSettingsView;
  await owner.act({ kind: 'projectMember', botId, projectName: 'demo', openId: 'ou_member', membership: 'absent', revision: now.members.revision });
  expect(await getProjectByName('demo')).toMatchObject({ autoCompact: false, allowedUsers: [] });
});
it.each([false, true])('CLI persist failure compensates runtime; compensation failure=%s is explicit', async failedRollback => {
  const start = vi.fn(async () => {}); const shutdown = vi.fn(async () => { if (failedRollback) throw new Error('stop failed'); });
  const { owner } = await fixture({ cliBridge: { start, shutdown }, writePreferences: createAppPreferencesWriter({ cfg, persistConfig: async () => { throw new Error('disk'); } }) });
  const view = await owner.read(agent) as AgentSettingsView;
  const result = await owner.act({ kind: 'setCliBridgeEnabled', botId, enabled: true, revision: view.cliRuntime.revision });
  expect(result.kind).toBe(failedRollback ? 'diverged' : 'rejected'); expect(start).toHaveBeenCalledOnce(); expect(shutdown).toHaveBeenCalledOnce(); expect(cfg.preferences?.cliBridge?.enabled).toBe(false);
});
it('comment partial propagation reports saved master and retryable warning', async () => {
  let text = 'original';
  const { owner } = await fixture({ instructions: { read: async () => text, save: async next => { text = next; }, sync: async () => { throw new Error('partial'); } } });
  const view = await owner.read(agent) as AgentSettingsView;
  const result = await owner.act({ kind: 'commentInstructions', botId, revision: view.commentInstructions.revision, content: { kind: 'custom', text: 'Updated {fileToken}' } });
  expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.warnings).toHaveLength(1); expect(text).toBe('Updated {fileToken}');
});
it('returns the exact settings result through executor and real IPC responder', async () => {
  const { owner } = await fixture(); const executor = createAdminWriteExecutor({ settings: owner, backendFor: () => backend, evictLiveSessionsForChat: async () => {} });
  const caller = createAdminIpcCaller(request => responder(request));
  const responder = createAdminIpcResponder(op => op.kind === 'settingsRead' ? owner.read(op.scope) : executor(op as Parameters<typeof executor>[0]), response => caller.onMessage(response));
  const view = await caller.call({ kind: 'settingsRead', scope: agent }) as AgentSettingsView;
  const result = await caller.call({ kind: 'settingsPatch', edit: { scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } } });
  expect(result).toMatchObject({ kind: 'saved', section: { section: 'cards', value: { stored: { showToolCalls: false } } } });
});
it('authenticated HTTP preserves result unions and rejects malformed or cross-agent requests', async () => {
  const { createWebServer } = await import('../src/web/server');
  const { owner } = await fixture();
  const service = { settings: owner } as import('../src/admin/service').AdminService;
  const server = createWebServer({ service, token: 'fixture-token' });
  const { port } = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const request = (route: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method, headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  try {
    const route = `/api/bots/${botId}/settings`;
    expect((await fetch(base + route)).status).toBe(401);
    expect((await request(route, 'GET', undefined, { Origin: 'https://evil.invalid' })).status).toBe(403);
    const view = await (await request(route)).json() as AgentSettingsView;
    const input = { revision: view.sections.run.revision, patch: { maxConcurrentRuns: 3 } };
    const result = await request(route + '/run', 'PATCH', input);
    expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ kind: 'saved', section: { value: { stored: { maxConcurrentRuns: 3 } } } });
    expect((await request(route + '/run', 'PATCH', input)).status).toBe(409);
    expect((await request(route + '/run', 'PATCH', { ...input, patch: { maxConcurrentRuns: '5' } })).status).toBe(400);
    expect((await request(route + '/actions', 'POST', { kind: 'repairCliHooks', botId: 'cli_other' })).status).toBe(400);
    const projectView = await (await request('/api/project/demo/settings?bot=cli_fixture')).json() as ProjectSettingsView;
    expect((await request('/api/project/demo/settings?bot=cli_fixture', 'PATCH', { section: 'compact', revision: projectView.sections.compact.revision, patch: { autoCompact: false } })).status).toBe(200);
    expect((await request('/api/project/demo/no-mention?bot=cli_fixture', 'POST', { on: 'yes' })).status).toBe(400);
    expect((await request(`/api/bots/${botId}/sessions/missing/settings`)).status).toBe(404);
  } finally { await server.close(); }
});
it('readonly owner never permits writes; failed catalogs do not disable unrelated settings', async () => {
  const { owner: readonly } = await fixture({ access: { kind: 'readonly', reason: 'owner-offline', message: 'Stopped' } });
  const view = await readonly.read(agent) as AgentSettingsView;
  expect((await readonly.save({ scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('unavailable');
  const { owner } = await fixture({ backendFor: () => ({ ...backend, listModels: async () => { throw new Error('private diagnostics'); } }) });
  const p = await owner.read(project) as ProjectSettingsView;
  expect((await owner.save({ scope: project, section: 'model', revision: p.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'high' } } })).kind).toBe('rejected');
  expect((await owner.save({ scope: agent, section: 'cards', revision: view.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
  expect(JSON.stringify(await owner.models({ botId, backend: 'codex-appserver', purpose: 'project' }))).not.toContain('private diagnostics');
});
it('CLI desired-state retries start once and repair hooks reports each failed backend', async () => {
  const start = vi.fn(async () => {}); const shutdown = vi.fn(async () => {});
  const install = vi.fn(async (options: import('../src/cli-bridge/hooks').InstallCliBridgeHooksOptions) => { if ((options as { agents: { claude: boolean } }).agents.claude) throw new Error('claude readonly'); });
  const { owner } = await fixture({ cliBridge: { start, shutdown }, hooks: { inspect: hooks.inspect, install } });
  const view = await owner.read(agent) as AgentSettingsView;
  const action = { kind: 'setCliBridgeEnabled' as const, botId, enabled: true, revision: view.cliRuntime.revision };
  expect((await owner.act(action)).kind).toBe('saved'); expect((await owner.act(action)).kind).toBe('saved'); expect(start).toHaveBeenCalledOnce();
  const result = await owner.act({ kind: 'repairCliHooks', botId });
  expect(install).toHaveBeenCalledTimes(2); if (result.kind === 'saved') expect(result.warnings).toHaveLength(1); else throw new Error(result.kind);
});
it('project persistence survives failed runtime eviction with an explicit restart effect', async () => {
  const { owner } = await fixture({ evictLiveSessionsForChat: async () => { throw new Error('busy'); } });
  const view = await owner.read(project) as ProjectSettingsView;
  const result = await owner.save({ scope: project, section: 'compact', revision: view.sections.compact.revision, patch: { autoCompact: false } });
  expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.effects.some(e => e.when === 'restart')).toBe(true);
  expect((await getProjectByName('demo'))?.autoCompact).toBe(false);
});
it('real instruction propagation retains saved master and reports partial filesystem failure', async () => {
  const { join } = await import('node:path');
  const healthy = join(paths.commentsRootDir, 'comment-docx-healthy');
  const broken = join(paths.commentsRootDir, 'comment-docx-broken');
  await mkdir(healthy, { recursive: true }); await mkdir(join(broken, 'AGENTS.md'), { recursive: true });
  const { owner } = await fixture(); const view = await owner.read(agent) as AgentSettingsView;
  const result = await owner.act({ kind: 'commentInstructions', botId, revision: view.commentInstructions.revision, content: { kind: 'custom', text: 'Use {fileToken} safely' } });
  expect(result.kind).toBe('saved'); if (result.kind === 'saved') expect(result.warnings).toHaveLength(1);
  expect(await readFile(paths.commentInstructionsFile, 'utf8')).toBe('Use {fileToken} safely');
  expect(await readFile(join(healthy, 'AGENTS.md'), 'utf8')).toBe('Use healthy safely');
});
