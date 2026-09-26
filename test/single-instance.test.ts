import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireSingleInstanceLock, BridgeAlreadyRunningError } from '../src/core/single-instance';

// ── helpers ─────────────────────────────────────────────────────────

/** 起一个真实存活的 node 子进程（给「活体持有者 / pid 复用」当道具）。 */
function spawnSleeper(ms = 8_000): ChildProcess {
  return spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], { stdio: 'ignore' });
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((r) => child.once('exit', () => r()));
}

const rec = (pid: number, appId = 'app_a', startedAt = Date.now()): string =>
  `${JSON.stringify({ pid, appId, startedAt })}\n`;

// ── 协议逻辑（同进程）────────────────────────────────────────────────

describe('acquireSingleInstanceLock 协议逻辑', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'si-lock-'));
    file = join(dir, 'processes.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('抢锁 → 写入本进程记录；release 后文件移除、可再抢', () => {
    const release = acquireSingleInstanceLock('app_a', file);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; appId: string };
    expect(onDisk.pid).toBe(process.pid);
    expect(onDisk.appId).toBe('app_a');
    release();
    expect(existsSync(file)).toBe(false);
    acquireSingleInstanceLock('app_a', file)();
  });

  it('自己 pid 的残留记录不挡道（重抢成功）', () => {
    writeFileSync(file, rec(process.pid));
    expect(() => acquireSingleInstanceLock('app_a', file)()).not.toThrow();
  });

  it('已死 pid 的残留锁 → 接管', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    await waitExit(child);
    writeFileSync(file, rec(pid));
    expect(() => acquireSingleInstanceLock('app_a', file)()).not.toThrow();
  });

  it('活体持有者 → BridgeAlreadyRunningError 拒启', async () => {
    const child = spawnSleeper();
    try {
      writeFileSync(file, rec(child.pid!));
      expect(() => acquireSingleInstanceLock('app_a', file)).toThrow(BridgeAlreadyRunningError);
    } finally {
      child.kill('SIGKILL');
      await waitExit(child);
    }
  });

  it('pid 复用：POSIX 接管晚启动的进程，Windows 缺少启动时间时保守拒绝', async () => {
    const child = spawnSleeper();
    try {
      // 记录声称三天前就启动了，而这个 pid 的进程刚出生 → 必是复用 pid 的无关进程
      writeFileSync(file, rec(child.pid!, 'app_a', Date.now() - 3 * 86_400_000));
      if (process.platform === 'win32') {
        expect(() => acquireSingleInstanceLock('app_a', file)).toThrow(BridgeAlreadyRunningError);
      } else {
        expect(() => acquireSingleInstanceLock('app_a', file)()).not.toThrow();
      }
    } finally {
      child.kill('SIGKILL');
      await waitExit(child);
    }
  });

  it('损坏的锁文件 → fail-closed（报错而非放行）', () => {
    writeFileSync(file, '{half-written');
    expect(() => acquireSingleInstanceLock('app_a', file)).toThrow(/损坏/);
    expect(() => acquireSingleInstanceLock('app_a', file)).not.toThrow(BridgeAlreadyRunningError);
  });

  it('超龄空锁文件（写入者 open 后被 SIGKILL 的残留）→ 摘掉接管，不再永久卡死', () => {
    writeFileSync(file, '');
    const old = (Date.now() - 60_000) / 1000; // mtime 一分钟前 —— 远超瞬态间隙
    utimesSync(file, old, old);
    expect(() => acquireSingleInstanceLock('app_a', file)()).not.toThrow();
  });

  it('新鲜空锁文件（抢占者 open→write 间隙）→ 按瞬态重试，耗尽后给可执行指引', () => {
    writeFileSync(file, ''); // mtime = now，整个重试期内都「新鲜」
    expect(() => acquireSingleInstanceLock('app_a', file)).toThrow(/手动删除/);
  });

  it('其他 app 的残留记录不挡道（沿旧覆盖语义）', async () => {
    const child = spawnSleeper();
    try {
      writeFileSync(file, rec(child.pid!, 'app_other'));
      expect(() => acquireSingleInstanceLock('app_a', file)()).not.toThrow();
    } finally {
      child.kill('SIGKILL');
      await waitExit(child);
    }
  });
});

// ── 真并发：多进程同时抢同一把锁（F4 的 TOCTOU 路径）────────────────

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const harnessDir = mkdtempSync(join(tmpdir(), 'fcb-si-test-'));
const require = createRequire(import.meta.url);

const DRIVER = `'use strict';
const { existsSync } = require('node:fs');
const { acquireSingleInstanceLock } = require('./single-instance.cjs');
const [, , lockFile, goFile] = process.argv;
const sab = new Int32Array(new SharedArrayBuffer(4));
const deadline = Date.now() + 10000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) { console.log('TIMEOUT'); process.exit(2); }
  Atomics.wait(sab, 0, 0, 5);
}
try {
  acquireSingleInstanceLock('cli_race_app', lockFile);
  console.log('ACQUIRED');
  setTimeout(() => process.exit(0), 1500); // 持锁等兄弟进程探测完
} catch (err) {
  console.log('REJECTED:' + (err && err.name));
  process.exit(0);
}
`;

describe('并发多进程抢锁', () => {
  beforeAll(() => {
    const compile = (srcPath: string, outName: string, rewrites: Record<string, string> = {}): void => {
      let src = readFileSync(join(root, srcPath), 'utf8');
      for (const [from, to] of Object.entries(rewrites)) src = src.replaceAll(`'${from}'`, () => JSON.stringify(to));
      const out = ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      }).outputText;
      writeFileSync(join(harnessDir, outName), out);
    };
    compile('src/config/data-root.ts', 'data-root.cjs');
    compile('src/config/data-compatibility.ts', 'data-compatibility.cjs');
    compile('src/config/paths.ts', 'paths.cjs', { './data-root': './data-root.cjs', './data-compatibility': './data-compatibility.cjs' });
    compile('src/platform/spawn.ts', 'spawn.cjs', {
      'cross-spawn': require.resolve('cross-spawn').replaceAll('\\', '/'),
    });
    compile('src/core/single-instance.ts', 'single-instance.cjs', {
      '../config/paths': './paths.cjs',
      '../platform/spawn': './spawn.cjs',
    });
    writeFileSync(join(harnessDir, 'driver.cjs'), DRIVER);
  });
  afterAll(() => rmSync(harnessDir, { recursive: true, force: true }));

  it('4 进程同时抢：恰一个拿到，其余 BridgeAlreadyRunningError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'si-race-'));
    const lockFile = join(dir, 'processes.json');
    const goFile = join(dir, 'go');
    try {
      const children = Array.from({ length: 4 }, () =>
        spawn(process.execPath, [join(harnessDir, 'driver.cjs'), lockFile, goFile], {
          stdio: ['ignore', 'pipe', 'inherit'],
        }),
      );
      const outputs = children.map((c) => {
        let buf = '';
        c.stdout!.on('data', (d: Buffer) => (buf += d.toString()));
        return () => buf;
      });
      await Promise.all(children.map((c) => new Promise((r) => c.once('spawn', r))));
      await new Promise((r) => setTimeout(r, 300)); // 都进入 go 轮询后再发令
      writeFileSync(goFile, 'go');
      await Promise.all(children.map((c) => waitExit(c)));
      const lines = outputs.map((f) => f().trim());
      expect(lines.filter((l) => l === 'ACQUIRED')).toHaveLength(1);
      expect(lines.filter((l) => l === 'REJECTED:BridgeAlreadyRunningError'), JSON.stringify(lines)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
