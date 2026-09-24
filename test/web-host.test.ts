import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { paths } from '../src/config/paths';
import {
  buildDaemonControlCommand,
  collectHostDoctor,
  toDaemonStatus,
} from '../src/admin/host';
import type { ServiceStatus } from '../src/service/common';

describe('host · toDaemonStatus（service 快照 → daemon 状态，纯函数）', () => {
  const base: ServiceStatus = {
    platformName: 'launchd (macOS)',
    installed: true,
    running: true,
    servicePath: '/x/y.plist',
    stdoutPath: '/x/out.log',
    stderrPath: '/x/err.log',
    pid: '4242',
    lastExit: '0',
    raw: '',
  };

  it('已安装+在跑：归一字段 + uptime 按 startedAt 算 + supported=true', () => {
    const d = toDaemonStatus({ status: base, version: '0.3.11', startedAt: 1000, now: 61_000 });
    expect(d.installed).toBe(true);
    expect(d.running).toBe(true);
    expect(d.pid).toBe(4242); // string → number
    expect(d.version).toBe('0.3.11');
    expect(d.uptimeMs).toBe(60_000);
    expect(d.supported).toBe(true);
    expect(d.platformName).toBe('launchd (macOS)');
    expect(d.selfHosted).toBe(false); // service manager 托管，非手动
  });

  it('未传 startedAt（只读预览进程）→ uptimeMs undefined', () => {
    const d = toDaemonStatus({ status: base, version: '0.3.11' });
    expect(d.uptimeMs).toBeUndefined();
  });

  it('手动 nohup 起的 daemon（startedAt 有值但 service manager 报未运行）→ running=true + selfHosted=true', () => {
    const manual: ServiceStatus = { ...base, installed: false, running: false, pid: undefined };
    const d = toDaemonStatus({ status: manual, version: '0.3.11', startedAt: 1000, now: 5000 });
    expect(d.running).toBe(true); // 内嵌 web 在响应即证明 daemon 活着
    expect(d.selfHosted).toBe(true); // 但未注册为开机服务
    expect(d.installed).toBe(false);
  });

  it('status undefined（未支持平台）→ supported=false、installed/running 兜底 false', () => {
    const d = toDaemonStatus({ status: undefined, version: '0.3.11' });
    expect(d.supported).toBe(false);
    expect(d.installed).toBe(false);
    expect(d.running).toBe(false);
    expect(d.pid).toBeUndefined();
  });

  it('未在跑但已安装：running=false、installed=true', () => {
    const d = toDaemonStatus({ status: { ...base, running: false, pid: undefined }, version: '0.3.11' });
    expect(d.installed).toBe(true);
    expect(d.running).toBe(false);
    expect(d.pid).toBeUndefined();
  });
});

describe('host · buildDaemonControlCommand（detached helper 命令构建，只验生成不真跑）', () => {
  it('restart：node + binPath + __daemon-control restart', () => {
    const { command, args } = buildDaemonControlCommand('restart', '/pkg/bin/feishu-codex-bridge.mjs', '/usr/bin/node');
    expect(command).toBe('/usr/bin/node');
    expect(args).toEqual(['/pkg/bin/feishu-codex-bridge.mjs', '__daemon-control', 'restart']);
  });

  it('update：固定 action 形参，无任意字符串拼接进 shell（无注入面）', () => {
    const { args } = buildDaemonControlCommand('update', '/pkg/bin/x.mjs', '/usr/bin/node');
    expect(args).toEqual(['/pkg/bin/x.mjs', '__daemon-control', 'update']);
  });

  it('start / stop：同样只是固定 action 形参（service install / uninstall 的 detached 执行）', () => {
    expect(buildDaemonControlCommand('start', '/pkg/bin/x.mjs', '/usr/bin/node').args).toEqual([
      '/pkg/bin/x.mjs',
      '__daemon-control',
      'start',
    ]);
    expect(buildDaemonControlCommand('stop', '/pkg/bin/x.mjs', '/usr/bin/node').args).toEqual([
      '/pkg/bin/x.mjs',
      '__daemon-control',
      'stop',
    ]);
  });

  it('缺省 binPath/nodePath 时回退到当前 Node 与解析出的 bin（绝对路径）', () => {
    const { command, args } = buildDaemonControlCommand('restart');
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/feishu-codex-bridge\.mjs$/);
    expect(args.slice(1)).toEqual(['__daemon-control', 'restart']);
  });
});

describe('host · collectHostDoctor（宿主机域聚合，绝不抛错）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'host-doctor-test-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('Node/平台/路径形状齐全 + 日志体量递归累加字节', async () => {
    const logsDir = join(tmp, 'logs');
    mkdirSync(join(logsDir, 'sub'), { recursive: true });
    writeFileSync(join(logsDir, 'a.log'), 'x'.repeat(100));
    writeFileSync(join(logsDir, 'sub', 'b.log'), 'y'.repeat(50));
    const h = await collectHostDoctor(logsDir);
    expect(h.node).toBe(process.version);
    expect(typeof h.platform).toBe('string');
    expect(typeof h.arch).toBe('string');
    expect(h.appDir).toBe(paths.appDir);
    expect(h.logsDir).toBe(logsDir);
    expect(h.logBytes).toBe(150); // 100 + 50（含子目录）
    expect(h.version).toBeTruthy();
  });

  it('日志目录不存在 → logBytes 0，不抛错', async () => {
    const h = await collectHostDoctor(join(tmp, 'nope'));
    expect(h.logBytes).toBe(0);
  });
});
