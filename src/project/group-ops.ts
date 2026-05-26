import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

export interface BotGroup {
  chatId: string;
  name: string;
  ownerId?: string;
  /** true when the bot itself owns the group (only owner can disband) */
  ownedByBot: boolean;
}

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

/** List the groups the bot is in, flagging which the bot owns. */
export async function listBotGroups(channel: LarkChannel): Promise<BotGroup[]> {
  const botOpenId = channel.botIdentity?.openId;
  const out: BotGroup[] = [];
  let pageToken: string | undefined;
  do {
    const res = await channel.rawClient.im.v1.chat.list({
      params: { user_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    const data = res.data as
      | { items?: { chat_id?: string; name?: string; owner_id?: string }[]; page_token?: string; has_more?: boolean }
      | undefined;
    for (const it of data?.items ?? []) {
      if (!it.chat_id) continue;
      out.push({
        chatId: it.chat_id,
        name: it.name ?? '(无名群)',
        ownerId: it.owner_id,
        ownedByBot: Boolean(botOpenId && it.owner_id === botOpenId),
      });
    }
    pageToken = data?.has_more ? data.page_token : undefined;
  } while (pageToken);
  return out;
}
