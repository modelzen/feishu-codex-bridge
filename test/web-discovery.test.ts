import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearWebConsole, publishWebConsole, readWebConsole } from '../src/web/discovery';

// 全部走显式 file 参数（临时目录），绝不碰真实 ~/.feishu-codex-bridge。
const dir = mkdtempSync(join(tmpdir(), 'web-discovery-test-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('web 控制台发现文件（daemon ↔ `web` 命令的接头）', () => {
  it('publish → 0600 权限 + read 原样读回（pid 活体 = 本进程）', () => {
    const file = join(dir, 'a.json');
    publishWebConsole({ port: 7866, token: 'tok-1', pid: process.pid, startedAt: 42 }, file);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600); // token 文件仅属主可读
    }
    expect(readWebConsole(file)).toEqual({ port: 7866, token: 'tok-1', pid: process.pid, startedAt: 42 });
  });

  it('重复 publish 覆盖旧记录且权限保持 0600（unlink 后重建）', () => {
    const file = join(dir, 'b.json');
    publishWebConsole({ port: 1, token: 'old', pid: process.pid, startedAt: 1 }, file);
    publishWebConsole({ port: 2, token: 'new', pid: process.pid, startedAt: 2 }, file);
    expect(readWebConsole(file)?.token).toBe('new');
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('持有 pid 已死 → 视为不存在（daemon 崩溃残留绝不把陈旧 token 当真）', () => {
    const file = join(dir, 'c.json');
    publishWebConsole({ port: 7866, token: 'tok', pid: 99999999, startedAt: 1 }, file);
    expect(readWebConsole(file)).toBeUndefined();
  });

  it('缺失 / 损坏 / 字段不全 → undefined（绝不抛错）', () => {
    expect(readWebConsole(join(dir, 'missing.json'))).toBeUndefined();
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{half');
    expect(readWebConsole(broken)).toBeUndefined();
    const partial = join(dir, 'partial.json');
    writeFileSync(partial, JSON.stringify({ port: 7866 }));
    expect(readWebConsole(partial)).toBeUndefined();
  });

  it('clear 只删本进程写的记录（别的 daemon 的记录不许误删）', () => {
    const mine = join(dir, 'mine.json');
    publishWebConsole({ port: 7866, token: 't', pid: process.pid, startedAt: 1 }, mine);
    clearWebConsole(mine);
    expect(readWebConsole(mine)).toBeUndefined();

    const theirs = join(dir, 'theirs.json');
    // This tests ownership-based deletion, not whether an OS-specific PID is alive.
    const other = { port: 7866, token: 't2', pid: process.pid + 1, startedAt: 1 };
    writeFileSync(theirs, JSON.stringify(other));
    clearWebConsole(theirs);
    expect(JSON.parse(readFileSync(theirs, 'utf8'))).toEqual(other); // 没被误删
  });
});
