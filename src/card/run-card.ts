import type { VoiceReply } from '../voice/types';
import { voiceReplyElements } from './voice-reply';
import {
  actions,
  button,
  card,
  collapsiblePanel,
  collapsiblePanelEl,
  md,
  mdStream,
  noteMd,
  splitRow,
  type CardElement,
  type CardObject,
} from './cards';
import type { ReasoningEffort } from '../agent/types';
import {
  reasoningContent,
  type Block,
  type FooterStatus,
  type RunState,
  type Terminal,
  type ToolEntry,
} from './run-state';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { renderRichText } from './markdown-render';
import { fileComponentCount, renderFileAnswer, type InlineFiles } from './inline-files';
import { hasMarkdownTable, renderReport } from './report-render';
import { StreamingImages } from './outbound-images';
import type { RunCardStream } from './run-card-stream';
import { toolBodyMd, toolHeaderText, toolSummaryLine } from './tool-render';
import { runCardGauge } from './context-gauge';

/** The context-usage gauge line, only at/above the warn tier (else null). */
function gaugeEl(state: RunState): CardElement | null {
  return state.usage ? runCardGauge(state.usage.used, state.usage.window) : null;
}

/** Action ids for the in-topic run card. */
export const RC = {
  stop: 'run.stop',
  /** manual completion-reminder mode: notify this turn's requester when it ends. */
  remind: 'run.remind',
  /** goal-only: clear the goal but let the in-flight turn finish (no auto-continue). */
  endGoal: 'goal.end',
} as const;

/**
 * Stable element_id of the streamed answer markdown while RUNNING. The answer
 * text is pushed to this element via cardkit.v1.cardElement.content for the
 * native typewriter (see {@link ../card/run-card-stream}); everything else
 * (reasoning / tools / footer) rides whole-card updates. Must be stable across
 * re-renders so the typewriter sees an append-only prefix.
 */
export const ANSWER_EID = 'answer';

/**
 * Stable element_id of the run/queued card's control row (⏹ / 🎯 / 取消). Lets
 * a post-restart orphan card self-heal on click: the in-process maps are gone
 * by then, so the handler can only recover the entity's card_id from the
 * carrier message and delete THIS element — the rest of the card is
 * unreconstructable (see healDeadRunCard in ../bot/handle-message).
 */
export const CONTROLS_EID = 'controls';

const REASONING_MAX = 1500;
/**
 * While RUNNING, once a tool group reaches this many calls, fold the prior ones
 * into a single summary panel and keep only the latest live (so the streaming
 * card stays cheap). Terminal cards render every tool as its own panel and lean
 * on {@link PROCESS_BODY_BUDGET}/{@link PROCESS_COMPONENT_BUDGET} instead.
 */
const COLLAPSE_TOOL_THRESHOLD = 3;
/**
 * Serialized-size budget for the terminal "过程" panel's body. Nesting every
 * reasoning/tool panel under one collapsible_panel can push that single element
 * past Feishu's ~30KB per-element limit and 400 the card; over budget we degrade
 * tool groups to a single full-command summary (no output bodies). Mirrors the
 * history-card budget guard. Kept under 30KB for wrapper/answer headroom.
 */
const PROCESS_BODY_BUDGET = 22_000;
/**
 * Component-count budget for the terminal "过程" body. Feishu silently DROPS a
 * whole card past ~200 nested components (error 300305) — a tool-heavy run
 * rendered as one panel per tool can blow that. Over budget we degrade tool
 * groups to summaries (1 component each) so the card always renders. Headroom
 * left under ~200 for the answer, footer, gauge and card wrapper.
 */
const PROCESS_COMPONENT_BUDGET = 120;
/** Byte cap on the batched summary's markdown body (one element, well under the
 * ~30KB per-element limit); over it the tail is dropped with a visible count. */
const SUMMARY_BODY_MAX = 6000;

