import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { fetchInteractiveCardText, isDegradedCardContent } from '../bot/card-content';

/**
 * Recover the real body of a received CardKit message while leaving every
 * ordinary message untouched. Hosts call this before projecting a normalized
 * SDK message into their own domain type.
 */
export async function resolveRuntimeInboundMessageText(
  channel: LarkChannel,
  message: Pick<NormalizedMessage, 'messageId' | 'content' | 'rawContentType'>,
): Promise<string> {
  if (message.rawContentType !== 'interactive' || !isDegradedCardContent(message.content)) {
    return message.content;
  }
  return await fetchInteractiveCardText(channel, message.messageId) ?? message.content;
}
