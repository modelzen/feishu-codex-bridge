import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codexVersion, codexVersionAsync, resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { paths } from '../src/config/paths';

// locate 模块级缓存（QW-9）：bin/版本只在成功时缓存、force 强制重探、同步与
// 异步版本探测共享一份缓存。版本 fixture 是 POSIX shebang 脚本——Windows 上
// 跑不了，对应组跳过（缓存逻辑本身平台无关）。

const dir = mkdtempSync(join(tmpdir(), 'locate-'));

/** 每次被执行都在 `$0.count` 追加一行，echo 一个固定版本号。 */
function fakeBin(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\necho run >> "$0.count"\n${body}\n`, { mode: 0o755 });
  return p;
}

function runs(bin: string): number {
  try {
    return readFileSync(`${bin}.count`, 'utf8').trim().split('\n').length;
  } catch {
    return 0;
  }
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
  it.skipIf(
    process.platform !== 'darwin' || !existsSync('/opt/homebrew/bin/codex'),
  )('在 Finder 启动的精简 PATH 下仍能识别 Homebrew Codex', () => {
    const previousPath = process.env.PATH;
    const previousManagedCodexBin = paths.managedCodexBin;
    const previousCodexCliBinDir = paths.codexCliBinDir;
    process.env.PATH = '/usr/bin:/bin';
    paths.managedCodexBin = undefined;
    paths.codexCliBinDir = join(dir, 'missing-private-install');
    try {
      expect(withCodexBinEnv('', () => resolveCodexBin({ force: true }))).toBe(
        '/opt/homebrew/bin/codex',
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      paths.managedCodexBin = previousManagedCodexBin;
      paths.codexCliBinDir = previousCodexCliBinDir;
    }
  });

  it('优先识别 Vonvon 桌面托管的 Codex', () => {
    const managed = join(dir, 'managed-codex');
    writeFileSync(managed, '');
    const previous = paths.managedCodexBin;
    paths.managedCodexBin = managed;
    try {
      expect(withCodexBinEnv('', () => resolveCodexBin({ force: true }))).toBe(managed);
    } finally {
      paths.managedCodexBin = previous;
    }
  });

  it('命中后不重探；force 重探；缓存路径消失则自动失效', () => {
    const a = join(dir, 'codex-a');
    const b = join(dir, 'codex-b');
    writeFileSync(a, '');
    writeFileSync(b, '');

    expect(withCodexBinEnv(a, () => resolveCodexBin({ force: true }))).toBe(a);
    // 环境换了但缓存仍有效（路径还存在）→ 不重探
    expect(withCodexBinEnv(b, () => resolveCodexBin())).toBe(a);
    // force 绕过缓存 → 看到新 CODEX_BIN
    expect(withCodexBinEnv(b, () => resolveCodexBin({ force: true }))).toBe(b);
    // 缓存的 bin 被删 → existsSync 复验失败，自动重探
    rmSync(b);
    expect(withCodexBinEnv(a, () => resolveCodexBin())).toBe(a);
  });
});

describe.skipIf(process.platform === 'win32')('codexVersion / codexVersionAsync 缓存', () => {
  it('uses a managed CLI sibling Node even when the host PATH has no Node.js', async () => {
    const isolatedDirectory = join(dir, 'managed-bin');
    const node = join(isolatedDirectory, 'node');
    const bin = join(isolatedDirectory, 'codex');
    mkdirSync(isolatedDirectory, { recursive: true });
    writeFileSync(node, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, {
      mode: 0o755,
    });
    writeFileSync(
      bin,
      '#!/usr/bin/env node\nprocess.stdout.write("managed-codex 10.0.0\\n");\n',
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      expect(codexVersion(bin, { force: true })).toBe('managed-codex 10.0.0');
      expect(await codexVersionAsync(bin, { force: true })).toBe('managed-codex 10.0.0');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('成功结果缓存且同步/异步共享；force 重新 spawn', async () => {
    const bin = fakeBin('codex-ok', 'echo "fake-codex 9.9.9"');

    expect(codexVersion(bin)).toBe('fake-codex 9.9.9');
    expect(runs(bin)).toBe(1);
    // 第二次同步：缓存命中，零 spawn
    expect(codexVersion(bin)).toBe('fake-codex 9.9.9');
    expect(runs(bin)).toBe(1);
    // 异步路径共享同一缓存
    expect(await codexVersionAsync(bin)).toBe('fake-codex 9.9.9');
    expect(runs(bin)).toBe(1);
    // force（DM 体检）重新 spawn
    expect(await codexVersionAsync(bin, { force: true })).toBe('fake-codex 9.9.9');
    expect(runs(bin)).toBe(2);
  });

  it('失败（非零退出）返回 null 且不缓存，下次仍重探', async () => {
    const bin = fakeBin('codex-bad', 'exit 3');

    expect(codexVersion(bin)).toBeNull();
    expect(runs(bin)).toBe(1);
    expect(await codexVersionAsync(bin)).toBeNull();
    expect(runs(bin)).toBe(2);
    expect(codexVersion(bin)).toBeNull();
    expect(runs(bin)).toBe(3);
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
