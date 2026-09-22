import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { actions, button, card, md, type CardObject } from '../card/cards';
import type { CardActionContext, CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { buildProcessPages } from '../card/run-process';
import type { Block } from '../card/run-state';
import { log } from '../core/logger';

export interface ProcessHistoryContext {
  messageId: string;
  chatId: string;
  cwd: string;
  requesterOpenId?: string;
  replyInThread: boolean;
}

interface HistoryRecord {
  version: 1;
  context: ProcessHistoryContext;
  blocks: Block[];
}

interface LiveRecord {
  snapshot: HistoryRecord;
  revision: number;
  savedRevision: number;
  writing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

const HISTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function copyBlocks(blocks: readonly Block[]): Block[] {
  return blocks.map(block => block.kind === 'tool' ? { ...block, tool: { ...block.tool } } : { ...block });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBlock(value: unknown): Block {
  if (!object(value)) throw new Error('Invalid process block');
  if ((value.kind === 'text' || value.kind === 'reasoning') && typeof value.id === 'string'
    && typeof value.content === 'string' && typeof value.streaming === 'boolean') {
    return { kind: value.kind, id: value.id, content: value.content, streaming: value.streaming };
  }
  const tool = value.tool;
  if (value.kind !== 'tool' || !object(tool) || typeof tool.id !== 'string' || typeof tool.title !== 'string'
    || !['running', 'done', 'error'].includes(String(tool.status))
    || (tool.detail !== undefined && typeof tool.detail !== 'string')
    || (tool.output !== undefined && typeof tool.output !== 'string')
    || (tool.kind !== undefined && !['command', 'file', 'search', 'tool'].includes(String(tool.kind)))
    || (tool.exitCode !== undefined && tool.exitCode !== null && !Number.isInteger(tool.exitCode))) {
    throw new Error('Invalid process tool');
  }
  return { kind: 'tool', tool: {
    id: tool.id, title: tool.title,
    status: tool.status as 'running' | 'done' | 'error',
    detail: tool.detail as string | undefined,
    output: tool.output as string | undefined,
    kind: tool.kind as 'command' | 'file' | 'search' | 'tool' | undefined,
    exitCode: tool.exitCode as number | null | undefined,
  } };
}

function parseRecord(value: unknown): HistoryRecord {
  if (!object(value) || value.version !== 1 || !object(value.context) || !Array.isArray(value.blocks)) {
    throw new Error('Invalid process history');
  }
  const context = value.context;
  if (typeof context.messageId !== 'string' || !context.messageId || typeof context.chatId !== 'string'
    || !context.chatId || typeof context.cwd !== 'string' || typeof context.replyInThread !== 'boolean'
    || (context.requesterOpenId !== undefined && typeof context.requesterOpenId !== 'string')) {
    throw new Error('Invalid process context');
  }
  return { version: 1, context: {
    messageId: context.messageId, chatId: context.chatId, cwd: context.cwd,
    replyInThread: context.replyInThread, requesterOpenId: context.requesterOpenId,
  }, blocks: value.blocks.map(parseBlock) };
}

function viewer(id: string, record: HistoryRecord, requestedPage: number): CardObject {
  const pages = buildProcessPages(record.blocks);
  const page = Math.max(0, Math.min(requestedPage, pages.length - 1));
  const pageCount = Math.max(1, pages.length);
  const navigation = [];
  if (page > 0) navigation.push(button('上一页', { a: 'run.process.page', h: id, p: page - 1 }));
  navigation.push(button('刷新', { a: 'run.process.page', h: id, p: page }));
  if (page + 1 < pageCount) navigation.push(button('下一页', { a: 'run.process.page', h: id, p: page + 1 }));
  return card([
    md(`执行过程 · 第 ${String(page + 1)} / ${String(pageCount)} 页`),
    ...(pages[page]?.length ? pages[page]! : [md('暂无操作记录。')]),
    actions(navigation),
  ], { summary: '完整执行过程', forward: false });
}

export class ProcessHistory {
  private readonly live = new Map<string, LiveRecord>();
  private readonly clicks = new Map<string, Promise<void>>();

  constructor(private readonly directory: string) {}

  create(context: ProcessHistoryContext, blocks: readonly Block[]): string {
    const id = randomUUID();
    this.live.set(id, {
      snapshot: { version: 1, context: { ...context }, blocks: copyBlocks(blocks) },
      revision: 1, savedRevision: 0,
    });
    this.schedule(id);
    return id;
  }

  update(id: string, blocks: readonly Block[]): void {
    const entry = this.live.get(id);
    if (!entry) return;
    entry.snapshot = { ...entry.snapshot, blocks: copyBlocks(blocks) };
    entry.revision += 1;
    this.schedule(id);
  }

  private schedule(id: string): void {
    const entry = this.live.get(id);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flush(id).catch(error => log.fail('process-history', error, { phase: 'save', id }));
    }, 250);
    entry.timer.unref();
  }

  async flush(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (entry.writing) {
      await entry.writing;
      return this.flush(id);
    }
    const write = async (): Promise<void> => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      while (entry.savedRevision < entry.revision) {
        const revision = entry.revision;
        const serialized = JSON.stringify(entry.snapshot);
        const target = join(this.directory, `${id}.json`);
        const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
          await rename(temporary, target);
          entry.savedRevision = revision;
        } finally {
          await rm(temporary, { force: true });
        }
      }
    };
    entry.writing = write();
    try { await entry.writing; } finally { entry.writing = undefined; }
  }

  async release(id: string): Promise<void> {
    await this.flush(id);
    this.live.delete(id);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map(id => this.release(id)));
  }

  private async load(id: string): Promise<HistoryRecord> {
    if (!HISTORY_ID.test(id)) throw new Error('Invalid process history ID');
    const live = this.live.get(id);
    if (live) return live.snapshot;
    const value: unknown = JSON.parse(await readFile(join(this.directory, `${id}.json`), 'utf8'));
    return parseRecord(value);
  }

  register(dispatcher: CardDispatcher, authorize: (context: ProcessHistoryContext, openId: string) => Promise<boolean>): void {
    const enqueue = (ctx: CardActionContext): void => {
      const previous = this.clicks.get(ctx.evt.messageId) ?? Promise.resolve();
      const task = previous.then(async () => {
        await new Promise(resolve => setTimeout(resolve, 500));
        await this.show(ctx, authorize);
      }).catch(error => log.fail('process-history', error, { phase: 'callback' }));
      this.clicks.set(ctx.evt.messageId, task);
      void task.finally(() => {
        if (this.clicks.get(ctx.evt.messageId) === task) this.clicks.delete(ctx.evt.messageId);
      });
    };
    dispatcher.on('run.process.open', enqueue);
    dispatcher.on('run.process.page', enqueue);
  }

  private async show(ctx: CardActionContext, authorize: (context: ProcessHistoryContext, openId: string) => Promise<boolean>): Promise<void> {
    const id = ctx.value.h;
    if (typeof id !== 'string' || !HISTORY_ID.test(id)) return;
    const warn = (message: string) => ctx.channel.send(ctx.evt.chatId, { markdown: message }, { replyTo: ctx.evt.messageId });
    let record: HistoryRecord;
    try { record = await this.load(id); } catch (error) {
      log.fail('process-history', error, { phase: 'load', id });
      await warn('执行过程暂时无法读取，请稍后重试。');
      return;
    }
    if (ctx.evt.chatId !== record.context.chatId
      || (ctx.actionId === 'run.process.open' && ctx.evt.messageId !== record.context.messageId)) return;
    if (!await authorize(record.context, ctx.evt.operator.openId)) {
      await warn('你没有查看此执行过程的权限。');
      return;
    }
    const requestedPage = typeof ctx.value.p === 'number' && Number.isSafeInteger(ctx.value.p) ? ctx.value.p : 0;
    try {
      const output = viewer(id, record, requestedPage);
      if (ctx.actionId === 'run.process.page' && await updateManagedCard(ctx.channel, ctx.evt.messageId, output)) return;
      await sendManagedCard(ctx.channel, record.context.chatId, output, record.context.messageId, record.context.replyInThread);
    } catch (error) {
      log.fail('process-history', error, { phase: 'show', id });
      await warn('执行过程卡片暂时无法显示，请稍后重试。');
    }
  }
}
