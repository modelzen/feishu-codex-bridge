import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import type { CardObject } from './cards';

/** element_id of the streaming body markdown element on a run card. */
export const RUN_BODY_ELEMENT_ID = 'run_body';

/** Min gap between native typewriter pushes (cardElement.content rate cap 50/s). */
const STREAM_THROTTLE_MS = 120;

/**
 * A run card backed by a single CardKit 2.0 entity. The body markdown element
 * ({@link RUN_BODY_ELEMENT_ID}) streams with Feishu's native typewriter via
 * cardkit.v1.cardElement.content; structural changes (header/buttons/terminal/
 * settings panel) go through whole-card updates (cardkit.v1.card.update). All
 * operations share one strictly-increasing `seq` per card — Feishu rejects
 * out-of-order updates.
 *
 * Unlike im.v1.message.patch (which only does unconditional, no-interaction
 * updates and silently reverts a card touched during a click's callback
 * window), this is the correct surface for a card that both streams output and
 * carries clickable controls.
 */
export class RunCardStream {
  private cardId = '';
  private _messageId = '';
  private seq = 0;
  private lastPush = 0;
  private lastContent = '';
  private streaming = false;

  get messageId(): string {
    return this._messageId;
  }

  /** Create the entity from the initial (running) card and send a message
   * referencing it by card_id. Returns the carrier message id. */
  async create(
    channel: LarkChannel,
    chatId: string,
    initialCard: CardObject,
    opts: { replyTo?: string; replyInThread?: boolean },
  ): Promise<string> {
    const created = await channel.rawClient.cardkit.v1.card.create({
      data: { type: 'card_json', data: JSON.stringify(initialCard) },
    });
    const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
    if (!cardId) {
      throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
    }
    this.cardId = cardId;
    this.streaming = true; // initial run card is built with streaming_mode: true

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
  }

  /** Push body text with the typewriter. Throttled; `force` flushes regardless. */
  async streamBody(channel: LarkChannel, content: string, force = false): Promise<void> {
    if (!this.cardId || !this.streaming) return;
    if (content === this.lastContent) return;
    const now = Date.now();
    if (!force && now - this.lastPush < STREAM_THROTTLE_MS) return;
    this.lastPush = now;
    this.lastContent = content;
    try {
      await channel.rawClient.cardkit.v1.cardElement.content({
        path: { card_id: this.cardId, element_id: RUN_BODY_ELEMENT_ID },
        data: { content: content || '…', sequence: ++this.seq, uuid: `e_${this.cardId}_${this.seq}` },
      });
    } catch (err) {
      log.fail('card', err, { phase: 'run-stream', cardId: this.cardId, seq: this.seq });
    }
  }

  /** Whole-card replace for structural changes (buttons, header, settings,
   * terminal). A terminal card built with streaming off also clears the
   * typewriter cursor, so no separate finish() call is needed. */
  async updateCard(channel: LarkChannel, fullCard: CardObject): Promise<void> {
    if (!this.cardId) return;
    this.streaming = Boolean((fullCard.config as { streaming_mode?: boolean })?.streaming_mode);
    const data = JSON.stringify(fullCard);
    const push = async (): Promise<void> => {
      await channel.rawClient.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: { card: { type: 'card_json', data }, sequence: ++this.seq, uuid: `u_${this.cardId}_${this.seq}` },
      });
    };
    try {
      await push();
    } catch (err) {
      // A terminal update fired right as a ⏹/⚙️ click is still in its callback
      // window hits err 200810 ("card in ongoing interaction"). Wait out the
      // 3s window and retry once.
      log.fail('card', err, { phase: 'run-update', cardId: this.cardId, seq: this.seq, retry: true });
      await new Promise((r) => setTimeout(r, 3200));
      try {
        await push();
      } catch (err2) {
        log.fail('card', err2, { phase: 'run-update-retry', cardId: this.cardId, seq: this.seq });
      }
    }
  }
}
