import { readFile, rm } from 'node:fs/promises';
import { loadBots, setActiveBots, removeBot } from '../config/bots';
import { botPaths, botDir } from '../config/paths';
import { removeSecret } from '../config/keystore';
import {
  getCompletionReminderConfig,
  isComplete,
  secretKeyForApp,
  type AppConfig,
  type CompletionReminderMode,
  type ResolvedCompletionReminderConfig,
} from '../config/schema';
import {
  defaultNoMention,
  effectiveGuestMode,
  effectiveMode,
  listProjectsIn,
} from '../project/registry';
import { listSessionsIn } from '../bot/session-store';
import { loadConfig } from '../config/store';
import { resolveAppSecret } from '../config/secret-resolver';
import { diagnoseEventSubscription, type EventDiagnosis } from '../utils/event-diagnosis';
import { validateAppCredentials } from '../utils/feishu-auth';
import { buildScopeGrantUrl, buildEventConfigUrl } from '../config/scopes';
import { registerBotFromCredentials } from '../bot/register-bot';
import {
  startRegistration,
  registrationErrorCode,
  registrationErrorMessage,
  type RegistrationQr,
  type RegistrationStatus,
} from '../bot/wizard';
import {
  backendIds,
  createBackend,
  DEFAULT_BACKEND_ID,
  visibleCatalog,
  catalogById,
  isInstallable,
  effectiveDefaultBackend,
  installBackendDep,
  isBackendInstalledInUserDir,
  installedBackendVersion,
  latestNpmVersion,
  type BackendCatalogEntry,
  type InstallResult,
  type InstallProgress,
} from '../agent';
import type { BackendDepState, BackendProbe, PermissionMode } from '../agent/types';
import { readRecentLogs } from '../core/logger';
import { getServiceAdapter } from '../service/adapter';
import {
  checkUpdate as checkUpdateImpl,
  clearUpdateStatus,
  readUpdateStatus,
  type UpdateCheck,
  type UpdateStatus,
} from '../service/update';
import { bridgeVersion } from '../core/version';
import { collectHostDoctor, toDaemonStatus, type DaemonStatus, type HostDoctor } from './host';
import type { AdminWriteOp } from './ops';

/**
 * 管理面共享服务层（设计：.plans/auto-optimize/design/admin-surface.md）。
 *
 * 【契约】DM 卡片回调与 Web API **共享同一写逻辑**：
 *   - 体验对齐原则「Web 能操作的飞书也能操作」——本接口的方法清单严格对齐
 *     DM 私聊控制台已有的 dm.* 动作（src/card/dm-cards.ts）：
 *       listBots            ← CLI `bot list` / 多 bot 聚合视图
 *       listProjects        ← dm.projects（📁 项目列表）
 *       getProject          ← dm.projectSettings（⚙️ 项目设置）
 *       switchBackend       ← dm.proj.backend.submit（🧠 后端 · 切换）
 *       setPermissionMode   ← dm.proj.perm.submit（🔐 权限 · 保存）
 *       setNoMention        ← dm.proj.noMention（✋ 免@）
 *       setAutoCompact      ← dm.proj.autoCompact（🗜️ 自动压缩）
 *       setCompletionReminder ← dm.set.completionReminder（🔔 完成提醒）
 *       doctorBackends      ← dm.doctor 的后端探测段（🩺 诊断）
 *       eventDiagnosis      ← dm.doctor 的事件订阅三态段（M-7）
 *       listSessions        ← dm.projectTopics（🧵 话题钻取）
 *       tailLogs            ← CLI `logs`（DM 够不着的宿主机域）
 *   - 写方法与 DM 的 dm.* 回调 handler 走**同一套共享纯函数**（admin/ops.ts 的
 *     perform*）：同样的校验、同样的会话驱逐、同样的落盘——双端行为零漂移。
 *
 * 【进程形态】写操作必须在持有该 bot registry/LIVE 会话的进程内执行：
 *   - 单 bot inline `run`：daemon 进程内直接调 Orchestrator.adminExecute。
 *   - 多 bot supervisor：经 IPC（admin/ipc.ts）转发给对应 bot 子进程执行。
 *   - 独立预览进程（`web` 命令、daemon 未跑）：无 executeWrite → 写抛
 *     {@link NotWiredYetError}（HTTP 501，只读预览）。
 *
 * 【实现注意】所有跨 bot 读取走 {@link botPaths} 的**显式路径**（listProjectsIn /
 * listSessionsIn / loadConfig(file)），绝不 useBotDir 全局切目录——daemon 进程内
 * 切目录会把在跑 bot 的 paths 指到别的 bot（第一棒遗留的坑，本棒修掉）。
 */
export interface AdminService {
  /** 全部已注册 bot + 进程在跑状态（daemon 内 = 真实 WS 状态；预览 = 锁文件探测）。 */
  listBots(): Promise<AdminBot[]>;
  /** 某 bot 的项目列表（含话题数等聚合字段），对齐 DM 📁 项目列表。 */
  listProjects(botId: string): Promise<AdminProject[]>;
  /** 单个项目详情；不存在返回 undefined。 */
  getProject(botId: string, name: string): Promise<AdminProject | undefined>;
  /** 🧠 切换项目后端（写）。与 DM dm.proj.backend.submit 同一套校验+落盘。 */
  switchBackend(botId: string, projectName: string, backendId: string): Promise<void>;
  /** 🔐 设置权限档（管理员档/普通用户档/联网）（写），含驱逐活跃会话的既有语义。 */
  setPermissionMode(
    botId: string,
    projectName: string,
    opts: { mode: PermissionMode; guestMode?: PermissionMode; network?: boolean },
  ): Promise<void>;
  /** ✋ 免@ 开关（写）。 */
  setNoMention(botId: string, projectName: string, on: boolean): Promise<void>;
  /** 🗜️ 自动压缩开关（写），含驱逐活跃会话的既有语义。 */
  setAutoCompact(botId: string, projectName: string, on: boolean): Promise<void>;
  /** 🔔 每 bot 的普通任务结束提醒（写）；经 bot 进程落盘并热更新 LIVE cfg。 */
  setCompletionReminder(
    botId: string,
    value: { mode: CompletionReminderMode; longTaskMinutes: number },
  ): Promise<void>;
  /** 🩺 对全部注册后端做环境体检（doctor 探测，绝不抛错）。 */
  doctorBackends(): Promise<AdminBackendStatus[]>;
  /** 事件订阅三态诊断（ok / missing / unpublished / unchecked，绝不抛错）。 */
  eventDiagnosis(botId: string): Promise<EventDiagnosis>;
  /** 某项目的话题（会话）列表，新→旧，对齐 DM 🧵 话题钻取。 */
  listSessions(botId: string, projectName: string): Promise<AdminSession[]>;
  /** 最近文件日志尾部（JSON lines 文本）。 */
  tailLogs(opts?: { maxBytes?: number }): Promise<string>;

