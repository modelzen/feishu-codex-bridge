import type { HistoryTool, HistoryTurn, ThreadHistory } from '../agent/types';
import {
  card,
  collapsiblePanel,
  collapsiblePanelEl,
  hr,
  md,
  note,
  noteMd,
  type CardElement,
  type CardObject,
} from './cards';
import { relativeTime } from './command-cards';

/**
 * The "已恢复历史会话" card — posted as the first message of the resumed topic
 * (reply_in_thread on the /resume message creates the topic). It is a pure,
 * non-streaming digest: every turn is a collapsed {@link collapsiblePanel}
 * (collapse/expand is client-side, no callback), and reasoning + tool detail
 * fold one level deeper ("一层层下钻"). The codex session itself is already
 * bound to this topic and resumes on the next message — this card is just the
 * "where we left off" you see before continuing.
 */
export interface HistoryCardState {
  cwd: string;
  projectName?: string;
  history: ThreadHistory;
}

// Per-field truncation — Feishu 400s a card if any element nears ~30KB, so the
// transcript is a digest, not a full replay (codex keeps the real context).
const USER_MAX = 300;
const ASSIST_MAX = 800;
const REASON_MAX = 600;
const TOOL_TITLE_MAX = 90;
const TOOLS_BODY_MAX = 700;
const TOOLS_MAX_LINES = 12;
const PREVIEW_MAX = 160;
// Collapsed-state title = the user's question, one line.
const TITLE_Q_MAX = 56;
// JSON overhead of a collapsible_panel wrapper (header/icon/border/padding),
// charged on top of its body so the budget reflects real serialized size.
const PANEL_SHELL = 360;
// Whole-card content budget. Set well under Feishu's ~30KB hard limit to leave
// headroom for the header / meta / footer / preview that aren't counted in
// `used`; older turns past it degrade to a title-only panel.
const BODY_BUDGET = 18_000;

export function buildHistoryCard(state: HistoryCardState): CardObject {
  const { history } = state;
  const elements: CardElement[] = [metaNote(state)];

  if (history.turns.length === 0) {
    elements.push(
      hr(),
      md('_这个会话还没有可显示的历史（可能是空会话或刚创建）。_'),
      hr(),
      resumedFooter(),
    );
    return card(elements, { header: header(state), summary: '已恢复历史会话' });
  }

  const dropped = history.totalTurns - history.turns.length;
  if (dropped > 0) {
    elements.push(note(`仅显示最近 ${history.turns.length} 轮，更早的 ${dropped} 轮 Codex 仍保留在上下文中。`));
  }
  elements.push(hr());

  // Allocate budget newest→oldest so the most recent turns stay full and only
  // the oldest degrade to a title-only panel; emit oldest→newest for reading.
  const panels: CardElement[] = [];
  let used = 0;
  for (let i = history.turns.length - 1; i >= 0; i--) {
    const turn = history.turns[i];
    if (!turn) continue;
    const title = turnTitle(turn);
    const body = turnBody(turn);
    const size = estimateSize(body) + PANEL_SHELL;
    if (used + size > BODY_BUDGET && panels.length > 0) {
      const stub = '_（内容已省略，历史较长）_';
      panels.push(collapsiblePanel({ title, expanded: false, border: 'grey', body: stub }));
      used += title.length + stub.length + PANEL_SHELL;
    } else {
      panels.push(collapsiblePanelEl({ title, expanded: false, border: 'grey', elements: body }));
      used += size;
    }
  }
  panels.reverse();
  elements.push(...panels);

  const last = history.turns[history.turns.length - 1];
  const leftOff = last ? last.assistantText || last.userText || (last.tools.at(-1)?.title ?? '') : '';
  if (leftOff.trim()) {
    elements.push(hr(), noteMd(`📍 **上次停在**：${truncateTail(leftOff, PREVIEW_MAX)}`));
  } else {
    elements.push(hr());
  }
  elements.push(resumedFooter());

  return card(elements, { header: header(state), summary: `已恢复历史会话 · 共 ${history.totalTurns} 轮` });
}

