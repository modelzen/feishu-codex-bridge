import { observeShutdown, type ShutdownControl } from '../../host/lifecycle';
import { ensureOnboarded, announceEventsWhenLive } from '../../bot/onboarding';
import { startBridge } from '../../bot/bridge';
import { runSupervisor } from '../../bot/supervisor';
import { acquireSingleInstanceLock, BridgeAlreadyRunningError } from '../../core/single-instance';
import { clearServicePid, recordServicePid } from '../../service/win-startup';
import { activeBots, ensureRegistry } from '../../config/bots';
import { log } from '../../core/logger';
import { AdminWriteError } from '../../admin/ops';
import { createAdminIpcResponder } from '../../admin/ipc';
import { createAdminService } from '../../admin/service';
import { installBackendDep, uninstallBackendDep } from '../../agent';
import { spawnDaemonControl } from './daemon-control';
import { mountWebConsole, type MountedWebConsole } from '../../web/mount';

export async function runRun(botName?: string, options: { control?: ShutdownControl; managed?: boolean } = {}): Promise<void> {
  const control = options.control ?? observeShutdown();
  const managed = Boolean(options.managed);
  // Explicit selector always runs exactly that one bot inline (this is also how
  // the supervisor launches each child: `run --bot <appId>`).
  if (botName) {
    await runSingle(botName, control, managed);
    return;
  }

  let registry = await ensureRegistry();
  if (registry.bots.length === 0 && process.stdout.isTTY) {
    const ready = await ensureOnboarded({ allowCreate: true });
    if (!ready) { process.exitCode = 1; return; }
    registry = await ensureRegistry();
  }
  await runSupervisor(activeBots(registry), { control, managed });
}

/** Run a single bot inline in this process. `botName` undefined → the implicit
 *  current/default bot (with first-run onboarding allowed). */
