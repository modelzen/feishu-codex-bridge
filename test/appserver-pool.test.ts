import { UnsentRequestError } from '../src/agent/types';
import { AppServerClient } from '../src/agent/codex-appserver/app-server-client';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import {
  refillWarmPool,
  shutdownResidentClients,
  takeWarmClient,
  utilityRequest,
} from '../src/agent/codex-appserver/client-pool';

// M-2（research/08 probe 思路的单测化）：utility client 复用/出错即重建 + 容量 1
// 预热池（取走异步补位、bin 指纹防升级错位、预热通知不漏进会话流）。真机基准
// （spawn/init/thread-start 计时、interrupt 终态）见 test/probe-appserver.mjs。
// 假 codex app-server 同既有 fixture 套路：POSIX shebang 脚本，Windows 整组跳过。
const FAKE_SERVER = `#!/usr/bin/env node
require('fs').appendFileSync(__filename + '.count', 'run\\n');
let buf = '';
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id !== 'number') continue; // notification — ignore
    const m = msg.method;
    const p = msg.params || {};
    if (m === 'die') process.exit(1); // 不回包直接死
    if (m === 'hang') continue; // 永不回包（wedged codex）
    if (m === 'rpc/error') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } });
      continue;
    }
    if (m === 'thread/start' && p.ephemeral) {
      // 预热路径：先吐一条「噪音」通知再回包——验证取用时被清空
      send({ jsonrpc: '2.0', method: 'prewarm/noise', params: {} });
      send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: 'warm_eph' } } });
      continue;
    }
    if (m === 'emit') send({ jsonrpc: '2.0', method: 'real/event', params: {} });
    const result =
      m === 'model/list' ? { data: [{ id: 'pool-model', isDefault: true }] } :
      m === 'thread/list' ? { data: [{ id: 't1', preview: 'hi', createdAt: 1, updatedAt: 2 }] } :
      m === 'thread/read' ? { thread: { turns: [] } } :
      m === 'thread/start' ? { thread: { id: 'th_real' } } :
      {};
    send({ jsonrpc: '2.0', id: msg.id, result });
  }
});
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

const dirs: string[] = [];
let prevEnv: string | undefined;
let prevPrewarmEnv: string | undefined;

/** 建一个假 codex，并把 CODEX_BIN 指过去；afterEach 统一关进程、删目录、还原 env。 */
function makeFakeCodex(): { bin: string; runs: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'appserver-pool-'));
  dirs.push(dir);
  const bin = join(dir, 'codex');
  writeFileSync(bin, FAKE_SERVER, { mode: 0o755 });
  prevEnv = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  const runs = (): number => {
    try {
      return readFileSync(`${bin}.count`, 'utf8').trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  return { bin, runs };
}

afterEach(async () => {
  await shutdownResidentClients();
  if (prevEnv === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = prevEnv;
  if (prevPrewarmEnv === undefined) delete process.env.FEISHU_CODEX_PREWARM;
  else process.env.FEISHU_CODEX_PREWARM = prevPrewarmEnv;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('utility client 复用与出错即重建（M-2）', () => {
  it('listModels/listThreads/readHistory 共享一个常驻进程，只 spawn 一次', async () => {
    const { runs } = makeFakeCodex();
    const backend = new CodexAppServerBackend();

    const models = await backend.listModels();
    expect(models.map((m) => m.id)).toEqual(['pool-model']);
    const threads = await backend.listThreads('/some/project');
    expect(threads.map((t) => t.sessionId)).toEqual(['t1']);
    const history = await backend.readHistory('/some/project', 't1');
    expect(history).toEqual({
      turns: [],
      totalTurns: 0,
      name: undefined,
      preview: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    });

    expect(runs()).toBe(1); // 三个 RPC 一个进程，不再各付一次 spawn+initialize
  });

  it('应用层 JSON-RPC error → 上抛但进程保留（健康进程不被 SIGKILL）', async () => {
    const { runs } = makeFakeCodex();
    await expect(utilityRequest('rpc/error')).rejects.toThrow('boom');
    expect(runs()).toBe(1);

    const res = await utilityRequest<{ data: { id: string }[] }>('model/list');
    expect(res.data[0]!.id).toBe('pool-model');
    expect(runs()).toBe(1); // 进程健康（它好好回了 error 包）——复用，不重建
  });

  it('一个调用方的 RPC error 不殃及并发在飞的请求（不 failAllPending）', async () => {
    makeFakeCodex();
    const [bad, good] = await Promise.allSettled([
      utilityRequest('rpc/error'),
      utilityRequest<{ data: { id: string }[] }>('model/list'),
    ]);
    expect(bad.status).toBe('rejected');
    expect((bad as PromiseRejectedResult).reason).toMatchObject({ message: 'boom' });
    expect(good.status).toBe('fulfilled'); // 旧行为会被 discard→SIGKILL 连坐打挂
    expect((good as PromiseFulfilledResult<{ data: { id: string }[] }>).value.data[0]!.id).toBe('pool-model');
  });

  it('进程死亡 → 后续调用自动重建', async () => {
    const { runs } = makeFakeCodex();
    await expect(utilityRequest('die')).rejects.toThrow(/app-server exited/);
    const res = await utilityRequest<{ data: { id: string }[] }>('model/list');
    expect(res.data[0]!.id).toBe('pool-model');
    expect(runs()).toBe(2);
  });

  it('超时（wedged codex）→ 报错并重建，不留挂死进程', async () => {
    const { runs } = makeFakeCodex();
    await expect(utilityRequest('hang', {}, { timeoutMs: 300 })).rejects.toThrow(/timed out/);
    const res = await utilityRequest<{ data: { id: string }[] }>('model/list');
    expect(res.data[0]!.id).toBe('pool-model');
    expect(runs()).toBe(2);
  });
});

describe.skipIf(process.platform === 'win32')('容量 1 预热池（M-2）', () => {
  beforeEach(() => {
    prevPrewarmEnv = process.env.FEISHU_CODEX_PREWARM;
    process.env.FEISHU_CODEX_PREWARM = '1';
  });

  it('补位→取走命中；池清空后再取扑空', async () => {
    const { bin, runs } = makeFakeCodex();
    await refillWarmPool();
    expect(runs()).toBe(1);

    const client = takeWarmClient(bin);
    expect(client).not.toBeNull();
    expect(takeWarmClient(bin)).toBeNull(); // 容量 1：取走即空

    // 取走的热进程功能完好：真实 thread/start 直接可用
    const res = await client!.request<{ thread: { id: string } }>('thread/start', { cwd: '/p' });
    expect(res.thread.id).toBe('th_real');
    expect(runs()).toBe(1); // 全程同一个进程
    await client!.close();
  });

  it('预热期间缓冲的通知被清空，不漏进会话事件流', async () => {
    const { bin } = makeFakeCodex();
    await refillWarmPool(); // 假 server 在 ephemeral thread/start 前吐了 prewarm/noise
    const client = takeWarmClient(bin)!;
    expect(client).not.toBeNull();

    await client.request('emit'); // 回包前先吐 real/event 通知
    const first = await client.stream()[Symbol.asyncIterator]().next();
    expect((first.value as { method: string }).method).toBe('real/event'); // 不是 prewarm/noise
    await client.close();
  });

  it('bin 指纹变化（codex 升级）→ 弃置热进程走冷路径', async () => {
    const { bin, runs } = makeFakeCodex();
    await refillWarmPool();
    expect(runs()).toBe(1);

    appendFileSync(bin, '\n// upgraded\n'); // mtime+size 都变 —— 模拟原地升级
    expect(takeWarmClient(bin)).toBeNull();
    expect(runs()).toBe(1); // 没有偷偷用旧进程
  });

  it('backend.startThread：冷路径触发补位，下一个会话复用热进程', async () => {
    const { bin, runs } = makeFakeCodex();
    const cwd = join(bin, '..'); // 真实存在的目录（冷路径 spawn 的 cwd 必须存在）
    const backend = new CodexAppServerBackend();

    const t1 = await backend.startThread({ cwd });
    expect(t1.sessionId).toBe('th_real');
    // 冷 spawn(1) + 异步补位(2)
    await vi.waitFor(() => expect(runs()).toBe(2));

    const t2 = await backend.startThread({ cwd });
    expect(t2.sessionId).toBe('th_real');
    // 第二个会话取走热进程（不新 spawn），随后补位把总数推到 3——且只到 3：
    // 若它走了冷路径，这里会出现第 4 个进程
    await vi.waitFor(() => expect(runs()).toBe(3));
    await new Promise((r) => setTimeout(r, 150));
    expect(runs()).toBe(3);

    await Promise.allSettled([t1.close(), t2.close()]);
  });
});

it('bounds a missing RPC response without killing unrelated requests', async () => {
  const { bin } = makeFakeCodex();
  const client = new AppServerClient({ bin, cwd: '/tmp' });
  try {
    await client.connect();
    const hanging = client.request('hang', {}, 30);
    const timedOut = expect(hanging).rejects.toThrow('delivery unknown');
    await expect(client.request('model/list', {})).resolves.toHaveProperty('data');
    await timedOut;
    expect((client as any).pending.size).toBe(0);
    await expect(client.request('model/list', {}, 1000)).resolves.toHaveProperty('data');
  } finally { await client.close(); }
});

it('classifies a locally closed request as definitely unsent', async () => {
 const client = new AppServerClient({bin:'unused',cwd:'/tmp'});
 await expect(client.request('turn/steer')).rejects.toBeInstanceOf(UnsentRequestError);
});
it('returning a notification iterator removes its pending read', async () => {
 const {bin} = makeFakeCodex(); const client = new AppServerClient({bin,cwd:'/tmp'});
 try {
  await client.connect();
  const abandoned = client.stream()[Symbol.asyncIterator]();
  const read = abandoned.next(); await abandoned.return?.();
  expect(await read).toMatchObject({done:true});
  await client.request('emit');
  const fresh = client.stream()[Symbol.asyncIterator]();
  expect(await fresh.next()).toMatchObject({done:false,value:{method:'real/event'}});
  await fresh.return?.();
 } finally {await client.close();}
});
