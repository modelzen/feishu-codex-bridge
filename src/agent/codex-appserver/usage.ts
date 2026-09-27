import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from '../../core/logger';
import type {
  AccountProfileStats,
  AccountUsageBundle,
  AccountUsageSnapshot,
  DailyBucket,
  RateBucket,
  RateWindow,
} from '../types';
import { UsageError } from '../types';
import { utilityRequest } from './client-pool';
import { resolveCodexBin } from './locate';

/**
 * Codex 账号用量数据层：限额（5h/7d 窗口）+ 个人资料统计（lifetime/streak/逐日热力图）。
 *
 * 数据通路（设计定稿，全部实测验证过）：
 *  - 两个端点都直连 ChatGPT 后端 HTTP（`GET {base}/wham/usage`、`GET {base}/wham/profiles/me`），
 *    凭据现读 `$CODEX_HOME/auth.json`（access_token 作 Bearer + account_id 作 ChatGPT-Account-Id）。
 *    这与 codex 自家 backend-client 的调用方式逐字一致（client.rs），且不依赖 codex 版本——
 *    app-server 的 `account/usage/read` 要 0.138+ 才有，HTTP 端点对所有版本的登录态都成立。
 *  - bridge **绝不**自己实现 OAuth refresh（auth.openai.com 有 refresh_token 轮换 + reuse 检测，
 *    自己刷而竞态丢失回写会把用户的 CLI 登录打坏）。需要刷新时唯一合法路径是经
 *    app-server（常驻 utility client）调 `account/read {refreshToken:true}`，让 codex 官方代码强刷并回写 auth.json
 *    （实测 0.135.0：无条件强刷、persist 正确处理轮换；失败不返回 JSON-RPC error，而是
 *    `result.account === null` 且 auth.json 不变——成败判定以 diff auth.json 为主信号）。
 */

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const HTTP_TIMEOUT_MS = 15_000;
/** account/read{refreshToken:true} 实测 init ~250ms + 刷新 ~2.3s；放宽到 20s 兜异常。 */
const REFRESH_TIMEOUT_MS = 20_000;
/** JWT exp 提前量：临期 1 分钟内视为已过期，先刷再打。 */
const EXP_SKEW_MS = 60_000;
/** profiles/me 的 stats 一天才更新一次（stats_as_of 粒度），5 分钟缓存绰绰有余。 */
const PROFILE_CACHE_MS = 5 * 60_000;
/** usage（限额）缓存 30s：防连点击穿，刷新按钮可 force 绕过。 */
const USAGE_CACHE_MS = 30_000;

// 错误模型（UsageError/UsageErrorKind）与对外数据形状（AccountUsageBundle 等）
// 已归一化上提到 ../types —— 本模块只保留 codex 专属的取数与映射实现。

// ── auth.json ─────────────────────────────────────────────────────────

export interface CodexAuth {
  accessToken: string;
  accountId?: string;
  lastRefresh?: string;
}

export function resolveCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * 现读 auth.json（绝不缓存 token——任何 codex 进程随时可能轮换它）。
 * codex 的 persist_tokens 是 truncate 原地写、**非原子**（storage.rs），并发读可能撞上
 * 半截 JSON —— parse 失败短暂重试 3 次再放弃。
 */
export async function readCodexAuth(): Promise<CodexAuth> {
  const file = join(resolveCodexHome(), 'auth.json');
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      throw new UsageError('no-auth', `读不到 ${file}：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const j = JSON.parse(raw) as {
        auth_mode?: string;
        last_refresh?: string;
        tokens?: { access_token?: string; account_id?: string };
      };
      const accessToken = j.tokens?.access_token;
      if (!accessToken) throw new UsageError('api-key-mode', 'auth.json 没有 ChatGPT access_token（API-key 登录模式）');
      return { accessToken, accountId: j.tokens?.account_id, lastRefresh: j.last_refresh };
    } catch (err) {
      if (err instanceof UsageError) throw err;
      lastErr = err; // 半截 JSON：等 codex 写完再读
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new UsageError('no-auth', `auth.json 反复解析失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 本地解 JWT 的 exp（毫秒）；解不出来返回 undefined（按未知处理，不拦请求）。 */
export function jwtExpMs(token: string): number | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ChatGPT 后端 base URL：尊重 `$CODEX_HOME/config.toml` 顶层的 `chatgpt_base_url`
 * （codex manager.rs 同款语义）。只做顶层键的朴素行匹配——第一个 `[section]` 之后不再看。
 */
export async function chatgptBaseUrl(): Promise<string> {
  try {
    const raw = await readFile(join(resolveCodexHome(), 'config.toml'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.startsWith('[')) break; // 进入 section，顶层键扫描结束
      const m = /^chatgpt_base_url\s*=\s*"([^"]+)"/.exec(t);
      if (m?.[1]) return m[1].replace(/\/+$/, '');
    }
  } catch {
    // config.toml 可缺省
  }
  return DEFAULT_BASE_URL;
}

// ── 官方刷新（经 app-server 委托给 codex） ─────────────────────────────

