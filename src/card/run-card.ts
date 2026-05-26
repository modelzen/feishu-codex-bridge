import type { ModelInfo, ReasoningEffort } from '../agent/types';
import {
  actions,
  button,
  card,
  hr,
  md,
  note,
  selectStatic,
  type CardObject,
  type HeaderTemplate,
} from './cards';

/** Action ids for the in-topic run card. */
export const RC = {
  stop: 'run.stop',
  settings: 'run.settings',
  model: 'run.model',
  effort: 'run.effort',
} as const;

export type RunStatus = 'running' | 'done' | 'error' | 'timeout';

const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: '无',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
};

/** Everything needed to render (and re-render) one run card. */
export interface RunCardState {
  /** rendered body markdown (RunRender.markdown()) */
  body: string;
  status: RunStatus;
  model?: string;
  effort?: ReasoningEffort;
  cwd?: string;
  branch?: string;
  /** identity for ⏹ stop routing (the card's own messageId) */
  cardKey?: string;
  /** topic thread id for ⚙️ settings routing (known after topic created) */
  threadId?: string;
  /** ⚙️ settings panel open */
  expanded?: boolean;
  models?: ModelInfo[];
  /** transient confirmation under the settings panel */
  settingsNote?: string;
}

function headerTitle(state: RunCardState): string {
  const model = state.models?.find((m) => m.id === state.model);
  const name = model?.displayName ?? state.model ?? 'codex';
  const eff = state.effort ? ` · effort：${EFFORT_LABEL[state.effort]}` : '';
  return `🤖 ${name}${eff}`;
}

/** Build the run card. While running → ⏹ 中止; once终态 → ⚙️ 设置(挂最新卡). */
export function buildRunCard(state: RunCardState): CardObject {
  const elements = [md(state.body || '✍️ 正在输出…')];

  if (state.status === 'running') {
    if (state.cardKey) {
      elements.push(actions([button('⏹ 中止', { a: RC.stop, m: state.cardKey }, 'danger')]));
    }
  } else if (state.threadId) {
    // terminal: offer ⚙️ settings on this (the latest) card
    if (state.expanded) {
      const models = (state.models ?? []).filter((m) => !m.hidden);
      const cur = state.models?.find((m) => m.id === state.model);
      const efforts = cur?.supportedEfforts.length ? cur.supportedEfforts : (['low', 'medium', 'high'] as ReasoningEffort[]);
      elements.push(hr());
      elements.push(note(metaNote(state)));
      elements.push(
        actions([
          selectStatic({
            actionId: RC.model,
            placeholder: '模型',
            initial: state.model,
            options: models.map((m) => ({ label: m.displayName, value: m.id })),
          }),
          selectStatic({
            actionId: RC.effort,
            placeholder: 'effort',
            initial: state.effort,
            options: efforts.map((e) => ({ label: `effort：${EFFORT_LABEL[e]}`, value: e })),
          }),
        ]),
      );
      if (state.settingsNote) elements.push(note(state.settingsNote));
      elements.push(actions([button('⬆️ 收起设置', { a: RC.settings, t: state.threadId })]));
    } else {
      elements.push(actions([button('⚙️ 设置', { a: RC.settings, t: state.threadId })]));
    }
  }

  const template: HeaderTemplate =
    state.status === 'error' || state.status === 'timeout'
      ? 'red'
      : state.status === 'running'
        ? 'turquoise'
        : 'grey';
  return card(elements, { header: { title: headerTitle(state), template } });
}

/** A plain (button-less) version — used to demote a previous turn's card. */
export function buildRunCardPlain(state: RunCardState): CardObject {
  return card([md(state.body || ' ')], { header: { title: headerTitle(state), template: 'grey' } });
}

function metaNote(state: RunCardState): string {
  const parts: string[] = [];
  if (state.cwd) parts.push(`📂 \`${state.cwd}\``);
  if (state.branch) parts.push(`🌿 ${state.branch}`);
  parts.push('改动下一轮生效');
  return parts.join('   ');
}
