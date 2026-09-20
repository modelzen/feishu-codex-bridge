import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { ContextBriefing, briefingThreshold, newMessages, formatMessages } from '../src/bot/context-briefing';
import { OrderedPreparation } from '../src/bot/ordered-preparation';
import type { BriefingModel } from '../src/agent/codex-appserver/briefing-runner';
import { readArchive, mergeHistory, type HistoryMessage, type BriefingHistory } from '../src/bot/briefing-history';

const controllers: ContextBriefing[] = [];
const dirs: string[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(c => c.close())); await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const msg = (id: string, text = '原文', at = 1000): HistoryMessage => ({ messageId: id, chatId: 'chat',
  senderName: '张三', senderId: 'ou_123', senderType: 'user', createTime: at, text, threadId: 'topic' });
const input = (id = 'question', text = '现在怎么样', at = 2000) => ({ messageId: id, chatId: 'chat',
  threadId: 'topic', senderId: 'ou_user', senderName: '李四', content: text, createTime: at }) as NormalizedMessage;
const signal = () => new AbortController().signal;
const output = (id = 'old', lookup: unknown = null) => JSON.stringify({ recentEvents: [{ text: '张三报告完成，尚未核验', messageIds: [id] }],
  relevantBackground: [], usefulMessages: [{ messageId: id, reason: '本次提问涉及此状态' }], missing: ['尚未核验'], lookup });
function setup(messages: HistoryMessage[], options: { timeoutMs?: number; stateFile?: string; enabled?: boolean } = {}) {
  const history = { recent: vi.fn<BriefingHistory['recent']>(async () => ({ messages, gaps: [] })), lookup: vi.fn<BriefingHistory['lookup']>(async () => ({ messages: [], gaps: [] })) };
  const model = { ask: vi.fn<BriefingModel['ask']>(async () => output()), close: vi.fn(async () => undefined) };
  const factory = vi.fn(async () => model);
  const c = new ContextBriefing(history, { enabled: options.enabled, timeoutMs: options.timeoutMs }, options.stateFile, factory);
  controllers.push(c);
  return { c, history, model, factory };
}

