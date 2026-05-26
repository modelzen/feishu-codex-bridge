import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { makeMessageHandler } from './handle-message';

export interface BridgeOptions {
  cfg: AppConfig;
  appSecret: string;
  /** fallback cwd for groups that aren't registered projects. */
  fallbackCwd: string;
}

/**
 * Bring up the long-connection bot. M1 wires the `message` handler
 * (group @bot → thread → codex → streaming card). cardAction / bot.menu
 * handlers come with later milestones.
 */
export async function startBridge(opts: BridgeOptions): Promise<LarkChannel> {
  const app = opts.cfg.accounts.app;
  const channel = createLarkChannel({
    appId: app.id,
    appSecret: opts.appSecret,
    domain: app.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-codex-bridge',
  });

  channel.on('message', makeMessageHandler(channel, opts.cfg, opts.fallbackCwd));
  channel.on('reject', (evt) => log.info('intake', 'reject', { reason: evt.reason, msgId: evt.messageId }));
  channel.on('error', (err) => log.fail('ws', err));
  channel.on('reconnecting', () => log.info('ws', 'reconnecting'));
  channel.on('reconnected', () => log.info('ws', 'reconnected'));

  await channel.connect();
  log.info('ws', 'connected', { appId: app.id, fallbackCwd: opts.fallbackCwd });
  return channel;
}
