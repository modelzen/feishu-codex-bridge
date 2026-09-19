import type { ModelInfo, ReasoningEffort, ThreadSummary } from '../agent/types';
import { actions, button, card, hr, linkButton, md, note, selectStatic, type CardElement, type CardObject } from './cards';

/** Action ids for the `/model` card. */
export const MC = {
  model: 'model.set',
  effort: 'model.effort',
  fast: 'model.fast',
} as const;

/** Action ids for the `/resume` card. */
export const RES = {
  pick: 'resume.pick',
} as const;

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: '无',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超强',
};

/** Keep model cards forward-compatible when Codex adds a new effort tier. */
export function reasoningEffortLabel(effort: string): string {
  return EFFORT_LABEL[effort as ReasoningEffort] ?? (effort || '未知');
}

// ── /model ────────────────────────────────────────────────────────────────

/** Server-side state for a pending `/model` card, keyed by its messageId. */
export interface ModelCardState {
  chatId: string;
  /** the topic (session) whose model/effort this card edits */
  threadId: string;
  sessionId?: string;
  requesterOpenId: string;
  models: ModelInfo[];
  model: string;
  effort: ReasoningEffort;
  fastMode?: boolean | null;
  /** the backend whose models this card lists（写回会话前复核，防跨后端把一个后端的
   * model id 持久化进另一后端的会话——resume 时会喂坏 CLI）。旧卡缺省。 */
  backend?: string;
  createdAt: number;
  /** transient confirmation line */
  note?: string;
}

/**
 * The `/model` card —— **按后端能力自适应**，对齐 Codex 的诚实体验：
 *   - 只在「当前模型真的有 supportedEfforts」时才显示 effort 下拉（没有就不显示，不
 *     回退成点了没用的假 low/medium/high）。
 *   - 只在「有多个可见模型」时才显示模型下拉（单模型用文字呈现，不给只有一项的下拉）。
 *   - 既不能切模型也不能调 effort 的后端 → 纯信息卡 + 明确「此后端不支持在此切换」。
 * 能调的给控件、不能调的给清晰说明（不静默、不造假）。
 */
export function buildModelCard(state: ModelCardState): CardObject {
  const visible = state.models.filter((m) => !m.hidden);
  const cur = state.models.find((m) => m.id === state.model);
  const efforts = cur?.supportedEfforts ?? [];
  const canPickModel = visible.length > 1;
  const canPickEffort = efforts.length > 0;
  const curLabel = cur?.displayName ?? state.model;

  const elements: CardElement[] = [md('🧠 **模型 / 推理强度**')];

  if (canPickModel || canPickEffort) {
    elements.push(note('选择后下一轮生效'), hr());
    const controls: CardElement[] = [];
    if (canPickModel) {
      controls.push(
        selectStatic({
          actionId: MC.model,
          placeholder: '选择模型',
          initial: state.model,
          options: visible.map((m) => ({ label: m.displayName, value: m.id })),
        }),
      );
    }
    if (canPickEffort) {
      controls.push(
        selectStatic({
          actionId: MC.effort,
          placeholder: 'effort',
          initial: state.effort,
          options: efforts.map((e) => ({ label: `effort：${reasoningEffortLabel(e)}`, value: e })),
        }),
      );
    }
    elements.push(actions(controls));
    // 只有一个维度可调时，给另一维度一句说明（避免「为什么只有一个下拉」的困惑）。
    if (canPickModel && !canPickEffort) {
      elements.push(note('该后端不调节推理强度（思考由模型自动调度，无 Codex 那样的 effort 档）'));
    }
  } else {
    // 既不能切模型也不能调 effort 的后端 → 信息卡，明确「此后端不支持」。
    elements.push(hr(), md(`当前模型：**${curLabel}**`));
    elements.push(note('该后端不支持在此切换模型或推理强度。'));
  }

  if (state.backend === 'codex-appserver') {
    elements.push(hr(), md('⚡ **Fast 模式**'), actions([selectStatic({
      actionId: MC.fast,
      placeholder: 'Fast 模式',
      initial: state.fastMode == null ? 'default' : state.fastMode ? 'on' : 'off',
      options: [
        { label: '沿用 Codex 设置（未覆盖）', value: 'default' },
        { label: 'Fast：开启', value: 'on' },
        { label: 'Fast：关闭', value: 'off' },
      ],
    })]), note('下一轮生效。Fast 会增加用量消耗，可用性取决于模型和账号。'));
  }
  if (state.note) elements.push(note(state.note));
  return card(elements, { summary: '模型设置' });
}

