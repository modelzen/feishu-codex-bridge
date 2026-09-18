import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { CardObject } from '../card/cards';
import { RunCardStream } from '../card/run-card-stream';

/** Stable delivery handle for one CardKit-backed Runtime task card. */
export interface RuntimeTaskCardDelivery {
  readonly messageId: string;
  /** Non-blocking latest-wins update used for activity/answer streaming. */
  push(card: CardObject, answerElementId?: string | null): void;
  /** Wait until every accepted coalesced update has settled. */
  drain(): Promise<void>;
  /** Forced live repaint for controls or other non-stream lifecycle changes. */
  update(card: CardObject): Promise<boolean>;
  /** Freeze live updates and guarantee the terminal frame is attempted last. */
  finalize(card: CardObject): Promise<boolean>;
  stats(): {
    pushCount: number;
    cardPushes: number;
    elPushes: number;
    totalRttMs: number;
    maxRttMs: number;
  };
}

export interface CreateRuntimeTaskCardDeliveryInput {
  /** Opaque SDK channel shape; kept structural so hosts may pin newer SDK releases. */
  channel: { readonly rawClient: object };
  chatId: string;
  initialCard: CardObject;
  replyTo?: string;
  replyInThread?: boolean;
  /** Feishu carrier-message UUID for host-level retry deduplication. */
  idempotencyKey?: string;
}

/**
 * Create the shared CardKit entity/carrier pair and return a deep delivery
 * module. Hosts never manage card ids, sequence numbers, rate limits, retries,
 * coalescing, streaming-mode recovery, or terminal ordering themselves.
 */
export async function createRuntimeTaskCardDelivery(
  input: CreateRuntimeTaskCardDeliveryInput,
): Promise<RuntimeTaskCardDelivery> {
  const channel = input.channel as unknown as LarkChannel;
  const stream = new RunCardStream();
  const messageId = await stream.create(channel, input.chatId, input.initialCard, {
    replyTo: input.replyTo,
    replyInThread: input.replyInThread,
    uuid: input.idempotencyKey,
  });
  // Establish the structure/answer baseline used to route later pure answer
  // growth to cardElement.content. This frame is content-identical to create()
  // and is therefore deduped without another network push.
  stream.streamCoalesced(channel, input.initialCard, 'answer');
  await stream.drain();
  return {
    messageId,
    push(card, answerElementId = 'answer') {
      stream.streamCoalesced(channel, card, answerElementId);
    },
    drain: async () => await stream.drain(),
    update: async (card) => await stream.updateLiveCard(channel, card),
    finalize: async (card) => await stream.finalizeCard(channel, card),
    stats: () => stream.stats(),
  };
}
