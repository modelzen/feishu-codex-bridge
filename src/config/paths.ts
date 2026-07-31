import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';

const defaultRootDir = join(homedir(), '.feishu-codex-bridge');
let appDir = defaultRootDir;
let hostDataDir = defaultRootDir;
let legacyAssetsDir = defaultRootDir;
let writableAssetsDir = defaultRootDir;
let managedToolsDir: string | undefined;
let systemNodeModulesDirs: string[] = [];
let explicitBotDataDir: string | undefined;
let explicitBotAppId: string | undefined;

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
let currentWritableBotDir = writableAssetsDir;

export interface PathRoots {
  /** Vonvon-owned native directory for this one bot process. */
  dataDir: string;
  /**
   * Optional shared desktop-host directory. Bot state remains bound to
   * `dataDir`; host discovery artifacts and aggregated logs live here so
   * isolated bot children can discover the parent Web console and keep the
   * original all-bot log view complete.
   */
  hostDataDir?: string;
  /** Existing feishu-codex-bridge user assets that must keep their old location. */
  legacyAssetsDir: string;
  /**
   * Desktop-owned writable compatibility assets. Standalone upstream callers
   * may omit this to retain the original single-root layout.
   */
  writableAssetsDir?: string;
  /** Optional Vonvon-owned npm prefix for managed Codex / Claude tooling. */
  managedToolsDir?: string;
  /** Existing user-controlled npm roots selected by desktop environment checks. */
  systemNodeModulesDirs?: readonly string[];
}

/**
 * Bind the vendored kernel to explicit roots without mutating HOME. This is a
 * process-level setting, matching the upstream module-level `useBotDir` model:
 * configure the roots once, then select exactly one bot in this process.
 */
export function configurePathRoots(roots: PathRoots): void {
  appDir = absoluteRoot('dataDir', roots.dataDir);
  hostDataDir = roots.hostDataDir === undefined
    ? appDir
    : absoluteRoot('hostDataDir', roots.hostDataDir);
  legacyAssetsDir = absoluteRoot('legacyAssetsDir', roots.legacyAssetsDir);
  writableAssetsDir = roots.writableAssetsDir === undefined
    ? legacyAssetsDir
    : absoluteOptionalRoot('writableAssetsDir', roots.writableAssetsDir);
  managedToolsDir = roots.managedToolsDir === undefined
    ? undefined
    : absoluteOptionalRoot('managedToolsDir', roots.managedToolsDir);
  systemNodeModulesDirs = roots.systemNodeModulesDirs?.map((root) => (
    absoluteRoot('systemNodeModulesDirs', root)
  )) ?? [];
  explicitBotDataDir = appDir;
  explicitBotAppId = undefined;
  currentBotDir = appDir;
  currentWritableBotDir = writableAssetsDir;
  refreshBasePaths();
}

export function botDir(appId: string): string {
  if (explicitBotDataDir && explicitBotAppId === appId) return explicitBotDataDir;
  return join(appDir, 'bots', appId);
}

/** Point the per-bot paths at `appId`'s directory. Call once at startup.
 * ⚠️ daemon 进程内（run/supervisor）绝不可在请求路径上反复调它切目录——它是
 * 模块级全局态，会把在跑 bot 进程的 paths 指到别的 bot。跨 bot 聚合读取一律
 * 走 {@link botPaths} 的显式路径。 */