// ── /resume ─────────────────────────────────────────────────────────────────

/** Server-side state for a pending `/resume` card, keyed by its messageId. */
export interface ResumeCardState {
  chatId: string;
  /** the `@bot /resume` message — reply_in_thread to it creates the topic */
  originalMsgId: string;
  requesterOpenId: string;
  cwd: string;
  projectName?: string;
  /** agent backend id the sessions were listed from — rides each pick button's
   * callback value (`b`) so the resume stays on the same backend. Unset on
   * legacy state → default (codex). */
  backend?: string;
  threads: ThreadSummary[];
  createdAt: number;
  /** in-flight guard (anti double-click) */
  launching?: boolean;
  /** single-session group: resume IN PLACE (no new topic) —— pick rebinds the
   * group's session key flat instead of reply_in_thread-ing a new topic. */
  flat?: boolean;
  /** single-session group only: the session key (chatId / chatId#role) to rebind
   * on pick. Set together with {@link flat}. */
  sessionKey?: string;
}

/** Max length of the session title shown inside a picker button. */
const RESUME_TITLE_MAX = 30;

/**
 * The `/resume` card: recent codex threads under this cwd. Each thread is ONE
 * button labeled `↩️ <time> · <title>` (time first, title truncated to one line)
 * — modeled on codex's own `resume` TUI — so it's unambiguous which button
 * resumes which session even when titles are long, messy, or repeated. Same-
 * title sessions are told apart by the minute-precise timestamp.
 */
export function buildResumeCard(state: ResumeCardState): CardObject {
  const elements = [md('🕘 **恢复历史会话**'), note(metaNote(state)), hr()];
  if (state.threads.length === 0) {
    elements.push(md('_该目录下还没有历史会话。直接 @我 即可新建。_'));
  } else {
    elements.push(
      note(
        state.flat
          ? '点一条即切回 —— 就地继续，不另起话题。'
          : '点一条即恢复 —— 在新话题里打开历史、可直接继续。',
      ),
    );
    for (const t of state.threads) {
      const title = (t.name?.trim() || t.preview.trim() || '(无摘要)').replace(/\s+/g, ' ');
      const label = `↩️ ${pickerTime(t.updatedAt || t.createdAt)} · ${truncate(title, RESUME_TITLE_MAX)}`;
      elements.push(actions([button(label, { a: RES.pick, t: t.sessionId, ...(state.backend ? { b: state.backend } : {}) })]));
    }
  }
  return card(elements, { summary: '恢复历史会话' });
}

/** Transient "resuming…" card — interactive controls removed (anti double-click). */
export function buildResumeLaunchingCard(state: ResumeCardState): CardObject {
  return card([md('⏳ 正在恢复历史会话…'), note(metaNote(state))], { summary: '恢复中' });
}

/** Terminal success card — resumed as a new topic (multi) or switched in place
 * (single, `flat`). */
export function buildResumeDoneCard(state: ResumeCardState): CardObject {
  const line = state.flat
    ? '↩️ 已切回 —— 就地继续，上面的历史消息保留。'
    : '✅ 已恢复 —— 已在上方新话题打开，可直接继续。';
  return card([md(line), note(metaNote(state))], { summary: '已恢复' });
}

// ── /clear ────────────────────────────────────────────────────────────────

/**
 * The `/clear` card (single-session groups only) — posted AFTER the group's
 * session is repointed to a fresh backend thread. It reassures on the one thing
 * Feishu can't do: the visible chat history above is NOT deleted — the agent
 * just stops reading it. The parked session stays on disk and is resumable via
 * `/resume`, so an accidental `/clear` is fully recoverable.
 */
export function buildClearedCard(): CardObject {
  return card(
    [
      md('🧹 **已开启全新会话**'),
      md('✅ 上下文已清空 —— 我从这里重新开始，不再参考上面的对话。'),
      md('💬 飞书聊天记录不受影响 —— 上面的消息都还在，只是我不再读取它们。'),
      md('🗂️ 刚才那段已归档 —— 发 `/resume` 随时切回继续。'),
    ],
    { summary: '已清空上下文' },
  );
}

