import { homedir } from 'node:os';
import { join } from 'node:path';

const appDir = join(homedir(), '.feishu-codex-bridge');
const larkCliDir = join(appDir, 'lark-cli');
const codexCliDir = join(appDir, 'codex-cli');

export const paths = {
  appDir,
  cacheDir: appDir,
  configFile: join(appDir, 'config.json'),
  /** thread(话题) → codex thread_id + cwd + 会话级配置 */
  sessionsFile: join(appDir, 'sessions.json'),
  /** project(群) → cwd + 默认参数 注册表 */
  projectsFile: join(appDir, 'projects.json'),
  /** 在跑的 start 进程注册中心（同 App 冲突检测） */
  processesFile: join(appDir, 'processes.json'),
  secretsFile: join(appDir, 'secrets.enc'),
  keystoreSaltFile: join(appDir, '.keystore.salt'),
  npmCacheDir: join(appDir, 'npm-cache'),
  /** 空白项目默认落地目录 */
  projectsRootDir: join(appDir, 'projects'),
  larkCliDir,
  larkCliBinDir: join(larkCliDir, 'node_modules', '.bin'),
  codexCliDir,
  codexCliBinDir: join(codexCliDir, 'node_modules', '.bin'),
  /**
   * Thin shell wrapper that lark-cli invokes to resolve secrets from the
   * bridge's encrypted store. Written user-owned and non-symlinked so it
   * passes lark-cli's AssertSecurePath audit.
   */
  secretsGetterScript: join(appDir, 'secrets-getter'),
  mediaDir: join(appDir, 'media'),
};
