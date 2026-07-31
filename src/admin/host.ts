import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { arch, platform, release } from 'node:os';
import { paths } from '../config/paths';
import { bridgeVersion } from '../core/version';
import {
  visibleCatalog,
  createBackend,
  effectiveDefaultBackend,
  isInstallable,
  isBackendEntryInstalled,
  type BackendCatalogEntry,
} from '../agent';
import type { BackendDepState } from '../agent/types';
import {
  resolveCliBinPath as resolveCompatibilityCliBinPath,
  type ServiceStatus,
} from '../service/common';
import type { UpdateCheck } from '../service/update';

/**
 * 宿主机 / daemon 维度的只读聚合 + detached helper 命令构建（Web 专属：飞书 DM
 * 卡片够不着这一层——初始化机器人 / daemon 生命周期 / 多 bot 管理 / 体检都是
 * 「全局控制台」的活）。
 *
 * 【为什么 restart / update 走 detached helper 而非进程内直执行】
 *   Web 控制台**内嵌在 daemon 进程里**（run / supervisor）。restart 要 service
 *   stop→start：在 daemon 自己进程里跑 stop 会把自己（含正在响应这条 HTTP 的
 *   事件循环）杀掉，start 永远执行不到 → 服务被卸载、无人复活。所以 restart /
 *   update 一律 detached spawn 一个**脱离本进程**的小 helper（`__daemon-control`
 *   子命令），由它在 daemon 死后继续把 service 拉起来。命令构建是纯函数
 *   {@link buildDaemonControlCommand}，单测只验证「生成的命令正确」，绝不真跑。
 *
 * 【安全/约束】只读聚合绝不抛错（各段独立降级）；体检不 spawn 危险命令；
 *   helper 走 cross-spawn（platform/spawn）detached + unref，绝不在 web 进程里
 *   同步等它（那会把重启阻塞在被杀的进程上）。
 */

/** daemon 生命周期快照（GET /api/daemon）。service 注册状态 + 运行 pid/版本/时长。 */
export interface DaemonStatus {
  /** 本平台的服务管理器名（launchd / Task Scheduler / systemd），未支持平台为 undefined。 */
  platformName?: string;
  /** 服务定义（plist/task/unit）已注册到 OS。 */
  installed: boolean;
  /** daemon 进程当前存活：service manager 报 running，**或**当前内嵌 web 的进程自身就是活 daemon。 */
  running: boolean;
  /** daemon 在跑但不由 service manager 托管（手动前台 / nohup 起的）——UI 提示「未注册为开机自启」。 */
  selfHosted: boolean;
  /** 服务进程 pid（service manager 报的；可能与内嵌 web 的 process.pid 不同）。 */
  pid?: number;
  /** 上次退出码（诊断用）。 */
  lastExit?: string;
  /** 当前运行的 bridge 版本（package.json）。 */
  version: string;
  /** 本进程（内嵌 web 的 daemon 进程）已运行毫秒数；只读预览进程为 undefined。 */
  uptimeMs?: number;
  /** 服务定义路径 / stdout / stderr 路径（诊断用）。 */
  servicePath?: string;
  /** 本平台是否支持后台服务（不支持时 restart 按钮置灰，引导前台 run）。 */
  supported: boolean;
}

/** 宿主机体检（GET /api/host-doctor）：后端环境 + Node/平台/路径/日志体量。 */
export interface HostDoctor {
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
  /** 配置目录绝对路径（~/.feishu-codex-bridge）。 */
  appDir: string;
  /** 日志目录绝对路径。 */
  logsDir: string;
  /** 磁盘上日志总字节数（logs/ 目录递归累加；读不到为 0）。 */
  logBytes: number;
  /** 当前 bridge 版本。 */
  version: string;
}

/**
 * 把 {@link ServiceStatus}（service 适配器的平台无关快照）+ 本进程运行时长归一成
 * {@link DaemonStatus}。纯函数（exported for tests）——不碰 service manager，输入
 * 是已探好的 status，便于单测 mock。`status` 为 undefined ⇒ 本平台不支持后台服务。
 */
export function toDaemonStatus(opts: {
  status?: ServiceStatus;
  version: string;
  /** daemon 进程启动时刻（内嵌 web 注入）；只读预览不传 → uptime undefined。 */
  startedAt?: number;
  now?: number;
}): DaemonStatus {
  const s = opts.status;
  // startedAt 仅在 daemon 进程内嵌 web 时注入：它存在即证明「当前有 daemon 进程在响应」，
  // 哪怕该进程是手动 nohup/前台起的（service manager 视角 running=false）。
  const selfRunning = opts.startedAt !== undefined;
  const serviceRunning = s?.running ?? false;
  return {
    platformName: s?.platformName,
    installed: s?.installed ?? false,
    running: serviceRunning || selfRunning,
    selfHosted: selfRunning && !serviceRunning,
    pid: s?.pid ? Number(s.pid) : undefined,
    lastExit: s?.lastExit,
    version: opts.version,
    uptimeMs: opts.startedAt !== undefined ? Math.max(0, (opts.now ?? Date.now()) - opts.startedAt) : undefined,
    servicePath: s?.servicePath,
    supported: s !== undefined,
  };
}

