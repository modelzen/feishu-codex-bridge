import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebServer, type WebServer } from '../src/web/server';
import { NotWiredYetError, type AdminService } from '../src/admin/service';
import { AdminWriteError } from '../src/admin/ops';

// 内存 stub：server 层单测不碰真实文件/注册表（service 自有专门的集成测试）。
function stubService(): AdminService {
  return {
    async listBots() {
      return [
        {
          name: 'alpha',
          appId: 'cli_a',
          tenant: 'feishu' as const,
          botName: '阿尔法',
          active: true,
          current: true,
          running: true,
          pid: 4242,
          completionReminder: { mode: 'failures' as const, longTaskMinutes: 3 },
        },
      ];
    },
    async listProjects() {
      return [
        {
          name: 'demo',
          chatId: 'oc_x',
          cwd: '/tmp/demo',
          blank: false,
          kind: 'multi' as const,
          origin: 'created' as const,
          noMention: true,
          autoCompact: true,
          mode: 'full' as const,
          guestMode: 'full' as const,
          network: false,
          backend: 'codex-appserver',
          allowedUsersCount: 0,
          sessionCount: 3,
          createdAt: 1,
        },
      ];
    },
    async getProject() {
      return undefined;
    },
    async switchBackend() {
      throw new NotWiredYetError('🧠 切换后端');
    },
    async setPermissionMode() {
      throw new NotWiredYetError('🔐 设置权限档');
    },
    async setNoMention() {
      throw new NotWiredYetError('✋ 免@ 开关');
    },
    async setAutoCompact() {
      throw new NotWiredYetError('🗜️ 自动压缩开关');
    },
    async setCompletionReminder() {
      throw new NotWiredYetError('🔔 完成提醒');
    },
    async doctorBackends() {
      return [{ id: 'codex-appserver', name: 'Codex', ok: true, version: '1.0.0', isDefault: true }];
    },
    async eventDiagnosis() {
      return { state: 'unchecked' as const, reason: 'stub' };
    },
    async listSessions() {
      return [
        {
          threadId: 't1',
          chatId: 'oc_x',
          summary: '修复登录 bug',
          backend: 'codex-appserver',
          createdAt: 1,
          updatedAt: 2,
        },
      ];
    },
    async tailLogs() {
      return '{"ts":"2026-06-13T00:00:00Z","level":"info","phase":"ws","event":"connected"}\n';
    },
    async getSetupStatus(botId) {
      return {
        appId: botId,
        tenant: 'feishu' as const,
        botName: '新机器人',
        credentials: { ok: true },
        connection: { running: true, connection: 'connected' },
        event: { state: 'ok' as const, version: '1.0.0', events: ['im.message.receive_v1'] },
        scopes: { missingRequired: [], grantUrl: 'https://open.feishu.cn/app/' + botId + '/auth?q=x' },
        eventConfigUrl: 'https://open.feishu.cn/app/' + botId + '/event',
      };
    },
    async registerBotByQr(o) {
      // 默认 stub：吐一帧 qr + 一帧 status，再成功。被取消（abort）则返回 abort。
      o.onQr({ url: 'https://accounts.feishu.cn/scan?code=abc', expireIn: 600 });
      o.onStatus?.({ status: 'polling' });
      if (o.signal.aborted) return { ok: false as const, code: 'abort' as const, reason: '已取消扫码。' };
      return {
        ok: true as const,
        appId: 'cli_scanned9999',
        name: 'scanned',
        tenant: 'feishu' as const,
        botName: '扫码机器人',
        adminOpenId: 'ou_scanner',
        missingScopes: [],
      };
    },
    async listBackendCatalog() {
      // codex-only：catalog 只剩 codex-appserver（external-cli，不可一键装）。
      return {
        defaultBackend: 'codex-appserver',
        entries: [
          {
            id: 'codex-appserver',
            agentFamily: 'codex',
            displayName: 'Codex',
            access: 'app-server',
            depKind: 'external-cli',
            depState: 'installed' as const,
            installable: false,
            version: '1.0.0',
            installedVersion: null,
            canUninstall: false,
            isDefault: true,
          },
        ],
      };
    },
    async installBackend(_id, onProgress, signal) {
      // 默认 stub 走「成功推进」路径，验证 install SSE 的 log→done 路由管道。
      onProgress?.('added 1 package\n');
      if (signal?.aborted) return { ok: false as const, code: null, aborted: true, tail: '安装已取消' };
      return { ok: true as const, code: 0, aborted: false, tail: 'added 1 package' };
    },
    async uninstallBackend(id) {
      return id === 'codex-appserver' ? { ok: true, message: '已卸载' } : { ok: false, message: '无法卸载' };
    },
    async backendVersion() {
      return { installed: '0.3.1', latest: '0.3.2', hasUpdate: true };
    },
    async getDaemonStatus() {
      return {
        platformName: 'launchd (macOS)',
        installed: true,
        running: true,
        selfHosted: false,
        pid: 4242,
        version: '0.3.11',
        uptimeMs: 60_000,
        supported: true,
      };
    },
    async restartDaemon() {
      throw new NotWiredYetError('🔁 重启 daemon');
    },
    async startDaemon() {
      throw new NotWiredYetError('▶️ 启动 daemon');
    },
    async stopDaemon() {
      throw new NotWiredYetError('⏹ 停止 daemon');
    },
    async checkUpdate() {
      return { current: '0.3.11', latest: '0.4.0', hasUpdate: true, dev: false };
    },
    updateStatus() {
      return null;
    },
    async applyUpdate() {
      throw new NotWiredYetError('⬆️ 升级');
    },
    async hostDoctor() {
      return {
        node: 'v20.11.0',
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '25.5.0',
        appDir: '/home/u/.feishu-codex-bridge',
        logsDir: '/home/u/.feishu-codex-bridge/logs',
        logBytes: 12_345,
        version: '0.3.11',
        backends: [{ id: 'codex-appserver', name: 'Codex', ok: true, version: '1.0.0', isDefault: true }],
      };
    },
    async setBotEnabled(appId, enabled) {
      if (appId === 'cli_missing') return { ok: false as const, reason: '机器人不存在。' };
      void enabled;
      return { ok: true as const };
    },
    async deleteBot(appId) {
      if (appId === 'cli_only') return { ok: false as const, reason: '这是当前唯一的机器人，不能删除。' };
      if (appId === 'cli_busy') return { ok: false as const, reason: '机器人正在运行且有活跃会话，不能删除。' };
      return { ok: true as const };
    },
  };
}