async function runSingle(botName: string | undefined, control: ShutdownControl, managed: boolean): Promise<void> {
  const ready = await ensureOnboarded({ allowCreate: !botName, bot: botName });
  if (!ready) {
    process.exitCode = 1;
    return;
  }
  const { cfg, secret } = ready;

  // Refuse to run alongside another bridge for the same app — two long
  // connections split card callbacks and make buttons flaky (see module doc).
  let releaseLock: () => void;
  try {
    releaseLock = acquireSingleInstanceLock(cfg.accounts.app.id);
  } catch (err) {
    if (err instanceof BridgeAlreadyRunningError) {
      // startNow (Windows service) eagerly wrote our pid to service.pid before we
      // lost the lock — drop it so it doesn't linger as a dead pid (no-op unless
      // service.pid still points at us; the live winner keeps its own).
      clearServicePid();
      console.error(`✗ ${err.message}`);
      log.info('run', 'already-running', { pid: err.pid });
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // If launched as the Windows background service, publish our PID so
  // `status`/`stop` can find us (no-op for a foreground run / other platforms /
  // a supervised child, whose service env flag the supervisor strips).
  recordServicePid();

  const fallbackCwd = process.env.FEISHU_CODEX_CWD || process.cwd();
  console.log('\n正在启动长连接 bot…');
  console.log('私聊我 `/new <名>` 建项目；在项目群里 @我 干活。Ctrl+C 退出。\n');
  const handle = await startBridge({ cfg, appSecret: secret, fallbackCwd });
  // 配置长连接需要 bridge 在线，启动后继续检查用户发布的订阅更新。
  void announceEventsWhenLive(ready);

  // ── Web 控制台 / supervisor IPC（按进程形态二选一）────────────────────────
  let webConsole: MountedWebConsole | undefined;
  if (process.send) {
    // supervisor 子进程（'ipc' stdio）：控制台由 supervisor 聚合挂载，本进程只
    // 接写请求——在进程内执行（registry withLock + 共享校验 + 驱逐 LIVE 会话，
    // 这正是写操作必须 IPC 转发、不能 supervisor 文件直写的原因）。status 请求
    // 回报真实 WS 连接状态，替代锁文件探测。
    const respond = createAdminIpcResponder(
      async (op) => {
        if (op.kind === 'status') {
          return { connection: handle.channel.getConnectionStatus?.()?.state ?? 'unknown' };
        }
        if (op.kind === 'collaboration') return handle.collaboration(op.request);
        if (op.kind === 'joinedGroups' || op.kind === 'bindGroup') return handle.adminGroups(op);
        if (op.kind === 'settingsRead') return handle.settings.read(op.scope);
        if (op.kind === 'settingsModels') return handle.settings.models(op.query);
        return handle.adminExecute(op);
      },
      (msg) => void process.send?.(msg),
    );
    process.on('message', respond);
  } else {
    // 独立 daemon（单 bot inline）：进程内挂全局控制台。本 bot 的写/实时状态走
    // 进程内 orchestrator；其他已注册 bot 仍可只读快照（写需该 bot 进程在跑——
    // 多 bot 写请用 `bot use` 选多个后由 supervisor 聚合）。
    const ownAppId = cfg.accounts.app.id;
    const startedAt = Date.now();
    webConsole = await mountWebConsole(
      createAdminService({
        executeCollaboration: async (botId, request) => {
          if (botId !== ownAppId) throw new AdminWriteError('机器人不在本进程的活跃集里');
          return handle.collaboration(request);
        },
        executeGroups: async (botId, op) => {
          if (botId !== ownAppId) throw new AdminWriteError('机器人不在本进程的活跃集里');
          return handle.adminGroups(op);
        },
        executeSettingsRead: async (botId, op) => {
          if (botId !== ownAppId) throw new AdminWriteError('机器人不在本进程的活跃集里');
          return op.kind === 'settingsRead' ? handle.settings.read(op.scope) : handle.settings.models(op.query);
        },
        executeWrite: async (botId, op) => {
          if (botId !== ownAppId) {
            throw new AdminWriteError(
              '该机器人不归本进程管：当前是单 bot 运行模式，只能改本 bot 的项目。多 bot 请 `bot use` 勾选后重启，由 supervisor 聚合管理。',
            );
          }
          return handle.adminExecute(op);
        },
        liveStatus: async (botId) =>
          botId === ownAppId
            ? {
                running: true,
                pid: process.pid,
                startedAt,
                connection: handle.channel.getConnectionStatus?.()?.state ?? 'unknown',
              }
            : undefined,
        daemonStartedAt: startedAt,
        // 重启 / 升级 / 停止走 detached helper：本进程被 service stop 杀掉后由 helper 续命。
        ...(managed ? {} : {
          restartDaemon: () => spawnDaemonControl('restart'),
          applyUpdate: () => spawnDaemonControl('update'),
          stopDaemon: () => spawnDaemonControl('stop'),
        }),
        // 按需后端安装在 daemon 进程内直跑（owns runtime，装完即能解析加载）。
        installBackend: installBackendDep,
        uninstallBackend: uninstallBackendDep,
      }),
    );
    if (webConsole) {
      if (process.stdout.isTTY) {
        // 含 token 的 URL 只在前台 TTY 打印；后台 daemon 的 stdout 会被 launchd/
        // systemd 重定向落盘——token 绝不进日志，后台改用 `web` 命令经 0600 发现
        // 文件跳转。
        console.log(`🌐 Web 控制台：${webConsole.url}`);
        console.log('   仅本机可访问（127.0.0.1）；URL 含 token 勿外传。也可随时 `feishu-codex-bridge web` 重新打开。\n');
      } else {
        console.log(`🌐 Web 控制台已内嵌启动（127.0.0.1:${webConsole.port}）：运行 \`feishu-codex-bridge web\` 获取登录链接。`);
      }
    }
  }

  await control.waitForRequest();
  try {
    await webConsole?.close();
    await handle.shutdown();
  } finally { releaseLock(); }
}
