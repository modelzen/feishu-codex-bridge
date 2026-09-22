import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { PermissionMode } from '../agent/types';
import { scanLocalFiles, type LocalFileRef } from '../card/file-refs';
import type { CardElement } from '../card/cards';
import { fileComponentCount, renderFileAnswer, type InlineFiles } from '../card/inline-files';
import type { CardDispatcher } from '../card/dispatcher';
import { log } from '../core/logger';

export const FILE_GET = 'file.get';
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_FILE_LINKS = 10;
const MAX_ANSWER_COMPONENTS = 120;
const MAX_LIVE_BINDINGS = 256;
const SEND_RETRY_WINDOW_MS = 55 * 60_000;

interface FileSnapshot {
  path: string;
  label: string;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}
interface FileOccurrence { elementId: string; label: string }
interface FileEntry extends FileSnapshot {
  revision?: string;
  error?: string;
  fileKey?: string;
  sendStartedAt?: number;
  messageId?: string;
  messageLink?: string;
  sendUuid?: string;
  needsPaint?: boolean;
  occurrences: FileOccurrence[];
}
export interface FileContext {
  messageId: string;
  chatId: string;
  cwd: string;
  mode: PermissionMode;
  requesterOpenId?: string;
  replyInThread: boolean;
  cardId?: string;
}
interface Manifest extends FileContext { files: FileEntry[]; sequence?: number }
type Paint = (elementId: string, element: CardElement) => Promise<boolean>;
type Authorize = (context: FileContext, openId: string) => Promise<PermissionMode | undefined>;
interface FileClick { messageId: string; chatId: string; operator?: { openId?: string } }

/** Raw IM responses return message_position; message_app_link is sometimes
 * added by a higher-level client (including lark-cli), not by the IM API.
 * This matches the CLI's verified link for the same chat/message position. */
function messageLink(message: { message_app_link?: string; message_position?: string; chat_id?: string }, chatId: string): string | undefined {
  if (message.message_app_link) return message.message_app_link;
  const position = message.message_position;
  if (position == null || !/^\d+$/.test(String(position))) return undefined;
  const query = new URLSearchParams({ openChatId: message.chat_id ?? chatId, position: String(position) });
  return `https://applink.feishu.cn/client/chat/open?${query}`;
}

/** The visible label never changes: progress and retry details are tooltips,
 * while the interaction switches from sending to locating the sent message. */
function fileText(id: string, index: number, file: FileEntry, chatId: string,
  occurrence: FileOccurrence, sending = false): CardElement {
  const behavior = file.messageId ? { type: 'open_url', default_url:
    file.messageLink ?? `https://applink.feishu.cn/client/chat/open?openChatId=${encodeURIComponent(chatId)}` }
    : { type: 'callback', value: { a: FILE_GET, r: file.revision ?? '0', id, i: index } };
  const hint = file.messageId ? (file.messageLink ? '查看附件消息' : '已发送，在会话中查看附件')
    : sending ? '正在发送…' : file.error ? `${file.error} · 点击重试` : '点击发送文件到当前会话';
  const label = occurrence.label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()!#|])/g, '\\$1');
  return {
    tag: 'interactive_container', element_id: occurrence.elementId,
    width: 'auto', height: 'auto', direction: 'vertical',
    background_style: 'default', has_border: false, corner_radius: '0px', padding: '0px', margin: '0px',
    behaviors: [behavior], disabled: sending,
    hover_tips: { tag: 'plain_text', content: hint },
    disabled_tips: { tag: 'plain_text', content: hint },
    elements: [{ tag: 'markdown', content: `<font color='blue'>${label}</font>`, margin: '0px' }],
  };
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function sourcePath(src: string, cwd: string): string {
  let path = src;
  if (/^file:\/\//i.test(path)) path = fileURLToPath(path);
  else { try { path = decodeURIComponent(path); } catch { /* literal percent */ } }
  // Codex source references can carry :line[:column] or #Lline anchors.
  path = path.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, '').replace(/:\d+(?::\d+)?$/, '');
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  return resolve(cwd, path);
}

async function inspect(path: string, cwd: string, mode: PermissionMode): Promise<FileSnapshot> {
  const canonical = await realpath(path);
  if (mode !== 'full' && !inside(await realpath(cwd), canonical)) throw new Error('文件超出项目可访问范围');
  const info = await stat(canonical);
  if (!info.isFile()) throw new Error('仅支持获取普通文件');
  if (info.size === 0) throw new Error('飞书不支持发送空文件');
  if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 30 MB，无法作为飞书附件发送');
  return { path: canonical, label: basename(path), size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev };
}

function unchanged(a: FileSnapshot, b: Pick<FileSnapshot, 'size' | 'mtimeMs' | 'ino' | 'dev'>): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
}

