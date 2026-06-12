import {
  actions,
  button,
  card,
  hr,
  input as inputField,
  md,
  note,
  form,
  submitButton,
  type CardElement,
  type CardObject,
} from '../card/cards';
import type { CliBridgeAgent, CliHookStatus } from './types';

export const CLI = {
  toggleEnabled: 'cli.toggle.enabled',
  setDelivery: 'cli.set.delivery',
  toggleIncludeBridge: 'cli.toggle.includeBridge',
  repairHooks: 'cli.hooks.repair',
  approveOnce: 'cli.approve.once',
  approveSession: 'cli.approve.session',
  deny: 'cli.deny',
  questionOption: 'cli.question.option',
  questionCustom: 'cli.question.custom',
  questionCustomSubmit: 'cli.question.custom.submit',
  taskCompletionDone: 'cli.taskCompletion.done',
} as const;

const agentLabel: Record<CliBridgeAgent, string> = { claude: 'Claude Code', codex: 'Codex' };
const statusLabel: Record<string, string> = {
  installed: '已安装',
  not_installed: '未安装',
  needs_repair: '需修复',
  conflict_agent2lark: '与 agent2lark 冲突',
};
type InteractionStatus = 'pending' | 'approved' | 'denied' | 'timeout' | 'local';
const TASK_OUTPUT_CHUNK_SIZE = 2800;

/** Cap free-form agent text (a full final answer or a long command) so it can't
 *  blow past Feishu's card size limit (~30KB) and make sendManagedCard throw —
 *  which would drop the whole notification and fall back local. */
function clip(text: string, max = 3000): string {
  return text.length > max ? text.slice(0, max) + '\n…（已截断 / truncated）' : text;
}

function formatTime(timestamp?: number): string {
  return new Date(timestamp ?? Date.now()).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function codeBlock(content: string, language: string): string {
  const fence = content.includes('```') ? '````' : '```';
  return `${fence}${language}\n${content}\n${fence}`;
}

function splitTextIntoChunks(value: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) chunks.push(value.slice(index, index + chunkSize));
  return chunks.length > 0 ? chunks : [''];
}

function metaColumns(left: string, right: string): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'default',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [md(left)] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [md(right)] },
    ],
  };
}

function disabledButton(label: string, type: 'default' | 'primary' | 'danger' = 'default'): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    disabled: true,
  };
}

function permissionStatusMeta(status: InteractionStatus): { label: string; template: 'blue' | 'green' | 'red' | 'orange'; icon: string } {
  switch (status) {
    case 'approved': return { label: '已允许', template: 'green', icon: '✅' };
    case 'denied': return { label: '已拒绝', template: 'red', icon: '⛔' };
    case 'timeout': return { label: '已超时', template: 'orange', icon: '⏰' };
    case 'local': return { label: '已转交本机', template: 'orange', icon: '↩️' };
    default: return { label: '等待审批', template: 'blue', icon: '🔐' };
  }
}

function questionStatusMeta(
  status: InteractionStatus,
  awaitingText?: boolean,
): { label: string; template: 'blue' | 'green' | 'red' | 'orange'; icon: string } {
  if (awaitingText && status === 'pending') return { label: '等待输入', template: 'blue', icon: '✍️' };
  switch (status) {
    case 'approved': return { label: '已选择', template: 'green', icon: '✅' };
    case 'denied': return { label: '已拒绝', template: 'red', icon: '⛔' };
    case 'timeout': return { label: '已超时', template: 'orange', icon: '⏰' };
    case 'local': return { label: '已转交本机', template: 'orange', icon: '↩️' };
    default: return { label: '等待选择', template: 'blue', icon: '🧭' };
  }
}

function taskStatusMeta(input: { status: 'completed' | 'failed'; replyEnabled: boolean; replyDoneAt?: number }): { label: string; template: 'blue' | 'green' | 'red'; icon: string } {
  if (input.replyDoneAt) return { label: '已确认完成', template: 'green', icon: '✅' };
  if (input.status === 'failed') return { label: '任务失败', template: 'red', icon: '❌' };
  if (input.replyEnabled) return { label: '等待确认', template: 'blue', icon: '⏳' };
  return { label: '任务完成', template: 'green', icon: '✅' };
}

