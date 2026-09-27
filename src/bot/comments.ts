import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { CommentEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import type { TenantBrand } from '../config/schema';
import { log } from '../core/logger';

/**
 * Cloud-doc comment plumbing: when someone @-mentions the bot in a Feishu
 * document comment (the `drive.notice.comment_add_v1` event, surfaced by the
 * SDK as a normalized `comment` event), these helpers read the comment text,
 * resolve wiki nodes, post the agent's answer back into the same thread, and
 * drive the best-effort "Typing" reaction. The agent run itself lives in the
 * orchestrator (handle-message.ts) so it can share the codex backend, session
 * store, and concurrency semaphore.
 *
 * File types supported by drive.v1.fileComment.*: doc / docx / sheet / bitable
 * (多维表格). Bitable comments are NOT a separate API — they ride the same
 * fileComment family: the comment_add event carries file_type="bitable", and the
 * SDK's get/list/reply params accept it. (The human-readable docs only list
 * doc/docx/sheet/file/slides for get/reply while the api-explorer metadata also
 * lists bitable — a known doc/metadata mismatch; the metadata side is the one the
 * SDK and event payload follow.) Deliberately OUT: `file` (云盘文件 — 评论场景用不到),
 * plus slides/mindnote, and whole-doc replies on bitable — fileComment.create
 * (the no-thread fallback) is doc/docx only.
 */
export const SUPPORTED_FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'bitable']);

/** Hard cap on the reply length we post into a comment (Feishu rejects very
 * long comment bodies); answers longer than this are truncated with an ellipsis. */
export const REPLY_MAX_CHARS = 2000;

export type CommentFileType = 'doc' | 'docx' | 'sheet' | 'bitable';

export interface ResolvedTarget {
  fileToken: string;
  fileType: CommentFileType;
}

export interface CommentContext {
  question: string;
  quote?: string;
  isWhole: boolean;
  /** reply_id of the reply carrying the @bot mention — the anchor we react on.
   * Undefined when we couldn't pinpoint a reply. */
  targetReplyId?: string;
}

interface ReplyContentElement {
  type: 'text_run' | 'docs_link' | 'person';
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
}
interface CommentReply {
  reply_id?: string;
  content?: { elements?: ReplyContentElement[] };
}
interface CommentGetResponse {
  data?: { reply_list?: { replies?: CommentReply[] }; quote?: string; is_whole?: boolean };
}
interface CommentListItem {
  comment_id?: string;
  reply_list?: { replies?: CommentReply[] };
  is_whole?: boolean;
  quote?: string;
}
interface CommentListResponse {
  data?: { items?: CommentListItem[]; has_more?: boolean; page_token?: string };
}

/** Pull the Feishu API error code off a thrown rawClient error (axios shape). */
export function apiErrCode(err: unknown): number | undefined {
  return (err as { response?: { data?: { code?: number } } })?.response?.data?.code;
}

export interface ResolvedComment {
  target: ResolvedTarget;
  ctx: CommentContext;
}

/**
 * Resolve a comment event to its (target, context), trying the event's OWN
 * token first — the common case (a normal doc/docx/sheet/bitable), which needs no
 * wiki scope and makes no extra API call. Only if that yields no question do we
 * treat the token as a knowledge-base (wiki) node, resolve it to the underlying
 * doc, and retry. So `wiki:*` scope is needed solely for wiki-hosted docs, and
 * a regular doc never triggers the (noisy, scope-gated) wiki getNode call.
 * Returns null when the file type is unsupported or no question was found.
 */
export async function resolveComment(
  channel: LarkChannel,
  evt: CommentEvent,
): Promise<ResolvedComment | null> {
  if (!SUPPORTED_FILE_TYPES.has(evt.fileType)) return null;

  const direct: ResolvedTarget = {
    fileToken: evt.fileToken,
    fileType: evt.fileType as CommentFileType,
  };
  const directCtx = await fetchCommentContext(channel, direct, evt).catch((err) => {
    if (apiErrCode(err) === 1069307) log.warn('comment', 'no-access', { token: direct.fileToken });
    else log.fail('comment', err, { step: 'fetch-direct' });
    return null;
  });
  if (directCtx?.question) return { target: direct, ctx: directCtx };

  // No question via the direct token → it may be a wiki node. Resolve + retry.
  const wiki = await resolveWikiNode(channel, evt.fileToken);
  if (wiki) {
    const wikiCtx = await fetchCommentContext(channel, wiki, evt).catch((err) => {
      log.fail('comment', err, { step: 'fetch-wiki' });
      return null;
    });
    if (wikiCtx?.question) return { target: wiki, ctx: wikiCtx };
  }
  return null;
}