/** Validate the open descriptor as well as the path to detect replacement
 * between inspection and reading. Bound reads to the advertised file size. */
async function readSnapshot(file: FileSnapshot): Promise<Buffer> {
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || !unchanged(file, info)) throw new Error('本地文件已变化，请重新获取文件引用');
    const bytes = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('本地文件读取不完整，请重试');
      offset += bytesRead;
    }
    if (!unchanged(file, await handle.stat())) throw new Error('本地文件正在修改，请稍后重新获取文件引用');
    return bytes;
  } finally { await handle.close(); }
}

async function uploadFile(channel: LarkChannel, file: FileSnapshot): Promise<string> {
  const ext = extname(file.label).toLowerCase();
  const fileType = ext === '.pdf' ? 'pdf' : /^\.docx?$/.test(ext) ? 'doc'
    : /^\.xlsx?$/.test(ext) ? 'xls' : /^\.pptx?$/.test(ext) ? 'ppt' : 'stream';
  const bytes = await readSnapshot(file);
  const uploaded = await timed(channel.rawClient.im.v1.file.create({
    data: { file_type: fileType, file_name: file.label, file: bytes },
  }));
  if (!uploaded?.file_key) throw new Error('文件上传失败，请检查机器人 im:resource 权限后重试');
  return uploaded.file_key;
}

const friendly = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return '本地文件已不存在';
  if (code === 'EACCES' || code === 'EPERM') return '无法读取本地文件';
  return err instanceof Error ? err.message : '获取失败，请重试';
};

async function timed<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('飞书文件接口响应超时，请稍后重试')), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Durable, bot-scoped references. Preparing a reply reads metadata only: no
 * file bytes, credentials, agent turns, or Feishu API calls until a click. */
