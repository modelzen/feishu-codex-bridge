import { createLarkChannel, Domain, type LarkChannel } from '@larksuiteoapi/node-sdk';
import type { TenantBrand } from '../config/schema';
import { log } from '../core/logger';
import { makeMessageHandler } from './handle-message';

export interface BridgeOptions {
  appId: string;
  appSecret: string;
  tenant: TenantBrand;
  /** M1: fixed working directory for codex runs (project registry is M2). */
  cwd: string;
}

/**
 * Bring up the long-connection bot. M1 wires the `message` handler
 * (group @bot → thread → codex → streaming card). cardAction / bot.menu
 * handlers come with later milestones.
 */
export async function startBridge(opts: BridgeOptions): Promise<LarkChannel> {
  const channel = createLarkChannel({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.tenant === 'lark' ? Domain.Lark : Domain.Feishu,
    source: 'feishu-codex-bridge',
  });

  channel.on('message', makeMessageHandler(channel, opts.cwd));
  channel.on('reject', (evt) => log.info('intake', 'reject', { reason: evt.reason, msgId: evt.messageId }));
  channel.on('error', (err) => log.fail('ws', err));
  channel.on('reconnecting', () => log.info('ws', 'reconnecting'));
  channel.on('reconnected', () => log.info('ws', 'reconnected'));

  await channel.connect();
  log.info('ws', 'connected', { appId: opts.appId, cwd: opts.cwd });
  return channel;
}
