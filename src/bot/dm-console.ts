import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { isAdmin, type AppConfig } from '../config/schema';
import { buildDmMenuCard } from '../card/dm-cards';
import { log, withTrace } from '../core/logger';
import { createProject } from '../project/lifecycle';
import { listProjects, getProjectByName, removeProject } from '../project/registry';
import { transferOwnership } from '../project/group-ops';

/**
 * p2p (DM) console. Admin-gated (design §5: only admins may create projects /
 * manage). M2: text commands; the bot-menu + cards come later. Never runs codex.
 */
export async function handleDmConsole(channel: LarkChannel, cfg: AppConfig, msg: NormalizedMessage): Promise<void> {
  await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
    const reply = (markdown: string): Promise<unknown> =>
      channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId }).catch(() => undefined);

    if (!isAdmin(cfg, msg.senderId)) {
      log.info('console', 'deny', { sender: msg.senderId.slice(-6) });
      await reply('⛔ 仅管理员可在私聊里管理项目。');
      return;
    }

    const text = msg.content.trim();
    const parts = text.split(/\s+/);
    const cmd = parts[0] ?? '';
    log.info('console', 'cmd', { cmd });

    try {
      switch (cmd) {
        case '/new': {
          const name = parts[1];
          const path = parts[2];
          if (!name) {
            await reply('用法：`/new <名>` 或 `/new <名> <现有路径>`');
            return;
          }
          await reply(`⏳ 正在创建项目「${name}」…`);
          const p = await createProject(channel, { name, ownerOpenId: msg.senderId, existingPath: path });
          await reply(
            `✅ 项目「${p.name}」已创建（${p.blank ? '空白' : '现有文件夹'}）\n` +
              `cwd: \`${p.cwd}\`\n已建群并把你拉入，去群里 @我 开话题干活。`,
          );
          break;
        }
        case '/projects': {
          const list = await listProjects();
          if (!list.length) {
            await reply('还没有项目。用 `/new <名>` 建一个。');
            return;
          }
          const lines = list.map(
            (p) => `- **${p.name}** — \`${p.cwd}\`${p.blank ? ' _(空白)_' : ''}`,
          );
          await reply(`📁 **项目（${list.length}）**\n${lines.join('\n')}`);
          break;
        }
        case '/rm': {
          const name = parts[1];
          if (!name) {
            await reply('用法：`/rm <名>`');
            return;
          }
          const existing = await getProjectByName(name);
          if (!existing) {
            await reply(`未找到项目「${name}」。`);
            return;
          }
          const removed = await removeProject(name);
          if (removed?.bannerMessageId) {
            await channel.rawClient.im.v1.pin
              .delete({ path: { message_id: removed.bannerMessageId } })
              .catch(() => undefined);
          }
          let transferred = false;
          if (removed?.chatId) {
            transferred = await transferOwnership(channel, removed.chatId, msg.senderId)
              .then(() => true)
              .catch((err) => {
                log.fail('console', err, { phase: 'owner-transfer' });
                return false;
              });
          }
          await reply(
            `✅ 已删除项目「${name}」（解绑，未删代码目录）。\n` +
              (transferred
                ? `群主已转给你 → 请在飞书里**自行解散该群**。`
                : `⚠️ 群主转让失败，请用「🚪 群管理」手动转让后解散。`),
          );
          break;
        }
        case '/menu':
        case '/help':
        default:
          // card-first console: text commands still work, but the default
          // surface is the interactive menu (buttons → CardDispatcher dm.*).
          await channel.send(msg.chatId, { card: buildDmMenuCard() }, { replyTo: msg.messageId }).catch(() => undefined);
      }
    } catch (err) {
      log.fail('console', err, { cmd });
      await reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
