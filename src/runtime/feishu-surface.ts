import { createHash } from 'node:crypto';

export interface RuntimeFeishuMessageReactionPort {
  create(input: {
    path: { message_id: string };
    data: { reaction_type: { emoji_type: string } };
  }): Promise<{ code?: number; msg?: string; data?: { reaction_id?: string } }>;
  delete(input: {
    path: { message_id: string; reaction_id: string };
  }): Promise<{ code?: number; msg?: string }>;
}

export async function addRuntimeFeishuMessageReaction(
  port: Pick<RuntimeFeishuMessageReactionPort, 'create'>,
  input: { messageId: string; emojiType: string },
): Promise<string | undefined> {
  const response = await port.create({
    path: { message_id: input.messageId },
    data: { reaction_type: { emoji_type: input.emojiType } },
  });
  if (response.code !== undefined && response.code !== 0) throw new Error(response.msg || '飞书拒绝添加消息表情。');
  return response.data?.reaction_id;
}

export async function removeRuntimeFeishuMessageReaction(
  port: Pick<RuntimeFeishuMessageReactionPort, 'delete'>,
  input: { messageId: string; reactionId: string },
): Promise<void> {
  const response = await port.delete({
    path: { message_id: input.messageId, reaction_id: input.reactionId },
  });
  if (response.code !== undefined && response.code !== 0) throw new Error(response.msg || '飞书拒绝移除消息表情。');
}

export interface RuntimeFeishuMessagePort {
  create(input: {
    params: { receive_id_type: 'chat_id' };
    data: { receive_id: string; msg_type: 'text'; content: string; uuid: string };
  }): Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
  reply(input: {
    path: { message_id: string };
    data: { msg_type: 'text'; content: string; uuid: string; reply_in_thread?: boolean };
  }): Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>;
}

export interface RuntimeIdempotentFeishuTextInput {
  chatId: string;
  text: string;
  idempotencyKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
}

export function runtimeFeishuMessageUuid(idempotencyKey: string, prefix = 'runtime'): string {
  const normalized = idempotencyKey.trim();
  if (normalized.length <= 50) return normalized;
  const safePrefix = prefix.replace(/[^a-z0-9-]/gi, '').slice(0, 12) || 'runtime';
  const hashLength = Math.max(16, 49 - safePrefix.length);
  return `${safePrefix}-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, hashLength)}`;
}

export async function sendRuntimeIdempotentFeishuText(
  port: RuntimeFeishuMessagePort,
  input: RuntimeIdempotentFeishuTextInput,
  uuidPrefix = 'runtime',
): Promise<{ messageId: string }> {
  const chatId = input.chatId.trim();
  const text = input.text.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  const replyToMessageId = input.replyToMessageId?.trim();
  if (!chatId || !text || !idempotencyKey) throw new Error('飞书文本投影需要群、正文和幂等键。');
  const uuid = runtimeFeishuMessageUuid(idempotencyKey, uuidPrefix);
  const content = JSON.stringify({ text });
  const response = !replyToMessageId
    ? await port.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content, uuid },
      })
    : await port.reply({
        path: { message_id: replyToMessageId },
        data: {
          msg_type: 'text',
          content,
          uuid,
          ...(input.replyInThread === undefined ? {} : { reply_in_thread: input.replyInThread }),
        },
      });
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`飞书消息投影失败（${response.code}）：${response.msg ?? '未知错误'}`);
  }
  const messageId = response.data?.message_id?.trim();
  if (!messageId) throw new Error('飞书消息投影响应缺少 message_id。');
  return { messageId };
}

export interface RuntimeFeishuChatInfo {
  chatId: string;
  name?: string;
  avatarUrl?: string;
  description?: string;
  chatType: 'group' | 'p2p';
  memberCount?: number;
}

export interface RuntimeFeishuChatListPort {
  list(input: {
    params: {
      page_size: number;
      sort_type: 'ByActiveTimeDesc';
      user_id_type: 'open_id';
      page_token?: string;
    };
  }): Promise<{
    code?: number;
    msg?: string;
    data?: {
      items?: readonly {
        chat_id?: string;
        name?: string;
        avatar?: string;
        description?: string;
        chat_status?: string;
        chat_mode?: string;
      }[];
      has_more?: boolean;
      page_token?: string;
    };
  }>;
}

export async function listRuntimeJoinedFeishuGroups(
  port: RuntimeFeishuChatListPort,
): Promise<readonly RuntimeFeishuChatInfo[]> {
  const groups = new Map<string, RuntimeFeishuChatInfo>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    const response = await port.list({
      params: {
        page_size: 100,
        sort_type: 'ByActiveTimeDesc',
        user_id_type: 'open_id',
        ...(pageToken === undefined ? {} : { page_token: pageToken }),
      },
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书群目录查询失败（${response.code}）：${response.msg ?? '未知错误'}`);
    }
    for (const item of response.data?.items ?? []) {
      const chatId = item.chat_id?.trim();
      const name = item.name?.trim();
      if (!chatId || !name || item.chat_status !== 'normal' || !['group', 'topic'].includes(item.chat_mode ?? '') || groups.has(chatId)) continue;
      groups.set(chatId, {
        chatId,
        name,
        chatType: 'group',
        ...(item.avatar?.trim() ? { avatarUrl: item.avatar.trim() } : {}),
        ...(item.description?.trim() ? { description: item.description.trim() } : {}),
      });
    }
    const next = response.data?.has_more === true ? response.data.page_token?.trim() : undefined;
    if (!next || seenPageTokens.has(next)) break;
    seenPageTokens.add(next);
    pageToken = next;
  } while (true);
  return [...groups.values()];
}