/** Failure card after a failed resume launch. */
export function buildResumeErrorCard(state: ResumeCardState, message: string): CardObject {
  return card([md(`❌ 恢复失败：${truncate(message, 200)}`), note(metaNote(state))], { summary: '恢复失败' });
}

function metaNote(state: { cwd: string; projectName?: string }): string {
  const parts = [`📂 \`${state.cwd}\``];
  if (state.projectName) parts.unshift(`📁 ${state.projectName}`);
  return parts.join('   ');
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Coarse relative time from a unix-seconds (or millis) timestamp. */
export function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return '未知时间';
  const ms = unixSeconds < 1e12 ? unixSeconds * 1000 : unixSeconds;
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}

/**
 * Timestamp for the resume picker buttons: friendly for recent sessions,
 * minute-precise (absolute) for older ones so same-title sessions stay
 * distinguishable (coarse "20 天前" would collide on duplicates).
 */
export function pickerTime(unixSeconds: number): string {
  if (!unixSeconds) return '未知时间';
  const ms = unixSeconds < 1e12 ? unixSeconds * 1000 : unixSeconds;
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const d = new Date(ms);
  const now = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `今天 ${hm}`;
  const md = `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`;
}

// ── /help & 建群欢迎卡 ────────────────────────────────────────────────────────

/** Where the user is when they ask for help — drives which commands we list. */
export type HelpScope = 'main' | 'topic' | 'single';

/** First bullet describing how to talk to the bot, honoring the group's
 * effective 免@ state so the card never promises免@ when it's actually off
 * (e.g. a joined single-session group, which defaults off). */
function talkLine(noMention: boolean, tail: string): string {
  return noMention
    ? `· 直接发消息（免@）→ ${tail}`
    : `· **@我 + 内容** → ${tail}（本群默认需 @；\`/settings\` 可开启免@）`;
}

/** 后端能力（只取 /help 关心的三项）。undefined ⇒ 全支持（codex 不声明
 * capabilities，约定 undefined=全能；不支持某命令的后端显式标 false）。 */
export interface HelpCaps {
  goal?: boolean;
  compact?: boolean;
  resume?: boolean;
}

/** The `/help` card: commands available **right here** (this exact scope).
 * `noMention` is the group's effective 免@ state (`noMention ?? defaultNoMention`).
 * `isAdmin` gates the owner-only commands (`/settings`、`/resume`): non-admins
 * don't see them listed (they'd be denied anyway — see handle-message 的门控).
 * `caps` 按会话后端能力裁剪：不支持 /goal、/compact、/resume 的后端
 * （能力守卫会拒），就不在速查卡里列出来——避免「列了点了才发现不支持」的不一致。
 * 缺省（undefined 或不传）= 全列（codex 行为，向后兼容）。 */
export function buildHelpCard(scope: HelpScope, noMention = true, isAdmin = false, caps?: HelpCaps): CardObject {
  const showGoal = caps?.goal ?? true;
  const showCompact = caps?.compact ?? true;
  const showResume = caps?.resume ?? true;
  const goalLine = '· `/goal <目标>` → 自主多轮跑到完成（卡上 ⏹ 终止 / 🎯 结束目标）';
  const compactLine = '· `/compact` → 压缩上下文（释放空间）';

  const elements: CardElement[] = [];
  if (scope === 'single') {
    const lines = [talkLine(noMention, '交给我处理')];
    if (showGoal) lines.push(goalLine);
    lines.push('· `/model` → 切换模型 / 推理强度', '· `/context` → 看上下文占比');
    if (showCompact) lines.push(compactLine);
    if (isAdmin) lines.push('· `/clear` → 清空上下文，开一段全新会话（飞书消息保留）');
    if (isAdmin && showResume) lines.push('· `/resume` → 切回历史会话');
    if (isAdmin) lines.push('· `/settings` → 群设置（免@ 开关）');
    lines.push('· `/help` → 这张速查卡');
    elements.push(md('💬 **单会话群** — 整群就是一个会话，上下文连续。'), hr(), md(lines.join('\n')));
  } else if (scope === 'topic') {
    const lines = [talkLine(noMention, '继续当前会话')];
    if (showGoal) lines.push(goalLine);
    lines.push('· `/model` → 切换模型 / 推理强度', '· `/context` → 看上下文占比');
    if (showCompact) lines.push(compactLine);
    lines.push('· `/help` → 这张速查卡');
    elements.push(
      md('🧵 **话题内** — 每个话题是一个独立会话。'),
      hr(),
      md(lines.join('\n')),
      note('开新话题：回到主群区 @我 + 内容。'),
    );
  } else {
    const lines = ['· **@我 + 内容** → 开一个新话题并开始'];
    if (showGoal) lines.push(goalLine);
    if (isAdmin && showResume) lines.push('· `/resume` → 恢复历史会话');
    if (isAdmin) lines.push('· `/settings` → 群设置（免@ 开关）');
    lines.push('· `/model` → 需要在话题里用', '· `/help` → 这张速查卡');
    elements.push(md('👥 **主群区** — @我开话题，每个话题是独立会话。'), hr(), md(lines.join('\n')));
  }
  return card(elements, { header: { title: '🤖 可用命令', template: 'blue' }, summary: '可用命令' });
}

