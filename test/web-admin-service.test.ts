import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { paths, botPaths, useBotDir } from '../src/config/paths';
import { saveBots } from '../src/config/bots';
import { addProject } from '../src/project/registry';
import { upsertSession } from '../src/bot/session-store';
import {
  createAdminService,
  createReadonlyAdminService,
  NotWiredYetError,
  type AdminService,
} from '../src/admin/service';
import { AdminWriteError, type AdminWriteOp } from '../src/admin/ops';

// 把整个 ~/.feishu-codex-bridge 指到临时目录，绝不碰真实用户数据。fixture 通过
// bots/registry/session-store 模块的导出写入（useBotDir 切目录后写）——服务层读
// 到的就是真实落盘格式；服务层自身只走 botPaths 显式路径，不再 useBotDir。
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'web-admin-service-test-'));
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

const BOT_A = 'cli_botA';
const BOT_B = 'cli_botB';
let service: AdminService;

beforeAll(async () => {
  await saveBots({
    version: 1,
    current: BOT_A,
    bots: [
      { name: 'alpha', appId: BOT_A, tenant: 'feishu', botName: '阿尔法', createdAt: 1, active: true },
      { name: 'beta', appId: BOT_B, tenant: 'lark', createdAt: 2, active: false },
    ],
  });

  // bot A：一个项目 + 两个话题（另一个 chatId 的会话不算它的话题数）
  useBotDir(BOT_A);
  await addProject({
    name: 'proj-a',
    chatId: 'oc_aaa',
    cwd: '/tmp/proj-a',
    blank: false,
    createdAt: 100,
    kind: 'multi',
    mode: 'write',
    backend: 'codex-appserver',
    allowedUsers: ['ou_1'],
  });
  // 每 bot 的完成提醒来自各自 config.json；A 自定义，B 缺省走 failures / 3。
  writeFileSync(
    botPaths(BOT_A).configFile,
    JSON.stringify({ preferences: { completionReminder: { mode: 'long', longTaskMinutes: 7 } } }),
    'utf8',
  );
  for (const [threadId, chatId] of [
    ['t1', 'oc_aaa'],
    ['t2', 'oc_aaa'],
    ['t3', 'oc_other'],
  ] as const) {
    await upsertSession({
      threadId,
      chatId,
      cwd: '/tmp/proj-a',
      sessionId: `sess-${threadId}`,
      backend: 'codex-appserver',
      summary: `话题 ${threadId}`,
      createdAt: 10,
      updatedAt: threadId === 't1' ? 30 : 20,
    });
  }

  // bot B：另一个目录下的项目（验证 per-bot 隔离）
  useBotDir(BOT_B);
  await addProject({
    name: 'proj-b',
    chatId: 'oc_bbb',
    cwd: '/tmp/proj-b',
    blank: true,
    createdAt: 200,
  });

  // 服务层不依赖 useBotDir 的全局态——故意把全局目录切到一个无关 bot，证明
  // 读取走的是显式路径（第一棒 useBotDir 切目录的坑已修掉）。
  useBotDir('cli_unrelated');

  service = createReadonlyAdminService();
});

afterAll(() => {
  rmSync(paths.appDir, { recursive: true, force: true });
});