/** 进程内互斥：并发 401 共享同一次刷新，绝不并行强刷（双刷可能触发服务端 reuse 检测）。 */
let refreshInFlight: Promise<CodexAuth | 'permanent-failure' | null> | null = null;

/**
 * 让 codex 官方代码刷新 token：经常驻 utility client（M-2，原短命 app-server 同
 * 语义）调 `account/read {refreshToken:true}`。utilityRequest 超时/出错会丢弃并
 * SIGKILL 当前进程（出错即重建），等价旧实现 finally close() 的兜底。
 * 返回新 auth（成功 / 别的进程恰好刷好了）、'permanent-failure'（要重新 codex login）、
 * 或 null（transient：网络/服务波动，token 没变也没有永久失败信号）。
 */
async function refreshViaAppServer(): Promise<CodexAuth | 'permanent-failure' | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const before = await readCodexAuth().catch(() => undefined);
    if (!resolveCodexBin()) return null;
    let account: unknown = undefined;
    try {
      const res = await utilityRequest<{ account?: unknown }>(
        'account/read',
        { refreshToken: true },
        { timeoutMs: REFRESH_TIMEOUT_MS },
      );
      account = res?.account;
    } catch (err) {
      log.fail('usage', err, { phase: 'refresh' });
      return null;
    }
    const after = await readCodexAuth().catch(() => undefined);
    if (after && after.accessToken !== before?.accessToken) return after; // 刷成（或别人刷的，都行）
    // v0.135.0 刷新失败不抛 JSON-RPC error：permanent 失败的信号是 account===null 且 token 未变
    if (account === null) return 'permanent-failure';
    return null;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// ── HTTP（带 401 兜底链） ─────────────────────────────────────────────

interface WhamResult {
  status: number;
  /** 仅 2xx 时存在（解析后的 body） */
  json?: unknown;
}

async function fetchWham(base: string, path: string, auth: CodexAuth): Promise<WhamResult> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}${path}`, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
        'User-Agent': 'codex-cli',
      },
      signal: ctl.signal,
    });
    if (!resp.ok) return { status: resp.status };
    // body 必须在 abort 计时器的保护窗内读完——fetch 在响应头到达就 resolve，
    // 若把 json() 留到窗外，15s 超时对停滞的 body 不生效（只剩 undici ~300s 兜底，
    // loading 卡会挂死 5 分钟）。
    return { status: resp.status, json: await resp.json() };
  } finally {
    clearTimeout(t);
  }
}

/**
 * GET {base}{path}，401 兜底链（每次用户触发最多 1 次刷新 + 2 次重试，绝不循环）：
 * 请求前解 exp 临期先刷 → 401 先重读 auth.json（别的 codex 进程可能刚刷过）重试 →
 * 仍 401 经 app-server 官方刷一次 → 再 401 = 账号侧问题，提示重新登录。
 */
async function whamGet<T>(path: string): Promise<T> {
  let auth = await readCodexAuth();

  const exp = jwtExpMs(auth.accessToken);
  if (exp !== undefined && exp <= Date.now() + EXP_SKEW_MS) {
    const refreshed = await refreshViaAppServer();
    if (refreshed === 'permanent-failure') throw new UsageError('need-relogin', 'Codex 登录态已失效');
    if (refreshed) auth = refreshed;
    // null（transient）：token 已知过期，刷又没刷成 —— 不浪费请求
    else throw new UsageError('transient', '登录态临期且暂时无法刷新');
  }

  const base = await chatgptBaseUrl();
  const attempt = async (a: CodexAuth): Promise<WhamResult> => {
    try {
      return await fetchWham(base, path, a);
    } catch (err) {
      throw new UsageError('transient', `请求失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let res = await attempt(auth);
  if (res.status === 401) {
    // 第一步：现读 auth.json —— 也许别的 codex 进程已经刷好了
    const fresh = await readCodexAuth();
    if (fresh.accessToken !== auth.accessToken) {
      auth = fresh;
      res = await attempt(auth).catch(() => res); // 网络波动时保留原 401 继续走刷新
    }
  }
  if (res.status === 401) {
    // 第二步：唯一一次官方刷新
    const refreshed = await refreshViaAppServer();
    if (refreshed === 'permanent-failure' || refreshed === null) {
      throw refreshed === null
        ? new UsageError('transient', '暂时无法刷新 Codex 登录态')
        : new UsageError('need-relogin', 'Codex 登录态已失效');
    }
    res = await attempt(refreshed);
    if (res.status === 401) throw new UsageError('need-relogin', '刷新后仍 401，账号侧已拒绝');
  }

  if (res.json === undefined) throw new UsageError('transient', `HTTP ${res.status} (${path})`);
  return res.json as T;
}

// ── wham/usage（限额）──────────────────────────────────────────────────

/** wham/usage 的原始（snake_case）窗口结构。 */
interface RawWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}
interface RawRateLimit {
  primary_window?: RawWindow | null;
  secondary_window?: RawWindow | null;
}
interface RawUsageResponse {
  plan_type?: string;
  rate_limit?: RawRateLimit | null;
  additional_rate_limits?: { limit_name?: string; rate_limit?: RawRateLimit | null }[] | null;
}