/** Routing + render inputs for one run card. */
export interface RunCardState {
  rs: RunState;
  /** Independent of model text, preserved across live and terminal renders. */
  voiceMessages?: VoiceReply[];
  /** identity for ⏹ stop routing (the card's own messageId) */
  cardKey?: string;
  /** topic thread id (known after the topic is created) */
  threadId?: string;
  /** who started this run — only they (or an admin) may ⏹ it (design §5) */
  requesterOpenId?: string;
  /** drop tool blocks from the render (pref) */
  showTools?: boolean;
  /** model id for the bottom-right「模型 · 推理强度」footnote (e.g. 'gpt-5.5'); set
   * when 模型显示 is running OR always. Absent ⇒ no footnote (default / off). */
  model?: string;
  /** reasoning effort (推理强度) shown alongside {@link model}; colored by tier
   * (低黄/中绿/高浅紫/极高深紫). Only the 推理强度 word is tinted — the model name
   * stays grey. */
  effort?: ReasoningEffort;
  /** keep the footnote on the TERMINAL card too (模型显示 = always). Running cards
   * always show it when {@link model} is set; this only gates the terminal render
   * so the running-only(仅输出时) mode drops it once the turn finishes. */
  modelOnTerminal?: boolean;
  /** suppress the ⏹ 终止 button (used by non-goal cards that opt out of stop). */
  hideStop?: boolean;
  /** Present only in the global `manual` reminder mode. `available` renders the
   * one-shot “完成后提醒我” button; `requested` replaces it with a visible
   * confirmation. Non-manual modes leave this unset and therefore never expose
   * the per-turn button. */
  completionReminder?: 'available' | 'requested';
  /** goal run cards: show TWO controls — `⏹ 终止` (clear goal + cut output now)
   * and `🎯 结束目标` (clear goal, let the current turn finish, then stop). */
  goalControls?: boolean;
  /** goal run cards, after 🎯 结束目标 was tapped: the goal is cleared and this
   * turn is finishing — drop the 结束目标 button (keep ⏹ 终止) and show a notice. */
  goalEnding?: boolean;
  /** `![](src) → image_key`, filled in by the turn's background uploader
   * ({@link ./outbound-images}.StreamingImages) as each ref resolves — so a
   * running card swaps its placeholder for a real `img` element mid-stream, and
   * the terminal card shows every image that made it. An unresolved ref renders
   * as text, never as raw `![](…)` markdown (see {@link renderRichText}). */
  images?: ReadonlyMap<string, string>;
  /** Prepared at terminal, before rendering can discard local link targets. */
  localFiles?: InlineFiles;
}

/**
 * Wire a turn's background image uploader onto its run card.
 *
 * Two things have to happen together, and forgetting the first is invisible at
 * the terminal frame but glaring mid-turn:
 *
 *  1. `rc.images` must point at the worker's live map. The worker mutates that
 *     one map in place, so `buildRunCard(rc)` sees each `src → image_key` the
 *     moment it lands. Without it every repaint still renders the unresolved
 *     placeholder `🖼️ x.jpg（图片处理中…）`, and the picture only shows up in the
 *     terminal frame — i.e. the running card looks stuck even though the uploads
 *     all succeeded.
 *  2. A resolved key repaints the LIVE card ({@link RunCardStream.updateLiveCard}),
 *     which no-ops once the turn has been finalized, so a late upload can't fight
 *     the terminal frame.
 *
 * Lives next to {@link buildRunCard} because that is what it repaints with; the
 * uploader itself ({@link ./outbound-images}.StreamingImages) is injectable so a
 * test can drive this without a network or a codex process.
 */
export function attachRunImages(opts: {
  stream: Pick<RunCardStream, 'setImageWorker' | 'updateLiveCard'>;
  rc: RunCardState;
  channel: LarkChannel;
  /** `src[] → image_key`. Injected so this wiring is testable without a network;
   * production passes `(s) => uploadOutboundImages(channel, s, runCwd, mode)`
   * (see {@link ./outbound-images}). */
  upload: (sources: string[]) => Promise<Map<string, string>>;
}): StreamingImages {
  const { stream, rc, channel, upload } = opts;
  const worker = new StreamingImages(upload, () => {
    // The map is mutated in place, so the frame built below already carries every
    // key that has landed — including the ones that arrived before this repaint.
    rc.images = worker.images;
    void stream.updateLiveCard(channel, buildRunCard(rc)).catch(() => undefined);
  });
  // Point at the live map up-front too: any frame built from here on sees keys as
  // they arrive, without waiting for a repaint.
  rc.images = worker.images;
  stream.setImageWorker(worker, () => runningAnswerText(rc.rs));
  return worker;
}

