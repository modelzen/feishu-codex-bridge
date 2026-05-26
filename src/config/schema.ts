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
 * Access control (see design §5):
 *   admins        — open_ids that may DM the bot (create project / global config /
 *                   destructive ops). Default = [owner] (seeded at onboarding).
 *   allowedUsers  — open_ids that may @bot in groups/threads. Empty = all.
 *   allowedChats  — chat_ids the bot responds in. Empty = all.
 */
export interface AppAccess {
  admins?: string[];
  allowedUsers?: string[];
  allowedChats?: string[];
}

export interface AppPreferences {
  /** reply rendering for IM messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /** render tool-call blocks in output. Default true. */
  showToolCalls?: boolean;
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

/**
 * Per-turn idle watchdog in ms. Default 120s, ON. `0` disables. Clamps to
 * [10, 1800] seconds when set.
 */
export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const raw = cfg.preferences?.runIdleTimeoutSeconds;
  if (raw === 0) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 120_000;
  const clamped = Math.min(Math.max(Math.floor(raw), 10), 1800);
  return clamped * 1000;
}

/** True when `senderId` may @bot in groups/threads. Empty list = all. */
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

/** True when `senderId` is an admin (may DM / create project / destructive). */
export function isAdmin(cfg: AppConfig, senderId: string): boolean {
  const list = cfg.preferences?.access?.admins;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}
