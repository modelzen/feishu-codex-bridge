import {
  actions,
  button,
  card,
  hr,
  input as inputField,
  md,
  note,
  form,
  selectMenu,
  multiSelectMenu,
  submitButton,
  type CardElement,
  type CardObject,
} from '../card/cards';
import type { CliBridgeNotifyScope } from '../config/schema';
import type { CliBridgeAgent, CliHookStatus, CliQuestionItem } from './types';

export const CLI = {
  toggleEnabled: 'cli.toggle.enabled',
  setDelivery: 'cli.set.delivery',
  setNotifyScope: 'cli.set.notifyScope',
  toggleAgent: 'cli.toggle.agent',
  toggleKeepAwake: 'cli.toggle.keepAwake',
  toggleIncludeBridge: 'cli.toggle.includeBridge',
  repairHooks: 'cli.hooks.repair',
  approveOnce: 'cli.approve.once',
  approveSession: 'cli.approve.session',
  deny: 'cli.deny',
  // One submit for the whole multi-question form (dropdown + custom text per question).
  questionSubmit: 'cli.question.submit',
  taskCompletionDone: 'cli.taskCompletion.done',
} as const;

/** Brand shown on every bridge card. Change the emoji/name here to rebrand everywhere. */
export const BRAND = '🌈 Vonvon Bridge';

const agentLabel: Record<CliBridgeAgent, string> = { claude: 'Claude Code', codex: 'Codex' };
const statusLabel: Record<string, string> = {
  installed: '已安装',
  not_installed: '未安装',
  needs_repair: '需修复',
  conflict_agent2lark: '与 agent2lark 冲突',
};
type InteractionStatus = 'pending' | 'approved' | 'denied' | 'timeout' | 'local';
const TASK_OUTPUT_CHUNK_SIZE = 2800;

// ── lively, rotated copy ─────────────────────────────────────────────────────
// Picked deterministically by a key (interaction id / session) via {@link pickCopy},
// so the wording varies card-to-card yet a given card always renders the same line
// (stable to re-render and to test). Exported so tests can assert membership.
export const COPY = {
  away: [
    { title: '你溜啦?桥我先给你架上', body: '本地还在跑活儿 —— 接下来要审批 / 提问 / 收尾,我都顺着桥递给你。' },
    { title: '人走桥不断,我接管了', body: '检测到你离开。本机 Claude / Codex 的大小事我接着,要紧的就喊你。' },
    { title: '你忙你的,这头交给我', body: '你不在键盘前这段,本地的审批 / 提问 / 完成,我都送到你手上。' },
    { title: '桥已就位,接管成功', body: '本机的活儿还跑着呢,我替你守在这头,该你拍板的一个都不漏。' },
  ],
  permission: [
    '桥那头想动手,先问你一声',
    '有条命令想跑,等你点个头',
    '它举手了:这个操作能放行吗?',
    '本地要执行点东西,你来拍板',
  ],
  question: [
    '桥那头卡了个选择,等你定',
    '有道选择题送到你面前啦',
    '它拿不准,想听听你的',
    '帮你接住一个选择,选哪个?',
  ],
  completion: [
    '桥那头收工了,瞄一眼?',
    '活儿干完了,等你一句话',
    '搞定!想接着支使就回我一句',
    '这一轮结束,看看成果?',
  ],
  footerAway: [
    '你一回电脑(解锁 / 动键鼠),我立刻收桥,绝不打扰。',
    '回到键盘我就把桥撤了,半点不烦你。',
    '人在桌前我就闭嘴,一切回归终端。',
  ],
  footerReply: [
    '💬 直接回复这条消息,就能接着支使它干活;或点「等待确认」让它收工。',
    '💬 回我一句话,它立刻接着跑;不想继续就点「等待确认」。',
  ],
} as const;

/** Deterministic pick from a pool by a string key — same key → same line (testable),
 *  different keys spread across the pool (varied). */
export function pickCopy<T>(pool: readonly T[], key: string): T {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return pool[h % pool.length] as T;
}

/** Friendly session label = the project folder name (basename of cwd) — far more
 *  recognizable than a raw session id. The full cwd path is shown only on the away card. */
