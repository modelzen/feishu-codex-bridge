import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/config/paths';
import { loadConfig, saveConfig } from '../src/config/store';
import { createAppPreferencesWriter } from '../src/admin/ops';
import { createSettingsOwner } from '../src/admin/settings';
import { parseSettingsEdit } from '../src/admin/settings-parse';
import type { AgentSettingsView, ProjectSettingsView, SessionSettingsView, SettingsEdit, SettingsOwnerDeps } from '../src/admin/settings';
import { addProject, getProjectByName } from '../src/project/registry';
import { getSession, upsertSession } from '../src/bot/session-store';
import type { AppConfig } from '../src/config/schema';
import type { AgentBackend } from '../src/agent/types';

vi.mock('../src/config/paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'settings-parity-'));
  return { paths: { appDir: root, configFile: join(root, 'config.json'), projectsFile: join(root, 'projects.json'), sessionsFile: join(root, 'sessions.json'), commentInstructionsFile: join(root, 'instructions.md'), commentsRootDir: join(root, 'comments') } };
});

const botId = 'cli_fixture';
const agent = { kind: 'agent' as const, botId };
const project = { kind: 'project' as const, botId, projectName: 'demo' };
const session = { kind: 'session' as const, botId, threadId: 'omt_fixture' };
const backend = { id: 'codex-appserver', doctor: async () => ({ ok: true }), supportedModes: ['qa', 'write', 'full'], listModels: async () => [{ id: 'fixture-model', displayName: 'Fixture', description: '', defaultEffort: 'high', supportedEfforts: ['medium', 'high'], isDefault: true, hidden: false }] } as unknown as AgentBackend;
const hooks = { inspect: async () => ({ claude: { agent: 'claude' as const, status: 'installed' as const, details: [] }, codex: { agent: 'codex' as const, status: 'installed' as const, details: [] } }), install: vi.fn(async () => {}) };
let cfg: AppConfig;

async function owner(overrides: Partial<SettingsOwnerDeps> = {}) {
  return createSettingsOwner({ cfg, writePreferences: createAppPreferencesWriter({ cfg }), backendFor: () => backend, evictLiveSessionsForChat: vi.fn(async () => {}), hooks, ...overrides });
}

beforeEach(async () => {
  await rm(paths.appDir, { recursive: true, force: true });
  await mkdir(paths.appDir, { recursive: true });
  cfg = JSON.parse(JSON.stringify({ accounts: { app: { id: botId, tenant: 'feishu', secret: { source: 'exec', id: 'fixture-secret' } } }, secrets: { providers: { sentinel: { source: 'env', allowlist: ['SECRET'] } } }, futureRoot: 17, preferences: { access: { ownerOpenId: 'ou_owner', admins: ['ou_admin'], future: 3 }, cliBridge: { enabled: false, presence: { future: 9 } }, comments: { future: 'retain' }, futurePreference: true } }));
  await saveConfig(cfg);
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: '/tmp/demo', createdAt: 1, blank: false });
  await addProject({ name: 'other', chatId: 'oc_other', cwd: '/tmp/other', createdAt: 2, blank: false, noMention: false, mode: 'qa', guestMode: 'qa', network: false });
  await upsertSession({ threadId: session.threadId, chatId: 'oc_demo', sessionId: 'native-one', backend: 'codex-appserver', cwd: '/tmp/demo', model: 'fixture-model', effort: 'high', createdAt: 1, updatedAt: 1, summary: '' });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));

