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

// The node-sdk dedups card-action callbacks for 12h keyed on
// `card:${messageId}:${openId}:${tag|name|option|value}` (SafetyPipeline /
// cardActionId), to swallow Feishu's re-deliveries of one click. But a console
// that updates ONE message in place reuses its messageId across every view, so
// a *second* click of any button whose value is unchanged (a cycle toggle, or
// 返回/设置 revisited) hashes to the same key and gets dropped — the click does
// nothing. We defeat that by stamping a fresh per-render token into every
// callback value: each (re)render gives its buttons new values, so a re-click
// after the card re-renders is a new key (fires), while a true re-delivery of
// the *same* rendered click keeps the same token (still deduped). Picked a
// `__r` key with sigils so it can't collide with real payload fields, and it
// stays well within cardActionId's 128-char value window.
let renderToken = 0;
function stampRenderToken(card: object): void {
  const token = (++renderToken).toString(36);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const behaviors = obj.behaviors;
    if (Array.isArray(behaviors)) {
      for (const b of behaviors) {
        if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'callback') {
          const v = (b as { value?: unknown }).value;
          if (v && typeof v === 'object') (v as Record<string, unknown>).__r = token;
        }
      }
    }
    for (const k of Object.keys(obj)) visit(obj[k]);
  };
  visit(card);
}

export interface ManagedCardSendResult {
  messageId: string;
  cardId: string;
}

/**
 * Create a CardKit entity and send a message referencing it. With `replyTo`
 * the card threads under the triggering message (im.v1.message.reply);
 * otherwise it posts top-level into `chatId`. Pass `replyInThread` when the
 * triggering message lives in a topic and the card should stay in it.
 */
export async function sendManagedCard(
  channel: LarkChannel,
  chatId: string,
  card: object,
  replyTo?: string,
  replyInThread = false,
): Promise<ManagedCardSendResult> {
  stampRenderToken(card);
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
      data: { msg_type: 'interactive', content, reply_in_thread: replyInThread },
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
  if (!entry) {
    // The silent failure that made "返回菜单又没用了" invisible: no mapping (e.g.
    // the card was sent before a restart — byMessageId is per-process). Log it
    // so the diagnosis isn't a black box; caller may fall back to a fresh card.
    log.info('card', 'managed-update-no-entry', { messageId, known: byMessageId.size });
    return false;
  }
  stampRenderToken(card);
  const data = JSON.stringify(card);
  const push = async (): Promise<void> => {
    entry.sequence += 1;
    await channel.rawClient.cardkit.v1.card.update({
      path: { card_id: entry.cardId },
      data: { card: { type: 'card_json', data }, sequence: entry.sequence, uuid: `u_${entry.cardId}_${entry.sequence}` },
    });
  };
  try {
    await push();
    return true;
  } catch (err) {
    // err 200810: the card is still in a previous click's interaction window.
    // Wait out the 3s callback window and retry once with the next sequence.
    log.fail('card', err, { phase: 'managed-update', cardId: entry.cardId, seq: entry.sequence, retry: true });
    await new Promise((r) => setTimeout(r, 3200));
    try {
      await push();
      return true;
    } catch (err2) {
      log.fail('card', err2, { phase: 'managed-update-retry', cardId: entry.cardId, seq: entry.sequence });
      return false;
    }
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
