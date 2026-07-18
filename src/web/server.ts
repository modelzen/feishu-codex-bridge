import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import {
  COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES,
  type CompletionReminderMode,
} from '../config/schema';
import { bridgeVersion } from '../core/version';
import { NotWiredYetError, type AdminService } from '../admin/service';
import { AdminWriteError } from '../admin/ops';
import { UI_HTML } from './ui';
import { GSAP_MIN_JS_BASE64 } from './vendor-gsap';
import { LOGO_PNG_BASE64 } from './vendor-logo';

/** vendored GSAP 解码一次（模块级，不每请求解码）；/vendor/gsap.min.js 路由直接吐这个 Buffer。 */
const GSAP_MIN_JS = Buffer.from(GSAP_MIN_JS_BASE64, 'base64');
/** vendored 品牌 logo（小猫 PNG）解码一次；/vendor/logo.png 路由直接吐这个 Buffer。 */
const LOGO_PNG = Buffer.from(LOGO_PNG_BASE64, 'base64');

/**
 * 本机 Web 控制台 HTTP 面（node:http，零新依赖）。
 *
 * 安全清单（设计文档 §5，逐条落实）：
 *   1. 仅绑定 127.0.0.1，绝不 0.0.0.0；不提供任何「远程访问」配置项。
 *   2. token 鉴权：启动生成随机 token（crypto.randomUUID）；所有请求校验
 *      `Authorization: Bearer` / cookie；`?token=` 仅用于首跳换 cookie（随后
 *      302 去掉 URL 里的 token，防日志/历史记录泄漏长期凭据）。
 *   3. Host/Origin 校验防 DNS rebinding（只认 127.0.0.1 / localhost / [::1]）。
 *   4. 端点最小化：只读（state / diagnosis / logs / sessions / setup-status /
 *      daemon / update.check / host-doctor / backends）+「DM 卡片已有等价操作」的
 *      写入（backend / permission / no-mention / auto-compact / completion-reminder）+ Web 专属（GET
 *      /api/bots/register-qr/stream 扫码注册 SSE + DELETE 取消；
 *      POST /api/backends/:id/install 按需安装 SSE；PATCH/DELETE /api/bots/:id
 *      多 bot 管理；POST /api/daemon/restart 与 /api/update 经 detached helper）。
 *      restart/update/install 只投递固定 action / catalog 内置包名给内部执行器，
 *      绝不暴露「执行任意命令」「装任意 npm 包」「读任意文件」。
 *   5. 日志流只透传现有文件日志行（已是尾 6 位脱敏风格），token 绝不进日志；
 *      扫码会话的 client_secret 仅一次性经内存→keystore，绝不回显/不进日志
 *      （扫码 SSE 的 done 事件白名单字段，
 *      永不含 secret）。
 *
 * 进程形态（第二棒已接）：daemon（run/supervisor 进程）经 web/mount.ts 内嵌同一
 * createWebServer——service 注入 executeWrite（进程内 Orchestrator.adminExecute /
 * supervisor IPC 转发）+ liveStatus（真实 WS 状态），写路由真实生效；独立 `web`
 * 预览进程无 executeWrite → 写仍 501（NotWiredYetError）。
 */

/** 默认端口（设计文档 §3 方案 B 的示例端口）；被占用时 daemon 退临时端口。 */
export const DEFAULT_WEB_PORT = 51847;
export interface WebServerOptions {
  service: AdminService;
  /**
   * 只读预览专用：探测「daemon 的可写控制台是否已在别处跑」。注入即代表本进程是只读
   * 预览（web 命令）——拿到活记录就让前端把用户带去那条可写控制台（见 /api/console/live）。
   * daemon 自身**绝不注入**（否则会把自己当成「别处」无限自跳）。
   */
  liveConsole?: () => { port: number; token: string } | undefined;
  /** 测试注入：日志目录（默认 ~/.feishu-codex-bridge/logs，与 core/logger 同址）。 */
  logDir?: string;
  /** 测试注入：固定 token（默认 crypto.randomUUID()）。 */
  token?: string;
  /** 测试注入：页面 HTML（默认内嵌 UI）。 */
  html?: string;
}

