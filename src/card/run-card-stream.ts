import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import type { CardObject, CardElement } from './cards';
import { isCardIdNotReady } from './managed';
import type { StreamingImages } from './outbound-images';

/**
 * Min gap between throttled stream pushes. Finer = smoother chunked growth
 * (each push shows the full text so far). Live cards run with
 * streaming_mode=true (see {@link ../card/cards}), which per Feishu's docs
 * exempts ALL card/element APIs from the per-card QPS cap while streaming —
 * this floor just keeps us friendly to the app-level 1000/min·50/s budget
 * (push RTT of hundreds of ms dominates the cadence anyway).
 */
const STREAM_THROTTLE_MS = 150;

/** streaming_mode auto-disabled (Feishu turns it off 10 minutes after it was
 * last enabled) — {@link RunCardStream.streamElement} re-enables and resends. */
const ERR_STREAMING_OFF = 300309;
/** sequence out-of-order — retried once with a fresh (higher) sequence. */
const ERR_SEQ_OUT_OF_ORDER = 300317;

/**
 * Same-chat pacing for ALL pushes (M-4 / audit-02 F7). streaming_mode exempts a
 * card from the per-card QPS cap, but Feishu still enforces a same-chat ~5 QPS
 * budget across the bot's messages/updates; two topics streaming concurrently
 * in one chat at the per-card cadence (~6.6/s each) sustain ~13 QPS → rolling
 * 429s. One pacer per chat, shared by every RunCardStream in that chat, spaces
 * pushes ≥{@link CHAT_MIN_GAP_MS} apart (250ms = 4 QPS, headroom for the chat's
 * non-stream messages); a 429 additionally holds the whole chat's next slot
 * back by {@link RATE_LIMIT_PENALTY_MS}. Waits happen inside the pump coroutine
 * / terminal retry only — event consumption (streamCoalesced) never blocks.
 */
const CHAT_MIN_GAP_MS = 250;
const RATE_LIMIT_PENALTY_MS = 1_000;
/** Terminal-frame retry budget when rate-limited (backoff 1s/2s/4s). */
const TERMINAL_RL_RETRIES = 3;
const RL_BACKOFF_BASE_MS = 1_000;

class ChatPacer {
  private nextAt = 0;
  /** Reserve the chat's next push slot and wait until it opens. */
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + CHAT_MIN_GAP_MS;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  /** Feishu said 429 — hold the whole chat's next slot back. */
  penalize(): void {
    this.nextAt = Math.max(this.nextAt, Date.now() + RATE_LIMIT_PENALTY_MS);
  }
  idle(now: number): boolean {
    return this.nextAt < now - 60_000;
  }
}

/** Pacers shared per chat across instances (tiny; idle ones pruned on overflow). */
const chatPacers = new Map<string, ChatPacer>();
function pacerFor(chatId: string): ChatPacer {
  let p = chatPacers.get(chatId);
  if (!p) {
    if (chatPacers.size >= 512) {
      const now = Date.now();
      for (const [k, v] of chatPacers) if (v.idle(now)) chatPacers.delete(k);
    }
    p = new ChatPacer();
    chatPacers.set(chatId, p);
  }
  return p;
}

/** Feishu rate limit — HTTP 429 (axios status) or business code 99991400. */
function isRateLimited(err: unknown): boolean {
  const e = err as { code?: number; response?: { status?: number; data?: { code?: number } } };
  return e?.response?.status === 429 || e?.response?.data?.code === 99991400 || e?.code === 99991400;
}

/**
 * A run card backed by a single CardKit 2.0 entity. The whole card is
 * re-rendered from {@link RunState} each tick; the pump routes each frame
 * either to the element-level typewriter (answer-only growth, via
 * cardkit.v1.cardElement.content — the ONLY API streaming_config's typewriter
 * applies to; needs the card's streaming_mode on) or to a whole-card
 * cardkit.v1.card.update (structure changed — full replace, no typewriter).
 * Throttled to STREAM_THROTTLE_MS so growth tracks the model in chunks with
 * zero trailing, and collapsible panels (reasoning / tools) re-render cleanly.
 * All updates share one strictly-increasing `seq` — Feishu rejects
 * out-of-order updates.
 *
 * Unlike im.v1.message.patch (unconditional, reverts a card touched during a
 * click's callback window), this is the correct surface for a card that both
 * streams and carries clickable controls (⏹).
 */
