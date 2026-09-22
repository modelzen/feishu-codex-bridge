import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, ToolKind } from '../types';

/**
 * Map the Claude Agent SDK message stream to normalized {@link AgentEvent}s.
 *
 * Unlike codex's stateless `mapNotification`, the SDK stream needs a tiny bit of
 * per-turn state: it interleaves token-level `stream_event` deltas (only with
 * `includePartialMessages: true`) with whole `assistant`/`user` messages, and
 * text/thinking content blocks carry NO stable id. So we mint our own itemId per
 * content block and correlate the block's start → deltas → stop by its stream
 * `index` (an index is unique among currently-open blocks — blocks stream
 * sequentially within a message and a new message's block 0 only starts after the
 * previous message's blocks stopped). Tool calls DO carry a stable `id`, so those
 * map straight off the full `assistant`/`user` messages (no index needed).
 *
 * Observed message order (verified via spike, SDK 0.3.178):
 *   system/init → (per assistant API message) message_start →
 *     content_block_start(idx) → content_block_delta(idx)* →
 *     [full `assistant` message for that one block] → content_block_stop(idx) →
 *   … → [`user` message carrying tool_result blocks] → … → result
 * Each content block surfaces as its OWN `assistant` message (one block each).
 *
 * Event production per block:
 *   text     → text_delta(itemId)* (from deltas) then text(itemId) (at stop)
 *   thinking → thinking_delta(itemId)* then thinking(itemId)
 *   tool_use → tool_use(itemId = block.id) (from the assistant message)
 *   tool_result (user msg) → tool_result(itemId = tool_use_id)
 * The thread layer owns turn_started/done (synthetic turnId — the SDK has no turn
 * id; interrupt() needs none); this mapper emits everything else, and on `result`
 * emits usage + context_usage (the thread appends `done`).
 */

export interface ClaudeMapContext {
  /** thread cwd, to relativize file paths in tool titles */
  cwd?: string;
}

type Kind = 'text' | 'thinking' | 'tool_use' | 'other';
interface OpenBlock {
  itemId: string;
  kind: Kind;
  acc: string;
}

// Minimal structural shapes for the bits we read (avoids fighting the SDK's
// re-exported Anthropic Beta types; we only touch a handful of fields).
interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

export interface TurnMapper {
  /** Map one raw SDK message to zero or more AgentEvents (in order). */
  map(msg: SDKMessage): AgentEvent[];
}