/**
 * Render the run card from its structured state (no header; reasoning + tool
 * calls as collapsible panels; text streams in order). Modeled on
 * zara/feishu-claude-code-bridge `src/card/run-renderer.ts`. While running, each
 * whole-card update instantly shows the current full text (no typewriter — see
 * the streaming_mode note in {@link ./cards}); growth tracks the model in
 * throttled chunks.
 *
 * Two layouts: while RUNNING everything streams expanded (reasoning, tools and
 * preamble text inline) so the user watches progress live; once TERMINAL the
 * whole "process" (reasoning + tools + every text block except the final one)
 * folds into a single collapsed panel and only the final answer stays open —
 * see {@link renderTerminal}.
 */
export function buildRunCard(rc: RunCardState): CardObject {
  const state = rc.rs;
  const running = state.terminal === 'running';
  const elements = running ? renderRunning(state, rc) : renderTerminal(state, rc);
  return card([...voiceReplyElements(rc.voiceMessages), ...elements], { streaming: running, summary: summaryText(state) });
}

/**
 * Live layout: reasoning panel, tool panels, the streamed answer, footer
 * (status + model), then the ⏹ controls row pinned at the BOTTOM. Text blocks
 * are concatenated into one answer run whose TRAILING markdown element carries
 * {@link ANSWER_EID}, so growth is driven by the element-level typewriter
 * (cardElement.content) — that needs one stable, append-only text element, which
 * is incompatible with interleaving text and tool panels. Tools therefore render
 * above the answer (matching the terminal fold), not inline between text runs.
 * An uploaded image splits the run into `md / img / md…`; only the last segment
 * keeps the stream id, and a mid-turn upload is a structure change (whole-card
 * update) after which the new tail resumes streaming.
 *
 * Controls-at-bottom rationale: a reader's eye tracks the newest output, which
 * grows at the bottom, so the stop button sits right where they're looking. The
 * tradeoff (the reason it once lived on top — b3eea45) is that a long streamed
 * output pushes the row below the fold mid-turn, so you may have to scroll down
 * to reach ⏹. The {@link CONTROLS_EID} anchor (M-4 orphan self-heal deletes by
 * element_id) is position-independent, so moving the row doesn't affect it; the
 * controls are static across frames, so answer growth still routes to the
 * element typewriter.
 */
function renderRunning(state: RunState, rc: RunCardState): CardElement[] {
  const elements: CardElement[] = [];

  const reasoning = reasoningContent(state);
  if (reasoning) elements.push(reasoningPanel(reasoning, state.reasoningActive));

  const showTools = rc.showTools !== false;
  const tools: ToolEntry[] = [];
  for (const b of state.blocks) {
    if (b.kind === 'tool') {
      if (showTools) tools.push(b.tool);
    }
  }
  if (tools.length > 0) elements.push(...renderToolGroup(tools, false));

  // The answer: one markdown element per text run, with real `img` elements where
  // a reference has already been uploaded. The trailing text element carries
  // ANSWER_EID so its growth streams through the native typewriter; a ref whose
  // upload is still in flight shows a placeholder and an incomplete `![…](path`
  // is held back (never raw `![]()` — the client parses that as a broken image
  // node and the card looks frozen; issue #14). The ```feishu-card fences stay
  // visible here and are hoisted at terminal.
  const answer = runningAnswerText(state);
  if (answer) {
    elements.push(...renderRichText(answer, rc.images, { streamTailId: ANSWER_EID, live: true }));
  }

  // Footer: status (left) + 模型·effort footnote (right) share one row when the
  // 显示模型 pref is on; either alone falls back to a single line.
  const mEl = modelEl(rc);
  if (state.footer && mEl) elements.push(splitRow(footerStatus(state.footer), mEl));
  else if (state.footer) elements.push(footerStatus(state.footer));
  else if (mEl) elements.push(mEl);
  // Context-usage gauge sits just above the controls (only at/above the warn
  // tier) so it never pushes the answer down.
  const gauge = gaugeEl(state);
  if (gauge) elements.push(gauge);

  // ⏹ controls row pinned at the BOTTOM — it tracks the newest output where the
  // reader is looking (tradeoff: a long stream may push it below the fold; see
  // the layout note above). CONTROLS_EID anchor is position-independent.
  if (rc.cardKey && rc.goalControls) {
    if (rc.goalEnding) {
      // 结束目标 已触发：目标已解除，本轮输出完即停。仅留 ⏹ 终止（可再点掐断）。
      elements.push(noteMd('_🎯 目标已解除，本轮输出完成后停止_'));
      elements.push(actions([button('⏹ 终止', { a: RC.stop, m: rc.cardKey }, 'danger')], CONTROLS_EID));
    } else {
      // Goal: 终止 = clear goal + cut output now; 结束目标 = clear goal, let this
      // turn finish, then stop (no auto-continue). Both routed by the card's msgId.
      elements.push(
        actions(
          [
            button('⏹ 终止', { a: RC.stop, m: rc.cardKey }, 'danger'),
            button('🎯 结束目标', { a: RC.endGoal, m: rc.cardKey }, 'default'),
          ],
          CONTROLS_EID,
        ),
      );
    }
  } else if (rc.cardKey) {
    // Ordinary turns only: the one-shot reminder is deliberately absent from
    // goal cards (goal has its own terminal summary) and from every non-manual
    // global strategy. Once tapped, make the state explicit instead of leaving
    // a button that looks tappable twice.
    if (rc.completionReminder === 'requested') {
      elements.push(noteMd('_🔔 本轮结束后会提醒发起人_'));
    }
    const controls: CardElement[] = [];
    if (!rc.hideStop) controls.push(button('⏹ 终止', { a: RC.stop, m: rc.cardKey }, 'danger'));
    if (rc.completionReminder === 'available') {
      controls.push(button('🔔 完成后提醒我', { a: RC.remind, m: rc.cardKey }, 'default'));
    }
    if (controls.length > 0) elements.push(actions(controls, CONTROLS_EID));
  }

  return elements;
}