describe('createReadonlyAdminService · 只读方法（显式路径，不碰全局 currentBotDir）', () => {
  it('listBots：全部 bot + current/active 标记，预览态下 running=false 且无 connection', async () => {
    const bots = await service.listBots();
    expect(bots.map((b) => b.appId).sort()).toEqual([BOT_A, BOT_B]);
    const a = bots.find((b) => b.appId === BOT_A)!;
    const b = bots.find((b) => b.appId === BOT_B)!;
    expect(a.current).toBe(true);
    expect(a.active).toBe(true);
    expect(a.botName).toBe('阿尔法');
    expect(a.completionReminder).toEqual({ mode: 'long', longTaskMinutes: 7 });
    expect(b.completionReminder).toEqual({ mode: 'failures', longTaskMinutes: 3 });
    expect(b.current).toBe(false);
    expect(b.active).toBe(false);
    // 没有单实例锁文件 → 未在跑；真实 WS 状态只有 daemon 进程内才有
    expect(a.running).toBe(false);
    expect(b.running).toBe(false);
    expect(a.connection).toBeUndefined();
  });

  it('listProjects：effective 字段已解析（默认值回填）+ 话题数按 chatId 聚合', async () => {
    const projects = await service.listProjects(BOT_A);
    expect(projects).toHaveLength(1);
    const p = projects[0]!;
    expect(p.name).toBe('proj-a');
    expect(p.kind).toBe('multi');
    expect(p.origin).toBe('created'); // 缺省回填
    expect(p.mode).toBe('write');
    expect(p.guestMode).toBe('write'); // guestMode 未设 → 跟管理员档
    expect(p.noMention).toBe(true); // created+multi 默认免@ 开
    expect(p.autoCompact).toBe(true);
    expect(p.network).toBe(false);
    expect(p.backend).toBe('codex-appserver'); // 显式设的后端原样透传
    expect(p.allowedUsersCount).toBe(1);
    expect(p.sessionCount).toBe(2); // oc_other 的 t3 不算
  });

  it('listProjects：per-bot 隔离（B 的项目读不到 A 的数据），且 effective 默认后端回填', async () => {
    const projects = await service.listProjects(BOT_B);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('proj-b');
    expect(projects[0]!.mode).toBe('full'); // 老数据无 mode → full
    expect(projects[0]!.backend).toBe('codex-appserver'); // 缺省 → 默认后端
    expect(projects[0]!.sessionCount).toBe(0);
  });

  it('并发跨 bot 读互不串（显式路径天然无共享可变态）', async () => {
    const [a, b] = await Promise.all([service.listProjects(BOT_A), service.listProjects(BOT_B)]);
    expect(a.map((p) => p.name)).toEqual(['proj-a']);
    expect(b.map((p) => p.name)).toEqual(['proj-b']);
  });

  it('getProject：命中返回详情，未命中返回 undefined', async () => {
    expect((await service.getProject(BOT_A, 'proj-a'))?.cwd).toBe('/tmp/proj-a');
    expect(await service.getProject(BOT_A, 'nope')).toBeUndefined();
  });

  it('listSessions：按项目 chatId 过滤并按 updatedAt 新→旧排序', async () => {
    const sessions = await service.listSessions(BOT_A, 'proj-a');
    expect(sessions.map((s) => s.threadId)).toEqual(['t1', 't2']);
    expect(sessions[0]!.summary).toBe('话题 t1');
    expect(await service.listSessions(BOT_A, 'nope')).toEqual([]);
  });

  it('eventDiagnosis：配置缺失 → unchecked 降级（绝不抛错）', async () => {
    const d = await service.eventDiagnosis(BOT_A);
    expect(d.state).toBe('unchecked');
    expect(d.reason).toBeTruthy();
  });

  it('tailLogs：返回字符串（文件日志尾部）', async () => {
    expect(typeof (await service.tailLogs({ maxBytes: 4096 }))).toBe('string');
  });
});

