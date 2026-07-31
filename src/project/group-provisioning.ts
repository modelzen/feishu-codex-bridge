import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { publishProjectGroupAnnouncement } from './announcement';
import { onboardGroup } from './onboarding';
import type { Project } from './registry';

export interface CreateProjectGroupInput {
  name: string;
  ownerOpenId: string;
}

/**
 * Create the Feishu/Lark group behind a project. Both the Feishu card flow and
 * the desktop flow use this primitive so "create project" has one meaning:
 * the bridge creates the group, invites the robot owner, and promotes them to
 * group admin. The chat_id is implementation data and is never user input.
 */
export async function createProjectGroup(
  channel: LarkChannel,
  input: CreateProjectGroupInput,
): Promise<string> {
  const response = await channel.rawClient.im.v1.chat.create({
    params: { user_id_type: 'open_id' },
    data: { name: input.name, user_id_list: [input.ownerOpenId] },
  });
  const chatId = (response.data as { chat_id?: string } | undefined)?.chat_id;
  if (!chatId) throw new Error(`建群失败：${JSON.stringify(response).slice(0, 200)}`);

  await channel.rawClient.im.v1.chatManagers
    .addManagers({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id' },
      data: { manager_ids: [input.ownerOpenId] },
    })
    .catch((error) => log.fail('project', error, { phase: 'add-manager' }));

  return chatId;
}

/**
 * Decorate a newly-created group with the same announcement, welcome card,
 * Pin, help tab, and menu used by the Feishu card flow. Best-effort by design:
 * a successfully registered project remains usable if a decorative API is not
 * permitted for this robot.
 */
export async function finalizeCreatedProjectGroup(
  channel: LarkChannel,
  project: Project,
): Promise<void> {
  await publishProjectGroupAnnouncement(channel, project)
    .catch((error) => log.fail('project', error, { phase: 'announcement' }));
  await onboardGroup(channel, project)
    .catch((error) => log.fail('project', error, { phase: 'onboard' }));
}

/** Delete a group created during a project transaction that failed to commit. */
export async function deleteCreatedProjectGroup(
  channel: LarkChannel,
  chatId: string,
): Promise<void> {
  await channel.rawClient.im.v1.chat.delete({ path: { chat_id: chatId } });
  log.info('project', 'create-rollback', { chatId: chatId.slice(-6) });
}
