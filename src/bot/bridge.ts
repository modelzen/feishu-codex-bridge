import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { createOrchestrator } from './handle-message';

export interface BridgeOptions {
  cfg: AppConfig;
  appSecret: string;
  /** fallback cwd for groups that aren't registered projects. */
  fallbackCwd: string;
}

/**
 * Bring up the long-connection bot. Wires the `message` handler (group @bot →
 * 会话配置卡 → reply_in_thread topic → codex → streaming card) and the
 * `cardAction` dispatcher (config card model/effort/创建/恢复 buttons), which
 * share run state via the orchestrator. Long-connection is required for
 * `card.action.trigger` (lark-cli doesn't deliver it).
 */
export async function startBridge(opts: BridgeOptions): Promise<LarkChannel> {
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
  });

  const orchestrator = createOrchestrator(channel, opts.cfg, opts.fallbackCwd);
  channel.on('message', orchestrator.onMessage);
  channel.on('cardAction', orchestrator.dispatcher.handle);
  channel.on('reject', (evt) => log.info('intake', 'reject', { reason: evt.reason, msgId: evt.messageId }));
  channel.on('error', (err) => log.fail('ws', err));
  channel.on('reconnecting', () => log.info('ws', 'reconnecting'));
  channel.on('reconnected', () => log.info('ws', 'reconnected'));

  await channel.connect();
  log.info('ws', 'connected', { appId: app.id, fallbackCwd: opts.fallbackCwd });
  return channel;
}