/** 递归累加目录字节数（读不到的项跳过，绝不抛错）。 */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (st.isDirectory()) total += await dirBytes(full);
      else if (st.isFile()) total += st.size;
    } catch {
      /* 单项读不到（权限/竞态）→ 跳过 */
    }
  }
  return total;
}

/** 宿主机体检聚合（绝不抛错）。后端探测由调用方（service 层复用 doctorBackends）
 * 单独并发；这里只管 Node/平台/路径/日志体量这部分宿主机域。 */
export async function collectHostDoctor(
  logsDir: string = join(paths.hostDataDir ?? paths.appDir, 'logs'),
): Promise<HostDoctor> {
  return {
    node: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    appDir: paths.appDir,
    logsDir,
    logBytes: await dirBytes(logsDir),
    version: bridgeVersion(),
  };
}

/**
 * 一条后端体检行（Web 后端页 / 宿主机体检共用）：catalog 元数据 + doctor 三态 +
 * 依赖安装态。从 catalog 渲染（不硬编码列表）；新后端注册到 catalog 即自动出现。
 */
export interface BackendDoctorRow {
  id: string;
  /** catalog displayName */
  name: string;
  /** agent 家族（picker 分组用） */
  agentFamily: string;
  /** 接入方式短名（app-server / sdk / acp） */
  access: string;
  ok: boolean;
  version: string | null;
  location?: string;
  hint?: string;
  /** 依赖安装态三态（installed / not-installed / external-missing） */
  depState: BackendDepState;
  /** 可一键按需下载（npm-ondemand 且当前未装） */
  installable: boolean;
  /** 体积提示 MB（installable 时给下载确认用） */
  approxSizeMB?: number;
  /** 手动装法 / 下载旁注 */
  installCmd?: string;
  /** 全局有效默认后端 */
  isDefault: boolean;
}

/**
 * 一条 catalog 的依赖安装态（doctor.ok 不直接等于装了——已装未登录也 ok:false，所以
 * 安装态单独由 catalog dep + 解析判定）：
 *   npm-ondemand —— 解析得到包 = installed，否则 not-installed（可一键下载）。
 *   external-cli / npm-external —— 不在此探解析（走 PATH / 握手），按 probe.ok：
 *     ok = installed，否则 external-missing（手动装）。
 */
function depStateFor(entry: BackendCatalogEntry, ok: boolean): BackendDepState {
  if (entry.dep.kind === 'npm-ondemand') {
    // bin 类（claude-pty-acp）查 .bin、库类（SDK）查 require.resolve——统一走 isBackendEntryInstalled。
    return isBackendEntryInstalled(entry) ? 'installed' : 'not-installed';
  }
  return ok ? 'installed' : 'external-missing';
}

/**
 * 后端体检聚合（从 catalog 渲染 + 每条带 depState/installable）。绝不抛错——
 * 每条 doctor 独立降级（force 探「现在」的状态）。service.ts 的 doctorBackends /
 * probeAllBackends 复用它（host.ts 是宿主机域聚合的单一出口）。
 */
export async function doctorBackends(): Promise<BackendDoctorRow[]> {
  const def = await effectiveDefaultBackend({ force: true }).catch(() => undefined);
  return Promise.all(
    visibleCatalog().map(async (entry) => {
      const probe = await createBackend(entry.id)
        .doctor({ force: true })
        .catch(() => undefined);
      const ok = probe?.ok === true;
      const installable = isInstallable(entry) && !ok;
      const depState = depStateFor(entry, ok);
      return {
        id: entry.id,
        name: entry.displayName,
        agentFamily: entry.agentFamily,
        access: entry.access,
        ok,
        version: probe?.version ?? null,
        location: probe?.location,
        hint: ok ? undefined : (probe?.hint ?? entry.dep.detectHint),
        depState,
        installable,
        approxSizeMB: entry.dep.approxSizeMB,
        installCmd: entry.dep.installCmd,
        isDefault: entry.id === def,
      };
    }),
  );
}

/**
 * 绝对路径到本包的 bin 入口（与 service/common.resolveCliBinPath 同算法）。打包后
 * 本模块在 dist/，bin 在 ../bin/feishu-codex-bridge.mjs——全局安装与本地 checkout
 * 同布局。detached helper 必须用绝对路径起（脱离本进程后 cwd / PATH 不可依赖）。
 */
export function resolveCliBinPath(): string {
  return resolveCompatibilityCliBinPath();
}

export type DaemonControlAction = 'restart' | 'update' | 'start' | 'stop';

/**
 * 构建 detached helper 的 spawn 命令（纯函数，exported for tests）：用当前 Node
 * 执行 bin 入口的内部子命令 `__daemon-control <action>`。该 helper 进程
 * detached + unref，与 web 进程脱钩——即便本 daemon 随后被 service stop 杀掉，
 * helper 仍会把 service 重新拉起（restart），或先 npm i -g 再重启（update）。
 *
 * 不直接 spawn `npm` / `launchctl`：把全部逻辑收进 helper 子命令，命令面最小
 * （只一个固定 action 形参），无任意字符串拼进 shell，天然无注入面。
 */
export function buildDaemonControlCommand(
  action: DaemonControlAction,
  binPath: string = resolveCliBinPath(),
  nodePath: string = process.execPath,
): { command: string; args: string[] } {
  return { command: nodePath, args: [binPath, '__daemon-control', action] };
}

export type { UpdateCheck };