/** Local-agents controls as a section to inline into the global 设置 card
 *  (no longer a separate sub-page). Returns the body elements; the caller
 *  splices them into {@link buildSettingsCard}. */
export function cliBridgeSettingsSection(input: {
  enabled: boolean;
  statuses: Record<CliBridgeAgent, CliHookStatus>;
  canEnable: { ok: true } | { ok: false; reason: string };
}): CardElement[] {
  return [
    hr(),
    md('**🖥️ 本地 agent**'),
    note('把本地 Claude Code 和 Codex 的提问、审批和最终回答转发到飞书。'),
    actions([
      button(input.enabled ? '飞书接管本地 agent：开' : '飞书接管本地 agent：关', { a: CLI.toggleEnabled, v: input.enabled ? 'off' : 'on' }, input.enabled ? 'primary' : 'default'),
    ]),
    note('默认：仅当 Mac 空闲超过一段时间时转发。'),
    // Shown only on win32 — macOS/Linux rendering is unchanged.
    ...(process.platform === 'win32'
      ? [note('⚠️ Windows 离开检测为实验性（PowerShell）；检测不可用时会直接转发。')]
      : []),
    md(`Claude Code：**${statusLabel[input.statuses.claude.status]}**\nCodex：**${statusLabel[input.statuses.codex.status]}**`),
    // Repair replaces any agent2lark hooks in place — say so before the user clicks,
    // since it rewrites another tool's ~/.claude / ~/.codex hook config.
    ...(input.statuses.claude.status === 'conflict_agent2lark' || input.statuses.codex.status === 'conflict_agent2lark'
      ? [note('⚠️ 检测到 agent2lark 的 hook；点「修复 hooks」会用本 bridge 覆盖它。')]
      : []),
    actions([button('修复 hooks', { a: CLI.repairHooks }, 'primary')]),
    input.canEnable.ok ? note('目标：机器人 owner 私聊') : note('启用本地 agent 前请先设置机器人 owner。'),
  ];
}

export function buildCliBridgeApprovalCard(input: {
  id: string;
  source: CliBridgeAgent;
  cwd: string;
  toolName?: string;
  command?: string;
  allowSession?: boolean;
  status?: InteractionStatus;
  hookEventName?: string;
  sessionId?: string;
  createdAt?: number;
}): CardObject {
  const status = input.status ?? 'pending';
  const statusMeta = permissionStatusMeta(status);
  const elements: CardElement[] = [
    metaColumns(
      `${statusMeta.icon} **${statusMeta.label}**\n🛠️ **${input.toolName || 'unknown'}**`,
      `🔗 ${input.hookEventName || 'unknown'}\n🕒 ${formatTime(input.createdAt)}`,
    ),
    input.command
      ? md(`💻 **命令**\n${codeBlock(clip(input.command), 'bash')}`)
      : note('No command text in hook payload.'),
    md(`📁 **工作目录**\n${input.cwd || 'unknown'}`),
  ];
  if (input.sessionId) elements.push(note(`Session ID: ${input.sessionId}`));
  if (status === 'pending') {
    elements.push(actions([
      button('✅ 允许', { a: CLI.approveOnce, id: input.id }, 'primary'),
      ...(input.allowSession === false ? [] : [button('🔁 始终允许', { a: CLI.approveSession, id: input.id })]),
      button('⛔ 拒绝', { a: CLI.deny, id: input.id }, 'danger'),
    ]));
  }
  return card(elements, { header: { title: `${statusMeta.icon} ${agentLabel[input.source]} permission`, template: statusMeta.template }, forward: false });
}

