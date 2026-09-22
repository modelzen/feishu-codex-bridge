import type { AgentEvent, ToolKind } from '../agent/types';

/**
 * Structured run state for the in-topic run card. AgentEvents are folded into
 * this (pure {@link reduce}) and {@link buildRunCard} renders it — reasoning and
 * tool calls become collapsible panels, text streams in order. Modeled on
 * zara/feishu-claude-code-bridge `src/card/run-state.ts`, adapted to this
 * repo's event shape (text_delta/text + thinking_delta/thinking keyed by
 * itemId, commandExecution carrying its command as `title` + aggregatedOutput).
 */

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  /** itemId from the agent event */
  id: string;
  /** human-readable label (for commandExecution this IS the command) */
  title: string;
  /** secondary detail, e.g. cwd for a shell command */
  detail?: string;
  /** coarse category — drives rendering (command → full ```bash body). Absent ⇒ 'tool'. */
  kind?: ToolKind;
  status: ToolStatus;
  output?: string;
  exitCode?: number | null;
}

export type Block =
  | { kind: 'reasoning'; id: string; content: string; streaming: boolean }
  | { kind: 'text'; id: string; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

/** One reasoning item (codex may emit several across a turn). */
export interface ReasoningItem {
  id: string;
  text: string;
}

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | 'retrying' | null;
export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  startedAt?: number;
  completedAt?: number;
  /** reasoning + text + tool blocks in arrival order (text/tool interleave preserved) */
  blocks: Block[];
  /** reasoning items, keyed by id so deltas + final reconcile without dupes */
  reasoning: ReasoningItem[];
  reasoningActive: boolean;
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  /** set when terminal === 'idle_timeout' — seconds idle before watchdog gave up */
  idleTimeoutSeconds?: number;
  /** latest context-window usage (from context_usage events); drives the run
   * card's threshold gauge. `window` null when codex reports no window. */
  usage?: { used: number; window: number | null };
}

export const initialState: RunState = {
  blocks: [],
  reasoning: [],
  reasoningActive: false,
  footer: 'thinking',
  terminal: 'running',
};

/** Joined reasoning text across all items (for the reasoning panel body). */
export function reasoningContent(state: RunState): string {
  return state.reasoning
    .map((r) => r.text)
    .filter((t) => t.trim())
    .join('\n\n');
}

/**
 * The agent's FINAL message — the content of the last non-empty text block.
 * Codex emits several agentMessage items per turn (progress/preamble messages
 * plus the actual answer); for a one-shot reply with no streaming UI (a
 * cloud-doc comment) we want only the last one, not all of them concatenated.
 * Returns '' if the turn produced no text.
 */
export function finalMessageText(state: RunState): string {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b && b.kind === 'text' && b.content.trim()) return b.content.trim();
  }
  return '';
}

function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) => (b.kind !== 'tool' && b.streaming ? { ...b, streaming: false } : b));
}

function upsertText(blocks: Block[], id: string, mutate: (prev: string) => string, kind: 'text' | 'reasoning' = 'text'): Block[] {
  const idx = blocks.findIndex((b) => b.kind === kind && b.id === id);
  if (idx === -1) {
    return [...closeStreamingText(blocks), { kind, id, content: mutate(''), streaming: true }];
  }
  const prev = blocks[idx] as Exclude<Block, { kind: 'tool' }>;
  const next: Block = { ...prev, content: mutate(prev.content) };
  return [...blocks.slice(0, idx), next, ...blocks.slice(idx + 1)];
}

function upsertReasoning(items: ReasoningItem[], id: string, mutate: (prev: string) => string): ReasoningItem[] {
  const idx = items.findIndex((r) => r.id === id);
  if (idx === -1) return [...items, { id, text: mutate('') }];
  const prev = items[idx]!;
  const next: ReasoningItem = { id: prev.id, text: mutate(prev.text) };
  return [...items.slice(0, idx), next, ...items.slice(idx + 1)];
}

/** Fold one normalized AgentEvent into the run state (pure). */
export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text_delta':
      return {
        ...state,
        blocks: upsertText(state.blocks, evt.itemId, (prev) => prev + evt.delta),
        reasoningActive: false,
        footer: 'streaming',
      };

    case 'text': {
      // item/completed → the reconciled full text; replace the streamed buffer.
      const idx = state.blocks.findIndex((b) => b.kind === 'text' && b.id === evt.itemId);
      const blocks =
        idx === -1
          ? [...state.blocks, { kind: 'text', id: evt.itemId, content: evt.text, streaming: false } as Block]
          : [
              ...state.blocks.slice(0, idx),
              { kind: 'text', id: evt.itemId, content: evt.text, streaming: false } as Block,
              ...state.blocks.slice(idx + 1),
            ];
      return { ...state, blocks, reasoningActive: false };
    }

    case 'thinking_delta':
      return {
        ...state,
        blocks: upsertText(state.blocks, evt.itemId, (prev) => prev + evt.delta, 'reasoning'),
        reasoning: upsertReasoning(state.reasoning, evt.itemId, (prev) => prev + evt.delta),
        reasoningActive: true,
        footer: state.footer === 'streaming' ? state.footer : 'thinking',
      };

    case 'thinking':
      return {
        ...state,
        blocks: upsertText(state.blocks, evt.itemId, () => evt.text, 'reasoning').map(b =>
          b.kind === 'reasoning' && b.id === evt.itemId ? { ...b, streaming: false } : b),
        reasoning: upsertReasoning(state.reasoning, evt.itemId, () => evt.text),
      };

    case 'tool_use': {
      const existing = state.blocks.findIndex(b => b.kind === 'tool' && b.tool.id === evt.itemId);
      if (existing >= 0) {
        return {
          ...state,
          blocks: state.blocks.map((b, index) => index === existing && b.kind === 'tool'
            ? { ...b, tool: { ...b.tool, title: evt.title,
              detail: evt.detail ?? b.tool.detail, kind: evt.kind ?? b.tool.kind } }
            : b),
        };
      }
      const tool: ToolEntry = {
        id: evt.itemId,
        title: evt.title,
        detail: evt.detail,
        kind: evt.kind,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoningActive: false,
        footer: 'tool_running',
      };
    }

    case 'tool_result': {
      const isError = evt.exitCode != null && evt.exitCode !== 0;
      const blocks = state.blocks.map((b) => {
        if (b.kind !== 'tool' || b.tool.id !== evt.itemId) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: isError ? ('error' as const) : ('done' as const),
            output: evt.output,
            exitCode: evt.exitCode,
          },
        };
      });
      return { ...state, blocks };
    }

    case 'context_usage':
      return { ...state, usage: { used: evt.usedTokens, window: evt.contextWindow } };

    // context_compacted is surfaced as a standalone notice by the run loop, not
    // folded into the card — fall through to the no-op default.

    case 'error':
      // willRetry: codex 瞬断后会自己重试 — NOT terminal. Flipping to the error
      // layout here flashes a fake "失败" (and drops the ⏹ button) that the next
      // event would revert; surface a retrying footer instead and let the
      // follow-up deltas overwrite it.
      if (evt.willRetry) {
        return { ...state, footer: 'retrying' };
      }
      return { ...state, terminal: 'error', errorMsg: evt.message, footer: null };

    case 'done':
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoningActive: false,
        terminal: 'done',
        footer: null,
      };

    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoningActive: false,
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, seconds: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoningActive: false,
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutSeconds: seconds,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoningActive: false,
    terminal: 'done',
    footer: null,
  };
}