/**
 * If `fileToken` is a knowledge-base (wiki) node, return its underlying
 * (obj_token, obj_type); otherwise null. Swallows errors (not a wiki node, or
 * `wiki:*` scope ungranted) — callers only reach here after the direct token
 * already failed, so a miss just means "give up".
 */
async function resolveWikiNode(
  channel: LarkChannel,
  fileToken: string,
): Promise<ResolvedTarget | null> {
  try {
    const r = await channel.rawClient.wiki.v2.space.getNode({ params: { token: fileToken } });
    const node = (r as { data?: { node?: { obj_token?: string; obj_type?: string } } })?.data?.node;
    if (node?.obj_token && node.obj_type && SUPPORTED_FILE_TYPES.has(node.obj_type)) {
      log.info('comment', 'wiki-resolved', { objToken: node.obj_token, objType: node.obj_type });
      return { fileToken: node.obj_token, fileType: node.obj_type as CommentFileType };
    }
  } catch {
    // not a wiki node, or wiki scope not granted — fine, caller gives up
  }
  return null;
}

/**
 * Fetch the comment thread and extract the @bot question. Tries `.get` first;
 * if it fails for ANY reason — commonly 1069307 on block-anchored comments, but
 * also transient/network errors — we fall back to paging `.list`. A genuinely
 * inaccessible comment then yields empty replies / an empty question and is
 * skipped upstream, so the broad catch only ever trades one API shape for the
 * other, never masks a hard failure.
 */
export async function fetchCommentContext(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
): Promise<CommentContext> {
  let replies: CommentReply[] = [];
  let quote: string | undefined;
  let isWhole = false;
  try {
    const r = (await channel.rawClient.drive.v1.fileComment.get({
      params: { file_type: target.fileType },
      path: { file_token: target.fileToken, comment_id: evt.commentId },
    })) as CommentGetResponse;
    replies = r?.data?.reply_list?.replies ?? [];
    quote = r?.data?.quote || undefined;
    isWhole = Boolean(r?.data?.is_whole);
  } catch (err) {
    log.warn('comment', 'get-failed-fallback-list', { code: apiErrCode(err) });
    const found = await findCommentViaList(channel, target, evt.commentId);
    replies = found?.reply_list?.replies ?? [];
    quote = found?.quote || undefined;
    isWhole = Boolean(found?.is_whole);
  }

  // Prefer the reply the event points at (the one with the @mention); else the
  // last reply in the thread.
  const targetReply =
    (evt.replyId ? replies.find((rr) => rr.reply_id === evt.replyId) : undefined) ??
    replies[replies.length - 1];
  const question = elementsToText(targetReply?.content?.elements ?? []);
  return { question, quote, isWhole, targetReplyId: targetReply?.reply_id };
}

function elementsToText(elements: ReplyContentElement[]): string {
  return elements
    .map((el) => {
      if (el.type === 'text_run') return el.text_run?.text ?? '';
      if (el.type === 'docs_link') return el.docs_link?.url ?? '';
      return '';
    })
    .join('')
    .trim();
}

async function findCommentViaList(
  channel: LarkChannel,
  target: ResolvedTarget,
  commentId: string,
): Promise<CommentListItem | null> {
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = (await channel.rawClient.drive.v1.fileComment.list({
      params: {
        file_type: target.fileType,
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
      path: { file_token: target.fileToken },
    })) as CommentListResponse;
    const items = r?.data?.items ?? [];
    const hit = items.find((it) => it.comment_id === commentId);
    if (hit) return hit;
    if (!r?.data?.has_more || !r.data.page_token) {
      // Walked the whole comment list (or the doc has none) without a match.
      return null;
    }
    pageToken = r.data.page_token;
  }
  // Hit the 10-page (≈1000-comment) safety cap without finding the target —
  // distinct from a genuinely empty mention so a missing reply is diagnosable.
  log.warn('comment', 'comment-not-found-after-paging', { commentId, pagesScanned: 10 });
  return null;
}