export class RunCardStream {
  /** Optional per-turn background image uploader (see {@link setImageWorker}).
   * Deliberately not part of the push path: event consumption asks it to scan,
   * never waits on it. */
  private imageWorker: { uploads: StreamingImages; text: () => string } | null = null;
  private cardId = '';
  private _messageId = '';
  private seq = 0;
  private lastPush = 0;
  private lastContent = '';
  // Per-turn push counters — surfaced via stats() for the stream.timing log.
  private pushCount = 0;
  private cardPushes = 0; // whole-card card.update (structure)
  private elPushes = 0; // element cardElement.content (answer typewriter)
  private totalRttMs = 0;
  private maxRttMs = 0;
  // Coalesced streaming. The consume loop records the latest {card, answerEid} in
  // `pending`; a single pump() drains it — NON-BLOCKING, so consuming codex events
  // never stalls on a round-trip (awaiting each push serially drained the backlog
  // at one event per ~RTT → "已回完、飞书还在慢慢打字"). The pump pushes only the most
  // recent snapshot per round-trip: when only the answer text grew it streams that
  // via cardElement.content (typewriter), otherwise it whole-card updates.
  private pending: { card: CardObject; answerEid: string | null } | null = null;
  private pumpChannel: LarkChannel | null = null;
  private pumpPromise: Promise<void> | null = null;
  // Baselines for the pump's route decision (structure unchanged + answer grew?).
  private lastStructureSig = '';
  private lastAnswerText = '';
  // Per-chat pacer shared with the chat's other streams (set in create()).
  private pacer: ChatPacer | null = null;
  // Forced whole-card writes (button/settings repaint, queue → run flip,
  // terminal frame) must never race one another. In particular, an async
  // completion-reminder repaint that started just before turn completion must
  // land BEFORE the terminal frame, not finish late and put the card back into
  // its running layout. This tail is deliberately separate from the coalesced
  // pump: event consumption remains non-blocking, and the caller drains that
  // pump before finalizing.
  private forcedUpdateTail: Promise<void> = Promise.resolve();
  /** Once terminal finalization starts, reminder/settings repaint is stale. */
  private liveUpdatesFrozen = false;

  get messageId(): string {
    return this._messageId;
  }

  /** Push counts (whole-card vs element) + round-trip stats for this card. */
  stats(): { pushCount: number; cardPushes: number; elPushes: number; totalRttMs: number; maxRttMs: number } {
    return {
      pushCount: this.pushCount,
      cardPushes: this.cardPushes,
      elPushes: this.elPushes,
      totalRttMs: this.totalRttMs,
      maxRttMs: this.maxRttMs,
    };
  }

  /**
   * Attach the turn's background image uploader. `text` returns the answer as it
   * stands (see {@link ../card/run-card}.runningAnswerText) — it's scanned for
   * new `![](…)` refs on every frame, and a resolved `image_key` repaints the
   * live card, which is how an image appears mid-turn instead of only at the end.
   */
  setImageWorker(uploads: StreamingImages, text: () => string): void {
    this.imageWorker = { uploads, text };
  }

  /**
   * Resolve this turn's images for the terminal frame. Bounded by
   * {@link StreamingImages.finalize}'s own deadline, because the terminal frame
   * is sequenced behind it — an upload that never settles must not leave the card
   * on 「正在输出」forever.
   *
   * Returns an empty map when no uploader was attached ({@link setImageWorker}).
   * Production always attaches one right after creating the stream (see
   * {@link ./run-card}.attachRunImages), so that only covers a stream driven
   * directly (a test, or a caller that only ever renders text).
   */
  async settleImages(finalAnswer: string): Promise<ReadonlyMap<string, string>> {
    if (!this.imageWorker) return new Map();
    return this.imageWorker.uploads.finalize(finalAnswer);
  }