export function useBotDir(appId: string): void {
  if (explicitBotDataDir) {
    if (explicitBotAppId && explicitBotAppId !== appId) {
      throw new Error(
        `this process is already bound to bot ${explicitBotAppId}; cannot select ${appId}`,
      );
    }
    explicitBotAppId = appId;
    currentBotDir = explicitBotDataDir;
  } else {
    currentBotDir = botDir(appId);
  }
  currentWritableBotDir = join(writableAssetsDir, 'bots', appId);
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
  hostDataDir,
  legacyAssetsDir,
  writableAssetsDir,
  cacheDir: writableAssetsDir,
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
  /** 云文档评论 @bot 的可编辑提示词 master 文件（当前 bot）。用户直接编辑这一份，
   * 桥在每条评论运行前把它同步进该文档的评论工作目录（AGENTS.md / CLAUDE.md）。
   * 首次缺失时由 bot/comments.ts 用内置默认模板自动落地。 */
  get commentInstructionsFile(): string {
    return join(currentBotDir, 'comment-instructions.md');
  },
  /** 评论工作目录根（**当前 bot**）：每个被评论文档一个 `comment-<type>-<token>` 子目录，
   * 放同步进去的 AGENTS.md / CLAUDE.md。放 per-bot 目录下，与其它 bot 隔离——否则
   * 编辑提示词时的「全量同步」会越界改到别的 bot 的评论目录。 */
  get commentsRootDir(): string {
    return join(currentBotDir, 'comments');
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
      const tag = createHash('sha1').update(currentWritableBotDir).digest('hex').slice(0, 16);
      return `\\\\.\\pipe\\feishu-cli-bridge-${tag}`;
    }
    return join(currentWritableBotDir, 'cli-bridge.sock');
  },
  secretsFile: join(appDir, 'secrets.enc'),
  keystoreSaltFile: join(appDir, '.keystore.salt'),
  npmCacheDir: join(writableAssetsDir, 'npm-cache'),
  /**
   * 按需后端（npm-ondemand 包）私装目录：一个扁平
   * `~/.feishu-codex-bridge/backends/node_modules` 放所有按需后端的 npm 包。
   * （通用基础设施；当前内置后端 codex 是 external-cli，不落此目录，保留以备将来。）
   * 永远在用户 HOME 下、用户可写（零 sudo/brew），与全局包目录的权限死结解耦。
   * 解析靠 createRequire(backendsDir/...).resolve（见 agent/backend-loader）；
   * 安装靠 `npm install --prefix backendsDir`（见 agent/installer）。 */
  backendsDir: join(writableAssetsDir, 'backends'),
  /** Original CLI packages remain a read-only compatibility fallback. */
  legacyBackendsDir: join(legacyAssetsDir, 'backends'),
  /** Vonvon-managed npm prefix; resolution checks this before legacy installs. */
  managedToolsDir,
  managedBackendsDir: managedToolsDir,
  /** User-controlled global npm roots explicitly selected by the desktop host. */
  systemNodeModulesDirs,
  managedCodexBin: managedToolsDir
    ? join(managedToolsDir, 'node_modules', '.bin', 'codex')
    : undefined,
  /** 空白项目默认落地目录 */
  projectsRootDir: join(writableAssetsDir, 'projects'),
  larkCliDir: join(legacyAssetsDir, 'lark-cli'),
  larkCliBinDir: join(legacyAssetsDir, 'lark-cli', 'node_modules', '.bin'),
  codexCliDir: join(legacyAssetsDir, 'codex-cli'),
  codexCliBinDir: join(legacyAssetsDir, 'codex-cli', 'node_modules', '.bin'),
  /**
   * Thin shell wrapper that lark-cli invokes to resolve secrets from the
   * bridge's encrypted store. Written user-owned and non-symlinked so it
   * passes lark-cli's AssertSecurePath audit.
   */
  secretsGetterScript: join(writableAssetsDir, 'secrets-getter'),
  mediaDir: join(writableAssetsDir, 'media'),
  /** Inbound file attachments downloaded from chat, handed to codex by absolute
   * path (codex has no native file input). TTL-pruned like {@link mediaDir}. */
  inboundDir: join(writableAssetsDir, 'inbound'),
  /** daemon 内嵌 Web 控制台的发现文件 {port, token, pid}（0600，daemon 退出
   * 清理）——`web` 子命令据此直接打开 daemon 控制台而不是再起只读副本。 */
  webConsoleFile: join(hostDataDir, 'web-console.json'),
  /** 稳定的 Web 控制台 token（0600，**不随进程退出清理**）——让重启 / 预览→daemon
   * 切换后浏览器里那条带 token 的 URL 始终有效，不再 401。删此文件即轮换 token。 */
  webTokenFile: join(hostDataDir, 'web-token'),
};

function absoluteRoot(name: keyof PathRoots, value: string): string {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be a non-empty absolute path`);
  }
  return normalize(value);
}

function absoluteOptionalRoot(name: keyof PathRoots, value: string): string {
  return absoluteRoot(name, value);
}

function refreshBasePaths(): void {
  paths.appDir = appDir;
  paths.hostDataDir = hostDataDir;
  paths.legacyAssetsDir = legacyAssetsDir;
  paths.writableAssetsDir = writableAssetsDir;
  paths.cacheDir = writableAssetsDir;
  paths.botsFile = join(appDir, 'bots.json');
  paths.secretsFile = join(appDir, 'secrets.enc');
  paths.keystoreSaltFile = join(appDir, '.keystore.salt');
  paths.npmCacheDir = join(writableAssetsDir, 'npm-cache');
  paths.backendsDir = join(writableAssetsDir, 'backends');
  paths.legacyBackendsDir = join(legacyAssetsDir, 'backends');
  paths.managedToolsDir = managedToolsDir;
  paths.managedBackendsDir = managedToolsDir;
  paths.systemNodeModulesDirs = systemNodeModulesDirs;
  paths.managedCodexBin = managedToolsDir
    ? join(managedToolsDir, 'node_modules', '.bin', 'codex')
    : undefined;
  paths.projectsRootDir = join(writableAssetsDir, 'projects');
  paths.larkCliDir = join(legacyAssetsDir, 'lark-cli');
  paths.larkCliBinDir = join(paths.larkCliDir, 'node_modules', '.bin');
  paths.codexCliDir = join(legacyAssetsDir, 'codex-cli');
  paths.codexCliBinDir = join(paths.codexCliDir, 'node_modules', '.bin');
  paths.secretsGetterScript = join(writableAssetsDir, 'secrets-getter');
  paths.mediaDir = join(writableAssetsDir, 'media');
  paths.inboundDir = join(writableAssetsDir, 'inbound');
  paths.webConsoleFile = join(hostDataDir, 'web-console.json');
  paths.webTokenFile = join(hostDataDir, 'web-token');
}
