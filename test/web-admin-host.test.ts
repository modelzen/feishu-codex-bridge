import { rmSync, existsSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths, botDir, useBotDir } from '../src/config/paths';
import { loadBots, saveBots } from '../src/config/bots';
import { addProject } from '../src/project/registry';
import { upsertSession } from '../src/bot/session-store';
import { setSecret, listSecretIds } from '../src/config/keystore';
import { secretKeyForApp } from '../src/config/schema';
import { createAdminService, createReadonlyAdminService, NotWiredYetError } from '../src/admin/service';

// 临时目录隔离 ~/.feishu-codex-bridge（同 web-admin-service.test 的做法）。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'web-admin-host-test-'));
  let currentBotDir = appDir;
  const botDir = (appId: string): string => join(appDir, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return {
      dir,
      configFile: join(dir, 'config.json'),
      sessionsFile: join(dir, 'sessions.json'),
      projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'),
    };
  };
  return {
    botDir,
    botPaths,
    useBotDir: (appId: string): void => {
      currentBotDir = botDir(appId);
    },
    paths: {
      appDir,
      cacheDir: appDir,
      botsFile: join(appDir, 'bots.json'),
      webConsoleFile: join(appDir, 'web-console.json'),
      secretsFile: join(appDir, 'secrets.enc'),
      keystoreSaltFile: join(appDir, '.keystore.salt'),
      get configFile(): string {
        return join(currentBotDir, 'config.json');
      },
      get sessionsFile(): string {
        return join(currentBotDir, 'sessions.json');
      },
      get projectsFile(): string {
        return join(currentBotDir, 'projects.json');
      },
      get processesFile(): string {
        return join(currentBotDir, 'processes.json');
      },
      projectsRootDir: join(appDir, 'projects'),
    },
  };
});

// service 适配器：daemon 状态聚合的输入，固定 mock（绝不碰真 launchctl）。
const statusMock = vi.fn();
vi.mock('../src/service/adapter', () => ({
  getServiceAdapter: () => ({ status: statusMock }),
  isServiceRunning: () => false,
}));

// 升级检测：固定 mock（绝不打真 npm registry）。
vi.mock('../src/service/update', () => ({
  checkUpdate: vi.fn(async () => ({ current: '0.3.11', latest: '0.4.0', hasUpdate: true, dev: false })),
  readUpdateStatus: vi.fn(() => null),
  clearUpdateStatus: vi.fn(() => undefined),
}));

const BOT_A = 'cli_hostA';
const BOT_B = 'cli_hostB';

async function seedTwoBots(): Promise<void> {
  await saveBots({
    version: 1,
    current: BOT_A,
    bots: [
      { name: 'alpha', appId: BOT_A, tenant: 'feishu', createdAt: 1, active: true },
      { name: 'beta', appId: BOT_B, tenant: 'lark', createdAt: 2, active: true },
    ],
  });
}

beforeEach(async () => {
  statusMock.mockReset();
  // 清掉上个用例可能留下的 bot 状态目录（项目/会话/密钥），保证每个用例从干净态起。
  rmSync(botDir(BOT_A), { recursive: true, force: true });
  rmSync(botDir(BOT_B), { recursive: true, force: true });
  rmSync(paths.secretsFile, { force: true });
  await seedTwoBots();
});

afterAll(() => {
  rmSync(paths.appDir, { recursive: true, force: true });
});

