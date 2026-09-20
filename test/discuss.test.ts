import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { Discuss, LUNA_PROMPT, parseJudgment, readScopedFile, type DiscussSnapshot } from '../src/bot/discuss';

let dir: string;
let workers: Discuss[];
const snap: DiscussSnapshot = { enabled: true, hostId: 'host', model: 'main-model', effort: 'high', cwd: '/project', busy: false, goal: false, signature: 'v1' };
const msg = (id: string): NormalizedMessage => ({ messageId: id, chatId: 'chat', chatType: 'group', senderId: 'u', senderName: 'User', mentionedBot: false,
  mentionAll: false, mentions: [], content: id, createTime: Date.now(), resources: [], rawContentType: 'text' });
const emptySummary = { topics: [], requests: [], constraints: [], decisions: [], results: [], uncertain: [] };
const history = { recent: vi.fn(async () => ({ messages: [], gaps: [] })), lookup: vi.fn(async () => ({ messages: [], gaps: [] })) };
const source = vi.fn(async () => ({ path: '/rollout' }));
function setup(action = 'FOLLOW_UP', snapshot = { ...snap }, extra: { judge?: (input: string) => Promise<string>; luna?: () => Promise<string> } = {}) {
  const asks: { model: string; effort: string; inputs: string[]; close: ReturnType<typeof vi.fn> }[] = [];
  const delivered: string[][] = [];
  const hooks = { snapshot: vi.fn(async () => snapshot), reconcile: vi.fn(async () => false),
    deliver: vi.fn(async (_key: string, messages: NormalizedMessage[], _action: unknown, _snap: unknown, context: { receipt: { accepted(): void } }) => {
      delivered.push(messages.map(m => m.messageId)); context.receipt.accepted(); return true;
    }) };
  const factory = vi.fn(async (opts: { model: string; effort: string; instructions?: string }) => {
    const log = { ...opts, inputs: [] as string[], close: vi.fn(async () => undefined) }; asks.push(log);
    return { close: log.close, ask: async (input: string) => {
      log.inputs.push(input);
      if (opts.instructions === LUNA_PROMPT) return extra.luna ? extra.luna() : JSON.stringify(emptySummary);
      if (extra.judge) return extra.judge(input);
      const data = JSON.parse(input);
      return JSON.stringify({ hostId: data.hostId, runId: data.runId, lookup: null, decisions: data.messages.map((m: { messageId: string }) => ({ messageId: m.messageId, action, reason: 'test' })) });
    } };
  });
  const worker = new Discuss(join(dir, 'state.json'), history, hooks, factory as never, source); workers.push(worker);
  return { worker, hooks, asks, delivered, snapshot, factory };
}
async function state() { return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')); }
const wait = (assert: () => void | Promise<void>) => vi.waitFor(assert, { timeout: 3500, interval: 20 });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'discuss-test-')); workers = []; });
afterEach(async () => { await Promise.all(workers.map(w => w.close())); await rm(dir, { recursive: true, force: true }); });