describe('conditional context briefing', () => {
  it.each([[799, 10, false], [800, 10, true], [800, 9, false], [1999, 9, false], [2000, 1, true], [2001, 1, true]])(
    '%i characters across %i messages => %s', (chars, count, enabled) => {
      const messages = Array.from({ length: count }, (_, i) => msg(String(i), i ? '字' : '字'.repeat(chars - count + 1)));
      expect(briefingThreshold(messages)).toEqual({ enabled, chars, count });
    });
  it('counts Unicode body characters, not whitespace or identity metadata', () => {
    expect(briefingThreshold([msg('x', '😀 中\n 文\t')])).toEqual({ enabled: false, chars: 3, count: 1 });
  });
  it('sends complete raw text with names and IDs without constructing Luna below threshold', async () => {
    const { c, factory } = setup([msg('old', '完整\n原文，保留换行')]);
    const result = await c.prepare(input(), 'topic', signal());
    expect(factory).not.toHaveBeenCalled();
    expect(result.block).toContain('完整\\n原文，保留换行');
    expect(result.block).toContain('"user_name":"张三"');
    expect(result.block).toContain('"user_id":"ou_123"');
  });
  it('uses Luna only for new content and commits only after acceptance', async () => {
    const { c, factory } = setup([msg('old', '字'.repeat(2000))]);
    const failed = await c.prepare(input(), 'topic', signal());
    failed.receipt.rejected();
    const retry = await c.prepare(input(), 'topic', signal());
    expect(factory).toHaveBeenCalledTimes(2);
    retry.receipt.accepted('topic', 'host');
    const next = await c.prepare(input('next', '好', 3000), 'topic', signal(), { sessionId: 'host' });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(next.block).not.toContain('字'.repeat(30));
  });
  it('includes the current question in the 2000-character threshold', async () => {
    const { c, factory, model } = setup([]);
    model.ask.mockResolvedValue(output('question'));
    await c.prepare(input('question', '字'.repeat(2000)), 'topic', signal());
    expect(factory).toHaveBeenCalledOnce();
  });
  it('counts more than 100 short new messages before selecting the model window', async () => {
    const { c, factory, model } = setup(Array.from({ length: 800 }, (_, i) => msg(`short-${i}`, '字')));
    model.ask.mockResolvedValue(output('question'));
    await c.prepare(input(), 'topic', signal());
    expect(factory).toHaveBeenCalledOnce();
    expect(JSON.parse(model.ask.mock.calls[0]![0]).messages).toHaveLength(100);
  });
  it('does not truncate many short raw messages below the gate', async () => {
    const { c, factory } = setup(Array.from({ length: 200 }, (_, i) => msg(`short-${i}`, '字')));
    const prepared = await c.prepare(input(), 'topic', signal());
    expect(factory).not.toHaveBeenCalled();
    expect(prepared.block).toContain('short-0'); expect(prepared.block).toContain('short-199');
  });
  it('still provides raw history when Luna is explicitly disabled', async () => {
    const { c, factory } = setup([msg('old', '字'.repeat(2000))], { enabled: false });
    const result = await c.prepare(input(), 'topic', signal());
    expect(factory).not.toHaveBeenCalled(); expect(result.block).toContain('字'.repeat(2000));
  });
  it('honors the project switch independently and enables Luna again on the next preparation', async () => {
    const { c, factory } = setup([msg('old', '字'.repeat(2000))]);
    const raw = await c.prepare(input(), 'disabled-project', signal(), undefined, false);
    expect(factory).not.toHaveBeenCalled();
    expect(raw.block).toContain('字'.repeat(2000));
    await c.prepare(input(), 'enabled-project', signal(), undefined, true);
    expect(factory).toHaveBeenCalledOnce();
  });
  it('rejects invented citations and falls back to real raw messages', async () => {
    const { c, model } = setup([msg('old', '字'.repeat(2000))]);
    model.ask.mockResolvedValue(output('invented'));
    const result = await c.prepare(input(), 'topic', signal());
    expect(result.block).not.toContain('invented'); expect(result.block).toContain('新增消息原文');
  });
  it('bounds proactive history expansion to three requests and 200 messages', async () => {
    const { c, model, history } = setup([msg('old', '字'.repeat(2000))]);
    model.ask.mockResolvedValue(output('old', { kind: 'before', beforeMs: 1000, messageId: '', query: '' }));
    history.lookup.mockImplementation(async (_r, _l, limit) => ({ messages: Array.from({ length: limit }, (_, i) => msg(`extra-${i}`, '旧资料', 500)), gaps: [] }));
    await c.prepare(input(), 'topic', signal());
    expect(history.lookup).toHaveBeenCalledTimes(3);
    expect(history.lookup.mock.calls.map(c => c[2])).toEqual([70, 70, 60]);
    expect(model.ask).toHaveBeenCalledTimes(4);
  });
  it('falls back within the deadline when a model never answers', async () => {
    const { c, model } = setup([msg('old', '字'.repeat(2000))], { timeoutMs: 100 });
    model.ask.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    const result = await c.prepare(input(), 'topic', signal());
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.block).toContain('超时'); expect(model.close).toHaveBeenCalledOnce();
  });
  it('does not deliver or checkpoint after cancellation', async () => {
    const { c, model } = setup([msg('old', '字'.repeat(2000))]);
    model.ask.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const job = c.prepare(input(), 'topic', controller.signal);
    await vi.waitFor(() => expect(model.ask).toHaveBeenCalled());
    controller.abort(); await expect(job).rejects.toThrow();
  });
  it('persists checkpoints, isolates roles and resets them for a replacement host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'context-test-')); dirs.push(dir);
    const stateFile = join(dir, 'state.json');
    const first = setup([msg('old', '字'.repeat(2000))], { stateFile });
    (await first.c.prepare(input(), 'topic#admin', signal())).receipt.accepted('topic#admin', 'host');
    await first.c.close();
    const next = setup([msg('old', '字'.repeat(2000))], { stateFile });
    await next.c.prepare(input('next', '继续', 3000), 'topic#admin', signal(), { sessionId: 'host' });
    expect(next.factory).not.toHaveBeenCalled();
    await next.c.prepare(input('guest', '继续', 3000), 'topic#guest', signal(), { sessionId: 'guest' });
    await next.c.prepare(input('new', '继续', 3000), 'topic#admin', signal(), { sessionId: 'replacement' });
    expect(next.factory).toHaveBeenCalledTimes(2);
  });
  it('retains unseen messages sharing the checkpoint timestamp', () => {
    expect(newMessages([msg('a'), msg('b')], { at: 1000, ids: ['a'] }).map(m => m.messageId)).toEqual(['b']);
  });
});

