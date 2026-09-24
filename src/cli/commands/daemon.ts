import { ensureOnboarded } from '../../bot/onboarding';
import { activeBots, loadBots } from '../../config/bots';
import { getServiceAdapter, type ServiceStatus } from '../../service/adapter';
import { readWebConsole, type WebConsoleRecord } from '../../web/discovery';

/**
 * Daemon lifecycle. `start` installs ONE launchd/systemd/login service whose
 * body runs `run` (so the background process is the same bridge the user runs
 * in the foreground). When multiple bots are active, that single `run` becomes
 * the multi-process supervisor, so the service layer stays bot-agnostic — no
 * per-bot service definitions to install.
 *
 * Onboarding happens here in the foreground first — this terminal has a TTY for
 * the scan — so the detached service never enters the wizard. With a multi-bot
 * active set we check each bot sequentially so its diagnostic output stays together.
 */
export async function runStart(): Promise<void> {
  const active = activeBots(await loadBots());

  if (active.length === 0) {
    // 零 bot + 非交互（典型：codex/claude 帮用户跑 `start`，没 TTY 没法终端扫码）→ 不在
    // 前台扫码，直接装服务。服务体跑 `run`，零 bot 会进「引导控制台」（见 runRun），用户
    // 在浏览器里扫码创建第一个机器人，建完重启即上线。这是「一句话安装」的关键：一条命令
    // 起好后台 + Web，把「创建机器人」整体搬进浏览器。
    if (!process.stdout.isTTY) {
      const status = await getServiceAdapter().install();
      console.log('✓ 后台服务已安装并启动（还没有机器人 → 已进入「引导控制台」模式）。');
      console.log('  下一步：运行 `feishu-codex-bridge web` 获取控制台登录链接，在浏览器里扫码创建第一个机器人。');
      console.log('  （建完机器人后它会自动成为活跃 bot，重启服务即上线。）');
      printStatus(status);
      return;
    }
    // Fresh / legacy single-bot install (TTY)：onboard (maybe scan-create) the
    // implicit current/default bot.
    const ready = await ensureOnboarded({ allowCreate: true });
    if (!ready) {
      process.exitCode = 1;
      return;
    }
  } else {
    if (active.length > 1) {
      console.log(`\n后台服务将托管 ${active.length} 个机器人（supervisor 多进程，各自独立进程）：`);
      for (const b of active) console.log(`  • ${b.name}  (${b.appId})  [${b.tenant}]`);
      console.log('');
    }
    for (const bot of active) {
      if (active.length > 1) console.log(`\n──── 机器人「${bot.name}」(${bot.appId}) ────`);
      const ready = await ensureOnboarded({ bot: bot.appId });
      if (!ready) {
        process.exitCode = 1;
        return;
      }
    }
  }

  const status = await getServiceAdapter().install();
  console.log(installedNote());
  printStatus(status);
}

export async function runStop(): Promise<void> {
  await getServiceAdapter().uninstall();
  console.log('✓ 后台服务已停止，并已关闭自启（已移除服务定义）。');
}

export async function runRestart(): Promise<void> {
  const status = await getServiceAdapter().restart();
  console.log('✓ 后台服务已重启。');
  printStatus(status);
}

export async function runStatus(): Promise<void> {
  const status = await getServiceAdapter().status();
  // service manager（launchd/systemd）只认它自己托管的服务。手动 `run`/前台/nohup
  // 起的 daemon 它看不见 → 会误报「没在运行」。daemon 内嵌 Web 控制台时写的发现
  // 文件（带 pid 活性校验）是 daemon 级的「确有进程在跑」信号，补进来消除误导。
  const live = readWebConsole();
  printStatus(status, live);
}

export async function runLogs(follow: boolean): Promise<void> {
  await getServiceAdapter().logs(follow);
}

function installedNote(): string {
  switch (process.platform) {
    case 'win32':
      return (
        '✓ 后台服务已安装并启动（登录自启，免管理员）。' +
        '\n  提示：登录自启在下次登录生效；当前已在后台隐藏启动。注意 Windows 登录自启无崩溃自动拉起。'
      );
    case 'linux':
      return (
        '✓ 后台服务已安装并启动（登录自启、崩溃自动拉起）。' +
        '\n  提示：注销后仍保持运行需执行一次 `loginctl enable-linger $USER`。'
      );
    default:
      return '✓ 后台服务已安装并启动（开机自启、崩溃自动拉起）。';
  }
}

function printStatus(status: ServiceStatus, live?: WebConsoleRecord): void {
  // service manager 没报 running，但发现文件有活 daemon → 手动/前台运行中。
  const selfHosted = !status.running && live !== undefined;
  console.log(`service:   ${status.platformName}`);
  console.log(`path:      ${status.servicePath}`);
  console.log(`installed: ${status.installed ? 'yes' : 'no'}`);
  console.log(`running:   ${status.running ? 'yes' : selfHosted ? 'yes（手动/前台运行，非服务托管）' : 'no'}`);
  console.log(`pid:       ${status.pid ?? live?.pid ?? '-'}`);
  console.log(`last exit: ${status.lastExit ?? '-'}`);
  console.log(`stdout:    ${status.stdoutPath}`);
  console.log(`stderr:    ${status.stderrPath}`);

  if (selfHosted) {
    console.log(
      `\ndaemon 正在运行（PID ${live.pid}，Web 控制台 http://127.0.0.1:${live.port}），` +
        '但不是开机自启服务。\n' +
        '提示：想关机/登出后自动拉起，运行 `feishu-codex-bridge start` 注册为后台服务。',
    );
  } else if (!status.installed) {
    console.log('提示：后台服务尚未安装，运行 `feishu-codex-bridge start`。');
  } else if (!status.running) {
    console.log('提示：服务已注册但当前未运行（试试 `restart`）。');
  }
}
