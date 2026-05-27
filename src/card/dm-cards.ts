import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getShowToolCalls,
  type AppConfig,
} from '../config/schema';
import type { Project } from '../project/registry';
import type { SessionRecord } from '../bot/session-store';
import { actions, button, card, form, hr, input, linkButton, md, note, selectStatic, submitButton, type CardObject } from './cards';
import { relativeTime } from './session-config-card';

/** applink to open a Feishu group chat by chat_id (oc_xxx). Feishu has no
 * deep link to a specific thread/topic, so this lands in the group and the
 * user scrolls to the topic themselves. */
function openChatUrl(chatId: string): string {
  return `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}

/** Action ids for the DM (private chat) management console. */
export const DM = {
  menu: 'dm.menu',
  newProject: 'dm.newProject',
  newProjectSubmit: 'dm.newProject.submit',
  projects: 'dm.projects',
  settings: 'dm.settings',
  doctor: 'dm.doctor',
  reconnect: 'dm.reconnect',
  rmConfirm: 'dm.rmConfirm',
  rmDo: 'dm.rmDo',
  rmCancel: 'dm.rmCancel',
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

/** Interactive new-project form: project name + optional CWD, submit/cancel. */
export function buildNewProjectFormCard(opts: { name?: string; cwd?: string; error?: string } = {}): CardObject {
  const elements = [];
  if (opts.error) elements.push(md(`❌ **创建失败**：${opts.error}`));
  elements.push(
    md('填项目名（必填）。**CWD 留空** = 在默认目录新建空白项目并 `git init`；**填绝对路径** = 用现有文件夹。'),
    form('new_project', [
      input({ name: 'name', label: '项目名', placeholder: 'my-app', value: opts.name, required: true }),
      input({ name: 'cwd', label: 'CWD（可选，绝对路径）', placeholder: '/Users/you/code/my-app', value: opts.cwd }),
      actions([submitButton('✅ 创建', { a: DM.newProjectSubmit }), button('⬅️ 菜单', { a: DM.menu })]),
    ]),
  );
  return card(elements, { header: { title: '➕ 新建项目', template: 'turquoise' } });
}

/** Shown after a project is created — a terminal "留痕" record, no nav button.
 * (Re-open the console any time by messaging the bot.) */
export function buildNewProjectDoneCard(p: Project): CardObject {
  return card(
    [
      md(`✅ 已创建项目 **${p.name}**${p.blank ? ' _(空白 + git init)_' : ''}`),
      note(`📂 \`${p.cwd}\``),
      md(p.chatId ? '群已建好 👉 去项目群里 **@我** 干活。' : '发我 `/menu` 可再次打开管理台。'),
    ],
    { header: { title: '➕ 新建项目', template: 'green' } },
  );
}

/** Project list: each project shows its bound group + a jump-to-group link,
 * and lists that group's topics (sessions, most-recent first). Feishu applink
 * can only target the group, not a thread — so the link lands in the group. */
export function buildProjectListCard(
  projects: Project[],
  sessionsByChat: Map<string, SessionRecord[]> = new Map(),
): CardObject {
  if (projects.length === 0) {
    return card(
      [md('还没有项目。点 **➕ 新建项目** 或直接发我一个项目名。'), actions([button('⬅️ 菜单', { a: DM.menu })])],
      { header: { title: '📁 项目列表', template: 'wathet' } },
    );
  }
  const elements: CardObject[] = [];
  for (const p of projects) {
    elements.push(md(`**${p.name}**${p.blank ? ' _(空白)_' : ''}`));
    elements.push(note(`📂 \`${p.cwd}\`${p.branch ? `   🌿 ${p.branch}` : ''}`));
    elements.push(note(p.chatId ? `💬 群：**${p.name}**` : '⚠️ 未绑定群'));
    const sessions = (p.chatId ? sessionsByChat.get(p.chatId) : undefined) ?? [];
    if (sessions.length === 0) {
      elements.push(note('（暂无话题）'));
    } else {
      const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
      for (const s of sorted) {
        const title = (s.summary || '(空)').replace(/\s+/g, ' ').slice(0, 40);
        elements.push(note(`· ${title} · ${relativeTime(s.updatedAt)}`));
      }
    }
    const row: CardObject[] = [];
    if (p.chatId) row.push(linkButton('💬 打开群聊', openChatUrl(p.chatId)));
    row.push(button('🗑 删除', { a: DM.rmConfirm, n: p.name }, 'danger'));
    elements.push(actions(row));
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
      note('仅解绑（移除注册 + 撤销置顶横幅），**不删代码目录**。群主会转给你，再由你自行在飞书解散群。'),
      actions([
        button('✅ 确认删除', { a: DM.rmDo, n: name }, 'danger'),
        button('取消', { a: DM.rmCancel }),
      ]),
    ],
    { header: { title: '🗑 删除项目', template: 'red' } },
  );
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
