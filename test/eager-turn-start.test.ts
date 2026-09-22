import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { writeNodeExecutable } from './helpers/node-executable';

// 一个最小的假 codex app-server：收到 turn/start 先落一个标记文件（证明请求
// 已到达），再按 input 文本分流——'fail' 回 JSON-RPC error（测 start-failure
// race），其余立即吐完整轮事件（测早发 + AsyncQueue 缓冲不丢）。
const FAKE_SERVER = `#!/usr/bin/env node
const fs = require('fs');
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
      // 写到脚本所在目录（绝对路径）——进程 cwd 可能是预热池的中性目录，不可依赖
      fs.writeFileSync(require('path').join(__dirname, 'turn-start-received'), '1');
      const text = msg.params.input?.[0]?.text ?? '';
      if (text === 'fail') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'bad params' } });
        continue;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: 't1' } } });
      send({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'th_eager', turn: { id: 't1' } } });
      send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: 'th_eager', turnId: 't1', itemId: 'i1', delta: 'hi' } });
      send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'th_eager', turn: { id: 't1' } } });
      continue;
    }
    const result = msg.method === 'thread/start' ? { thread: { id: 'th_eager' } } : {};
    send({ jsonrpc: '2.0', id: msg.id, result });
  }
});
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

const dir = mkdtempSync(join(tmpdir(), 'eager-turn-start-'));
const { bin } = writeNodeExecutable(dir, 'codex', FAKE_SERVER);
const marker = join(dir, 'turn-start-received');

async function withFakeCodex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
}

afterAll(async () => {
  await shutdownResidentClients();
  rmSync(dir, { recursive: true, force: true });
});

describe('runStreamed 提前发 turn/start（QW-1）', () => {
  it('issues turn/start at runStreamed() call time; pre-consumption notifications buffer losslessly', async () => {
    await withFakeCodex(async () => {
      const backend = new CodexAppServerBackend();
      const thread = await backend.startThread({ cwd: dir });
      const run = thread.runStreamed({ text: 'go' });

      // 一个事件都还没消费：惰性实现这里会永远等不到 turn/start 到达
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));

      // 整轮事件早已吐进 AsyncQueue——现在才开始消费，一个不丢、顺序不乱
      const types: string[] = [];
      for await (const ev of run.events) types.push(ev.type);
      expect(types).toEqual(['turn_started', 'text_delta', 'done']);
      await thread.close();
    });
  });

  it('keeps the start-failure race: an (early) turn/start rejection surfaces as a fatal error event', async () => {
    await withFakeCodex(async () => {
      const backend = new CodexAppServerBackend();
      const thread = await backend.startThread({ cwd: dir });
      const run = thread.runStreamed({ text: 'fail' });

      // 拒绝可能发生在消费开始之前（eager）——race 仍须把真实原因吐出来，
      // 而不是留给 idle watchdog 报假「已超时」
      const events = [];
      for await (const ev of run.events) events.push(ev);
      expect(events).toEqual([{ type: 'error', message: 'bad params', willRetry: false }]);
      await thread.close();
    });
  });
});
