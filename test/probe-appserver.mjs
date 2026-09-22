#!/usr/bin/env node
// codex app-server 真机探针（research/08 的 probe 脚本入库版）。手动运行，不进 vitest
// （vitest 只收 test/**/*.test.ts）；池化/复用逻辑的单测见 test/appserver-pool.test.ts。
//
// 用法：
//   node test/probe-appserver.mjs              # 零 token 基准：spawn→initialize、
//                                              # 首/次 thread/start(ephemeral) 计时、
//                                              # thread/loaded/list 多线程并存验证
//   node test/probe-appserver.mjs --interrupt  # L-3 go/no-go：turn/start 后 ~1s 发
//                                              # turn/interrupt，核实是否以
//                                              # turn/completed(status:"interrupted")
//                                              # 收尾、同进程能否继续复用。
//                                              # ⚠️ 花费一轮最小 turn（真实 token）
//
// 二进制取 $CODEX_BIN，否则 PATH 上的 `codex`。输出带 >>/<< 方向标记的原始
// JSON-RPC 往返（截断到 400 字符），可直接摘进调研报告。

import spawn from 'cross-spawn';
import { tmpdir } from 'node:os';

const INTERRUPT_MODE = process.argv.includes('--interrupt');
const BIN = process.env.CODEX_BIN || 'codex';
const CWD = tmpdir();
const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`;
const trunc = (s, n = 400) => (s.length > n ? `${s.slice(0, n)}…(${s.length}ch)` : s);

const child = spawn(BIN, ['app-server', '--listen', 'stdio://'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.on('error', (err) => {
  console.error('spawn failed:', err.message);
  process.exit(1);
});
child.stderr.on('data', (d) => {
  const line = d.toString().trim();
  if (line) console.error(`${ts()} [stderr] ${trunc(line, 200)}`);
});
process.on('exit', () => {
  try {
    child.kill('SIGKILL');
  } catch {}
});

let nextId = 0;
const pending = new Map();
const notificationWaiters = []; // { match: (msg) => boolean, resolve }
const send = (obj) => {
  console.log(`${ts()} >> ${trunc(JSON.stringify(obj))}`);
  child.stdin.write(`${JSON.stringify(obj)}\n`);
};
const request = (method, params = {}) => {
  const id = ++nextId;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
/** 等第一条满足 match 的通知（带死线）。 */
const waitNotification = (match, label, ms = 60_000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`waiting for ${label} timed out after ${ms}ms`)), ms);
    notificationWaiters.push({
      match,
      resolve: (msg) => {
        clearTimeout(t);
        resolve(msg);
      },
    });
  });

let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    console.log(`${ts()} << ${trunc(line)}`);
    if (typeof msg.id === 'number' && !msg.method) {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'JSON-RPC error'));
      else p.resolve(msg.result);
      continue;
    }
    if (typeof msg.id === 'number' && msg.method) {
      // server 发起的请求（审批等）——回 method-not-found 防卡死
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not handled' } });
      continue;
    }
    for (let i = 0; i < notificationWaiters.length; i++) {
      if (notificationWaiters[i].match(msg)) {
        notificationWaiters.splice(i, 1)[0].resolve(msg);
        break;
      }
    }
  }
});

const startEphemeralThread = () =>
  request('thread/start', { cwd: CWD, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' });

async function benchmark() {
  let mark = Date.now();
  await request('initialize', {
    clientInfo: { name: 'feishu-codex-bridge-probe', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  console.log(`\n=== spawn→initialize: ${Date.now() - mark}ms ===\n`);

  mark = Date.now();
  const th1 = await startEphemeralThread();
  console.log(`\n=== thread/start #1 (含 MCP 启动): ${Date.now() - mark}ms ===\n`);

  mark = Date.now();
  const th2 = await startEphemeralThread();
  console.log(`\n=== thread/start #2 (同进程): ${Date.now() - mark}ms ===\n`);

  const loaded = await request('thread/loaded/list', {});
  console.log(`\n=== loaded threads: ${JSON.stringify(loaded)} (期望含 ${th1.thread.id} 与 ${th2.thread.id}) ===\n`);
}

async function interruptProbe() {
  await request('initialize', {
    clientInfo: { name: 'feishu-codex-bridge-probe', version: '0.0.1' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  const th = await startEphemeralThread();
  const threadId = th.thread.id;

  // ── 第 1 轮：起 turn，~1s 后 interrupt ───────────────────────────────
  const input = [{ type: 'text', text: 'reply with exactly: pong', text_elements: [] }];
  const turnDone = waitNotification((m) => m.method === 'turn/completed', 'turn/completed #1', 120_000);
  const turn1 = request('turn/start', { threadId, input }); // ACK 返回 turn ID；本探针另等通知以测量事件时序
  turn1.catch((err) => console.error(`${ts()} turn/start #1 rejected: ${err.message}`));
  const started = await waitNotification((m) => m.method === 'turn/started', 'turn/started #1');
  const turnId = started.params.turn.id;

  await new Promise((r) => setTimeout(r, 1000));
  console.log(`\n=== 发 turn/interrupt (threadId=${threadId} turnId=${turnId}) ===\n`);
  await request('turn/interrupt', { threadId, turnId });
  const completed = await turnDone;
  const status1 = completed.params?.turn?.status;
  console.log(`\n=== turn #1 终态: turn/completed status=${JSON.stringify(status1)} ===\n`);

  // ── 第 2 轮：同进程同 thread 再跑一轮到自然完成（验证可复用） ────────
  const turn2Done = waitNotification((m) => m.method === 'turn/completed', 'turn/completed #2', 120_000);
  const turn2 = request('turn/start', { threadId, input });
  turn2.catch((err) => console.error(`${ts()} turn/start #2 rejected: ${err.message}`));
  const completed2 = await turn2Done;
  const status2 = completed2.params?.turn?.status;
  console.log(`\n=== turn #2 终态: status=${JSON.stringify(status2)}（同进程复用${status2 === 'completed' ? '成功' : '存疑'}） ===\n`);
}

try {
  if (INTERRUPT_MODE) await interruptProbe();
  else await benchmark();
  console.log('probe done.');
  process.exit(0);
} catch (err) {
  console.error('probe failed:', err);
  process.exit(1);
}