  // ── Web 专属：扫码初始化 / 添加机器人（day-0 场景）─────────────────────────
  /**
   * 某 bot 的初始化 checklist 聚合三/四态：密钥有效（探活）/ 长连接在线 / 事件订阅
   * 三态诊断（复用 M-7）/ 缺失 scope 清单 + 一键深链。向导页 5s 轮询它直到「事件已
   * 生效」。绝不 throw——每段独立降级。
   */
  getSetupStatus(botId: string): Promise<AdminSetupStatus>;
  /**
   * 扫码注册一个机器人（day-0 主路径）：编排 SDK registerApp 扫码会话 → 拿明文密钥
   * → 复用 registerBotFromCredentials 写盘（keystore + config + bots.json），扫码人
   * open_id 自动落成 owner+admin。绝不 throw——失败落 {@link QrRegisterFailure}
   * （HTTP/SSE 层据 code 映射）。callbacks 把 SDK 的 onQr/onStatus 透传给上层做 SSE，
   * signal 取消（abort → SDK reject code='abort'，本方法返回 {ok:false,code:'abort'}）。
   * 拿不到扫码人的 open_id 时拒绝落盘，避免产生无人可管理的机器人配置。
   */
  registerBotByQr(opts: {
    signal: AbortSignal;
    onQr: (info: RegistrationQr) => void;
    onStatus?: (info: RegistrationStatus) => void;
  }): Promise<QrRegisterResult | QrRegisterFailure>;

  // ── Web 专属：后端 catalog 预览 + 按需安装（backend-catalog-ondemand.md）──────
  /**
   * 列出后端 catalog，每条附依赖状态（installed/not-installed/external-missing）+
   * installable + approxSizeMB + version + 是否当前全局默认。读路径，绝不抛错，
   * 与 daemon/预览进程形态无关（只探本机装配，不写）。Web GET /api/backends 用它。
   */
  listBackendCatalog(): Promise<AdminBackendCatalog>;
  /**
   * 按需安装一个后端依赖（npm-ondemand 包）到用户私装目录。
   * 仅 installable 的后端可装；external-cli（codex）调用即 {ok:false} 带手动装法。
   * onProgress 透传 npm 输出（SSE {type:'log'}），signal 取消（kill 子进程 + 回滚半装）。
   * **install 是 daemon 注入态能力**（owns runtime）：只读预览进程无 installer 注入 →
   * 抛 {@link NotWiredYetError}（HTTP 501），引导先起 daemon。绝不 throw 其它错。
   */
  installBackend(
    id: string,
    onProgress?: InstallProgress,
    signal?: AbortSignal,
    opts?: { update?: boolean },
  ): Promise<InstallResult>;
  /**
   * 卸载一个装在用户私装目录的后端依赖（rm node_modules/<pkg> + 删 package.json 条目）。
   * 仅 canUninstall 的可卸（npm-ondemand + 确实装在用户目录）。卸载是 daemon 注入态能力
   * （owns runtime）→ 只读预览无注入 → 抛 {@link NotWiredYetError}（HTTP 501）。绝不 throw 其它。
   */
  uninstallBackend(id: string): Promise<{ ok: boolean; message: string }>;
  /**
   * 某后端的版本信息：已装版本（用户私装目录 package.json）+ npm 上最新版 + 有无更新。
   * 网络查询（npm view），较慢，按需调（不进 listBackendCatalog 以免拖慢每次刷新）。
   * 绝不抛错：查不到 latest → null、hasUpdate=false。
   */
  backendVersion(id: string): Promise<{ installed: string | null; latest: string | null; hasUpdate: boolean }>;

  // ── Web 专属：daemon 生命周期 / 升级 / 多 bot 管理 / 宿主机体检 ──────────────
  /** daemon 生命周期快照（service 注册状态 + 运行 pid/版本/启动时长）。绝不抛错。 */
  getDaemonStatus(): Promise<DaemonStatus>;
  /**
   * 重启后台 daemon（service stop→start）。不能在 web 进程里直执行（会杀自己），
   * 走 detached helper（注入 {@link AdminServiceDeps.restartDaemon}）。只读预览
   * （无 daemon 在跑）抛 {@link NotWiredYetError}（HTTP 501）。
   */
  restartDaemon(): Promise<void>;
  /**
   * 启动后台服务（service install = 注册自启 + 拉起）。给只读预览用——预览态下
   * daemon 没在跑，注入 {@link AdminServiceDeps.startDaemon}（detached helper）把它
   * 装起来。未注入（如 daemon 进程自身，本就在跑）抛 {@link NotWiredYetError}（501）。
   */
  startDaemon(): Promise<void>;
  /**
   * 停止后台服务（service uninstall = 停进程 + 移除自启），与 CLI `stop` 同义。走
   * detached helper（不能在 web 进程里停自己）。只读预览（无 daemon）未注入抛 NotWiredYetError。
   */
  stopDaemon(): Promise<void>;
  /** 检查 npm 上有无新版（current / latest / hasUpdate / dev）。绝不抛错（latest=null 兜底）。 */
  checkUpdate(): Promise<UpdateCheck>;
  /**
   * 读最近一次升级的进度/结果（installing/restarting/done/error），供 Web 轮询——尤其
   * 失败：detached helper 的失败否则对网页端完全静默。无记录返回 null。绝不抛错。
   */
  updateStatus(): UpdateStatus | null;
  /**
   * 升级到最新版（npm i -g + 重启 daemon）。**默认只检测不自动升级**——只有用户
   * 点「升级」按钮才走这里。同 restart 走 detached helper。只读预览抛 NotWiredYetError。
   */
  applyUpdate(): Promise<void>;
  /** 宿主机体检：后端环境（复用 doctorBackends）+ Node/平台/配置目录/日志体量。绝不抛错。 */
  hostDoctor(): Promise<AdminHostDoctor>;
  /**
   * 切换某 bot 的 enabled（= 活跃集 active 字段，bots.json 落盘）。纯写宿主机级
   * 注册表，不需 daemon 在跑。改活跃集需重启 daemon 才生效
   * （提示由 UI 给），这里只落盘。绝不 throw——失败回 {@link BotMutationResult}。
   */
  setBotEnabled(appId: string, enabled: boolean): Promise<BotMutationResult>;
  /**
   * 删除某 bot：注册表 + keystore 密钥 + 状态目录。**拒绝删除当前唯一 bot 或带
   * 运行中会话的 bot**——返回 { ok:false, reason } 让 UI 给清晰提示，绝不 throw。
   */
  deleteBot(appId: string): Promise<BotMutationResult>;
}

