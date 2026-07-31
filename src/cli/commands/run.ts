import { ensureOnboarded, announceEventsWhenLive } from '../../bot/onboarding';
import { acquireSingleInstanceLock, BridgeAlreadyRunningError } from '../../core/single-instance';
import { acquireHostRuntimeLease, RuntimeAlreadyOwnedError, type HostRuntimeLease } from '../../core/runtime-lock';
import { clearServicePid, recordServicePid } from '../../service/win-startup';
import {
  activeBots,
  findBot,
  loadBots,
  type BotEntry,
} from '../../config/bots';
import { log } from '../../core/logger';
import { AdminWriteError } from '../../admin/ops';
import { createAdminService } from '../../admin/service';
import { installBackendDep, uninstallBackendDep } from '../../agent';
import { spawnDaemonControl } from './daemon-control';
import { mountWebConsole, type MountedWebConsole } from '../../web/mount';
import {
  startBridgeRuntime,
  type RunningBridgeRuntime,
} from '../../runtime/index';
import {
  CliRuntimeHost,
  type PreparedCliBot,
} from '../runtime-host';

/**
 * CLI host for the same public Runtime embedded by Vonvon Bridge.
 *
 * Terminal, daemon, and Web-console concerns stay here. Runtime owns one
 * worker per robot, readiness, restart policy, and administrative routing.
 */
