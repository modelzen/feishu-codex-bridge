import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { log, withTrace } from '../core/logger';

/** Context handed to every card-action handler. */
export interface CardActionContext {
  channel: LarkChannel;
  cfg: AppConfig;
  evt: CardActionEvent;
  /** action id (= evt.action.value.a) */
  actionId: string;
  /** chosen option value for static selects (evt.action.option) */
  option?: string;
  /** the element's value payload (buttons carry their payload here) */
  value: Record<string, unknown>;
  /** form inputs (by `name`) when a submit button fired — needs includeRawEvent */
  formValue?: Record<string, unknown>;
}

export type CardActionHandler = (ctx: CardActionContext) => Promise<void> | void;

/**
 * Routes `card.action.trigger` callbacks to handlers keyed by action id. The
 * action id lives in the element's `value.a` (see card builders in ./cards).
 * Long-connection delivers these events; lark-cli does not — so this only runs
 * under the node-sdk WSClient transport.
 */
export class CardDispatcher {
  private readonly handlers = new Map<string, CardActionHandler>();

  constructor(
    private readonly channel: LarkChannel,
    private readonly cfg: AppConfig,
  ) {}

  /** Register a handler for an action id. Last registration wins. */
  on(actionId: string, handler: CardActionHandler): this {
    this.handlers.set(actionId, handler);
    return this;
  }

  /** Bound handler suitable for `channel.on('cardAction', ...)`. */
  readonly handle = async (evt: CardActionEvent): Promise<void> => {
    const value = (evt.action?.value ?? {}) as Record<string, unknown>;
    const actionId = typeof value.a === 'string' ? value.a : undefined;
    if (!actionId) {
      log.info('card', 'action-unkeyed', { tag: evt.action?.tag });
      return;
    }
    const handler = this.handlers.get(actionId);
    if (!handler) {
      log.info('card', 'action-nohandler', { actionId });
      return;
    }
    const formValue = (evt as CardActionEvent & { raw?: { action?: { form_value?: Record<string, unknown> } } })
      .raw?.action?.form_value;
    await withTrace({ chatId: evt.chatId, msgId: evt.messageId }, async () => {
      log.info('card', 'action', { actionId, by: evt.operator?.openId?.slice(-6) });
      try {
        await handler({
          channel: this.channel,
          cfg: this.cfg,
          evt,
          actionId,
          option: evt.action?.option,
          value,
          formValue,
        });
      } catch (err) {
        log.fail('card', err, { actionId });
      }
    });
  };
}