function header(state: HistoryCardState): { title: string; template: 'turquoise'; subtitle?: string } {
  const { history } = state;
  const bits = [
    history.name?.trim() || state.projectName,
    `共 ${history.totalTurns} 轮`,
    history.updatedAt ? relativeTime(history.updatedAt) : undefined,
  ].filter(Boolean);
  return { title: '🕘 已恢复历史会话', template: 'turquoise', subtitle: bits.join(' · ') };
}

function metaNote(state: HistoryCardState): CardElement {
  const parts = [`📂 \`${state.cwd}\``];
  if (state.projectName) parts.unshift(`📁 ${state.projectName}`);
  return note(parts.join('   '));
}

function resumedFooter(): CardElement {
  return md('✅ **会话已恢复** —— 直接发消息即可继续。');
}

/**
 * Collapsed-state title of a turn: the user's question on one line, with a
 * trailing '…' when there's more. Tapping expands to the full Q&A + the
 * 思考/工具 detail fold (see {@link turnBody}) — the answer lives there, not in
 * the title, so the collapsed list stays a clean scan of the questions.
 */
function turnTitle(turn: HistoryTurn): string {
  if (turn.userText.trim()) return `👤 ${escapeInline(truncate(oneLine(turn.userText), TITLE_Q_MAX))}`;
  return '⚙️ 系统 / 工具调用';
}

/** The expandable body of one turn: full Q&A + a deeper fold for 思考/工具. */
function turnBody(turn: HistoryTurn): CardElement[] {
  const out: CardElement[] = [];
  if (turn.userText.trim()) out.push(md(`**👤 你**\n${truncate(turn.userText, USER_MAX)}`));
  if (turn.assistantText.trim()) out.push(md(`**🤖 Codex**\n${truncate(turn.assistantText, ASSIST_MAX)}`));
  if (!turn.assistantText.trim() && !turn.userText.trim() && turn.tools.length) {
    out.push(noteMd('_（仅工具调用，无文本回复）_'));
  }

  const detail: CardElement[] = [];
  if (turn.reasoning.trim()) detail.push(md(`🧠 **思考**\n${truncate(turn.reasoning, REASON_MAX)}`));
  if (turn.tools.length) detail.push(md(toolsBlock(turn.tools)));
  if (detail.length) {
    out.push(collapsiblePanelEl({ title: detailTitle(turn), expanded: false, border: 'blue', elements: detail }));
  }
  return out;
}

function detailTitle(turn: HistoryTurn): string {
  const parts: string[] = [];
  if (turn.reasoning.trim()) parts.push('🧠 思考');
  if (turn.tools.length) parts.push(`🧰 ${turn.tools.length} 个工具`);
  return `🔎 ${parts.join(' · ')}`;
}

function toolsBlock(tools: HistoryTool[]): string {
  const lines: string[] = [`🧰 **工具调用（${tools.length}）**`];
  let body = 0;
  let shown = 0;
  for (const t of tools) {
    if (shown >= TOOLS_MAX_LINES || body >= TOOLS_BODY_MAX) {
      lines.push(`_…还有 ${tools.length - shown} 个_`);
      break;
    }
    const line = toolLine(t);
    lines.push(line);
    body += line.length;
    shown += 1;
  }
  return lines.join('\n');
}

function toolLine(t: HistoryTool): string {
  const title = escapeInline(truncate(oneLine(t.title), TOOL_TITLE_MAX));
  const mark = t.failed ? ' ✗' : '';
  const exit = t.exitCode != null && t.exitCode !== 0 ? ` (exit ${t.exitCode})` : '';
  return `- \`${title}\`${mark}${exit}`;
}

/** Rough rendered-content size of an element list, for the budget guard. */
function estimateSize(els: CardElement[]): number {
  let n = 0;
  for (const el of els) n += JSON.stringify(el).length;
  return n;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Strip backticks so an inline-code span can't break out of its fence. */
function escapeInline(s: string): string {
  return s.replace(/`/g, '');
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Keep the END of `s`, prefixing '…' when content precedes it — used by
 * "上次停在" so it shows where the last reply actually stopped. */
function truncateTail(s: string, n: number): string {
  const t = oneLine(s);
  return t.length > n ? `…${t.slice(t.length - n)}` : t;
}
