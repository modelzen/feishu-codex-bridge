import { describe, expect, it } from 'vitest';
import { card, mdStream } from '../src/card/cards';
import { createRuntimeTaskCardDelivery } from '../src/runtime/task-card-delivery';

function fakeChannel() {
  const createdMessages: any[] = [];
  const elementPushes: any[] = [];
  const cardUpdates: any[] = [];
  return {
    createdMessages,
    elementPushes,
    cardUpdates,
    rawClient: {
      cardkit: { v1: {
        card: {
          create: async () => ({ data: { card_id: 'card-1' } }),
          update: async (input: any) => { cardUpdates.push(input); return {}; },
          settings: async () => ({}),
        },
        cardElement: {
          content: async (input: any) => { elementPushes.push(input); return {}; },
        },
      } },
      im: { v1: { message: {
        create: async (input: any) => {
          createdMessages.push(input);
          return { data: { message_id: 'message-1' } };
        },
        reply: async () => ({ data: { message_id: 'message-1' } }),
      } } },
    },
  } as any;
}

describe('public Runtime task-card delivery', () => {
  it('owns CardKit creation, coalesced answer streaming, and terminal finalization', async () => {
    const channel = fakeChannel();
    const initial = card([mdStream('hello', 'answer')], { streaming: true });
    const delivery = await createRuntimeTaskCardDelivery({
      channel,
      chatId: 'chat-1',
      initialCard: initial,
      idempotencyKey: 'task-card:1',
    });

    expect(delivery.messageId).toBe('message-1');
    expect(channel.createdMessages[0].data.uuid).toBe('task-card:1');

    delivery.push(card([mdStream('hello world', 'answer')], { streaming: true }), 'answer');
    await delivery.drain();
    expect(channel.elementPushes.at(-1)?.data.content).toBe('hello world');

    await expect(delivery.finalize(card([{ tag: 'markdown', content: 'done' }]))).resolves.toBe(true);
    expect(channel.cardUpdates.at(-1)?.data.card.data).toContain('done');
  });
});