const agentCases = [
  { id: 'CARD-019', section: 'access', patch: { allowedChats: ['oc_demo'] }, field: 'access.allowedChats', expected: ['oc_demo'] },
  { id: 'CARD-020', section: 'cards', patch: { showToolCalls: false }, field: 'showToolCalls', expected: false },
  { id: 'CARD-021', section: 'cards', patch: { showModel: 'running' }, field: 'showModel', expected: 'running' },
  { id: 'CARD-022', section: 'run', patch: { maxConcurrentRuns: 50 }, field: 'maxConcurrentRuns', expected: 50 },
  { id: 'CARD-023', section: 'run', patch: { runIdleTimeoutSeconds: 3600 }, field: 'runIdleTimeoutSeconds', expected: 3600 },
  { id: 'CARD-024', section: 'run', patch: { pendingPolicy: 'queue' }, field: 'pendingPolicy', expected: 'queue' },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'failures' }, field: 'completionReminder.mode', expected: 'failures' },
  { id: 'CARD-026', section: 'completion', patch: { longTaskMinutes: 1440 }, field: 'completionReminder.longTaskMinutes', expected: 1440 },
  { id: 'CARD-029', section: 'cliBridge', patch: { notifyScope: 'bound_projects' }, field: 'cliBridge.notifyScope', expected: 'bound_projects' },
  { id: 'CARD-030', section: 'cliBridge', patch: { agents: { claude: false, codex: true } }, field: 'cliBridge.agents', expected: { claude: false, codex: true } },
  { id: 'CARD-031', section: 'cliBridge', patch: { keepAwake: { enabled: true } }, field: 'cliBridge.keepAwake.enabled', expected: true },
  { id: 'CARD-032', section: 'cliBridge', patch: { approval: { enabled: true, timeoutSeconds: 86400 } }, field: 'cliBridge.approval', expected: { enabled: true, timeoutSeconds: 86400 } },
  { id: 'CARD-033', section: 'cliBridge', patch: { taskCompletion: { enabled: true, replyEnabled: true, replyTimeoutSeconds: 86400 } }, field: 'cliBridge.taskCompletion', expected: { enabled: true, replyEnabled: true, replyTimeoutSeconds: 86400 } },
  { id: 'CARD-034', section: 'cliBridge', patch: { allowCache: { enabled: true, scope: 'session' } }, field: 'cliBridge.allowCache', expected: { enabled: true, scope: 'session' } },
  { id: 'CARD-035', section: 'cliBridge', patch: { presence: { enabled: true, platform: 'auto', idleThresholdSeconds: 3600 } }, field: 'cliBridge.presence.idleThresholdSeconds', expected: 3600 },
  { id: 'CARD-039', section: 'paths', patch: { projectsRootDir: '/tmp/parity-projects' }, field: 'projectsRootDir', expected: '/tmp/parity-projects' },
] as const;

function getField(record: unknown, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], record);
}

describe('agent settings persist in config.json and preserve unrelated data', () => {
  it.each(agentCases)('$id $field', async ({ section, patch, field, expected }) => {
    const settings = await owner();
    const before = await settings.read(agent) as AgentSettingsView;
    const original = JSON.parse(await readFile(paths.configFile, 'utf8'));
    const result = await settings.save({ scope: agent, section, revision: before.sections[section].revision, patch } as SettingsEdit);
    expect(result.kind).toBe('saved');
    const disk = await loadConfig() as AppConfig & { futureRoot: number };
    expect(getField(disk.preferences, field)).toEqual(expected);
    expect(disk.accounts).toEqual(original.accounts);
    expect(disk.secrets).toEqual(original.secrets);
    expect(disk.futureRoot).toBe(17);
    expect((disk.preferences as Record<string, unknown>).futurePreference).toBe(true);
    const after = await settings.read(agent) as AgentSettingsView;
    expect(getField(after.sections[section].stored, field.includes('.') ? field.slice(field.indexOf('.') + 1) : field)).toEqual(expected);
  });
});