  /**
   * Record the latest card and ensure the pump is running. Returns immediately;
   * calls that arrive while a push is in flight collapse into a single push of
   * the most recent card once that round-trip completes. Use this from the
   * event-consume loop instead of awaiting {@link streamCard} per event.
   */
  streamCoalesced(channel: LarkChannel, fullCard: CardObject, answerEid: string | null): void {
    // Kick the image uploader off the same snapshot the frame was built from, so
    // a ref starts uploading the moment the model finishes writing it.
    this.imageWorker?.uploads.refresh(this.imageWorker.text());
    this.pending = { card: fullCard, answerEid };
    this.pumpChannel = channel;
    if (!this.pumpPromise) this.pumpPromise = this.pump();
  }

  /** Await any in-flight coalesced push so the final streaming frame lands (and
   * `seq` stays ordered) before the terminal update. Call after the loop ends. */
  async drain(): Promise<void> {
    if (this.pumpPromise) await this.pumpPromise;
  }

  private async pump(): Promise<void> {
    try {
      while (this.pending && this.pumpChannel) {
        const { card, answerEid } = this.pending;
        this.pending = null;
        const t0 = Date.now();
        const answer = answerEid ? answerContent(card, answerEid) : null;
        const sig = structureSig(card, answerEid);
        // Baselines only advance on a DELIVERED frame: a failed push (429 etc.)
        // leaves them stale, so the next frame re-routes as a structure change
        // and re-sends the full card — dropped frames self-heal (M-4).
        if (
          answerEid &&
          answer !== null &&
          sig === this.lastStructureSig &&
          answer !== this.lastAnswerText &&
          answer.startsWith(this.lastAnswerText)
        ) {
          // Structure unchanged, answer grew by append → native typewriter.
          if (await this.streamElement(this.pumpChannel, answerEid, answer)) {
            this.lastAnswerText = answer;
          }
        } else {
          // First frame or structure changed → whole-card update re-establishes the
          // (answer-blanked) baseline; the answer element streams via
          // cardElement.content from here, carrying current text so nothing is lost.
          if (await this.streamCard(this.pumpChannel, card, true)) {
            this.lastStructureSig = sig;
            this.lastAnswerText = answer ?? '';
          }
        }
        // RTT (~hundreds of ms) usually spaces pushes on its own; this floor only
        // bites if a round-trip is unusually fast, keeping us under Feishu's
        // single-card ~10 ops/sec cap.
        const gap = STREAM_THROTTLE_MS - (Date.now() - t0);
        if (this.pending && gap > 0) await new Promise((r) => setTimeout(r, gap));
      }
    } finally {
      this.pumpPromise = null;
    }
  }

  /** Element-level streaming push (cardkit.v1.cardElement.content): the answer
   * element's accumulated full text. Feishu diffs the prefix and types the delta
   * per the card's streaming_config. Needs streaming_mode on the card — which
   * Feishu auto-disables 10 minutes after it was last enabled, so a long turn
   * would silently freeze this channel; on 300309 we re-enable it (settings
   * PATCH) and resend the frame. Recovery runs inside the pump coroutine, so
   * event consumption never blocks on it. Returns true ⇔ the frame landed (the
   * pump only advances its baselines on delivered frames). */
  private async streamElement(channel: LarkChannel, elementId: string, content: string): Promise<boolean> {
    if (!this.cardId) return false;
    const push = async (): Promise<void> => {
      assertCardkitSuccess(
        await channel.rawClient.cardkit.v1.cardElement.content({
          path: { card_id: this.cardId, element_id: elementId },
          data: { content, sequence: ++this.seq, uuid: `e_${this.cardId}_${this.seq}` },
        }),
      );
    };
    await this.pacer?.wait();
    const t0 = Date.now();
    try {
      try {
        await push();
      } catch (err) {
        const code = cardkitErrCode(err);
        if (code === ERR_STREAMING_OFF) {
          log.fail('card', err, { phase: 'run-stream-el', cardId: this.cardId, seq: this.seq, reopenStreaming: true });
          assertCardkitSuccess(
            await channel.rawClient.cardkit.v1.card.settings({
              path: { card_id: this.cardId },
              data: {
                settings: JSON.stringify({ config: { streaming_mode: true } }),
                sequence: ++this.seq,
                uuid: `o_${this.cardId}_${this.seq}`,
              },
            }),
          );
          await push();
        } else if (code === ERR_SEQ_OUT_OF_ORDER) {
          log.fail('card', err, { phase: 'run-stream-el', cardId: this.cardId, seq: this.seq, retry: true });
          await push();
        } else {
          throw err;
        }
      }
      const rtt = Date.now() - t0;
      this.pushCount++;
      this.elPushes++;
      this.totalRttMs += rtt;
      if (rtt > this.maxRttMs) this.maxRttMs = rtt;
      return true;
    } catch (err) {
      const rl = isRateLimited(err);
      if (rl) this.pacer?.penalize();
      log.fail('card', err, { phase: 'run-stream-el', cardId: this.cardId, seq: this.seq, rateLimited: rl });
      return false;
    }
  }