function sessionLabel(cwd: string): string {
  const base = (cwd || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return base || 'session';
}

/** Title line on every card: brand prefix + a short verb. No header color band. */
function titleEl(verb: string): CardElement {
  return md(`**${BRAND} · ${verb}**`);
}

/** Meta line under the title: agent + session as inline-code chips. No "Agent:" key,
 *  no 载体, no cwd (cwd lives only on the away card). `extra` appends e.g. a tool chip. */
function metaLine(source: CliBridgeAgent, cwd: string, extra?: string): CardElement {
  const chips = '🤖 `' + agentLabel[source] + '`　💬 `' + sessionLabel(cwd) + '`' + (extra ? '　' + extra : '');
  return note(chips);
}

/** Cap free-form agent text (a full final answer or a long command) so it can't
 *  blow past Feishu's card size limit (~30KB) and make sendManagedCard throw —
 *  which would drop the whole notification and fall back local. */
function clip(text: string, max = 3000): string {
  return text.length > max ? text.slice(0, max) + '\n…（已截断 / truncated）' : text;
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

function disabledButton(label: string, type: 'default' | 'primary' | 'danger' = 'default'): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    disabled: true,
  };
}

/** Local-agents controls as a section to inline into the global 设置 card
 *  (no longer a separate sub-page). Returns the body elements; the caller
 *  splices them into {@link buildSettingsCard}. Each axis is independent:
 *  the master toggle (whole bridge on/off), 通知范围 (all / bound-projects /
 *  none), per-backend forwarding, and 离开保活 (caffeinate). */
export function cliBridgeSettingsSection(input: {
  enabled: boolean;
  statuses: Record<CliBridgeAgent, CliHookStatus>;
  canEnable: { ok: true } | { ok: false; reason: string };
  notifyScope: CliBridgeNotifyScope;
  agents: { claude: boolean; codex: boolean };
  keepAwake: boolean;
}): CardElement[] {
  const scopeButton = (label: string, value: CliBridgeNotifyScope): CardElement =>
    button(label, { a: CLI.setNotifyScope, v: value }, input.notifyScope === value ? 'primary' : 'default');
  const agentButton = (label: string, agent: CliBridgeAgent, on: boolean): CardElement =>
    button(`${label}：${on ? '开' : '关'}`, { a: CLI.toggleAgent, agent, v: on ? 'off' : 'on' }, on ? 'primary' : 'default');
  return [
    hr(),
    md('**☕ 咖啡一下**'),
    note('去倒杯咖啡的工夫，我替你盯着本机的 Claude Code / Codex —— 它要审批、要问你、或跑完了，都推到这个私聊，你在手机上接着拍板就行。'),
    actions([
      button(input.enabled ? '咖啡一下：开' : '咖啡一下：关', { a: CLI.toggleEnabled, v: input.enabled ? 'off' : 'on' }, input.enabled ? 'primary' : 'default'),
    ]),
    note('锁屏、或键鼠空闲超过设定时长，就当你去接咖啡了 → 自动接管；回到电脑/解锁立即收手。'),
    // Shown only on win32 — macOS/Linux rendering is unchanged.
    ...(process.platform === 'win32'
      ? [note('⚠️ Windows 离开检测为实验性（PowerShell）；检测不可用时会直接转发。')]
      : []),

    md('**📣 通知范围**'),
    note('离开时把哪些会话推到飞书。'),
    actions([
      scopeButton('全部', 'all'),
      scopeButton('仅绑定项目', 'bound_projects'),
      scopeButton('不通知', 'none'),
    ]),

    md('**🤖 转发哪些后端**'),
    actions([
      agentButton('Claude Code', 'claude', input.agents.claude),
      agentButton('Codex', 'codex', input.agents.codex),
    ]),

    md('**🔋 离开保活**'),
    note('离开且有任务在跑时自动顶住系统休眠（屏幕照常熄灭），回到电脑/解锁即关。仅 macOS。'),
    actions([
      button(input.keepAwake ? '离开保活：开' : '离开保活：关', { a: CLI.toggleKeepAwake, v: input.keepAwake ? 'off' : 'on' }, input.keepAwake ? 'primary' : 'default'),
    ]),

    md(`**🔧 hooks**　Claude Code：**${statusLabel[input.statuses.claude.status]}**　Codex：**${statusLabel[input.statuses.codex.status]}**`),
    // Repair replaces any agent2lark hooks in place — say so before the user clicks,
    // since it rewrites another tool's ~/.claude / ~/.codex hook config.
    ...(input.statuses.claude.status === 'conflict_agent2lark' || input.statuses.codex.status === 'conflict_agent2lark'
      ? [note('⚠️ 检测到 agent2lark 的 hook；点「修复 hooks」会用本 bridge 覆盖它。')]
      : []),
    actions([button('修复 hooks', { a: CLI.repairHooks }, 'primary')]),
    input.canEnable.ok
      ? note('目标：机器人 owner 私聊　·　hooks 为本机全局，多个机器人共用一套（修复不会重复安装）。')
      : note('开启「☕ 咖啡一下」前请先设置机器人 owner。'),
  ];
}