export class OutboundFiles {
  private readonly busy = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly bindings = new Map<string, { prepared: InlineFiles; paint?: Paint }>();
  private ready: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, private readonly interactionDelayMs = 500) {}

  /** Restore interrupted interactions without sending files on startup. */
  recover(channel: LarkChannel): Promise<void> {
    this.ready = this.recoverPending(channel).catch((err) => log.fail('outbound', err, { phase: 'file-recover-startup' }));
    return this.ready;
  }

  private async recoverPending(channel: LarkChannel): Promise<void> {
    const names = await readdir(this.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const manifest = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as Manifest;
        for (const [index, file] of manifest.files.entries()) {
          if (!file.needsPaint || !file.occurrences?.length) continue;
          if (!file.messageId) {
            file.error = '上次获取中断，请重试';
            file.revision = randomUUID().slice(0, 8);
          } else await this.resolveLink(channel, file, manifest.chatId);
          await this.save(name.slice(0, -5), manifest);
          await this.settleLinks(channel, name.slice(0, -5), manifest, index);
        }
      } catch (err) { log.fail('outbound', err, { phase: 'file-recover' }); }
    }
  }

  private async save(id: string, manifest: Manifest): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${id}.json`);
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 });
    await rename(tmp, path);
  }

  async prepare(text: string, context: FileContext, paint?: Paint): Promise<InlineFiles> {
    const refs = scanLocalFiles(text);
    if (refs.length === 0) return { text, links: [] };
    try {
      return await this.prepareReferences(text, refs, context, paint);
    } catch (err) {
      log.fail('outbound', err, { phase: 'file-prepare' });
      return { text, links: [] };
    }
  }

  private async prepareReferences(text: string, refs: LocalFileRef[], context: FileContext, paint?: Paint): Promise<InlineFiles> {
    await this.ready;
    const id = createHash('sha256').update(context.messageId).digest('hex');
    const previous = await readFile(join(this.dir, `${id}.json`), 'utf8')
      .then((raw) => JSON.parse(raw) as Manifest).catch(() => undefined);
    const files: FileEntry[] = [];
    const links: InlineFiles['links'] = [];
    const edits: Array<{ start: number; end: number; text: string; fallback: string }> = [];
    let prefix = `BRIDGEFILE${id.slice(0, 16)}REF`;
    while (text.includes(prefix)) prefix += 'X';
    for (const ref of refs) {
      const edit = { start: ref.start, end: ref.end, text: ref.fallback, fallback: ref.fallback };
      edits.push(edit);
      if (links.length >= MAX_FILE_LINKS) continue;
      try {
        const inspected = await inspect(sourcePath(ref.src, context.cwd), context.cwd, context.mode);
        let index = files.findIndex((file) => file.path === inspected.path);
        if (index < 0) {
          index = files.length;
          const prior = previous?.files.find((file) => file.path === inspected.path && unchanged(file, inspected));
          files.push({ ...(prior ?? inspected), occurrences: [] });
        }
        const file = files[index]!;
        const occurrence = { elementId: `local_file_${links.length}`, label: ref.label };
        file.occurrences.push(occurrence);
        const token = `${prefix}${links.length}END`;
        links.push({ token, element: fileText(id, index, file, context.chatId, occurrence) });
        edit.text = token;
      } catch (err) {
        log.info('outbound', 'file-unavailable', { reason: friendly(err) });
      }
    }
    const compose = (): string => {
      let rendered = text;
      for (const edit of [...edits].reverse()) rendered = rendered.slice(0, edit.start) + edit.text + rendered.slice(edit.end);
      return rendered;
    };
    const prepared: InlineFiles = { text: compose(), links };
    // A large native table must not become thousands of nested components just
    // because one cell references a file. Fall back in place to readable text.
    while (links.length && fileComponentCount(renderFileAnswer(prepared)) > MAX_ANSWER_COMPONENTS) {
      const { token, element } = links.pop()!;
      for (const file of files) file.occurrences = file.occurrences.filter((o) => o.elementId !== element.element_id);
      const edit = edits.find((e) => e.text === token)!;
      edit.text = edit.fallback;
      prepared.text = compose();
    }
    if (links.length === 0) return prepared;
    await this.save(id, { ...context, files, sequence: previous?.sequence });
    // Recent cards retain their stream queue, even after their settings controls
    // are demoted. Older cards use the persisted CardKit ID after eviction/restart.
    this.bindings.delete(id);
    this.bindings.set(id, { prepared, paint });
    if (this.bindings.size > MAX_LIVE_BINDINGS) this.bindings.delete(this.bindings.keys().next().value!);
    return prepared;
  }

  private async repaint(channel: LarkChannel, id: string, manifest: Manifest, index: number, sending = false): Promise<boolean> {
    const file = manifest.files[index]!;
    let painted = true;
    for (const occurrence of file.occurrences) {
      const element = fileText(id, index, file, manifest.chatId, occurrence, sending);
      if (!await this.repaintElement(channel, id, manifest, element)) painted = false;
    }
    return painted;
  }

  private async repaintElement(channel: LarkChannel, id: string, manifest: Manifest, element: CardElement): Promise<boolean> {
    const elementId = String(element.element_id);
    const binding = this.bindings.get(id);
    if (binding) {
      const link = binding.prepared.links.find(({ element }) => element.element_id === elementId);
      if (link) link.element = element;
    }
    try {
      if (binding?.paint) return await binding.paint(elementId, element);
      if (!manifest.cardId) return false;
      // No live stream after restart. Persist a monotonically increasing epoch
      // sequence so subsequent retries/restarts cannot go backwards.
      for (let attempt = 0; attempt < 2; attempt++) {
        manifest.sequence = Math.max((manifest.sequence ?? 0) + 1, Math.floor(Date.now() / 1000));
        await this.save(id, manifest);
        try {
          const result = await timed(channel.rawClient.cardkit.v1.cardElement.update({
            path: { card_id: manifest.cardId, element_id: elementId },
            data: { element: JSON.stringify(element), sequence: manifest.sequence, uuid: randomUUID() },
          }));
          if (result?.code) throw new Error(`CardKit ${result.code}`);
          return true;
        } catch (err) {
          if (attempt === 1) throw err;
          await new Promise((r) => setTimeout(r, 3200));
        }
      }
    } catch (err) { log.fail('outbound', err, { phase: 'file-link-update' }); }
    return false;
  }

  private async resolveLink(channel: LarkChannel, file: FileEntry, chatId: string): Promise<void> {
    if (!file.messageId || file.messageLink) return;
    try {
      const result = await timed(channel.rawClient.im.v1.message.get({ path: { message_id: file.messageId } }));
      const item = result.data?.items?.find((m) => m.message_id === file.messageId);
      if (item && !item.deleted) file.messageLink = messageLink(item, chatId);
    } catch (err) { log.fail('outbound', err, { phase: 'file-message-link' }); }
  }

  private async settleLinks(channel: LarkChannel, id: string, manifest: Manifest, index: number): Promise<void> {
    if (await this.repaint(channel, id, manifest, index)) {
      delete manifest.files[index]!.needsPaint;
      await this.save(id, manifest);
    }
  }

  /** The caller rechecks current project membership/binding/permissions; card
   * callback values carry only opaque IDs, never a trusted filesystem path. */
  register(dispatcher: CardDispatcher, authorize: Authorize): void {
    dispatcher.on(FILE_GET, ({ channel, evt, value }) => {
      // Return immediately so the Feishu callback is acknowledged before I/O.
      void this.deliver(channel, evt, value, authorize).catch((err) => log.fail('outbound', err, { phase: 'file-delivery' }));
    });
  }

  async deliver(
    channel: LarkChannel,
    evt: FileClick,
    value: Record<string, unknown>,
    authorize: Authorize,
  ): Promise<void> {
    await this.ready;
    const id = typeof value.id === 'string' ? value.id : '';
    const index = value.i;
    if (!/^[a-f0-9]{64}$/.test(id) || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
    const key = `${id}:${index}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    const previous = this.tails.get(id) ?? Promise.resolve();
    const task = previous.then(() => this.deliverOne(channel, evt, id, index, authorize));
    const tail = task.catch(() => undefined);
    this.tails.set(id, tail);
    try { await task; }
    finally {
      this.busy.delete(key);
      // Only the last queued operation can remove the card's serialization tail.
      if (this.tails.get(id) === tail) this.tails.delete(id);
    }
  }

  private async deliverOne(
    channel: LarkChannel,
    evt: FileClick,
    id: string,
    index: number,
    authorize: Authorize,
  ): Promise<void> {
    let manifest: Manifest | undefined;
    let authorized = false;
    let file: FileEntry | undefined;
    try {
      manifest = JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8')) as Manifest;
      if (manifest.messageId !== evt.messageId || manifest.chatId !== evt.chatId) return;
      const mode = await authorize(manifest, evt.operator?.openId ?? '');
      if (!mode) throw new Error('当前无权获取此文件，请由任务发起人或管理员操作');
      authorized = true;
      file = manifest.files[index];
      if (!file?.occurrences?.length) throw new Error('文件入口已失效，请让 agent 重新引用文件');
      // Callback acknowledgment has returned; let Feishu's interaction frame
      // settle before mutating the source card (otherwise updates can revert).
      if (manifest.cardId || this.bindings.get(id)?.paint) await new Promise((r) => setTimeout(r, this.interactionDelayMs));
      if (file.messageId) {
        await this.resolveLink(channel, file, manifest.chatId);
        await this.save(id, manifest);
        await this.settleLinks(channel, id, manifest, index);
        return;
      }
      // Feishu only deduplicates a reply UUID for one hour. Do not risk sending
      // twice when an old attempt's response was lost; a new card is explicit.
      if (file.sendStartedAt && Date.now() - file.sendStartedAt >= SEND_RETRY_WINDOW_MS) {
        throw new Error('上次发送结果未确认，请先检查会话；需要重新发送时请让 agent 重新引用文件');
      }
      file.needsPaint = true;
      await this.save(id, manifest);
      await this.repaint(channel, id, manifest, index, true);
      const policy = manifest.mode === 'full' && mode === 'full' ? 'full' : 'qa';
      const current = await inspect(file.path, manifest.cwd, policy);
      if (!unchanged(file, current) || current.path !== file.path) throw new Error('本地文件已变化，请让 agent 重新引用后获取');
      if (!file.fileKey) {
        file.fileKey = await uploadFile(channel, file);
        await this.save(id, manifest);
      }
      file.sendStartedAt ??= Date.now();
      file.sendUuid ??= randomUUID();
      await this.save(id, manifest);
      const sent = await timed(channel.rawClient.im.v1.message.reply({
        path: { message_id: manifest.messageId },
        data: { msg_type: 'file', content: JSON.stringify({ file_key: file.fileKey }), reply_in_thread: manifest.replyInThread,
          uuid: file.sendUuid },
      }));
      if (sent?.code || !sent?.data?.message_id) throw new Error('文件发送结果未确认，请稍后重试');
      file.messageId = sent.data.message_id;
      file.messageLink = messageLink(sent.data, manifest.chatId);
      delete file.error;
      // Record delivery BEFORE optional link lookup/card repaint. A repaint or
      // process failure must never turn a successful send into another upload.
      await this.save(id, manifest);
      await this.resolveLink(channel, file, manifest.chatId);
      await this.save(id, manifest);
      await this.settleLinks(channel, id, manifest, index);
      log.info('outbound', 'file-sent', { messageId: manifest.messageId, bytes: file.size });
    } catch (err) {
      log.fail('outbound', err, { phase: 'file-get' });
      const message = manifest ? (authorized ? friendly(err) : '当前无权获取此文件，请由任务发起人或管理员操作') : '文件入口已失效，请让 agent 重新引用文件';
      if (manifest && authorized && file?.occurrences?.length && !file.messageId) {
        file.error = friendly(err);
        file.needsPaint = true;
        // A fresh value also bypasses the SDK's callback deduplication on retry.
        file.revision = randomUUID().slice(0, 8);
        await this.save(id, manifest);
        await this.settleLinks(channel, id, manifest, index);
      }
      await channel.send(evt.chatId, { markdown: `⚠️ ${message}` }, { replyTo: evt.messageId, replyInThread: manifest?.replyInThread }).catch(() => undefined);
    }
  }
}
