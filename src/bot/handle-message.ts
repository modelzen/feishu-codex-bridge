import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createBackend } from '../agent';
import type { AgentThread } from '../agent/types';
import { RunRender } from '../card/run-render';
import { log, withTrace } from '../core/logger';

/**
 * M1 minimal vertical slice:
 *   group @bot → reply_in_thread (creates a topic) → app-server turn →
 *   stream a markdown card. Follow-up @bot inside a thread reuses that
 *   thread's codex session.
 *
 * Out of scope for M1 (later milestones): config card, project registry
 * (cwd is fixed here), p2p console, watchdog, steer/queue, access control.
 */
export function makeMessageHandler(channel: LarkChannel, cwd: string): (msg: NormalizedMessage) => Promise<void> {
  const backend = createBackend();
  const sessions = new Map<string, AgentThread>();
  const busy = new Set<string>();

  return async (msg: NormalizedMessage): Promise<void> => {
    log.info('intake', 'recv', {
      chatType: msg.chatType,
      mentionedBot: msg.mentionedBot,
      mentionAll: msg.mentionAll,
      threadId: msg.threadId ?? null,
      preview: msg.content.slice(0, 40),
    });
    // p2p (DM) is the management console (create project / settings) — M2.
    // M1 only runs codex in project groups via @bot.
    if (msg.chatType === 'p2p') return;
    if (!msg.mentionedBot) return;

    const key = msg.threadId ?? `pending:${msg.messageId}`;
    if (busy.has(key)) {
      log.info('intake', 'skip-busy', { key });
      return;
    }
    busy.add(key);

    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const text = msg.content.trim();
      log.info('intake', 'enter', {
        chatType: msg.chatType,
        sender: msg.senderName ?? msg.senderId.slice(-6),
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

        // Persist the session under the (possibly new) topic's thread_id so a
        // follow-up @bot in that thread continues this codex session.
        const threadId = msg.threadId ?? (await getThreadId(channel, res.messageId));
        if (threadId) sessions.set(threadId, thread);
        log.info('card', 'final', { terminal });
      } catch (err) {
        log.fail('intake', err);
        await channel
          .send(msg.chatId, { markdown: `❌ 出错了：${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId, replyInThread: true })
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
