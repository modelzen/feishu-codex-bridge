import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { buildCompletionReminderContent } from '../card/completion-reminder';
import {
  shouldSendCompletionReminder,
  type AppConfig,
  type CompletionReminderOutcome,
} from '../config/schema';
import { log } from '../core/logger';

export interface CompletionReminderReplyInput {
  cardMsgId: string;
  requesterOpenId?: string;
  outcome: CompletionReminderOutcome;
  requestedAt: number;
  manuallyRequested: boolean;
  summary?: string;
  cardUpdated: boolean;
  replyInThread: boolean;
}

export interface CompletionReminderReplyDeps {
  channel: LarkChannel;
  cfg: AppConfig;
  /** `seen` records on first call and returns true for a duplicate. */
  dedupe: { seen(id: string): boolean };
  now?: () => number;
}

export type CompletionReminderReplyResult = 'sent' | 'skipped' | 'failed';

/**
 * Apply the four-mode policy and emit the native Feishu reply. Delivery is
 * deliberately best-effort: this runs after the task/card terminal has been
 * settled, catches transport failures, and never rewrites the task outcome.
 */
export async function sendCompletionReminderReply(
  deps: CompletionReminderReplyDeps,
  input: CompletionReminderReplyInput,
): Promise<CompletionReminderReplyResult> {
  // Explicit product boundary: user-stop / queue-cancel never generate an @
  // reply. Only ordinary success, agent error and watchdog timeout do.
  if (
    !input.requesterOpenId ||
    (input.outcome !== 'done' && input.outcome !== 'error' && input.outcome !== 'idle_timeout')
  ) {
    return 'skipped';
  }

  const elapsedMs = Math.max(0, (deps.now?.() ?? Date.now()) - input.requestedAt);
  // A failed terminal CardKit update needs an observable fallback regardless
  // of strategy; otherwise the user is left staring at a forever-running card.
  const policyMatch = shouldSendCompletionReminder(deps.cfg, {
    outcome: input.outcome,
    elapsedMs,
    manuallyRequested: input.manuallyRequested,
  });
  if (input.cardUpdated && !policyMatch) return 'skipped';
  if (deps.dedupe.seen(input.cardMsgId)) return 'skipped';

  const content = buildCompletionReminderContent({
    requesterOpenId: input.requesterOpenId,
    outcome: input.outcome,
    elapsedMs,
    summary: input.summary,
    cardUpdated: input.cardUpdated,
  });
  try {
    await deps.channel.rawClient.im.v1.message.reply({
      path: { message_id: input.cardMsgId },
      data: { msg_type: 'post', content, reply_in_thread: input.replyInThread },
    });
    log.info('card', 'completion-reminder', {
      terminal: input.outcome,
      elapsedMs,
      cardUpdated: input.cardUpdated,
    });
    return 'sent';
  } catch (err) {
    log.fail('card', err, { phase: 'completion-reminder', terminal: input.outcome });
    return 'failed';
  }
}