describe('AdminService · getDaemonStatus（聚合 service 状态，mock service 模块）', () => {
  it('桌面宿主状态 override 优先，完全绕过旧 service adapter', async () => {
    const desktopStatus = {
      installed: true,
      running: true,
      selfHosted: false,
      pid: 4321,
      version: 'desktop-1.0.0',
      supported: true,
    };
    const svc = createAdminService({
      daemonStatus: async () => desktopStatus,
    });

    await expect(svc.getDaemonStatus()).resolves.toEqual(desktopStatus);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('daemon 进程内：注入 daemonStartedAt → uptimeMs 有值、supported=true', async () => {
    statusMock.mockResolvedValue({
      platformName: 'launchd (macOS)',
      installed: true,
      running: true,
      servicePath: '/x.plist',
      stdoutPath: '/o',
      stderrPath: '/e',
      pid: '999',
      lastExit: '0',
      raw: '',
    });
    const svc = createAdminService({ daemonStartedAt: Date.now() - 5000 });
    const d = await svc.getDaemonStatus();
    expect(d.installed).toBe(true);
    expect(d.running).toBe(true);
    expect(d.pid).toBe(999);
    expect(d.supported).toBe(true);
    expect(d.uptimeMs).toBeGreaterThanOrEqual(5000);
  });

  it('service 适配器抛错（未支持平台）→ supported=false，绝不让接口 500', async () => {
    statusMock.mockRejectedValue(new Error('平台不支持'));
    const svc = createAdminService();
    const d = await svc.getDaemonStatus();
    expect(d.supported).toBe(false);
    expect(d.running).toBe(false);
  });
});

describe('AdminService · restartDaemon / applyUpdate（detached helper 注入）', () => {
  it('只读预览（无注入）→ 抛 NotWiredYetError', async () => {
    const svc = createAdminService();
    await expect(svc.restartDaemon()).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(svc.applyUpdate()).rejects.toBeInstanceOf(NotWiredYetError);
  });

  it('daemon 内：调用注入的 helper 触发器（不真跑，只验证被调一次）', async () => {
    const restart = vi.fn();
    const update = vi.fn();
    const svc = createAdminService({ restartDaemon: restart, applyUpdate: update });
    await svc.restartDaemon();
    await svc.applyUpdate();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('startDaemon / stopDaemon：无注入 → NotWiredYetError；有注入 → 触发对应 helper', async () => {
    const bare = createAdminService();
    await expect(bare.startDaemon()).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(bare.stopDaemon()).rejects.toBeInstanceOf(NotWiredYetError);
    const start = vi.fn();
    const stop = vi.fn();
    const svc = createAdminService({ startDaemon: start, stopDaemon: stop });
    await svc.startDaemon();
    await svc.stopDaemon();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('createReadonlyAdminService：只放行 startDaemon（停止 daemon 时唯一该能做的宿主级动作），stop/restart/update 仍 501', async () => {
    const start = vi.fn();
    const svc = createReadonlyAdminService({ startDaemon: start });
    await svc.startDaemon();
    expect(start).toHaveBeenCalledTimes(1);
    // 其余生命周期动作在只读态不放行
    await expect(svc.stopDaemon()).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(svc.restartDaemon()).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(svc.applyUpdate()).rejects.toBeInstanceOf(NotWiredYetError);
  });

  it('checkUpdate：复用 service/update（mock）→ hasUpdate', async () => {
    const svc = createAdminService();
    const u = await svc.checkUpdate();
    expect(u.hasUpdate).toBe(true);
    expect(u.latest).toBe('0.4.0');
  });

  it('桌面更新 override 优先，并等待异步动作完成', async () => {
    const calls: string[] = [];
    const svc = createAdminService({
      checkUpdate: async () => ({
        current: 'desktop-1.0.0',
        latest: 'desktop-1.1.0',
        hasUpdate: true,
        dev: false,
      }),
      updateStatus: () => ({
        phase: 'installing',
        at: 123,
      }),
      clearUpdateStatus: () => calls.push('clear'),
      applyUpdate: async () => {
        await Promise.resolve();
        calls.push('apply');
      },
    });

    expect((await svc.checkUpdate()).current).toBe('desktop-1.0.0');
    expect(svc.updateStatus()?.phase).toBe('installing');
    await svc.applyUpdate();
    expect(calls).toEqual(['clear', 'apply']);
  });
});

describe('AdminService · setBotEnabled（活跃集 enabled 落盘）', () => {
  it('桌面宿主 override 优先，不直写 upstream bots.json', async () => {
    const before = await loadBots();
    const route = vi.fn(async () => ({ ok: true as const }));
    const svc = createAdminService({ setBotEnabled: route });

    await expect(svc.setBotEnabled(BOT_B, false)).resolves.toEqual({ ok: true });
    expect(route).toHaveBeenCalledWith(BOT_B, false);
    expect(await loadBots()).toEqual(before);
  });

  it('停用一个 bot → bots.json 的 active=false（其余不变）', async () => {
    const svc = createAdminService();
    const r = await svc.setBotEnabled(BOT_B, false);
    expect(r.ok).toBe(true);
    const reg = await loadBots();
    expect(reg.bots.find((b) => b.appId === BOT_A)!.active).toBe(true);
    expect(reg.bots.find((b) => b.appId === BOT_B)!.active).toBe(false);
  });

  it('重新启用 → active=true', async () => {
    const svc = createAdminService();
    await svc.setBotEnabled(BOT_B, false);
    const r = await svc.setBotEnabled(BOT_B, true);
    expect(r.ok).toBe(true);
    expect((await loadBots()).bots.find((b) => b.appId === BOT_B)!.active).toBe(true);
  });

  it('不存在的 bot → { ok:false, reason }', async () => {
    const svc = createAdminService();
    const r = await svc.setBotEnabled('cli_nope', true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不存在');
  });
});

describe('AdminService · deleteBot（删除 + 保护分支）', () => {
  it('桌面宿主 override 优先，不直删 upstream registry/keystore/目录', async () => {
    useBotDir(BOT_B);
    await addProject({ name: 'keep', chatId: 'oc_keep', cwd: '/tmp/keep', blank: false, createdAt: 1 });
    await setSecret(secretKeyForApp(BOT_B), 'secret-B');
    const route = vi.fn(async () => ({ ok: true as const }));
    const svc = createAdminService({ deleteBot: route });

    await expect(svc.deleteBot(BOT_B)).resolves.toEqual({ ok: true });
    expect(route).toHaveBeenCalledWith(BOT_B);
    expect((await loadBots()).bots.some((bot) => bot.appId === BOT_B)).toBe(true);
    expect(await listSecretIds()).toContain(secretKeyForApp(BOT_B));
    expect(existsSync(botDir(BOT_B))).toBe(true);
  });

  it('唯一 bot 拒删（给清晰提示），注册表/密钥/目录都不动', async () => {
    await saveBots({ version: 1, current: BOT_A, bots: [{ name: 'alpha', appId: BOT_A, tenant: 'feishu', createdAt: 1, active: true }] });
    await setSecret(secretKeyForApp(BOT_A), 'secret-A');
    const svc = createAdminService();
    const r = await svc.deleteBot(BOT_A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('唯一');
    expect((await loadBots()).bots).toHaveLength(1);
    expect(await listSecretIds()).toContain(secretKeyForApp(BOT_A));
  });

  it('运行中且有活跃会话的 bot 拒删（liveStatus 注入 running + 写 session 记录）', async () => {
    useBotDir(BOT_B);
    await addProject({ name: 'p-b', chatId: 'oc_b', cwd: '/tmp/p-b', blank: false, createdAt: 1 });
    await upsertSession({
      threadId: 't1', chatId: 'oc_b', cwd: '/tmp/p-b', sessionId: 's1',
      backend: 'codex-appserver', summary: '进行中', createdAt: 1, updatedAt: 2,
    });
    const svc = createAdminService({
      liveStatus: async (id) => (id === BOT_B ? { running: true, pid: 123 } : undefined),
    });
    const r = await svc.deleteBot(BOT_B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('活跃会话');
    expect((await loadBots()).bots.some((b) => b.appId === BOT_B)).toBe(true);
  });

  it('成功删除：注册表项 + keystore 密钥 + 状态目录全清', async () => {
    useBotDir(BOT_B);
    await addProject({ name: 'p-b', chatId: 'oc_b', cwd: '/tmp/p-b', blank: false, createdAt: 1 });
    await setSecret(secretKeyForApp(BOT_B), 'secret-B');
    expect(existsSync(botDir(BOT_B))).toBe(true);

    // 未运行（无 liveStatus、无锁文件）→ 保护②不触发，可删。
    const svc = createAdminService();
    const r = await svc.deleteBot(BOT_B);
    expect(r.ok).toBe(true);
    const reg = await loadBots();
    expect(reg.bots.some((b) => b.appId === BOT_B)).toBe(false);
    expect(await listSecretIds()).not.toContain(secretKeyForApp(BOT_B));
    expect(existsSync(botDir(BOT_B))).toBe(false);
  });
});

describe('AdminService · hostDoctor（体检聚合形状）', () => {
  it('宿主机域 + 后端探测都在，且绝不抛错', async () => {
    const svc = createAdminService();
    const h = await svc.hostDoctor();
    expect(h.node).toBe(process.version);
    expect(typeof h.platform).toBe('string');
    expect(h.appDir).toBe(paths.appDir); // mock 下 = 临时目录
    expect(typeof h.logBytes).toBe('number');
    expect(Array.isArray(h.backends)).toBe(true);
    expect(h.backends.length).toBeGreaterThan(0);
    expect(h.backends[0]).toHaveProperty('id');
    expect(h.backends[0]).toHaveProperty('ok');
  });
});
