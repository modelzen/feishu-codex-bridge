import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { paths } from '../config/paths';
import { readServiceCodexBin, saveServiceCodexBin } from '../service/codex-bin';
import type { ApplyEffect, HostSettings, HostSettingsView, SettingsSave, SettingsSectionView } from './settings-types';

export function createHostSettings(options: {
  appDir?: string;
  readonly?: boolean;
  runningCodexBin?: string | null;
} = {}): Pick<HostSettings, 'read' | 'save'> {
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
  return {
    async read(scope) {
      if (scope.kind !== 'host') throw new Error('Host settings require the host scope');
      return view();
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