const TOKEN = 'test-token-1234';
let web: WebServer;
let base: string;
let logDir: string;

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init });
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return get(path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
}

// node 的 fetch 类型把 json() 标成 unknown；测试里按宽松 JSON 读。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonOf(res: Response): Promise<any> {
  return (await res.json()) as any;
}

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'web-server-test-logs-'));
  web = createWebServer({ service: stubService(), token: TOKEN, logDir });
  const { port, url } = await web.listen(0); // 临时端口，起了就关，绝不占固定口
  base = `http://127.0.0.1:${port}`;
  expect(url).toBe(`${base}/?token=${TOKEN}`);
});

afterAll(async () => {
  await web.close();
  rmSync(logDir, { recursive: true, force: true });
});

describe('web server · 安全（loopback + token + Host 校验）', () => {
  it('仅绑定 127.0.0.1（绝不 0.0.0.0）', () => {
    const addr = web.server.address();
    expect(typeof addr).toBe('object');
    expect((addr as { address: string }).address).toBe('127.0.0.1');
  });

  it('无 token → 401', async () => {
    const res = await get('/api/state');
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).error).toBe('unauthorized');
  });

  it('错误 token → 401（Bearer / query 都不行）', async () => {
    expect((await get('/api/state', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await get('/api/state?token=wrong')).status).toBe(401);
  });

  it('Authorization: Bearer 正确 token → 200', async () => {
    expect((await authed('/api/state')).status).toBe(200);
  });

  it('正确 ?token= 能盖过过期 cookie（daemon 重启换 token 后旧窗口不被旧 cookie 挡死）', async () => {
    // 旧 daemon 留下的过期 cookie + URL 上带正确新 token → 必须放行（回归 #cookie-shadow）
    const res = await get(`/?token=${TOKEN}`, { headers: { Cookie: 'fcb_console_token=stale-old-token' } });
    expect(res.status).toBe(302); // 走换 cookie 流程而非 401
    expect(res.headers.get('set-cookie') ?? '').toContain(`fcb_console_token=${TOKEN}`);
  });

  it('过期 cookie + 无 ?token= → 仍 401（不放水）', async () => {
    const res = await get('/api/state', { headers: { Cookie: 'fcb_console_token=stale-old-token' } });
    expect(res.status).toBe(401);
  });

  it('?token= 首跳：页面 302 去掉 URL token 并种 cookie；cookie 可继续鉴权', async () => {
    const first = await get(`/?token=${TOKEN}`);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/');
    const cookie = first.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('fcb_console_token=');
    expect(cookie).toContain('HttpOnly');
    const cookiePair = cookie.split(';')[0]!;
    const page = await get('/', { headers: { Cookie: cookiePair } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Feishu Bridge 管理台');
    const api = await get('/api/state', { headers: { Cookie: cookiePair } });
    expect(api.status).toBe(200);
  });

  // fetch(undici) 会静默丢弃 Host/Origin 这类 forbidden header，用裸 http.request 才能真发出去。
  function rawStatus(headers: Record<string, string>): Promise<number> {
    const port = Number(new URL(base).port);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/state', headers: { Authorization: `Bearer ${TOKEN}`, ...headers } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('非 loopback Host → 403（防 DNS rebinding）', async () => {
    expect(await rawStatus({ Host: 'evil.example.com' })).toBe(403);
    expect(await rawStatus({ Host: 'evil.example.com:7866' })).toBe(403);
  });

  it('跨站 Origin → 403', async () => {
    expect(await rawStatus({ Origin: 'http://evil.example.com' })).toBe(403);
  });
});

