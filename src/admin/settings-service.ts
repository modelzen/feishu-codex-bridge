import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackend } from '../agent';
import { botDir, botPaths } from '../config/paths';
import { loadConfig } from '../config/store';
import { isComplete } from '../config/schema';
import { listProjectsIn } from '../project/registry';
import { listSessionsIn } from '../bot/session-store';
import { DEFAULT_COMMENT_INSTRUCTIONS } from '../bot/comments';
import { createSettingsOwner, offlineSettings, SettingsInputError } from './settings';
import { createHostSettings } from './host-settings';
import type { AdminServiceDeps } from './service';
import type { HostSettings, SettingsAccess, SettingsSave, SettingsActionResult, SettingsView, ModelCatalog } from './settings-types';
export function createSettingsService(deps: AdminServiceDeps): HostSettings {
  const host = createHostSettings({
    readonly: deps.readonlyPreview
  });
  const unavailable = (): SettingsAccess => deps.readonlyPreview ? {
    kind: 'readonly',
    reason: 'preview',
    message: '预览模式不可编辑，请先启动 Host'
  } : offlineSettings;
  const owned = async (botId: string) => !deps.readonlyPreview && !!deps.executeWrite && (await deps.liveStatus?.(botId))?.running === true;
  return {
    async read(scope) {
      if (scope.kind === 'host')
        return host.read(scope);
      if (deps.executeSettingsRead && await owned(scope.botId))
        return await deps.executeSettingsRead(scope.botId, {
          kind: 'settingsRead',
          scope
        }) as SettingsView;
      const cfg = await loadConfig(botPaths(scope.botId).configFile);
      if (!isComplete(cfg))
        throw new SettingsInputError('机器人不存在或配置不完整');
      const files = botPaths(scope.botId);
      return createSettingsOwner({
        cfg,
        access: unavailable(),
        backendFor: createBackend,
        writePreferences: async () => {
          throw new Error('只读');
        },
        evictLiveSessionsForChat: async () => {
        },
        readProject: async (name) => (await listProjectsIn(files.projectsFile)).find(p => p.name === name),
        listProjects: () => listProjectsIn(files.projectsFile),
        readSession: async (id) => (await listSessionsIn(files.sessionsFile)).find(s => s.threadId === id),
        instructions: {
          read: () => readFile(join(botDir(scope.botId), 'comment-instructions.md'), 'utf8').catch(error => {
            if (error.code === 'ENOENT')
              return DEFAULT_COMMENT_INSTRUCTIONS;
            throw error;
          }),
          save: async () => {
            throw new Error('只读');
          },
          sync: async () => {
            throw new Error('只读');
          },
        },
      }).read(scope);
    },
    async save(edit) {
      if (edit.scope.kind === 'host')
        return host.save(edit);
      if (!await owned(edit.scope.botId))
        return {
          kind: 'unavailable',
          reason: unavailable()
        };
      return await deps.executeWrite!(edit.scope.botId, {
        kind: 'settingsPatch',
        edit: edit as import('./settings-types').BotSettingsEdit
      }) as SettingsSave;
    },
    async act(action) {
      if (!await owned(action.botId))
        return {
          kind: 'unavailable',
          reason: unavailable()
        };
      return await deps.executeWrite!(action.botId, {
        kind: 'settingsAction',
        action
      }) as SettingsActionResult;
    },
    async models(query) {
      if (!deps.executeSettingsRead || !await owned(query.botId))
        return {
          backend: query.backend,
          models: [],
          state: 'unavailable',
          source: 'backend-provided',
          observedAt: new Date().toISOString(),
          error: 'Agent 未运行',
          titleEfforts: []
        };
      return await deps.executeSettingsRead(query.botId, {
        kind: 'settingsModels',
        query
      }) as ModelCatalog;
    },
  };
}