/**
 * Terminal layout: fold the process (reasoning + tools + every non-final text
 * block) into one collapsed panel and surface only the final answer below it.
 * The final answer is the last non-empty text block (codex emits preamble /
 * progress messages before the real reply). Interrupt / error / timeout still
 * land here — whatever process happened folds away and the status note shows;
 * a partial answer (if any text streamed) stays visible above the note.
 */
function renderTerminal(state: RunState, rc: RunCardState): CardElement[] {
  const elements: CardElement[] = [];

  const answerIdx = lastTextIndex(state.blocks);
  const answer = rc.localFiles?.text ?? (answerIdx >= 0 ? (state.blocks[answerIdx] as Extract<Block, { kind: 'text' }>).content.trim() : '');
  const answerElements = rc.localFiles ? renderFileAnswer(rc.localFiles, rc.images)
    : hasMarkdownTable(answer) ? renderReport(answer, { images: rc.images }) : renderRichText(answer, rc.images);

  // Everything except the final answer block is "process". (A block after the
  // answer can only be a trailing tool call — keep it folded with the rest.)
  const processBlocks = state.blocks.filter((_, i) => i !== answerIdx);
  const blocks = rc.showTools === false ? processBlocks.filter((b) => b.kind !== 'tool') : processBlocks;
  const reasoning = reasoningContent(state);
  const processBudget = rc.localFiles?.links.length
    ? Math.max(10, Math.min(PROCESS_COMPONENT_BUDGET, 170 - fileComponentCount(answerElements))) : PROCESS_COMPONENT_BUDGET;
  const processEls = buildProcessBody(reasoning, blocks, rc.images, processBudget);
  if (processEls.length > 0) {
    const toolCount = blocks.reduce((n, b) => (b.kind === 'tool' ? n + 1 : n), 0);
    elements.push(
      collapsiblePanelEl({
        title: processTitle(Boolean(reasoning), toolCount, state.terminal),
        expanded: false,
        border: 'grey',
        elements: processEls,
      }),
    );
  }

  // Terminal answer. A reply that TABLES its data goes through the report
  // renderer: card markdown has no tables, so `| a | b |` would otherwise show up
  // as raw pipes, and an image written inside a table can't be rendered there at
  // all (feishu's table nests nothing) — the report renderer hoists those to the
  // end as image pills. Everything else is the normal markdown path: uploaded
  // images become pills in place, and a ref that never resolved (path outside the
  // project, missing/oversized file, failed upload) renders as text — never raw
  // `![](…)`, which the client would resolve as a broken image node.
  if (answer) {
    elements.push(...answerElements);
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const s = state.idleTimeoutSeconds ?? 0;
    const idleLabel = s > 0 && s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒`;
    elements.push(noteMd(`_⏱ ${idleLabel}无响应，已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
    const advice = errorAdvice(state.errorMsg);
    if (advice) elements.push(noteMd(advice));
  } else if (state.terminal === 'done' && !answer) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  // Context-usage gauge as the closing footnote (only at/above the warn tier).
  const gauge = gaugeEl(state);
  if (gauge) elements.push(gauge);
  // 「模型 · 推理强度」footnote, bottom-right — only the always(始终) mode keeps it
  // on the terminal card; running(仅输出时) drops it once the turn ends.
  const mEl = rc.modelOnTerminal ? modelEl(rc) : null;
  if (mEl) elements.push(mEl);

  return elements;
}

