import {
  actions,
  button,
  card,
  collapsiblePanel,
  md,
  noteMd,
  type CardElement,
  type CardObject,
} from './cards';
import {
  reasoningContent,
  type Block,
  type FooterStatus,
  type RunState,
  type ToolEntry,
} from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

/** Action ids for the in-topic run card. */
export const RC = {
  stop: 'run.stop',
} as const;

const REASONING_MAX = 1500;
/** Collapse N tool calls into one summary panel at/above this count. */
const COLLAPSE_TOOL_THRESHOLD = 3;

/** Routing + render inputs for one run card. */
export interface RunCardState {
  rs: RunState;
  /** identity for ⏹ stop routing (the card's own messageId) */
  cardKey?: string;
  /** topic thread id (known after the topic is created) */
  threadId?: string;
  /** who started this run — only they (or an admin) may ⏹ it (design §5) */
  requesterOpenId?: string;
  /** drop tool blocks from the render (pref) */
  showTools?: boolean;
}

/**
 * Render the run card from its structured state (no header; reasoning + tool
 * calls as collapsible panels; text streams in order). Modeled on
 * zara/feishu-claude-code-bridge `src/card/run-renderer.ts`. While running the
 * card carries streaming_mode so whole-card updates animate the text delta.
 */
export function buildRunCard(rc: RunCardState): CardObject {
  const state = rc.rs;
  const running = state.terminal === 'running';
  const elements: CardElement[] = [];

  const reasoning = reasoningContent(state);
  if (reasoning) elements.push(reasoningPanel(reasoning, state.reasoningActive));

  const blocks = rc.showTools === false ? state.blocks.filter((b) => b.kind !== 'tool') : state.blocks;
  for (const group of groupBlocks(blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) elements.push(md(group.content));
    } else {
      elements.push(...renderToolGroup(group.tools, !running));
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    elements.push(noteMd(`_⏱ ${state.idleTimeoutMinutes ?? 0} 分钟无响应，已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (running) {
    if (state.footer) elements.push(footerStatus(state.footer));
    if (rc.cardKey) elements.push(actions([button('⏹ 终止', { a: RC.stop, m: rc.cardKey }, 'danger')]));
  }

  return card(elements, { streaming: running, summary: summaryText(state) });
}

/** Button-less version — used to demote a previous turn's card. */
export function buildRunCardPlain(rc: RunCardState): CardObject {
  return buildRunCard({ ...rc, cardKey: undefined });
}

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): CardElement[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) return [collapsedToolSummary(tools, true)];
  // running: collapse prior tools into a summary, keep the latest one visible
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: CardElement[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): CardElement {
  return collapsiblePanel({
    title: active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**',
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): CardElement {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * N tool calls as one collapsed panel — only the per-tool header line is kept
 * (no bodies). Nesting full output panels can blow past Feishu's ~30KB
 * per-element limit and 400 the whole card stream.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): CardElement {
  const suffix = finalized ? '（已结束）' : '';
  return collapsiblePanel({
    title: `☕ **${tools.length} 个工具调用${suffix}**`,
    expanded: false,
    border: 'blue',
    body: tools.map((t) => `- ${toolHeaderText(t)}`).join('\n'),
  });
}

function footerStatus(status: Exclude<FooterStatus, null>): CardElement {
  const text = status === 'thinking' ? '🧠 正在思考' : status === 'tool_running' ? '🧰 正在调用工具' : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
