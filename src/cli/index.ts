import { Command } from 'commander';
import { bridgeVersion } from '../core/version';
import { homedir } from 'node:os';
import { enterDataAccess, type DataLease } from '../config/data-access';
import { observeShutdown, type ShutdownControl } from '../host/lifecycle';

const program = new Command();

program
  .name('vonvon-bridge')
  .description('把飞书/Lark 桥接到本机 Codex（项目=群, 话题=会话）')
  .version(bridgeVersion());

let lease: DataLease | undefined;
let control: ShutdownControl | undefined;
program.hook('preAction', async (_command, action) => {
  const name = action.name();
  if (name === 'host' || name === 'run') control = observeShutdown(name === 'host');
  if (action.parent?.name() === 'data' || name === 'status' || name === 'desktop' || name === 'stop' || name === '__desktop-service') return;
  lease = await enterDataAccess(homedir());
});
program.hook('postAction', () => { lease?.release(); control?.dispose(); });

program.command('host', { hidden: true })
  .option('--parent-control', 'Owned Host controlled by parent stdin')
  .option('--bot <appId>', 'Run only this Agent without changing the default selection')
  .action(async (options: { parentControl?: boolean; bot?: string }) => {
    if (!options.parentControl) throw new Error('The Host entry requires --parent-control.');
    await (await import('../host/bootstrap')).runHostRuntime({ managed: true, control, bot: options.bot });
  });
