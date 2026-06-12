import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const appDir = join(homedir(), '.feishu-codex-bridge');
const larkCliDir = join(appDir, 'lark-cli');
const codexCliDir = join(appDir, 'codex-cli');

/**
 * Per-bot state directory. Each saved bot keeps its own config / projects /
 * sessions / single-instance lock under `~/.feishu-codex-bridge/bots/<appId>/`
 * so switching the active bot (`use`) never mixes one bot's groups with
 * another's. `currentBotDir` defaults to `appDir` (the legacy flat layout) so
 * code that runs before a bot is selected — and pre-migration installs — keeps
 * reading the old top-level files; `useBotDir()` repoints it once the active
 * bot is known.
 */
let currentBotDir = appDir;

export function botDir(appId: string): string {
  return join(appDir, 'bots', appId);
}

/** Point the per-bot paths at `appId`'s directory. Call once at startup.
 * ⚠️ daemon 进程内（run/supervisor）绝不可在请求路径上反复调它切目录——它是
 * 模块级全局态，会把在跑 bot 进程的 paths 指到别的 bot。跨 bot 聚合读取一律
 * 走 {@link botPaths} 的显式路径。 */
export function useBotDir(appId: string): void {
  currentBotDir = botDir(appId);
}

/** 指定 bot 的各状态文件路径（纯函数，不碰全局 currentBotDir）。Web 控制台 /
 * supervisor 聚合多 bot 读取专用——与 useBotDir 后的 paths.* 指向完全一致。 */
export function botPaths(appId: string): {
  dir: string;
  configFile: string;
  sessionsFile: string;
  projectsFile: string;
  processesFile: string;
} {
  const dir = botDir(appId);
  return {
    dir,
    configFile: join(dir, 'config.json'),
    sessionsFile: join(dir, 'sessions.json'),
    projectsFile: join(dir, 'projects.json'),
    processesFile: join(dir, 'processes.json'),
  };
}

export const paths = {
  appDir,
  cacheDir: appDir,
  /** bot 注册表：保存的全部 bot + 当前选中的 appId */
  botsFile: join(appDir, 'bots.json'),
  /** app id / 租户 / 偏好（当前 bot；不含明文密钥） */
  get configFile(): string {
    return join(currentBotDir, 'config.json');
  },
  /** thread(话题) → codex thread_id + cwd + 会话级配置（当前 bot） */
  get sessionsFile(): string {
    return join(currentBotDir, 'sessions.json');
  },
  /** project(群) → cwd + 默认参数 注册表（当前 bot） */
  get projectsFile(): string {
    return join(currentBotDir, 'projects.json');
  },
  /** 在跑的 start 进程注册中心（同 App 冲突检测；当前 bot） */
  get processesFile(): string {
    return join(currentBotDir, 'processes.json');
  },
  /**
   * Local CLI hook IPC endpoint for the current bot. macOS/Linux use a Unix
   * domain socket file; Windows has none, so Node maps a `\\.\pipe\…` path to a
   * named pipe. The pipe name is hashed from the per-bot dir so the daemon and
   * the hook subprocess (both pointed at the same bot) derive the same name,
   * while distinct bots/users on one machine can't collide in the global pipe
   * namespace.
   */
  get cliBridgeSocket(): string {
    if (process.platform === 'win32') {
      const tag = createHash('sha1').update(currentBotDir).digest('hex').slice(0, 16);
      return `\\\\.\\pipe\\feishu-cli-bridge-${tag}`;
    }
    return join(currentBotDir, 'cli-bridge.sock');
  },
  secretsFile: join(appDir, 'secrets.enc'),
  keystoreSaltFile: join(appDir, '.keystore.salt'),
  npmCacheDir: join(appDir, 'npm-cache'),
  /**
   * 按需后端（npm-ondemand 包）私装目录：一个扁平
   * `~/.feishu-codex-bridge/backends/node_modules` 放所有按需后端的 npm 包。
   * （通用基础设施；当前内置后端 codex 是 external-cli，不落此目录，保留以备将来。）
   * 永远在用户 HOME 下、用户可写（零 sudo/brew），与全局包目录的权限死结解耦。
   * 解析靠 createRequire(backendsDir/...).resolve（见 agent/backend-loader）；
   * 安装靠 `npm install --prefix backendsDir`（见 agent/installer）。 */
  backendsDir: join(appDir, 'backends'),
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
  /** Inbound file attachments downloaded from chat, handed to codex by absolute
   * path (codex has no native file input). TTL-pruned like {@link mediaDir}. */
  inboundDir: join(appDir, 'inbound'),
  /** daemon 内嵌 Web 控制台的发现文件 {port, token, pid}（0600，daemon 退出
   * 清理）——`web` 子命令据此直接打开 daemon 控制台而不是再起只读副本。 */
  webConsoleFile: join(appDir, 'web-console.json'),
  /** 稳定的 Web 控制台 token（0600，**不随进程退出清理**）——让重启 / 预览→daemon
   * 切换后浏览器里那条带 token 的 URL 始终有效，不再 401。删此文件即轮换 token。 */
  webTokenFile: join(appDir, 'web-token'),
};
