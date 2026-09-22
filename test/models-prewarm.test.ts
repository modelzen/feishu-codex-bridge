import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { writeNodeExecutable } from './helpers/node-executable';

// 启动预热（createOrchestrator 末尾的 void backend.listModels()）的安全前提：
// listModels 失败时返回 STATIC_MODELS 兜底但**不写缓存**——否则预热一旦撞上
// codex 暂不可用，fallback 会被钉死整个 daemon 生命周期。这里验证同一 backend
// 实例「失败 → 恢复 → 拿到真实列表 → 此后走缓存」的完整链路。

/** 起不来的假 codex：spawn 即退出，connect 的 initialize 必然被拒。 */
const BROKEN_SERVER = 'process.exit(7);';

/** 正常应答 initialize / model/list 的假 codex app-server；每次启动在
 * `__filename + .count` 追加一行，用于断言缓存命中后不再 spawn。 */
const WORKING_SERVER = `#!/usr/bin/env node
require('fs').appendFileSync(__filename + '.count', 'run\\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.id !== 'number') continue; // notification — ignore
    const result =
      msg.method === 'model/list'
        ? { data: [{ id: 'test-model-live', isDefault: true, defaultReasoningEffort: 'high' }] }
        : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
  }
});
setInterval(() => {}, 1 << 30); // stay alive until killed
`;

const dir = mkdtempSync(join(tmpdir(), 'models-prewarm-'));
const { bin, script } = writeNodeExecutable(dir, 'codex', BROKEN_SERVER);
let prevEnv: string | undefined;

beforeAll(() => {
  prevEnv = process.env.CODEX_BIN;
  process.env.CODEX_BIN = bin;
});

afterAll(async () => {
  await shutdownResidentClients();
  if (prevEnv === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = prevEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe('listModels 预热不钉死 fallback（QW-2）', () => {
  it('失败返回 STATIC_MODELS 但不写缓存；恢复后重试拿真实列表，此后走缓存', async () => {
    const backend = new CodexAppServerBackend();

    // codex 起不来 → 静态兜底
    const fallback = await backend.listModels();
    expect(fallback.map((m) => m.id)).toEqual(['gpt-5.5']);

    // 同一实例、同一路径换成正常 server：若失败时误写了缓存，这里仍会是兜底
    writeNodeExecutable(dir, 'codex', WORKING_SERVER);
    const live = await backend.listModels();
    expect(live.map((m) => m.id)).toEqual(['test-model-live']);
    expect(live[0]!.defaultEffort).toBe('high');

    // 成功后缓存生效：再调用直接返回同一数组，server 没有第二次 spawn
    const again = await backend.listModels();
    expect(again).toBe(live);
    expect(readFileSync(`${script}.count`, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