/**
 * One-time "I noticed you left, I'm taking over" heads-up, sent right before the
 * first real card of an away period (only on a genuine away route). Closes the
 * "did it even notice I left?" confidence gap. This is the ONLY card that shows
 * the full working directory; later cards drop it (one agent → no need to repeat).
 * No buttons. `key` rotates the lively copy across away periods.
 */
export function buildCliBridgeAwayNoticeCard(input: { source: CliBridgeAgent; cwd: string; key?: string }): CardObject {
  const k = input.key ?? input.cwd ?? '';
  const c = pickCopy(COPY.away, k);
  return card(
    [
      titleEl(c.title),
      metaLine(input.source, input.cwd),
      note(c.body),
      md(`📂 **当前项目**\n${input.cwd || 'unknown'}`),
      note(pickCopy(COPY.footerAway, k)),
    ],
    { forward: false },
  );
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
  const verb = status === 'approved' ? '✅ 已允许'
    : status === 'denied' ? '⛔ 已拒绝'
      : status === 'local' ? '↩️ 已转交本机'
        : status === 'timeout' ? '⏰ 已超时'
          : pickCopy(COPY.permission, input.id || input.cwd);
  const tool = input.toolName ? '🛠️ `' + input.toolName + '`' : undefined;
  const elements: CardElement[] = [
    titleEl(verb),
    metaLine(input.source, input.cwd, tool),
    input.command
      ? md(`💻 **命令**\n${codeBlock(clip(input.command), 'bash')}`)
      : note('（hook 未带命令文本）'),
  ];
  if (status === 'pending') {
    elements.push(actions([
      button('✅ 允许', { a: CLI.approveOnce, id: input.id }, 'primary'),
      ...(input.allowSession === false ? [] : [button('🔁 始终允许', { a: CLI.approveSession, id: input.id })]),
      button('⛔ 拒绝', { a: CLI.deny, id: input.id }, 'danger'),
    ]));
  }
  return card(elements, { forward: false });
}

/** Per-question form field names — exported so the resolve side reads exactly what
 *  the card wrote. `_choice` is the dropdown (single → string, multi → string[]);
 *  `_custom` is the always-visible free-text override (filled → it wins). */
export function questionChoiceField(index: number): string {
  return `q${index}_choice`;
}
export function questionCustomField(index: number): string {
  return `q${index}_custom`;
}

/** Dropdown option text: the label, plus a short slice of its description so the
 *  meaning is visible in the collapsed select (descriptions can't render fully in
 *  a Feishu dropdown). The picked **value** stays the bare label = the answer. */
function optionDisplay(o: { label: string; description?: string }): string {
  if (!o.description) return o.label;
  const desc = o.description.length > 36 ? o.description.slice(0, 36) + '…' : o.description;
  return `${o.label} — ${desc}`;
}

/**
 * AskUserQuestion / ask_user_question card. Renders all 1-4 questions as ONE form:
 * each question gets a dropdown (single → select, multi → multi_select) PLUS an
 * always-visible free-text box that overrides the dropdown when filled — so a
 * custom answer needs no extra click and no chat reply. One ✅ 提交 collects every
 * question at once (atomic form submit — no per-click card-update latency, which is
 * what made the old 自定义输入 button feel dead). On resolve the form is replaced by
 * the chosen answers.
 */