describe('web server · 只读 API', () => {
  it('/api/state 快照形状：version/generatedAt + bots[].projects[]', async () => {
    const body = await jsonOf(await authed('/api/state'));
    expect(typeof body.version).toBe('string');
    expect(typeof body.generatedAt).toBe('number');
    expect(body.bots).toHaveLength(1);
    const bot = body.bots[0];
    expect(bot.appId).toBe('cli_a');
    expect(bot.running).toBe(true);
    expect(bot.completionReminder).toEqual({ mode: 'failures', longTaskMinutes: 3 });
    expect(bot.projects).toHaveLength(1);
    const p = bot.projects[0];
    expect(p).toMatchObject({
      name: 'demo',
      kind: 'multi',
      mode: 'full',
      backend: 'codex-appserver',
      sessionCount: 3,
      noMention: true,
    });
  });

  it('/api/diagnosis：backends + event 三态', async () => {
    const body = await jsonOf(await authed('/api/diagnosis'));
    expect(body.bot).toBe('cli_a');
    expect(body.backends[0]).toMatchObject({ id: 'codex-appserver', ok: true });
    expect(body.event.state).toBe('unchecked');
  });

  it('/api/project/:name/sessions：话题列表', async () => {
    const body = await jsonOf(await authed('/api/project/demo/sessions'));
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].summary).toBe('修复登录 bug');
  });

  it('未知路径 → 404', async () => {
    expect((await authed('/api/nope')).status).toBe(404);
  });

  it('GET /vendor/gsap.min.js：鉴权后 200 + JS content-type + 长缓存 + 真是 GSAP 源', async () => {
    const res = await authed('/vendor/gsap.min.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const body = await res.text();
    expect(body).toContain('GSAP'); // 许可证头里有 "GSAP 3.x"
    expect(body.length).toBeGreaterThan(50000); // ~71KB，确认不是空壳
  });

  it('GET /vendor/gsap.min.js：无 token → 401（静态资源同样过鉴权）', async () => {
    expect((await get('/vendor/gsap.min.js')).status).toBe(401);
  });

  it('GET /vendor/logo.png：鉴权后 200 + image/png + 长缓存 + 真是 PNG（魔数）', async () => {
    const res = await authed('/vendor/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG 魔数 89 50 4E 47 0D 0A 1A 0A
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(buf.length).toBeGreaterThan(10000); // ~27KB，确认不是空壳
  });

  it('GET /vendor/logo.png：无 token → 401（静态资源同样过鉴权）', async () => {
    expect((await get('/vendor/logo.png')).status).toBe(401);
  });
});