const edgeCases = [
  { id: 'CARD-021', section: 'cards', patch: { showModel: 'off' }, field: 'showModel', expected: 'off' },
  { id: 'CARD-021', section: 'cards', patch: { showModel: 'always' }, field: 'showModel', expected: 'always' },
  { id: 'CARD-022', section: 'run', patch: { maxConcurrentRuns: 1 }, field: 'maxConcurrentRuns', expected: 1 },
  { id: 'CARD-023', section: 'run', patch: { runIdleTimeoutSeconds: 0 }, field: 'runIdleTimeoutSeconds', expected: 0 },
  { id: 'CARD-023', section: 'run', patch: { runIdleTimeoutSeconds: 10 }, field: 'runIdleTimeoutSeconds', expected: 10 },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'manual' }, field: 'completionReminder.mode', expected: 'manual' },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'long' }, field: 'completionReminder.mode', expected: 'long' },
  { id: 'CARD-025', section: 'completion', patch: { mode: 'always' }, field: 'completionReminder.mode', expected: 'always' },
  { id: 'CARD-026', section: 'completion', patch: { longTaskMinutes: 1 }, field: 'completionReminder.longTaskMinutes', expected: 1 },
  { id: 'CARD-029', section: 'cliBridge', patch: { notifyScope: 'all' }, field: 'cliBridge.notifyScope', expected: 'all' },
  { id: 'CARD-029', section: 'cliBridge', patch: { notifyScope: 'none' }, field: 'cliBridge.notifyScope', expected: 'none' },
  { id: 'CARD-030', section: 'cliBridge', patch: { agents: { claude: true, codex: false } }, field: 'cliBridge.agents', expected: { claude: true, codex: false } },
  { id: 'CARD-032', section: 'cliBridge', patch: { approval: { enabled: false, timeoutSeconds: 1 } }, field: 'cliBridge.approval', expected: { enabled: false, timeoutSeconds: 1 } },
  { id: 'CARD-033', section: 'cliBridge', patch: { taskCompletion: { enabled: false, replyEnabled: false, replyTimeoutSeconds: 1 } }, field: 'cliBridge.taskCompletion', expected: { enabled: false, replyEnabled: false, replyTimeoutSeconds: 1 } },
  { id: 'CARD-035', section: 'cliBridge', patch: { presence: { enabled: false, platform: 'macos', idleThresholdSeconds: 10 } }, field: 'cliBridge.presence', expected: { future: 9, enabled: false, platform: 'macos', idleThresholdSeconds: 10 } },
] as const;

it.each(edgeCases)('$id accepts $section boundary $field', async ({ section, patch, field, expected }) => {
  const settings = await owner();
  const before = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({ scope: agent, section, revision: before.sections[section].revision, patch } as SettingsEdit)).kind).toBe('saved');
  expect(getField((await loadConfig()).preferences, field)).toEqual(expected);
});

const projectCases = [
  { id: 'CARD-010', section: 'response', patch: { noMention: true }, field: 'noMention', expected: true },
  { id: 'CARD-011', section: 'compact', patch: { autoCompact: false }, field: 'autoCompact', expected: false },
  { id: 'CARD-012', section: 'permission', patch: { mode: 'write' }, field: 'mode', expected: 'write' },
  { id: 'CARD-013', section: 'permission', patch: { guestMode: 'qa' }, field: 'guestMode', expected: 'qa' },
  { id: 'CARD-014', section: 'permission', patch: { network: true }, field: 'network', expected: true },
] as const;

describe('project settings persist in projects.json and isolate group scope', () => {
  it.each(projectCases)('$id $field', async ({ section, patch, field, expected }) => {
    const evict = vi.fn(async () => {});
    const settings = await owner({ evictLiveSessionsForChat: evict });
    const before = await settings.read(project) as ProjectSettingsView;
    const other = await getProjectByName('other');
    const result = await settings.save({ scope: project, section, revision: before.sections[section].revision, patch } as SettingsEdit);
    expect(result.kind).toBe('saved');
    expect(getField(await getProjectByName('demo'), field)).toEqual(expected);
    if (section === 'permission' || section === 'compact') {
      expect(evict).toHaveBeenCalledOnce();
      expect(evict).toHaveBeenCalledWith('oc_demo');
    }
    else expect(evict).not.toHaveBeenCalled();
    expect(await getProjectByName('other')).toEqual(other);
  });
});

it.each(['qa', 'write', 'full'] as const)('CARD-012/013 accepts supported %s permission for administrator and member', async mode => {
  const settings = await owner();
  const before = await settings.read(project) as ProjectSettingsView;
  expect((await settings.save({ scope: project, section: 'permission', revision: before.sections.permission.revision, patch: { mode, guestMode: mode } })).kind).toBe('saved');
  expect(await getProjectByName('demo')).toMatchObject({ mode, guestMode: mode });
});

