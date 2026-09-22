import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile, truncate, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OutboundFiles, MAX_FILE_BYTES, type FileContext } from '../src/bot/outbound-files';
import { scanLocalFiles } from '../src/card/file-refs';
import { placeInlineFiles, type InlineFiles } from '../src/card/inline-files';
import { renderRichText } from '../src/card/markdown-render';
import { buildRunCard, buildRunCardPlain } from '../src/card/run-card';
import { initialState } from '../src/card/run-state';
import { CardDispatcher } from '../src/card/dispatcher';

function values(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) node.forEach((n) => values(n, out));
  else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.a === 'file.get') out.push(record);
    Object.values(record).forEach((n) => values(n, out));
  }
  return out;
}

describe('local file reference syntax', () => {
  it('recognizes all three inline filenames including spaces', () => {
    const text = '当前项目目录中有 3 个文件：\n- `含 空格的测试文件.txt`\n- `文件入口测试.md`\n- `文件入口测试.zip`';
    expect(scanLocalFiles(text)).toMatchObject([
      { src: '含 空格的测试文件.txt', label: '含 空格的测试文件.txt' },
      { src: '文件入口测试.md', label: '文件入口测试.md' },
      { src: '文件入口测试.zip', label: '文件入口测试.zip' },
    ]);
  });
  it('accepts links, citations, code paths and bare absolute paths, preserving normal prose', () => {
    const result = scanLocalFiles('已生成 [报告](<输出/测试 报告.xlsx>)。\nCreated :codex-file-citation{path="/tmp/a.md" purpose="output"}\n`data.csv`\n路径：/tmp/b.zip。');
    expect(result.map((r) => r.src)).toEqual(['输出/测试 报告.xlsx', '/tmp/a.md', 'data.csv', '/tmp/b.zip']);
    expect(result[0]!.fallback).toBe('`报告`');
    expect(result[1]!.fallback).toBe('`/tmp/a.md`');
  });

  it('ignores URLs, image refs and fenced/inline code examples', () => {
    const text = '[site](https://example.com/a.md) https://example.com/b.md ![图](/tmp/image.png)\n```md\n[f](/tmp/secret.txt)\n/tmp/example.txt\n```\n`[f](/tmp/inline.md)`';
    expect(scanLocalFiles(text)).toEqual([]);
  });

  it('finds table refs but leaves standalone feishu-card fences to their own renderer', () => {
    const result = scanLocalFiles('| 文件 |\n|---|\n| [a](./a.csv) |\n```feishu-card\n# 文件\n[b](b.md)\n```');
    expect(result.map((r) => r.src)).toEqual(['./a.csv']);
  });
});

