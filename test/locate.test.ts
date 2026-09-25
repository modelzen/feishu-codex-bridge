import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codexVersion, codexVersionAsync, resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { writeNodeExecutable } from './helpers/node-executable';

// locate 模块级缓存（QW-9）：bin/版本只在成功时缓存、force 强制重探、同步与
// 异步版本探测共享一份缓存。版本 fixture 在各平台运行真实子进程。

const dir = mkdtempSync(join(tmpdir(), 'locate-'));

/** 每次执行都追加计数，验证缓存命中时没有启动另一个进程。 */
function fakeBin(name: string, body: string): { bin: string; runs: () => number } {
  const { bin, script } = writeNodeExecutable(dir, name,
    `require('node:fs').appendFileSync(__filename + '.count', 'run\\n');\n${body}\n`);
  return {
    bin,
    runs: () => {
      try {
        return readFileSync(`${script}.count`, 'utf8').trim().split('\n').length;
      } catch {
        return 0;
      }
    },
  };
}

/** 跑一段代码时临时替换 CODEX_BIN（resolveCodexBin 的最高优先级探测分支）。 */
function withCodexBinEnv<T>(value: string, fn: () => T): T {
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prev;
  }
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveCodexBin 缓存', () => {
  it('显式覆盖立即生效；路径消失时不得回退到其它 Codex', () => {
    const a = join(dir, 'codex-a');
    const b = join(dir, 'codex-b');
    writeFileSync(a, '');
    writeFileSync(b, '');

    expect(withCodexBinEnv(a, () => resolveCodexBin({ force: true }))).toBe(a);
    expect(withCodexBinEnv(b, () => resolveCodexBin())).toBe(b);
    // force 绕过缓存 → 看到新 CODEX_BIN
    expect(withCodexBinEnv(b, () => resolveCodexBin({ force: true }))).toBe(b);
    // 缓存的 bin 被删 → existsSync 复验失败，自动重探
    rmSync(b);
    expect(withCodexBinEnv(b, () => resolveCodexBin())).toBeNull();
    expect(withCodexBinEnv(a, () => resolveCodexBin())).toBe(a);
  });
});

describe('codexVersion / codexVersionAsync 缓存', () => {
  it('成功结果缓存且同步/异步共享；force 重新 spawn', async () => {
    const { bin, runs } = fakeBin('codex with spaces 中文', 'console.log("fake-codex 9.9.9");');

    expect(codexVersion(bin)).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(1);
    // 第二次同步：缓存命中，零 spawn
    expect(codexVersion(bin)).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(1);
    // 异步路径共享同一缓存
    expect(await codexVersionAsync(bin)).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(1);
    // force（DM 体检）重新 spawn
    expect(await codexVersionAsync(bin, { force: true })).toBe('fake-codex 9.9.9');
    expect(runs()).toBe(2);
  });

  it('失败（非零退出）返回 null 且不缓存，下次仍重探', async () => {
    const { bin, runs } = fakeBin('codex-bad', 'process.exit(3);');

    expect(codexVersion(bin)).toBeNull();
    expect(runs()).toBe(1);
    expect(await codexVersionAsync(bin)).toBeNull();
    expect(runs()).toBe(2);
    expect(codexVersion(bin)).toBeNull();
    expect(runs()).toBe(3);
  });

  it('bin 不存在时异步返回 null 而不抛', async () => {
    expect(await codexVersionAsync(join(dir, 'no-such-codex'))).toBeNull();
  });
});

describe('codexVersionAsync 真实子进程', () => {
  it('对 node 自身返回 --version 输出（跨平台冒烟）', async () => {
    expect(await codexVersionAsync(process.execPath, { force: true })).toBe(process.version);
  });
});

describe('desktop and Agent executable selection', () => {
  it('uses the legacy physical root, managed copy and generation pointer with explicit override priority', async () => {
    const { mkdirSync, existsSync } = await import('node:fs');
    const { resolveDataRoot } = await import('../src/config/data-root');
    const home = join(dir, 'legacy-home');
    const root = join(home, '.feishu-codex-bridge');
    const generation = '12345678-1234-1234-1234-123456789012';
    const generationDir = join(root, 'codex-cli', 'releases', generation, 'node_modules', '.bin');
    mkdirSync(generationDir, { recursive: true });
    const legacy = writeNodeExecutable(generationDir, 'codex', 'console.log("codex-cli 1.0.0")').bin;
    writeFileSync(join(root, 'codex-cli', 'current.json'), JSON.stringify({ generation }));
    const context = { home, dataRoot: resolveDataRoot(home).path, env: { PATH: '' } };
    expect(resolveCodexBin(context)).toBe(legacy);
    const managedDir = join(root, 'managed-tools', 'bin');
    mkdirSync(managedDir, { recursive: true });
    const managed = writeNodeExecutable(managedDir, 'codex', 'console.log("codex-cli 2.0.0")').bin;
    expect(resolveCodexBin(context)).toBe(managed);
    expect(await codexVersionAsync(managed, { force: true })).toBe('codex-cli 2.0.0');
    expect(resolveCodexBin({ ...context, env: { PATH: '', CODEX_BIN: legacy } })).toBe(legacy);
    expect(resolveCodexBin({ ...context, env: { PATH: '', CODEX_BIN: join(home, 'missing') } })).toBeNull();
    rmSync(managed);
    expect(resolveCodexBin(context)).toBe(legacy);
    expect(existsSync(join(home, '.vonvon-bridge'))).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('still detects the Codex application bundle without shell PATH', async () => {
    const { mkdirSync, existsSync } = await import('node:fs');
    const home = join(dir, 'bundle-home');
    const resourceDir = join(home, 'Applications', 'Codex.app', 'Contents', 'Resources');
    mkdirSync(resourceDir, { recursive: true });
    const local = writeNodeExecutable(resourceDir, 'codex', 'console.log("codex-cli 3.0.0")').bin;
    const global = '/Applications/Codex.app/Contents/Resources/codex';
    expect(resolveCodexBin({ home, dataRoot: join(home, '.vonvon-bridge'), env: { PATH: '' } })).toBe(existsSync(global) ? global : local);
  });
});