/**
 * One next-step suggestion for a fatal error, by message pattern (登录 / 用量 /
 * 网络重试). Pure copy classification — NEVER fires a request (the codex 401
 * chain stays codex's own business); unmatched messages get no advice line.
 */
function errorAdvice(msg: string): string | null {
  if (/401|unauthor|not.?logged.?in|login|credential|token.*(expired|invalid)/i.test(msg)) {
    return '🔑 凭证可能已失效：请在部署机上运行 `codex login` 重新登录后重试';
  }
  if (/usage.?limit|quota|rate.?limit|429|too many requests/i.test(msg)) {
    return '📊 可能触达用量上限：发送 /usage 查看用量，稍后再试';
  }
  if (/network|timed?.?out|econn|epipe|enotfound|eai_again|socket|fetch failed|disconnect/i.test(msg)) {
    return '🌐 网络波动：重发本条消息即可重试';
  }
  return null;
}

/** Index of the last non-empty text block (the final answer), or -1 if none. */
function lastTextIndex(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'text' && b.content.trim()) return i;
  }
  return -1;
}

/**
 * The running card's answer text: every non-empty text block in order, joined —
 * exactly what {@link renderRunning} feeds to the answer elements. The image
 * uploader scans THIS string, so a ref starts uploading as soon as the model has
 * written it (see {@link ../card/outbound-images}.StreamingImages).
 */
export function runningAnswerText(state: RunState): string {
  const parts: string[] = [];
  for (const b of state.blocks) {
    if (b.kind === 'text' && b.content.trim()) parts.push(b.content);
  }
  return parts.join('\n\n');
}

/**
 * Body of the terminal "过程" panel. Renders reasoning + interleaved text/tool
 * groups (tools finalized). Guards the ~30KB per-element limit: if the rich body
 * (with tool-output bodies) exceeds {@link PROCESS_BODY_BUDGET}, rebuild it with
 * every tool group degraded to a header-only summary.
 */
function buildProcessBody(reasoning: string, blocks: Block[], images?: ReadonlyMap<string, string>, componentBudget = PROCESS_COMPONENT_BUDGET): CardElement[] {
  const rich = processElements(reasoning, blocks, false, images);
  if (estimateSize(rich) <= PROCESS_BODY_BUDGET && estimateComponents(rich) <= componentBudget) {
    return rich;
  }
  return processElements(reasoning, blocks, true, images);
}

function processElements(
  reasoning: string,
  blocks: Block[],
  compactTools: boolean,
  images?: ReadonlyMap<string, string>,
): CardElement[] {
  const out: CardElement[] = [];
  if (reasoning) out.push(reasoningPanel(reasoning, false));
  for (const group of groupBlocks(blocks)) {
    if (group.kind === 'text') {
      // Progress-message images stay visible in the folded 过程 panel (they were
      // streamed into the live card, so dropping them at terminal would make them
      // vanish on the user).
      if (group.content.trim()) out.push(...renderRichText(group.content, images));
    } else {
      out.push(...renderToolGroup(group.tools, true, compactTools));
    }
  }
  return out;
}

