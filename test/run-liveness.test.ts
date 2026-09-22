import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { writeNodeExecutable } from './helpers/node-executable';

// 一个最小的假 codex app-server：应答 initialize / thread/start；收到 turn/start
// 后只持续发 event-map 映射为 null 的原始通知（命令输出 delta），永不发可映射
// 事件——模拟「长命令一直在输出、卡片层却看不到任何 yield」的场景（QW-5）。
const FAKE_SERVER = `#!/usr/bin/env node
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
    if (msg.method === 'turn/start') {
      send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 't1' } } });
      setInterval(() => {
        send({ jsonrpc: '2.0', method: 'item/commandExecution/outputDelta', params: { threadId: 'th_live', turnId: 't1', itemId: 'i1', delta: 'x' } });
      }, 20);
      continue;
    }
    const result = msg.method === 'thread/start' ? { thread: { id: 'th_live' } } : {};
    send({ jsonrpc: '2.0', id: msg.id, result });
  }
});
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

const dir = mkdtempSync(join(tmpdir(), 'run-liveness-'));
const { bin } = writeNodeExecutable(dir, 'codex', FAKE_SERVER);

afterAll(async () => {
  await shutdownResidentClients();
  rmSync(dir, { recursive: true, force: true });
});

describe('runStreamed 原始通知刷新 lastActivity（QW-5）', () => {
  it('unmapped raw notifications advance run.lastActivity() while the stream yields nothing', async () => {
    const prev = process.env.CODEX_BIN;
    process.env.CODEX_BIN = bin;
    try {
      const backend = new CodexAppServerBackend();
      const thread = await backend.startThread({ cwd: dir });
      const run = thread.runStreamed({ text: 'go' });
      expect(typeof run.lastActivity).toBe('function');

      // 开始消费（挂起的 next() 让 gen 循环跑起来）；到来的全是 null 映射通知，
      // 流上不产出任何事件，但活性时钟必须持续前进。
      const iter = run.events[Symbol.asyncIterator]();
      const pending = iter.next();
      const before = run.lastActivity!();
      await vi.waitFor(() => expect(run.lastActivity!()).toBeGreaterThan(before));

      // 回收：close 杀掉子进程 → 通知队列关闭 → 挂起的 next() 以 done 收尾
      await thread.close();
      await expect(pending).resolves.toMatchObject({ done: true });
    } finally {
      if (prev === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prev;
    }
  });
});