  /** Create the entity from the initial (running) card and send a message
   * referencing it by card_id. Returns the carrier message id.
   *
   * A just-created CardKit entity occasionally hasn't propagated when the message
   * referencing it is sent — Feishu 400s with 230099 / ErrCode 11310 "cardid is
   * invalid" and the run card silently fails to appear (this surfaced as
   * intermittent intake.fail). Same transient, same fix as
   * {@link ../card/managed#sendManagedCard}: retry the whole create+send with a
   * short backoff. Only this transient retries — Feishu rejected the message
   * outright (nothing sent), and a re-created entity that's never referenced is a
   * harmless orphan, so no duplicate card. */
  async create(
    channel: LarkChannel,
    chatId: string,
    initialCard: CardObject,
    opts: { replyTo?: string; replyInThread?: boolean },
  ): Promise<string> {
    this.pacer = pacerFor(chatId); // shared with the chat's other streams
    const attempt = async (): Promise<string> => {
      const created = await channel.rawClient.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(initialCard) },
      });
      const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
      if (!cardId) {
        throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
      }
      this.cardId = cardId;
      this.lastContent = JSON.stringify(initialCard);

      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let messageId: string | undefined;
      if (opts.replyTo) {
        const r = await channel.rawClient.im.v1.message.reply({
          path: { message_id: opts.replyTo },
          data: { msg_type: 'interactive', content, reply_in_thread: opts.replyInThread ?? false },
        });
        messageId = (r as { data?: { message_id?: string } }).data?.message_id;
      } else {
        const r = await channel.rawClient.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
        messageId = (r as { data?: { message_id?: string } }).data?.message_id;
      }
      if (!messageId) throw new Error('run card send returned no message_id');
      this._messageId = messageId;
      return messageId;
    };

    for (let i = 0; ; i++) {
      try {
        return await attempt();
      } catch (err) {
        if (i >= 2 || !isCardIdNotReady(err)) throw err;
        log.fail('card', err, { phase: 'run-stream-create', attempt: i, retry: true });
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
  }

  /** Throttled whole-card stream update. Skips identical/too-soon pushes;
   * `force` flushes regardless (still de-duped on content). Returns true ⇔ the
   * card now shows this frame (delivered, or identical to what's on it) — a
   * failed push leaves `lastContent` untouched so the same frame isn't deduped
   * away when it comes around again. */
  async streamCard(channel: LarkChannel, fullCard: CardObject, force = false): Promise<boolean> {
    if (!this.cardId) return false;
    const data = JSON.stringify(fullCard);
    if (data === this.lastContent) return true;
    const now = Date.now();
    if (!force && now - this.lastPush < STREAM_THROTTLE_MS) return false;
    this.lastPush = now;
    await this.pacer?.wait();
    const t0 = Date.now();
    try {
      assertCardkitSuccess(
        await channel.rawClient.cardkit.v1.card.update({
          path: { card_id: this.cardId },
          data: { card: { type: 'card_json', data }, sequence: ++this.seq, uuid: `s_${this.cardId}_${this.seq}` },
        }),
      );
      this.lastContent = data;
      const rtt = Date.now() - t0;
      this.pushCount++;
      this.cardPushes++;
      this.totalRttMs += rtt;
      if (rtt > this.maxRttMs) this.maxRttMs = rtt;
      return true;
    } catch (err) {
      const rl = isRateLimited(err);
      if (rl) this.pacer?.penalize();
      log.fail('card', err, { phase: 'run-stream', cardId: this.cardId, seq: this.seq, rateLimited: rl });
      return false;
    }
  }

  /** Forced whole-card replace for structural updates. Calls are serialized in
   * invocation order so concurrent callback repaints cannot complete out of
   * order. A terminal card built with streaming off clears the typewriter
   * cursor.
   *
   * The terminal frame MUST land — losing it leaves the card "streaming"
   * forever (cursor + dead ⏹) while the run is over and `runsByCard` already
   * cleared (audit-02 F7). So failures retry: rate limits (429 / 99991400)
   * with exponential backoff (1s/2s/4s, {@link TERMINAL_RL_RETRIES} retries);
   * anything else — typically 200810 "card in ongoing interaction" when the
   * update fires inside a ⏹ click's 3s window — waits out the window and
   * retries once. Returns whether the requested frame is observably on the
   * entity, so terminal callers can emit a truthful fallback notification. */
  updateCard(channel: LarkChannel, fullCard: CardObject): Promise<boolean> {
    return this.enqueueForcedUpdate(channel, fullCard);
  }

  getCardId(): string { return this.cardId; }

  /** File rows share the whole-card queue and sequence, including demotion. */
  private readonly elementOverrides = new Map<string, CardElement>();

  updateElement(channel: LarkChannel, elementId: string, element: CardElement): Promise<boolean> {
    this.elementOverrides.set(elementId, element);
    const data = JSON.stringify(element);
    const task = this.forcedUpdateTail.then(async () => {
      if (!this.cardId) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.pacer?.wait();
        try {
          assertCardkitSuccess(await channel.rawClient.cardkit.v1.cardElement.update({
            path: { card_id: this.cardId, element_id: elementId },
            data: { element: data, sequence: ++this.seq, uuid: `f_${this.cardId}_${this.seq}` },
          }));
          return true;
        } catch (err) {
          log.fail('card', err, { phase: 'file-row-update', retry: attempt === 0 });
          if (attempt === 0) await new Promise((r) => setTimeout(r, 3200));
        }
      }
      return false;
    });
    this.forcedUpdateTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /**
   * Repaint a still-live card (currently used by the completion-reminder
   * control). Once {@link finalizeCard} has synchronously frozen live repaints,
   * late callbacks become a no-op. Repaints accepted before the freeze share
   * the forced-update tail and therefore finish before the terminal frame.
   */
  updateLiveCard(channel: LarkChannel, fullCard: CardObject): Promise<boolean> {
    if (this.liveUpdatesFrozen) return Promise.resolve(false);
    return this.enqueueForcedUpdate(channel, fullCard);
  }

  /**
   * Freeze live repaints synchronously, then enqueue the terminal whole-card
   * frame after every already-accepted forced update. Future intentional
   * non-live updates (for example demoting an old terminal card's settings
   * control) may still use {@link updateCard}.
   */
  finalizeCard(channel: LarkChannel, fullCard: CardObject): Promise<boolean> {
    this.liveUpdatesFrozen = true;
    return this.enqueueForcedUpdate(channel, fullCard);
  }

  private enqueueForcedUpdate(channel: LarkChannel, fullCard: CardObject): Promise<boolean> {
    if (!this.cardId) return Promise.resolve(false);
    // Capture the exact frame at invocation time; callers often mutate their
    // RunCardState again while this queued network write is waiting its turn.
    const data = JSON.stringify(fullCard);
    const task = this.forcedUpdateTail.then(() => {
      // Overlay at dispatch time: an already-queued demotion must not restore
      // a stale "get" button after delivery completed.
      const frame = JSON.parse(data) as CardBody;
      const overlay = (el: CardElement): CardElement => {
        const updated = this.elementOverrides.get(String(el.element_id));
        if (updated) return updated;
        if (Array.isArray(el.elements)) el.elements = (el.elements as CardElement[]).map(overlay);
        if (Array.isArray(el.columns)) el.columns = (el.columns as CardElement[]).map(overlay);
        return el;
      };
      if (frame.body?.elements) frame.body.elements = frame.body.elements.map(overlay);
      return this.pushForcedUpdate(channel, JSON.stringify(frame));
    });
    // A surprising transport failure must not poison the serialization tail and
    // prevent the terminal frame. pushForcedUpdate normally absorbs failures,
    // but keep the tail resilient to any future exception too.
    this.forcedUpdateTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async pushForcedUpdate(channel: LarkChannel, data: string): Promise<boolean> {
    if (!this.cardId) return false;
    const push = async (): Promise<void> => {
      assertCardkitSuccess(
        await channel.rawClient.cardkit.v1.card.update({
          path: { card_id: this.cardId },
          data: { card: { type: 'card_json', data }, sequence: ++this.seq, uuid: `u_${this.cardId}_${this.seq}` },
        }),
      );
      this.lastContent = data;
    };
    for (let i = 0; ; i++) {
      await this.pacer?.wait();
      try {
        await push();
        return true;
      } catch (err) {
        const rl = isRateLimited(err);
        if (rl) this.pacer?.penalize();
        if (i >= (rl ? TERMINAL_RL_RETRIES : 1)) {
          log.fail('card', err, { phase: 'run-update-retry', cardId: this.cardId, seq: this.seq });
          return false;
        }
        log.fail('card', err, { phase: 'run-update', cardId: this.cardId, seq: this.seq, retry: true, rateLimited: rl });
        await new Promise((r) => setTimeout(r, rl ? RL_BACKOFF_BASE_MS * 2 ** i : 3200));
      }
    }
  }
}

type CardBody = { body?: { elements?: Array<Record<string, unknown>> } };

/** Cardkit business error code off a thrown SDK error — HTTP 4xx carries it in
 * response.data.code (axios shape, same as {@link isCardIdNotReady}); some
 * transports surface it at the top level. */
function cardkitErrCode(err: unknown): number | undefined {
  const e = err as { code?: number; response?: { data?: { code?: number } } };
  return e?.response?.data?.code ?? e?.code;
}

/** Content of the streamed answer element (element_id === eid), or null if the
 * card has no such element yet (top-level in body.elements). */
function answerContent(card: CardObject, eid: string): string | null {
  const els = (card as CardBody).body?.elements;
  if (!Array.isArray(els)) return null;
  for (const el of els) {
    if (el && el.element_id === eid) return typeof el.content === 'string' ? el.content : '';
  }
  return null;
}

/** Serialized card with the answer element's content blanked. A change here is a
 * structural change (reasoning / tools / footer) needing a whole-card update;
 * when it's unchanged and only the answer grew, the pump routes to the element
 * typewriter instead. */
function structureSig(card: CardObject, eid: string | null): string {
  const body = (card as CardBody).body;
  const els = body?.elements;
  if (!eid || !Array.isArray(els)) return JSON.stringify(card);
  const blanked = els.map((el) => (el && el.element_id === eid ? { ...el, content: '' } : el));
  return JSON.stringify({ ...(card as object), body: { ...body, elements: blanked } });
}

/**
 * The SDK resolves HTTP 200 business failures (`{code: 230099, msg: …}`) instead
 * of rejecting, so without this check a rejected card write counts as delivered:
 * `lastContent` advances and the frame is never retried. That silently drops the
 * TERMINAL frame in particular — the run is over but the card keeps its running
 * layout with a live ⏹ cursor (issue #14 "一显示就卡"). Throwing here routes the
 * failure into the existing retry/self-heal paths.
 */
function assertCardkitSuccess(response: unknown): void {
  const result = response as { code?: number; msg?: string } | null;
  if (typeof result?.code === 'number' && result.code !== 0) {
    throw Object.assign(new Error(result.msg ?? `cardkit error ${result.code}`), { code: result.code });
  }
}
