import {
  getMaxConcurrentRuns,
  getMessageReplyMode,
  getPendingPolicy,
  getShowToolCalls,
  type AppConfig,
} from '../config/schema';
import type { Project } from '../project/registry';
import { actions, button, card, hr, md, note, selectStatic, type CardObject } from './cards';

/** Action ids for the DM (private chat) management console. */
export const DM = {
  menu: 'dm.menu',
  newProject: 'dm.newProject',
  projects: 'dm.projects',
  settings: 'dm.settings',
  doctor: 'dm.doctor',
  reconnect: 'dm.reconnect',
  rmConfirm: 'dm.rmConfirm',
  rmDo: 'dm.rmDo',
  rmCancel: 'dm.rmCancel',
  setReply: 'dm.set.reply',
  setTools: 'dm.set.tools',
  setWatchdog: 'dm.set.watchdog',
  setPending: 'dm.set.pending',
  setConcurrency: 'dm.set.concurrency',
} as const;

/** The top-level management menu. */
export function buildDmMenuCard(): CardObject {
  return card(
    [
      md('私聊用于**建项目和管理**；具体任务请到项目群里 @我。'),
      hr(),
      actions([
        button('➕ 新建项目', { a: DM.newProject }, 'primary'),
        button('📁 项目列表', { a: DM.projects }),
        button('⚙️ 设置', { a: DM.settings }),
      ]),
      actions([
        button('🩺 诊断', { a: DM.doctor }),
        button('🔄 重连', { a: DM.reconnect }),
      ]),
    ],
    { header: { title: '🤖 Codex Bridge 管理台', template: 'blue' } },
  );
}

export function buildNewProjectHintCard(): CardObject {
  return card(
    [
      md('**新建项目**：发我一条命令：'),
      md('- `/new 项目名` — 新建空白项目（建群 + 拉你进群 + git init）\n- `/new 项目名 /现有/绝对路径` — 用现有文件夹'),
      note('例：`/new my-app` 或 `/new my-app /Users/you/code/my-app`'),
      actions([button('⬅️ 菜单', { a: DM.menu })]),
    ],
    { header: { title: '➕ 新建项目', template: 'turquoise' } },
  );
}

export function buildProjectListCard(projects: Project[]): CardObject {
  if (projects.length === 0) {
    return card(
      [md('还没有项目。点 **➕ 新建项目** 或直接发我一个项目名。'), actions([button('⬅️ 菜单', { a: DM.menu })])],
      { header: { title: '📁 项目列表', template: 'wathet' } },
    );
  }
  const elements: ReturnType<typeof md>[] = [];
  for (const p of projects) {
    elements.push(md(`**${p.name}**${p.blank ? ' _(空白)_' : ''}`));
    elements.push(note(`📂 \`${p.cwd}\`${p.branch ? `   🌿 ${p.branch}` : ''}`));
    elements.push(actions([button('🗑 删除', { a: DM.rmConfirm, n: p.name }, 'danger')]));
    elements.push(hr());
  }
  elements.push(note(`共 ${projects.length} 个项目`));
  elements.push(actions([button('⬅️ 菜单', { a: DM.menu })]));
  return card(elements, { header: { title: '📁 项目列表', template: 'wathet' } });
}

export function buildRmConfirmCard(name: string): CardObject {
  return card(
    [
      md(`确定删除项目 **${name}**？`),
      note('仅解绑（移除注册 + 撤销置顶横幅），**不删代码目录**。群需你自行在飞书解散。'),
      actions([
        button('✅ 确认删除', { a: DM.rmDo, n: name }, 'danger'),
        button('取消', { a: DM.rmCancel }),
      ]),
    ],
    { header: { title: '🗑 删除项目', template: 'red' } },
  );
}

const REPLY_LABEL: Record<string, string> = { card: '卡片', markdown: 'Markdown', text: '纯文本' };

/** Global preferences card. Selecting an option mutates config + saves. */
export function buildSettingsCard(cfg: AppConfig): CardObject {
  const watchdogSec = cfg.preferences?.runIdleTimeoutSeconds;
  const watchdogVal = watchdogSec === 0 ? '0' : String(watchdogSec ?? 120);
  return card(
    [
      md('**全局设置**（管理员）'),
      actions([
        selectStatic({
          actionId: DM.setReply,
          placeholder: '回复方式',
          initial: getMessageReplyMode(cfg),
          options: [
            { label: '回复方式：卡片', value: 'card' },
            { label: '回复方式：Markdown', value: 'markdown' },
            { label: '回复方式：纯文本', value: 'text' },
          ],
        }),
        selectStatic({
          actionId: DM.setTools,
          placeholder: '工具调用显示',
          initial: getShowToolCalls(cfg) ? 'on' : 'off',
          options: [
            { label: '工具调用：显示', value: 'on' },
            { label: '工具调用：隐藏', value: 'off' },
          ],
        }),
      ]),
      actions([
        selectStatic({
          actionId: DM.setWatchdog,
          placeholder: '假死超时',
          initial: watchdogVal,
          options: [
            { label: '假死超时：关闭', value: '0' },
            { label: '假死超时：60 秒', value: '60' },
            { label: '假死超时：120 秒', value: '120' },
            { label: '假死超时：300 秒', value: '300' },
          ],
        }),
        selectStatic({
          actionId: DM.setPending,
          placeholder: '运行中新消息',
          initial: getPendingPolicy(cfg),
          options: [
            { label: '运行中新消息：引导', value: 'steer' },
            { label: '运行中新消息：排队', value: 'queue' },
          ],
        }),
        selectStatic({
          actionId: DM.setConcurrency,
          placeholder: '并发上限',
          initial: String(getMaxConcurrentRuns(cfg)),
          options: [
            { label: '并发上限：1', value: '1' },
            { label: '并发上限：5', value: '5' },
            { label: '并发上限：10', value: '10' },
            { label: '并发上限：20', value: '20' },
          ],
        }),
      ]),
      note(
        `当前：回复 ${REPLY_LABEL[getMessageReplyMode(cfg)]} · 工具 ${getShowToolCalls(cfg) ? '显示' : '隐藏'} · ` +
          `假死 ${watchdogVal === '0' ? '关' : `${watchdogVal}s`} · ${getPendingPolicy(cfg) === 'steer' ? '引导' : '排队'} · 并发 ${getMaxConcurrentRuns(cfg)}`,
      ),
      note('⚠️ 假死超时 / 并发上限 改后需重启 bridge 生效；回复方式 / 工具显示即时生效。'),
      actions([button('⬅️ 菜单', { a: DM.menu })]),
    ],
    { header: { title: '⚙️ 设置', template: 'blue' } },
  );
}