describe('web server · 写操作占位（只读预览：daemon 未跑）', () => {
  it.each(['backend', 'permission', 'no-mention', 'auto-compact'])('POST /api/project/demo/%s → 501', async (action) => {
    const res = await authed(`/api/project/demo/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'codex-appserver', mode: 'qa', on: true }),
    });
    expect(res.status).toBe(501);
    const body = await jsonOf(res);
    expect(body.error).toBe('not_wired_yet');
    expect(body.message).toContain('daemon');
  });

  it('写操作同样要鉴权：无 token → 401（不是 501）', async () => {
    const res = await get('/api/project/demo/backend', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('POST /api/bots/:id/completion-reminder 在只读预览 → 501', async () => {
    const res = await authed('/api/bots/cli_a/completion-reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'failures', longTaskMinutes: 3 }),
    });
    expect(res.status).toBe(501);
    expect((await jsonOf(res)).error).toBe('not_wired_yet');
  });
});

describe('web server · 写操作真实现（daemon 进程内 service）', () => {
  // 写方法可成功 / 校验拒绝的 stub —— 验证路由对 200/409 的映射；UI 的 postWrite
  // 已按「200 → ✅ 已保存、其余 → ❌ message」处理，路由从 501 变真后前端零改动。
  let writeWeb: WebServer;
  let writeBase: string;
  const written: unknown[] = [];

  beforeAll(async () => {
    const svc = stubService();
    svc.switchBackend = async (botId, project, backend) => {
      written.push({ botId, project, backend });
    };
    svc.setNoMention = async () => {
      throw new AdminWriteError('项目「demo」不存在');
    };
    svc.setCompletionReminder = async (botId, value) => {
      written.push({ botId, completionReminder: value });
    };
    writeWeb = createWebServer({ service: svc, token: TOKEN, logDir });
    const { port } = await writeWeb.listen(0);
    writeBase = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await writeWeb.close();
  });

  it('写成功 → 200 {ok:true}（前端走 ✅ 已保存）', async () => {
    const res = await fetch(`${writeBase}/api/project/demo/backend?bot=cli_a`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'codex-appserver' }),
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ok).toBe(true);
    expect(written).toEqual([{ botId: 'cli_a', project: 'demo', backend: 'codex-appserver' }]);
  });

  it('校验拒绝（AdminWriteError）→ 409 write_rejected + 中文原因', async () => {
    const res = await fetch(`${writeBase}/api/project/demo/no-mention?bot=cli_a`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: true }),
    });
    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    expect(body.error).toBe('write_rejected');
    expect(body.message).toContain('不存在');
  });

  it('完成提醒保存 → 200，并把每 bot 设置交给 service', async () => {
    const res = await fetch(`${writeBase}/api/bots/cli_a/completion-reminder`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'long', longTaskMinutes: 7 }),
    });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toMatchObject({
      ok: true,
      completionReminder: { mode: 'long', longTaskMinutes: 7 },
    });
    expect(written).toContainEqual({
      botId: 'cli_a',
      completionReminder: { mode: 'long', longTaskMinutes: 7 },
    });
  });

  it.each([
    [{ mode: 'smart', longTaskMinutes: 3 }, 'mode'],
    [{ mode: 'long', longTaskMinutes: 0 }, 'longTaskMinutes'],
    [{ mode: 'long', longTaskMinutes: 1441 }, 'longTaskMinutes'],
    [{ mode: 'long', longTaskMinutes: 2.5 }, 'longTaskMinutes'],
  ])('完成提醒非法输入 %# → 400（%s）', async (input, field) => {
    const res = await fetch(`${writeBase}/api/bots/cli_a/completion-reminder`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).message).toContain(field);
  });
});

describe('web server · 扫码初始化与机器人管理', () => {
  it('POST /api/bots 手填注册入口已下线 → 404', async () => {
    const res = await authed('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'cli_manual1111', appSecret: 'secret' }),
    });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error).toBe('not_found');
  });

  it('GET /api/bots/:appId/setup-status：聚合三/四态 checklist', async () => {
    const body = await jsonOf(await authed('/api/bots/cli_new111111/setup-status'));
    expect(body.appId).toBe('cli_new111111');
    expect(body.credentials.ok).toBe(true);
    expect(body.connection.connection).toBe('connected');
    expect(body.event.state).toBe('ok');
    expect(body.scopes.grantUrl).toContain('/auth?q=');
    expect(body.eventConfigUrl).toContain('/event');
  });

  it('DELETE /api/bots/:appId 成功 → 200 { ok }', async () => {
    const res = await authed('/api/bots/cli_new111111', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).ok).toBe(true);
  });

  it('DELETE /api/bots/:appId 删唯一/带会话 → 409 rejected + 中文原因', async () => {
    const only = await authed('/api/bots/cli_only', { method: 'DELETE' });
    expect(only.status).toBe(409);
    expect((await jsonOf(only)).error).toBe('rejected');
    expect((await jsonOf(await authed('/api/bots/cli_busy', { method: 'DELETE' }))).message).toContain('不能删除');
  });

  it('PATCH /api/bots/:appId { enabled } → 200，缺布尔 → 400，不存在 → 409', async () => {
    const ok = await authed('/api/bots/cli_new111111', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).ok).toBe(true);

    const bad = await authed('/api/bots/cli_new111111', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(bad.status).toBe(400);
    expect((await jsonOf(bad)).error).toBe('invalid_input');

    const missing = await authed('/api/bots/cli_missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(409);
  });
});

describe('web server · daemon 生命周期 / 升级 / 宿主机体检', () => {
  it('GET /api/daemon：service 注册状态 + pid/版本/启动时长', async () => {
    const body = await jsonOf(await authed('/api/daemon'));
    expect(body.installed).toBe(true);
    expect(body.running).toBe(true);
    expect(body.pid).toBe(4242);
    expect(body.supported).toBe(true);
    expect(typeof body.uptimeMs).toBe('number');
  });

  it('POST /api/daemon/restart：只读预览 stub 抛 NotWiredYetError → 501', async () => {
    const res = await authed('/api/daemon/restart', { method: 'POST' });
    expect(res.status).toBe(501);
    expect((await jsonOf(res)).error).toBe('not_wired_yet');
  });

  it('POST /api/daemon/start：未注入 startDaemon 的 stub 抛 NotWiredYetError → 501', async () => {
    const res = await authed('/api/daemon/start', { method: 'POST' });
    expect(res.status).toBe(501);
    expect((await jsonOf(res)).error).toBe('not_wired_yet');
  });

  it('POST /api/daemon/stop：未注入 stopDaemon 的 stub 抛 NotWiredYetError → 501', async () => {
    const res = await authed('/api/daemon/stop', { method: 'POST' });
    expect(res.status).toBe(501);
    expect((await jsonOf(res)).error).toBe('not_wired_yet');
  });

  it('GET /api/console/live：默认服务器（未注入 liveConsole = daemon 自身）→ live:false', async () => {
    const body = await jsonOf(await authed('/api/console/live'));
    expect(body.live).toBe(false);
    expect(body.url).toBeUndefined();
  });

  it('GET /api/console/live：注入 liveConsole（只读预览探到 daemon 已起）→ live:true + 带 token 的可点 URL', async () => {
    const liveWeb = createWebServer({
      service: stubService(),
      token: TOKEN,
      logDir,
      liveConsole: () => ({ port: 55432, token: 'daemon-tok' }),
    });
    const { port } = await liveWeb.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/console/live`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const body = (await res.json()) as { live: boolean; url?: string };
      expect(body.live).toBe(true);
      expect(body.url).toBe('http://127.0.0.1:55432/?token=daemon-tok');
    } finally {
      await liveWeb.close();
    }
  });

  it('GET /api/update/check：current/latest/hasUpdate', async () => {
    const body = await jsonOf(await authed('/api/update/check'));
    expect(body.current).toBe('0.3.11');
    expect(body.latest).toBe('0.4.0');
    expect(body.hasUpdate).toBe(true);
  });

  it('POST /api/update：只读预览 stub 抛 NotWiredYetError → 501', async () => {
    const res = await authed('/api/update', { method: 'POST' });
    expect(res.status).toBe(501);
  });

  it('GET /api/host-doctor：Node/平台/路径/日志体量 + 后端', async () => {
    const body = await jsonOf(await authed('/api/host-doctor'));
    expect(body.node).toBe('v20.11.0');
    expect(body.platform).toBe('darwin');
    expect(body.appDir).toContain('.feishu-codex-bridge');
    expect(typeof body.logBytes).toBe('number');
    expect(body.backends[0].id).toBe('codex-appserver');
  });
});