function processTitle(hasReasoning: boolean, toolCount: number, terminal: Terminal): string {
  // Status-led header (like a COT task tracker): a status glyph + what the fold
  // holds. On a non-normal ending the noun names it ("中断前的过程") — after an
  // interrupt the user opens it precisely to see what was mid-flight.
  const icon =
    terminal === 'interrupted' ? '⏹' : terminal === 'idle_timeout' ? '⏱' : terminal === 'error' ? '⚠️' : '✅';
  const noun =
    terminal === 'interrupted'
      ? '中断前的过程'
      : terminal === 'idle_timeout'
        ? '超时前的过程'
        : terminal === 'error'
          ? '出错前的过程'
          : '本轮过程';
  const parts: string[] = [];
  if (hasReasoning) parts.push('🧠 思考');
  if (toolCount > 0) parts.push(`🧰 ${toolCount} 个工具`);
  const detail = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
  return `${icon} **${noun}**${detail}（点击展开）`;
}

/** Rough serialized size of an element list, for the process-panel budget. */
function estimateSize(els: CardElement[]): number {
  let n = 0;
  for (const el of els) n += JSON.stringify(el).length;
  return n;
}

/**
 * Rough nested-component count, for the ~200-per-card cap. A collapsible_panel
 * wraps a header + a body element, so count it as ~3; a plain markdown line is 1.
 * Deliberately conservative — a small overcount just degrades to summaries a bit
 * sooner, which is the safe direction (a dropped card is the failure to avoid).
 */
function estimateComponents(els: CardElement[]): number {
  let n = 0;
  for (const el of els) n += (el as { tag?: string }).tag === 'collapsible_panel' ? 3 : 1;
  return n;
}

/** Button-less version — used to demote a previous turn's card. */
export function buildRunCardPlain(rc: RunCardState): CardObject {
  return buildRunCard({ ...rc, cardKey: undefined });
}

/** Render inputs for the queue placeholder card (M-3 排队可见可取消). */
export interface QueuedCardState {
  voiceMessages?: VoiceReply[];
  /** 1-based position in the global run queue (waiting layout only). */
  position?: number;
  /** routes the ⏹ 取消 button (the card's own messageId); unset → no button
   * (the first frame, before the messageId exists). */
  cardKey?: string;
  /** ⏹ tapped while waiting — terminal「已取消排队」layout. */
  cancelled?: boolean;
  /** follow-up messages queued behind the cancelled run (told, not swallowed). */
  dropped?: number;
  /** goal runs only: slot granted — the goal's own (lazily created) run cards
   * take over, this entity is repainted into a short started note. */
  started?: boolean;
  /** Same manual-only, per-turn reminder control as {@link RunCardState}. */
  completionReminder?: 'available' | 'requested';
}

/**
 * Queue placeholder card — posted BEFORE the global semaphore acquire when the
 * run pool is full, so a queued run is visible and cancellable. The ⏹ 取消
 * button reuses the run card's {@link RC.stop} action: while waiting,
 * `state.interrupt` resolves to「移除 waiter + 释放预订」(see acquireRunSlot).
 * Once the slot is granted the SAME CardKit entity is repainted in place into
 * the first run card (launchRun) or a started note (goal) — no
 * delete-and-recreate flicker.
 */