/** Create a per-turn mapper. One per `runStreamed` turn (state resets with it). */
export function createTurnMapper(ctx: ClaudeMapContext = {}): TurnMapper {
  let blockSeq = 0;
  const open = new Map<number, OpenBlock>();
  let systemEmitted = false;
  // Captured from system/init — the result message has NO `model`, so the context
  // window fallback must read it here (else the window shows as 未知/unknown).
  let initModel: string | undefined;

  function map(msg: SDKMessage): AgentEvent[] {
    const m = msg as unknown as Record<string, any>;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          if (typeof m.model === 'string') initModel = m.model;
          if (!systemEmitted) {
            systemEmitted = true;
            return [{ type: 'system', threadId: String(m.session_id ?? '') }];
          }
        }
        // Auto-compaction during a turn → surface the「上下文已压缩」notice.
        if (m.subtype === 'compact_boundary') return [{ type: 'context_compacted' }];
        return [];

      case 'stream_event':
        return mapStreamEvent(m.event);

      case 'assistant': {
        const content = (m.message?.content ?? []) as ContentBlock[];
        // Synthetic API failures may have no stream_event text deltas and can
        // even precede an empty success result. Preserve the explicit SDK error
        // instead of silently dropping its text. max_output_tokens is a
        // recoverable truncation signal, not a terminal API rejection. A nested
        // agent's failure is owned by its parent tool, not the whole user turn.
        if (m.parent_tool_use_id == null && m.error !== 'max_output_tokens' && (m.error || m.isApiErrorMessage === true)) {
          const message = content
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
            .trim();
          return [{
            type: 'error',
            message: message || `模型服务请求失败（${String(m.error ?? 'unknown')}）`,
            willRetry: false,
          }];
        }
        const out: AgentEvent[] = [];
        for (const b of content) {
          if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            out.push({
              type: 'tool_use',
              itemId: String(b.id ?? `tool${++blockSeq}`),
              title: toolTitle(b.name ?? '工具', b.input ?? {}, ctx.cwd),
              detail: toolDetail(b.name ?? '', b.input ?? {}),
              kind: toolKind(b.name ?? ''),
            });
          }
        }
        return out;
      }

      case 'user': {
        const content = m.message?.content;
        if (!Array.isArray(content)) return [];
        const out: AgentEvent[] = [];
        for (const b of content as ContentBlock[]) {
          if (b.type === 'tool_result') {
            out.push({
              type: 'tool_result',
              itemId: String(b.tool_use_id ?? ''),
              output: toolResultText(b.content),
              exitCode: b.is_error ? 1 : 0,
            });
          }
        }
        return out;
      }

      case 'result': {
        // The turn boundary. We emit only usage/context here; the THREAD inspects
        // the result message to decide `done` vs `error` (it knows whether the
        // user pressed ⏹ — an interrupted turn ends with subtype
        // 'error_during_execution', which is NOT a real failure). See thread.ts.
        const out: AgentEvent[] = [];
        const usage = m.usage as Record<string, number> | undefined;
        if (usage) {
          out.push({
            type: 'usage',
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
          });
          // Fallback context gauge (the thread overrides this with the authoritative
          // getContextUsage() reading). used = input + cache_read + cache_creation
          // (≈ the request's full input context — verified to equal getContextUsage
          // totalTokens). Window comes from the init model, NOT result.model (absent).
          const used =
            (usage.input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
          if (used > 0) {
            out.push({ type: 'context_usage', usedTokens: used, contextWindow: contextWindowFor(initModel) });
          }
        }
        return out;
      }

      // Transient API hiccup the SDK auto-retries — surface a retrying footer
      // (run-state keeps the ⏹ button and lets the next deltas overwrite it).
      case 'system_api_retry':
      case 'api_retry':
        return [{ type: 'error', message: '网络波动，正在重试…', willRetry: true }];

      default:
        return [];
    }
  }

  function mapStreamEvent(ev: Record<string, any> | undefined): AgentEvent[] {
    if (!ev || typeof ev.type !== 'string') return [];
    switch (ev.type) {
      case 'content_block_start': {
        const idx = ev.index as number;
        const cb = (ev.content_block ?? {}) as ContentBlock;
        const kind: Kind =
          cb.type === 'thinking' || cb.type === 'redacted_thinking'
            ? 'thinking'
            : cb.type === 'text'
              ? 'text'
              : cb.type === 'tool_use' || cb.type === 'server_tool_use'
                ? 'tool_use'
                : 'other';
        open.set(idx, { itemId: `b${++blockSeq}`, kind, acc: '' });
        return [];
      }
      case 'content_block_delta': {
        const b = open.get(ev.index as number);
        if (!b) return [];
        const d = (ev.delta ?? {}) as Record<string, any>;
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          b.acc += d.text;
          return [{ type: 'text_delta', itemId: b.itemId, delta: d.text }];
        }
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          b.acc += d.thinking;
          return [{ type: 'thinking_delta', itemId: b.itemId, delta: d.thinking }];
        }
        return [];
      }
      case 'content_block_stop': {
        const idx = ev.index as number;
        const b = open.get(idx);
        open.delete(idx);
        if (!b || !b.acc) return [];
        if (b.kind === 'text') return [{ type: 'text', itemId: b.itemId, text: b.acc }];
        if (b.kind === 'thinking') return [{ type: 'thinking', itemId: b.itemId, text: b.acc }];
        return [];
      }
      default:
        return [];
    }
  }

  return { map };
}

// ── tool rendering helpers ──────────────────────────────────────────────────

/** A Claude built-in tool call → a short Chinese title, mirroring codex's
 * command-as-title convention (Bash shows the command itself). Exported so the
 * history folder (resume card) renders tool calls identically to the live stream. */