describe('click-to-get local files', () => {
  let root: string;
  let cwd: string;
  let dir: string;
  let context: FileContext;
  let service: OutboundFiles;
  const evt = { messageId: 'om_card', chatId: 'oc_chat', operator: { openId: 'ou_owner' } };
  const allow = vi.fn(async () => 'write' as const);
  const upload = vi.fn(async (_: any) => ({ file_key: 'file_key' }));
  const messageLink = 'https://applink.feishu.cn/client/chat/open?openChatId=oc_chat&position=60';
  const reply = vi.fn(async (_: any): Promise<any> => ({ code: 0, data: { message_id: 'om_file', message_app_link: messageLink } }));
  const get = vi.fn(async (_: any): Promise<any> => ({ data: { items: [{ message_id: 'om_file', message_app_link: messageLink }] } }));
  const update = vi.fn(async (_: any) => ({ code: 0 }));
  const send = vi.fn(async (..._: any[]) => ({}));
  const channel = { rawClient: { im: { v1: { file: { create: upload }, message: { reply, get } } }, cardkit: { v1: { cardElement: { update } } } }, send } as never;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-files-')));
    cwd = join(root, 'project');
    dir = join(root, 'state');
    await mkdir(cwd);
    context = { ...evt, cwd, mode: 'write', requesterOpenId: 'ou_owner', replyInThread: true };
    service = new OutboundFiles(dir, 0);
    await writeFile(join(cwd, '测试 报告.xlsx'), 'spreadsheet bytes');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const prepare = async (): Promise<InlineFiles> =>
    service.prepare('已生成 [报告](<测试 报告.xlsx>)', context);

  it('prepares metadata and renders a link without uploading; click works after restart', async () => {
    const prepared = await prepare();
    expect(upload).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    const payload = values(prepared.links)[0]!;
    expect(JSON.stringify(payload)).not.toContain(cwd);
    await new OutboundFiles(dir).deliver(channel, evt, payload, allow);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0].data).toMatchObject({ file_name: '测试 报告.xlsx', file_type: 'xls', file: Buffer.from('spreadsheet bytes') });
    expect(reply.mock.calls[0]![0]).toMatchObject({ path: { message_id: 'om_card' }, data: { msg_type: 'file', reply_in_thread: true, content: '{"file_key":"file_key"}' } });
  });

  it('keeps links on table answers and demoted older run cards', async () => {
    const raw = '| 文件 |\n|---|\n| [报告](<测试 报告.xlsx>) |';
    const localFiles = await service.prepare(raw, context);
    const rc = { rs: { ...initialState, terminal: 'done' as const, blocks: [{ kind: 'text' as const, id: 'a', content: raw, streaming: false }] }, localFiles };
    expect(values(buildRunCard(rc))).toHaveLength(1);
    expect(values(buildRunCardPlain(rc))).toHaveLength(1);
    expect(JSON.stringify(buildRunCard(rc))).toContain('报告');
  });

  it('preserves the answer without dead interactions when delivery state cannot be saved', async () => {
    await writeFile(dir, 'not a directory');
    const text = '已生成 [报告](<测试 报告.xlsx>)';
    expect(await service.prepare(text, context)).toEqual({ text, links: [] });
    expect(upload).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('rejects obsolete delivery entries without inline occurrences', async () => {
    const payload = values((await prepare()).links)[0]!;
    const path = join(dir, (await readdir(dir))[0]!);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    delete manifest.files[0].occurrences;
    await writeFile(path, JSON.stringify(manifest));
    await new OutboundFiles(dir, 0).deliver(channel, evt, payload, allow);
    expect(upload).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(send.mock.calls.at(-1)![1].markdown).toContain('入口已失效');
  });

  it('replaces file references at their original positions without a footer or duplicate labels', async () => {
    await writeFile(join(cwd, 'second.txt'), 'second file');
    const raw = '介绍段落。\n\n- [报告](<测试 报告.xlsx>)：查看报告。\n- `second.txt`：查看文本。\n\n结束段落。';
    const localFiles = await service.prepare(raw, context);
    const rc = { rs: { ...initialState, terminal: 'done' as const, blocks: [{ kind: 'text' as const, id: 'a', content: raw, streaming: false }] }, localFiles };
    const result = JSON.stringify(buildRunCard(rc));
    expect(result).not.toContain('BRIDGEFILE');
    expect(result).not.toContain('grey-50');
    expect(result).not.toContain('获取并查看');
    expect(result.match(/<font color='blue'>报告<\/font>/g)).toHaveLength(1);
    const ordered = ['介绍段落', "<font color='blue'>报告", '：查看报告', "<font color='blue'>second.txt", '：查看文本', '结束段落'];
    expect(ordered.map((label) => result.indexOf(label))).toEqual(ordered.map((label) => result.indexOf(label)).sort((a, b) => a - b));
    expect(values(buildRunCard(rc))).toHaveLength(2);
  });

  it('updates every inline alias after sending and after a restart, without sending twice', async () => {
    context.cardId = 'card_1';
    const painted: string[] = [];
    const prepared = await service.prepare('[首处](<测试 报告.xlsx>) 以及 `测试 报告.xlsx`', context, async (id) => { painted.push(id); return true; });
    const payloads = values(prepared.links);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]!.i).toBe(payloads[1]!.i);
    await service.deliver(channel, evt, payloads[0]!, allow);
    expect(painted).toEqual(['local_file_0', 'local_file_1', 'local_file_0', 'local_file_1']);
    expect(values(prepared.links)).toHaveLength(0);
    for (const { element } of prepared.links) expect(element).toMatchObject({ behaviors: [{ type: 'open_url', default_url: messageLink }] });
    await new OutboundFiles(dir, 0).deliver(channel, evt, payloads[1]!, allow);
    expect(update.mock.calls.map(([request]) => request.path.element_id)).toEqual(['local_file_0', 'local_file_1']);
    expect(upload).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('keeps bare absolute paths and citations in source order with their full visible path', async () => {
    const path = join(cwd, 'second.txt');
    await writeFile(path, 'second file');
    const raw = `首先 ${path}，然后 :codex-file-citation{path="${path}" purpose="output"}，最后 [报告](<测试 报告.xlsx>)。`;
    const prepared = await service.prepare(raw, context);
    expect(values(prepared.links).map((v) => v.i)).toEqual([0, 0, 1]);
    const rendered = JSON.stringify(placeInlineFiles(renderRichText(prepared.text), prepared));
    expect(rendered).not.toContain('BRIDGEFILE');
    expect(rendered).not.toContain('codex-file-citation');
    expect(rendered.match(/<font color='blue'>/g)).toHaveLength(3);
    // A visible Windows separator must be escaped in Markdown, then again in JSON.
    const markdownPath = path.replace(/\\/g, '\\\\').replace(/_/g, '\\_');
    expect(rendered).toContain(JSON.stringify(markdownPath).slice(1, -1));
  });

  it('limits interactive occurrences without dropping the remaining text or creating orphan fence callbacks', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `[第${i}处](<测试 报告.xlsx>)`).join('\n');
    const prepared = await service.prepare(text, context);
    expect(prepared.links).toHaveLength(10);
    const rendered = JSON.stringify(placeInlineFiles(renderRichText(prepared.text), prepared));
    expect(rendered).toContain('第11处');
    expect(rendered).not.toContain('BRIDGEFILE');
    const fence = await service.prepare('```feishu-card\n[报告](<测试 报告.xlsx>)\n```', { ...context, messageId: 'om_fence' });
    expect(fence.links).toEqual([]);
    expect(fence.text).not.toContain('BRIDGEFILE');
  });

  it('keeps a large table readable instead of exceeding the card component limit', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => `| ${i === 0 ? '[报告](<测试 报告.xlsx>)' : `第${i}行`} | 数据 |`);
    const raw = '| 文件 | 说明 |\n|---|---|\n' + rows.join('\n');
    const prepared = await service.prepare(raw, context);
    expect(prepared.links).toEqual([]);
    expect(prepared.text).toContain('第99行');
    expect(prepared.text).toContain('`报告`');
    expect(prepared.text).not.toContain('BRIDGEFILE');
  });

  it('uses flat replies in single-session groups and deduplicates repeated clicks', async () => {
    context.replyInThread = false;
    const payload = values((await prepare()).links)[0]!;
    await Promise.all([service.deliver(channel, evt, payload, allow), service.deliver(channel, evt, payload, allow)]);
    await service.deliver(channel, evt, payload, allow);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0].data.reply_in_thread).toBe(false);
  });

  it('rejects forged IDs, forwarded cards, wrong chats and revoked access before upload', async () => {
    const payload = values((await prepare()).links)[0]!;
    await service.deliver(channel, evt, { ...payload, id: '../../config' }, allow);
    await service.deliver(channel, { ...evt, chatId: 'other' }, payload, allow);
    await service.deliver(channel, { ...evt, messageId: 'forwarded' }, payload, allow);
    await service.deliver(channel, evt, payload, async () => undefined);
    expect(upload).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(evt.chatId, expect.objectContaining({ markdown: expect.stringContaining('无权') }), expect.anything());
  });

  it('does not follow a symlink outside the workspace; full mode still allows an explicit outside file', async () => {
    const outside = join(root, 'private.txt');
    await writeFile(outside, 'private');
    await symlink(outside, join(cwd, 'link.txt'));
    expect(values((await service.prepare('[file](link.txt)', context)).links)).toHaveLength(0);
    expect(values((await service.prepare(`[file](${outside})`, { ...context, mode: 'full' })).links)).toHaveLength(1);
    const payload = values((await service.prepare(`[file](${outside})`, { ...context, mode: 'full' })).links)[0]!;
    await service.deliver(channel, evt, payload, allow); // permissions narrowed since creation
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a replaced, deleted, or changed file with visible feedback', async () => {
    const payload = values((await prepare()).links)[0]!;
    await writeFile(join(cwd, '测试 报告.xlsx'), 'different bytes');
    await service.deliver(channel, evt, payload, allow);
    expect(send.mock.calls.at(-1)![1].markdown).toContain('已变化');
    await unlink(join(cwd, '测试 报告.xlsx'));
    await service.deliver(channel, evt, payload, allow);
    expect(send.mock.calls.at(-1)![1].markdown).toContain('已不存在');
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a file swapped to a symlink after the card was created', async () => {
    const payload = values((await prepare()).links)[0]!;
    const outside = join(root, 'secret.xlsx');
    await writeFile(outside, 'secret');
    await unlink(join(cwd, '测试 报告.xlsx'));
    await symlink(outside, join(cwd, '测试 报告.xlsx'));
    await service.deliver(channel, evt, payload, allow);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects empty/oversized/missing files and directories without reading/uploading them', async () => {
    await writeFile(join(cwd, 'empty.txt'), '');
    await writeFile(join(cwd, 'big.zip'), 'x');
    await truncate(join(cwd, 'big.zip'), MAX_FILE_BYTES + 1);
    const result = await service.prepare('[empty](empty.txt) [big](big.zip) [dir](.) [missing](missing.md)', context);
    expect(values(result.links)).toHaveLength(0);
    expect(result.links).toEqual([]);
    expect(result.text).toBe('`empty` `big` `dir` `missing`');
    expect(upload).not.toHaveBeenCalled();
  });

  it('handles file URLs, percent encoding and source line anchors, deduplicating aliases', async () => {
    const uri = pathToFileURL(join(cwd, '测试 报告.xlsx')).href;
    const result = await service.prepare(`[a](${uri}) [b](测试%20报告.xlsx:12) [c](测试%20报告.xlsx#L3)`, context);
    expect(values(result.links)).toHaveLength(3);
    expect(new Set(values(result.links).map((v) => v.i))).toEqual(new Set([0]));
    await Promise.all(values(result.links).map((payload) => service.deliver(channel, evt, payload, allow)));
    expect(upload).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('reports upload failure and permits retry; never sends a file message on failed upload', async () => {
    const payload = values((await prepare()).links)[0]!;
    upload.mockRejectedValueOnce(new Error('network error'));
    await service.deliver(channel, evt, payload, allow);
    expect(reply).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
    await service.deliver(channel, evt, payload, allow);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('acknowledges callbacks without waiting for an upload', async () => {
    const payload = values((await prepare()).links)[0]!;
    const dispatcher = new CardDispatcher(channel, {} as never);
    let finish!: () => void;
    const held = new Promise<void>((r) => { finish = r; });
    const deliver = vi.spyOn(service, 'deliver').mockImplementation(async () => held);
    service.register(dispatcher, allow);
    await dispatcher.handle({ ...evt, action: { value: payload } } as never);
    expect(deliver).toHaveBeenCalledOnce();
    finish();
  });

  it('makes the entire file component clickable with no buttons, then reopens the sent attachment without resending', async () => {
    const painted: string[] = [];
    const prepared = await service.prepare('[报告](<测试 报告.xlsx>)', context, async (_, row) => {
      painted.push(JSON.stringify(row)); return true;
    });
    expect(JSON.stringify(prepared.links)).toContain("<font color='blue'>报告</font>");
    expect(prepared.links[0]!.element).toMatchObject({ background_style: 'default', has_border: false, padding: '0px' });
    expect(prepared.links[0]!.element).toMatchObject({ tag: 'interactive_container', behaviors: [{ type: 'callback' }] });
    expect(JSON.stringify(prepared)).not.toContain('"tag":"button"');
    expect(prepared.links).toHaveLength(1);
    const payload = values(prepared.links)[0]!;
    await service.deliver(channel, evt, payload, allow);
    expect(painted[0]).toContain('正在发送');
    expect(painted[0]).toContain('"disabled":true');
    expect(painted.at(-1)).toContain(messageLink);
    expect(painted.at(-1)).toContain('查看附件消息');
    expect(painted.at(-1)).not.toContain('"tag":"button"');
    expect(prepared.links[0]!.element).toMatchObject({ behaviors: [{ type: 'open_url', default_url: messageLink }] });
    expect(values(prepared.links)).toEqual([]);
    await new OutboundFiles(dir, 0).deliver(channel, evt, payload, allow);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    const again = await service.prepare('[报告](<测试 报告.xlsx>)', context);
    expect(JSON.stringify(again)).toContain(messageLink);
  });

  it('changes the callback revision on failure so the SDK accepts a real retry', async () => {
    const prepared = await service.prepare('[报告](<测试 报告.xlsx>)', context, async () => true);
    const original = values(prepared.links)[0]!;
    upload.mockRejectedValueOnce(new Error('network unavailable'));
    await service.deliver(channel, evt, original, allow);
    const retry = values(prepared.links)[0]!;
    expect(JSON.stringify(prepared)).toContain('点击重试');
    expect(retry.r).not.toEqual(original.r);
    expect(JSON.stringify(retry).slice(0, 128)).not.toEqual(JSON.stringify(original).slice(0, 128));
    await service.deliver(channel, evt, retry, allow);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('reuses the uploaded file and persisted reply UUID when a send response is lost', async () => {
    const payload = values((await prepare()).links)[0]!;
    reply.mockRejectedValueOnce(new Error('connection reset after sending'));
    await service.deliver(channel, evt, payload, allow);
    await new OutboundFiles(dir, 0).deliver(channel, evt, payload, allow);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[0]![0].data.uuid).toBe(reply.mock.calls[1]![0].data.uuid);
  });

  it('serializes different files in one card without losing either delivery record', async () => {
    await writeFile(join(cwd, 'second.txt'), 'second file');
    const payloads = values((await service.prepare('[a](<测试 报告.xlsx>) [b](second.txt)', context)).links);
    await Promise.all(payloads.map((payload) => service.deliver(channel, evt, payload, allow)));
    expect(upload).toHaveBeenCalledTimes(2);
    const manifest = JSON.parse(await readFile(join(dir, (await readdir(dir))[0]!), 'utf8'));
    expect(manifest.files.map((f: any) => f.messageId)).toEqual(['om_file', 'om_file']);
    expect(reply.mock.calls[0]![0].data.uuid).not.toBe(reply.mock.calls[1]![0].data.uuid);
  });

  it('repairs an interrupted disabled link at startup without uploading or sending', async () => {
    context.cardId = 'card_1';
    await prepare();
    const path = join(dir, (await readdir(dir))[0]!);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.files[0].needsPaint = true;
    manifest.files[0].sendStartedAt = Date.now();
    await writeFile(path, JSON.stringify(manifest));
    await new OutboundFiles(dir, 0).recover(channel);
    expect(upload).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0].data.element).toContain('点击重试');
    expect(JSON.parse(await readFile(path, 'utf8')).files[0].needsPaint).toBeUndefined();
  });

  it('refuses an ambiguous resend outside the Feishu UUID deduplication window', async () => {
    const payload = values((await prepare()).links)[0]!;
    const path = join(dir, (await readdir(dir))[0]!);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.files[0].sendStartedAt = Date.now() - 60 * 60_000;
    manifest.files[0].fileKey = 'already_uploaded';
    await writeFile(path, JSON.stringify(manifest));
    await service.deliver(channel, evt, payload, allow);
    expect(upload).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(send.mock.calls.at(-1)![1].markdown).toContain('上次发送结果未确认');
  });

  it('looks up the message link when reply omitted it, and only shows success with a message ID', async () => {
    const payload = values((await prepare()).links)[0]!;
    reply.mockResolvedValueOnce({ code: 0 });
    await service.deliver(channel, evt, payload, allow);
    expect(send.mock.calls.at(-1)![1].markdown).toContain('未确认');
    reply.mockResolvedValueOnce({ code: 0, data: { message_id: 'om_file' } });
    await service.deliver(channel, evt, payload, allow);
    expect(get).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('derives the attachment link from raw IM message_position', async () => {
    const prepared = await prepare();
    const payload = values(prepared.links)[0]!;
    reply.mockResolvedValueOnce({ code: 0, data: { message_id: 'om_file' } });
    get.mockResolvedValueOnce({ data: { items: [{ message_id: 'om_file', chat_id: 'oc_chat', message_position: '15' }] } });
    await service.deliver(channel, evt, payload, allow);
    expect(prepared.links[0]!.element).toMatchObject({
      tag: 'interactive_container', behaviors: [{ type: 'open_url', default_url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_chat&position=15' }],
    });
    await new OutboundFiles(dir, 0).deliver(channel, evt, payload, allow);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('prepares and sends a relative filename with spaces without a separate button', async () => {
    await writeFile(join(cwd, '含 空格的测试文件.txt'), 'the original contents');
    const prepared = await service.prepare('文件：`含 空格的测试文件.txt`', context);
    expect(prepared.links).toHaveLength(1);
    expect(prepared.links[0]!.element?.tag).toBe('interactive_container');
    await service.deliver(channel, evt, values(prepared.links)[0]!, allow);
    expect(upload.mock.calls[0]![0].data).toMatchObject({ file_name: '含 空格的测试文件.txt', file: Buffer.from('the original contents') });
  });
});
