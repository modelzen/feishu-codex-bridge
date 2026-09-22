import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardActionEvent, LarkChannel } from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessHistory } from '../src/bot/process-history';
import { CardDispatcher } from '../src/card/dispatcher';
import type { AppConfig } from '../src/config/schema';
import type { Block } from '../src/card/run-state';

const managed = vi.hoisted(() => ({
  send: vi.fn(async (..._args: unknown[]) => ({ messageId: 'viewer', cardId: 'card' })),
  update: vi.fn(async (..._args: unknown[]) => true),
}));
vi.mock('../src/card/managed', () => ({ sendManagedCard: managed.send, updateManagedCard: managed.update }));

const context = { messageId: 'source', chatId: 'chat', cwd: '/repo', requesterOpenId: 'owner', replyInThread: true };
const tool = (id: number, command = `printf 'operation ${id}'`): Block => ({
  kind: 'tool', tool: { id: String(id), title: command, kind: 'command', status: 'done', output: `result ${id}` },
});

let directory: string;
let stores: ProcessHistory[];
const store = () => {
  const history = new ProcessHistory(directory);
  stores.push(history);
  return history;
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'process-history-'));
  stores = [];
  vi.clearAllMocks();
  managed.update.mockResolvedValue(true);
});
afterEach(async () => {
  for (const history of stores) await history.shutdown();
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

function harness(history: ProcessHistory) {
  const send = vi.fn(async () => ({}));
  const channel = { send } as unknown as LarkChannel;
  const authorize = vi.fn(async (_context, openId: string) => openId === 'owner');
  const dispatcher = new CardDispatcher(channel, {} as AppConfig);
  history.register(dispatcher, authorize);
  const click = async (id: string, options: { page?: number; messageId?: string; chatId?: string; openId?: string; action?: string } = {}) => {
    const evt: CardActionEvent = {
      messageId: options.messageId ?? 'source', chatId: options.chatId ?? 'chat',
      operator: { openId: options.openId ?? 'owner' },
      action: { tag: 'button', value: { a: options.action ?? 'run.process.open', h: id, p: options.page ?? 0 } },
    };
    await dispatcher.handle(evt);
    await vi.advanceTimersByTimeAsync(501);
  };
  return { click, send, authorize, dispatcher };
}

describe('durable process history', () => {
  it('coalesces updates, clones snapshots, writes private atomic files and releases to disk', async () => {
    const history = store();
    const blocks = [tool(0)];
    const id = history.create(context, blocks);
    blocks.push(tool(99));
    await history.flush(id);
    expect(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).blocks).toEqual([tool(0)]);
    for (let index = 1; index < 40; index++) history.update(id, [tool(index)]);
    await history.release(id);
    const disk = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
    expect(disk.blocks).toEqual([tool(39)]);
    expect(await readdir(directory)).toEqual([`${id}.json`]);
    if (process.platform !== 'win32') expect((await stat(join(directory, `${id}.json`))).mode & 0o777).toBe(0o600);
    history.update(id, [tool(100)]);
    await history.release(id);
    expect(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).blocks).toEqual([tool(39)]);
  });

  it('persists the latest revision when updates arrive during a pending write', async () => {
    const history = store();
    const id = history.create(context, [tool(1)]);
    const first = history.flush(id);
    history.update(id, [tool(2)]);
    const second = history.flush(id);
    history.update(id, [tool(3)]);
    await Promise.all([first, second, history.release(id)]);
    expect(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).blocks).toEqual([tool(3)]);
  });

  it('reads terminal history after restart and sends a new viewer under the original card', async () => {
    const history = store();
    const id = history.create(context, [tool(1)]);
    await history.release(id);
    vi.useFakeTimers();
    const { click } = harness(store());
    managed.update.mockResolvedValue(false);
    await click(id, { action: 'run.process.page', messageId: 'old-viewer' });
    await vi.waitFor(() => expect(managed.send).toHaveBeenCalledTimes(1));
    expect(managed.send.mock.calls[0]?.slice(1)).toEqual([
      'chat', expect.objectContaining({ schema: '2.0' }), 'source', true,
    ]);
    expect(JSON.stringify(managed.send.mock.calls)).toContain('operation 1');
  });

  it('acks before work, paginates all commands, handles repeated navigation and refreshes latest state', async () => {
    const history = store();
    const blocks = Array.from({ length: 70 }, (_, index) => tool(index, `printf '${index}:${'x'.repeat(1500)}'`));
    const id = history.create(context, blocks);
    vi.useFakeTimers();
    const { click } = harness(history);
    await click(id);
    expect(managed.send).toHaveBeenCalledTimes(1);
    const first = managed.send.mock.calls[0]?.[2];
    const firstJson = JSON.stringify(first);
    const count = Number(firstJson.match(/第 1 \/ (\d+) 页/)?.[1]);
    expect(count).toBeGreaterThan(1);
    const rendered = [firstJson];
    for (let page = 1; page < count; page++) {
      await click(id, { action: 'run.process.page', messageId: 'viewer', page });
      rendered.push(JSON.stringify(managed.update.mock.calls.at(-1)?.[2]));
    }
    for (let index = 0; index < 70; index++) expect(rendered.join('')).toContain(`printf '${index}:`);
    await click(id, { action: 'run.process.page', messageId: 'viewer', page: 0 });
    await click(id, { action: 'run.process.page', messageId: 'viewer', page: 1 });
    expect(managed.update).toHaveBeenCalledTimes(count + 1);
    history.update(id, [tool(80, 'echo latest')]);
    await click(id, { action: 'run.process.page', messageId: 'viewer', page: 0 });
    expect(JSON.stringify(managed.update.mock.calls.at(-1))).toContain('echo latest');
  });

  it('rejects wrong chat, wrong source message, unauthorized users and traversal IDs', async () => {
    const history = store();
    const id = history.create(context, [tool(1)]);
    vi.useFakeTimers();
    const { click, send, authorize } = harness(history);
    await click(id, { chatId: 'other' });
    await click(id, { messageId: 'other' });
    await click('../../secrets');
    expect(authorize).not.toHaveBeenCalled();
    await click(id, { openId: 'stranger' });
    expect(send).toHaveBeenCalledWith('chat', { markdown: '你没有查看此执行过程的权限。' }, { replyTo: 'source' });
    expect(managed.send).not.toHaveBeenCalled();
    expect(managed.update).not.toHaveBeenCalled();
  });

  it('validates disk payloads and gives a useful read failure without leaking content', async () => {
    const history = store();
    const id = history.create(context, []);
    await history.release(id);
    await writeFile(join(directory, `${id}.json`), JSON.stringify({ version: 1, context, blocks: [{ kind: 'tool', tool: { title: 'SECRET' } }] }));
    vi.useFakeTimers();
    const { click, send } = harness(store());
    await click(id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(send.mock.calls)).not.toContain('SECRET');
    expect(managed.send).not.toHaveBeenCalled();
  });

  it('serializes rapid viewer clicks while an earlier update is still in flight', async () => {
    const history = store();
    const id = history.create(context, [tool(1)]);
    vi.useFakeTimers();
    const { dispatcher } = harness(history);
    let complete: (value: boolean) => void = () => undefined;
    managed.update.mockImplementationOnce(() => new Promise<boolean>(resolve => { complete = resolve; }));
    const event: CardActionEvent = {
      messageId: 'viewer', chatId: 'chat', operator: { openId: 'owner' },
      action: { tag: 'button', value: { a: 'run.process.page', h: id, p: 0 } },
    };
    await dispatcher.handle(event);
    expect(managed.update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(501);
    expect(managed.update).toHaveBeenCalledTimes(1);
    await dispatcher.handle(event);
    await vi.advanceTimersByTimeAsync(1000);
    expect(managed.update).toHaveBeenCalledTimes(1);
    complete(true);
    await vi.advanceTimersByTimeAsync(501);
    expect(managed.update).toHaveBeenCalledTimes(2);
  });

  it('retains live history if persistence fails so a later flush can recover', async () => {
    const obstructed = join(directory, 'blocked');
    await writeFile(obstructed, 'not a directory');
    const history = new ProcessHistory(obstructed);
    stores.push(history);
    const id = history.create(context, [tool(1)]);
    await expect(history.release(id)).rejects.toThrow();
    history.update(id, [tool(2)]);
    await rm(obstructed);
    await history.release(id);
    expect(JSON.parse(await readFile(join(obstructed, `${id}.json`), 'utf8')).blocks).toEqual([tool(2)]);
  });

  it('flushes all active histories on shutdown', async () => {
    const history = store();
    const ids = [history.create(context, [tool(1)]), history.create(context, [tool(2)])];
    await history.shutdown();
    expect((await readdir(directory)).sort()).toEqual(ids.map(id => `${id}.json`).sort());
  });

  it('renders one informative page for empty history', async () => {
    const history = store();
    const id = history.create(context, []);
    vi.useFakeTimers();
    const { click } = harness(history);
    await click(id);
    expect(JSON.stringify(managed.send.mock.calls)).toContain('第 1 / 1 页');
    expect(JSON.stringify(managed.send.mock.calls)).toContain('暂无操作记录');
  });
});