export function toolTitle(name: string, input: Record<string, unknown>, cwd?: string): string {
  const s = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return s('command') || 'Shell 命令';
    case 'Read':
      return `读取 ${displayPath(s('file_path'), cwd)}`;
    case 'Write':
      return `写入 ${displayPath(s('file_path'), cwd)}`;
    case 'Edit':
    case 'MultiEdit':
      return `编辑 ${displayPath(s('file_path'), cwd)}`;
    case 'NotebookEdit':
      return `编辑笔记本 ${displayPath(s('notebook_path'), cwd)}`;
    case 'Glob':
      return `查找 ${s('pattern')}`.trim();
    case 'Grep':
      return `搜索 ${s('pattern')}`.trim();
    case 'WebFetch':
      return `抓取网页 ${s('url')}`.trim();
    case 'WebSearch':
      return `联网搜索 ${s('query')}`.trim();
    case 'Task':
      return `子任务：${s('description') || s('subagent_type') || ''}`.trim();
    case 'TodoWrite':
      return '更新待办清单';
    case 'ExitPlanMode':
      return '提交方案';
    default:
      return name || '工具调用';
  }
}

/**
 * Coarse category for a Claude tool, so the card renders it right (command →
 * full ```bash body, file/search/tool → label header). Mirrors {@link toolTitle}'s
 * switch: Bash IS a shell command (title carries the command line); file edits
 * and searches carry a short label title.
 */
function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return 'command';
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'file';
    case 'Glob':
    case 'Grep':
    case 'WebFetch':
    case 'WebSearch':
      return 'search';
    default:
      return 'tool';
  }
}

/** Secondary line for a tool block (e.g. a Bash command's description). */
function toolDetail(name: string, input: Record<string, unknown>): string | undefined {
  if (name === 'Bash' && typeof input.description === 'string' && input.description) {
    return input.description;
  }
  return undefined;
}

/** tool_result.content is a string or an array of {type:'text',text} (and image)
 * blocks — flatten to plain text for the card's tool output panel. */
function toolResultText(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const x = b as Record<string, any>;
        if (x?.type === 'text' && typeof x.text === 'string') return x.text;
        if (x?.type === 'image') return '[图片]';
        return '';
      })
      .join('')
      .trim();
    return text || undefined;
  }
  return undefined;
}

const PATH_TAIL_MAX = 40;
/** Relative path inside cwd / absolute outside it (so an out-of-project touch is
 * visible); with no cwd, long paths keep only trailing segments. Mirrors
 * codex event-map's displayPath. */
function displayPath(p: string, cwd?: string): string {
  if (!p) return '文件';
  if (cwd) {
    const sep = cwd.includes('\\') ? '\\' : '/';
    const root = cwd.endsWith(sep) ? cwd : cwd + sep;
    if (p.startsWith(root) && p.length > root.length) return p.slice(root.length);
  }
  if (p.length <= PATH_TAIL_MAX || !p.includes('/')) return p;
  const segs = p.split('/');
  let out = segs[segs.length - 1] ?? p;
  for (let i = segs.length - 2; i >= 0; i--) {
    const cand = `${segs[i]}/${out}`;
    if (cand.length > PATH_TAIL_MAX) break;
    out = cand;
  }
  return `…/${out}`;
}

/** Model context window heuristic — the SDK's result message doesn't report it.
 * `[1m]`-suffixed / 1m-context models get 1,000,000; otherwise the 200k default.
 * Approximate (drives only the gauge percentage); refine if the SDK exposes it. */
function contextWindowFor(model: unknown): number | null {
  const id = typeof model === 'string' ? model.toLowerCase() : '';
  if (!id) return null;
  if (id.includes('1m') || id.includes('[1m]')) return 1_000_000;
  return 200_000;
}

/** Human-readable error text for a non-success `result` message. Used by the
 * thread when a turn ends in failure (not an interrupt). */
export function resultErrorText(m: Record<string, unknown>): string {
  if (Array.isArray(m.errors)) {
    const errors = m.errors.filter((e): e is string => typeof e === 'string' && !!e.trim());
    if (errors.length) return errors.join('\n');
  }
  const result = m.result;
  if (typeof result === 'string' && result.trim()) return result.trim();
  const subtype = m.subtype;
  if (typeof subtype === 'string') {
    if (subtype === 'error_max_turns') return '已达到最大轮次限制';
    if (subtype === 'error_max_budget_usd') return '已达到预算上限';
    return `运行出错（${subtype}）`;
  }
  return '运行出错';
}