it('CARD-015 CARD-016 validates model and effort before changing the new-session default', async () => {
  const settings = await owner();
  const before = await settings.read(project) as ProjectSettingsView;
  for (const invalid of [{ kind: 'explicit', model: 'missing', effort: 'high' }, { kind: 'explicit', model: 'fixture-model', effort: 'ultra' }]) {
    expect((await settings.save({ scope: project, section: 'model', revision: before.sections.model.revision, patch: { selection: invalid } } as SettingsEdit)).kind).toBe('rejected');
    expect((await getProjectByName('demo'))?.defaultModel).toBeUndefined();
  }
  expect((await settings.save({ scope: project, section: 'model', revision: before.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'medium' } } })).kind).toBe('saved');
  expect(await getProjectByName('demo')).toMatchObject({ defaultModel: 'fixture-model', defaultEffort: 'medium' });
  expect((await getSession(session.threadId))?.effort).toBe('high');
});

it('CARD-017 CARD-018 handles members, audience and immutable owner with persisted revisions', async () => {
  const settings = await owner();
  let p = await settings.read(project) as ProjectSettingsView;
  expect((await settings.act({ kind: 'projectMember', botId, projectName: 'demo', openId: 'ou_member', membership: 'present', revision: p.members.revision })).kind).toBe('saved');
  p = await settings.read(project) as ProjectSettingsView;
  expect(p.members.openIds).toEqual(['ou_member']);
  expect((await settings.act({ kind: 'projectAudience', botId, projectName: 'demo', audience: 'all', revision: p.members.revision })).kind).toBe('saved');
  expect((await getProjectByName('demo'))?.allowedUsers).toEqual([]);
  let a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'adminMember', botId, openId: 'ou_owner', membership: 'absent', revision: a.administrators.revision })).kind).toBe('rejected');
  expect((await settings.act({ kind: 'adminMember', botId, openId: 'ou_test', membership: 'present', revision: a.administrators.revision })).kind).toBe('saved');
  a = await settings.read(agent) as AgentSettingsView;
  expect(a.administrators.openIds).toContain('ou_test');
  expect((await loadConfig()).preferences?.access?.admins).toContain('ou_test');
  expect(a.ownerOpenId).toBe('ou_owner');
});

it('CARD-022 CARD-023 CARD-026 CARD-032 CARD-033 CARD-035 rejects out-of-range values without writing', async () => {
  const invalid = [
    ['run', { maxConcurrentRuns: 0 }], ['run', { maxConcurrentRuns: 51 }], ['run', { maxConcurrentRuns: 1.5 }],
    ['run', { runIdleTimeoutSeconds: 9 }], ['run', { runIdleTimeoutSeconds: 3601 }],
    ['completion', { longTaskMinutes: 0 }], ['completion', { longTaskMinutes: 1441 }],
    ['cliBridge', { approval: { enabled: true, timeoutSeconds: 0 } }],
    ['cliBridge', { approval: { enabled: true, timeoutSeconds: 86401 } }],
    ['cliBridge', { taskCompletion: { enabled: true, replyEnabled: true, replyTimeoutSeconds: 0 } }],
    ['cliBridge', { taskCompletion: { enabled: true, replyEnabled: true, replyTimeoutSeconds: 86401 } }],
    ['cliBridge', { presence: { enabled: true, platform: 'auto', idleThresholdSeconds: 9 } }],
    ['cliBridge', { presence: { enabled: true, platform: 'auto', idleThresholdSeconds: 3601 } }],
  ] as const;
  const before = await readFile(paths.configFile, 'utf8');
  for (const [section, patch] of invalid) {
    expect(() => parseSettingsEdit({ scope: agent, section, revision: 'revision', patch })).toThrow();
  }
  expect(await readFile(paths.configFile, 'utf8')).toBe(before);
});

it('CARD-027 CARD-028 dispatches voice actions, starts CLI once, repairs both hook backends and disables', async () => {
  const voiceAction = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  const shutdown = vi.fn(async () => {});
  const settings = await owner({ voiceAction, cliBridge: { start, shutdown } });
  for (const action of ['enable', 'test', 'refreshPermission', 'disable'] as const) {
    expect((await settings.act({ kind: 'voice', botId, action: { action } })).kind).toBe('saved');
  }
  expect(voiceAction.mock.calls.map(call => (call as unknown as [{ action: string }])[0].action)).toEqual(['enable', 'test', 'refreshPermission', 'disable']);
  const before = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'setCliBridgeEnabled', botId, enabled: true, revision: before.cliRuntime.revision })).kind).toBe('saved');
  expect(start).toHaveBeenCalledOnce();
  expect((await loadConfig()).preferences?.cliBridge?.enabled).toBe(true);
  hooks.install.mockClear();
  expect((await settings.act({ kind: 'repairCliHooks', botId })).kind).toBe('saved');
  expect(hooks.install.mock.calls).toHaveLength(2);
  const enabled = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'setCliBridgeEnabled', botId, enabled: false, revision: enabled.cliRuntime.revision })).kind).toBe('saved');
  expect(shutdown).toHaveBeenCalledOnce();
  expect((await loadConfig()).preferences?.cliBridge?.enabled).toBe(false);
});

