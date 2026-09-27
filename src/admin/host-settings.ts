import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { paths } from '../config/paths';
import { activeBots, currentBot, loadBots } from '../config/bots';
import { loadConfig } from '../config/store';
import { getCliBridgePreferences, isComplete, resolveOwner } from '../config/schema';
import { cliBridgeRouteRevision, readCliBridgeRoute, saveCliBridgeRoute } from '../cli-bridge/route';
import { inspectCliBridgeHooks, installCliBridgeHooks, resolveBridgeHookCommand } from '../cli-bridge/hooks';
import { readServiceCodexBin, saveServiceCodexBin } from '../service/codex-bin';
import type { ApplyEffect, HostSettings, HostSettingsView, SettingsActionResult, SettingsSave, SettingsSectionView } from './settings-types';

export function createHostSettings(options: {
  appDir?: string;
  readonly?: boolean;
  runningCodexBin?: string | null;
} = {}): Pick<HostSettings, 'read' | 'save' | 'act'> {
  const appDir = options.appDir ?? paths.appDir;
  const runningCodexBin = options.runningCodexBin === undefined
    ? process.env.CODEX_BIN || null
    : options.runningCodexBin;
  let writes: Promise<unknown> = Promise.resolve();
  const effect: ApplyEffect = { fields: ['codexBin'], when: 'restart', detail: '已保存，下次启动 Bridge 时使用；当前会话保持原来的执行程序。' };
  function view(): HostSettingsView {
    const stored = readServiceCodexBin(appDir);
    return {
      scope: { kind: 'host' },
      sections: {
        execution: {
          stored: { codexBin: stored ?? null },
          effective: { codexBin: runningCodexBin },
          revision: createHash('sha256').update(JSON.stringify({ configured: stored !== undefined, codexBin: stored ?? null })).digest('hex'),
          access: options.readonly
            ? { kind: 'readonly', reason: 'preview', message: '只读预览不能更改执行程序，请先启动 Bridge。' }
            : { kind: 'writable' },
          apply: [effect],
        },
      },
      runtime: { codexBin: runningCodexBin, fallbackCwd: process.env.FEISHU_CODEX_CWD || process.cwd(), platform: process.platform },
    };
  }
  const section = (current: HostSettingsView): SettingsSectionView => ({ scope: { kind: 'host' }, section: 'execution', value: current.sections.execution });
  async function fullView(): Promise<HostSettingsView> {
    const route = readCliBridgeRoute(appDir);
    const registry = await loadBots();
    const agents = await Promise.all(registry.bots.map(async bot => {
      const cfg = await loadConfig(join(appDir, 'bots', bot.appId, 'config.json')).catch(() => undefined);
      return {
        botId: bot.appId,
        name: bot.name,
        enabled: bot.active !== false && !!cfg && isComplete(cfg) && getCliBridgePreferences(cfg).enabled,
        hasOwner: !!cfg && isComplete(cfg) && Boolean(resolveOwner(cfg)),
      };
    }));
    const candidates = activeBots(registry);
    const preferred = currentBot(registry);
    const legacy = candidates.find(bot => bot.appId === preferred?.appId && agents.find(agent => agent.botId === bot.appId)?.enabled)
      ?? candidates.find(bot => agents.find(agent => agent.botId === bot.appId)?.enabled)
      ?? preferred ?? candidates[0] ?? registry.bots[0];
    const hooks = await inspectCliBridgeHooks().catch(() => ({
      claude: { agent: 'claude' as const, status: 'needs_repair' as const, details: ['读取 Hook 状态失败'] },
      codex: { agent: 'codex' as const, status: 'needs_repair' as const, details: ['读取 Hook 状态失败'] },
    }));
    return {
      ...view(),
      runtime: {
        ...view().runtime,
        coffee: {
          route: route.kind,
          botId: route.kind === 'agent' ? route.botId : route.kind === 'legacy' ? legacy?.appId ?? null : null,
          revision: cliBridgeRouteRevision(route),
          agents,
          hooks,
        },
      },
    };
  }
  return {
    async read(scope) {
      if (scope.kind !== 'host') throw new Error('Host settings require the host scope');
      return fullView();
    },
    async act(action): Promise<SettingsActionResult> {
      if (action.kind !== 'setHostCliRoute' && action.kind !== 'repairHostCliHooks') throw new Error('Host action required');
      if (options.readonly) return { kind: 'unavailable', reason: { kind: 'readonly', reason: 'preview', message: '只读预览不能修改本机 Hook。' } };
      if (action.kind === 'setHostCliRoute') {
        if (action.botId !== null) {
          const registry = await loadBots();
          if (!registry.bots.some(bot => bot.appId === action.botId))
            return { kind: 'rejected', fields: [{ field: 'botId', message: '所选通知 Agent 已不存在。' }] };
        }
        if (!saveCliBridgeRoute(action.botId, action.revision, appDir))
          return { kind: 'conflict', view: await fullView() };
        return { kind: 'saved', view: await fullView(), effects: [{ fields: ['notificationBotId'], when: 'next-hook', detail: '通知目标已保存，下一次本机 CLI 活动使用新目标。请确保所选 Agent 已启用本机 CLI 转发。' }], warnings: [] };
      }
      if (readCliBridgeRoute(appDir).kind === 'legacy' && (await loadBots()).bots.length > 0)
        return { kind: 'rejected', fields: [{ field: 'notificationBotId', message: '请先确认通知 Agent，再修复本机 Hook。' }] };
      const warnings: string[] = [];
      for (const agent of action.agents) {
        try {
          await installCliBridgeHooks({ command: resolveBridgeHookCommand(), agents: { claude: agent === 'claude', codex: agent === 'codex' } });
        } catch {
          warnings.push(`${agent} Hook 修复失败，请检查配置权限后重试。`);
        }
      }
      return { kind: 'saved', view: await fullView(), effects: [], warnings };
    },
    save(edit) {
      const run = writes.then(async (): Promise<SettingsSave> => {
        if (edit.scope.kind !== 'host' || edit.section !== 'execution') throw new Error('Host settings require the execution section');
        let current = view();
        if (current.sections.execution.access.kind === 'readonly') return { kind: 'unavailable', reason: current.sections.execution.access };
        const value = edit.patch.codexBin;
        if (value === undefined) return { kind: 'rejected', fields: [{ field: 'codexBin', message: '请选择执行程序或恢复自动查找。' }] };
        if (readServiceCodexBin(appDir) === value) return { kind: 'saved', section: section(current), effects: [] };
        if (current.sections.execution.revision !== edit.revision) return { kind: 'conflict', current: section(current) };
        if (value !== null) {
          if (!isAbsolute(value) || /[\r\n\0]/.test(value)) return { kind: 'rejected', fields: [{ field: 'codexBin', message: '执行程序必须是有效的绝对文件路径。' }] };
          try {
            if (!(await stat(value)).isFile()) throw new Error('not a file');
            await access(value, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
          } catch {
            return { kind: 'rejected', fields: [{ field: 'codexBin', message: '所选执行程序不存在或不可执行，请重新选择。' }] };
          }
        }
        current = view();
        if (current.sections.execution.revision !== edit.revision) return { kind: 'conflict', current: section(current) };
        saveServiceCodexBin(value, appDir);
        return { kind: 'saved', section: section(view()), effects: [effect] };
      });
      writes = run.catch(() => undefined);
      return run;
    },
  };
}