const DOC_HOSTS: Record<TenantBrand, string> = {
  feishu: 'feishu.cn',
  lark: 'larksuite.com',
};

/**
 * file_type (the API value) → the path segment in the public web URL. These are
 * NOT all identical to the type string: a 旧版文档 lives at /docs/, a 电子表格 at
 * /sheets/, and a 多维表格 (bitable) at /base/ — only docx and file match verbatim.
 * Building links as /<fileType>/<token> would 404 for doc/sheet/bitable. Unknown
 * types fall back to the verbatim segment.
 */
const DOC_URL_PATH: Record<CommentFileType, string> = {
  doc: 'docs',
  docx: 'docx',
  sheet: 'sheets',
  bitable: 'base',
};

/** Public web URL for a cloud doc, honoring the per-type path segment above. */
function buildDocUrl(tenant: TenantBrand, fileType: string, fileToken: string): string {
  const seg = DOC_URL_PATH[fileType as CommentFileType] ?? fileType;
  return `https://${DOC_HOSTS[tenant]}/${seg}/${fileToken}`;
}

/**
 * 出厂默认的「评论助手」指令——会被同步成每个文档评论工作目录里的 AGENTS.md
 * （codex 原生读）与 CLAUDE.md（claude 开 settingSources 后读），从而不必每轮注入。
 * 用户可直接编辑 master 文件（paths.commentInstructionsFile）整段覆盖；其中「必须遵守」一节是
 * 「机器契约」（系统靠它自动回贴、靠纯文本渲染），删掉会导致回复发不出去或显示乱码。
 */
export const DEFAULT_COMMENT_INSTRUCTIONS = `# 飞书云文档评论助手

你被 @ 在一篇飞书云文档（{docUrl}，类型 {fileType}，file_token：{fileToken}）的评论里。系统会把你这一轮的最终回复自动贴回这条评论。每轮还会给你评论范围和（行内评论时）选中的原文。

## 怎么做
- 需要看正文，或用户要求"帮我改 / 优化 / 重写 / 细化这段"时，用 lark-cli 读 / 改这篇文档（{fileToken}）。
- 改文档时绝不要删除或整段替换"被评论的原文"（本轮给你的选中原文）——飞书评论锚定在这段文字上，删了它评论会变成"原文已被删除"、移进历史评论，正文就看不到了。要保留这段原文，在它之后或周围增改，只动这一处。
- 改完只回一句简短说明；用户只是提问就直接答，不改任何东西。

## 必须遵守
1. 不要自己发表 / 回复 / 解决 / 删除任何飞书评论——系统会自动把你的最终回复贴上去。
2. 只输出最终答案本身，不要复述分析过程或"我现在去…"。
3. 全程纯文本：不要任何 markdown 标记（** __ # - * > 反引号 之类）、不要代码块、不要表格——评论框不渲染，会原样显示这些符号。语气简洁直接。
`;

/** A doc-comment session key — one per comment THREAD (not per doc), so distinct
 * comment threads on the same document are independent conversations that run in
 * parallel, while replies within a thread continue the same session. */
export function commentSessionKey(fileToken: string, commentId: string): string {
  return `doc:${fileToken}:${commentId}`;
}

/** The per-document working directory for comment runs: one folder per document
 * (shared by all of its comment threads), named so it's recognizable on disk and
 * in codex/claude session lists. Holds the synced AGENTS.md / CLAUDE.md. */
export function commentCwd(projectsRoot: string, fileType: string, fileToken: string): string {
  return join(projectsRoot, `comment-${fileType}-${fileToken}`);
}

/**
 * Read the user-editable instructions master file. Seeds it with the built-in
 * default ONLY when it's missing/unreadable (so there's always a file to edit),
 * then uses the default. An existing file is used as-is and never overwritten —
 * a blank/whitespace-only file falls back to the default for this run but is left
 * untouched on disk (never silently clobber a file the user may have emptied).
 * A comment run never blocks on this.
 */
export async function loadCommentInstructions(masterFile: string): Promise<string> {
  try {
    const existing = await readFile(masterFile, 'utf8');
    return existing.trim() ? existing : DEFAULT_COMMENT_INSTRUCTIONS; // exists → use as-is (blank → default, no clobber)
  } catch {
    // missing / unreadable only — seed a copy below so the user has a file to edit
  }
  await mkdir(dirname(masterFile), { recursive: true }).catch(() => undefined);
  await writeFile(masterFile, DEFAULT_COMMENT_INSTRUCTIONS, 'utf8').catch(() => undefined);
  return DEFAULT_COMMENT_INSTRUCTIONS;
}

