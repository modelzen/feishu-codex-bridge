import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { card, md, note, type CardObject } from '../card/cards';
import { log } from '../core/logger';
import { currentBranch } from './git-info';
import { updateProject, type Project } from './registry';

/**
 * The chat-level pinned banner for a project group (design §3.2). Shows
 * 项目 / cwd / 分支(只读). Branch is detected lazily: callers invoke
 * {@link refreshBranch} on message-in / run-end; the banner card is patched
 * only when the branch actually changed (no-op otherwise).
 *
 * Note: a topic view does NOT show chat-level pins — the run card carries the
 * branch there. The banner serves the main group area.
 */
function buildBannerCard(project: Project, branch: string): CardObject {
  return card(
    [
      md(`📁 **${project.name}**`),
      md(`📂 \`${project.cwd}\``),
      note(`🌿 ${branch}（只读）   ·   在主区 @我 开一个话题干活`),
    ],
    { header: { title: '📌 项目', template: 'grey' } },
  );
}

/** Build + send + pin the banner card, persisting its messageId + branch. */
export async function setBanner(channel: LarkChannel, project: Project): Promise<void> {
  const branch = (await currentBranch(project.cwd)) ?? '—';
  const sent = await channel.send(project.chatId, { card: buildBannerCard(project, branch) });
  await channel.rawClient.im.v1.pin
    .create({ data: { message_id: sent.messageId } })
    .catch((err) => log.fail('project', err, { phase: 'pin' }));
  await updateProject(project.name, { bannerMessageId: sent.messageId, branch });
}

/**
 * Lazy branch detection: re-read the git branch and, if it differs from what
 * the banner last showed, patch the banner card. Best-effort and cheap when
 * unchanged (one `git rev-parse`). No banner messageId → nothing to patch.
 */
export async function refreshBranch(channel: LarkChannel, project: Project): Promise<void> {
  if (!project.bannerMessageId) return;
  const branch = (await currentBranch(project.cwd)) ?? '—';
  if (branch === (project.branch ?? '—')) return;
  log.info('project', 'branch-change', { name: project.name, from: project.branch ?? '—', to: branch });
  // Only persist the new branch if the card patch succeeded — otherwise leave
  // the stored branch stale so the next message/run retries (no false "current").
  try {
    await channel.updateCard(project.bannerMessageId, buildBannerCard(project, branch));
    await updateProject(project.name, { branch });
  } catch (err) {
    log.fail('project', err, { phase: 'banner-patch' });
  }
}