// SSE 读取小工具：读到出现 needle 为止，返回累积的全部文本（超时即抛）。
async function readSseUntil(res: Response, needle: string, timeoutMs: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (!buf.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`SSE 超时未等到 ${needle}；已收到：${buf}`);
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf;
}

describe('web server · 扫码注册 SSE', () => {
  it('GET /api/bots/register-qr/stream：推 qr → status → done（done 不含 secret）', async () => {
    const res = await authed('/api/bots/register-qr/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const buf = await readSseUntil(res, 'event: done', 4000);
    // qr 帧：含 qrUrl + expireIn + sessionId
    expect(buf).toContain('event: qr');
    expect(buf).toContain('"qrUrl":"https://accounts.feishu.cn/scan?code=abc"');
    expect(buf).toContain('"expireIn":600');
    expect(buf).toContain('"sessionId":"');
    // status 帧
    expect(buf).toContain('event: status');
    expect(buf).toContain('"status":"polling"');
    // done 帧：白名单字段，绝不含 secret
    expect(buf).toContain('event: done');
    expect(buf).toContain('"appId":"cli_scanned9999"');
    expect(buf).toContain('"adminOpenId":"ou_scanner"');
    expect(buf).not.toContain('secret');
    expect(buf).not.toContain('client_secret');
  }, 8000);

  it('扫码失败 → event: error + code/message（expired_token）', async () => {
    const svc = stubService();
    svc.registerBotByQr = async (o) => {
      o.onQr({ url: 'https://accounts.feishu.cn/x', expireIn: 600 });
      return { ok: false as const, code: 'expired_token' as const, reason: '二维码已过期，请重新生成。' };
    };
    const errWeb = createWebServer({ service: svc, token: TOKEN, logDir });
    const { port } = await errWeb.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bots/register-qr/stream`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const buf = await readSseUntil(res, 'event: error', 4000);
      expect(buf).toContain('event: error');
      expect(buf).toContain('"code":"expired_token"');
      expect(buf).toContain('二维码已过期');
    } finally {
      await errWeb.close();
    }
  }, 8000);

  it('abort（DELETE 取消）→ registerBotByQr 收到 signal.aborted，不推 error', async () => {
    // stub 的 registerBotByQr 同步检查 signal.aborted；这里用一个会等 abort 的 stub。
    const svc = stubService();
    svc.registerBotByQr = (o) =>
      new Promise((resolve) => {
        o.onQr({ url: 'https://accounts.feishu.cn/x', expireIn: 600 });
        o.signal.addEventListener('abort', () => resolve({ ok: false as const, code: 'abort' as const, reason: '已取消扫码。' }), {
          once: true,
        });
      });
    const abWeb = createWebServer({ service: svc, token: TOKEN, logDir });
    const { port } = await abWeb.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bots/register-qr/stream`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      // 单 reader 全程读（getReader 会锁流，不能再开第二个）。
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const pump = async (needle: string): Promise<void> => {
        while (!buf.includes(needle)) {
          const { value, done } = await reader.read();
          if (value) buf += decoder.decode(value, { stream: true });
          if (done) return;
        }
      };
      await pump('event: qr');
      // 主动取消：DELETE（不带 sessionId 也应取消当前会话）
      const del = await fetch(`http://127.0.0.1:${port}/api/bots/register-qr`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(del.status).toBe(204);
      // abort 路径静默关闭：读到流结束，buf 里没有 error 帧
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        if (done) break;
      }
      expect(buf).not.toContain('event: error');
    } finally {
      await abWeb.close();
    }
  }, 8000);

  it('扫码 SSE 同样要鉴权：无 token → 401', async () => {
    const res = await get('/api/bots/register-qr/stream');
    expect(res.status).toBe(401);
  });
});

