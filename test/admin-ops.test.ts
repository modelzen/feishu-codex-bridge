import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../src/config/paths';
import { addProject, getProjectByName, removeProject } from '../src/project/registry';
import {
  AdminWriteError,
  createAppPreferencesWriter,
  createAdminWriteExecutor,
  performBackendSwitch,
  performSetAutoCompact,
  performSetCompletionReminder,
  performSetNoMention,
  performSetPermissionMode,
  probeBackends as opsProbeBackends,
  runAdminWriteOp,
  validateBackendSwitch as opsValidateBackendSwitch,
} from '../src/admin/ops';
import type { AppConfig } from '../src/config/schema';
import {
  BACKEND_PROBE_TIMEOUT_MS as hmTimeout,
  probeBackends as hmProbeBackends,
  validateBackendSwitch as hmValidateBackendSwitch,
} from '../src/bot/handle-message';
import type { AgentBackend } from '../src/agent/types';

// 写操作单测一律在临时目录里落盘（mock paths），绝不碰真实 ~/.feishu-codex-bridge。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'admin-ops-test-'));
  return {
    botDir: (appId: string) => join(appDir, 'bots', appId),
    botPaths: (appId: string) => ({
      dir: join(appDir, 'bots', appId),
      configFile: join(appDir, 'bots', appId, 'config.json'),
      sessionsFile: join(appDir, 'bots', appId, 'sessions.json'),
      projectsFile: join(appDir, 'bots', appId, 'projects.json'),
      processesFile: join(appDir, 'bots', appId, 'processes.json'),
    }),
    useBotDir: () => undefined,
    paths: {
      appDir,
      cacheDir: appDir,
      botsFile: join(appDir, 'bots.json'),
      configFile: join(appDir, 'config.json'),
      sessionsFile: join(appDir, 'sessions.json'),
      projectsFile: join(appDir, 'projects.json'),
      processesFile: join(appDir, 'processes.json'),
      projectsRootDir: join(appDir, 'projects'),
      webConsoleFile: join(appDir, 'web-console.json'),
    },
  };
});

// performSetPermissionMode 的「后端档位兼容守门」直接从 catalog 读 supportedModes
// （非 backendFor 注入），故用 mock 给真实 catalog 追加一个泛化的「仅 full」后端条目
// 'fake-fullonly'，以保留该守卫的通用覆盖——而不绑定任何具体后端名。其余 catalog
// 行为（codex-appserver 全档、catalogBackendIds 等）走 importActual 原样保留。
vi.mock('../src/agent/catalog', async () => {
  const actual = await vi.importActual<typeof import('../src/agent/catalog')>('../src/agent/catalog');
  const fakeFullOnly = {
    id: 'fake-fullonly',
    agentFamily: 'codex' as const,
    displayName: '仅完全访问后端',
    access: 'app-server' as const,
    dep: { kind: 'external-cli' as const, detectHint: 'test-only' },
    supportedModes: ['full'] as const,
  };
  const catalog = [...actual.BACKEND_CATALOG, fakeFullOnly];
  return {
    ...actual,
    BACKEND_CATALOG: catalog,
    catalogById: (id: string) => catalog.find((e) => e.id === id),
  };
});

afterAll(() => {
  rmSync(paths.appDir, { recursive: true, force: true });
});

/** 可用的假后端（doctor ok、全档支持，除非显式收窄）。 */
function fakeBackend(over: Partial<AgentBackend> = {}): AgentBackend {
  return {
    id: 'codex-appserver',
    displayName: 'Codex',
    doctor: async () => ({ ok: true, version: '1.0.0' }),
    ...over,
  } as unknown as AgentBackend;
}

beforeEach(async () => {
  await removeProject('demo');
  await addProject({
    name: 'demo',
    chatId: 'oc_demo',
    cwd: '/tmp/demo',
    blank: false,
    createdAt: 1,
    mode: 'full',
  });
});

describe('共享层契约：DM（handle-message re-export）与 ops 是同一个函数对象', () => {
  it('validateBackendSwitch / probeBackends / BACKEND_PROBE_TIMEOUT_MS 同源（防止两套逻辑漂移回潮）', () => {
    expect(hmValidateBackendSwitch).toBe(opsValidateBackendSwitch);
    expect(hmProbeBackends).toBe(opsProbeBackends);
    expect(hmTimeout).toBe(3000);
  });
});