describe('createReadonlyAdminService · 写方法（只读预览占位）', () => {
  it('五个写方法一律抛 NotWiredYetError', async () => {
    await expect(service.switchBackend(BOT_A, 'proj-a', 'codex-appserver')).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(service.setPermissionMode(BOT_A, 'proj-a', { mode: 'qa' })).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(service.setNoMention(BOT_A, 'proj-a', true)).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(service.setAutoCompact(BOT_A, 'proj-a', false)).rejects.toBeInstanceOf(NotWiredYetError);
    await expect(
      service.setCompletionReminder(BOT_A, { mode: 'failures', longTaskMinutes: 3 }),
    ).rejects.toBeInstanceOf(NotWiredYetError);
  });

  it('NotWiredYetError 带 code 和「先起 daemon」的引导文案', async () => {
    const err = await service.switchBackend(BOT_A, 'proj-a', 'x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotWiredYetError);
    expect((err as NotWiredYetError).code).toBe('NOT_WIRED_YET');
    expect((err as NotWiredYetError).message).toContain('daemon');
    expect((err as NotWiredYetError).message).toContain('只读预览');
  });
});

describe('createAdminService · daemon 进程内（executeWrite + liveStatus 注入）', () => {
  it('写方法把 botId + AdminWriteOp 原样交给执行器（Web 与 DM 同一写路径的接缝）', async () => {
    const calls: { botId: string; op: AdminWriteOp }[] = [];
    const daemon = createAdminService({
      executeWrite: async (botId, op) => void calls.push({ botId, op }),
    });
    await daemon.switchBackend(BOT_A, 'proj-a', 'codex-appserver');
    await daemon.setPermissionMode(BOT_A, 'proj-a', { mode: 'qa', guestMode: 'write', network: true });
    await daemon.setNoMention(BOT_A, 'proj-a', false);
    await daemon.setAutoCompact(BOT_A, 'proj-a', true);
    await daemon.setCompletionReminder(BOT_A, { mode: 'long', longTaskMinutes: 8 });
    expect(calls).toEqual([
      { botId: BOT_A, op: { kind: 'switchBackend', project: 'proj-a', backend: 'codex-appserver' } },
      {
        botId: BOT_A,
        op: { kind: 'setPermissionMode', project: 'proj-a', mode: 'qa', guestMode: 'write', network: true },
      },
      { botId: BOT_A, op: { kind: 'setNoMention', project: 'proj-a', on: false } },
      { botId: BOT_A, op: { kind: 'setAutoCompact', project: 'proj-a', on: true } },
      { botId: BOT_A, op: { kind: 'setCompletionReminder', mode: 'long', longTaskMinutes: 8 } },
    ]);
  });

  it('执行器抛 AdminWriteError（校验拒绝）原样透传给调用方', async () => {
    const daemon = createAdminService({
      executeWrite: async () => {
        throw new AdminWriteError('后端「x」当前不可用');
      },
    });
    await expect(daemon.switchBackend(BOT_A, 'proj-a', 'x')).rejects.toBeInstanceOf(AdminWriteError);
  });

  it('liveStatus 注入：listBots 用真实 WS 状态替代锁文件探测；未覆盖的 bot 回退锁文件', async () => {
    const daemon = createAdminService({
      liveStatus: async (botId) =>
        botId === BOT_A
          ? { running: true, pid: 4242, startedAt: 1000, connection: 'connected' }
          : undefined,
    });
    const bots = await daemon.listBots();
    const a = bots.find((b) => b.appId === BOT_A)!;
    const b = bots.find((b) => b.appId === BOT_B)!;
    expect(a.running).toBe(true);
    expect(a.pid).toBe(4242);
    expect(a.connection).toBe('connected');
    // B 不归 daemon 管 → 锁文件探测（无锁文件 = 未在跑）
    expect(b.running).toBe(false);
    expect(b.connection).toBeUndefined();
  });

  it('liveStatus 抛错不致命：回退锁文件探测（绝不让 /api/state 整页 500）', async () => {
    const daemon = createAdminService({
      liveStatus: async () => {
        throw new Error('IPC 超时');
      },
    });
    const bots = await daemon.listBots();
    expect(bots.find((b) => b.appId === BOT_A)!.running).toBe(false);
  });
});

describe('createAdminService · getSetupStatus（初始化 checklist 聚合）', () => {
  // 真飞书 API 一律 mock（绝不打真网络）：token / bot-info / scopes / app_versions。
  // 写一个带明文 secret 的完整 config.json（resolveAppSecret 直接吃明文）到 bot 目录。
  const SETUP_BOT = 'cli_setupbot';

  function writeCompleteConfig(tenant: 'feishu' | 'lark' = 'feishu'): void {
    const dir = botPaths(SETUP_BOT).dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      botPaths(SETUP_BOT).configFile,
      JSON.stringify({ accounts: { app: { id: SETUP_BOT, secret: 'plain-secret', tenant } } }),
    );
  }

  function stubFetch(opts: { grantedScopes: string[]; eventEvents: string[]; published?: boolean }): typeof fetch {
    return (async (input: unknown): Promise<Response> => {
      const u = String(input);
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('/auth/v3/tenant_access_token/internal')) {
        return json({ code: 0, tenant_access_token: 't-xyz' });
      }
      if (u.includes('/bot/v3/info')) {
        return json({ code: 0, bot: { app_name: 'SetupBot', open_id: 'ou_bot' } });
      }
      if (u.includes('/application/v6/scopes')) {
        return json({ data: { scopes: opts.grantedScopes.map((s) => ({ scope_name: s, grant_status: 1 })) } });
      }
      if (u.includes('/app_versions')) {
        return json({
          code: 0,
          data: opts.published === false ? { items: [] } : { items: [{ version: '1.0.0', status: 1, events: opts.eventEvents }] },
        });
      }
      throw new Error('unexpected fetch ' + u);
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeAll(async () => {
    await saveBots({
      version: 1,
      current: BOT_A,
      bots: [
        { name: 'alpha', appId: BOT_A, tenant: 'feishu', botName: '阿尔法', createdAt: 1, active: true },
        { name: 'beta', appId: BOT_B, tenant: 'lark', createdAt: 2, active: false },
        { name: 'setup', appId: SETUP_BOT, tenant: 'feishu', createdAt: 3, active: false },
      ],
    });
  });

  it('全绿：密钥有效 + scope 齐全 + 事件 ok（长连接靠锁文件探测，预览态 running=false）', async () => {
    writeCompleteConfig();
    // 授予全部必需 scope，且事件含 im.message.receive_v1 → ok。
    vi.stubGlobal(
      'fetch',
      stubFetch({
        grantedScopes: [
          'im:message.group_at_msg:readonly',
          'im:message.group_msg',
          'im:message.p2p_msg:readonly',
          'im:message:send_as_bot',
          'im:message.pins:write_only',
          'im:message.reactions:write_only',
          'im:resource',
          'im:chat:create',
          'im:chat:update',
          'im:chat.managers:write_only',
          'im:chat.announcement:read',
          'im:chat.announcement:write_only',
          'im:chat.top_notice:write_only',
          'im:chat.tabs:write_only',
          'cardkit:card:write',
        ],
        eventEvents: ['im.message.receive_v1'],
      }),
    );
    const svc = createReadonlyAdminService();
    const s = await svc.getSetupStatus(SETUP_BOT);
    expect(s.appId).toBe(SETUP_BOT);
    expect(s.credentials.ok).toBe(true);
    expect(s.botName).toBe('SetupBot');
    expect(s.scopes.missingRequired).toEqual([]);
    expect(s.scopes.grantUrl).toContain('/app/cli_setupbot/auth?q=');
    expect(s.event.state).toBe('ok');
    expect(s.connection.running).toBe(false); // 没锁文件 + 预览态
    expect(s.eventConfigUrl).toContain('/app/cli_setupbot/event');
  });

  it('桌面宿主 secret resolver 可解析 process-only SecretRef', async () => {
    mkdirSync(botPaths(SETUP_BOT).dir, { recursive: true });
    writeFileSync(
      botPaths(SETUP_BOT).configFile,
      JSON.stringify({
        accounts: {
          app: {
            id: SETUP_BOT,
            secret: { source: 'file', id: 'desktop-secret-ref' },
            tenant: 'feishu',
          },
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      stubFetch({
        grantedScopes: [],
        eventEvents: ['im.message.receive_v1'],
      }),
    );
    const resolveBotSecret = vi.fn(async () => 'desktop-plaintext-secret');
    const svc = createAdminService({ resolveBotSecret });

    const s = await svc.getSetupStatus(SETUP_BOT);

    expect(resolveBotSecret).toHaveBeenCalledWith(
      SETUP_BOT,
      expect.objectContaining({
        accounts: expect.objectContaining({
          app: expect.objectContaining({ id: SETUP_BOT }),
        }),
      }),
    );
    expect(s.credentials.ok).toBe(true);
    expect(s.event.state).toBe('ok');
  });

  it('缺 scope + 事件未发布：missingRequired 非空、event=unpublished', async () => {
    writeCompleteConfig();
    vi.stubGlobal('fetch', stubFetch({ grantedScopes: ['im:resource'], eventEvents: [], published: false }));
    const svc = createReadonlyAdminService();
    const s = await svc.getSetupStatus(SETUP_BOT);
    expect(s.credentials.ok).toBe(true);
    expect((s.scopes.missingRequired ?? []).length).toBeGreaterThan(0);
    expect(s.scopes.missingRequired).toContain('im:message:send_as_bot');
    expect(s.event.state).toBe('unpublished');
  });

  it('配置缺失（未写 config.json）→ credentials.ok=false + event unchecked，绝不抛错', async () => {
    rmSync(botPaths(SETUP_BOT).dir, { recursive: true, force: true });
    const svc = createReadonlyAdminService();
    const s = await svc.getSetupStatus(SETUP_BOT);
    expect(s.credentials.ok).toBe(false);
    expect(s.event.state).toBe('unchecked');
    expect(s.scopes.grantUrl).toContain('/auth?q='); // 深链总归得给
  });
});
