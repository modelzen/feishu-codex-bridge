import type { ModelInfo, ReasoningEffort, ThreadSummary } from '../agent/types';
import { actions, button, card, hr, md, note, selectStatic, type CardObject } from './cards';

/** Action ids for the session config / resume card. */
export const SC = {
  model: 'cfg.model',
  effort: 'cfg.effort',
  create: 'cfg.create',
  resume: 'cfg.resume',
  back: 'cfg.back',
  pick: 'cfg.pick',
} as const;

/**
 * Server-side state for one pending config card, keyed by the card's messageId
 * in the orchestrator. Holds everything needed to launch the session when the
 * user clicks 创建/恢复 (the first message, target cwd, chosen model/effort).
 */
export interface SessionConfigState {
  chatId: string;
  /** original @bot message id — reply_in_thread to it creates the topic */
  originalMsgId: string;
  requesterOpenId: string;
  /** the user's first message (stripped of the @bot mention) */
  text: string;
  cwd: string;
  projectName?: string;
  branch?: string;
  models: ModelInfo[];
  /** selected model id */
  model: string;
  /** selected reasoning effort */
  effort: ReasoningEffort;
  mode: 'config' | 'resume';
  /** populated in resume mode */
  threads?: ThreadSummary[];
  /** when the card was posted (ms) — for TTL pruning of abandoned cards */
  createdAt: number;
  /** in-flight launch guard (anti double-click) */
  launching?: boolean;
}

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: '无',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
};

function modelOf(state: SessionConfigState): ModelInfo | undefined {
  return state.models.find((m) => m.id === state.model);
}

function metaNote(state: SessionConfigState): string {
  const parts = [`📂 \`${state.cwd}\``];
  if (state.projectName) parts.unshift(`📁 ${state.projectName}`);
  if (state.branch) parts.push(`🌿 ${state.branch}`);
  return parts.join('   ');
}

/** The config card: pick model/effort, then 创建新会话 or 恢复历史会话. */
export function buildSessionConfigCard(state: SessionConfigState): CardObject {
  if (state.mode === 'resume') return buildResumeCard(state);

  const visibleModels = state.models.filter((m) => !m.hidden);
  const model = modelOf(state);
  const efforts = (model?.supportedEfforts.length ? model.supportedEfforts : (['low', 'medium', 'high'] as ReasoningEffort[]));

  const elements = [
    md(state.text ? `**首条消息**\n${truncate(state.text, 300)}` : '_（无首条消息，创建后直接在话题里 @我 对话）_'),
    note(metaNote(state)),
    hr(),
    actions([
      selectStatic({
        actionId: SC.model,
        placeholder: '选择模型',
        initial: state.model,
        options: visibleModels.map((m) => ({ label: m.displayName, value: m.id })),
      }),
      selectStatic({
        actionId: SC.effort,
        placeholder: 'effort',
        initial: state.effort,
        options: efforts.map((e) => ({ label: `effort：${EFFORT_LABEL[e]}`, value: e })),
      }),
    ]),
    actions([
      button('✅ 创建新会话', { a: SC.create }, 'primary'),
      button('🔁 恢复历史会话', { a: SC.resume }),
    ]),
  ];

  return card(elements, { header: { title: '🆕 新建会话', template: 'blue' } });
}

/** The resume picker: recent codex threads under this cwd. */
function buildResumeCard(state: SessionConfigState): CardObject {
  const threads = state.threads ?? [];
  const elements = [
    note(metaNote(state)),
    hr(),
  ];

  if (threads.length === 0) {
    elements.push(md('_该目录下还没有历史会话。_'));
  } else {
    for (const t of threads) {
      const title = t.name?.trim() || t.preview.trim() || '(无摘要)';
      elements.push(md(`**${truncate(title, 80)}**`));
      elements.push(
        actions([
          button(`↩️ 恢复 · ${relativeTime(t.updatedAt || t.createdAt)}`, { a: SC.pick, t: t.codexThreadId }),
        ]),
      );
    }
  }

  elements.push(hr());
  elements.push(actions([button('⬅️ 返回', { a: SC.back })]));
  return card(elements, { header: { title: '🔁 恢复历史会话', template: 'wathet' } });
}

/** Transient "launching" card — interactive controls removed (anti double-click). */
export function buildConfigLaunchingCard(state: SessionConfigState, kind: 'created' | 'resumed'): CardObject {
  const label = kind === 'created' ? '正在创建新会话…' : '正在恢复历史会话…';
  return card([md(`⏳ ${label}`), note(metaNote(state))], {
    header: { title: '🆕 新建会话', template: 'grey' },
  });
}

/** Failure card — keeps the action retryable (返回配置). */
export function buildConfigErrorCard(state: SessionConfigState, message: string): CardObject {
  return card(
    [
      md(`❌ 启动失败：${truncate(message, 200)}`),
      note(metaNote(state)),
      actions([button('🔁 重试', { a: SC.back })]),
    ],
    { header: { title: '🆕 新建会话', template: 'red' } },
  );
}

/** A terminal (non-interactive) card shown after the session is launched. */
export function buildConfigDoneCard(
  state: SessionConfigState,
  kind: 'created' | 'resumed',
): CardObject {
  const model = modelOf(state);
  const label = kind === 'created' ? '已创建新会话' : '已恢复历史会话';
  return card(
    [
      md(`✅ **${label}** → 见下方话题`),
      note(
        `${metaNote(state)}   🤖 ${model?.displayName ?? state.model}   ⚙️ effort：${EFFORT_LABEL[state.effort]}`,
      ),
    ],
    { header: { title: '🆕 新建会话', template: 'grey' } },
  );
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Coarse relative time from a unix-seconds timestamp. */
function relativeTime(unixSeconds: number): string {
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
