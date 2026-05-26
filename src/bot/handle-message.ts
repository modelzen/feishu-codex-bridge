import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createBackend } from '../agent';
import type { AgentThread } from '../agent/types';
import { isChatAllowed, isUserAllowed, type AppConfig } from '../config/schema';
import { RunRender } from '../card/run-render';
import { log, withTrace } from '../core/logger';
import { getProjectByChatId } from '../project/registry';
import { handleDmConsole } from './dm-console';

/**
 * Inbound message router.
 *   p2p   → DM management console (create project / manage). Never runs codex.
 *   group → @bot → reply_in_thread (topic) → app-server turn → streaming card.
 *           cwd comes from the project registry (group↔cwd); if the group
 *           isn't a registered project, falls back to `fallbackCwd`.
 */
export function makeMessageHandler(
  channel: LarkChannel,
  cfg: AppConfig,
  fallbackCwd: string,
): (msg: NormalizedMessage) => Promise<void> {
  const backend = createBackend();
  const sessions = new Map<string, AgentThread>();
  const busy = new Set<string>();

  return async (msg: NormalizedMessage): Promise<void> => {
    log.info('intake', 'recv', {
      chatType: msg.chatType,
      mentionedBot: msg.mentionedBot,
      threadId: msg.threadId ?? null,
      preview: msg.content.slice(0, 40),
    });

    if (msg.chatType === 'p2p') {
      await handleDmConsole(channel, cfg, msg);
      return;
    }
    if (!msg.mentionedBot) return;
    // group access control (design §5; empty lists = allow all)
    if (!isChatAllowed(cfg, msg.chatId) || !isUserAllowed(cfg, msg.senderId)) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      return;
    }

    const key = msg.threadId ?? `pending:${msg.messageId}`;
    if (busy.has(key)) {
      log.info('intake', 'skip-busy', { key });
      return;
    }
    busy.add(key);

    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const text = msg.content.trim();
      const project = await getProjectByChatId(msg.chatId);
      const cwd = project?.cwd ?? fallbackCwd;
      log.info('intake', 'enter', {
        chatType: msg.chatType,
        sender: msg.senderName ?? msg.senderId.slice(-6),
        project: project?.name ?? '(unregistered)',
        preview: text.slice(0, 40),
      });
      try {
        let thread = msg.threadId ? sessions.get(msg.threadId) : undefined;
        if (!thread) {
          thread = await backend.startThread({ cwd });
          log.info('agent', 'thread-start', { codexThreadId: thread.codexThreadId, cwd });
        }

        const run = thread.runStreamed({ text });
        const render = new RunRender();
        let terminal: 'done' | 'error' = 'done';

        const res = await channel.stream(
          msg.chatId,
          {
            markdown: async (ctrl) => {
              for await (const ev of run.events) {
                if (ev.type === 'error') terminal = 'error';
                render.apply(ev);
                await ctrl.setContent(render.markdown());
              }
              await ctrl.setContent(render.markdown());
            },
          },
          { replyTo: msg.messageId, replyInThread: true },
        );

        const threadId = msg.threadId ?? (await getThreadId(channel, res.messageId));
        if (threadId) sessions.set(threadId, thread);
        log.info('card', 'final', { terminal });
      } catch (err) {
        log.fail('intake', err);
        await channel
          .send(
            msg.chatId,
            { markdown: `❌ 出错了：${err instanceof Error ? err.message : String(err)}` },
            { replyTo: msg.messageId, replyInThread: true },
          )
          .catch(() => undefined);
      } finally {
        busy.delete(key);
      }
    });
  };
}

/** Resolve a message's thread_id via the raw API (the reply response omits it). */
async function getThreadId(channel: LarkChannel, messageId: string): Promise<string | undefined> {
  try {
    const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    const items = (res.data as { items?: { thread_id?: string }[] } | undefined)?.items;
    return items?.[0]?.thread_id;
  } catch {
    return undefined;
  }
}
