import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { isAdmin, type AppConfig } from '../config/schema';
import { buildDmMenuCard } from '../card/dm-cards';
import { sendManagedCard } from '../card/managed';
import { log, withTrace } from '../core/logger';

/**
 * p2p (DM) console. Admin-gated (design §5: only admins may create / manage
 * projects). Card-first: any message opens the interactive menu; create / list /
 * remove all happen via card buttons (dm.* actions in handle-message). The
 * console never runs codex.
 */
export async function handleDmConsole(channel: LarkChannel, cfg: AppConfig, msg: NormalizedMessage): Promise<void> {
  await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
    if (!isAdmin(cfg, msg.senderId)) {
      log.info('console', 'deny', { sender: msg.senderId.slice(-6) });
      await channel
        .send(msg.chatId, { markdown: '⛔ 仅管理员可在私聊里管理项目。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    // The menu is a CardKit entity so dm.* button clicks can update it in place
    // (raw-JSON cards can't be patched — they flash and revert).
    await sendManagedCard(channel, msg.chatId, buildDmMenuCard(), msg.messageId).catch((err) =>
      log.fail('console', err, { cmd: 'menu-send' }),
    );
  });
}