/** setBotEnabled / deleteBot 的统一返回：ok 或带中文拒因（HTTP 层映射 409）。 */
export type BotMutationResult = { ok: true } | { ok: false; reason: string };

/** 宿主机体检聚合：宿主机域（host.ts）+ 后端环境探测（doctorBackends 同源）。 */
export interface AdminHostDoctor extends HostDoctor {
  backends: AdminBackendStatus[];
}

/** 只读预览（daemon 未跑 / 独立 `web` 进程）里写方法统一抛它；HTTP 层映射 501。 */
export class NotWiredYetError extends Error {
  readonly code = 'NOT_WIRED_YET';
  constructor(action: string) {
    super(
      `「${action}」需要 daemon 在跑：当前是只读预览（直读本机文件）。` +
        '请先 `feishu-codex-bridge run`（或 `start`）启动，再运行 `web` 自动跳到 daemon 的控制台执行写操作。',
    );
    this.name = 'NotWiredYetError';
  }
}

export interface AdminBot {
  name: string;
  appId: string;
  tenant: 'feishu' | 'lark';
  botName?: string;
  /** run/start 会带起它（bot use 的多选活跃集） */
  active: boolean;
  /** bots.json 的 current（单 bot 代码路径的主 bot） */
  current: boolean;
  /** bridge 进程在跑吗。daemon 进程内 = 本进程/子进程的真实状态；预览进程 =
   * 单实例锁文件 + signal 0 探测。 */
  running: boolean;
  pid?: number;
  startedAt?: number;
  /** 真实 WS 长连接状态（connected / connecting / reconnecting / …）。仅 daemon
   * 进程内（本进程的 channel / 子进程 IPC 上报）可用；预览进程缺省。 */
  connection?: string;
  /** 每 bot 的普通任务结束提醒 effective 配置（缺省 = failures / 3 分钟）。 */
  completionReminder: ResolvedCompletionReminderConfig;
}

/** daemon 进程内的实时运行状态（注入 {@link AdminServiceDeps.liveStatus}）。 */
export interface BotLiveStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  connection?: string;
}

/** 项目快照——effective 值（缺省已按 registry 的单一事实源解析），UI 直接渲染。 */
export interface AdminProject {
  name: string;
  chatId: string;
  cwd: string;
  blank: boolean;
  branch?: string;
  kind: 'multi' | 'single';
  origin: 'created' | 'joined';
  /** effective 免@（noMention ?? defaultNoMention） */
  noMention: boolean;
  /** effective 自动压缩（autoCompact ?? true） */
  autoCompact: boolean;
  /** effective 管理员权限档 */
  mode: PermissionMode;
  /** effective 普通用户权限档 */
  guestMode: PermissionMode;
  network: boolean;
  /** effective 后端 id（显式 backend ?? 智能默认 effectiveDefaultBackend，与运行时路由同源） */
  backend: string;
  allowedUsersCount: number;
  /** 🧵 话题数（该群名下的会话记录数） */
  sessionCount: number;
  createdAt: number;
}

