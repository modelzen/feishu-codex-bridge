import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mock = vi.hoisted(() => ({ requests: [] as { method: string; params: Record<string, unknown> }[], home: '', fork: undefined as Record<string, unknown> | undefined, fail: false }));
vi.mock('../src/agent/codex-appserver/locate', () => ({ resolveCodexBin: () => '/fake/codex' }));
vi.mock('../src/agent/codex-appserver/app-server-client', () => ({ AppServerClient: class {
  constructor(options: { env: { CODEX_HOME: string } }) { mock.home = options.env.CODEX_HOME; }
  async connect() {}
  async close() {}
  async request(method: string, params: Record<string, unknown>) {
    mock.requests.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn' } };
    if (method === 'thread/fork') { mock.fork = params; if (mock.fail) throw new Error('fork rejected'); }
    return { thread: { id: 'fork-id' } };
  }
  async *stream() {}
} }));
import { createDiscussModel } from '../src/agent/codex-appserver/discuss-runner';
let root: string;
afterEach(async () => { mock.fail = false; if (root) await rm(root, { recursive: true, force: true }); });
it.each(['legacy', 'paginated'])('imports an unchanged private %s snapshot and excludes returned turns', async history_mode => {
  root = await mkdtemp(join(tmpdir(), 'discuss-source-test-'));
  const source = join(root, 'rollout-test.jsonl');
  const bytes = JSON.stringify({ type: 'session_meta', payload: { id: 'source', history_mode } }) + '\n';
  await writeFile(source, bytes);
  const model = await createDiscussModel({ model: 'test', effort: 'low', instructions: 'classify', sourceId: 'source', sourcePath: source, beforeTurnId: 'active-turn' }, new AbortController().signal);
  const snapshot = mock.fork!.path as string;
  expect(snapshot).toBe(join(mock.home, 'sessions', 'rollout-test.jsonl'));
  expect(snapshot).not.toBe(source);
  expect(await readFile(snapshot, 'utf8')).toBe(bytes);
  expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
  expect(mock.fork).toMatchObject({ threadId: 'source', excludeTurns: true, ephemeral: true, beforeTurnId: 'active-turn' });
  await model.close();
  await expect(stat(mock.home)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(source, 'utf8')).toBe(bytes);
});
it('cleans the private snapshot and preserves the RPC error when fork fails', async () => {
  root = await mkdtemp(join(tmpdir(), 'discuss-source-test-'));
  const source = join(root, 'rollout-test.jsonl'); await writeFile(source, 'unchanged'); mock.fail = true;
  await expect(createDiscussModel({ model: 'test', effort: 'low', instructions: 'classify', sourceId: 'source', sourcePath: source }, new AbortController().signal)).rejects.toThrow('fork rejected');
  await expect(stat(mock.home)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(source, 'utf8')).toBe('unchanged');
});

it.each([true, false])('sends explicit Fast=%s to both thread and turn', async fast => {
  mock.requests = [];
  const model = await createDiscussModel({ model: 'gpt-5.6-luna', effort: 'low', instructions: 'summary', fast }, new AbortController().signal);
  try {
    await expect(model.ask('summarize', {}, new AbortController().signal)).rejects.toThrow('Auxiliary stream closed');
    for (const method of ['thread/start', 'turn/start']) expect(mock.requests.find(r => r.method === method)?.params.serviceTier).toBe(fast ? 'fast' : null);
  } finally { await model.close(); }
});
