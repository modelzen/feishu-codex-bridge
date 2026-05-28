import type { ModelInfo, ReasoningEffort, ThreadSummary } from '../agent/types';
import { actions, button, card, hr, md, note, selectStatic, type CardObject } from './cards';

/** Action ids for the `/model` card. */
export const MC = {
  model: 'model.set',
  effort: 'model.effort',
} as const;

/** Action ids for the `/resume` card. */
export const RES = {
  pick: 'resume.pick',
} as const;

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: '无',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
};

// ── /model ────────────────────────────────────────────────────────────────

/** Server-side state for a pending `/model` card, keyed by its messageId. */
export interface ModelCardState {
  chatId: string;
  /** the topic (session) whose model/effort this card edits */
  threadId: string;
  requesterOpenId: string;
  models: ModelInfo[];
  model: string;
  effort: ReasoningEffort;
  createdAt: number;
  /** transient confirmation line */
  note?: string;
}

/** The `/model` card: pick model + reasoning effort for the current session. */
export function buildModelCard(state: ModelCardState): CardObject {
  const visible = state.models.filter((m) => !m.hidden);
  const cur = state.models.find((m) => m.id === state.model);
  const efforts = cur?.supportedEfforts.length ? cur.supportedEfforts : (['low', 'medium', 'high'] as ReasoningEffort[]);
  const elements = [
    md('🧠 **模型 / 推理强度**'),
    note('选择后下一轮生效'),
    hr(),
    actions([
      selectStatic({
        actionId: MC.model,
        placeholder: '选择模型',
        initial: state.model,
        options: visible.map((m) => ({ label: m.displayName, value: m.id })),
      }),
      selectStatic({
        actionId: MC.effort,
        placeholder: 'effort',
        initial: state.effort,
        options: efforts.map((e) => ({ label: `effort：${EFFORT_LABEL[e]}`, value: e })),
      }),
    ]),
  ];
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
  threads: ThreadSummary[];
  createdAt: number;
  /** in-flight guard (anti double-click) */
  launching?: boolean;
}

/** The `/resume` card: recent codex threads under this cwd, pick one to resume. */
export function buildResumeCard(state: ResumeCardState): CardObject {
  const elements = [md('🕘 **恢复历史会话**'), note(metaNote(state)), hr()];
  if (state.threads.length === 0) {
    elements.push(md('_该目录下还没有历史会话。直接 @我 即可新建。_'));
  } else {
    for (const t of state.threads) {
      const title = t.name?.trim() || t.preview.trim() || '(无摘要)';
      elements.push(md(`**${truncate(title, 80)}**`));
      elements.push(
        actions([button(`↩️ 恢复 · ${relativeTime(t.updatedAt || t.createdAt)}`, { a: RES.pick, t: t.codexThreadId })]),
      );
    }
  }
  return card(elements, { summary: '恢复历史会话' });
}

/** Transient "resuming…" card — interactive controls removed (anti double-click). */
export function buildResumeLaunchingCard(state: ResumeCardState): CardObject {
  return card([md('⏳ 正在恢复历史会话…'), note(metaNote(state))], { summary: '恢复中' });
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
