import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Button-driven cards must be **CardKit 2.0 entities**, not raw interactive
 * JSON. `im.v1.message.patch` (what `channel.updateCard` does) silently no-ops
 * on a card sent as plain JSON via `channel.send({ card })` — the click just
 * flashes and reverts. So any card a user clicks to mutate in place goes
 * through here: create an entity → send a message that references it by
 * `card_id` → update the entity via `cardkit.v1.card.update` (monotonic
 * `sequence` so the server can't reorder/drop updates).
 */

interface ManagedEntry {
  cardId: string;
  sequence: number;
}

// Per-process; lost on restart, which is fine — a stale card just stops being
// updatable and the user re-triggers the flow to mint a fresh one.
const byMessageId = new Map<string, ManagedEntry>();

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit entity and send a message referencing it. With `replyTo`
 * the card threads under the triggering message (im.v1.message.reply);
 * otherwise it posts top-level into `chatId`.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  chatId: string,
  card: object,
  replyTo?: string,
): Promise<ManagedCardSendResult> {
  const created = await channel.rawClient.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  const cardId = (created as { data?: { card_id?: string } }).data?.card_id;
  if (!cardId) {
    throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(created).slice(0, 200)}`);
  }

  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  let messageId: string | undefined;
  if (replyTo) {
    const sent = await channel.rawClient.im.v1.message.reply({
      path: { message_id: replyTo },
      data: { msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  } else {
    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content },
    });
    messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
  }
  if (!messageId) {
    throw new Error('send card-by-reference returned no message_id');
  }

  byMessageId.set(messageId, { cardId, sequence: 0 });
  return { messageId, cardId };
}

/**
 * Replace the whole card of a managed entity, keyed by the messageId that
 * carries it. Returns false (and logs) if we have no mapping — caller can fall
 * back to a fresh card. Sequence auto-increments per card.
 */
export async function updateManagedCard(
  channel: LarkChannel,
  messageId: string,
  card: object,
): Promise<boolean> {
  const entry = byMessageId.get(messageId);
  if (!entry) return false;
  entry.sequence += 1;
  try {
    await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: entry.cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        sequence: entry.sequence,
      },
    });
    return true;
  } catch (err) {
    log.fail('card', err, { phase: 'managed-update', cardId: entry.cardId, seq: entry.sequence });
    return false;
  }
}

/** True iff we hold the card_id mapping for this messageId. */
export function isManaged(messageId: string): boolean {
  return byMessageId.has(messageId);
}

/** Drop the mapping (card recalled / flow ended). */
export function forgetManagedCard(messageId: string): void {
  byMessageId.delete(messageId);
}