export function buildQueuedCard(qc: QueuedCardState): CardObject {
  if (qc.cancelled) {
    const els: CardElement[] = [...voiceReplyElements(qc.voiceMessages), noteMd('_⏹ 已取消排队_')];
    if (qc.dropped) els.push(noteMd(`_⚠️ ${qc.dropped} 条排队消息已丢弃，请重发。_`));
    return card(els, { summary: '已取消排队' });
  }
  if (qc.started) return card([noteMd('_🎯 排队结束，目标已开始执行_')], { summary: '已开始执行' });
  const els: CardElement[] = [
    ...voiceReplyElements(qc.voiceMessages),
    md(`⏳ 排队中（第 **${qc.position ?? 1}** 位）`),
    noteMd('全局并发池已满（所有群/话题共享），轮到后自动开始。'),
  ];
  if (qc.completionReminder === 'requested') els.push(noteMd('_🔔 本轮结束后会提醒发起人_'));
  if (qc.cardKey) {
    const controls: CardElement[] = [button('⏹ 取消', { a: RC.stop, m: qc.cardKey }, 'danger')];
    if (qc.completionReminder === 'available') {
      controls.push(button('🔔 完成后提醒我', { a: RC.remind, m: qc.cardKey }, 'default'));
    }
    els.push(actions(controls, CONTROLS_EID));
  }
  return card(els, { summary: '排队中' });
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

function renderToolGroup(tools: ToolEntry[], finalized: boolean, compact = false): CardElement[] {
  if (tools.length === 0) return [];
  // compact (process-panel over size/component budget): one summary panel that
  // still lists each tool's FULL command, just without output bodies.
  if (compact) return [collapsedToolSummary(tools, finalized)];
  // terminal: every tool gets its own collapsible panel, so each is independently
  // expandable to its full command + output. buildProcessBody falls back to
  // `compact` if this stack would blow the size/component budget.
  if (finalized) return tools.map((t) => toolPanel(t, false));
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  // running: collapse prior tools into a summary (full commands), keep the latest
  // one live and expanded so progress is watchable without exploding the card.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: CardElement[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): CardElement {
  return collapsiblePanel({
    title: active ? '🧠 **正在思考…**' : '🧠 **思考过程**（点击展开）',
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
 * N tool calls as one collapsed panel. Each line keeps the tool's FULL command
 * ({@link toolSummaryLine}) — NOT clipped to the one-line header — so a batched
 * shell command is actually readable (the「看不全脚本」fix). Output bodies are
 * dropped: this is the cheap/degraded form (1 component, no nested output
 * panels) used when a group is huge or over the per-card budget. If the joined
 * body would still approach the ~30KB per-element limit, the tail is dropped
 * with a visible count (never silently).
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): CardElement {
  const suffix = finalized ? '（已结束）' : '';
  const lines = tools.map(toolSummaryLine);
  let body = lines.join('\n');
  if (body.length > SUMMARY_BODY_MAX) {
    let kept = 0;
    let acc = 0;
    for (const line of lines) {
      if (acc + line.length + 1 > SUMMARY_BODY_MAX) break;
      acc += line.length + 1;
      kept++;
    }
    body = `${lines.slice(0, kept).join('\n')}\n- _…还有 ${tools.length - kept} 个命令未显示_`;
  }
  return collapsiblePanel({
    title: `🧰 **${tools.length} 个工具调用${suffix}**`,
    expanded: false,
    border: 'blue',
    body,
  });
}

function footerStatusText(status: Exclude<FooterStatus, null>): string {
  return status === 'thinking'
    ? '🧠 正在思考'
    : status === 'tool_running'
      ? '🧰 正在调用工具'
      : status === 'retrying'
        ? '⚠️ 瞬断，自动重试中…'
        : '✍️ 正在输出';
}

function footerStatus(status: Exclude<FooterStatus, null>): CardElement {
  return noteMd(footerStatusText(status));
}

/**
 * Effort → 中文档位 + 飞书颜色。只给 effort 词上色（模型名保持灰）：低=黄 / 中=绿 /
 * 高=浅紫(violet) / 极高及以上=深紫(purple)；none·minimal 不强调（灰）。命名色取自飞书
 * 色板，浅深紫的差异以真机为准（可在此调成色阶或换色名）。
 */
const EFFORT_TIER: Record<ReasoningEffort, { label: string; color: string }> = {
  none: { label: '无', color: 'grey' },
  minimal: { label: '极简', color: 'grey' },
  low: { label: '低', color: 'yellow' },
  medium: { label: '中', color: 'green' },
  high: { label: '高', color: 'violet' },
  xhigh: { label: '极高', color: 'purple' },
  max: { label: '最高', color: 'purple' },
  ultra: { label: '超强', color: 'purple' },
};

/**
 * `<model> · <colored effort>` for the footnote. The effort word is tinted via
 * lark_md inline `<font color='…'>`; the whole element also carries
 * text_color:'grey' so the model name is muted and, on any client that ignores
 * the inline tag, the effort degrades to grey instead of breaking.
 */
function modelEffortMd(model: string, effort?: ReasoningEffort): string {
  if (!effort) return model;
  const t = EFFORT_TIER[effort];
  if (!t) return `${model} · ${effort}`;
  return `${model} · <font color='${t.color}'>${t.label}</font>`;
}

/** Right-aligned, notation-sized「模型 · effort」footnote, or null when off. */
function modelEl(rc: RunCardState): CardElement | null {
  if (!rc.model) return null;
  return {
    tag: 'markdown',
    content: modelEffortMd(rc.model, rc.effort),
    text_size: 'notation',
    text_color: 'grey',
    text_align: 'right',
  };
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  if (state.footer === 'retrying') return '自动重试中';
  return '思考中';
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