program.command('__desktop-service <action>', { hidden: true }).action(async (action: string) => {
  console.log(JSON.stringify(await (await import('../host/service')).controlDesktopService(action)));
});
const data = program.command('data').description('Inspect or migrate local Bridge data while offline');
data.command('status').action(async () => {
  console.log(JSON.stringify(await (await import('../host/client')).inspectHost(homedir()), null, 2));
});
for (const name of ['migrate', 'retry']) data.command(name).action(async () => {
  const result = await (await import('../host/migration')).migrateHostDataOffline(homedir(), {
    nodePath: process.execPath, cliPath: process.argv[1] ?? '',
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === 'deferred' || result.kind === 'recovery-required') process.exitCode = 1;
});

// ── 进程 / 守护 ──────────────────────────────────────────────
program
  .command('run')
  .description('前台启动活跃机器人（多个则各自独立进程；没配置则先扫码 init；Ctrl+C 优雅退出）')
  .option('--bot <name>', '只启动指定的一个机器人（名字或 appId）')
  .action(async (options: { bot?: string }) => {
    await (await import('../host/bootstrap')).runHostRuntime({ bot: options.bot, managed: false, control });
  });

program
  .command('start')
  .description('后台 daemon 启动（装 launchd 开机自启；没配置则先扫码 init）')
  .action(async () => {
    await (await import('./commands/daemon')).runStart();
  });

program
  .command('stop')
  .description('停止后台 daemon 并关闭开机自启')
  .action(async () => {
    await (await import('../service/control')).stopInstallation(homedir());
  });

program
  .command('restart')
  .description('重启后台 daemon')
  .action(async () => {
    await (await import('./commands/daemon')).runRestart();
  });

program
  .command('status')
  .description('后台 daemon 状态（pid / 日志路径 / 上次退出码）')
  .action(async () => {
    const desktopRelease = await (await import('../service/desktop-release')).getDesktopRelease();
    console.log(JSON.stringify({
      installation: (await import('../service/control')).inspectInstallation(homedir()),
      host: await (await import('../host/client')).inspectHost(homedir()),
      ...(desktopRelease ? { desktopRelease } : {}),
    }, null, 2));
  });

program
  .command('desktop')
  .description('查看已发布的 Vonvon Bridge 桌面版安装包')
  .action(async () => {
    const { getDesktopRelease, desktopInstallerForHost } = await import('../service/desktop-release');
    const release = await getDesktopRelease();
    if (!release) {
      console.log('Vonvon Bridge 桌面版安装包尚未发布，或暂时无法查询。');
      return;
    }
    const installer = desktopInstallerForHost(release);
    console.log(`Vonvon Bridge 桌面版 v${release.version} 已提供。安装后可接续已有 Agent、飞书群和配置，无需重新配置；CLI 仍可单独使用。`);
    if (installer) console.log(`${installer.platform} 安装包：${installer.url}`);
    else for (const option of release.installers) console.log(`${option.platform} 安装包：${option.url}`);
  });

program
  .command('logs')
  .description('查看后台 daemon 日志')
  .option('-f, --follow', '持续跟随日志')
  .action(async (options: { follow?: boolean }) => {
    await (await import('./commands/daemon')).runLogs(Boolean(options.follow));
  });

program
  .command('update')
  .description('更新到最新版（npm i -g），并自动重启后台 daemon')
  .option('--check', '只检查有无新版，不安装')
  .action(async (options: { check?: boolean }) => {
    await (await import('./commands/update')).runUpdate({ check: Boolean(options.check) });
  });

program
  .command('web')
  .description('本机 Web 控制台（只读预览，仅 127.0.0.1 + token；写操作随 daemon 集成开放）')
  .option('--port <port>', '监听端口（默认 51847）')
  .action(async (options: { port?: string }) => {
    await (await import('./commands/web')).runWeb({ port: options.port !== undefined ? Number(options.port) : undefined });
  });

// 内部命令：Web 控制台「重启 / 升级」按钮 detached spawn 的 helper 入口。脱离
// daemon 进程执行 service.restart()（升级则先 npm i -g 再重启），不对外暴露。
program
  .command('__daemon-control <action>', { hidden: true })
  .action(async (action: string) => {
    await (await import('./commands/daemon-control')).runDaemonControl(action);
  });

// 内部命令（Windows 专用）：restartWinStartup 经 WMI/计划任务在「daemon 进程树之外」
// 拉起的 relauncher 入口。它 taskkill 旧 daemon → 等其真死 → startNow 起新，绝不会
// 像旧的进程内重启那样把自己一起杀掉。不对外暴露。
program
  .command('__win-relaunch [requestPath]', { hidden: true })
  .action(async (requestPath?: string) => {
    await (await import('../service/win-startup')).runWinRelaunch({ requestPath });
  });

// ── 飞书机器人管理 ───────────────────────────────────────────
const bot = program.command('bot').description('飞书机器人管理（多机器人）');
bot
  .command('init [name]')
  .description('扫码注册一个飞书机器人并授权（可选短名）')
  .action(async (name?: string) => {
    await (await import('./commands/bot')).runBotInit(name);
  });
bot
  .command('list')
  .description('列出已注册的飞书机器人')
  .action(async () => {
    await (await import('./commands/bot')).runBotList();
  });
bot
  .command('use [names...]')
  .description('勾选/指定要同时连接的机器人（多选）；无参数弹交互式勾选框')
  .action(async (names: string[]) => {
    await (await import('./commands/bot')).runBotUse(names ?? []);
  });
bot
  .command('rm <name>')
  .description('移除一个机器人配置')
  .action(async (name: string) => {
    await (await import('./commands/bot')).runBotRm(name);
  });

// ── 杂项 ─────────────────────────────────────────────────────
program
  .command('doctor')
  .description('本地自检：codex / 登录 / lark-cli / 当前机器人配置')
  .action(async () => {
    await (await import('./commands/doctor')).runDoctor();
  });

// Internal plumbing — the `secrets-getter` wrapper execs `secrets get` to
// resolve the App Secret from the keystore. Users never call it, so hide it
// from --help (still fully functional, just unlisted).
const secrets = program.command('secrets', { hidden: true }).description('本地加密密钥库（内部）');
secrets
  .command('get')
  .description('exec-provider 端点（从 stdin 读 JSON 请求）')
  .action(async () => {
    await (await import('./commands/secrets')).secretsGet();
  });
secrets
  .command('set <id>')
  .description('存储密钥（值从 stdin 读）')
  .action(async (id: string) => {
    await (await import('./commands/secrets')).secretsSet(id);
  });
secrets
  .command('list')
  .description('列出密钥 id')
  .action(async () => {
    await (await import('./commands/secrets')).secretsList();
  });
secrets
  .command('remove <id>')
  .description('删除密钥')
  .action(async (id: string) => {
    await (await import('./commands/secrets')).secretsRemove(id);
  });

program
  .command('hook', { hidden: true })
  .requiredOption('--agent <agent>', 'claude or codex')
  .option('--bot <nameOrAppId>', 'target bot name or appId')
  .action(async (options: { agent: string; bot?: string }) => {
    const { runHookCommand } = await import('../cli-bridge');
    await runHookCommand(options.agent, options.bot);
  });

program.parseAsync(process.argv).then(() => {
  if (control) process.exit(process.exitCode ?? 0);
}).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
