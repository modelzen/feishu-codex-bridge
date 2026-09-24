import { CHILD_SHUTDOWN_GRACE_MS, observeShutdown, stopChild, type ShutdownControl } from '../host/lifecycle';
import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';
import { recordServicePid, SERVICE_ENV_FLAG } from '../service/win-startup';
import { log } from '../core/logger';
import type { BotEntry } from '../config/bots';
import { createAdminIpcCaller, type AdminIpcCaller } from '../admin/ipc';
import { AdminWriteError } from '../admin/ops';
import { createAdminService } from '../admin/service';
import { installBackendDep, uninstallBackendDep } from '../agent';
import { spawnDaemonControl } from '../cli/commands/daemon-control';
import { mountWebConsole } from '../web/mount';

/**
 * Multi-bot supervisor. `run` delegates here when more than one bot is active
 * (`bot use` picked a set): each bot runs in its OWN child process
 * (`run --bot <appId>`), so one bot crashing, leaking, or wedging its codex
 * tree can't corrupt or take down the others — the design's "multi-process,
 * one bot per process" model. The supervisor restarts a crashed child with
 * exponential backoff (the OS service manager only restarts the supervisor, not
 * individual children, so child auto-recovery has to live here), and forwards
 * SIGINT/SIGTERM so a graceful stop tears the whole tree down.
 *
 * Children inherit the supervisor's CLI entry (`process.argv[1]`) so this works
 * identically for a global install, npx, and a local `./bin` checkout.
 *
 * Web 控制台（第二棒）：supervisor 是多 bot 聚合点，全局控制台挂在这里（子进程
 * 检测到 'ipc' stdio 就不再各自挂）。读路径直读各 bot 目录的文件快照；写操作与
 * 实时连接状态经 IPC 转发给对应子进程——registry 的 withLock 是进程内锁、LIVE
 * 会话驱逐只能在 bot 进程内做，supervisor 文件级直写既会丢更新也驱逐不了。
 */

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** A child that stays up at least this long resets its backoff to the minimum. */
const HEALTHY_UPTIME_MS = 60_000;

interface Child {
  bot: BotEntry;
  proc?: ChildProcess;
  backoffMs: number;
  restartTimer?: NodeJS.Timeout;
  startedAt: number;
  /** 管理面 IPC（写转发 + 实时状态查询）；子进程重启换新实例，旧在途请求由
   * rejectAll 收尾，绝不悬挂 Web 请求。 */
  ipc?: AdminIpcCaller;
}

/** 实时状态查询（{kind:'status'}）的短超时：/api/state 是 5s 轮询，不能被一个
 * 假死子进程拖住整页——超时按 connection:'unknown' 渲染。 */
const STATUS_IPC_TIMEOUT_MS = 2_000;

