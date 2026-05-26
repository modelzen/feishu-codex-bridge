import { Command } from 'commander';
import { runDoctor } from './commands/doctor';
import { runStart } from './commands/start';
import { secretsGet, secretsSet, secretsList, secretsRemove } from './commands/secrets';
import { registerServiceCommand } from './commands/service';

const program = new Command();

program
  .name('feishu-codex-bridge')
  .description('把飞书/Lark 桥接到本机 Codex（项目=群, 话题=会话）')
  .version('0.0.1');

program
  .command('start')
  .description('扫码 onboarding + 启动 bot（前台）')
  .action(async () => {
    await runStart();
  });

program
  .command('doctor')
  .description('本地自检：codex / 登录 / lark-cli / 配置')
  .action(async () => {
    await runDoctor();
  });

const secrets = program.command('secrets').description('本地加密密钥库');
secrets
  .command('get')
  .description('exec-provider 端点（从 stdin 读 JSON 请求）')
  .action(async () => {
    await secretsGet();
  });
secrets
  .command('set <id>')
  .description('存储密钥（值从 stdin 读）')
  .action(async (id: string) => {
    await secretsSet(id);
  });
secrets
  .command('list')
  .description('列出密钥 id')
  .action(async () => {
    await secretsList();
  });
secrets
  .command('remove <id>')
  .description('删除密钥')
  .action(async (id: string) => {
    await secretsRemove(id);
  });

registerServiceCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
