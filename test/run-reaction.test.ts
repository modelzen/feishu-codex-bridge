import { describe, expect, it, vi } from 'vitest';
import {
  classifyReaction,
  createRunReaction,
  type MessageReactionPort,
} from '../src/runtime/run-reaction';

function reactionPort(log: string[]): MessageReactionPort {
  let next = 0;
  return {
    async add({ messageId, emojiType }) {
      const id = `reaction-${++next}`;
      log.push(`add:${messageId}:${emojiType}:${id}`);
      return id;
    },
    async remove({ messageId, reactionId }) {
      log.push(`remove:${messageId}:${reactionId}`);
    },
  };
}

describe('shared run reaction lifecycle', () => {
  it('serializes OneSecond -> Typing -> cleared for a queued run', async () => {
    const log: string[] = [];
    const reaction = createRunReaction({
      messageId: 'om_trigger',
      queued: true,
      port: reactionPort(log),
    });

    reaction.started();
    await reaction.done();

    expect(log).toEqual([
      'add:om_trigger:OneSecond:reaction-1',
      'remove:om_trigger:reaction-1',
      'add:om_trigger:Typing:reaction-2',
      'remove:om_trigger:reaction-2',
    ]);
  });

  it('starts at Typing and makes terminal cleanup idempotent', async () => {
    const log: string[] = [];
    const reaction = createRunReaction({
      messageId: 'om_trigger',
      queued: false,
      port: reactionPort(log),
    });

    reaction.started();
    await Promise.all([reaction.done(), reaction.done()]);

    expect(log).toEqual([
      'add:om_trigger:Typing:reaction-1',
      'remove:om_trigger:reaction-1',
    ]);
  });

  it('reports transport failures without failing the Agent run', async () => {
    const onError = vi.fn();
    const reaction = createRunReaction({
      messageId: 'om_trigger',
      queued: false,
      port: {
        add: vi.fn(async () => { throw new Error('scope missing'); }),
        remove: vi.fn(async () => undefined),
      },
      onError,
    });

    await expect(reaction.done()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'scope missing' }),
      { phase: 'add', emojiType: 'Typing' },
    );
  });

  it('still clears when the error observer itself throws', async () => {
    const reaction = createRunReaction({
      messageId: 'om_trigger',
      queued: false,
      port: {
        add: vi.fn(async () => { throw new Error('scope missing'); }),
        remove: vi.fn(async () => undefined),
      },
      onError: () => { throw new Error('observer failed'); },
    });

    await expect(reaction.done()).resolves.toBeUndefined();
  });
});

describe('shared reaction intent', () => {
  it('accepts stop only while running and continue only after terminal', () => {
    expect(classifyReaction('OK', true)).toBe('stop');
    expect(classifyReaction('DONE', true)).toBe('stop');
    expect(classifyReaction('THUMBSUP', true)).toBeNull();
    expect(classifyReaction('THUMBSUP', false)).toBe('continue');
    expect(classifyReaction('DONE', false)).toBeNull();
  });
});