/**
 * Sync the instructions into a document's comment working directory as BOTH
 * AGENTS.md (codex reads it natively) and CLAUDE.md (claude reads it once the
 * backend opts into settingSources). Called before each run so edits to the
 * master file propagate to the next comment in any document.
 */
export async function syncCommentInstructions(cwd: string, instructions: string): Promise<void> {
  await mkdir(cwd, { recursive: true });
  await Promise.all([
    writeFile(join(cwd, 'AGENTS.md'), instructions, 'utf8'),
    writeFile(join(cwd, 'CLAUDE.md'), instructions, 'utf8'),
  ]);
}

/** Write the user-edited instructions to the master file (in-card prompt editor).
 * Creates the parent dir if needed. The caller then re-syncs all comment dirs. */
export async function saveCommentInstructions(masterFile: string, content: string): Promise<void> {
  await mkdir(dirname(masterFile), { recursive: true });
  const temporary = `${masterFile}.tmp-${randomUUID()}`;
  try { await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, masterFile); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

/** Substitute the doc-level variables ({fileType}/{fileToken}/{docUrl}) in the
 * instructions for one document. Unknown `{...}` are left untouched. The set of
 * variables (and how each is described to the user) is spelled out in the prompt
 * editor card (buildCommentPromptCard); keep the two in sync. The comment's
 * selected text and the user's question are delivered to the agent automatically
 * every turn, so they aren't variables. */
export function renderCommentInstructions(
  template: string,
  tenant: TenantBrand,
  fileType: string,
  fileToken: string,
): string {
  const docUrl = buildDocUrl(tenant, fileType, fileToken);
  return template
    .replace(/\{fileType\}/g, fileType)
    .replace(/\{fileToken\}/g, fileToken)
    .replace(/\{docUrl\}/g, docUrl);
}

/**
 * Re-sync the instructions into EVERY existing comment working dir under
 * `projectsRoot` (`comment-<type>-<token>`), substituting each doc's own
 * variables. Called when the user edits the master prompt so the change reaches
 * ALL documents — including ones commented in the past — not just the next one
 * touched. Returns how many dirs were synced. Best-effort per dir.
 */
export async function syncAllCommentInstructions(
  projectsRoot: string,
  rawTemplate: string,
  tenant: TenantBrand,
): Promise<number> {
  const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  let synced = 0;
  let failed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('comment-')) continue;
    const m = /^comment-([a-z]+)-(.+)$/.exec(e.name);
    const fileType = m?.[1];
    const fileToken = m?.[2];
    if (!fileType || !fileToken) continue;
    const rendered = renderCommentInstructions(rawTemplate, tenant, fileType, fileToken);
    try { await syncCommentInstructions(join(projectsRoot, e.name), rendered); synced++; } catch { failed++; }
  }
  if (failed) throw new Error(`回复规则已保存，${failed} 个历史目录同步失败，${synced} 个已同步`);
  return synced;
}

/**
 * Build the per-turn user message for a doc-comment mention — runtime FACTS only
 * (doc link/token/type, comment scope, the selected quote, the question). The
 * behavioral instructions (read/edit via lark-cli, don't self-post, plain-text
 * output) live in the synced AGENTS.md / CLAUDE.md instead of being repeated
 * every turn (see {@link DEFAULT_COMMENT_INSTRUCTIONS}).
 */
export function buildCommentPrompt(
  target: ResolvedTarget,
  ctx: CommentContext,
  tenant: TenantBrand,
): string {
  const docUrl = buildDocUrl(tenant, target.fileType, target.fileToken);
  const parts: string[] = [];
  parts.push('我在飞书云文档的评论里 @了你。文档信息：');
  parts.push(`- 链接：${docUrl}`);
  parts.push(`- file_token：${target.fileToken}`);
  parts.push(`- 类型：${target.fileType}`);
  parts.push(`- 评论范围：${ctx.isWhole ? '全文评论（针对整篇文档）' : '行内评论（针对选中的文字）'}`);
  if (ctx.quote) {
    parts.push('');
    parts.push(`用户选中的原文：\n> ${ctx.quote.replace(/\n/g, '\n> ')}`);
  }
  parts.push('');
  parts.push(`用户的问题：${ctx.question}`);
  return parts.join('\n');
}