export async function runSupervisor(bots: BotEntry[], options: { control?: ShutdownControl; managed?: boolean } = {}): Promise<void> {
  const control = options.control ?? observeShutdown();
  const supervisorStartedAt = Date.now();
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('supervisor: 无法解析 CLI 入口（process.argv[1] 为空）');

  // The supervisor IS the Windows background service process — publish OUR pid to
  // service.pid so `status`/`stop` and the update flow's isServiceRunning() find
  // us. Historically this was never called on the supervisor path (only runSingle
  // / onboarding did), so multi-bot + logon-autostart left service.pid stale →
  // isServiceRunning()=false → the update button silently skipped the restart
  // (restart-skipped-no-service, "updated but not relaunched"). No-op off Windows
  // / when not launched as the service. (recordServicePid reads process.env, which
  // the strip below never touches — see there — so the ordering isn't load-bearing.)
  recordServicePid();

  // Children must NOT record service.pid (that's the supervisor's job on Windows).
  // Strip the flag from a COPY of the env (not process.env — mutating that would
  // also disable the supervisor's own exit-time clearServicePid) so the flag is
  // absent only for children and recordServicePid no-ops in them.
  const childEnv = { ...process.env };
  delete childEnv[SERVICE_ENV_FLAG];

  let shuttingDown = false;
  const children = bots.map<Child>((bot) => ({ bot, backoffMs: BACKOFF_MIN_MS, startedAt: 0 }));

  console.log(`\n正在启动 ${bots.length} 个机器人（各自独立进程）：`);
  for (const b of bots) console.log(`  • ${b.name}  (${b.appId})  [${b.tenant}]`);
  console.log('Ctrl+C 退出（关闭全部）。\n');

  const prefixPipe = (name: string, src: NodeJS.ReadableStream | null, dst: NodeJS.WriteStream): void => {
    if (!src) return;
    let buf = '';
    src.setEncoding('utf8');
    src.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        dst.write(`\x1b[2m[${name}]\x1b[0m ${line}\n`);
      }
    });
    src.on('end', () => {
      if (buf) dst.write(`\x1b[2m[${name}]\x1b[0m ${buf}\n`);
    });
  };

  const spawnChild = (c: Child): void => {
    c.startedAt = Date.now();
    // 'ipc' 通道：子进程据此识别自己被 supervisor 托管（不自己挂 Web 控制台），
    // 并接收管理面写请求（admin/ipc.ts 协议）。
    const proc = spawnProcess(process.execPath, [cliEntry, 'run', '--bot', c.bot.appId], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: childEnv,
    });
    c.proc = proc;
    const ipc = createAdminIpcCaller((msg) => {
      // connected=false 才算通道关闭；send 返回 false 还可能只是背压（消息仍会
      // 送达），不能据此误拒——真丢失由 caller 的超时兜底。
      if (!proc.connected) throw new Error('IPC 通道已关闭');
      proc.send(msg);
    });
    c.ipc = ipc;
    proc.on('message', ipc.onMessage);
    log.info('supervisor', 'child-start', { bot: c.bot.name, appId: c.bot.appId, pid: proc.pid ?? null });
    prefixPipe(c.bot.name, proc.stdout, process.stdout);
    prefixPipe(c.bot.name, proc.stderr, process.stderr);

    proc.on('exit', (code, signal) => {
      c.proc = undefined;
      c.ipc = undefined;
      ipc.rejectAll(`机器人「${c.bot.name}」进程已退出（等待自动重启）`);
      if (shuttingDown) return;
      // Reset backoff if it had been healthy a while; otherwise grow it.
      const uptime = Date.now() - c.startedAt;
      if (uptime >= HEALTHY_UPTIME_MS) c.backoffMs = BACKOFF_MIN_MS;
      const wait = c.backoffMs;
      c.backoffMs = Math.min(c.backoffMs * 2, BACKOFF_MAX_MS);
      log.warn('supervisor', 'child-exit', { bot: c.bot.name, code, signal, restartInMs: wait });
      console.error(
        `\x1b[2m[${c.bot.name}]\x1b[0m 进程退出（code=${code ?? signal ?? '?'}），${Math.round(wait / 1000)}s 后重启…`,
      );
      c.restartTimer = setTimeout(() => spawnChild(c), wait);
    });
    proc.on('error', (err) => {
      log.fail('supervisor', err, { bot: c.bot.name, phase: 'spawn' });
    });
  };

  let webConsole: Awaited<ReturnType<typeof mountWebConsole>>;
  try {
    for (const c of children) spawnChild(c);

    // ── 全局 Web 控制台（多 bot 聚合）─────────────────────────────────────────
    // 读 = 各 bot 目录文件快照（显式路径，不切全局目录）；写 + 实时连接状态 =
    // IPC 转发给对应子进程（崩溃重启窗口内明确拒绝，绝不静默丢写）。
    const byAppId = (botId: string): Child | undefined => children.find((c) => c.bot.appId === botId);
    webConsole = await mountWebConsole(
      createAdminService({
        executeGroups: async (botId, op) => {
          const child = byAppId(botId);
          if (!child?.proc || !child.ipc) throw new AdminWriteError('机器人不在运行中的活跃集里');
          return child.ipc.call(op, 60_000);
        },
        executeWrite: async (botId, op) => {
          const c = byAppId(botId);
          if (!c) throw new AdminWriteError(`机器人「${botId}」不在本次启动的活跃集里（先 \`bot use\` 勾选后重启）。`);
          if (!c.proc || !c.ipc) throw new AdminWriteError(`机器人「${c.bot.name}」进程未在运行（崩溃重启中），稍后重试。`);
          await c.ipc.call(op);
        },
        liveStatus: async (botId) => {
          const c = byAppId(botId);
          if (!c?.proc || !c.ipc) return undefined; // 不归本 supervisor 管 → 锁文件探测兜底
          const r = (await c.ipc.call({ kind: 'status' }, STATUS_IPC_TIMEOUT_MS).catch(() => undefined)) as
            | { connection?: string }
            | undefined;
          return {
            running: true,
            pid: c.proc.pid,
            startedAt: c.startedAt,
            connection: r?.connection ?? 'unknown',
          };
        },
        daemonStartedAt: supervisorStartedAt,
        ...(options.managed ? {} : {
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
        // 含 token 的 URL 只在前台 TTY 打印（后台 stdout 会落盘成日志，token 不进
        // 日志——后台用 `web` 命令经 0600 发现文件跳转）。
        console.log(`🌐 Web 控制台（聚合 ${bots.length} 个机器人）：${webConsole.url}\n`);
      } else {
        console.log(`🌐 Web 控制台已内嵌启动（127.0.0.1:${webConsole.port}）：运行 \`feishu-codex-bridge web\` 获取登录链接。`);
      }
    }

    await control.waitForRequest();
  } finally {
    shuttingDown = true;
    for (const child of children) if (child.restartTimer) clearTimeout(child.restartTimer);
    const live = children.flatMap((child) => child.proc ? [stopChild(child.proc, CHILD_SHUTDOWN_GRACE_MS)] : []);
    const cleanup = await Promise.allSettled([webConsole?.close(), ...live]);
    control.dispose();
    const failures = cleanup.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'Supervisor cleanup failed.');
  }
}
