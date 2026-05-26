import { Command } from 'commander';
import { getServiceAdapter, type ServiceStatus } from '../../service/adapter';

export function registerServiceCommand(program: Command): void {
  const service = program.command('service').description('后台常驻服务（macOS launchd）');

  service
    .command('install <manager>')
    .description('安装后台服务（目前支持 launchd）')
    .action(async (manager: string) => {
      assertLaunchd(manager);
      const status = await getServiceAdapter().install();
      console.log('service 已安装并启动。');
      printStatus(status);
    });

  service
    .command('uninstall')
    .description('卸载后台服务并删除 launchd plist')
    .action(async () => {
      await getServiceAdapter().uninstall();
      console.log('service 已卸载。');
    });

  service
    .command('status')
    .description('查看后台服务状态')
    .action(async () => {
      const status = await getServiceAdapter().status();
      printStatus(status);
    });

  service
    .command('restart')
    .description('重启后台服务')
    .action(async () => {
      const status = await getServiceAdapter().restart();
      console.log('service 已重启。');
      printStatus(status);
    });

  service
    .command('logs')
    .description('查看后台服务日志')
    .option('-f, --follow', '持续跟随日志')
    .action(async (options: { follow?: boolean }) => {
      await getServiceAdapter().logs(Boolean(options.follow));
    });
}

function assertLaunchd(manager: string): void {
  if (manager !== 'launchd') {
    throw new Error(`暂不支持 service install ${manager}，目前仅支持 launchd。`);
  }
}

function printStatus(status: ServiceStatus): void {
  console.log(`plist: ${status.plistPath}`);
  console.log(`installed: ${status.installed ? 'yes' : 'no'}`);
  console.log(`loaded: ${status.loaded ? 'yes' : 'no'}`);
  console.log(`pid: ${status.pid ?? '-'}`);
  console.log(`last exit: ${status.lastExit ?? '-'}`);
  console.log(`stdout: ${status.stdoutPath}`);
  console.log(`stderr: ${status.stderrPath}`);

  if (!status.installed) {
    console.log('提示：service 尚未安装，运行 `feishu-codex-bridge service install launchd`。');
  } else if (!status.loaded) {
    console.log('提示：plist 已存在，但 launchd 当前未加载。');
  }
}
