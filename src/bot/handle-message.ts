import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { createBackend } from '../agent';
import type { AgentRun, AgentThread } from '../agent/types';
import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getRunIdleTimeoutMs,
  isChatAllowed,
  isUserAllowed,
  type AppConfig,
} from '../config/schema';
import { RunRender } from '../card/run-render';
import { log, withTrace } from '../core/logger';
import { getProjectByChatId } from '../project/registry';
import { handleDmConsole } from './dm-console';
import { Semaphore, withIdleTimeout } from './watchdog';

interface ActiveState {
  thread: AgentThread;
  run?: AgentRun;
  queue: string[];
}

/**
 * Inbound router.
 *   p2p   → DM console (project management). Never runs codex.
 *   group → @bot → reply_in_thread topic → app-server turn → streaming card.
 *           cwd from project registry. Stability (design §6): per-turn idle
 *           watchdog, mid-turn steer/queue, concurrency cap.
 */
export function makeMessageHandler(
  channel: LarkChannel,
  cfg: AppConfig,
  fallbackCwd: string,
): (msg: NormalizedMessage) => Promise<void> {
  const backend = createBackend();
  const sessions = new Map<string, AgentThread>();
  const active = new Map<string, ActiveState>();
  const sema = new Semaphore(getMaxConcurrentRuns(cfg));
  const idleMs = getRunIdleTimeoutMs(cfg) ?? 0;
  const policy = getPendingPolicy(cfg);

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
    if (!isChatAllowed(cfg, msg.chatId) || !isUserAllowed(cfg, msg.senderId)) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      return;
    }

    const text = msg.content.trim();
    const key = msg.threadId ?? `pending:${msg.messageId}`;

    // Mid-turn message: steer (引导) or queue (排队) per policy.
    const existing = active.get(key);
    if (existing) {
      if (policy === 'steer' && existing.run) {
        const tid = existing.run.turnId();
        if (tid) {
          try {
            await existing.thread.steer({ text }, tid);
            log.info('intake', 'steer', { tid });
            return;
          } catch (err) {
            log.warn('intake', 'steer-failed', { err: String(err) });
          }
        }
      }
      existing.queue.push(text);
      log.info('intake', 'queued', { depth: existing.queue.length });
      return;
    }

    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const project = await getProjectByChatId(msg.chatId);
      const cwd = project?.cwd ?? fallbackCwd;
      log.info('intake', 'enter', {
        sender: msg.senderName ?? msg.senderId.slice(-6),
        project: project?.name ?? '(unregistered)',
        preview: text.slice(0, 40),
      });

      const release = await sema.acquire();
      const state: ActiveState = {
        thread: msg.threadId ? sessions.get(msg.threadId) ?? (await backend.startThread({ cwd })) : await backend.startThread({ cwd }),
        queue: [],
      };
      active.set(key, state);
      let activeKey = key;

      try {
        let turnText = text;
        let replyTo = msg.messageId;
        // loop drains the queue (queue policy / failed steers)
        for (;;) {
          const run = state.thread.runStreamed({ text: turnText });
          state.run = run;
          const render = new RunRender();
          let terminal: 'done' | 'error' | 'timeout' = 'done';

          const res = await channel.stream(
            msg.chatId,
            {
              markdown: async (ctrl) => {
                // migrate pending key → real topic thread_id once known
                if (activeKey.startsWith('pending:')) {
                  const tid = await getThreadId(channel, ctrl.messageId);
                  if (tid) {
                    active.delete(activeKey);
                    active.set(tid, state);
                    sessions.set(tid, state.thread);
                    activeKey = tid;
                  }
                }
                const guarded = withIdleTimeout(run.events, idleMs, () => {
                  terminal = 'timeout';
                  const tid = run.turnId();
                  if (tid) void state.thread.abort(tid).catch(() => undefined);
                });
                for await (const ev of guarded) {
                  if (ev.type === 'error') terminal = 'error';
                  render.apply(ev);
                  await ctrl.setContent(render.markdown());
                }
                if (terminal === 'timeout') {
                  render.apply({ type: 'error', message: '⏱ 似乎卡住了（无响应），已中止，可重试', willRetry: false });
                }
                await ctrl.setContent(render.markdown());
              },
            },
            { replyTo, replyInThread: true },
          );

          if (activeKey.startsWith('pending:')) {
            const tid = await getThreadId(channel, res.messageId);
            if (tid) {
              active.delete(activeKey);
              active.set(tid, state);
              sessions.set(tid, state.thread);
              activeKey = tid;
            }
          } else if (msg.threadId) {
            sessions.set(msg.threadId, state.thread);
          }
          replyTo = res.messageId;
          log.info('card', 'final', { terminal });

          if (state.queue.length === 0) break;
          turnText = state.queue.shift()!;
        }
      } catch (err) {
        log.fail('intake', err);
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId, replyInThread: true })
          .catch(() => undefined);
      } finally {
        active.delete(activeKey);
        release();
      }
    });
  };
}

/** Resolve a message's thread_id via raw API (reply response omits it). */
async function getThreadId(channel: LarkChannel, messageId: string): Promise<string | undefined> {
  try {
    const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
    const items = (res.data as { items?: { thread_id?: string }[] } | undefined)?.items;
    return items?.[0]?.thread_id;
  } catch {
    return undefined;
  }
}