describe('performSetNoMention / performSetAutoCompact', () => {
  it('免@：落盘并写后回读（无需驱逐）', async () => {
    const r = await performSetNoMention({ projectName: 'demo', on: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.noMention).toBe(false);
    expect((await getProjectByName('demo'))?.noMention).toBe(false);
  });

  it('自动压缩：落盘 + 驱逐该群活跃会话（thread/start 绑定，驱逐才能重绑生效）', async () => {
    const evict = vi.fn(async () => undefined);
    const r = await performSetAutoCompact({ projectName: 'demo', on: false, evictLiveSessionsForChat: evict });
    expect(r.ok).toBe(true);
    expect((await getProjectByName('demo'))?.autoCompact).toBe(false);
    expect(evict).toHaveBeenCalledWith('oc_demo');
  });

  it('项目不存在 → ok:false（不落盘、不驱逐）', async () => {
    const evict = vi.fn(async () => undefined);
    const r1 = await performSetNoMention({ projectName: 'nope', on: true });
    const r2 = await performSetAutoCompact({ projectName: 'nope', on: true, evictLiveSessionsForChat: evict });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(evict).not.toHaveBeenCalled();
  });
});

describe('performSetCompletionReminder', () => {
  function config(): AppConfig {
    return {
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      preferences: { completionReminder: { mode: 'failures', longTaskMinutes: 3 } },
    };
  }

  it('先落盘再热更新同一个 LIVE cfg 对象', async () => {
    const cfg = config();
    const persist = vi.fn(async (next: AppConfig) => {
      // persist 尚未完成时，运行态仍是旧策略；避免落盘失败却临时生效。
      expect(cfg.preferences?.completionReminder).toEqual({ mode: 'failures', longTaskMinutes: 3 });
      expect(next.preferences?.completionReminder).toEqual({ mode: 'long', longTaskMinutes: 9 });
    });
    const r = await performSetCompletionReminder({
      cfg,
      mode: 'long',
      longTaskMinutes: 9,
      persistConfig: persist,
    });
    expect(r).toEqual({ ok: true, completionReminder: { mode: 'long', longTaskMinutes: 9 } });
    expect(cfg.preferences?.completionReminder).toEqual({ mode: 'long', longTaskMinutes: 9 });
    expect(persist).toHaveBeenCalledOnce();
  });

  it.each([
    { mode: 'smart' as never, longTaskMinutes: 3 },
    { mode: 'long' as const, longTaskMinutes: 0 },
    { mode: 'long' as const, longTaskMinutes: 1441 },
    { mode: 'long' as const, longTaskMinutes: 1.5 },
  ])('非法策略/阈值 %# → 拒绝且不落盘、不改 LIVE cfg', async (input) => {
    const cfg = config();
    const persist = vi.fn(async () => undefined);
    const r = await performSetCompletionReminder({ ...input, cfg, persistConfig: persist });
    expect(r.ok).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(cfg.preferences?.completionReminder).toEqual({ mode: 'failures', longTaskMinutes: 3 });
  });

  it('落盘失败 → reject 且 LIVE cfg 保持旧策略', async () => {
    const cfg = config();
    await expect(
      performSetCompletionReminder({
        cfg,
        mode: 'always',
        longTaskMinutes: 3,
        persistConfig: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(cfg.preferences?.completionReminder).toEqual({ mode: 'failures', longTaskMinutes: 3 });
  });

  it('串行合并 Web 完成提醒与同时发生的其它 DM 偏好写，不丢字段', async () => {
    const cfg = config();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: AppConfig[] = [];
    const persist = vi.fn(async (next: AppConfig) => {
      snapshots.push(next);
      if (snapshots.length === 1) await firstBlocked;
    });
    const writePreferences = createAppPreferencesWriter({ cfg, persistConfig: persist });

    const webWrite = performSetCompletionReminder({
      cfg,
      mode: 'long',
      longTaskMinutes: 9,
      writePreferences,
    });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const dmWrite = writePreferences((preferences) => {
      preferences.showToolCalls = true;
    });

    // The first disk write is still pending, so LIVE remains the last committed snapshot.
    expect(cfg.preferences).toEqual({ completionReminder: { mode: 'failures', longTaskMinutes: 3 } });
    releaseFirst();
    await Promise.all([webWrite, dmWrite]);

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.preferences).toEqual({ completionReminder: { mode: 'long', longTaskMinutes: 9 } });
    expect(snapshots[1]?.preferences).toEqual({
      completionReminder: { mode: 'long', longTaskMinutes: 9 },
      showToolCalls: true,
    });
    expect(cfg.preferences).toEqual(snapshots[1]?.preferences);
  });

  it('仅切 mode 会在队列内合并最新阈值，不会用入队前的旧阈值覆盖它', async () => {
    const cfg = config();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const snapshots: AppConfig[] = [];
    const writePreferences = createAppPreferencesWriter({
      cfg,
      persistConfig: async (next) => {
        snapshots.push(next);
        if (snapshots.length === 1) await firstBlocked;
      },
    });

    const thresholdWrite = performSetCompletionReminder({
      cfg,
      mode: 'long',
      longTaskMinutes: 12,
      writePreferences,
    });
    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    const modeOnlyWrite = performSetCompletionReminder({ cfg, mode: 'always', writePreferences });

    releaseFirst();
    await Promise.all([thresholdWrite, modeOnlyWrite]);
    expect(snapshots[1]?.preferences?.completionReminder).toEqual({ mode: 'always', longTaskMinutes: 12 });
    expect(cfg.preferences?.completionReminder).toEqual({ mode: 'always', longTaskMinutes: 12 });
  });
});

describe('performSetPermissionMode', () => {
  it('落盘 mode/guestMode/network + 驱逐活跃会话（新档立即生效的既有语义）', async () => {
    const evict = vi.fn(async () => undefined);
    const r = await performSetPermissionMode({
      projectName: 'demo',
      mode: 'qa',
      guestMode: 'write',
      network: true,
      evictLiveSessionsForChat: evict,
    });
    expect(r.ok).toBe(true);
    const p = await getProjectByName('demo');
    expect(p?.mode).toBe('qa');
    expect(p?.guestMode).toBe('write');
    expect(p?.network).toBe(true);
    expect(evict).toHaveBeenCalledWith('oc_demo');
  });

  it('缺省字段不改盘（undefined 跳过——与 DM 旧写法等价）', async () => {
    const evict = vi.fn(async () => undefined);
    await performSetPermissionMode({ projectName: 'demo', network: false, evictLiveSessionsForChat: evict });
    const p = await getProjectByName('demo');
    expect(p?.mode).toBe('full'); // 原值保留
    expect(p?.guestMode).toBeUndefined();
  });

  it('Web 来路的非法档位 → 拒绝（DM 来路有 asTier 收窄，这里再守一道）', async () => {
    const evict = vi.fn(async () => undefined);
    const r = await performSetPermissionMode({
      projectName: 'demo',
      mode: 'root' as never,
      evictLiveSessionsForChat: evict,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未知权限档');
    expect(evict).not.toHaveBeenCalled();
    expect((await getProjectByName('demo'))?.mode).toBe('full');
  });

  // 后端档位兼容守门（review wf_28088b2e #2/#5）：若后端 supportedModes 仅「完全访问」，
  // 把档改到其支持面之外应被前置拦住，否则新话题在 backend 的 fail-closed 守卫处整群卡死。
  // 用泛化的「仅 full」后端 fake-fullonly（见顶部 catalog mock）覆盖该守卫，不绑定具体后端名。
  it('后端只支持 full，把权限档改到 qa → 前置拒绝且不落盘、不驱逐', async () => {
    await addProject({ name: 'cl', chatId: 'oc_cl', cwd: '/tmp/cl', blank: false, createdAt: 1, mode: 'full', backend: 'fake-fullonly' });
    const evict = vi.fn(async () => undefined);
    const r = await performSetPermissionMode({ projectName: 'cl', mode: 'qa', evictLiveSessionsForChat: evict });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('完全访问');
    expect(evict).not.toHaveBeenCalled();
    expect((await getProjectByName('cl'))?.mode).toBe('full'); // 未改盘
    await removeProject('cl');
  });

  it('guestMode 改到后端不支持的档同样被拦（普通用户档也要兼容后端）', async () => {
    await addProject({ name: 'cl2', chatId: 'oc_cl2', cwd: '/tmp/cl2', blank: false, createdAt: 1, mode: 'full', backend: 'fake-fullonly' });
    const r = await performSetPermissionMode({ projectName: 'cl2', guestMode: 'qa', evictLiveSessionsForChat: async () => undefined });
    expect(r.ok).toBe(false);
    await removeProject('cl2');
  });

  it('codex 后端（supportedModes 全档）→ 任意权限档放行', async () => {
    await addProject({ name: 'cx', chatId: 'oc_cx', cwd: '/tmp/cx', blank: false, createdAt: 1, mode: 'full', backend: 'codex-appserver' });
    const r = await performSetPermissionMode({ projectName: 'cx', mode: 'qa', evictLiveSessionsForChat: async () => undefined });
    expect(r.ok).toBe(true);
    expect((await getProjectByName('cx'))?.mode).toBe('qa');
    await removeProject('cx');
  });
});

describe('performBackendSwitch（注册表 → doctor 探活 → 档位支持面，全过才写盘）', () => {
  it('项目不存在 → 拒绝（防御式 IPC/HTTP 入口的脏请求）', async () => {
    const r = await performBackendSwitch({ projectName: 'ghost', target: 'codex-appserver', backendFor: () => fakeBackend() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不存在');
  });

  it('未知后端 → 拒绝且不写盘', async () => {
    const r = await performBackendSwitch({ projectName: 'demo', target: 'gpt-9', backendFor: () => fakeBackend() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('未知后端');
    expect((await getProjectByName('demo'))?.backend).toBeUndefined();
  });

  it('doctor 探活失败 → 拒绝（切过去才报错是事故，这里提前拦）', async () => {
    const be = fakeBackend({ doctor: async () => ({ ok: false, hint: '未登录' }) } as Partial<AgentBackend>);
    const r = await performBackendSwitch({ projectName: 'demo', target: 'codex-appserver', backendFor: () => be });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不可用');
  });

  it('权限档不在目标后端支持面 → 拒绝并讲清原因', async () => {
    await performSetPermissionMode({
      projectName: 'demo',
      mode: 'qa',
      evictLiveSessionsForChat: async () => undefined,
    });
    const be = fakeBackend({ supportedModes: ['full'] } as Partial<AgentBackend>);
    const r = await performBackendSwitch({ projectName: 'demo', target: 'codex-appserver', backendFor: () => be });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('权限档');
  });

  it('全过 → 写盘 + 写后回读（legacy：backend 未设时一次性落地）', async () => {
    const r = await performBackendSwitch({ projectName: 'demo', target: 'codex-appserver', backendFor: () => fakeBackend() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.backend).toBe('codex-appserver');
    expect((await getProjectByName('demo'))?.backend).toBe('codex-appserver');
  });

  it('已设后端再切到异值 → 防御式拒绝「创建时选定，不支持切换」且不写盘', async () => {
    // 模拟「创建时已选定 codex」的项目：先落地一个后端，再尝试切到别的（异值）。
    // 防御拦截在注册表/doctor 校验之前，故目标取任意异值（不必是已注册 id）即可触发。
    await performBackendSwitch({ projectName: 'demo', target: 'codex-appserver', backendFor: () => fakeBackend() });
    const r = await performBackendSwitch({ projectName: 'demo', target: 'gpt-9', backendFor: () => fakeBackend() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不支持切换');
    // 写盘未变：仍是创建时选定的 codex（防御拦截在 doctor/校验之前）。
    expect((await getProjectByName('demo'))?.backend).toBe('codex-appserver');
  });

  it('已设后端切到同值 → no-op 放行（幂等，不算切换）', async () => {
    await performBackendSwitch({ projectName: 'demo', target: 'codex-appserver', backendFor: () => fakeBackend() });
    const r = await performBackendSwitch({ projectName: 'demo', target: 'codex-appserver', backendFor: () => fakeBackend() });
    expect(r.ok).toBe(true);
    expect((await getProjectByName('demo'))?.backend).toBe('codex-appserver');
  });
});

describe('createAdminWriteExecutor / runAdminWriteOp（Web · IPC 入口）', () => {
  const deps = {
    backendFor: () => fakeBackend(),
    evictLiveSessionsForChat: async () => undefined,
  };

  it('op 分发到对应 perform*（落盘可见）', async () => {
    const r = await runAdminWriteOp({ kind: 'setNoMention', project: 'demo', on: false }, deps);
    expect(r.ok).toBe(true);
    expect((await getProjectByName('demo'))?.noMention).toBe(false);
  });

  it('执行器：成功静默返回，拒绝抛 AdminWriteError（带 code，IPC/HTTP 可还原）', async () => {
    const exec = createAdminWriteExecutor(deps);
    await expect(exec({ kind: 'setAutoCompact', project: 'demo', on: true })).resolves.toBeUndefined();
    const err = await exec({ kind: 'switchBackend', project: 'demo', backend: 'gpt-9' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminWriteError);
    expect((err as AdminWriteError).code).toBe('ADMIN_WRITE_REJECTED');
  });

  it('setCompletionReminder op 通过执行器热更新 cfg；缺 LIVE cfg 时 fail closed', async () => {
    const cfg: AppConfig = {
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    };
    const persist = vi.fn(async () => undefined);
    const exec = createAdminWriteExecutor({ ...deps, cfg, persistConfig: persist });
    await expect(
      exec({ kind: 'setCompletionReminder', mode: 'manual', longTaskMinutes: 3 }),
    ).resolves.toBeUndefined();
    expect(cfg.preferences?.completionReminder).toEqual({ mode: 'manual', longTaskMinutes: 3 });

    const missingCfg = createAdminWriteExecutor(deps);
    await expect(
      missingCfg({ kind: 'setCompletionReminder', mode: 'failures', longTaskMinutes: 3 }),
    ).rejects.toBeInstanceOf(AdminWriteError);
  });
});