it('CARD-036 CARD-038 CARD-040 keeps comment, title and current-session model choices separate', async () => {
  const settings = await owner();
  let a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({ scope: agent, section: 'comments', revision: a.sections.comments.revision, patch: { backend: 'codex-appserver', selection: { kind: 'explicit', model: 'fixture-model', effort: 'medium' } } })).kind).toBe('saved');
  a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({ scope: agent, section: 'titles', revision: a.sections.titles.revision, patch: { byBackend: { 'codex-appserver': { enabled: true, model: 'title-custom', effort: 'medium' } } } })).kind).toBe('saved');
  let s = await settings.read(session) as SessionSettingsView;
  expect((await settings.save({ scope: session, section: 'model', revision: s.sections.model.revision, patch: { selection: { kind: 'explicit', model: 'fixture-model', effort: 'medium' } } })).kind).toBe('saved');
  s = await settings.read(session) as SessionSettingsView;
  expect(s.sections.model.stored.selection).toEqual({ kind: 'explicit', model: 'fixture-model', effort: 'medium' });
  expect(await getSession(session.threadId)).toMatchObject({ model: 'fixture-model', effort: 'medium' });
  const disk = await loadConfig();
  expect(disk.preferences?.comments).toMatchObject({ backend: 'codex-appserver', model: 'fixture-model', effort: 'medium', future: 'retain' });
  expect(disk.preferences?.sessionTitles?.byBackend?.['codex-appserver']).toMatchObject({ enabled: true, model: 'title-custom', effort: 'medium' });
  expect((await getProjectByName('demo'))?.defaultModel).toBeUndefined();
});

it('CARD-037 persists comment instructions, syncs directory and resets the default', async () => {
  const directory = join(paths.commentsRootDir, 'comment-docx-healthy');
  await mkdir(directory, { recursive: true });
  const settings = await owner();
  let a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'commentInstructions', botId, revision: a.commentInstructions.revision, content: { kind: 'custom', text: 'Review {fileToken}' } })).kind).toBe('saved');
  expect(await readFile(paths.commentInstructionsFile, 'utf8')).toBe('Review {fileToken}');
  expect(await readFile(join(directory, 'AGENTS.md'), 'utf8')).toBe('Review healthy');
  a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.act({ kind: 'commentInstructions', botId, revision: a.commentInstructions.revision, content: { kind: 'default' } })).kind).toBe('saved');
  expect((await settings.read(agent) as AgentSettingsView).commentInstructions.content.kind).toBe('default');
});

it('CARD-057 detects stale card edits; CARD-058 rejects stopped-agent edits', async () => {
  const settings = await owner();
  const a = await settings.read(agent) as AgentSettingsView;
  expect((await settings.save({ scope: agent, section: 'cards', revision: a.sections.cards.revision, patch: { showToolCalls: false } })).kind).toBe('saved');
  expect((await settings.save({ scope: agent, section: 'cards', revision: a.sections.cards.revision, patch: { showModel: 'off' } })).kind).toBe('conflict');
  const stopped = await owner({ access: { kind: 'readonly', reason: 'owner-offline', message: 'stopped' } });
  const snapshot = await stopped.read(agent) as AgentSettingsView;
  expect(snapshot.sections.cards.access.kind).toBe('readonly');
  expect((await stopped.save({ scope: agent, section: 'cards', revision: snapshot.sections.cards.revision, patch: { showToolCalls: true } })).kind).toBe('unavailable');
  expect((await loadConfig()).preferences?.showToolCalls).toBe(false);
});