export function buildCliBridgeQuestionCard(input: {
  id: string;
  source: 'claude';
  cwd: string;
  questions: CliQuestionItem[];
  status?: InteractionStatus;
  /** Resolved view: answers keyed by question text (what we sent back to the agent). */
  answers?: Record<string, string>;
  hookEventName?: string;
  createdAt?: number;
}): CardObject {
  const status = input.status ?? 'pending';
  const questions = input.questions ?? [];
  const numbered = questions.length > 1;
  const verb = status === 'approved' ? '✅ 已回答'
    : status === 'denied' ? '⛔ 已拒绝'
      : status === 'local' ? '↩️ 已转交本机'
        : status === 'timeout' ? '⏰ 已超时'
          : pickCopy(COPY.question, input.id || input.cwd);
  const elements: CardElement[] = [
    titleEl(verb),
    metaLine(input.source, input.cwd),
  ];
  if (status === 'pending') {
    const formEls: CardElement[] = [];
    questions.forEach((q, i) => {
      const head = `${numbered ? `${i + 1}. ` : ''}${q.header || '请你定一下'}`;
      formEls.push(md(`🧩 **${head}**\n${clip(q.question, 600)}${q.multiSelect ? '　_(可多选)_' : ''}`));
      const opts = q.options.map((o) => ({ label: optionDisplay(o), value: o.label }));
      formEls.push(q.multiSelect
        ? multiSelectMenu({ name: questionChoiceField(i), placeholder: '可多选…', options: opts })
        : selectMenu({ name: questionChoiceField(i), placeholder: '选一个…', options: opts }));
      formEls.push(inputField({ name: questionCustomField(i), placeholder: '都不合适？直接写这里（填了就用你写的）' }));
    });
    formEls.push(actions([submitButton('✅ 提交', { a: CLI.questionSubmit, id: input.id }, 'primary', 'submit')]));
    elements.push(form(`cli_question_${input.id}`, formEls));
    elements.push(note('🐙 选项和「自己写」都在卡片里，答完点「提交」即可 —— 不用回到电脑。'));
  } else if (status === 'approved') {
    const ans = input.answers ?? {};
    const lines = questions.length
      ? questions.map((q, i) => `**${numbered ? `${i + 1}. ` : ''}${q.header || '回答'}**：${ans[q.question] ?? '（未答）'}`).join('\n')
      : Object.entries(ans).map(([k, v]) => `**${k}**：${v}`).join('\n');
    elements.push(md(`✅ 你的回答\n${lines || '（无）'}`));
  }
  return card(elements, { forward: false });
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
  const verb = input.replyDoneAt ? '✅ 已确认完成'
    : input.status === 'failed' ? '❌ 任务失败'
      : pickCopy(COPY.completion, input.id || input.cwd);
  const elements: CardElement[] = [
    titleEl(verb),
    metaLine(input.source, input.cwd),
  ];
  const summary = input.summary?.trim();
  if (summary) {
    for (const [index, chunk] of splitTextIntoChunks(clip(summary, 5600), TASK_OUTPUT_CHUNK_SIZE).entries()) {
      const title = summary.length > TASK_OUTPUT_CHUNK_SIZE ? `Agent 输出（${index + 1}）` : 'Agent 输出';
      elements.push(md(`📝 **${title}**\n${codeBlock(chunk, 'text')}`));
    }
  } else {
    elements.push(note('（hook 未带最终回答）'));
  }
  if (input.replyEnabled) {
    const expiresAt = input.replyExpiresAt ? `（有效期至 ${new Date(input.replyExpiresAt).toLocaleString('zh-CN')}）` : '';
    elements.push(actions([button('⏳ 等待确认', { a: CLI.taskCompletionDone, id: input.id }, 'primary')]));
    elements.push(note(pickCopy(COPY.footerReply, input.id || input.cwd) + expiresAt));
  } else if (input.replyDoneAt) {
    elements.push(actions([disabledButton('✅ 已完成', 'primary')]));
  }
  return card(elements, { forward: false });
}