function mapWindow(w: RawWindow | null | undefined): RateWindow | undefined {
  if (!w || typeof w.used_percent !== 'number') return undefined;
  return {
    usedPercent: Math.min(100, Math.max(0, w.used_percent)),
    windowSeconds: w.limit_window_seconds,
    resetAt: w.reset_at,
  };
}

export function mapUsageResponse(raw: RawUsageResponse, fetchedAt: number): AccountUsageSnapshot {
  const mapBucket = (rl: RawRateLimit | null | undefined, name?: string): RateBucket => ({
    ...(name ? { name } : {}),
    primary: mapWindow(rl?.primary_window),
    secondary: mapWindow(rl?.secondary_window),
  });
  return {
    planType: raw.plan_type,
    main: mapBucket(raw.rate_limit),
    extras: (raw.additional_rate_limits ?? [])
      .filter((x) => x?.rate_limit)
      .map((x) => mapBucket(x.rate_limit, x.limit_name)),
    fetchedAt,
  };
}

// ── wham/profiles/me（统计 + 热力图）───────────────────────────────────

interface RawProfileResponse {
  profile?: { display_name?: string; username?: string };
  stats?: {
    lifetime_tokens?: number;
    peak_daily_tokens?: number;
    current_streak_days?: number;
    longest_streak_days?: number;
    longest_running_turn_sec?: number;
    total_threads?: number;
    fast_mode_usage_percentage?: number;
    total_skills_used?: number;
    unique_skills_used?: number;
    most_used_reasoning_effort?: string;
    most_used_reasoning_effort_percentage?: number;
    top_invocations?: {
      type?: string;
      plugin_name?: string | null;
      skill_name?: string | null;
      usage_count?: number;
    }[];
    daily_usage_buckets?: { start_date?: string; tokens?: number }[];
  };
  metadata?: { stats_as_of?: string };
}

export function mapProfileResponse(raw: RawProfileResponse): AccountProfileStats {
  const s = raw.stats ?? {};
  return {
    // 只用 display_name，绝不兜底 username——后者是邮箱 local part，会随可转发的
    // 分享卡泄出去；display_name 缺失时卡片侧降级「我的」。
    displayName: raw.profile?.display_name || undefined,
    lifetimeTokens: s.lifetime_tokens,
    peakDailyTokens: s.peak_daily_tokens,
    currentStreakDays: s.current_streak_days,
    longestStreakDays: s.longest_streak_days,
    longestTurnSec: s.longest_running_turn_sec,
    totalThreads: s.total_threads,
    fastModePct: s.fast_mode_usage_percentage,
    totalSkillsUsed: s.total_skills_used,
    uniqueSkillsUsed: s.unique_skills_used,
    mostUsedEffort: s.most_used_reasoning_effort,
    mostUsedEffortPct: s.most_used_reasoning_effort_percentage,
    topInvocations: (s.top_invocations ?? [])
      .map((t) => ({
        name: t.plugin_name ?? t.skill_name ?? '',
        count: t.usage_count ?? 0,
        kind: (t.plugin_name ? 'plugin' : 'skill') as 'plugin' | 'skill',
      }))
      .filter((t) => t.name),
    dailyBuckets: (s.daily_usage_buckets ?? [])
      .filter((b): b is { start_date: string; tokens: number } => typeof b.start_date === 'string')
      .map((b) => ({ date: b.start_date, tokens: b.tokens ?? 0 })),
    statsAsOf: raw.metadata?.stats_as_of,
  };
}

// ── 拉数（带缓存）──────────────────────────────────────────────────────

let profileCache: { at: number; data: AccountProfileStats } | null = null;
let usageCache: { at: number; data: AccountUsageSnapshot } | null = null;

export async function fetchProfileStats(force = false): Promise<AccountProfileStats> {
  if (!force && profileCache && Date.now() - profileCache.at < PROFILE_CACHE_MS) return profileCache.data;
  const raw = await whamGet<RawProfileResponse>('/wham/profiles/me');
  const data = mapProfileResponse(raw);
  profileCache = { at: Date.now(), data };
  return data;
}

export async function fetchUsageSnapshot(force = false): Promise<AccountUsageSnapshot> {
  if (!force && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.data;
  const raw = await whamGet<RawUsageResponse>('/wham/usage');
  const data = mapUsageResponse(raw, Date.now());
  usageCache = { at: Date.now(), data };
  return data;
}

/** 一次拉齐两端点（并行）。任一失败抛 UsageError，调用方按 kind 渲染错误卡。 */
export async function fetchUsageBundle(force = false): Promise<AccountUsageBundle> {
  let firstFailure: { reason: unknown } | undefined;
  const trackFailure = <T>(pending: Promise<T>): Promise<T> => pending.catch((reason: unknown) => {
    firstFailure ??= { reason };
    throw reason;
  });
  const [profile, usage] = await Promise.allSettled([
    trackFailure(fetchProfileStats(force)),
    trackFailure(fetchUsageSnapshot(force)),
  ]);
  if (profile.status === 'rejected' || usage.status === 'rejected') throw firstFailure?.reason;
  return { profile: profile.value, usage: usage.value };
}
