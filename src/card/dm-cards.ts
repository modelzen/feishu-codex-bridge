import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getShowToolCalls,
  type AppConfig,
} from '../config/schema';
import type { Project } from '../project/registry';
import type { BotGroup } from '../project/group-ops';
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
  groups: 'dm.groups',
  transferOwner: 'dm.transferOwner',
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
        button('🚪 群管理', { a: DM.groups }),
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

/** Bot's groups, with 🔑 转让群主给我 on bot-owned ones (so admin can disband). */
export function buildGroupsCard(groups: BotGroup[], adminName?: string): CardObject {
  const owned = groups.filter((g) => g.ownedByBot);
  const elements = [
    md('机器人是这些群的**群主**——只有群主能解散。点 🔑 把群主转给你，再去飞书自行解散。'),
    hr(),
  ];
  if (owned.length === 0) {
    elements.push(md('_机器人当前不是任何群的群主。_'));
  } else {
    for (const g of owned) {
      elements.push(md(`**${g.name}**`));
      elements.push(note(`\`${g.chatId}\``));
      elements.push(actions([button(`🔑 转让群主给${adminName ? ` ${adminName}` : '我'}`, { a: DM.transferOwner, c: g.chatId })]));
      elements.push(hr());
    }
  }
  elements.push(actions([button('⬅️ 菜单', { a: DM.menu })]));
  return card(elements, { header: { title: '🚪 群管理', template: 'orange' } });
}

/** Global preferences card. Selecting an option mutates config + saves. */
export function buildSettingsCard(cfg: AppConfig): CardObject {
  const watchdogSec = cfg.preferences?.runIdleTimeoutSeconds;
  const watchdogVal = watchdogSec === 0 ? '0' : String(watchdogSec ?? 120);
  return card(
    [
      md('**全局设置**（管理员）'),
      actions([
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
        `当前：工具 ${getShowToolCalls(cfg) ? '显示' : '隐藏'} · ` +
          `假死 ${watchdogVal === '0' ? '关' : `${watchdogVal}s`} · ${getPendingPolicy(cfg) === 'steer' ? '引导' : '排队'} · 并发 ${getMaxConcurrentRuns(cfg)}`,
      ),
      note('⚠️ 假死超时 / 并发上限 改后需**重启**生效；工具显示 / 运行中新消息 即时生效。'),
      actions([button('⬅️ 菜单', { a: DM.menu })]),
    ],
    { header: { title: '⚙️ 设置', template: 'blue' } },
  );
}