/**
 * Strip the most common markdown markers so a plain-text comment doesn't show
 * literal `**` / `#` / `> ` etc. Conservative — only touches bold, italic,
 * headings, blockquote, list bullets, and inline/fenced code.
 */
export function stripMarkdown(s: string): string {
  return (
    s
      // Fenced code FIRST: drop the ``` fences (with optional lang) but keep the
      // body — must run before the inline-code rule, else its backticks get
      // eaten pairwise and the fence is left half-stripped.
      .replace(/```[a-zA-Z]*\n?/g, '')
      .replace(/```/g, '')
      // headings: "# foo" -> "foo"
      .replace(/^#{1,6}\s+/gm, '')
      // bold/italic: **foo** / __foo__ / *foo* / _foo_. The single-delimiter
      // rules require the markers to hug non-space content (`(?!\s)`/`(?<!\s)`),
      // so a lone `*` or `_` used as an operator (`a * b`) is left alone.
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, '$1')
      .replace(/(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1')
      // inline code: `foo` -> foo
      .replace(/`([^`]+)`/g, '$1')
      // unordered list bullets + blockquote
      .replace(/^[-*]\s+/gm, '')
      .replace(/^>\s?/gm, '')
  );
}

/**
 * Post the answer as a reply in the same comment thread. Whole-document
 * comments have no thread (1069302) — fall back to a fresh top-level comment.
 */
export async function postCommentReply(
  channel: LarkChannel,
  target: ResolvedTarget,
  evt: CommentEvent,
  text: string,
): Promise<void> {
  try {
    await channel.rawClient.drive.v1.fileCommentReply.create({
      params: { file_type: target.fileType },
      path: { file_token: target.fileToken, comment_id: evt.commentId },
      data: { content: { elements: [{ type: 'text_run', text_run: { text } }] } },
    });
    log.info('comment', 'replied', { mode: 'in-thread' });
    return;
  } catch (err) {
    // 1069302: whole-document comments don't accept replies — they have no
    // thread, only a flat list. Anything else is a real failure.
    if (apiErrCode(err) !== 1069302) throw err;
    log.warn('comment', 'reply-rejected-fallback-create', { code: 1069302 });
  }

  // Whole-doc fallback: fileComment.create only accepts doc/docx.
  if (target.fileType !== 'doc' && target.fileType !== 'docx') {
    log.warn('comment', 'whole-doc-reply-unsupported', { fileType: target.fileType });
    return;
  }
  await channel.rawClient.drive.v1.fileComment.create({
    params: { file_type: target.fileType },
    path: { file_token: target.fileToken },
    data: {
      reply_list: { replies: [{ content: { elements: [{ type: 'text_run', text_run: { text } }] } }] },
    },
  });
  log.info('comment', 'replied', { mode: 'new-top-level' });
}

/**
 * Add a "Typing" reaction to a cloud-doc comment reply. Doc comments have their
 * own reaction endpoint (drive/v2/comment_reaction) — separate from IM message
 * reactions, and unlike IM it returns no reaction id: add/delete are the same
 * POST with an `action` field. Returns true if the call succeeded so callers
 * know whether to bother sending the matching remove. Best-effort.
 */
export async function addCommentReaction(
  channel: LarkChannel,
  target: ResolvedTarget,
  replyId: string,
): Promise<boolean> {
  return commentReaction(channel, target, replyId, 'add');
}

export async function removeCommentReaction(
  channel: LarkChannel,
  target: ResolvedTarget,
  replyId: string,
): Promise<void> {
  await commentReaction(channel, target, replyId, 'delete');
}

async function commentReaction(
  channel: LarkChannel,
  target: ResolvedTarget,
  replyId: string,
  action: 'add' | 'delete',
): Promise<boolean> {
  try {
    await channel.rawClient.drive.v2.commentReaction.updateReaction({
      params: { file_type: target.fileType },
      path: { file_token: target.fileToken },
      data: { action, reply_id: replyId, reaction_type: 'Typing' },
    });
    log.info('comment', `reaction-${action}`, { fileToken: target.fileToken, replyId });
    return true;
  } catch (err) {
    log.warn('comment', `reaction-${action}-failed`, {
      replyId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
