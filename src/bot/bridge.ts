import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AdminWriteOp } from '../admin/ops';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { createOrchestrator } from './handle-message';
import { paths } from '../config/paths';
import { createCliBridgeService, shouldStartCliBridge } from '../cli-bridge';

export interface BridgeOptions {
  cfg: AppConfig;
  appSecret: string;
  /** fallback cwd for groups that aren't registered projects. */
  fallbackCwd: string;
}

export interface BridgeHandle {
  channel: LarkChannel;
  /** 管理面写操作（Web 控制台 / supervisor IPC）：进程内执行，与 DM 卡片回调
   * 同一套共享逻辑（admin/ops.ts）；校验拒绝抛 AdminWriteError。 */
  adminExecute: (op: AdminWriteOp) => Promise<void>;
  /** Graceful teardown: close every codex session (no orphan app-servers) then
   *  drop the long connection. Idempotent enough for a signal handler. */
  shutdown: () => Promise<void>;
}

/**
 * Bring up the long-connection bot. Wires the `message` handler (group @bot →
 * 会话配置卡 → reply_in_thread topic → codex → streaming card) and the
 * `cardAction` dispatcher (config card model/effort/创建/恢复 buttons), which
 * share run state via the orchestrator. Long-connection is required for
 * `card.action.trigger` (lark-cli doesn't deliver it).
 */
export async function startBridge(opts: BridgeOptions): Promise<BridgeHandle> {
  const app = opts.cfg.accounts.app;
  const channel = createLarkChannel({
    appId: app.id,
    appSecret: opts.appSecret,
    domain: app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-codex-bridge',
    // surface raw events so card-action handlers can read form submissions
    // (action.form_value) — used by the new-project form.
    includeRawEvent: true,
    // Deliver ALL group messages (not just @bot) to `onMessage`. The SDK's
    // PolicyGate otherwise drops non-@ group messages with reason 'no_mention'
    // before they reach us, which would make 免@ impossible. We turn the SDK
    // filter off and let our per-project gate (shouldRespondWithoutMention in
    // handle-message) be the single source of truth for 免@. Non-@ delivery
    // still requires the im:message.group_msg scope (Feishu-side push).
    policy: { requireMention: false },
    // Disable the SDK's 600ms per-chat text batching. It merges messages by
    // chatId, so two topics in the same group posting within 600ms get their
    // content concatenated and senderId taken from the last message — breaking
    // "topic = independent session" and misattributing permissions. delayMs: 0
    // takes the SDK's pure-serial branch (dedup + chat queue stay on); double
    // sends are already prevented by startReservedRun's synchronous booking.
    safety: { batch: { text: { delayMs: 0 } } },
  });

  // Local CLI agent bridge (Claude Code / Codex hooks → owner DM). Always create
  // the runtime object so card actions are registered even when disabled at
  // boot; start the IPC listener only when config says it should be live.
  const cliBridge = createCliBridgeService({ cfg: opts.cfg, channel, socketPath: paths.cliBridgeSocket });
  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd, cliBridge);
  channel.on('message', orchestrator.onMessage);
  channel.on('cardAction', orchestrator.dispatcher.handle);
  // Cloud-doc comments: @bot in a doc comment (drive.notice.comment_add_v1) →
  // reply in the same comment thread.
  channel.on('comment', orchestrator.onComment);
  // A human added the bot to a group → DM the (admin) adder a bind card to
  // register it as a `joined` project.
  channel.on('botAdded', orchestrator.onBotAddedToChat);
  // Inbound reactions (im.message.reaction.created_v1, SDK-normalized + deduped):
  // 终态 run 卡 👍 = 续轮，运行中 run/排队卡 OK/DONE = ⏹ 终止（M-6）。Without the
  // im:message.reactions:read scope the event is simply never pushed — silent off.
  channel.on('reaction', orchestrator.onReaction);
  // The SDK exposes no named event for bot-*removed* (im.chat.member.bot.deleted_v1)
  // nor for bot-menu clicks (application.bot.menu_v6), so tap its private raw
  // EventDispatcher: register() merges by event key, so this adds our handlers
  // without clobbering the SDK's built-ins. Guarded + best-effort — if the SDK's
  // internals change on a bump we log and degrade (manual unbind via the console's
  // 删除项目 still works; the DM console still opens by messaging the bot).
  try {
    const tap = (
      channel as unknown as {
        dispatcher?: { register?: (h: Record<string, (raw: unknown) => void>) => unknown };
      }
    ).dispatcher;
    if (tap?.register) {
      tap.register({
        'im.chat.member.bot.deleted_v1': (raw: unknown) => {
          const ev = raw as { chat_id?: string; event?: { chat_id?: string } };
          const chatId = ev?.chat_id ?? ev?.event?.chat_id;
          if (chatId) void orchestrator.onBotRemovedFromChat(chatId);
        },
        // Bot-menu click → DM console menu card. The payload may carry fields at
        // the top level or under `event` depending on schema version — read both.
        'application.bot.menu_v6': (raw: unknown) => {
          const ev = raw as {
            event_id?: string;
            event_key?: string;
            operator?: { operator_id?: { open_id?: string } };
            event?: { event_key?: string; operator?: { operator_id?: { open_id?: string } } };
          };
          void orchestrator.onBotMenu({
            openId: ev?.operator?.operator_id?.open_id ?? ev?.event?.operator?.operator_id?.open_id,
            eventKey: ev?.event_key ?? ev?.event?.event_key,
            eventId: ev?.event_id,
          });
        },
      });
      log.info('ws', 'raw-event-tap', { events: ['im.chat.member.bot.deleted_v1', 'application.bot.menu_v6'] });
    } else {
      log.info('ws', 'raw-event-tap-unavailable');
    }
  } catch (err) {
    log.fail('ws', err, { phase: 'raw-event-tap' });
  }
  channel.on('reject', (evt) => log.info('intake', 'reject', { reason: evt.reason, msgId: evt.messageId }));
  channel.on('error', (err) => log.fail('ws', err));
  channel.on('reconnecting', () => log.info('ws', 'reconnecting'));
  channel.on('reconnected', () => log.info('ws', 'reconnected'));

  await channel.connect();
  // Never let an optional local-agent IPC bind failure (EADDRINUSE/EACCES) tear
  // down an already-connected bot — log and stay up, mirroring shutdown's catch.
  if (shouldStartCliBridge(opts.cfg)) {
    await cliBridge.start().catch((err) => log.fail('cli-bridge', err, { phase: 'start' }));
  }
  log.info('ws', 'connected', { appId: app.id, fallbackCwd: opts.fallbackCwd });

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await orchestrator.shutdown();
    await cliBridge.shutdown().catch((err) => log.fail('cli-bridge', err, { phase: 'shutdown' }));
    await channel.disconnect().catch((err) => log.fail('ws', err, { phase: 'disconnect' }));
  };
  return { channel, adminExecute: orchestrator.adminExecute, shutdown };
}
