import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

/**
 * Transfer group ownership to `toOpenId`. Because the bridge creates project
 * groups (`chat.create`), the bot is the owner and members cannot disband the
 * group themselves — transferring ownership lets the admin disband it in
 * Feishu. Uses `im.v1.chat.update` (same `im:chat` scope as create); the bot
 * must currently be the owner for this to succeed.
 */
export async function transferOwnership(channel: LarkChannel, chatId: string, toOpenId: string): Promise<void> {
  await channel.rawClient.im.v1.chat.update({
    path: { chat_id: chatId },
    params: { user_id_type: 'open_id' },
    data: { owner_id: toOpenId },
  });
  log.info('project', 'owner-transfer', { chatId: chatId.slice(-6), to: toOpenId.slice(-6) });
}
