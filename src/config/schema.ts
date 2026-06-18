export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside config.json (keeps the App
 * Secret out of backups/git/log dumps). Mirrors lark-cli's SecretRef shape.
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  allowlist?: string[];
  path?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  passEnv?: string[];
  noOutputTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/** card: full interactive card · markdown: lightweight streaming · text: one-shot */
export type MessageReplyMode = 'card' | 'markdown' | 'text';

/** Behavior when a new message arrives mid-turn: steer(引导) or queue(排队). */
export type PendingPolicy = 'steer' | 'queue';

/**
 * 「模型显示」三档：off(关闭) · running(仅输出时，只在运行卡显示) ·
 * always(始终，运行卡 + 终态卡都保留)。控制运行卡右下角「模型 · 推理强度」脚注。
 */
export type ModelDisplayMode = 'off' | 'running' | 'always';

/**
 * Access control (see design §5):
 *   ownerOpenId   — 扫码注册者(owner)。恒为 admin、不可删；即使 admins 为空也仍是 admin。
 *   admins        — open_ids that may DM the bot (create project / global config /
 *                   destructive ops). 空 = 仅 owner。
 *   allowedUsers  — @deprecated 全局响应白名单，已由项目级 Project.allowedUsers 取代。
 *   allowedChats  — chat_ids the bot responds in. Empty = all.
 */
export interface AppAccess {
  /** 扫码注册者的 open_id；恒为 admin，不可删；admins 增删不影响它。 */
  ownerOpenId?: string;
  admins?: string[];
  /** @deprecated 已由项目级 Project.allowedUsers 取代；保留仅为兼容旧 config 解析，不再读取。 */
  allowedUsers?: string[];
  allowedChats?: string[];
}

export interface AppPreferences {
  /** reply rendering for IM messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /** render tool-call blocks in output. Default true. */
  showToolCalls?: boolean;
  /** 「模型 · 推理强度」脚注的显示档位（运行卡右下角）。off/running/always，
   * 默认 running（仅输出时显示，生成完即收起）——平时能扫一眼当前模型，又不在终态
   * 卡上长期留标签。兼容历史布尔值：true→always、false→off（见 {@link getModelDisplay}）。 */
  showModel?: ModelDisplayMode | boolean;
  /** cap concurrent codex turns across all threads. Default 10. */
  maxConcurrentRuns?: number;
  /** per-turn idle watchdog (seconds). 0 = off. Default 120 (on). */
  runIdleTimeoutSeconds?: number;
  /** new-message-mid-turn behavior. Default 'steer'. */
  pendingPolicy?: PendingPolicy;
  /** groups require @bot to respond. Default true. */
  requireMentionInGroup?: boolean;
  /** access control — see AppAccess. */
  access?: AppAccess;
  /** SIGTERM→SIGKILL grace (ms) for the app-server child. Default 5000. */
  agentStopGraceMs?: number;
  /** local Claude Code / Codex CLI bridge — see {@link CliBridgePreferences}. */
  cliBridge?: CliBridgePreferences;
}

export interface AppConfig {
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** keystore key for the bot's App Secret. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'card';
}

export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls !== false;
}

/**
 * 「模型显示」档位（默认 running／仅输出时）。兼容历史布尔值：true→always、
 * false→off。运行卡按此决定右下角「模型 · 推理强度」脚注：running 仅运行卡显示，
 * always 终态卡也保留，off 不显示。
 */
export function getModelDisplay(cfg: AppConfig): ModelDisplayMode {
  const v = cfg.preferences?.showModel;
  if (v === 'running' || v === 'always' || v === 'off') return v;
  if (v === true) return 'always';
  if (v === false) return 'off';
  return 'running';
}

export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  return Math.min(Math.floor(raw), 50);
}

export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  return cfg.preferences?.requireMentionInGroup !== false;
}

export function getPendingPolicy(cfg: AppConfig): PendingPolicy {
  return cfg.preferences?.pendingPolicy === 'queue' ? 'queue' : 'steer';
}

export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

/** Watchdog clamp bounds in seconds — shared by the read path and the settings
 * card's custom-input validation so stored value == effective value. */
export const RUN_IDLE_TIMEOUT_MIN_SEC = 10;
export const RUN_IDLE_TIMEOUT_MAX_SEC = 3600;

/**
 * Per-turn idle watchdog in ms. Default 120s, ON. `0` disables. Clamps to
 * [10, 3600] seconds when set.
 */