export function buildCliBridgeQuestionCard(input: {
  id: string;
  source: 'claude';
  cwd: string;
  question: string;
  options: { label: string; description?: string; preview?: string }[];
  header?: string;
  status?: InteractionStatus;
  awaitingText?: boolean;
  selectedOptionLabel?: string;
  hookEventName?: string;
  createdAt?: number;
}): CardObject {
  const status = input.status ?? 'pending';
  const statusMeta = questionStatusMeta(status, input.awaitingText);
  const optionContent = input.options.map((option, index) => {
    const details = [option.description, option.preview].filter(Boolean).join('\n');
    return `${index + 1}. ${option.label}${details ? `\n   ${details}` : ''}`;
  }).join('\n\n');
  const elements: CardElement[] = [
    metaColumns(
      `${statusMeta.icon} **${statusMeta.label}**\n❓ **AskUserQuestion**`,
      `🔗 ${input.hookEventName || 'PermissionRequest'}\n🕒 ${formatTime(input.createdAt)}`,
    ),
    md(`🧩 **${input.header || '问题'}**\n${clip(input.question)}`),
    md(`🗂️ **可选项**\n${optionContent}`),
    md(`📁 **工作目录**\n${input.cwd || 'unknown'}`),
  ];
  if (status === 'pending' && input.awaitingText) {
    elements.push(md(`✍️ **请直接在卡片中输入自定义内容**\n已选择：自定义输入`));
    elements.push(form(`cli_question_custom_${input.id}`, [
      inputField({ name: 'answer', placeholder: '请输入自定义内容', required: true }),
      actions([submitButton('提交自定义输入', { a: CLI.questionCustomSubmit, id: input.id }, 'primary', 'submit')]),
    ]));
  } else if (status === 'pending') {
    elements.push(actions([
      ...input.options.map((o) => button(o.label, { a: CLI.questionOption, id: input.id, label: o.label })),
      button('自定义输入', { a: CLI.questionCustom, id: input.id }),
    ]));
  } else if (status === 'approved' && input.selectedOptionLabel) {
    elements.push(md(`已选择：${input.selectedOptionLabel}`));
  }
  return card(elements, { header: { title: `${statusMeta.icon} Claude Code question`, template: statusMeta.template }, forward: false });
}

export function buildCliBridgeQuestionCustomCard(input: { id: string; question: string }): CardObject {
  return card([
    form('cli_question_custom', [
      md(input.question),
      inputField({ name: 'answer', label: '自定义输入', placeholder: '请输入自定义内容', required: true }),
      actions([submitButton('提交自定义输入', { a: CLI.questionCustomSubmit, id: input.id }, 'primary', 'submit')]),
    ]),
  ], { header: { title: '自定义输入', template: 'turquoise' }, forward: false });
}

export function buildCliBridgeTaskCompletionCard(input: {
  id: string;
  source: CliBridgeAgent;
  cwd: string;
  status: 'completed' | 'failed';
  summary?: string;
  replyEnabled: boolean;
  sessionId?: string;
  hookEventName?: string;
  createdAt?: number;
  replyExpiresAt?: number;
  replyDoneAt?: number;
}): CardObject {
  const statusMeta = taskStatusMeta(input);
  const elements: CardElement[] = [
    metaColumns(
      `${statusMeta.icon} **${statusMeta.label}**\n🏁 **Stop**`,
      `🔗 ${input.hookEventName || (input.status === 'failed' ? 'StopFailure' : 'Stop')}\n🕒 ${formatTime(input.createdAt)}`,
    ),
  ];
  if (input.sessionId) elements.push(md(`Session: ${input.sessionId}`));
  const summary = input.summary?.trim();
  if (summary) {
    for (const [index, chunk] of splitTextIntoChunks(clip(summary, 5600), TASK_OUTPUT_CHUNK_SIZE).entries()) {
      const title = summary.length > TASK_OUTPUT_CHUNK_SIZE ? `Agent 输出（${index + 1}）` : 'Agent 输出';
      elements.push(md(`📝 **${title}**\n${codeBlock(chunk, 'text')}`));
    }
  } else {
    elements.push(note('No final answer found in hook payload.'));
  }
  elements.push(md(`📁 **工作目录**\n${input.cwd || 'unknown'}`));
  if (input.replyEnabled) {
    const expiresAt = input.replyExpiresAt ? `，有效期至 ${new Date(input.replyExpiresAt).toLocaleString('zh-CN')}` : '';
    elements.push(actions([button('⏳ 等待确认', { a: CLI.taskCompletionDone, id: input.id }, 'primary')]));
    elements.push(note(`回复此消息可继续 Agent 执行，或点击等待确认让 Agent 正常结束${expiresAt}`));
  } else if (input.replyDoneAt) {
    elements.push(actions([disabledButton('✅ 已完成', 'primary')]));
  }
  return card(elements, { header: { title: `${statusMeta.icon} ${agentLabel[input.source]} Stop 通知`, template: statusMeta.template }, forward: false });
}
