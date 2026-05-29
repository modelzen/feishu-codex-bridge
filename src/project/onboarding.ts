import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { buildWelcomeCard } from '../card/command-cards';
import type { Project } from './registry';

/**
 * Public command manual — an internet-readable Feishu doc (full command guide +
 * product intro). Linked from the welcome card and surfaced as a chat tab.
 * Empty string = skip the tab + the manual button (no broken links). Set this
 * to the doc's share URL once it's published as "互联网获取链接的人可阅读".
 */
const HELP_DOC_URL: string = 'https://my.feishu.cn/wiki/PZ23wGr7JiKK5RkIG4rcZXzGn5g';

/**
 * Onboard a freshly-created project group (design: 项目=群): post a welcome card
 * listing every command this group supports, Pin it (so it lives in the chat's
 * Pins tab), and add a "👈 查看可使用的命令" url tab pointing at the public manual.
 *
 * This is distinct from the 群公告 top banner ({@link setAnnouncement}): the
 * banner is the always-on one-line project header, while the Pin'd card + tab
 * are the command cheat-sheet. Every step is best-effort — the group is still
 * usable if any of them fails (e.g. missing scope).
 */
export async function onboardGroup(channel: LarkChannel, project: Project): Promise<void> {
  const kind = project.kind ?? 'multi';
  const chatId = project.chatId;

  // 1. Welcome card → Pin. Raw interactive JSON (no callback buttons to mutate,
  //    just an open_url link), so it needn't be a CardKit entity. Capture the
  //    message_id so we can Pin it.
  try {
    const content = JSON.stringify(buildWelcomeCard(kind, HELP_DOC_URL || undefined));
    const sent = await channel.rawClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content },
    });
    const messageId = (sent as { data?: { message_id?: string } }).data?.message_id;
    if (messageId) {
      await channel.rawClient.im.v1.pin.create({ data: { message_id: messageId } });
      log.info('project', 'onboard-pin', { name: project.name });
    }
  } catch (err) {
    log.fail('project', err, { phase: 'onboard-welcome' });
  }

  // 2. Chat tab → public manual. Skipped when no URL is configured (otherwise
  //    we'd pin a tab to an empty link). Sits to the right of the built-in Pins
  //    tab. Only doc/url tab types are allowed by the API.
  if (HELP_DOC_URL) {
    try {
      await channel.rawClient.im.v1.chatTab.create({
        path: { chat_id: chatId },
        data: {
          chat_tabs: [{ tab_name: '👈 使用说明', tab_type: 'url', tab_content: { url: HELP_DOC_URL } }],
        },
      });
      log.info('project', 'onboard-tab', { name: project.name });
    } catch (err) {
      log.fail('project', err, { phase: 'onboard-tab' });
    }
  }
}