describe('history isolation', () => {
  it('deduplicates and excludes future and foreign-chat messages', () => {
    const result = mergeHistory([msg('a'), msg('a', '新正文'), { ...msg('foreign'), chatId: 'other' }, msg('future', '不应提前看见', 5000)],
      { chatId: 'chat', start: 0, cutoff: 2000 });
    expect(result).toEqual([msg('a', '新正文')]);
  });
  it('reads an existing archive read-only with literal, scoped searches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archive-test-')); dirs.push(dir);
    const file = join(dir, 'db.sqlite3');
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE messages(message_id TEXT,chat_id TEXT,thread_id TEXT,sender_name TEXT,sender_id TEXT,sender_type TEXT,create_ms INTEGER,content TEXT,deleted INTEGER,msg_type TEXT)')
c.executemany('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)',[('a','chat','topic','张三','ou_1','user',1000,'良率 99%',0,'text'),('b','other','other','别人','ou_2','user',1000,'良率 99%',0,'text')])
c.commit()`, file]);
    const result = await readArchive(file, 'python3', { chatId: 'chat', start: 0, cutoff: 2000 },
      { kind: 'search', query: '99%', beforeMs: 0, messageId: '' }, 70, signal());
    expect(result.map(m => m.messageId)).toEqual(['a']);
    expect(formatMessages(result)).toContain('"user_id":"ou_1"');
  });
});

describe('ordered preparation', () => {
  it('waits for acceptance before preparing the next message but permits other topics', async () => {
    const lane = new OrderedPreparation();
    let release!: () => void;
    const accepted = new Promise<void>(r => { release = r; });
    const order: string[] = [];
    lane.submit('a', async () => { order.push('prepare-a'); return 1; }, async () => { await accepted; order.push('accepted-a'); }, e => { throw e; });
    lane.submit('a', async () => { order.push('prepare-b'); return 2; }, async () => {}, e => { throw e; });
    lane.submit('other', async () => { order.push('other'); return 3; }, async () => {}, e => { throw e; });
    await vi.waitFor(() => expect(order).toContain('other'));
    expect(order).not.toContain('prepare-b'); release();
    await vi.waitFor(() => expect(order).toContain('prepare-b'));
    expect(order.indexOf('accepted-a')).toBeLessThan(order.indexOf('prepare-b'));
    lane.close();
  });
  it('never delivers cancelled results into a new generation', async () => {
    const lane = new OrderedPreparation(); let release!: () => void;
    const wait = new Promise<void>(r => { release = r; }); const delivered: string[] = [];
    lane.submit('a', async () => { await wait; return 'old'; }, async x => { delivered.push(x); }, () => {});
    lane.cancel('a');
    lane.submit('a', async () => 'new', async x => { delivered.push(x); }, () => {});
    release(); await vi.waitFor(() => expect(delivered).toEqual(['new'])); lane.close();
  });
});

it('passes the per-project model and Fast override to the briefing runner', async () => {
  const { c, factory } = setup([msg('old', '字'.repeat(2000))], { enabled: false });
  const result = await c.prepare(input(), 'key', signal(), undefined, true, { enabled: true, model: 'gpt-5.6-sol', fast: true });
  expect(factory).toHaveBeenCalledWith('gpt-5.6-sol', expect.any(AbortSignal), true);
  result.receipt.rejected();
});


it('closes a model whose factory resolves after the preparation deadline', async () => {
  const t = setup([msg('old', '字'.repeat(2000))], { timeoutMs: 100 });
  let finish!: (model: typeof t.model) => void;
  t.factory.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = await t.c.prepare(input(), 'topic', signal());
  expect(result.block).toContain('超时');
  expect(t.model.close).not.toHaveBeenCalled();
  finish(t.model);
  await vi.waitFor(() => expect(t.model.close).toHaveBeenCalledTimes(1));
  expect(t.model.ask).not.toHaveBeenCalled();
});