export async function runRun(botName?: string): Promise<void> {
  let hostLease: HostRuntimeLease | undefined;
  if (!process.send) {
    try {
      hostLease = acquireHostRuntimeLease({
        owner: { kind: 'cli', product: 'feishu-codex-bridge' },
      });
    } catch (error) {
      if (error instanceof RuntimeAlreadyOwnedError) {
        clearServicePid();
        console.error(`✗ ${error.message}`);
        log.info('run', 'runtime-already-owned', {
          owner: error.owner.kind,
          pid: error.owner.pid,
        });
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  }

  try {
    const registry = await loadBots();
    const selected = botName
      ? selectedBot(registry, botName)
      : activeBots(registry);
    if (selected.length === 0 && !botName && !process.stdout.isTTY) {
      await runOnboardingConsole();
      return;
    }
    const prepared = await prepareBots(selected, botName);
    if (prepared.length === 0) {
      process.exitCode = 1;
      return;
    }
    await runPublicRuntime(prepared);
  } finally {
    hostLease?.release();
  }
}
/**
 * 零 bot 引导守护：还没有任何机器人时，不报错退出，而是只起一个**可写**的 Web 控制台，
 * 用户在浏览器里扫码创建第一个机器人即可（registerBotByQr 不依赖任何在跑的 bot）。创建后
 * 重启 daemon（空注册表→首 bot 自动成为 current/active）该 bot 即上线。这是「一句话安装」
 * 落地体验的关键：codex/claude 非交互地起好它 + 打印网址，用户全程在浏览器里点完。
 */
async function runOnboardingConsole(): Promise<void> {
  let releaseLock: () => void;
  try {
    releaseLock = acquireSingleInstanceLock('__onboarding__');
  } catch (err) {
    if (err instanceof BridgeAlreadyRunningError) {
      // If we were spawned by startNow (Windows service), it eagerly wrote our
      // pid to service.pid before we lost the lock — drop it so it doesn't stick
      // as a dead pid (clearServicePid only unlinks if it still points at us).
      clearServicePid();
      console.error(`✗ ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  recordServicePid();
  const startedAt = Date.now();
  const webConsole = await mountWebConsole(
    createAdminService({
      daemonStartedAt: startedAt,
      // 引导态没有 bot → 不注入 executeWrite/liveStatus；但全局能力齐备：扫码建 bot
      // （registerBotByQr 自给自足）、按需下载后端、重启/升级。
      restartDaemon: () => spawnDaemonControl('restart'),
      applyUpdate: () => spawnDaemonControl('update'),
      stopDaemon: () => spawnDaemonControl('stop'),
      installBackend: installBackendDep,
      uninstallBackend: uninstallBackendDep,
    }),
  );
  if (!webConsole) {
    console.error('✗ Web 控制台未能启动，无法进入引导（端口被占用？）。');
    releaseLock();
    process.exitCode = 1;
    return;
  }
  console.log('\n还没有配置任何飞书机器人 —— 已进入「引导控制台」，到浏览器里扫码创建第一个：');
  if (process.stdout.isTTY) {
    console.log(`\n🌐 ${webConsole.url}`);
    console.log('   仅本机可访问（127.0.0.1）；URL 含 token 勿外传。\n');
  } else {
    console.log(
      `\n🌐 Web 控制台已启动（127.0.0.1:${webConsole.port}）。运行 ` +
        '`feishu-codex-bridge web` 获取带 token 的登录链接，在浏览器里扫码创建机器人；建完重启即上线。\n',
    );
  }
  log.info('run', 'onboarding-console-up', { port: webConsole.port });

  let stopping = false;
  const stop = (sig: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${sig}，正在退出引导控制台…`);
    void (webConsole.close() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => {
        releaseLock();
        process.exit(0);
      });
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => stop(sig));
  }
  await new Promise<never>(() => {});
}

function selectedBot(
  registry: Awaited<ReturnType<typeof loadBots>>,
  nameOrAppId: string,
): BotEntry[] {
  const bot = findBot(registry, nameOrAppId);
  return bot === undefined ? [] : [bot];
}

async function prepareBots(
  selected: readonly BotEntry[],
  explicitName: string | undefined,
): Promise<PreparedCliBot[]> {
  if (selected.length === 0) {
    const ready = await ensureOnboarded({
      allowCreate: explicitName === undefined,
      ...(explicitName === undefined ? {} : { bot: explicitName }),
    });
    if (!ready) return [];
    const registry = await loadBots();
    const entry = findBot(registry, ready.cfg.accounts.app.id);
    if (!entry) return [];
    return [{ entry, config: ready.cfg, initialSecret: ready.secret }];
  }

  const prepared: PreparedCliBot[] = [];
  for (const entry of selected) {
    const ready = await ensureOnboarded({ bot: entry.appId });
    if (!ready) continue;
    prepared.push({
      entry,
      config: ready.cfg,
      initialSecret: ready.secret,
    });
  }
  return prepared;
}

async function runPublicRuntime(prepared: readonly PreparedCliBot[]): Promise<void> {
  recordServicePid();
  console.log(`\n正在启动 ${prepared.length} 个机器人（公共 Bridge Runtime）：`);
  for (const bot of prepared) {
    console.log(`  • ${bot.entry.name}  (${bot.entry.appId})  [${bot.entry.tenant}]`);
  }
  console.log('私聊我 `/new <名>` 建项目；在项目群里 @我 干活。Ctrl+C 退出。\n');

  const runtime = await startBridgeRuntime(new CliRuntimeHost({ bots: prepared }));
  for (const ready of prepared) {
    void announceEventsWhenLive({
      cfg: ready.config,
      secret: ready.initialSecret,
    });
  }

  const startedAt = Date.now();
  const webConsole = await mountRuntimeWebConsole(runtime, startedAt);
  printWebConsole(webConsole);
  await waitForRuntimeStop(runtime, webConsole);
}

async function mountRuntimeWebConsole(
  runtime: RunningBridgeRuntime,
  startedAt: number,
): Promise<MountedWebConsole | undefined> {
  return await mountWebConsole(
    createAdminService({
      executeWrite: async (botId, operation) => {
        if (!runtime.status(botId)) {
          throw new AdminWriteError(`机器人「${botId}」不在当前活跃集中。`);
        }
        await runtime.executeAdmin(botId, operation);
      },
      liveStatus: async (botId) => runtime.status(botId),
      daemonStartedAt: startedAt,
      restartDaemon: () => spawnDaemonControl('restart'),
      applyUpdate: () => spawnDaemonControl('update'),
      stopDaemon: () => spawnDaemonControl('stop'),
      installBackend: installBackendDep,
      uninstallBackend: uninstallBackendDep,
    }),
  );
}

function printWebConsole(webConsole: MountedWebConsole | undefined): void {
  if (!webConsole) return;
  if (process.stdout.isTTY) {
    console.log(`🌐 Web 控制台：${webConsole.url}`);
    console.log('   仅本机可访问（127.0.0.1）；URL 含 token 勿外传。也可随时 `feishu-codex-bridge web` 重新打开。\n');
    return;
  }
  console.log(
    `🌐 Web 控制台已内嵌启动（127.0.0.1:${webConsole.port}）：` +
    '运行 `feishu-codex-bridge web` 获取登录链接。',
  );
}

async function waitForRuntimeStop(
  runtime: RunningBridgeRuntime,
  webConsole: MountedWebConsole | undefined,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      console.log(`\n收到 ${signal}，正在优雅退出（关闭所有 Agent 会话）…`);
      void (webConsole?.close() ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => runtime.stop())
        .catch((error) => log.fail('run', error, { phase: 'shutdown' }))
        .finally(resolve);
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => stop(signal));
    }
  });
}
