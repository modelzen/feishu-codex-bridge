/** Port implemented by a Feishu transport that can mutate message reactions. */
export interface MessageReactionPort {
  add(input: {
    messageId: string;
    emojiType: string;
  }): Promise<string | undefined>;
  remove(input: {
    messageId: string;
    reactionId: string;
  }): Promise<void>;
}

export interface RunReactionErrorContext {
  phase: 'add' | 'remove';
  emojiType?: string;
}

export interface RunReactionOptions {
  messageId: string;
  queued: boolean;
  port: MessageReactionPort;
  onError?: (
    error: unknown,
    context: RunReactionErrorContext,
  ) => void | Promise<void>;
}

/**
 * Serialized acknowledgement lifecycle for one accepted task.
 *
 * - queued: OneSecond
 * - running: Typing
 * - every terminal path: remove the current reaction
 *
 * The transport is best-effort, while ordering is strict: a late add can never
 * survive a later terminal transition.
 */
export interface RunReaction {
  started(): void;
  done(): Promise<void>;
}

export function createRunReaction(options: RunReactionOptions): RunReaction {
  let phase: 0 | 1 | 2 = options.queued ? 0 : 1;
  let chain: Promise<string | undefined> = safeAdd(
    options,
    options.queued ? 'OneSecond' : 'Typing',
  );

  const swap = (emojiType: string): void => {
    chain = chain.then(async (previousId) => {
      if (previousId !== undefined) await safeRemove(options, previousId);
      return await safeAdd(options, emojiType);
    });
  };

  return {
    started() {
      if (phase !== 0) return;
      phase = 1;
      swap('Typing');
    },
    done() {
      if (phase !== 2) {
        phase = 2;
        chain = chain.then(async (previousId) => {
          if (previousId !== undefined) await safeRemove(options, previousId);
          return undefined;
        });
      }
      return chain.then(() => undefined);
    },
  };
}

/** Running cards accept stop-like emoji; terminal cards accept thumbs-up. */
export const STOP_EMOJIS: ReadonlySet<string> = new Set(['OK', 'DONE']);
export const CONTINUE_EMOJIS: ReadonlySet<string> = new Set(['THUMBSUP']);
export type ReactionIntent = 'stop' | 'continue';

export function classifyReaction(
  emojiType: string,
  running: boolean,
): ReactionIntent | null {
  if (running) return STOP_EMOJIS.has(emojiType) ? 'stop' : null;
  return CONTINUE_EMOJIS.has(emojiType) ? 'continue' : null;
}

async function safeAdd(
  options: RunReactionOptions,
  emojiType: string,
): Promise<string | undefined> {
  try {
    return await options.port.add({
      messageId: options.messageId,
      emojiType,
    });
  } catch (error) {
    safeReport(options, error, { phase: 'add', emojiType });
    return undefined;
  }
}

async function safeRemove(
  options: RunReactionOptions,
  reactionId: string,
): Promise<void> {
  try {
    await options.port.remove({
      messageId: options.messageId,
      reactionId,
    });
  } catch (error) {
    safeReport(options, error, { phase: 'remove' });
  }
}

function safeReport(
  options: RunReactionOptions,
  error: unknown,
  context: RunReactionErrorContext,
): void {
  try {
    const reported = options.onError?.(error, context);
    if (reported !== undefined) void Promise.resolve(reported).catch(() => undefined);
  } catch {
    // Observation is best-effort too; it cannot break reaction cleanup.
  }
}
