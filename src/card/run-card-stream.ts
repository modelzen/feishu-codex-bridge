import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import type { CardObject } from './cards';

/** Min gap between throttled whole-card stream updates (card.update rate cap). */
const STREAM_THROTTLE_MS = 250;

/**
 * A run card backed by a single CardKit 2.0 entity. The whole card is
 * re-rendered from {@link RunState} each tick and pushed via
 * cardkit.v1.card.update; while running the card carries streaming_mode so
 * Feishu animates the markdown delta between pushes (native typewriter feel)
 * and collapsible panels (reasoning / tools) re-render cleanly. All updates
 * share one strictly-increasing `seq` — Feishu rejects out-of-order updates.
 *
 * Unlike im.v1.message.patch (unconditional, reverts a card touched during a
 * click's callback window), this is the correct surface for a card that both
 * streams and carries clickable controls (⏹).
 */
export class RunCardStream {
  private cardId = '';
  private _messageId = '';
  private seq = 0;
  private lastPush = 0;
  private lastContent = '';

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
  }

  /** Throttled whole-card stream update. Skips identical/too-soon pushes;
   * `force` flushes regardless (still de-duped on content). */
  async streamCard(channel: LarkChannel, fullCard: CardObject, force = false): Promise<void> {
    if (!this.cardId) return;
    const data = JSON.stringify(fullCard);
    if (data === this.lastContent) return;
    const now = Date.now();
    if (!force && now - this.lastPush < STREAM_THROTTLE_MS) return;
    this.lastPush = now;
    this.lastContent = data;
    try {
      await channel.rawClient.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: { card: { type: 'card_json', data }, sequence: ++this.seq, uuid: `s_${this.cardId}_${this.seq}` },
      });
    } catch (err) {
      log.fail('card', err, { phase: 'run-stream', cardId: this.cardId, seq: this.seq });
    }
  }

  /** Forced whole-card replace for structural/terminal updates. A terminal
   * card built with streaming off clears the typewriter cursor. */
  async updateCard(channel: LarkChannel, fullCard: CardObject): Promise<void> {
    if (!this.cardId) return;
    const data = JSON.stringify(fullCard);
    this.lastContent = data;
    const push = async (): Promise<void> => {
      await channel.rawClient.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: { card: { type: 'card_json', data }, sequence: ++this.seq, uuid: `u_${this.cardId}_${this.seq}` },
      });
    };
    try {
      await push();
    } catch (err) {
      // A terminal update fired right as a ⏹ click is still in its callback
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