describe('Discuss durable routing', () => {
  it('debounces, deduplicates and delivers follow-ups with accepted receipts', async () => {
    const t = setup(); await Promise.all([t.worker.observe('key', msg('a'), false), t.worker.observe('key', msg('b'), false), t.worker.observe('key', msg('a'), false)]);
    expect(t.delivered).toEqual([]);
    await wait(() => expect(t.delivered).toEqual([['a', 'b']]));
    await wait(async () => expect((await state()).lanes.key.entries.map((e: { state: string }) => e.state)).toEqual(['accepted', 'accepted']));
    expect(t.asks.find(a => a.model === 'main-model')?.effort).toBe('high');
  });
  it('Luna failure cooldown never blocks the independent judgment lane', async () => {
    const t = setup('FOLLOW_UP', { ...snap }, { luna: async () => { throw new Error('unavailable'); } });
    await t.worker.observe('key', msg('a'), false);
    await wait(() => expect(t.delivered).toEqual([['a']]));
    expect(t.asks.filter(a => a.model === 'gpt-5.6-luna')).toHaveLength(3);
  });
  it('does not deliver ignored chatter', async () => {
    const t = setup('IGNORE'); await t.worker.observe('key', msg('a'), false);
    await wait(async () => expect((await state()).lanes.key.entries[0].state).toBe('ignored'));
    expect(t.delivered).toEqual([]);
  });
  it('direct mentions bypass judgment and context waits for no Luna result', async () => {
    const t = setup('IGNORE', { ...snap }, { luna: () => new Promise(() => {}) });
    await t.worker.observe('key', msg('at'), true);
    const context = await t.worker.context('key', 'host', ['at']);
    expect(context.block).toContain('at'); context.receipt.accepted(); await context.receipt.settled;
    expect(t.asks.filter(a => a.model === 'main-model')).toHaveLength(0);
  });
  it('queues follow-up durably while busy and drains after idle', async () => {
    const t = setup('FOLLOW_UP', { ...snap, busy: true, runId: 'running' });
    await t.worker.observe('key', msg('a'), false);
    await wait(async () => expect((await state()).lanes.key.entries[0].state).toBe('followup'));
    expect(t.delivered).toEqual([]);
    t.snapshot.busy = false; t.snapshot.runId = undefined;
    await wait(() => expect(t.delivered).toEqual([['a']]));
  });
  it('rejects stale judgment after main finishes and rebuilds fork', async () => {
    let release!: (value: string) => void;
    const t = setup('STEER', { ...snap, busy: true, runId: 'old' }, { judge: () => new Promise(r => { release = r; }) });
    await t.worker.observe('key', msg('a'), false);
    await wait(() => expect(release).toBeTypeOf('function'));
    t.worker.refresh('key'); t.snapshot.runId = 'new';
    release(JSON.stringify({ hostId: 'host', runId: 'old', lookup: null, decisions: [{ messageId: 'a', action: 'STEER', reason: 'correction' }] }));
    await wait(() => expect(t.asks[0]?.close.mock.calls.length || t.asks[1]?.close.mock.calls.length).toBeGreaterThan(0));
    expect(t.delivered).toEqual([]);
    expect((await state()).lanes.key.entries[0].state).toBe('pending');
  });
  it('stop cancels old work without replaying it on the next message', async () => {
    const t = setup(); await t.worker.observe('key', msg('old'), false); t.worker.cancel('key');
    expect((await t.worker.context('key', 'host')).block).toContain('old');
    await wait(async () => expect((await state()).lanes.key.entries[0].state).toBe('cancelled'));
    expect(t.delivered).toEqual([]);
  });
  it('never retries an uncertain steer through the judgment retry loop', async () => {
    const t = setup('STEER', { ...snap, busy: true, runId: 'running' });
    t.hooks.deliver.mockRejectedValue(new Error('transport disconnected after write'));
    await t.worker.observe('key', msg('a'), false);
    await wait(() => expect(t.hooks.deliver).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(t.hooks.deliver).toHaveBeenCalledOnce();
    expect((await state()).lanes.key.entries[0].state).toBe('unknown');
  });
  it('recovery preserves unknown outcomes and reconciles rather than redelivering', async () => {
    const t = setup(); await t.worker.observe('key', msg('a'), true); await t.worker.context('key', 'host', ['a']); await t.worker.close();
    const next = setup(); next.hooks.reconcile.mockResolvedValue(true);
    await next.worker.tick();
    await wait(async () => expect((await state()).lanes.key.entries[0].state).toBe('accepted'));
    expect(next.delivered).toEqual([]);
  });
  it('summary versions are injected once, newer raw input is still present', async () => {
    const t = setup('IGNORE'); await t.worker.observe('key', msg('a'), false);
    await wait(async () => expect((await state()).lanes.key.summary.version).toBe(1));
    const first = await t.worker.context('key', 'host'); expect(first.block).toContain('简报 v1'); first.receipt.accepted();
    await t.worker.observe('key', msg('b'), false);
    const second = await t.worker.context('key', 'host'); expect(second.block).not.toContain('简报 v1'); expect(second.block).toContain('"messageId":"b"');
    expect((await t.worker.context('key', 'new-host')).block).toContain('简报 v1');
  });
  it('disabled projects never invoke an auxiliary model', async () => {
    const t = setup('IGNORE', { ...snap, enabled: false }); await t.worker.observe('key', msg('a'), false);
    await wait(async () => expect((await state()).lanes.key.entries[0].state).toBe('cancelled'));
    expect(t.factory).not.toHaveBeenCalled();
  });
});

it('requires exactly one valid decision per message and exact turn target', () => {
  const base = { hostId: 'host', runId: null, lookup: null, decisions: [{ messageId: 'a', action: 'IGNORE', reason: '' }] };
  expect(parseJudgment(JSON.stringify(base), [{ msg: msg('a') }], snap).decisions).toHaveLength(1);
  for (const value of [{ ...base, runId: 'stale' }, { ...base, decisions: [] }, { ...base, decisions: [...base.decisions, ...base.decisions] }, { ...base, decisions: [{ ...base.decisions[0], action: 'STEER' }] }]) expect(() => parseJudgment(JSON.stringify(value), [{ msg: msg('a') }], snap)).toThrow();
});
it('project file lookup denies path traversal, symlink escape and truncates large files', async () => {
  await writeFile(join(dir, 'allowed'), 'abcdefgh');
  expect(await readScopedFile(dir, 'allowed', 4)).toBe('abcd');
  await symlink('/etc/hosts', join(dir, 'escape'));
  await expect(readScopedFile(dir, 'escape')).rejects.toThrow('outside project');
  await expect(readScopedFile(dir, '/etc/hosts')).rejects.toThrow('outside project');
});

it('recovers a failed state write without dispatching uncommitted ingress', async () => {
  const t = setup(); await mkdir(join(dir, 'state.json.tmp'));
  await expect(t.worker.observe('key', msg('a'), false)).rejects.toThrow();
  await expect(t.worker.tick()).rejects.toThrow(); expect(t.delivered).toEqual([]);
  await rm(join(dir, 'state.json.tmp'), { recursive: true });
  await t.worker.observe('key', msg('b'), false);
  await wait(() => expect(t.delivered).toEqual([['a', 'b']]));
});
it.each(['partial', 'complete'])('repairs a %s trailing journal boundary before appending', async kind => {
  const row = JSON.stringify({ key: 'key', msg: msg('old'), direct: false });
  await writeFile(join(dir, 'state.json.messages.jsonl'), kind === 'partial' ? row + '\n{"key":' : row);
  const t = setup('IGNORE'); await t.worker.observe('key', msg('new'), false); await t.worker.close();
  const again = setup('IGNORE'); await again.worker.context('key', 'host');
  expect((await state()).lanes.key.entries.map((e: { msg: { messageId: string } }) => e.msg.messageId)).toEqual(['old', 'new']);
});
it('retains an in-flight summary when only the judge is refreshed', async () => {
  let release!: (value: string) => void;
  const t = setup('IGNORE', { ...snap }, { luna: () => new Promise(r => { release = r; }) });
  await t.worker.observe('key', msg('a'), false);
  await wait(() => expect(release).toBeTypeOf('function'));
  t.worker.refresh('key'); release(JSON.stringify(emptySummary));
  await wait(async () => expect((await state()).lanes.key.summary.covered).toBe(1));
});
it('takeover owns all undecided messages until main acknowledgment', async () => {
  const t = setup(); await t.worker.observe('key', msg('a'), false); await t.worker.observe('key', msg('b'), false);
  expect((await t.worker.takeover('key', msg('at'))).map(m => m.messageId)).toEqual(['a', 'b']);
  expect((await state()).lanes.key.entries.map((e: { state: string }) => e.state)).toEqual(['unknown', 'unknown', 'unknown']);
  const context = await t.worker.context('key', 'host', ['a', 'b', 'at']);
  context.receipt.accepted(); await context.receipt.settled;
  expect((await state()).lanes.key.entries.map((e: { state: string }) => e.state)).toEqual(['accepted', 'accepted', 'accepted']);
  expect(t.delivered).toEqual([]);
});

it('rechecks uncertain delivery after 30 seconds despite intermediate ticks', async () => {
  const t = setup('IGNORE'); await t.worker.observe('key', msg('a'), true);
  await t.worker.context('key', 'host', ['a']);
  await wait(() => expect(t.hooks.reconcile).toHaveBeenCalledOnce());
  const base = Date.now(); const clock = vi.spyOn(Date, 'now');
  try {
    for (const elapsed of [10000, 20000, 31000]) {
      clock.mockReturnValue(base + elapsed); await t.worker.tick();
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(t.hooks.reconcile).toHaveBeenCalledTimes(2);
  } finally { clock.mockRestore(); }
});

it('configures summary independently of judgment and switches model and Fast', async () => {
  const t = setup('IGNORE');
  let policy = { enabled: false, model: 'gpt-5.6-sol', fast: true };
  Object.assign(t.hooks, { summaryPolicy: async () => policy });
  await t.worker.observe('key', msg('a'), false);
  await wait(async () => expect((await state()).lanes.key.entries[0].state).toBe('ignored'));
  expect(t.factory.mock.calls.some(([o]) => o.instructions === LUNA_PROMPT)).toBe(false);
  policy = { ...policy, enabled: true }; await t.worker.tick();
  await wait(async () => expect((await state()).lanes.key.summary.version).toBe(1));
  expect(t.factory).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-sol', fast: true, instructions: LUNA_PROMPT }), expect.any(AbortSignal));
  const original = t.asks.find(a => a.model === 'gpt-5.6-sol')!;
  policy = { enabled: true, model: 'gpt-6-astra', fast: false };
  await t.worker.observe('key', msg('b'), false);
  await wait(() => expect(t.factory).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra', fast: false, instructions: LUNA_PROMPT }), expect.any(AbortSignal)));
  expect(original.close).toHaveBeenCalled();
  policy = { ...policy, enabled: false };
  const context = await t.worker.context('key', 'host');
  expect(context.block).not.toContain('简报 v'); expect(context.block).toContain('"messageId":"a"');
});
it('does not commit a summary finishing after the project turns it off', async () => {
  let release!: (v: string) => void;
  const t = setup('IGNORE', { ...snap }, { luna: () => new Promise(r => { release = r; }) });
  let enabled = true; Object.assign(t.hooks, { summaryPolicy: async () => ({ enabled, model: 'gpt-5.6-luna', fast: false }) });
  await t.worker.observe('key', msg('a'), false);
  await wait(() => expect(release).toBeTypeOf('function'));
  enabled = false; release(JSON.stringify(emptySummary));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect((await state()).lanes.key.summary).toBeUndefined();
});


it('bounds raw background for a new host and never consumes skipped messages', async () => {
  const file = join(dir, 'bounded.json');
  const entries = Array.from({ length: 500 }, (_, i) => ({ seq: i + 1, msg: { ...msg(`m-${i}`), content: '汉'.repeat(4000) }, state: 'ignored' }));
  await writeFile(file, JSON.stringify({ version: 1, lanes: { key: { entries, injected: {}, generation: 0, next: 501 } } }));
  const worker = new Discuss(file, history, { snapshot: async () => snap, reconcile: async () => false, deliver: async () => false,
    enabled: async () => false, summaryPolicy: async () => ({ enabled: false, model: 'unused', fast: false }) }, (() => { throw new Error('No model needed'); }) as never, source);
  workers.push(worker);
  const context = await worker.context('key', 'new-host', ['m-0']);
  expect(Buffer.byteLength(context.block)).toBeLessThan(66 * 1024);
  expect(context.block).toContain('m-0'); expect(context.block).toContain('m-499');
  expect(context.block).toContain('省略');
  context.receipt.accepted(); await context.receipt.settled;
  const saved = JSON.parse(await readFile(file, 'utf8'));
  expect(saved.lanes.key.rawInjected['new-host']).toBe(1);
  expect((await worker.context('key', 'new-host')).block).toContain('省略');
});


it('falls back to raw history without consuming an oversized summary version', async () => {
  const file = join(dir, 'oversized-summary.json');
  const entries = [{ seq: 1, msg: { ...msg('original'), content: '尾部约束必须保留' }, state: 'ignored' }];
  await writeFile(file, JSON.stringify({ version: 1, lanes: { key: { entries, injected: {}, generation: 0, next: 2,
    summary: { version: 1, covered: 1, body: '汉'.repeat(30000), gaps: [] } } } }));
  const worker = new Discuss(file, history, { snapshot: async () => snap, reconcile: async () => false, deliver: async () => false,
    enabled: async () => false }, (() => { throw new Error('No model needed'); }) as never, source);
  workers.push(worker);
  const context = await worker.context('key', 'host');
  expect(context.block).toContain('尾部约束必须保留');
  expect(context.block).toContain('简报超过预算');
  expect(Buffer.byteLength(context.block)).toBeLessThan(66 * 1024);
  context.receipt.accepted(); await context.receipt.settled;
  const saved = JSON.parse(await readFile(file, 'utf8'));
  expect(saved.lanes.key.injected.host).toBeUndefined();
  expect(saved.lanes.key.rawInjected.host).toBe(1);
  expect((await worker.context('key', 'another-host')).block).toContain('尾部约束必须保留');
});


it('skips an empty lane without starving later populated lanes', async () => {
  const t = setup('IGNORE');
  Object.assign(t.hooks, { enabled: async (_key: string, m: NormalizedMessage) => Boolean(m.chatId) });
  await t.worker.context('empty', 'host');
  await t.worker.observe('key', msg('still-judged'), false);
  await wait(async () => expect((await state()).lanes.key.entries[0].state).toBe('ignored'));
});
