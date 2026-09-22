import type { VoiceReply } from '../voice/types';
import { voiceReplyElements } from './voice-reply';
import {
  actions,
  button,
  card,
  md,
  noteMd,
  splitRow,
  type CardElement,
  type CardObject,
} from './cards';
import type { ReasoningEffort } from '../agent/types';
import type { Block, FooterStatus, RunState } from './run-state';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { renderRichText } from './markdown-render';
import { fileComponentCount, renderFileAnswer, type InlineFiles } from './inline-files';
import { hasMarkdownTable, renderReport } from './report-render';
import { StreamingImages } from './outbound-images';
import type { RunCardStream } from './run-card-stream';
import { processPanel } from './process-panel';
import { buildProcessBody, currentAnswerIndex, processTitle, runElapsedMs } from './run-process';
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

const PROCESS_COMPONENT_BUDGET = 120;

/** Routing + render inputs for one run card. */
export interface RunCardState {
  rs: RunState;
  /** This display segment ended because an accepted steer opened a new card. */
  continued?: boolean;
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
 * Render the ordered process and current answer using the restrained native
 * presentation adapted from vonvon-dsh. The process is expanded while running
 * and collapsed at terminal; tool details remain independently expandable.
 * The current answer keeps the native typewriter and existing rich media path.
 */
export function buildRunCard(rc: RunCardState): CardObject {
  const state = rc.rs;
  const running = state.terminal === 'running';
  const elements = running ? renderRunning(state, rc) : renderTerminal(state, rc);
  const result = card([...voiceReplyElements(rc.voiceMessages), ...elements].map(runTypography), { streaming: running, summary: rc.continued ? '已接收补充，继续处理' : summaryText(state) });
  result.body = { ...(result.body as Record<string, unknown>), vertical_spacing: '16px' };
  return result;
}

/** Apply native normal (14px) body text only within run cards; metadata keeps
 * its explicit notation size, and other card families keep their own styles. */
function runTypography(element: CardElement): CardElement {
  return {
    ...element,
    ...(element.tag === 'markdown' && !element.text_size ? { text_size: 'normal' } : {}),
    ...(Array.isArray(element.elements) ? { elements: element.elements.map(runTypography) } : {}),
  };
}

/** The ordered process stays above the current answer. Only the trailing text
 * item streams through ANSWER_EID; earlier progress text remains in the process.
 * Controls stay at the bottom and preserve their stable routing element id. */
function renderRunning(state: RunState, rc: RunCardState): CardElement[] {
  const elements: CardElement[] = [];

  const answerIdx = currentAnswerIndex(state.blocks);
  const processBlocks = state.blocks.filter((b, i) => i !== answerIdx && (rc.showTools !== false || b.kind !== 'tool'));
  const process = buildProcessBody(processBlocks, rc.images);
  const title = processTitle(state.terminal, runElapsedMs(state));
  if (process.length) elements.push(processPanel(title, process, true));
  else if (state.startedAt !== undefined) elements.push(md(`<font color='grey'>${title}</font>`));
  const answer = answerIdx >= 0 ? (state.blocks[answerIdx] as Extract<Block, { kind: 'text' }>).content : '';
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
  const processBudget = rc.localFiles?.links.length
    ? Math.max(10, Math.min(PROCESS_COMPONENT_BUDGET, 170 - fileComponentCount(answerElements))) : PROCESS_COMPONENT_BUDGET;
  const processEls = buildProcessBody(blocks, rc.images, processBudget);
  const title = processTitle(state.terminal, runElapsedMs(state));
  if (processEls.length) elements.push(processPanel(title, processEls, false));
  else if (state.startedAt !== undefined) elements.push(md(`<font color='grey'>${title}</font>`));

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

  if (rc.continued) {
    elements.push(noteMd('已接收补充，后续输出见下一张卡片'));
  } else if (state.terminal === 'interrupted') {
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

function footerStatusText(status: Exclude<FooterStatus, null>): string {
  return status === 'thinking'
    ? '正在处理'
    : status === 'tool_running'
      ? '正在调用工具'
      : status === 'retrying'
        ? '⚠️ 瞬断，自动重试中…'
        : '正在输出';
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
