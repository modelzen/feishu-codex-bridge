import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';
import { currentBranch } from './git-info';
import { updateProject, type Project } from './registry';

/**
 * The project group's **announcement** (群公告, design §3.2) — the always-on
 * banner pinned to the top of the chat (the `📢 群公告` tab), not a Pin'd
 * message. One concise line:
 *
 *   📁 <name>   ·   📂 <cwd>   ·   🌿 <branch>
 *
 * Path shows only when the project binds an existing folder (`!blank`); the
 * default `projects/<name>` path is omitted. Branch shows only for git repos.
 * Branch is detected lazily: {@link refreshBranch} rewrites the announcement
 * on message-in / run-end, but only when the branch actually changed.
 *
 * The announcement is a docx document addressed by chat_id, so we edit it via
 * the docx block API: list blocks → find the root page block → clear its
 * children → insert one text block. `revision_id: -1` means "latest", so we
 * don't track revisions across the clear+insert.
 */
const PAGE_BLOCK_TYPE = 1;
const TEXT_BLOCK_TYPE = 2;
const LATEST_REVISION = -1;

function buildAnnouncementLine(project: Project, branch: string | null): string {
  const parts = [`📁 ${project.name}`];
  if (!project.blank) parts.push(`📂 ${project.cwd}`);
  if (branch) parts.push(`🌿 ${branch}`);
  return parts.join('   ·   ');
}

/**
 * Retry transient failures. A just-created group's announcement doc isn't
 * ready immediately — `list` blocks returns a gateway 500 (code 1771002) for a
 * short window after `chat.create`. Linear backoff rides that out (and any
 * other transient 5xx). Permission/4xx errors still get retried but fail fast
 * enough (a few seconds) and surface the real error.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Replace the whole announcement with a single line of text. The list → delete
 * → create sequence is wrapped as one retry unit, and each attempt re-lists so
 * it always works off the latest revision/children (idempotent on retry).
 */
async function writeAnnouncement(channel: LarkChannel, chatId: string, line: string): Promise<void> {
  const docx = channel.rawClient.docx.v1;
  await withRetry(async () => {
    const listed = await docx.chatAnnouncementBlock.list({ path: { chat_id: chatId } });
    const items = listed.data?.items ?? [];
    const page = items.find((b) => b.block_type === PAGE_BLOCK_TYPE);
    if (!page?.block_id) throw new Error('群公告缺少 page block');

    const existing = page.children?.length ?? 0;
    if (existing > 0) {
      await docx.chatAnnouncementBlockChildren.batchDelete({
        path: { chat_id: chatId, block_id: page.block_id },
        params: { revision_id: LATEST_REVISION },
        data: { start_index: 0, end_index: existing },
      });
    }
    await docx.chatAnnouncementBlockChildren.create({
      path: { chat_id: chatId, block_id: page.block_id },
      params: { revision_id: LATEST_REVISION },
      data: {
        index: 0,
        children: [{ block_type: TEXT_BLOCK_TYPE, text: { elements: [{ text_run: { content: line } }] } }],
      },
    });
  });
}

/**
 * Pin the group announcement to the chat's top banner. `action_type: "2"`
 * means "announcement" (vs "1" = a specific message), so no message_id is
 * needed. Reuses the `im:chat` scope — no extra permission. Idempotent.
 */
async function pinAnnouncement(channel: LarkChannel, chatId: string): Promise<void> {
  await withRetry(() =>
    channel.rawClient.im.v1.chatTopNotice.putTopNotice({
      path: { chat_id: chatId },
      data: { chat_top_notice: [{ action_type: '2' }] },
    }),
  );
}

/** Set the project group's announcement, pin it to the top, persist the branch. */
export async function setAnnouncement(channel: LarkChannel, project: Project): Promise<void> {
  const branch = await currentBranch(project.cwd); // null when not a git repo
  await writeAnnouncement(channel, project.chatId, buildAnnouncementLine(project, branch));
  // Pin is best-effort: the announcement content is already written, so a pin
  // failure shouldn't lose the persisted branch below — just no top banner.
  try {
    await pinAnnouncement(channel, project.chatId);
  } catch (err) {
    log.fail('project', err, { phase: 'announcement-pin' });
  }
  // Persist the real branch only; never store a placeholder.
  await updateProject(project.name, { branch: branch ?? undefined });
}

/**
 * Lazy branch detection: re-read the git branch and, if it differs from what
 * the announcement last showed, rewrite it. Cheap when unchanged (one
 * `git rev-parse`).
 */
export async function refreshBranch(channel: LarkChannel, project: Project): Promise<void> {
  const branch = await currentBranch(project.cwd); // null when not a git repo
  if ((branch ?? '—') === (project.branch ?? '—')) return;
  log.info('project', 'branch-change', { name: project.name, from: project.branch ?? '—', to: branch ?? '—' });
  // Only persist the new branch if the rewrite succeeded — otherwise leave the
  // stored branch stale so the next message/run retries (no false "current").
  try {
    await writeAnnouncement(channel, project.chatId, buildAnnouncementLine(project, branch));
    await updateProject(project.name, { branch: branch ?? undefined });
  } catch (err) {
    log.fail('project', err, { phase: 'announcement-patch' });
  }
}