export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutSeconds;
  if (raw === 0) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 120_000;
  const clamped = Math.min(Math.max(Math.floor(raw), RUN_IDLE_TIMEOUT_MIN_SEC), RUN_IDLE_TIMEOUT_MAX_SEC);
  return clamped * 1000;
}

/**
 * @deprecated 全局响应白名单已由项目级 {@link isUserAllowedInProject} 取代，不再使用。
 * 保留以防外部引用；新代码请用 isUserAllowedInProject。
 */
export function isUserAllowed(cfg: AppConfig, senderId: string): boolean {
  const list = cfg.preferences?.access?.allowedUsers;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

/** True when `chatId` is one the bot responds in. Empty list = all. */
export function isChatAllowed(cfg: AppConfig, chatId: string): boolean {
  const list = cfg.preferences?.access?.allowedChats;
  if (!list || list.length === 0) return true;
  return list.includes(chatId);
}

/** The bot owner's open_id: explicit `ownerOpenId`, else the first admin (惰性
 * 兼容老 config——无 ownerOpenId 时回退首个 admin，不写盘). undefined 仅当从未注册。 */
export function resolveOwner(cfg: AppConfig): string | undefined {
  const access = cfg.preferences?.access;
  return access?.ownerOpenId ?? access?.admins?.[0];
}

/** True when `senderId` is the owner or an admin (may DM / create project /
 * destructive). Owner 恒为 admin、不受 admins 增删影响；admins 为空时仅 owner 是 admin。 */
export function isAdmin(cfg: AppConfig, senderId: string): boolean {
  if (!senderId) return false;
  if (senderId === resolveOwner(cfg)) return true;
  return Boolean(cfg.preferences?.access?.admins?.includes(senderId));
}

/** True when `senderId` may make the bot respond in a project group. admin/owner
 * 恒豁免；项目白名单空/缺省 = 所有人。project 用结构化 Pick 类型避免 schema→registry
 * 循环依赖。 */
export function isUserAllowedInProject(
  cfg: AppConfig,
  project: { allowedUsers?: string[] } | undefined,
  senderId: string,
): boolean {
  if (isAdmin(cfg, senderId)) return true;
  const list = project?.allowedUsers;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

// ── local CLI agent bridge (Claude Code / Codex) ─────────────────────────────

export type CliBridgeDelivery = 'always' | 'away_only';
/** 离开时转发哪些会话：all=全部 / bound_projects=仅 cwd 命中已绑定项目 / none=不通知。 */
export type CliBridgeNotifyScope = 'all' | 'bound_projects' | 'none';
export type CliBridgeAgentKey = 'claude' | 'codex';

/** Raw (partial) CLI bridge preferences as stored in config.json. */
export interface CliBridgePreferences {
  /** 总开关：是否把本地 CLI agent（Claude Code / Codex）的 hook 事件转发到飞书。默认 false。 */
  enabled?: boolean;
  /** 历史兼容字段；用户侧不再暴露配置，运行时固定为 away_only。 */
  delivery?: CliBridgeDelivery;
  /** 调试用：是否也转发由本 bridge 自己发起的会话（FEISHU_CODEX_BRIDGE=1）。默认 false，避免自我转发回环。 */
  includeBridgeOwnedSessionsForDebugging?: boolean;
  /** 按 agent 分别启停转发（claude / codex）。缺省时两者均为 true。 */
  agents?: Partial<Record<CliBridgeAgentKey, boolean>>;
  /** 离开时把哪些会话推到飞书：all=全部 / bound_projects=仅 cwd 命中已绑定项目的会话 / none=不通知。默认 all。 */
  notifyScope?: CliBridgeNotifyScope;
  /** 离开保活：离开且有未决交互（卡在飞书审批 / 问答 / 续聊）时，用 caffeinate 顶住系统休眠
   *  （屏幕仍可正常熄灭），回到本机 / 解锁即释放。仅 macOS 生效。 */
  keepAwake?: {
    /** 是否启用离开保活。默认 true。 */
    enabled?: boolean;
  };
  /** 权限审批（PermissionRequest）转发配置。 */
  approval?: {
    /** 是否转发权限审批请求。默认 true；为 false 时审批回落到本地终端处理。 */
    enabled?: boolean;
    /** 等待飞书审批的超时（秒），超时后回落本地。默认 86400（24 小时）。 */
    timeoutSeconds?: number;
  };
  /** 任务完成 / Stop 通知配置。 */
  taskCompletion?: {
    /** 是否转发任务完成 / Stop 通知卡。默认 true。 */
    enabled?: boolean;
    /** 是否允许在飞书回复完成卡以续聊（Stop 续聊）。默认 true。 */
    replyEnabled?: boolean;
    /** 等待续聊回复的超时（秒），其间可被本机回归打断。默认 600（10 分钟）。 */
    replyTimeoutSeconds?: number;
  };
  /** “本会话放行”（Allow this session）缓存配置。 */
  allowCache?: {
    /** 是否启用会话级放行缓存。默认 true。 */
    enabled?: boolean;
    /** 缓存粒度，目前仅支持 'session'（整个会话）。 */
    scope?: 'session';
  };
  /** 本机在场检测，用于 away_only 模式判定是否“离开”。 */
  presence?: {
    /** 是否启用在场检测。默认 true；为 false 时 away_only 下不转发。 */
    enabled?: boolean;
    /** 检测平台：'auto' 自动 / 'macos' 强制走 macOS（ioreg HIDIdleTime）。默认 auto。 */
    platform?: 'auto' | 'macos';
    /** 判定“离开”的空闲阈值（秒）：空闲超过该值视为离开。默认 120。 */
    idleThresholdSeconds?: number;
  };
}

/** Fully-resolved CLI bridge preferences (every field present, normalized). */
export interface ResolvedCliBridgePreferences {
  enabled: boolean;
  delivery: CliBridgeDelivery;
  includeBridgeOwnedSessionsForDebugging: boolean;
  agents: Record<CliBridgeAgentKey, boolean>;
  notifyScope: CliBridgeNotifyScope;
  keepAwake: {
    enabled: boolean;
  };
  approval: {
    enabled: boolean;
    timeoutSeconds: number;
  };
  taskCompletion: {
    enabled: boolean;
    replyEnabled: boolean;
    replyTimeoutSeconds: number;
  };
  allowCache: {
    enabled: boolean;
    scope: 'session';
  };
  presence: {
    enabled: boolean;
    platform: 'auto' | 'macos';
    idleThresholdSeconds: number;
  };
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function secondsOr(value: unknown, fallback: number, min: number, max: number): number {
  // 0/负数是无效配置 → 回落默认值;正数但越界才 clamp 到 [min,max]。
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Normalize stored CLI bridge prefs into a fully-resolved, safe-defaulted shape. */
export function getCliBridgePreferences(cfg: AppConfig): ResolvedCliBridgePreferences {
  const raw = cfg.preferences?.cliBridge;
  return {
    enabled: boolOr(raw?.enabled, false),
    delivery: 'away_only',
    includeBridgeOwnedSessionsForDebugging: boolOr(raw?.includeBridgeOwnedSessionsForDebugging, false),
    agents: {
      claude: boolOr(raw?.agents?.claude, true),
      codex: boolOr(raw?.agents?.codex, true),
    },
    notifyScope: raw?.notifyScope === 'bound_projects' || raw?.notifyScope === 'none' ? raw.notifyScope : 'all',
    keepAwake: {
      enabled: boolOr(raw?.keepAwake?.enabled, true),
    },
    approval: {
      enabled: boolOr(raw?.approval?.enabled, true),
      timeoutSeconds: secondsOr(raw?.approval?.timeoutSeconds, 86400, 1, 86400),
    },
    taskCompletion: {
      enabled: boolOr(raw?.taskCompletion?.enabled, true),
      replyEnabled: boolOr(raw?.taskCompletion?.replyEnabled, true),
      replyTimeoutSeconds: secondsOr(raw?.taskCompletion?.replyTimeoutSeconds, 600, 1, 86400),
    },
    allowCache: {
      enabled: boolOr(raw?.allowCache?.enabled, true),
      scope: 'session',
    },
    presence: {
      enabled: boolOr(raw?.presence?.enabled, true),
      platform: raw?.presence?.platform === 'macos' ? 'macos' : 'auto',
      idleThresholdSeconds: secondsOr(raw?.presence?.idleThresholdSeconds, 120, 10, 3600),
    },
  };
}

/** The owner DM target for local CLI notifications, or undefined if no owner. */
export function resolveCliBridgeTarget(
  cfg: AppConfig,
): { receiveIdType: 'open_id'; receiveId: string } | undefined {
  const owner = resolveOwner(cfg);
  return owner ? { receiveIdType: 'open_id', receiveId: owner } : undefined;
}

/** Whether the CLI bridge master switch can be enabled (needs a bot owner). */
export function canEnableCliBridge(cfg: AppConfig): { ok: true } | { ok: false; reason: 'missing_owner' } {
  return resolveCliBridgeTarget(cfg) ? { ok: true } : { ok: false, reason: 'missing_owner' };
}