export interface AdminSession {
  threadId: string;
  chatId: string;
  summary: string;
  backend: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AdminBackendStatus {
  id: string;
  name: string;
  ok: boolean;
  version: string | null;
  location?: string;
  hint?: string;
  /** 全局默认后端（项目未显式选择时用它） */
  isDefault: boolean;
}

/** 添加机器人向导的 checklist 聚合（GET /api/bots/:appId/setup-status）。 */
export interface AdminSetupStatus {
  appId: string;
  tenant: 'feishu' | 'lark';
  botName?: string;
  /** ① 密钥有效（tenant_access_token 探活）；undefined = 该 bot 配置缺失，没法探。 */
  credentials: { ok: boolean; reason?: string };
  /** ② bridge 长连接在线状态：running（进程在跑吗）+ connection（真实 WS，仅 daemon 内有）。 */
  connection: { running: boolean; connection?: string };
  /** ③ 事件订阅三态诊断（复用 M-7 event-diagnosis）。 */
  event: EventDiagnosis;
  /**
   * ④ 必需 scope 中尚未授权的（undefined = 没查成；空 = 已齐全）+ 一键授权深链。
   * grantUrl 始终给（预选全部 scope，缺啥点一次补齐）。
   */
  scopes: { missingRequired?: string[]; grantUrl: string };
  /** 开发者后台「事件与回调」配置页深链（事件订阅没写 API，只能引导手动配 + 发版本）。 */
  eventConfigUrl: string;
}

/** 扫码注册成功：基本信息 + adminOpenId（扫码人 = owner）。
 * 绝不含 client_secret（已进 keystore）。Web SSE 的 done 事件 payload 据此组装。 */
export interface QrRegisterResult {
  ok: true;
  appId: string;
  name: string;
  tenant: 'feishu' | 'lark';
  botName?: string;
  /** 扫码人 open_id（已落成 owner+admin）。 */
  adminOpenId: string;
  /** 必需 scope 中尚未授权的（undefined = 没查成；空 = 已齐全）。 */
  missingScopes?: string[];
}

/** 扫码注册失败：code 来自 SDK reject（abort/expired_token/access_denied）或身份缺失
 * （identity_missing）/ 写盘（persist_failed）/ 校验（credential_rejected）。 */
export interface QrRegisterFailure {
  ok: false;
  code:
    | 'abort'
    | 'expired_token'
    | 'access_denied'
    | 'identity_missing'
    | 'persist_failed'
    | 'credential_rejected'
    | 'network'
    | 'unknown';
  reason: string;
}

/** GET /api/backends 的聚合：catalog 全条目（含安装态）+ 当前全局默认后端 id。 */
export interface AdminBackendCatalog {
  /** 当前有效全局默认后端 id（项目未显式选择时路由到它）。 */
  defaultBackend: string;
  entries: AdminBackendCatalogEntry[];
}

/** 一条后端 catalog 的管理面投影：catalog 元数据 + 本机探测出的安装/可用态。 */
export interface AdminBackendCatalogEntry {
  id: string;
  agentFamily: string;
  displayName: string;
  /** 接入方式短名（app-server / sdk / acp）。 */
  access: string;
  blurb?: string;
  /** 依赖类型（external-cli / npm-ondemand / npm-external）。 */
  depKind: string;
  /** 安装态三态：installed / not-installed（可一键装）/ external-missing（手动装）。 */
  depState: BackendDepState;
  /** 可一键按需下载（npm-ondemand 且当前未装 → true）。 */
  installable: boolean;
  /** 体积提示 MB（下载确认用）。 */
  approxSizeMB?: number;
  /** 探测到的版本（external-cli 的 codex --version 等；未装/无版本 → null）。 */
  version: string | null;
  /** 已装在用户私装目录里的版本号（读 package.json；未装/dev devDep → null）。后端管理页展示。 */
  installedVersion: string | null;
  /** 能否一键卸载（npm-ondemand 且确实装在用户私装目录 → true；dev/worktree 的 devDep 不可卸）。 */
  canUninstall: boolean;
  /** !installed 时的人读提示（external 给手动装法 / npm-ondemand 给「点下载」）。 */
  hint?: string;
  /** 是否当前全局默认。 */
  isDefault: boolean;
  /** 本后端支持的权限档（undefined ⇒ 全档）。 */
  supportedModes?: readonly PermissionMode[];
}

/** daemon/预览两种进程形态的差异全部收进这几个注入点；读路径完全同源。 */
export interface AdminServiceDeps {
  /** 写执行器：botId + op → 完成或抛 AdminWriteError（校验拒绝）。
   * 缺省 = 只读预览，写方法抛 {@link NotWiredYetError}（HTTP 501）。 */
  executeWrite?: (botId: string, op: AdminWriteOp) => Promise<void>;
  /** 实时运行状态（daemon 进程内：本进程 channel / 子进程 IPC）。返回 undefined
   * 或缺省 → 回退锁文件探测（该 bot 不归本 daemon 管，如未激活的 bot）。 */
  liveStatus?: (botId: string) => Promise<BotLiveStatus | undefined>;
  /**
   * Resolve one bot's app secret in the owning host. Desktop configs contain
   * process-only SecretRefs, so the parent Web host must not fall back to the
   * upstream keystore when this adapter is present.
   */
  resolveBotSecret?: (botId: string, config: AppConfig) => Promise<string>;
  /**
   * Desktop-owned registration route. When present, QR registration never
   * writes the upstream keystore/config/registry directly.
   */
  registerBotByQr?: AdminService['registerBotByQr'];
  /** Desktop-owned registry mutations; keep desktop-index and runtime in sync. */
  setBotEnabled?: AdminService['setBotEnabled'];
  deleteBot?: AdminService['deleteBot'];
  /** daemon 进程启动时刻（内嵌 web 注入）；只读预览不传 → uptime 缺省。 */
  daemonStartedAt?: number;
  /** Desktop-owned lifecycle snapshot; bypasses launchd/systemd/task probes. */
  daemonStatus?: () => Promise<DaemonStatus>;
  /**
   * 重启 daemon 的真正执行器（detached helper，见 cli/commands/daemon-control）。
   * 缺省 = 只读预览（无 daemon 在跑），restartDaemon/applyUpdate 抛 NotWiredYetError。
   */
  restartDaemon?: () => void | Promise<void>;
  /**
   * Host-owned update action. The desktop host must route this to its updater;
   * absence produces 501 and never runs the upstream global npm updater.
   */
  applyUpdate?: () => void | Promise<void>;
  /** Desktop-owned update availability/status adapters. */
  checkUpdate?: () => Promise<UpdateCheck>;
  updateStatus?: () => UpdateStatus | null;
  clearUpdateStatus?: () => void;
  /** 启动后台服务的执行器（detached helper，service install）。只读预览注入，缺省抛 NotWiredYetError。 */
  startDaemon?: () => void | Promise<void>;
  /** 停止后台服务的执行器（detached helper，service uninstall）。daemon 进程注入，缺省抛 NotWiredYetError。 */
  stopDaemon?: () => void | Promise<void>;
  /**
   * 只读预览标记（仅 {@link createReadonlyAdminService} 置 true）。置 true 时扫码注册机器人
   * （registerBotByQr，属写操作）一律 NotWiredYetError——「没启动只读」：加机器人
   * 必须先有 daemon 在跑。daemon 托管的服务不置此标记，注册照常。
   */
  readonlyPreview?: boolean;
  /**
   * 按需后端依赖的安装执行器（npm-ondemand → 用户私装目录）。daemon 进程注入
   * {@link installBackendDep}（它 owns runtime，装完即能解析加载）；只读预览进程
   * 不注入 → installBackend 抛 {@link NotWiredYetError}（HTTP 501）。测试可注入 mock
   * 推进度 / 模拟失败，不真跑 npm。
   */
  installBackend?: (
    pkg: string,
    onProgress?: InstallProgress,
    signal?: AbortSignal,
    opts?: { binName?: string },
  ) => Promise<InstallResult>;
  /** 卸载执行器（rm 用户私装目录里的包 + 清 package.json 条目）。daemon 进程注入
   * {@link uninstallBackendDep}；只读预览不注入 → uninstallBackend 抛 NotWiredYetError。 */
  uninstallBackend?: (pkg: string) => Promise<boolean>;
}

/**
 * AdminService 的统一实现：读路径直读 ~/.feishu-codex-bridge/bots/<appId>/ 下的
 * 注册表/会话文件（复用 registry / session-store / store 模块的显式路径导出，
 * 不自己解析 JSON；不碰全局 currentBotDir）；写路径与实时状态由 deps 注入。
 */
export function createAdminService(deps: AdminServiceDeps = {}): AdminService {
  function resolveSecret(botId: string, config: AppConfig): Promise<string> {
    return deps.resolveBotSecret
      ? deps.resolveBotSecret(botId, config)
      : resolveAppSecret(config);
  }

  async function projectsWithCounts(botId: string): Promise<AdminProject[]> {
    const files = botPaths(botId);
    const projects = await listProjectsIn(files.projectsFile);
    const sessions = await listSessionsIn(files.sessionsFile);
    // 未显式选后端的项目，effective backend = 智能默认（与运行时 backendForProject
    // 同源），UI 展示「会实际路由到哪」而非硬编码 codex；探测失败回退常量默认。
    const defaultBackend = await effectiveDefaultBackend().catch(() => DEFAULT_BACKEND_ID);
    const countByChat = new Map<string, number>();
    for (const s of sessions) {
      countByChat.set(s.chatId, (countByChat.get(s.chatId) ?? 0) + 1);
    }
    return projects.map((p) => ({
      name: p.name,
      chatId: p.chatId,
      cwd: p.cwd,
      blank: p.blank,
      branch: p.branch,
      kind: p.kind ?? 'multi',
      origin: p.origin ?? 'created',
      noMention: p.noMention ?? defaultNoMention(p),
      autoCompact: p.autoCompact ?? true,
      mode: effectiveMode(p),
      guestMode: effectiveGuestMode(p),
      network: p.network ?? false,
      backend: p.backend ?? defaultBackend,
      allowedUsersCount: p.allowedUsers?.length ?? 0,
      sessionCount: p.chatId ? (countByChat.get(p.chatId) ?? 0) : 0,
      createdAt: p.createdAt,
    }));
  }

  /** 单实例锁文件（processes.json）→「bridge 进程在跑吗」。损坏/缺失一律视为
   * 未在跑（预览级探测，绝不抛错）。daemon 进程内只用于「不归本 daemon 管」的
   * bot（如未激活但被别的终端单独 run 起来的）。 */
  async function lockFileRunState(botId: string): Promise<BotLiveStatus> {
    try {
      const raw = await readFile(botPaths(botId).processesFile, 'utf8');
      const rec = JSON.parse(raw) as { pid?: number; startedAt?: number };
      if (typeof rec.pid === 'number' && isAlive(rec.pid)) {
        return { running: true, pid: rec.pid, startedAt: rec.startedAt };
      }
    } catch {
      /* 没锁文件 / 损坏 → 未在跑 */
    }
    return { running: false };
  }

  async function runState(botId: string): Promise<BotLiveStatus> {
    const live = await deps.liveStatus?.(botId).catch(() => undefined);
    return live ?? lockFileRunState(botId);
  }

  /** config 损坏/缺失不能拖垮整个 /api/state；按 schema 的安全默认值降级。 */
  async function completionReminderFor(botId: string): Promise<ResolvedCompletionReminderConfig> {
    try {
      return getCompletionReminderConfig((await loadConfig(botPaths(botId).configFile)) as AppConfig);
    } catch {
      return getCompletionReminderConfig({} as AppConfig);
    }
  }

  function executeWrite(botId: string, action: string, op: AdminWriteOp): Promise<void> {
    if (!deps.executeWrite) throw new NotWiredYetError(action);
    return deps.executeWrite(botId, op);
  }

  return {
    async listBots(): Promise<AdminBot[]> {
      const reg = await loadBots();
      const configured = reg.bots.some((b) => b.active !== undefined);
      const out: AdminBot[] = [];
      for (const b of reg.bots) {
        const [run, completionReminder] = await Promise.all([runState(b.appId), completionReminderFor(b.appId)]);
        out.push({
          name: b.name,
          appId: b.appId,
          tenant: b.tenant,
          botName: b.botName,
          // 与 config/bots.activeBots 同语义：从未配置过活跃集 → 回退 current。
          active: configured ? b.active === true : reg.current === b.appId,
          current: reg.current === b.appId,
          running: run.running,
          pid: run.pid,
          startedAt: run.startedAt,
          connection: run.connection,
          completionReminder,
        });
      }
      return out;
    },

    listProjects(botId: string): Promise<AdminProject[]> {
      return projectsWithCounts(botId);
    },

    async getProject(botId: string, name: string): Promise<AdminProject | undefined> {
      return (await projectsWithCounts(botId)).find((x) => x.name === name);
    },

    async switchBackend(botId: string, projectName: string, backendId: string): Promise<void> {
      await executeWrite(botId, '🧠 切换后端', { kind: 'switchBackend', project: projectName, backend: backendId });
    },

    async setPermissionMode(
      botId: string,
      projectName: string,
      opts: { mode: PermissionMode; guestMode?: PermissionMode; network?: boolean },
    ): Promise<void> {
      await executeWrite(botId, '🔐 设置权限档', {
        kind: 'setPermissionMode',
        project: projectName,
        mode: opts.mode,
        guestMode: opts.guestMode,
        network: opts.network,
      });
    },

    async setNoMention(botId: string, projectName: string, on: boolean): Promise<void> {
      await executeWrite(botId, '✋ 免@ 开关', { kind: 'setNoMention', project: projectName, on });
    },

    async setAutoCompact(botId: string, projectName: string, on: boolean): Promise<void> {
      await executeWrite(botId, '🗜️ 自动压缩开关', { kind: 'setAutoCompact', project: projectName, on });
    },

    async setCompletionReminder(
      botId: string,
      value: { mode: CompletionReminderMode; longTaskMinutes: number },
    ): Promise<void> {
      await executeWrite(botId, '🔔 完成提醒', {
        kind: 'setCompletionReminder',
        mode: value.mode,
        longTaskMinutes: value.longTaskMinutes,
      });
    },

    doctorBackends(): Promise<AdminBackendStatus[]> {
      return probeAllBackends();
    },

    async eventDiagnosis(botId: string): Promise<EventDiagnosis> {
      try {
        const cfg = await loadConfig(botPaths(botId).configFile);
        if (!isComplete(cfg)) return { state: 'unchecked', reason: '配置缺失（该 bot 尚未完成初始化）' };
        const { app } = cfg.accounts;
        const secret = await resolveSecret(botId, cfg);
        return await diagnoseEventSubscription(app.id, secret, app.tenant);
      } catch (err) {
        return { state: 'unchecked', reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async listSessions(botId: string, projectName: string): Promise<AdminSession[]> {
      const files = botPaths(botId);
      const p = (await listProjectsIn(files.projectsFile)).find((x) => x.name === projectName);
      if (!p?.chatId) return [];
      const sessions = await listSessionsIn(files.sessionsFile);
      return sessions
        .filter((s) => s.chatId === p.chatId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({
          threadId: s.threadId,
          chatId: s.chatId,
          summary: s.summary,
          backend: s.backend,
          model: s.model,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }));
    },

    tailLogs(opts?: { maxBytes?: number }): Promise<string> {
      return readRecentLogs({ maxBytes: opts?.maxBytes ?? 64 * 1024 });
    },

    async getSetupStatus(botId: string): Promise<AdminSetupStatus> {
      const reg = await loadBots();
      const entry = reg.bots.find((b) => b.appId === botId);
      const tenant: 'feishu' | 'lark' = entry?.tenant ?? 'feishu';
      const base: Pick<AdminSetupStatus, 'appId' | 'tenant' | 'botName' | 'eventConfigUrl'> = {
        appId: botId,
        tenant,
        botName: entry?.botName,
        eventConfigUrl: buildEventConfigUrl(botId, tenant),
      };

      // ② 长连接：真实状态优先（daemon 内），否则锁文件探测——绝不抛错。
      const run = await runState(botId);

      // 配置缺失（注册一半 / 损坏）→ 探活、事件、scope 都没法查，统一降级。
      let cfg;
      try {
        cfg = await loadConfig(botPaths(botId).configFile);
      } catch {
        cfg = undefined;
      }
      if (!cfg || !isComplete(cfg)) {
        return {
          ...base,
          credentials: { ok: false, reason: '配置缺失（该机器人尚未完成注册或文件损坏）' },
          connection: { running: run.running, connection: run.connection },
          event: { state: 'unchecked', reason: '配置缺失，无法诊断事件订阅' },
          scopes: { grantUrl: buildScopeGrantUrl(botId, tenant) },
        };
      }

      // ①③④ 都要密钥——解析一次，三段共用（探活拿 scope、事件诊断各打各的只读 API）。
      let secret: string | undefined;
      try {
        secret = await resolveSecret(botId, cfg);
      } catch (err) {
        return {
          ...base,
          credentials: { ok: false, reason: err instanceof Error ? err.message : String(err) },
          connection: { running: run.running, connection: run.connection },
          event: { state: 'unchecked', reason: '密钥不可解析' },
          scopes: { grantUrl: buildScopeGrantUrl(botId, tenant) },
        };
      }

      const { app } = cfg.accounts;
      // ①+④ 探活同时拿 botName / missingScopes；③ 事件诊断并发。各自绝不抛错。
      const [validation, event] = await Promise.all([
        validateAppCredentials(app.id, secret, app.tenant).catch((err) => ({
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        })),
        diagnoseEventSubscription(app.id, secret, app.tenant).catch(
          (err): EventDiagnosis => ({ state: 'unchecked', reason: err instanceof Error ? err.message : String(err) }),
        ),
      ]);

      return {
        ...base,
        botName: validation.ok ? (validation.botName ?? entry?.botName) : entry?.botName,
        credentials: validation.ok ? { ok: true } : { ok: false, reason: validation.reason },
        connection: { running: run.running, connection: run.connection },
        event,
        scopes: {
          missingRequired: validation.ok ? validation.missingScopes : undefined,
          grantUrl: buildScopeGrantUrl(app.id, app.tenant),
        },
      };
    },

    async registerBotByQr(opts): Promise<QrRegisterResult | QrRegisterFailure> {
      if (deps.registerBotByQr) return deps.registerBotByQr(opts);
      // 「没启动只读」：只读预览不许扫码加机器人——必须先有 daemon 在跑。
      if (deps.readonlyPreview) throw new NotWiredYetError('➕ 添加机器人');
      // ① 扫码会话：透传 onQr/onStatus 给上层做 SSE；signal 取消 → SDK reject code='abort'。
      let creds;
      try {
        creds = await startRegistration({ signal: opts.signal, onQr: opts.onQr, onStatus: opts.onStatus });
      } catch (err) {
        const code = registrationErrorCode(err);
        return mapQrFailure(code, registrationErrorMessage(err));
      }
      const ownerOpenId = creds.operatorOpenId?.trim();
      if (!ownerOpenId) {
        return {
          ok: false,
          code: 'identity_missing',
          reason: '未获取到扫码人的飞书身份，未保存机器人。请重新扫码并确认授权。',
        };
      }
      // ② 入库：「探活→keystore→config→bots.json」，扫码人 open_id 落成 owner+admin。
      //    明文 client_secret 只此一次喂进去，绝不回显——done payload 永不含它。
      const r = await registerBotFromCredentials({
        appId: creds.clientId,
        appSecret: creds.clientSecret,
        tenant: creds.tenant,
        ownerOpenId,
      });
      if (!r.ok) {
        // 写盘 / 探活失败 → 据 register-bot 的 code 映射（invalid_input 理论不该出现，
        // 扫码拿到的 appId 必合法，归为 unknown 兜底）。
        const code: QrRegisterFailure['code'] =
          r.code === 'credential_rejected' ? 'credential_rejected' : r.code === 'persist_failed' ? 'persist_failed' : 'unknown';
        return { ok: false, code, reason: r.reason };
      }
      return {
        ok: true,
        appId: r.appId,
        name: r.name,
        tenant: r.tenant,
        botName: r.botName,
        adminOpenId: ownerOpenId,
        missingScopes: r.missingScopes,
      };
    },

    async listBackendCatalog(): Promise<AdminBackendCatalog> {
      // force：用户刚装完后要看「现在」的默认（绕过探测缓存）。
      const defaultBackend = await effectiveDefaultBackend({ force: true }).catch(() => DEFAULT_BACKEND_ID);
      const entries = await Promise.all(
        visibleCatalog().map((entry) => catalogEntryStatus(entry, defaultBackend)),
      );
      return { defaultBackend, entries };
    },

    async installBackend(id, onProgress, signal, opts): Promise<InstallResult> {
      const entry = catalogById(id);
      if (!entry) {
        return { ok: false, code: null, aborted: false, tail: `未知后端「${id}」` };
      }
      // 仅 installable（npm-ondemand）可一键装；external-cli（codex）给手动装法。
      if (!isInstallable(entry)) {
        return {
          ok: false,
          code: null,
          aborted: false,
          tail: `「${entry.displayName}」不支持一键下载。手动安装：${entry.dep.installCmd ?? entry.dep.detectHint}`,
        };
      }
      // 更新 = 装 @latest（无视 catalog 的 version pin，取 npm 最新）；普通下载用 pin（有的话）。
      const spec = opts?.update ? 'latest' : entry.dep.version;
      const pkg = spec ? `${entry.dep.pkg}@${spec}` : entry.dep.pkg!;
      const verb = opts?.update ? '🔄 更新' : '⬇️ 下载';
      // install/update 是 daemon 注入态能力（owns runtime）；只读预览无注入 → 501 引导起 daemon。
      if (!deps.installBackend) throw new NotWiredYetError(`${verb}「${entry.displayName}」`);
      // binName ⇒ bin 类后端：装完按 .bin 校验而非 require.resolve。
      return deps.installBackend(pkg, onProgress, signal, { binName: entry.dep.binName });
    },

    async uninstallBackend(id): Promise<{ ok: boolean; message: string }> {
      const entry = catalogById(id);
      if (!entry) return { ok: false, message: `未知后端「${id}」` };
      if (entry.dep.kind === 'external-cli') {
        // codex 等外部 CLI 是你系统自管的（全局 npm / Codex.app / CODEX_BIN），桥只用不卸，
        // 删了会破坏运行中的会话。引导用户自行处置，绝不替删。
        return {
          ok: false,
          message: `「${entry.displayName}」是你本机自管的全局 CLI（不是桥下载的包），无法在这里卸载。如需移除，请自行 \`npm uninstall -g\` 或卸载 Codex.app。`,
        };
      }
      if (!entry.dep.pkg || !isInstallable(entry)) {
        return { ok: false, message: `「${entry.displayName}」不是可一键管理的按需后端，无法卸载。` };
      }
      if (!isBackendInstalledInUserDir(entry)) {
        return { ok: false, message: `「${entry.displayName}」并未装在用户目录，无需卸载。` };
      }
      // 有效卸载 owns runtime：桌面会先持久禁用只读 legacy fallback，再删除 managed
      // copy；纯上游仍是 rm + 清 package.json。只读预览无注入 → 501。
      if (!deps.uninstallBackend) throw new NotWiredYetError(`🗑️ 卸载「${entry.displayName}」`);
      const ok = await deps.uninstallBackend(entry.dep.pkg);
      return ok
        ? { ok: true, message: `已卸载「${entry.displayName}」。` }
        : { ok: false, message: `卸载「${entry.displayName}」失败（可能仍被占用），可稍后重试。` };
    },

    async backendVersion(id): Promise<{ installed: string | null; latest: string | null; hasUpdate: boolean }> {
      const entry = catalogById(id);
      if (!entry?.dep.pkg) return { installed: null, latest: null, hasUpdate: false };
      const installed = installedBackendVersion(entry.dep.pkg);
      const latest = await latestNpmVersion(entry.dep.pkg).catch(() => null);
      const hasUpdate = !!installed && !!latest && cmpSemver(latest, installed) > 0;
      return { installed, latest, hasUpdate };
    },

    async getDaemonStatus(): Promise<DaemonStatus> {
      if (deps.daemonStatus) return deps.daemonStatus();
      // service manager 状态在「未支持平台」会抛——按 undefined 降级（toDaemonStatus
      // 据此置 supported=false，UI 把重启按钮置灰引导前台 run）。
      let status;
      try {
        status = await getServiceAdapter().status();
      } catch {
        status = undefined;
      }
      return toDaemonStatus({ status, version: bridgeVersion(), startedAt: deps.daemonStartedAt });
    },

    async restartDaemon(): Promise<void> {
      // 不能在 web 进程里直执行（会杀自己）：daemon 内注入 detached helper；只读
      // 预览无 daemon 在跑 → 引导先起 daemon。
      if (!deps.restartDaemon) throw new NotWiredYetError('🔁 重启 daemon');
      await deps.restartDaemon();
    },

    async startDaemon(): Promise<void> {
      // 只读预览注入 spawnDaemonControl('start')；daemon 进程自身在跑、无需「启动」→ 未注入 501。
      if (!deps.startDaemon) throw new NotWiredYetError('▶️ 启动 daemon');
      await deps.startDaemon();
    },

    async stopDaemon(): Promise<void> {
      // daemon 进程注入 spawnDaemonControl('stop')（detached，停自己安全）；只读预览无 daemon → 501。
      if (!deps.stopDaemon) throw new NotWiredYetError('⏹ 停止 daemon');
      await deps.stopDaemon();
    },

    checkUpdate(): Promise<UpdateCheck> {
      if (deps.checkUpdate) return deps.checkUpdate();
      return checkUpdateImpl().catch(() => ({
        current: bridgeVersion(),
        latest: null,
        hasUpdate: false,
        dev: false,
      }));
    },

    updateStatus(): UpdateStatus | null {
      if (deps.updateStatus) return deps.updateStatus();
      return readUpdateStatus();
    },

    async applyUpdate(): Promise<void> {
      if (!deps.applyUpdate) throw new NotWiredYetError('⬆️ 升级');
      // 清掉上一次的结果，之后 Web 轮询读到的状态才确定属于本次升级（helper 会重写）。
      if (deps.clearUpdateStatus) deps.clearUpdateStatus();
      else clearUpdateStatus();
      await deps.applyUpdate();
    },

    async hostDoctor(): Promise<AdminHostDoctor> {
      const [host, backends] = await Promise.all([collectHostDoctor(), probeAllBackends()]);
      return { ...host, backends };
    },

    async setBotEnabled(appId: string, enabled: boolean): Promise<BotMutationResult> {
      if (deps.setBotEnabled) return deps.setBotEnabled(appId, enabled);
      const reg = await loadBots();
      if (!reg.bots.some((b) => b.appId === appId)) {
        return { ok: false, reason: `机器人「${appId}」不存在。` };
      }
      // 活跃集是多选 active 字段：基于当前激活集增/删该 bot 后整集重写（setActiveBots
      // 会给每个 bot 盖 explicit active 布尔，从此「已配置」）。
      const current = new Set(
        reg.bots.some((b) => b.active !== undefined)
          ? reg.bots.filter((b) => b.active === true).map((b) => b.appId)
          : reg.current
            ? [reg.current]
            : [],
      );
      if (enabled) current.add(appId);
      else current.delete(appId);
      await setActiveBots([...current]);
      return { ok: true };
    },

    async deleteBot(appId: string): Promise<BotMutationResult> {
      if (deps.deleteBot) return deps.deleteBot(appId);
      const reg = await loadBots();
      const target = reg.bots.find((b) => b.appId === appId);
      if (!target) return { ok: false, reason: `机器人「${appId}」不存在。` };
      // 保护①：唯一 bot 不许删（删完控制台空了、无从恢复，得引导重新 init）。
      if (reg.bots.length <= 1) {
        return { ok: false, reason: '这是当前唯一的机器人，不能删除——删完控制台就空了。先用 `bot init` 添加另一个再删。' };
      }
      // 保护②：带运行中会话（bridge 在跑 + 有话题记录）的 bot 不许删——会打断正在跑的
      // codex 会话、留下孤儿 app-server。先 `bot use` 退活跃集 + 重启让进程退出再删。
      const run = await runState(appId);
      if (run.running) {
        const sessions = await listSessionsIn(botPaths(appId).sessionsFile).catch(() => []);
        if (sessions.length > 0) {
          return {
            ok: false,
            reason: `机器人「${target.name}」正在运行且有 ${sessions.length} 个活跃会话，不能删除（会打断进行中的对话）。先在「多机器人」里关掉它并重启 daemon，等进程退出后再删。`,
          };
        }
      }
      // 注册表 + keystore 密钥 + 状态目录（projects/sessions/config），与 `bot rm` 同语义。
      await removeBot(appId);
      await removeSecret(secretKeyForApp(appId)).catch(() => undefined);
      await rm(botDir(appId), { recursive: true, force: true }).catch(() => undefined);
      return { ok: true };
    },
  };
}

/** 比较两个 x.y.z 版本：a>b →1，a<b →-1，相等→0。非法段按 0。后端「有无更新」判定用。 */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** SDK registerApp reject 的 code → 扫码失败结果（前端文案归 UI/SSE，这里给中文兜底）。 */
function mapQrFailure(code: string, description: string): QrRegisterFailure {
  switch (code) {
    case 'abort':
      return { ok: false, code: 'abort', reason: '已取消扫码。' };
    case 'expired_token':
      return { ok: false, code: 'expired_token', reason: '二维码已过期，请重新生成。' };
    case 'access_denied':
      return { ok: false, code: 'access_denied', reason: '你在飞书里取消或拒绝了创建。' };
    default:
      // 网络/TLS 抖动（SDK reject 的不是结构化码，是底层 socket/DNS/TLS 错）——别把英文原文
      // 甩给用户。常见：切 VPN/代理、断网重连、公司网拦截开放平台。统一归一成可操作的中文。
      if (isNetworkErrorText(code, description)) {
        return {
          ok: false,
          code: 'network',
          reason: '连不上飞书开放平台（网络中断或超时）。检查网络 / VPN / 代理后，点「重新生成」重试。',
        };
      }
      return { ok: false, code: 'unknown', reason: description ? `创建失败：${description}` : '创建失败，请重试。' };
  }
}

/** 识别「网络/TLS/DNS 层」失败：code 或 description 命中常见信号即算。切飞书账号本身不会触发，
 * 真因多是切 VPN/代理或网络抖动让到开放平台的 HTTPS 握手中断。 */
function isNetworkErrorText(code: string, description: string): boolean {
  const hay = `${code} ${description}`;
  return /socket disconnected|secure TLS|\bTLS\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|network socket|fetch failed|socket hang up|ECONNABORTED|EPIPE/i.test(
    hay,
  );
}

/**
 * 一条 catalog 的管理面投影：catalog 元数据 + 本机探测态。external-cli（codex）走
 * doctor 拿版本/可用；npm-ondemand / npm-external 走 isBackendDepInstalled 判装没装。
 * 绝不抛错——探测失败按「未装/未知」降级。
 */
async function catalogEntryStatus(
  entry: BackendCatalogEntry,
  defaultBackend: string,
): Promise<AdminBackendCatalogEntry> {
  const probe: BackendProbe | undefined = await createBackend(entry.id)
    .doctor({ force: true })
    .catch(() => undefined);
  const ok = probe?.ok === true;
  // depState：installed（探测通过）/ not-installed（npm-ondemand 可一键装）/
  // external-missing（external-cli / npm-external 缺失，需手动装）。优先用 doctor
  // 自报的 depState（npm-ondemand 未装时的 not-installed），否则按 ok + installable 推。
  const installable = ok ? false : isInstallable(entry);
  const depState: BackendDepState =
    probe?.depState ?? (ok ? 'installed' : installable ? 'not-installed' : 'external-missing');
  return {
    id: entry.id,
    agentFamily: entry.agentFamily,
    displayName: entry.displayName,
    access: entry.access,
    blurb: entry.blurb,
    depKind: entry.dep.kind,
    depState,
    installable: depState === 'not-installed' && isInstallable(entry),
    approxSizeMB: entry.dep.approxSizeMB,
    version: probe?.version ?? null,
    installedVersion: entry.dep.pkg ? installedBackendVersion(entry.dep.pkg) : null,
    canUninstall: isInstallable(entry) && isBackendInstalledInUserDir(entry),
    hint: ok ? undefined : (probe?.hint ?? entry.dep.detectHint),
    isDefault: entry.id === defaultBackend,
    supportedModes: entry.supportedModes,
  };
}

/** 与 DM 🧠 后端检测卡同源：按注册表动态探测全部后端，绝不硬编码列表；绝不抛错。 */
async function probeAllBackends(): Promise<AdminBackendStatus[]> {
  // 只探**用户可见**后端（visibleCatalog 过滤 hidden 闸）：与 listBackendCatalog /
  // host.doctorBackends 同口径，走 visibleCatalog 单一过滤源。
  return Promise.all(
    visibleCatalog().map((e) => e.id).map(async (id) => {
      const backend = createBackend(id);
      const probe = await backend.doctor({ force: true }).catch(() => undefined);
      return {
        id,
        name: backend.displayName,
        ok: probe?.ok === true,
        version: probe?.version ?? null,
        location: probe?.location,
        hint: probe?.ok ? undefined : (probe?.hint ?? '环境探测失败（未安装、未登录或探测超时）'),
        isDefault: id === DEFAULT_BACKEND_ID,
      };
    }),
  );
}

/** 只读预览（独立 `web` 进程，daemon 未跑）：无写执行器、状态靠锁文件探测。 */
/**
 * 只读预览用的 AdminService：项目写 / 重启 / 升级 / 后端装卸全部缺省（抛 NotWiredYetError
 * → 501）。唯一例外是 {@link AdminServiceDeps.startDaemon}——预览态下 daemon 没在跑，
 * 「启动」是预览唯一该能做的宿主级动作（detached helper 把 service 装起来，与预览进程脱钩），
 * 故允许调用方注入。其余 deps 一律不放行，保持「只读」语义。
 */
export function createReadonlyAdminService(deps: Pick<AdminServiceDeps, 'startDaemon' | 'applyUpdate'> = {}): AdminService {
  // 只读预览能做的宿主级写操作只有「启动」和「更新」（没启动只读，但这俩是为了让用户能
  // 起 / 升级 daemon）；readonlyPreview 闸挡掉扫码注册等其余写。
  return createAdminService({ startDaemon: deps.startDaemon, applyUpdate: deps.applyUpdate, readonlyPreview: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