export interface WebServer {
  server: Server;
  token: string;
  /** 监听 127.0.0.1:port（port=0 取临时端口）；返回实际端口与含 token 的可点击 URL。 */
  listen(port: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

const COOKIE_NAME = 'fcb_console_token';
/** SSE 初始回放的日志尾部字节数。 */
const SSE_INITIAL_TAIL_BYTES = 16 * 1024;
const COMPLETION_REMINDER_MODES: readonly CompletionReminderMode[] = ['manual', 'long', 'failures', 'always'];

export function createWebServer(opts: WebServerOptions): WebServer {
  const token = opts.token ?? randomUUID();
  const html = opts.html ?? UI_HTML;
  const logDir = opts.logDir ?? join(paths.appDir, 'logs');
  const sseCleanups = new Set<() => void>();
  /** 一条挂在某安装 job 上的 SSE 连接（发数据 + 收尾本连接）。 */
  interface InstallConn {
    send: (data: unknown) => void;
    done: () => void;
  }
  /** 一次后台安装：npm 子进程跑到底，多个 SSE 连接可观察；某连接断开不影响安装。 */
  interface InstallJob {
    buffer: unknown[];
    conns: Set<InstallConn>;
    abort: AbortController;
    settled: boolean;
  }
  /** 进行中的安装，按 `${id}|${update}` 去重 —— 刷新/重连命中同一 job，绝不并发重复装。 */
  const installJobs = new Map<string, InstallJob>();

  /**
   * 单例扫码会话槽（design §1.4）：同时只允许一个扫码会话——registerApp 每会话都吃
   * 飞书 device_code 配额 + 持续轮询，多开纯浪费；控制台是单机 loopback 单用户工具，
   * 不存在并发注册。新会话**抢占式替换**旧会话（先 abort 旧、再开新），用户刷新页面
   * 不会被僵尸会话卡住。SSE 断开（req.on('close')）→ abort 兜底，杜绝僵尸轮询打飞书。
   */
  let qrSession: { id: string; abort: AbortController } | null = null;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal', message: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ── Host/Origin 校验（防 DNS rebinding）────────────────────────────────
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, { error: 'forbidden_host', message: '仅允许 127.0.0.1 / localhost 访问' });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) {
      sendJson(res, 403, { error: 'forbidden_origin', message: '跨站请求被拒绝' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathName = url.pathname;

    // ── token 鉴权（Bearer / ?token= / cookie 任一匹配即放行）──────────────
    // 关键：检查全部三个来源，任一匹配当前 token 就通过——不能用 `??` 只认第一个
    // 非空来源，否则「带正确 ?token= 但残留了旧 daemon 的过期 cookie」会被旧 cookie
    // 挡死 401（daemon 重启换 token 后浏览器旧窗口的常见症状）。?token= 是用户显式
    // 带的新凭据，必须能盖过过期 cookie。
    const queryToken = url.searchParams.get('token');
    const candidates = [bearerToken(req), queryToken, cookieToken(req)].filter(
      (t): t is string => t !== null,
    );
    if (!candidates.some((t) => safeEqual(t, token))) {
      sendJson(res, 401, { error: 'unauthorized', message: '缺少或错误的 token；请用启动日志里打印的完整 URL 打开' });
      return;
    }
    // ?token= 合法 → 种 cookie；对页面请求再 302 清掉 URL 上的 token。
    const setCookie =
      queryToken !== null && safeEqual(queryToken, token)
        ? `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`
        : undefined;
    if (setCookie && pathName === '/' && req.method === 'GET') {
      res.writeHead(302, { 'Set-Cookie': setCookie, Location: '/' });
      res.end();
      return;
    }
    if (setCookie) res.setHeader('Set-Cookie', setCookie);

    // ── 路由 ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathName === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    // 本地自带的 GSAP（动画引擎）—— 不走 CDN（隐私 + 离线）。已过 token 鉴权（页面种了
    // cookie，同源 <script> 自带）；内容不可变 → 可长缓存。GSAP 缺失时前端动画层是无操作
    // 降级（不影响任何功能），所以这条路由是纯增强。
    if (req.method === 'GET' && pathName === '/vendor/gsap.min.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(GSAP_MIN_JS);
      return;
    }

    // 本地自带的品牌 logo（小猫）—— 同 GSAP：不走外链、已过 cookie 鉴权、内容不可变长缓存。
    if (req.method === 'GET' && pathName === '/vendor/logo.png') {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(LOGO_PNG);
      return;
    }

    if (req.method === 'GET' && pathName === '/api/state') {
      await handleState(res);
      return;
    }

    if (req.method === 'GET' && pathName === '/api/diagnosis') {
      await handleDiagnosis(res, url.searchParams.get('bot'));
      return;
    }

    // ── Web 专属：daemon 生命周期 / 升级 / 宿主机体检 ─────────────────────────
    if (req.method === 'GET' && pathName === '/api/daemon') {
      sendJson(res, 200, await opts.service.getDaemonStatus());
      return;
    }

    // POST /api/daemon/restart —— detached helper 重启（不在 web 进程里杀自己）。
    if (req.method === 'POST' && pathName === '/api/daemon/restart') {
      try {
        await opts.service.restartDaemon();
        sendJson(res, 202, { ok: true, message: '重启已发起：Feishu Bridge 将在数秒内由服务管理器拉起新实例。' });
      } catch (err) {
        if (err instanceof NotWiredYetError) {
          sendJson(res, 501, { error: 'not_wired_yet', message: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    // POST /api/daemon/start —— 启动后台服务（只读预览注入；detached helper service install）。
    if (req.method === 'POST' && pathName === '/api/daemon/start') {
      try {
        await opts.service.startDaemon();
        sendJson(res, 202, {
          ok: true,
          message: '启动已发起：Feishu Bridge 将在数秒内由服务管理器拉起。起来后本页会自动带你进入可写控制台。',
        });
      } catch (err) {
        if (err instanceof NotWiredYetError) {
          sendJson(res, 501, { error: 'not_wired_yet', message: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    // POST /api/daemon/stop —— 停止后台服务并移除自启（detached helper service uninstall）。
    if (req.method === 'POST' && pathName === '/api/daemon/stop') {
      try {
        await opts.service.stopDaemon();
        sendJson(res, 202, {
          ok: true,
          message: '停止已发起：Feishu Bridge 将在数秒内退出（本控制台随之断开，属正常）。',
        });
      } catch (err) {
        if (err instanceof NotWiredYetError) {
          sendJson(res, 501, { error: 'not_wired_yet', message: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    // GET /api/console/live —— 只读预览探测 daemon 的可写控制台是否已在别处起来。起了
    // 就回带 token 的可点 URL（同机同用户、loopback，与 web-console.json 0600 同信任域），
    // 前端据此把用户从只读预览带去可写控制台。daemon 自身没注入 liveConsole → 永远 live:false。
    if (req.method === 'GET' && pathName === '/api/console/live') {
      const live = opts.liveConsole?.();
      if (live) sendJson(res, 200, { live: true, url: `http://127.0.0.1:${live.port}/?token=${live.token}` });
      else sendJson(res, 200, { live: false });
      return;
    }

    if (req.method === 'GET' && pathName === '/api/update/check') {
      sendJson(res, 200, await opts.service.checkUpdate());
      return;
    }

    // GET /api/update/status —— 升级进度/结果（前端点「升级」后轮询：失败会明确报出，
    // 不再像 detached helper 那样静默；成功则 daemon 重启、连接断开由版本变更流接管）。
    if (req.method === 'GET' && pathName === '/api/update/status') {
      sendJson(res, 200, opts.service.updateStatus());
      return;
    }

    // POST /api/update —— 升级（默认只检测不自动升级；点按钮才到这）。
    if (req.method === 'POST' && pathName === '/api/update') {
      try {
        await opts.service.applyUpdate();
        sendJson(res, 202, { ok: true, message: '升级已发起：安装完成后 Feishu Bridge 会自动重启加载新版本。' });
      } catch (err) {
        if (err instanceof NotWiredYetError) {
          sendJson(res, 501, { error: 'not_wired_yet', message: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    if (req.method === 'GET' && pathName === '/api/host-doctor') {
      sendJson(res, 200, await opts.service.hostDoctor());
      return;
    }

    // ── Web 专属：扫码初始化 / 添加机器人（day-0）───────────────────────────
    // GET /api/bots/register-qr/stream —— 扫码注册 SSE（启动 registerApp 会话，推
    // qr → status* → done/error 全程）。EventSource 只能 GET，鉴权靠 cookie。
    // 必须排在 /^\/api\/bots\/([^/]+)$/ 的 botMatch 之前（否则 register-qr 被当 appId）。
    if (req.method === 'GET' && pathName === '/api/bots/register-qr/stream') {
      handleRegisterQrStream(req, res);
      return;
    }

    // DELETE /api/bots/register-qr —— 主动取消当前扫码会话（abort signal）。
    if (req.method === 'DELETE' && pathName === '/api/bots/register-qr') {
      const sessionId = url.searchParams.get('sessionId');
      // 带 sessionId 时仅当匹配当前会话才 abort（抢占式替换下防旧页面误杀新会话）。
      if (sessionId === null || (qrSession && qrSession.id === sessionId)) {
        qrSession?.abort.abort();
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /api/bots/:appId/setup-status —— 初始化 checklist 聚合（向导页 5s 轮询）。
    const setupMatch = /^\/api\/bots\/([^/]+)\/setup-status$/.exec(pathName);
    if (req.method === 'GET' && setupMatch) {
      const status = await opts.service.getSetupStatus(decodeURIComponent(setupMatch[1]!));
      sendJson(res, 200, status);
      return;
    }

    // POST /api/bots/:appId/completion-reminder —— 每 bot 的普通任务结束提醒。
    // Web 只投递结构化 op；真正的 config.json 落盘与 LIVE cfg 热更新在 bot 进程内完成。
    const completionReminderMatch = /^\/api\/bots\/([^/]+)\/completion-reminder$/.exec(pathName);
    if (req.method === 'POST' && completionReminderMatch) {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_body', message: '请求体必须是 JSON' });
        return;
      }
      const mode = body.mode as CompletionReminderMode;
      const minutes = body.longTaskMinutes;
      if (!COMPLETION_REMINDER_MODES.includes(mode)) {
        sendJson(res, 400, { error: 'invalid_input', message: 'mode 必须是 manual / long / failures / always' });
        return;
      }
      if (
        typeof minutes !== 'number' ||
        !Number.isInteger(minutes) ||
        minutes < COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES ||
        minutes > COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES
      ) {
        sendJson(res, 400, {
          error: 'invalid_input',
          message:
            `longTaskMinutes 必须是 ${COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES}–` +
            `${COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES} 之间的整数`,
        });
        return;
      }
      try {
        await opts.service.setCompletionReminder(decodeURIComponent(completionReminderMatch[1]!), {
          mode,
          longTaskMinutes: minutes,
        });
        sendJson(res, 200, { ok: true, completionReminder: { mode, longTaskMinutes: minutes } });
      } catch (err) {
        if (err instanceof NotWiredYetError) {
          sendJson(res, 501, { error: 'not_wired_yet', message: err.message });
        } else if (err instanceof AdminWriteError) {
          sendJson(res, 409, { error: 'write_rejected', message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }

    // PATCH /api/bots/:appId { enabled } —— 多 bot 管理：切活跃集（bots.json 落盘）。
    const botMatch = /^\/api\/bots\/([^/]+)$/.exec(pathName);
    if (req.method === 'PATCH' && botMatch) {
      const appId = decodeURIComponent(botMatch[1]!);
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_body', message: '请求体必须是 JSON' });
        return;
      }
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'invalid_input', message: 'enabled 必须是布尔值' });
        return;
      }
      const r = await opts.service.setBotEnabled(appId, body.enabled);
      if (r.ok) {
        sendJson(res, 200, {
          ok: true,
          message: '已保存。改活跃集需重启 Feishu Bridge 才生效（在「Feishu Bridge」卡点重启，或终端 `restart`）。',
        });
      } else {
        sendJson(res, 409, { error: 'rejected', message: r.reason });
      }
      return;
    }

    // DELETE /api/bots/:appId —— 删除机器人（注册表 + keystore + 状态目录）。
    // service 层守门：拒删唯一 bot / 带运行中会话的 bot（清晰 reason → 409）。
    if (req.method === 'DELETE' && botMatch) {
      const r = await opts.service.deleteBot(decodeURIComponent(botMatch[1]!));
      if (r.ok) sendJson(res, 200, { ok: true, message: '已删除该机器人的注册表项、密钥与状态目录。' });
      else sendJson(res, 409, { error: 'rejected', message: r.reason });
      return;
    }

    if (req.method === 'GET' && pathName === '/api/logs') {
      const maxBytes = clampInt(url.searchParams.get('maxBytes'), 1024, 256 * 1024, 64 * 1024);
      const text = await opts.service.tailLogs({ maxBytes });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
      return;
    }

    if (req.method === 'GET' && pathName === '/api/logs/stream') {
      handleLogStream(req, res);
      return;
    }

    // ── Web 专属：后端 catalog 预览 + 按需安装（backend-catalog-ondemand.md）──────
    // GET /api/backends —— catalog + 每条依赖态（installed/not-installed/external-missing）
    // + installable + approxSizeMB + version + 当前全局默认。读路径，不需 daemon。
    if (req.method === 'GET' && pathName === '/api/backends') {
      sendJson(res, 200, await opts.service.listBackendCatalog());
      return;
    }

    // POST /api/backends/:id/install —— 按需安装 SSE：推 {type:'log'} 进度块 →
    // {type:'done'}/{type:'error'}。仅 installable 的可装；external 返回指引不真装；
    // 只读预览（无 installer 注入）→ {type:'error',code:'not_wired_yet'}。
    const installMatch = /^\/api\/backends\/([^/]+)\/install$/.exec(pathName);
    if (req.method === 'POST' && installMatch) {
      handleBackendInstall(req, res, decodeURIComponent(installMatch[1]!), false);
      return;
    }

    // POST /api/backends/:id/update —— 更新到 npm 最新版（同安装 SSE，装 @latest）。
    const updateMatch = /^\/api\/backends\/([^/]+)\/update$/.exec(pathName);
    if (req.method === 'POST' && updateMatch) {
      handleBackendInstall(req, res, decodeURIComponent(updateMatch[1]!), true);
      return;
    }

    // GET /api/backends/:id/version —— 已装版本 + npm 最新版 + 有无更新（npm view，较慢）。
    const verMatch = /^\/api\/backends\/([^/]+)\/version$/.exec(pathName);
    if (req.method === 'GET' && verMatch) {
      sendJson(res, 200, await opts.service.backendVersion(decodeURIComponent(verMatch[1]!)));
      return;
    }

    // DELETE /api/backends/:id —— 卸载（rm 用户私装目录里的包 + 清 package.json 条目）。
    const uninstMatch = /^\/api\/backends\/([^/]+)$/.exec(pathName);
    if (req.method === 'DELETE' && uninstMatch) {
      try {
        const r = await opts.service.uninstallBackend(decodeURIComponent(uninstMatch[1]!));
        sendJson(res, r.ok ? 200 : 409, r);
      } catch (err) {
        if (err instanceof NotWiredYetError) sendJson(res, 501, { ok: false, message: err.message });
        else throw err;
      }
      return;
    }

    // GET /api/project/:name/sessions —— 🧵 话题钻取
    const sessionsMatch = /^\/api\/project\/([^/]+)\/sessions$/.exec(pathName);
    if (req.method === 'GET' && sessionsMatch) {
      const botId = url.searchParams.get('bot') ?? (await defaultBotId());
      if (!botId) {
        sendJson(res, 404, { error: 'no_bot', message: '没有已注册的机器人' });
        return;
      }
      const sessions = await opts.service.listSessions(botId, decodeURIComponent(sessionsMatch[1]!));
      sendJson(res, 200, { sessions });
      return;
    }

    // POST 写操作 —— daemon 进程内为真实写入（共享 admin/ops.ts，与 DM 卡片同
    // 源）；只读预览进程映射 501（NotWiredYetError），校验拒绝映射 409。
    const writeMatch = /^\/api\/project\/([^/]+)\/(backend|permission|no-mention|auto-compact)$/.exec(pathName);
    if (req.method === 'POST' && writeMatch) {
      const project = decodeURIComponent(writeMatch[1]!);
      const action = writeMatch[2]!;
      const botId = url.searchParams.get('bot') ?? (await defaultBotId());
      if (!botId) {
        sendJson(res, 404, { error: 'no_bot', message: '没有已注册的机器人' });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'bad_body', message: '请求体必须是 JSON' });
        return;
      }
      try {
        if (action === 'backend') {
          await opts.service.switchBackend(botId, project, String(body.backend ?? ''));
        } else if (action === 'permission') {
          await opts.service.setPermissionMode(botId, project, {
            mode: body.mode as never,
            guestMode: body.guestMode as never,
            network: typeof body.network === 'boolean' ? body.network : undefined,
          });
        } else if (action === 'no-mention') {
          await opts.service.setNoMention(botId, project, body.on === true);
        } else {
          await opts.service.setAutoCompact(botId, project, body.on === true);
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        if (err instanceof NotWiredYetError) {
          // 只读预览进程（daemon 未跑）：引导用户起 daemon 后从其控制台操作。
          sendJson(res, 501, { error: 'not_wired_yet', message: err.message });
          return;
        }
        if (err instanceof AdminWriteError) {
          // 校验拒绝（项目不存在 / 后端不可用 / 档位不支持 / bot 进程未在跑）：
          // 中文原因原样上 body，UI toast 直接展示。
          sendJson(res, 409, { error: 'write_rejected', message: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  async function defaultBotId(): Promise<string | undefined> {
    const bots = await opts.service.listBots();
    return (bots.find((b) => b.current) ?? bots[0])?.appId;
  }

  /** GET /api/state —— bots + projects(+话题数) 聚合快照，前端 5s 轮询。 */
  async function handleState(res: ServerResponse): Promise<void> {
    const bots = await opts.service.listBots();
    const out = [];
    for (const b of bots) {
      const projects = await opts.service.listProjects(b.appId).catch(() => []);
      out.push({ ...b, projects });
    }
    sendJson(res, 200, { version: bridgeVersion(), generatedAt: Date.now(), bots: out });
  }

  /**
   * GET /api/bots/register-qr/stream —— 扫码注册 SSE。启动 registerApp 会话，按
   * `event: qr|status|done|error` 推送全程；单例 qrSession 抢占式替换；SSE 断开
   * → abort 兜底（防僵尸轮询）。secret 绝不经前端：service 内 resolve 后直接进
   * keystore，done payload 只回白名单字段（appId/name/tenant/adminOpenId/botName/missingScopes）。
   */
  function handleRegisterQrStream(req: IncomingMessage, res: ServerResponse): void {
    // 抢占式替换：先 abort 旧会话（旧 EventSource 收到 abort 静默关闭），再开新会话。
    qrSession?.abort.abort();
    const abort = new AbortController();
    const session = { id: randomUUID(), abort };
    qrSession = session;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => res.write(': ka\n\n'), 15_000);

    let ended = false;
    const sendEvent = (event: string, data: unknown): void => {
      if (ended) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const finish = (): void => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      sseCleanups.delete(cleanup);
      // 只在仍是本会话时清槽（抢占替换后旧会话结束不能误清新会话）。
      if (qrSession === session) qrSession = null;
      res.end();
    };
    // cleanup 用于连接断开 / 服务器关闭：abort 后台轮询 + 收尾。
    const cleanup = (): void => {
      abort.abort();
      finish();
    };
    sseCleanups.add(cleanup);
    req.on('close', cleanup);

    void opts.service
      .registerBotByQr({
        signal: abort.signal,
        onQr: (info) => sendEvent('qr', { qrUrl: info.url, expireIn: info.expireIn, sessionId: session.id }),
        onStatus: (info) => sendEvent('status', { status: info.status, interval: info.interval }),
      })
      .then((result) => {
        if (result.ok) {
          // done payload 白名单字段——绝不含 client_secret（已进 keystore）。
          sendEvent('done', {
            appId: result.appId,
            name: result.name,
            tenant: result.tenant,
            adminOpenId: result.adminOpenId,
            botName: result.botName,
            missingScopes: result.missingScopes,
          });
        } else if (result.code === 'abort') {
          // 用户主动取消 / 连接断开：静默关闭，不渲染错误。
        } else {
          sendEvent('error', { code: result.code, message: result.reason });
        }
      })
      .catch((err) => {
        sendEvent('error', { code: 'unknown', message: err instanceof Error ? err.message : String(err) });
      })
      .finally(finish);
  }

  /**
   * POST /api/backends/:id/install —— 按需安装 SSE。流式推 {type:'log'} npm 进度块
   * → {type:'done'}（ok）/{type:'error'}（失败/未装成/external/501）。
   *
   * 安装**脱离单个 SSE 连接的生命周期**：一次安装(265MB SDK 要装 1-3 分钟)登记在
   * {@link installJobs}，npm 子进程在后台跑到底；SSE 断开(用户刷新/切走)**只摘掉这个
   * 监听、绝不 abort/回滚**——否则刷一下就把半成品删了(实测踩坑)。重连(再点下载)会
   * 命中同一 job、回放已有日志 + 续看实时进度,绝不重复装。安装完成后清掉 job,
   * /api/backends 经文件系统探测即显示「已装」。
   */
  function handleBackendInstall(req: IncomingMessage, res: ServerResponse, id: string, update: boolean): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      try {
        res.write(': ka\n\n');
      } catch {
        /* socket gone */
      }
    }, 15_000);

    let ended = false;
    const conn: InstallConn = {
      send: (data) => {
        if (ended) return;
        try {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* socket gone */
        }
      },
      done: () => {
        if (ended) return;
        ended = true;
        clearInterval(heartbeat);
        sseCleanups.delete(conn.done);
        try {
          res.end();
        } catch {
          /* already closed */
        }
      },
    };
    sseCleanups.add(conn.done);

    const key = `${id}|${update ? 1 : 0}`;
    const running = installJobs.get(key);
    if (running && !running.settled) {
      // 已有安装在后台跑 → 挂上去（回放日志 + 续看实时进度），绝不重复装。
      running.buffer.forEach(conn.send);
      running.conns.add(conn);
      req.on('close', () => {
        running.conns.delete(conn);
        conn.done();
      });
      return;
    }

    // 新安装：登记 job，后台跑到底；SSE 断开不 abort（安装继续）。
    const job: InstallJob = { buffer: [], conns: new Set([conn]), abort: new AbortController(), settled: false };
    installJobs.set(key, job);
    req.on('close', () => {
      job.conns.delete(conn);
      conn.done(); // 只结束本连接；安装继续后台跑（不 abort、不回滚）
    });
    const emit = (data: Record<string, unknown>): void => {
      if (data.type === 'log') job.buffer.push(data);
      for (const c of [...job.conns]) c.send(data);
    };

    void opts.service
      .installBackend(id, (chunk) => emit({ type: 'log', chunk }), job.abort.signal, { update })
      .then((result) => {
        emit(
          result.ok
            ? { type: 'done' }
            : { type: 'error', code: result.aborted ? 'aborted' : 'install_failed', message: result.tail },
        );
      })
      .catch((err) => {
        const code = err instanceof NotWiredYetError ? 'not_wired_yet' : 'unknown';
        emit({ type: 'error', code, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        job.settled = true;
        installJobs.delete(key);
        for (const c of [...job.conns]) c.done();
      });
  }

  /** GET /api/diagnosis —— 事件订阅三态 + 各后端环境体检（按需，较慢）。 */
  async function handleDiagnosis(res: ServerResponse, botParam: string | null): Promise<void> {
    const botId = botParam ?? (await defaultBotId());
    const [backends, event] = await Promise.all([
      opts.service.doctorBackends(),
      botId ? opts.service.eventDiagnosis(botId) : Promise.resolve(undefined),
    ]);
    sendJson(res, 200, { bot: botId, backends, event });
  }

  /**
   * GET /api/logs/stream —— SSE 实时跟随当日文件日志。
   * 初始回放今日文件尾部，之后 fs.watch 目录 + 按 offset 增量读；跨天自动切到
   * 新的 YYYY-MM-DD.log。EventSource 不能带 header，鉴权靠 cookie（首跳已种）。
   */
  function handleLogStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    let currentFile = todayLogFile(logDir);
    let offset = 0;
    let reading = false;
    let pending = false;
    let closed = false;

    const sendLines = (text: string): void => {
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        res.write(`data: ${line}\n\n`);
      }
    };

    /** 从 offset 起把新增字节读出来推送；并发触发时合并成一次补读。 */
    const pump = async (): Promise<void> => {
      if (closed) return;
      if (reading) {
        pending = true;
        return;
      }
      reading = true;
      try {
        const today = todayLogFile(logDir);
        if (today !== currentFile) {
          currentFile = today; // 跨天：切新文件从头读
          offset = 0;
        }
        const st = await stat(currentFile).catch(() => null);
        if (!st) return;
        if (st.size < offset) offset = 0; // 文件被轮转/截断
        if (st.size === offset) return;
        const fh = await open(currentFile, 'r');
        try {
          const buf = Buffer.alloc(st.size - offset);
          await fh.read(buf, 0, buf.length, offset);
          offset = st.size;
          sendLines(buf.toString('utf8'));
        } finally {
          await fh.close();
        }
      } finally {
        reading = false;
        if (pending && !closed) {
          pending = false;
          void pump();
        }
      }
    };

    // 初始回放：今日文件最后 SSE_INITIAL_TAIL_BYTES 字节（丢掉可能的半行）。
    void (async () => {
      const st = await stat(currentFile).catch(() => null);
      if (st && st.size > 0) {
        const start = Math.max(0, st.size - SSE_INITIAL_TAIL_BYTES);
        const fh = await open(currentFile, 'r');
        try {
          const buf = Buffer.alloc(st.size - start);
          await fh.read(buf, 0, buf.length, start);
          let text = buf.toString('utf8');
          if (start > 0) {
            const nl = text.indexOf('\n');
            text = nl === -1 ? '' : text.slice(nl + 1);
          }
          offset = st.size;
          sendLines(text);
        } finally {
          await fh.close();
        }
      }
    })().catch(() => undefined);

    // 监听目录而不是单个文件：今日文件可能尚不存在（首条日志才创建）。
    let watcher: FSWatcher | undefined;
    try {
      mkdirSync(logDir, { recursive: true });
      watcher = watch(logDir, () => void pump());
    } catch {
      /* 监听失败 → 退化为只有心跳；下一棒可换轮询 */
    }
    const heartbeat = setInterval(() => res.write(': ka\n\n'), 15_000);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        watcher?.close();
      } catch {
        /* noop */
      }
      sseCleanups.delete(cleanup);
      res.end();
    };
    sseCleanups.add(cleanup);
    req.on('close', cleanup);
  }

  return {
    server,
    token,
    listen(port: number): Promise<{ port: number; url: string }> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // 安全清单 #1：仅 loopback，绝不 0.0.0.0。
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address();
          const actual = typeof addr === 'object' && addr ? addr.port : port;
          resolve({ port: actual, url: `http://127.0.0.1:${actual}/?token=${token}` });
        });
      });
    },
    close(): Promise<void> {
      for (const cleanup of [...sseCleanups]) cleanup();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

function cookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return null;
}

/** 常数时间比较（长度不同直接 false，不泄漏前缀匹配进度）。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function todayLogFile(dir: string): string {
  return join(dir, `${new Date().toISOString().slice(0, 10)}.log`);
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
  return parsed as Record<string, unknown>;
}
