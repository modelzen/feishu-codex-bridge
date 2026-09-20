import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, appendFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discuss, DISCUSS_TERMINAL_ENTRIES, DISCUSS_TERMINAL_BYTES } from '../src/bot/discuss';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
const workers: Discuss[] = [];
const dirs: string[] = [];
const message = (id: string, content = id): NormalizedMessage => ({ messageId: id, chatId: 'chat', chatType: 'group', senderId: 'u', senderName: 'User', mentionedBot: false, mentionAll: false, mentions: [], content, createTime: 1, resources: [], rawContentType: 'text' });
const row = (seq: number, state = 'accepted', content?: string) => ({ seq, msg: message(`m${seq}`, content), state });
async function seed(entries: ReturnType<typeof row>[]) {
  const dir = await mkdtemp(join(tmpdir(), 'discuss-retention-')); dirs.push(dir);
  const file = join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ version: 1, lanes: { key: { entries, injected: {}, generation: 0, next: entries.length + 1 } } }));
  await writeFile(`${file}.messages.jsonl`, entries.map(e => JSON.stringify({ key: 'key', msg: e.msg, direct: false })).join('\n') + '\n');
  return file;
}
function start(file: string) {
  const worker = new Discuss(file, { recent: async () => ({ messages: [], gaps: [] }), lookup: async () => ({ messages: [], gaps: [] }) }, {
    summaryPolicy: async () => ({ enabled: false, model: 'unused', fast: false }),
    snapshot: async () => ({ enabled: true, hostId: 'h', model: 'unused', effort: 'low', cwd: '/', busy: false, goal: true, signature: 's' }),
    reconcile: async () => false, deliver: vi.fn(async () => false),
  }, async () => { throw new Error('Model must not run'); });
  workers.push(worker); return worker;
}
const disk = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
afterEach(async () => { await Promise.allSettled(workers.splice(0).map(w => w.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
describe('Discuss durable retention', () => {
  it('checkpoints old terminal messages, preserves unresolved work and deduplicates after restart without replaying old journal', async () => {
    const file = await seed([...Array.from({ length: DISCUSS_TERMINAL_ENTRIES + 3 }, (_, i) => row(i + 1, i % 3 === 0 ? 'ignored' : i % 3 === 1 ? 'accepted' : 'cancelled')), row(260, 'pending'), row(261, 'followup'), row(262, 'unknown')]);
    const first = start(file); await first.checkpoint();
    const state = await disk(file);
    expect(state.journal).toBeTruthy();
    expect(state.lanes.key.entries).toHaveLength(DISCUSS_TERMINAL_ENTRIES + 3);
    expect(state.lanes.key.entries.slice(-3).map((e: any) => e.state)).toEqual(['pending', 'followup', 'unknown']);
    expect((await first.readArchived('key', 'm1'))?.state).toBe('ignored');
    expect((await first.readArchived('another-key', 'm1'))).toBeUndefined();
    await first.close();
    // Old journal is intentionally unreadable: a checkpoint restart must not parse it.
    await writeFile(`${file}.messages.jsonl`, 'old-epoch-is-not-replayed');
    const next = start(file); await next.observe('key', message('m2'), false);
    await next.observe('key', message('fresh'), true);
    expect((await disk(file)).lanes.key.entries.filter((e: any) => e.msg.messageId === 'm2')).toHaveLength(0);
    expect((await disk(file)).lanes.key.entries.at(-1).state).toBe('unknown');
  });
  it('recovers ingress appended to the new journal but absent from the checkpoint snapshot', async () => {
    const file = await seed([row(1)]);
    const worker = start(file); await worker.checkpoint(); await worker.close();
    const epoch = (await disk(file)).journal;
    await appendFile(`${file}.messages.${epoch}.jsonl`, JSON.stringify({ key: 'key', msg: message('not-yet-snapshotted'), direct: true }) + '\n');
    const restarted = start(file); await restarted.observe('key', message('probe'), true);
    expect((await disk(file)).lanes.key.entries.find((e: any) => e.msg.messageId === 'not-yet-snapshotted').state).toBe('unknown');
  });

  it('limits terminal bytes independently of count and retains the complete archived payload', async () => {
    const text = 'x'.repeat(DISCUSS_TERMINAL_BYTES + 1);
    const file = await seed([row(1, 'accepted', text), row(2, 'unknown', text)]);
    const worker = start(file); await worker.checkpoint();
    expect((await disk(file)).lanes.key.entries.map((e: any) => e.msg.messageId)).toEqual(['m2']);
    expect((await worker.readArchived('key', 'm1'))?.msg.content).toBe(text);
  });
  it('keeps the original snapshot and journal usable when archive creation fails', async () => {
    const file = await seed(Array.from({ length: DISCUSS_TERMINAL_ENTRIES + 1 }, (_, i) => row(i + 1)));
    const before = await readFile(file, 'utf8');
    const worker = start(file); (await worker.context('key', 'host')).receipt.rejected();
    await writeFile(`${file}.archive`, 'not a directory');
    await expect(worker.checkpoint()).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await disk(file)).journal).toBeUndefined();
    await rm(`${file}.archive`); await worker.checkpoint();
    expect((await disk(file)).lanes.key.entries).toHaveLength(DISCUSS_TERMINAL_ENTRIES);
  });
  it('preserves a receipt accepted while the checkpoint snapshot is committing', async () => {
    const file = await seed([...Array.from({ length: DISCUSS_TERMINAL_ENTRIES + 1 }, (_, i) => row(i + 1)), row(258, 'unknown')]);
    const worker = start(file);
    const context = await worker.context('key', 'host', ['m258']);
    const originalWrite = (worker as any).durableWrite.bind(worker);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    (worker as any).durableWrite = async (path: string, body: string) => {
      if (path === file) { enter(); await released; }
      return originalWrite(path, body);
    };
    const checkpoint = worker.checkpoint(); await entered;
    context.receipt.accepted(); release(); await checkpoint; await context.receipt.settled;
    expect((await disk(file)).lanes.key.entries.find((e: any) => e.msg.messageId === 'm258').state).toBe('accepted');
    await worker.close();
    const restarted = start(file); await restarted.observe('key', message('probe'), true);
    expect((await disk(file)).lanes.key.entries.find((e: any) => e.msg.messageId === 'm258').state).toBe('accepted');
  });

  it('recovers a committed archive with an older pre-checkpoint snapshot without reviving accepted work', async () => {
    const file = await seed(Array.from({ length: DISCUSS_TERMINAL_ENTRIES + 1 }, (_, i) => row(i + 1)));
    const original = await disk(file);
    const first = start(file); await first.checkpoint(); await first.close();
    // Simulate crash between durable archive and snapshot commit, including a
    // receipt whose terminal state had not reached the older snapshot yet.
    original.lanes.key.entries[0].state = 'pending';
    await writeFile(file, JSON.stringify(original));
    const next = start(file); await next.observe('key', message('probe'), true);
    expect((await disk(file)).lanes.key.entries[0].state).toBe('accepted');
    await next.checkpoint();
    expect((await disk(file)).lanes.key.entries.some((e: any) => e.msg.messageId === 'm1')).toBe(false);
    expect((await readdir(`${file}.archive`)).filter(n => n.endsWith('.json'))).toHaveLength(1);
  });
});