describe('web server · 后端 catalog + 按需安装', () => {
  it('GET /api/backends：catalog + depState/installable/version + 默认（codex-only）', async () => {
    const body = await jsonOf(await authed('/api/backends'));
    expect(body.defaultBackend).toBe('codex-appserver');
    expect(body.entries).toHaveLength(1);
    const codex = body.entries.find((e: { id: string }) => e.id === 'codex-appserver');
    expect(codex).toMatchObject({ depState: 'installed', installable: false, isDefault: true, version: '1.0.0' });
  });

  it('POST /api/backends/:id/install：SSE 推 log → done', async () => {
    const res = await authed('/api/backends/codex-appserver/install', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const buf = await readSseUntil(res, '"type":"done"', 4000);
    expect(buf).toContain('"type":"log"');
    expect(buf).toContain('added 1 package');
    expect(buf).toContain('"type":"done"');
  }, 8000);

  it('POST /api/backends/:id/install：external 不真装 → error', async () => {
    // external-cli 后端（codex）不可一键装：installBackend 返回 {ok:false}，路由吐 error 帧。
    const svc = stubService();
    svc.installBackend = async () => ({
      ok: false as const,
      code: null,
      aborted: false,
      tail: '「Codex」不支持一键下载。手动安装：…',
    });
    const extWeb = createWebServer({ service: svc, token: TOKEN, logDir });
    const { port } = await extWeb.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/backends/codex-appserver/install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const buf = await readSseUntil(res, '"type":"error"', 4000);
      expect(buf).toContain('"type":"error"');
      expect(buf).toContain('不支持一键下载');
    } finally {
      await extWeb.close();
    }
  }, 8000);

  it('只读预览（installBackend 抛 NotWiredYetError）→ error code=not_wired_yet', async () => {
    const svc = stubService();
    svc.installBackend = async () => {
      throw new NotWiredYetError('⬇️ 下载「Codex」');
    };
    const previewWeb = createWebServer({ service: svc, token: TOKEN, logDir });
    const { port } = await previewWeb.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/backends/codex-appserver/install`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const buf = await readSseUntil(res, '"type":"error"', 4000);
      expect(buf).toContain('"code":"not_wired_yet"');
      expect(buf).toContain('daemon');
    } finally {
      await previewWeb.close();
    }
  }, 8000);

  it('后端 API 同样要鉴权：无 token → 401', async () => {
    expect((await get('/api/backends')).status).toBe(401);
    expect((await get('/api/backends/codex-appserver/install', { method: 'POST' })).status).toBe(401);
  });
});

describe('web server · 日志', () => {
  it('GET /api/logs：tail 文本', async () => {
    const res = await authed('/api/logs');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ws');
  });

  it('GET /api/logs/stream：SSE 推送已有日志尾部 + 追加增量', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const file = join(logDir, `${today}.log`);
    writeFileSync(file, '{"event":"first-line"}\n');

    const ac = new AbortController();
    const res = await authed('/api/logs/stream', { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readUntil = async (needle: string, timeoutMs: number): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      while (!buf.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`SSE 超时未等到 ${needle}；已收到：${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      return buf;
    };

    await readUntil('first-line', 3000);
    // 追加一行 → fs.watch 增量推送
    appendFileSync(file, '{"event":"second-line"}\n');
    await readUntil('second-line', 3000);
    expect(buf).toContain('data: {"event":"first-line"}');
    expect(buf).toContain('data: {"event":"second-line"}');
    ac.abort();
  }, 10_000);
});