/**
 * Welcome card posted when a project group is created or a group is bound — a
 * full overview of every command this group supports, keyed off its session
 * kind. `noMention` is the group's effective 免@ state (so a joined
 * single-session group, which defaults off, doesn't promise免@). Adds a
 * "查看完整手册" link button when a doc URL is configured.
 */
/**
 * 欢迎卡按会话后端能力裁剪命令（与 {@link buildHelpCard} 同源 caps）：不支持
 * /goal /compact /resume 的后端就不在欢迎卡里列；codex（caps undefined ⇒ 全 true）
 * 保持全列。避免用户第一眼的「使用说明」就推销点了不支持的命令。
 */
export function buildWelcomeCard(
  kind: 'multi' | 'single',
  docUrl?: string,
  noMention = true,
  caps?: HelpCaps,
  /** 本群后端的展示名（Codex / Claude …）——欢迎语按后端区分；缺省 'Codex'（向后兼容）。 */
  agentName = 'Codex',
): CardObject {
  const showGoal = caps?.goal ?? true;
  const showCompact = caps?.compact ?? true;
  const showResume = caps?.resume ?? true;
  const goalLine = '· `/goal <目标>` → 自主多轮跑到完成（卡上 ⏹ 终止 / 🎯 结束目标）';
  // /context 总在；/compact 仅后端支持时合并进同一行。
  const ctxLine = showCompact ? '· `/context` · `/compact` → 看 / 压缩上下文' : '· `/context` → 看上下文占比';
  const elements: CardElement[] = [
    md(`👋 **欢迎使用 ${agentName} Bridge** — 本群已绑定一个项目目录，在群里就能驱动本机 ${agentName} 干活。`),
    hr(),
  ];
  if (kind === 'single') {
    elements.push(
      md('💬 **单会话群**（整群一个会话，上下文连续）'),
      md(
        [
          talkLine(noMention, '交给我处理'),
          ...(showGoal ? [goalLine] : []),
          '· `/model` → 切换模型 / 推理强度',
          '· `/clear` → 清空上下文，开新会话（管理员，飞书消息保留）',
          ...(showResume ? ['· `/resume` → 切回历史会话（管理员）'] : []),
          '· `/settings` → 群设置（免@ 开关）',
          '· `/help` → 命令速查卡',
        ].join('\n'),
      ),
    );
  } else {
    elements.push(
      md('👥 **主群区**'),
      md(
        [
          '· **@我 + 内容** → 开一个新话题并开始（每话题独立会话）',
          ...(showGoal ? [goalLine] : []),
          ...(showResume ? ['· `/resume` → 恢复历史会话'] : []),
          '· `/settings` → 群设置（免@ 开关）',
        ].join('\n'),
      ),
      md('🧵 **话题内**'),
      md(['· 直接发消息（免@）→ 继续当前会话', '· `/model` → 切换模型 / 推理强度', ctxLine].join('\n')),
      note('任意场景发 `/help` 看当前可用命令。'),
    );
  }
  if (docUrl) {
    elements.push(hr(), actions([linkButton('📖 查看完整使用手册', docUrl, 'primary')]));
  }
  return card(elements, { header: { title: '🤖 本群使用说明', template: 'turquoise' }, summary: '本群使用说明' });
}
