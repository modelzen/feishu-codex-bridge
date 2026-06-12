import type {
  BotAddedEvent,
  CardActionEvent,
  CommentEvent,
  LarkChannel,
  NormalizedMessage,
  ReactionEvent,
} from '@larksuiteoapi/node-sdk';
import { DEFAULT_BACKEND_ID, backendIds, createBackend, isBackendEntryInstalled } from '../agent';
import { catalogById, projectCreatableBackends, visibleCatalog } from '../agent/catalog';
import type { AgentBackend, AgentInput, AgentRun, AgentThread, ModelInfo, PermissionMode, ReasoningEffort } from '../agent/types';
import type { SelectOption } from '../card/cards';
import {
  createAdminWriteExecutor,
  performBackendSwitch,
  performSetAutoCompact,
  performSetNoMention,
  performSetPermissionMode,
  probeBackends,
  type AdminWriteOp,
} from '../admin/ops';
import { isGoalTerminal, UsageError } from '../agent/types';
import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getModelDisplay,
  getRunIdleTimeoutMs,
  getShowToolCalls,
  isAdmin,
  isChatAllowed,
  isUserAllowedInProject,
  resolveOwner,
  RUN_IDLE_TIMEOUT_MAX_SEC,
  RUN_IDLE_TIMEOUT_MIN_SEC,
  secretKeyForApp,
  canEnableCliBridge,
  getCliBridgePreferences,
  type AppAccess,
  type AppConfig,
  type AppPreferences,
  type PendingPolicy,
} from '../config/schema';
import { saveConfig } from '../config/store';
import { CardDispatcher } from '../card/dispatcher';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { RunRender } from '../card/run-render';
import { finalMessageText, initialState, reduce, type RunState } from '../card/run-state';
import {
  buildHelpCard,
  buildModelCard,
  buildResumeCard,
  buildResumeDoneCard,
  buildResumeErrorCard,
  buildResumeLaunchingCard,
  MC,
  RES,
  type HelpScope,
  type ModelCardState,
  type ResumeCardState,
} from '../card/command-cards';
import { buildHistoryCard, type HistoryCardState } from '../card/history-card';
import {
  ANSWER_EID,
  buildQueuedCard,
  buildRunCard,
  buildRunCardPlain,
  CONTROLS_EID,
  RC,
  type RunCardState,
} from '../card/run-card';
import { buildGoalDoneCard } from '../card/goal-card';
import { RunCardStream } from '../card/run-card-stream';
import { buildCleanCard, extractCardFences } from '../card/markdown-render';
import { imageSources, uploadOutboundImages } from '../card/outbound-images';
import {
  buildAutoCompactCard,
  buildCompactFailedCard,
  buildCompactedCard,
  buildCompactingCard,
  buildContextCard,
} from '../card/context-gauge';
import { log, withTrace } from '../core/logger';
import {
  buildAddAdminCard,
  buildAddAllowedCard,
  buildAdminsCard,
  buildAllowlistCard,
  buildDmMenuCard,
  buildDoctorCard,
  buildGroupSettingsCard,
  buildJoinGroupFormCard,
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildPermissionCard,
  buildProjectListCard,
  buildProjectTopicsCard,
  buildProjectSettingsCard,
  buildReconnectCard,
  buildRmConfirmCard,
  buildSettingsCard,
  buildUpdateCard,
  buildWatchdogCustomCard,
  DM,
  GS,
  type BackendProbeRow,
  type DoctorInfo,
} from '../card/dm-cards';
import { cliBridgeSettingsSection, CLI } from '../cli-bridge/cards';
import { inspectCliBridgeHooks, installCliBridgeHooks, resolveBridgeHookCommand } from '../cli-bridge/hooks';
import type { CliBridgeRuntimeHooks } from '../cli-bridge/service';
export type { CliBridgeRuntimeHooks };
import {
  currentVersion,
  daemonRunning,
  installLatest,
  isDevSource,
  isNewer,
  latestVersion,
  restartDaemon,
} from '../service/update';
import { fetchUsageBundle } from '../agent/usage';
import {
  buildShareConfigCard,
  buildUsageCard,
  buildUsageShareCard,
  parseShareSections,
  type UsageCardState,
} from '../card/usage-cards';
import { serviceStdoutPath, serviceStderrPath } from '../service/common';
import { bridgeVersion } from '../core/version';
import { webConsoleUrl } from '../web/discovery';
import { paths } from '../config/paths';
import { getSecret } from '../config/keystore';
import { buildScopeGrantUrl, JOIN_GROUP_SCOPES } from '../config/scopes';
import { validateAppCredentials } from '../utils/feishu-auth';
import {
  defaultNoMention,
  getProjectByChatId,
  getProjectByName,
  listProjects,
  removeProject,
  turnTier,
  updateProject,
  type Project,
} from '../project/registry';
import { createProject, joinExistingGroup } from '../project/lifecycle';
import { refreshBranch } from '../project/announcement';
import { leaveChat, transferOwnership } from '../project/group-ops';
import { getSession, listSessions, patchSession, upsertSession, type SessionRecord } from './session-store';
import { handleDmConsole } from './dm-console';
import {
  collectInboundFiles,
  collectInboundImages,
  messageHasFiles,
  messageHasImages,
  stripFileTokens,
  weaveFileManifest,
} from './media';
import {
  fetchQuotedMessage,
  fetchThreadContext,
  filterHistorySince,
  weaveQuote,
  weaveSender,
  weaveThreadHistory,
  type ContextMessage,
} from './context-weave';
import {
  addCommentReaction,
  buildCommentPrompt,
  postCommentReply,
  removeCommentReaction,
  REPLY_MAX_CHARS,
  resolveComment,
  stripMarkdown,
  SUPPORTED_FILE_TYPES,
} from './comments';
import { createGracefulInterrupt, Semaphore, withIdleTimeout } from './watchdog';

/**
 * open_id → 姓名 的批量解析（管理员 / 白名单卡展示用）。需 contact:user.base:readonly
 * scope；无 scope / 调用失败则返回空 Map，卡片降级显示 open_id 尾段（见 memberName）。
 */
async function resolveNames(channel: LarkChannel, ids: (string | undefined)[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, string>();
  if (uniq.length === 0) return out;
  try {
    const r = await channel.rawClient.contact.v3.user.batch({
      params: { user_ids: uniq, user_id_type: 'open_id' },
    });
    for (const it of r.data?.items ?? []) {
      if (it.open_id && it.name) out.set(it.open_id, it.name);
    }
  } catch (err) {
    log.info('console', 'resolve-names-fail', { n: uniq.length, err: String(err) });
  }
  return out;
}

/** 拉群成员（open_id + 姓名）。该接口**不返回机器人成员**（天然排除 bot），也能拿到
 * 外部租户成员（不受通讯录可见范围限制）。失败 / 无权限返回空数组（调用方降级到手填
 * open_id）。仅取首页（page_size 100），大群配合手填。 */
async function fetchChatMembers(channel: LarkChannel, chatId: string): Promise<{ openId: string; name: string }[]> {
  try {
    const r = await channel.rawClient.im.v1.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100 },
    });
    const out: { openId: string; name: string }[] = [];
    for (const it of r.data?.items ?? []) {
      if (it.member_id) out.push({ openId: it.member_id, name: it.name || `…${it.member_id.slice(-6)}` });
    }
    return out;
  } catch (err) {
    log.info('console', 'fetch-members-fail', { chatId: chatId.slice(-6), err: String(err) });
    return [];
  }
}

/** 所有项目群成员的并集（去重）—— admins 加人的候选源（admins 通常是项目相关的人）。
 * 逐群调 fetchChatMembers，失败的群跳过；不含 bot/应用（接口保证）。 */
async function fetchAllProjectMembers(channel: LarkChannel): Promise<{ openId: string; name: string }[]> {
  const projects = await listProjects();
  // 并发拉各项目群成员（原串行 for-await 在项目多时单次渲染放大成 O(N) 串行调用）。
  const lists = await Promise.all(projects.filter((p) => p.chatId).map((p) => fetchChatMembers(channel, p.chatId)));
  const seen = new Map<string, string>();
  for (const members of lists) {
    for (const m of members) if (!seen.has(m.openId)) seen.set(m.openId, m.name);
  }
  return [...seen].map(([openId, name]) => ({ openId, name }));
}

/**
 * 从 select_person 的提交值（form_value['pick']）里取出 open_id。单选格式飞书未在
 * 类型中声明（可能是字符串 / 数组 / {open_id|id|value}），故 best-effort 兼容多形态，
 * 取第一个 ou_ 开头的 id；取不到时返回 undefined（回调据此跳过写入）。
 */
function pickOpenId(formValue: Record<string, unknown> | undefined): string | undefined {
  const raw = formValue?.pick;
  const cands: unknown[] = Array.isArray(raw) ? raw : [raw];
  for (const c of cands) {
    if (typeof c === 'string' && c.startsWith('ou_')) return c;
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      for (const v of [o.open_id, o.id, o.value]) if (typeof v === 'string' && v.startsWith('ou_')) return v;
    }
  }
  return undefined;
}

/** Read a selectMenu's submitted value (form_value[name]) — best-effort across
 * string / array / {value} shapes, mirroring {@link pickOpenId}. */
function selectValue(formValue: Record<string, unknown> | undefined, name: string): string | undefined {
  const c = (() => {
    const raw = formValue?.[name];
    return Array.isArray(raw) ? raw[0] : raw;
  })();
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    for (const v of [o.value, o.id]) if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Narrow an arbitrary string to a PermissionMode, else undefined. */
function asTier(v: string | undefined): PermissionMode | undefined {
  return v === 'qa' || v === 'write' || v === 'full' ? v : undefined;
}

/**
 * 新建/绑定项目卡的后端下拉选项：列出该权限档兼容的**全部**（非隐藏）后端——已下载的
 * 正常显示；**未下载的（如 Claude）也列出并标注「未下载·去控制台下载」**，让用户知道它
 * 存在、并去 Web「后端 Agent」页下载（Feishu 下拉无法对单项置灰，故用标注 + 提交时
 * {@link assertBackendUsable} 友好拦截，等价于「置灰 + 提示」）。新建默认档 'full'、绑定
 * 外部群默认档 'qa'，按 supportedModes 过滤（claude 仅 full，qa 下自然只剩 codex）。
 */
function backendOptionsFor(mode: PermissionMode): SelectOption[] {
  const opts: SelectOption[] = visibleCatalog()
    .filter((e) => !e.supportedModes || e.supportedModes.includes(mode))
    .map((e) => {
      const installed = e.id === DEFAULT_BACKEND_ID || isBackendEntryInstalled(e);
      return { label: installed ? e.displayName : `${e.displayName}（未下载·去控制台下载）`, value: e.id };
    });
  // 只剩默认 codex（无真实选择）时不渲染后端区，卡片回到「无后端概念」形态。
  return opts.length > 1 ? opts : [];
}

/**
 * 绑定『已有群』时该项目落哪个权限档。joined 群默认只读 qa（外部群安全考量）——但
 * claude 系后端仅支持 full，若用户在绑定卡里显式选了它，就以它支持的档（full）绑定，
 * 否则 joinExistingGroup 的 assertBackendUsable 会当场拒绝「不支持该档」。codex / 未选
 * → undefined → 沿用 joinExistingGroup 的 qa 默认（外部群仍只读，安全不变）。
 */
export function bindModeFor(backend?: string): PermissionMode | undefined {
  const modes = backend ? catalogById(backend)?.supportedModes : undefined;
  if (modes && !modes.includes('qa')) return modes.includes('full') ? 'full' : modes[0];
  return undefined;
}
/** 把卡片提交的 backend 收成安全值：必须是注册表里的 id，否则丢弃（落回默认 codex），防伪造。 */
export function safeBackendId(formValue: Record<string, unknown> | undefined): string | undefined {
  const v = selectValue(formValue, 'backend');
  return v && backendIds().includes(v) ? v : undefined;
}

// 后端切换校验 + 探测已抽到管理面共享层（admin/ops.ts）——DM 回调与 Web 控制台
// 写同一套逻辑的单一事实源。原处 re-export 保持既有 import 路径（含测试）不变。
export { BACKEND_PROBE_TIMEOUT_MS, probeBackends, validateBackendSwitch } from '../admin/ops';

interface ActiveState {
  /** unset only during the brief "reserved, still resolving the thread" window */
  thread?: AgentThread;
  run?: AgentRun;
  /** follow-up turns queued mid-run; each carries its own text + downloaded images */
  queue: AgentInput[];
  /** who started this run — gates destructive ⏹ (design §5) */
  requesterOpenId?: string;
  /** ⏹ 终止: interrupt the in-flight codex turn. Set per-turn while a run is in
   * flight. codex 0.139+ 在 turn/interrupt 后以 turn/completed(status:
   * "interrupted") 干净收尾（08b 探针实测；旧版「no mappable terminal」行为已
   * 证伪），所以正常路径发 interrupt 后等事件流自然 done、线程与进程留用；只有
   * turnId 未到手或 5s 没收尾才强停本地循环 + 杀进程（createGracefulInterrupt）。
   * For a goal run this instead clears the goal first (so it won't reactivate on
   * resume)、按既有设计每轮回收进程, and suppresses the goal summary card. */
  interrupt?: () => void;
  /** 🎯 结束目标 (goal runs only): clear the goal so codex stops auto-continuing,
   * but let the in-flight turn finish streaming; the loop then ends after that
   * turn's `done` (or immediately if no turn is in flight). No summary card. */
  endGoal?: () => void;
  /** goal run (launchGoalRun): turns are auto-continued by codex and the queue
   * is never consumed — incoming messages get a prompt instead of queueing
   * (they'd be dropped silently at the end otherwise). */
  isGoal?: boolean;
}

/** Message-reaction lifecycle controller (see {@link runReaction}). */
interface RunReaction {
  /** the run acquired a concurrency slot and is now running → Typing */
  started: () => void;
  /** the run ended (complete / ⏹ / timeout / error) → DONE */
  done: () => void;
}

export interface Orchestrator {
  onMessage: (msg: NormalizedMessage) => Promise<void>;
  /** `comment` event handler: @bot in a cloud-doc comment → reply in-thread. */
  onComment: (evt: CommentEvent) => Promise<void>;
  /** `botAdded` event: a human added the bot to a group → DM the (admin) adder
   * a bind card to register it as a `joined` project. */
  onBotAddedToChat: (evt: BotAddedEvent) => Promise<void>;
  /** bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher) → auto-unbind the bound project, if any. */
  onBotRemovedFromChat: (chatId: string) => Promise<void>;
  /** `reaction` event (im.message.reaction.created_v1)：终态 run 卡 👍 = 续轮，
   * 运行中 run/排队卡 OK/DONE = ⏹ 终止（M-6 零打字驱动）。 */
  onReaction: (evt: ReactionEvent) => Promise<void>;
  /** application.bot.menu_v6（raw-tap）：bot 单聊菜单点击 → DM 管理台菜单卡。 */
  onBotMenu: (evt: { openId?: string; eventKey?: string; eventId?: string }) => Promise<void>;
  dispatcher: CardDispatcher;
  /** 进程内管理写面（Web 控制台 / supervisor IPC 共用）：四个写操作走与 DM
   * 卡片回调完全同一套共享函数（admin/ops.ts），含同样的校验与活跃会话驱逐；
   * 校验拒绝抛 AdminWriteError（HTTP 409 / IPC code 还原）。 */
  adminExecute: (op: AdminWriteOp) => Promise<void>;
  /** Close every live codex session (SIGKILLs the app-server children) so a
   *  graceful exit leaves no orphan processes. */
  shutdown: () => Promise<void>;
}

/**
 * The group orchestrator owns all per-bridge run state (codex threads, active
 * turns, concurrency, pending command cards) and exposes both the inbound
 * message handler and the card-action dispatcher so they share that state.
 *
 * Flow (design §3):
 *   p2p                       → DM console (never runs codex).
 *   group @bot, no thread     → reply_in_thread creates the topic → run codex
 *                               (default model/effort; tune later with /model).
 *   group @bot /resume        → history picker → resume a codex thread in a new topic.
 *   group @bot, inside thread → a turn in that session (steer/queue mid-turn);
 *                               /model opens the model/effort picker for it.
 *
 * Group kinds (project.kind): 'multi' (default) = a topic per session, keyed by
 * threadId (the flow above); 'single' = the whole group is one session keyed by
 * chatId, replies quote the message (no topic, runs serialize). 免@ (noMention,
 * default on) lets non-@ messages run too — multi only inside a topic, single
 * whole-group (needs the im:message.group_msg scope). @bot /settings toggles it.
 */

/**
 * Detect a `/goal` trigger ANYWHERE in the message (not just a leading command):
 * a standalone, whitespace-delimited `/goal` token. Returns the objective — the
 * message with the token stripped and whitespace collapsed — or null if there's
 * no token or nothing left after it. The token must be whitespace-bounded so
 * paths and URLs containing `/goal` (e.g. `src/goal/x.ts`, `cmd/goal/main.go`,
 * `https://x/goal`) never trigger. No /goal pause|resume|clear|status slash
 * subcommands — manual control is via the run card's ⏹ 终止 / 🎯 结束目标 buttons.
 */
export function parseGoalTrigger(text: string): string | null {
  if (!/(^|\s)\/goal(?=\s|$)/i.test(text)) return null;
  const objective = text
    .replace(/(^|\s)\/goal(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return objective.length > 0 ? objective : null;
}

// ── M-6 Reaction 入站：零打字驱动 ────────────────────────────────────
/** 运行中卡片上「⏹ 类」表情 → 终止。飞书 reaction 面板没有 ⏹，取语义最近的
 * OK（👌「到此为止」，synthesis 验收用例）与 DONE（✅）。 */
export const STOP_EMOJIS: ReadonlySet<string> = new Set(['OK', 'DONE']);
/** 终态卡片上 👍 → 续轮（等价于在话题里发一句「继续」）。 */
export const CONTINUE_EMOJIS: ReadonlySet<string> = new Set(['THUMBSUP']);
export type ReactionIntent = 'stop' | 'continue';

/**
 * Reaction → 意图的纯决策（exported for tests）：运行中的 run/排队卡只认
 * STOP_EMOJIS（👍 在运行中无意义，忽略）；终态卡只认 CONTINUE_EMOJIS（终态卡
 * 没有可终止的东西）。其余 emoji 一律 null —— 群友的日常表情不该有副作用。
 */
export function classifyReaction(emojiType: string, running: boolean): ReactionIntent | null {
  if (running) return STOP_EMOJIS.has(emojiType) ? 'stop' : null;
  return CONTINUE_EMOJIS.has(emojiType) ? 'continue' : null;
}

/**
 * 入站事件去重（飞书事件 at-least-once：WS 重连窗口会重推同一事件）。卡片回调
 * SDK 自带 12h 去重，消息/评论侧没有 —— 重推的指令会排队后双跑 codex（写盘类
 * 指令二次执行）。Map 的插入序即 LRU 序：TTL 内命中视为重复；超容量剔除最旧。
 */
export class RecentIdCache {
  private readonly entries = new Map<string, number>();
  constructor(
    private readonly maxEntries = 2048,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  /** Record `id`; true ⇔ already seen within the TTL (i.e. a duplicate). */
  seen(id: string): boolean {
    const now = Date.now();
    const at = this.entries.get(id);
    if (at !== undefined && now - at < this.ttlMs) return true;
    this.entries.delete(id); // re-insert so the Map's order stays oldest-first
    this.entries.set(id, now);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return false;
  }
}

/**
 * card_id of a CardKit-entity message (a run card's carrier message body is
 * `{"type":"card","data":{"card_id":…}}`), or undefined for any other shape.
 * Used to heal a post-restart orphan run card whose in-process entity mapping
 * is gone (M-4 ⏹ 静默失败反馈).
 */
export function cardIdFromMessageContent(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { type?: string; data?: { card_id?: string } };
    return parsed?.type === 'card' && typeof parsed.data?.card_id === 'string' ? parsed.data.card_id : undefined;
  } catch {
    return undefined;
  }
}

// ── M-3 空闲进程 reaper 参数 ─────────────────────────────────────────
/** 超过这个时长没有任何轮次的 LIVE 会话进程被回收（close + 驱逐缓存）。持久化
 * 记录保留，下一条消息经 resolveThread 的 resume 兜底自愈（~250ms–1.6s），对话
 * 无感衔接。synthesis 给的区间 30–60min，取中值。 */
const SESSION_REAP_IDLE_MS = 45 * 60_000;
/** reaper 清扫周期。 */
const SESSION_REAP_SWEEP_MS = 5 * 60_000;

/**
 * M-3 空闲进程 reaper 的纯决策：从 LIVE 会话 key 里挑出可回收的 —— 跳过 busy
 * 的（运行/排队中的 active、评论串行链的 docLocks）与最近 idleMs 内有过轮次
 * （touchedAt 打点）的；没有打点的 key 不回收（调用方先补记，下一轮再评估）。
 */
export function pickIdleSessions(
  keys: Iterable<string>,
  touchedAt: ReadonlyMap<string, number>,
  isBusy: (key: string) => boolean,
  idleMs: number,
  now: number,
): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (isBusy(key)) continue;
    const at = touchedAt.get(key);
    if (at === undefined || now - at < idleMs) continue;
    out.push(key);
  }
  return out;
}

export function createOrchestrator(
  channel: LarkChannel,
  cfg: AppConfig,
  fallbackCwd: string,
  cliBridge?: CliBridgeRuntimeHooks,
): Orchestrator {
  /** Lazily-constructed backends by id — one instance per backend for the whole
   * bridge (mirrors the old single-instance shape; codex stays the default). */
  const backends = new Map<string, AgentBackend>();
  function backendFor(id?: string): AgentBackend {
    // 指向已移除后端（如历史 claude-*）的旧项目配置回退到默认 codex，避免 createBackend
    // 抛「未知后端」让该群消息处理崩。
    const key = id && catalogById(id) ? id : DEFAULT_BACKEND_ID;
    let be = backends.get(key);
    if (!be) {
      be = createBackend(key);
      backends.set(key, be);
    }
    return be;
  }

  /** 会话后端是否支持 `/goal` 自治目标（codex caps undefined ⇒ true）。 */
  function goalCapable(project?: Project): boolean {
    return backendFor(project?.backend).capabilities?.goal ?? true;
  }

  /** 后端不支持 `/goal` 时的统一回执。关键：在「加 OKR reaction / 起 reserved run」之前
   * 拦截 —— 否则会先贴上 🎯OKR 受理回执、再被能力守卫拒绝，留下一个自相矛盾的假信号
   * （e2e 实测发现）。引导用户直接派活即可。 */
  async function denyGoal(msg: NormalizedMessage, inThread: boolean): Promise<void> {
    await channel
      .send(
        msg.chatId,
        { markdown: '当前后端不支持 `/goal` 自治目标。直接 @我描述任务即可。' },
        { replyTo: msg.messageId, replyInThread: inThread },
      )
      .catch(() => undefined);
  }
  /** The default backend (codex app-server). Call sites that aren't project-
   * routed yet (status card, /usage, models prewarm, resume-picker pick) keep
   * using it directly — identical to the pre-registry behavior. */
  const backend = backendFor();
  /** 后端 id → 展示名（项目设置卡）。手编 projects.json 写了未知 id 时原样显示。 */
  const backendDisplayName = (id?: string): string => {
    try {
      return backendFor(id).displayName;
    } catch {
      return id ?? DEFAULT_BACKEND_ID;
    }
  };
  const sessions = new Map<string, AgentThread>();
  /** M-3 空闲 reaper 的轮次时钟：每次进 LIVE 缓存（trackSession）/ 每轮收尾
   * （touchSession）打点；空闲时长 = now − 最后打点。 */
  const sessionTouchedAt = new Map<string, number>();
  /** sessions.set + 打点 —— 所有放进 LIVE 缓存的会话一律走这里。 */
  function trackSession(key: string, thread: AgentThread): void {
    sessions.set(key, thread);
    sessionTouchedAt.set(key, Date.now());
  }
  /** 轮次收尾打点：刷新会话的空闲时钟（不在 LIVE 缓存则忽略）。 */
  function touchSession(key: string): void {
    if (sessions.has(key)) sessionTouchedAt.set(key, Date.now());
  }
  const active = new Map<string, ActiveState>();
  /** Per-doc serialization for comment runs (see {@link withDocLock}). */
  const docLocks = new Map<string, Promise<void>>();
  const sema = new Semaphore(getMaxConcurrentRuns(cfg));
  // Read live per run (not frozen at startup) so the settings card's change to
  // the idle timeout applies immediately to every group/thread — no daemon
  // restart. `cfg` is the same object `applyPref` mutates, so this sees edits.
  const currentIdleMs = (): number => getRunIdleTimeoutMs(cfg) ?? 0;
  // pendingPolicy is read per-message (settings card can change it live)
  /** pending /resume cards, keyed by the card's messageId */
  const resumePending = new Map<string, ResumeCardState>();
  /** pending /model cards, keyed by the card's messageId */
  const modelPending = new Map<string, ModelCardState>();
  /** active runs indexed by their run card's messageId (for ⏹ 中止) */
  const runsByCard = new Map<string, ActiveState>();
  /** latest run-card state by messageId (to demote a previous turn's card) */
  const runCards = new Map<string, RunCardState>();
  /** CardKit entity backing each run card, by messageId — drives the native
   * typewriter stream and whole-card (button/settings) updates. */
  const runStreams = new Map<string, RunCardStream>();
  /** the latest settings-bearing run card per topic thread */
  const lastRunCard = new Map<string, string>();
  /** latest context usage per session (sessionKey → tokens), for `/context`.
   * Fed from context_usage events in the run loop; keyed like topicThreadId. */
  const lastUsage = new Map<string, { used: number; window: number | null }>();
  /** inbound message/comment dedup (at-least-once delivery, see RecentIdCache) */
  const seenInbound = new RecentIdCache();

  /** 模型列表直通后端：两个后端内部都已缓存成功结果（codex 的 modelCache、
   * claude 的静态常量），这层不再缓存——codex 瞬时不可用时返回的 STATIC_MODELS
   * 兜底一旦缓存在这层，会被钉死整个 daemon 生命周期（backend 故意不缓存失败
   * 结果，让下次调用重试；见 codex-appserver/backend.listModels）。 */
  const listModels = (be: AgentBackend = backend): Promise<ModelInfo[]> => be.listModels();

  function pickDefault(models: ModelInfo[]): { model: string; effort: ReasoningEffort } {
    const def = models.find((m) => m.isDefault && !m.hidden) ?? models.find((m) => !m.hidden) ?? models[0];
    return { model: def?.id ?? 'gpt-5.5', effort: def?.defaultEffort ?? 'medium' };
  }

  // Feishu gives bots no way to mark a message "已读" (read receipts are a
  // human-client signal), so a reaction stands in for one. Best-effort — a
  // missing im:message.reactions:write_only scope just means no reaction appears.
  async function addReaction(messageId: string, emoji: string): Promise<string | undefined> {
    try {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      return (r as { data?: { reaction_id?: string } }).data?.reaction_id;
    } catch (err) {
      log.fail('card', err, { phase: 'reaction-add', emoji });
      return undefined;
    }
  }
  function removeReaction(messageId: string, reactionId: string): void {
    void channel.rawClient.im.v1.messageReaction
      .delete({ path: { message_id: messageId, reaction_id: reactionId } })
      .catch((err) => log.fail('card', err, { phase: 'reaction-del' }));
  }

  /**
   * Reaction lifecycle on the triggering message: ⏳ OneSecond while the run
   * waits for a free concurrency slot, 🫳 Typing while it's actually running,
   * then the emoji is removed entirely when it ends (complete / ⏹ 终止 /
   * timeout / error) — no "done" emoji. Transitions are serialized through
   * `chain` so each step removes the prior emoji first.
   */
  function runReaction(messageId: string, queued: boolean): RunReaction {
    let chain: Promise<string | undefined> = addReaction(messageId, queued ? 'OneSecond' : 'Typing');
    let phase = queued ? 0 : 1; // 0 = waiting(OneSecond), 1 = running(Typing), 2 = done(cleared)
    const swap = (emoji: string): void => {
      chain = chain.then(async (prevId) => {
        if (prevId) removeReaction(messageId, prevId);
        return addReaction(messageId, emoji);
      });
    };
    return {
      started: () => {
        if (phase < 1) {
          phase = 1;
          swap('Typing');
        }
      },
      done: () => {
        if (phase < 2) {
          phase = 2;
          chain = chain.then((prevId) => {
            if (prevId) removeReaction(messageId, prevId);
            return undefined;
          });
        }
      },
    };
  }

  // ── inbound messages ──────────────────────────────────────────────
  const onMessage = async (msg: NormalizedMessage): Promise<void> => {
    if (seenInbound.seen(msg.messageId)) {
      log.info('intake', 'reject', { reason: 'duplicate', msgId: msg.messageId });
      return;
    }
    log.info('intake', 'recv', {
      chatType: msg.chatType,
      mentionedBot: msg.mentionedBot,
      threadId: msg.threadId ?? null,
      preview: msg.content.slice(0, 40),
    });

    if (msg.chatType === 'p2p') {
      // 本地 CLI Stop 续聊：owner 在私聊里回复任务完成卡 → 把文本喂回本地 agent。
      // 必须抢在 handleDmConsole（任意 p2p 消息都会弹菜单卡）之前；命中即不再下传。
      if (cliBridge?.onMessage({
        parentId: msg.replyToMessageId,
        rootId: msg.threadId,
        text: msg.content,
      })) {
        return;
      }
      await handleDmConsole(channel, cfg, msg);
      return;
    }

    const project = await getProjectByChatId(msg.chatId);
    // @门：没 @ 时只在「项目群 + 免@ 适用」才响应。免@默认开,但 multi 仅话题内、
    // single 整群;非项目群一律不响应非 @ 消息。
    if (!msg.mentionedBot && !(project && shouldRespondWithoutMention(project, msg))) return;
    if (!isChatAllowed(cfg, msg.chatId) || !isUserAllowedInProject(cfg, project, msg.senderId)) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      return;
    }

    // The bot is in a group not bound to any project (e.g. it was just added and
    // the admin hasn't finished binding in DM yet). Don't run codex in the
    // fallback cwd for an unbound group — only nudge toward binding when @ed.
    if (!project) {
      log.info('intake', 'unbound-group', { chatId: msg.chatId.slice(-6), atBot: msg.mentionedBot });
      if (msg.mentionedBot) {
        await channel
          .send(
            msg.chatId,
            { markdown: '本群还没绑定为项目。请**把我拉进群的管理员**在与我的私聊里完成绑定后再 @我。' },
            { replyTo: msg.messageId },
          )
          .catch(() => undefined);
      }
      return;
    }

    const text = msg.content.trim();
    const cmd = parseCommand(text);
    // `/goal <objective>` anywhere in the message → a persistent autonomous goal
    // run (OKR reaction as the receipt, streaming cards, then a terminal card).
    // Explicit slash COMMANDS above still take priority (clear, leading intent).
    const goalObjective = parseGoalTrigger(text);

    // Single-session group: the whole group is one session keyed by chatId. No
    // topics — reply by quoting (引用回复); runs serialize per chatId (active[chatId]).
    // Commands: /settings (群设置) + /model. /resume has no topic list here.
    if ((project?.kind ?? 'multi') === 'single') {
      if (cmd === 'help') {
        await postHelpCard(msg, 'single', false, project);
        return;
      }
      if (cmd === 'settings') {
        await postGroupSettings(msg, project);
        return;
      }
      const ts = turnSession(msg.chatId, project, msg.senderId);
      if (cmd === 'model') {
        postModelCard(msg, ts.sessionKey, false); // 单会话群：扁平引用回复，卡片直接出现在会话里，不另起话题
        return;
      }
      if (cmd === 'compact') {
        runCompact(msg, ts.sessionKey, false, ts);
        return;
      }
      if (cmd === 'context') {
        await postContextCard(msg, ts.sessionKey, false);
        return;
      }
      if (goalObjective) {
        if (!goalCapable(project)) {
          await denyGoal(msg, false);
          return;
        }
        void addReaction(msg.messageId, 'OKR');
        startReservedRun(msg, goalObjective, ts.sessionKey, true, project, ts, undefined, undefined, undefined, true);
        return;
      }
      handleTurn(msg, text, ts.sessionKey, true, project, ts);
      return;
    }

    // Multi (default): inside a topic → a turn in that session. /settings +
    // /resume aren't topic-scoped — redirect to the main area instead of feeding
    // them to codex as a normal turn (烧一轮还无人能懂).
    if (msg.threadId) {
      if (cmd === 'help') {
        await postHelpCard(msg, 'topic', true, project);
        return;
      }
      if (cmd === 'resume' || cmd === 'settings') {
        await channel
          .send(msg.chatId, { markdown: `\`/${cmd}\` 请到主群区使用（话题外发）。` }, { replyTo: msg.messageId, replyInThread: true })
          .catch(() => undefined);
        return;
      }
      const ts = turnSession(msg.threadId, project, msg.senderId);
      if (cmd === 'model') {
        postModelCard(msg, ts.sessionKey, true); // 已在话题里：卡片就发在当前话题内
        return;
      }
      if (cmd === 'compact') {
        runCompact(msg, ts.sessionKey, true, ts);
        return;
      }
      if (cmd === 'context') {
        await postContextCard(msg, ts.sessionKey, true);
        return;
      }
      if (goalObjective) {
        if (!goalCapable(project)) {
          await denyGoal(msg, true);
          return;
        }
        void addReaction(msg.messageId, 'OKR');
        startReservedRun(msg, goalObjective, ts.sessionKey, false, project, ts, undefined, undefined, undefined, true);
        return;
      }
      handleTurn(msg, text, ts.sessionKey, false, project, ts);
      return;
    }
    // Main group area: /resume opens the history picker; /settings opens the
    // group-settings card; /model only makes sense inside a topic; anything else
    // directly creates a topic + runs.
    if (cmd === 'help') {
      await postHelpCard(msg, 'main', false, project);
      return;
    }
    if (cmd === 'resume') {
      postResumeCard(msg);
      return;
    }
    if (cmd === 'settings') {
      await postGroupSettings(msg, project);
      return;
    }
    if (cmd === 'model' || cmd === 'compact' || cmd === 'context') {
      await channel
        .send(msg.chatId, { markdown: `\`/${cmd}\` 需要在话题里使用（先 @我 开个话题）。` }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    if (goalObjective) {
      if (!goalCapable(project)) {
        await denyGoal(msg, false);
        return;
      }
      void addReaction(msg.messageId, 'OKR');
      startTopicDirectly(msg, goalObjective, project, true);
      return;
    }
    // 拼错/臆想的斜杠命令（/stop /compat…）会直接烧一轮 codex 新开话题 —— 拦下。
    // 已知命令在上面全部 return 了，走到这里的 /单词 只剩裸 `/goal`（缺目标）和
    // 未知命令。仅限「整条消息就是一个 /纯字母单词」的形态，以 / 开头的路径、
    // 带参数的正文（用户真想让 codex 处理的）不受影响。
    if (/^\/[a-z]+$/i.test(text)) {
      const name = text.slice(1).toLowerCase();
      await channel
        .send(
          msg.chatId,
          { markdown: name === 'goal' ? '用法：`/goal <目标>`，例如 `/goal 把所有单测跑绿`。' : `未知命令 \`/${name}\`，可用命令见 \`/help\`。` },
          { replyTo: msg.messageId },
        )
        .catch(() => undefined);
      log.info('intake', 'unknown-cmd', { name });
      return;
    }
    startTopicDirectly(msg, text, project);
  };

  /** Parse a leading slash command; null otherwise. */
  function parseCommand(text: string): 'resume' | 'model' | 'settings' | 'help' | 'compact' | 'context' | null {
    const m = /^\/(\w+)/.exec(text);
    const name = m?.[1]?.toLowerCase();
    return name === 'resume' ||
      name === 'model' ||
      name === 'settings' ||
      name === 'help' ||
      name === 'compact' ||
      name === 'context'
      ? name
      : null;
  }

  /** Whether to respond to a non-@ message in a project group (免@ default on).
   * single: whole group. multi: inside a topic, OR a slash command in the main
   * area — plain chatter in the main area still needs @ (开新话题 是明确意图，
   * 不能让随便一句话就开话题)，but explicit commands (/help /resume /settings
   * /model) and a `/goal` trigger respond without @ since they're unambiguous intent.
   * 即使开了免@，若消息 @了所有人 或 @了具体的(非机器人)用户,说明是定向给别人的,
   * bot 不插话。(此函数仅在 !mentionedBot 时调用,故 @到 bot 的情况已被排除。) */
  function shouldRespondWithoutMention(project: Project, msg: NormalizedMessage): boolean {
    if (!(project.noMention ?? defaultNoMention(project))) return false;
    if (msg.mentionAll || msg.mentions.some((m) => !m.isBot)) return false;
    if ((project.kind ?? 'multi') === 'single') return true;
    const content = msg.content.trim();
    return Boolean(msg.threadId) || parseCommand(content) !== null || parseGoalTrigger(content) !== null;
  }

  /** 非管理员触发 owner-only 命令(/resume、/settings)时的统一无权限提示。
   * design §5: 管理类命令仅 bot owner(=admins[]) 可用；对话类(/model、/help)对所有人开放。 */
  async function denyAdminCommand(msg: NormalizedMessage, cmd: 'resume' | 'settings'): Promise<void> {
    await channel
      .send(msg.chatId, { markdown: `⚠️ \`/${cmd}\` 仅 bot 管理员可用。` }, { replyTo: msg.messageId })
      .catch(() => undefined);
    log.info('intake', 'cmd-denied', { cmd });
  }

  /** @bot /settings in a group: post the in-group settings card (owner/admin-gated). */
  async function postGroupSettings(msg: NormalizedMessage, project?: Project): Promise<void> {
    if (!isAdmin(cfg, msg.senderId)) {
      await denyAdminCommand(msg, 'settings');
      return;
    }
    if (!project) {
      await channel
        .send(msg.chatId, { markdown: '本群未绑定项目，请先在私聊里新建项目。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildGroupSettingsCard(project), msg.messageId);
      log.info('card', 'group-settings', { project: project.name });
    });
  }

  /** A turn's resolved permission, by sender role. `roleSuffix` is set only when
   * the project splits admin/guest tiers — then the session key is namespaced by
   * it so a guest never shares the admin thread (sandbox + codex history). */
  type TurnPerm = { mode?: PermissionMode; network?: boolean; autoCompact?: boolean; roleSuffix?: 'admin' | 'guest' };

  /** Pick this sender's tier (admin vs guest) for `project`. */
  function turnPerm(project: Project | undefined, senderId: string): TurnPerm {
    if (!project) return {};
    const t = turnTier(project, isAdmin(cfg, senderId));
    return { mode: t.mode, network: project.network, autoCompact: project.autoCompact, roleSuffix: t.split ? t.role : undefined };
  }

  /** As {@link turnPerm}, plus the role-namespaced session key (only namespaced
   * when the project splits tiers — keeps existing single-tier sessions intact). */
  function turnSession(
    baseKey: string,
    project: Project | undefined,
    senderId: string,
  ): { sessionKey: string } & TurnPerm {
    const perm = turnPerm(project, senderId);
    return { sessionKey: perm.roleSuffix ? `${baseKey}#${perm.roleSuffix}` : baseKey, ...perm };
  }

  /**
   * Per-message context ingest: fold this message's attachments AND any quoted
   * message into the prompt text codex receives.
   *   - File attachments → a local-path manifest (codex has no native file input,
   *     so an upload is only visible as an on-disk path — see weaveFileManifest).
   *   - 引用消息 (quote reply) → the quoted message's content, pulled by id and
   *     PREPENDED as a fenced block (see context-weave.weaveQuote) so codex sees
   *     上文 the bare @ doesn't carry. Best-effort: a deleted/unreadable quote is
   *     skipped, never thrown.
   * Both are gated (messageHasFiles / replyToMessageId) so the common text path
   * stays await-free. 话题上文 is woven separately in startReservedRun (it is
   * session-scoped, not per-message). Returns `text` unchanged when there's
   * nothing to add.
   */
  async function ingestContext(msg: NormalizedMessage, text: string): Promise<string> {
    let body = text;
    if (messageHasFiles(msg)) {
      const files = await collectInboundFiles(channel, msg);
      body = weaveFileManifest(text, files);
      // A file-ONLY message whose download failed (oversize / Feishu reject /
      // transient) strips to '' — don't hand codex a blank turn (wasted run +
      // empty card). Tell it the attachment couldn't be read so it can say so.
      if (!body.trim()) {
        body =
          '用户发来一个附件，但桥没能下载它（可能超过 50MB 上限或被飞书拒绝）。请告诉用户附件没读到，可以重发，或改为粘贴文本 / 发图片。';
      }
    }
    if (msg.replyToMessageId) {
      const quoted = await fetchQuotedMessage(channel, msg.replyToMessageId);
      body = weaveQuote(body, quoted);
    }
    // Identity weave (outermost within ingestContext): fold WHO sent this turn so
    // codex can match the roster (approve-gate) and @ them back. Covers both the
    // first-turn (startReservedRun) and mid-turn (handleTurn) paths.
    body = weaveSender(body, msg);
    return body;
  }

  /**
   * A turn in a session keyed by `sessionKey` — the topic's threadId (multi) or
   * the chatId (single, `flat`). steer/queue mid-turn; otherwise reserve + run.
   * `flat` = reply by quoting (no reply_in_thread / topic), for single groups.
   */
  async function handleTurn(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project: Project | undefined,
    perm: TurnPerm,
  ): Promise<void> {
    // Mid-turn: steer (引导) or queue (排队).
    const existing = active.get(sessionKey);
    if (existing) {
      // 🎯 goal 会话不接外部输入（turns 由 codex 自续，queue 永远不被消费），
      // 入队只会在收尾被静默丢弃 —— 直接告知而不是黑洞。
      if (existing.isGoal) {
        await replyGoalBusy(msg, flat);
        return;
      }
      // Download any images first (best-effort) so the steered/queued turn can
      // carry them. Awaited here — the session is already held by a running
      // turn, so there's no reservation race to protect; gated on
      // messageHasImages so the common text path stays await-free and fast.
      const images = messageHasImages(msg) ? await collectInboundImages(channel, msg) : undefined;
      // Download file attachments too and weave their paths into the text (codex
      // reads them by path). Both awaits happen before re-reading the session.
      const woven = await ingestContext(msg, text);
      // The turn may have finished while media downloaded — re-read the session.
      // If it's gone, start a fresh run (carrying what we already fetched).
      const cur = active.get(sessionKey);
      if (!cur) {
        startReservedRun(msg, woven, sessionKey, flat, project, perm, images, true, text);
        return;
      }
      // A goal may have started while media downloaded — same prompt as above.
      if (cur.isGoal) {
        await replyGoalBusy(msg, flat);
        return;
      }
      if (getPendingPolicy(cfg) === 'steer' && cur.run && cur.thread) {
        const tid = cur.run.turnId();
        if (tid) {
          try {
            await cur.thread.steer({ text: woven, images }, tid);
            log.info('intake', 'steer', { tid, images: images?.length ?? 0 });
            return;
          } catch (err) {
            log.warn('intake', 'steer-failed', { err: String(err) });
          }
        }
      }
      cur.queue.push({ text: woven, images });
      log.info('intake', 'queued', { depth: cur.queue.length });
      return;
    }

    startReservedRun(msg, text, sessionKey, flat, project, perm);
  }

  /** 🎯 goal 运行中收到消息的统一提示（goal 会话不入队，见 ActiveState.isGoal）。 */
  async function replyGoalBusy(msg: NormalizedMessage, flat: boolean): Promise<void> {
    await channel
      .send(
        msg.chatId,
        { markdown: '🎯 目标运行中，消息不会进入会话；可在卡片上 **⏹ 终止** 或 **🎯 结束目标** 后重发。' },
        { replyTo: msg.messageId, replyInThread: !flat },
      )
      .catch(() => undefined);
    log.info('intake', 'goal-busy', { msgId: msg.messageId });
  }

  /**
   * Reserve `sessionKey` synchronously (before any await) so a second message
   * racing in through the SDK's per-chatId queue sees it and queues instead of
   * double-launching — including a message whose image download just finished
   * and discovered the prior run had ended (handleTurn's fall-through). The
   * synchronous check-then-set is the critical section; everything slow (image
   * download, thread resolution, the codex run) runs **detached** so onMessage
   * returns fast — holding the chatId queue would block sibling topics and the
   * ⏹ card-action (design: 话题=独立 session，应并行).
   */
  function startReservedRun(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project: Project | undefined,
    perm: TurnPerm,
    preloadedImages?: string[],
    preIngested?: boolean,
    summaryText?: string,
    goal?: boolean,
  ): void {
    const existing = active.get(sessionKey);
    if (existing) {
      // A goal can't co-run with (or queue behind) a turn on the same session —
      // it's an autonomous multi-turn run, not a follow-up. Tell the user and skip.
      if (goal) {
        void channel
          .send(msg.chatId, { markdown: '当前会话有任务在跑，请等它结束后再发 `/goal`。' }, { replyTo: msg.messageId, replyInThread: !flat })
          .catch(() => undefined);
        return;
      }
      // A goal appeared in that window — its queue is never consumed, so prompt
      // instead of queueing (same as handleTurn's isGoal gate).
      if (existing.isGoal) {
        void replyGoalBusy(msg, flat);
        return;
      }
      // A run appeared between handleTurn's check and here (we awaited an image
      // download) — queue onto it rather than launch a second turn. `text` is
      // already file-woven when preIngested (handleTurn's fall-through).
      existing.queue.push({ text, images: preloadedImages });
      log.info('intake', 'queued', { depth: existing.queue.length });
      return;
    }
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId, isGoal: goal };
    active.set(sessionKey, reserved);
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      // Goal runs use the OKR reaction (added at dispatch) as their only receipt,
      // not the ⏳/🫳 run-reaction lifecycle.
      const reaction = goal ? undefined : runReaction(msg.messageId, !sema.hasFree());
      try {
        const tIntake = Date.now();
        // ── 入站三路并行（M-1）── 飞书 API（图片下载 / 文件+引用织入）、本地
        // spawn（resolveThread）与话题上文拉取互不依赖，Promise.all 把串行 RTT
        // 全部重叠掉。失败语义与串行版一致：resolve/ingest/getSession 失败走外层
        // catch 终止本轮并回 ❌（Promise.all 自带对其余分支 rejection 的观察，
        // 不会产生 unhandled rejection）；images/history 内部 best-effort（吞错
        // 返回空），永不拖死其他路。
        // Images preloaded by handleTurn's fall-through, else fetch them now
        // (inside the detached run, after the synchronous reservation).
        const imagesP = preloadedImages
          ? Promise.resolve(preloadedImages)
          : messageHasImages(msg)
            ? collectInboundImages(channel, msg)
            : Promise.resolve(undefined);
        // File attachments / quoted message woven into the prompt. Skipped when
        // preIngested (handleTurn already wove them into `text`).
        const ingestP = preIngested ? Promise.resolve(text) : ingestContext(msg, text);
        let tResolveDone = tIntake;
        const resolveP = resolveThread(sessionKey, msg.chatId, {
          mode: perm.mode,
          network: perm.network,
          autoCompact: perm.autoCompact,
        }).then((r) => {
          tResolveDone = Date.now();
          return r;
        });
        // For an already-resumed session the high-water mark (lastSeenAt) tells us
        // which thread messages codex hasn't seen — a pure local read, NOT
        // dependent on resolveThread's outcome, so it rides the same Promise.all.
        const priorP = getSession(sessionKey);
        // 话题上文投机拉取：sinceTime 只是单页拉取后的本地 filter（API 调用对任何
        // sinceTime 完全相同），所以不必等 resolveThread 的 codexEmpty —— 先按
        // 全量拉回来，汇合后用 filterHistorySince 收敛成与串行版逐字节一致的
        // 增量。唯一不投机的情况：有记录但无水位（resume 上来的旧会话，codex
        // 已带历史，串行版只在 recreated 罕见路径才拉）—— 留到汇合后补拉。
        const topicId = goal ? undefined : msg.threadId;
        const historyP: Promise<ContextMessage[]> = topicId
          ? priorP.then((p) =>
              p && p.lastSeenAt === undefined
                ? []
                : fetchThreadContext(channel, topicId, { excludeMessageId: msg.messageId }),
            )
          : Promise.resolve([]);
        const [images, ingested, { thread: resolved, recreated }, prior, specHistory] = await Promise.all([
          imagesP,
          ingestP,
          resolveP,
          priorP,
          historyP,
        ]);
        let firstText = ingested;
        let thread = resolved;
        const neverSeen = !thread;
        // codex's history is EMPTY when the session is brand-new (neverSeen) OR a
        // resume failed and we fell back to a new thread (recreated) — both want
        // the FULL topic woven as opening context, not just the delta.
        const codexEmpty = neverSeen || recreated;
        if (!thread) {
          // Unknown session (created before this bridge, or store lost): treat as
          // a fresh session bound to the resolved cwd, on the project's backend.
          const cwd = project?.cwd ?? fallbackCwd;
          const be = backendFor(project?.backend);
          thread = await be.startThread({ cwd, mode: perm.mode, network: perm.network, autoCompact: perm.autoCompact });
          trackSession(sessionKey, thread);
          // 自愈观测：来源=全新会话（无持久化记录），与 resume-ok/resume-recreate
          // 互斥——三者其一 + agent 层的 spawn/prewarm-hit 即可还原完整恢复路径。
          log.info('agent', 'session-fresh', { sessionKey, sessionId: thread.sessionId, backend: be.id });
          await upsertSession({
            threadId: sessionKey,
            chatId: msg.chatId,
            cwd,
            sessionId: thread.sessionId,
            backend: be.id,
            // `text` is already file-woven when preIngested; use the raw
            // `summaryText` (handleTurn's original) so the session label isn't
            // manifest boilerplate + a temp path.
            summary: stripFileTokens(summaryText ?? text).slice(0, 80),
            lastSeenAt: msg.createTime,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        // 话题上文：在话题里 @bot 时，把 bot 还没喂给 codex 的人对人消息补进开场。
        // codexEmpty（新会话 / resume 失败重建）→ 用最近 N 条全量（即投机结果）；
        // 已有会话 → 用 filterHistorySince 把投机全量收敛成水位之后的增量（没有
        // 水位说明是 resume 上来的旧会话，codex 已带历史，跳过以免重复喂）。
        // Goals skip the topic-history weave (topicId=undefined above): the
        // objective must stay self-contained (and under codex's ~4000-char goal
        // limit), and a resumed thread already carries codex's own history —
        // weaving chat transcript into a goal would pollute it and risk a
        // rejected thread/goal/set.
        if (topicId && (codexEmpty || prior?.lastSeenAt !== undefined)) {
          const history = codexEmpty
            ? prior && prior.lastSeenAt === undefined
              ? // 投机被跳过的唯一组合（有记录无水位）撞上 recreated 罕见路径：补拉全量
                await fetchThreadContext(channel, topicId, { excludeMessageId: msg.messageId })
              : specHistory
            : filterHistorySince(specHistory, prior?.lastSeenAt ?? 0);
          firstText = weaveThreadHistory(firstText, history);
        }
        // Advance the high-water mark so the NEXT turn only catches up新消息.
        // (a brand-new session already wrote it in the upsert above.)
        if (!neverSeen) void patchSession(sessionKey, { lastSeenAt: msg.createTime }).catch(() => undefined);
        reserved.thread = thread;
        const launchOpts: LaunchOpts = {
          chatId: msg.chatId,
          replyTo: msg.messageId,
          replyInThread: !flat,
          flat,
          thread,
          firstText,
          images,
          knownThreadId: sessionKey,
          requesterOpenId: msg.senderId,
          // 编织完成 → turn/start 之间不再读盘：首轮直接用预取的会话记录
          // （prior=undefined 即确知是全新会话，刚 upsert 的记录还没有 model）。
          firstRec: prior ?? null,
          timing: { tResolve: tResolveDone - tIntake, tWeave: Date.now() - tIntake },
        };
        if (goal) await launchGoalRun(launchOpts);
        else await launchRun(launchOpts, reaction);
      } catch (err) {
        active.delete(sessionKey); // release the reservation so the session isn't wedged
        reaction?.done();
        log.fail('intake', err);
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId, replyInThread: !flat })
          .catch(() => undefined);
      }
    });
  }

  /** Reuse an in-memory codex thread, else resume from the persisted store.
   * `perm` carries the bound project's CURRENT permission tier (mode/network),
   * applied when we (re)start a thread here. A LIVE thread keeps the sandbox it
   * was started with (codex binds it at thread/start and never re-reads it), so
   * a tier change can only take effect by EVICTING the live thread first — see
   * evictLiveSessionsForChat, called from the 🔐 权限 handlers. Without that
   * eviction the fast-path below would silently keep a 'full' thread running
   * after the admin switched to read-only.
   *
   * Returns `recreated: true` ONLY when a resume FAILED and we fell back to a
   * brand-new codex thread — its history is empty, so the caller re-feeds full
   * topic context (not just the delta). A `undefined` thread means "never seen"
   * (caller starts + persists it fresh). */
  async function resolveThread(
    threadId: string,
    chatId: string,
    perm?: { mode?: PermissionMode; network?: boolean; autoCompact?: boolean },
  ): Promise<{ thread: AgentThread | undefined; recreated: boolean }> {
    const live = sessions.get(threadId);
    if (live) {
      if (live.isAlive()) return { thread: live, recreated: false };
      // app-server 子进程已死（崩溃/被 kill）：死线程留在缓存只会反复失败，
      // 清掉让它落入下面既有的 resume-or-recreate 兜底（持久化的 sessionId
      // 还在，话题自愈而不是僵死到重启）。
      sessions.delete(threadId);
      log.info('agent', 'dead-thread-evict', { threadId });
    }
    const rec = await getSession(threadId);
    if (!rec) return { thread: undefined, recreated: false };
    // Route by the RECORD's backend — the backend that created the session (old
    // v1 records read back as the codex default). A project switching backends
    // later must not strand existing sessions on the wrong runtime; the project
    // is still consulted for cwd / tier defaults on the recreate path below.
    const project = await getProjectByChatId(chatId);
    const be = backendFor(rec.backend);
    try {
      const resumed = await be.resumeThread({
        cwd: rec.cwd,
        sessionId: rec.sessionId,
        model: rec.model,
        effort: rec.effort,
        mode: perm?.mode,
        network: perm?.network,
        autoCompact: perm?.autoCompact,
      });
      trackSession(threadId, resumed);
      // 自愈观测：resume 来源=持久化记录（区分「resume 自愈」与 LIVE 快路径的
      // 普通续轮——后者不经过这里，stream.timing 的 tResolve≈0 是它的指纹）。
      log.info('agent', 'resume-ok', { threadId, sessionId: rec.sessionId, backend: be.id });
      return { thread: resumed, recreated: false };
    } catch (err) {
      log.fail('agent', err, { phase: 'resume-on-turn', threadId });
      const cwd = project?.cwd ?? rec.cwd ?? fallbackCwd;
      const fresh = await be.startThread({
        cwd,
        model: rec.model,
        effort: rec.effort,
        mode: perm?.mode ?? project?.mode,
        network: perm?.network ?? project?.network,
        autoCompact: perm?.autoCompact ?? project?.autoCompact,
      });
      trackSession(threadId, fresh);
      // The resumed codex thread is gone — repoint the persisted record at the
      // new thread id so a later restart doesn't keep resuming the dead one.
      await patchSession(threadId, { sessionId: fresh.sessionId }).catch(() => undefined);
      // 自愈观测：resume 失败已重建全新线程（codex 历史为空，调用方会回灌话题上文）。
      log.info('agent', 'resume-recreate', { threadId, sessionId: fresh.sessionId, backend: be.id });
      return { thread: fresh, recreated: true };
    }
  }

  /**
   * Close every LIVE codex thread under `chatId` so a permission-tier change
   * actually rebinds. The codex sandbox is fixed at thread/start|resume and is
   * immutable for the thread's life — so an already-running 'full' thread would
   * keep full-disk read access even after the admin switches the project to
   * read-only (the card would claim read-only while the runtime stays full
   * access, reading ~/.ssh etc.). Evicting forces the next turn's resolveThread
   * to re-resume under the new tier (or fail-closed where it can't be enforced).
   */
  async function evictLiveSessionsForChat(chatId: string): Promise<void> {
    let closed = 0;
    for (const rec of await listSessions()) {
      if (rec.chatId !== chatId) continue;
      const live = sessions.get(rec.threadId);
      if (!live) continue;
      sessions.delete(rec.threadId); // synchronous: next turn can't reuse it
      void live.close().catch(() => undefined); // SIGKILLs the app-server child
      closed++;
    }
    if (closed) log.info('console', 'tier-evict', { chatId, closed });
  }

  /** Group @bot (no topic): create the topic + run with the default model.
   * Detached — onMessage must return fast (see {@link handleTurn}); a new
   * topic has a unique reply target so no same-topic reservation is needed. */
  function startTopicDirectly(msg: NormalizedMessage, text: string, project?: Project, goal?: boolean): void {
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      // 🫳 Typing on receive (⏳ OneSecond if a slot isn't free) → ✅ DONE once
      // the topic is created (onTopicCreated, below). For this path the acked
      // action is "建话题", not the full reply — so DONE fires on first card,
      // unlike an in-topic turn (see handleTurn). Goal runs skip this lifecycle —
      // the OKR reaction (added at dispatch) is their receipt.
      const reaction = goal ? undefined : runReaction(msg.messageId, !sema.hasFree());
      const cwd = project?.cwd ?? fallbackCwd;
      // The topic creator's role decides this new topic's tier; roleSuffix (when
      // tiers are split) namespaces the persisted session so the other role gets
      // its own thread on its first message (see turnSession / adoptThreadId).
      const perm = turnPerm(project, msg.senderId);
      // lazy banner branch refresh (design §3.2) — best-effort, non-blocking
      if (project) void refreshBranch(channel, project).catch(() => undefined);
      // Pick the default model FROM THE PROJECT'S BACKEND — a claude project must
      // not be handed codex's default ('gpt-5.5'). Unset backend → codex, as before.
      const be = backendFor(project?.backend);
      // ── 入站并行（M-1）── listModels+startThread（本地 spawn，实测 250ms–1.6s）
      // 与图片下载 / 文件+引用织入（飞书 API）互不依赖。任何一路失败都终止本轮
      // 并回 ❌（原先 ingest 失败只进日志、reaction 卡死——顺带修正），但已起的
      // 进程必须回收：它还不在 sessions 里，不关就是孤儿 app-server。
      const tIntake = Date.now();
      let tResolveDone = tIntake;
      const threadP = (async () => {
        const { model, effort } = pickDefault(await listModels(be));
        const thread = await be.startThread({ cwd, model, effort, mode: perm.mode, network: perm.network, autoCompact: perm.autoCompact });
        tResolveDone = Date.now();
        return { thread, model, effort };
      })();
      // Download any attached/forwarded images so the opening turn can see them,
      // and any file attachments (their paths get woven into the prompt text).
      const imagesP = messageHasImages(msg) ? collectInboundImages(channel, msg) : Promise.resolve(undefined);
      const ingestP = ingestContext(msg, text);
      let thread: AgentThread;
      let model: string;
      let effort: ReasoningEffort;
      let images: string[] | undefined;
      let firstText: string;
      try {
        const [started, imgs, ingested] = await Promise.all([threadP, imagesP, ingestP]);
        ({ thread, model, effort } = started);
        images = imgs;
        firstText = ingested || '你好，我们开始吧。';
      } catch (err) {
        reaction?.done();
        // 失败路互不拖死：threadP 若已成功则回收孤儿进程，若失败吞掉其 rejection。
        void threadP.then((s) => s.thread.close()).catch(() => undefined);
        log.fail('card', err, { phase: 'start-topic' });
        await channel
          .send(msg.chatId, { markdown: `❌ 启动失败：${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
        return;
      }
      log.info('card', 'start', { project: project?.name ?? '(unregistered)', model, effort, images: images?.length ?? 0, goal: Boolean(goal) });
      const launchOpts: LaunchOpts = {
        chatId: msg.chatId,
        replyTo: msg.messageId,
        replyInThread: true,
        thread,
        firstText,
        images,
        model,
        effort,
        cwd,
        summary: stripFileTokens(text).slice(0, 80) || '(空)',
        requesterOpenId: msg.senderId,
        roleSuffix: perm.roleSuffix,
        backendId: be.id,
        timing: { tResolve: tResolveDone - tIntake, tWeave: Date.now() - tIntake },
      };
      if (goal) await launchGoalRun(launchOpts);
      else
        await launchRun(
          launchOpts,
          reaction,
          () => reaction?.done(), // topic created → ✅ DONE (don't wait for the reply)
        );
    }).catch((err) => log.fail('intake', err));
  }

  /** Group @bot /resume: post the history picker for this project's cwd. Owner-only
   * (admins[]) — 恢复会话会改变上下文，属管理类命令；非管理员收到无权限提示。
   * Detached — listThreads spawns an app-server (slow); holding onMessage on it
   * would pin the SDK's per-chat queue (sibling topics + ⏹ card-actions stall). */
  function postResumeCard(msg: NormalizedMessage): void {
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      if (!isAdmin(cfg, msg.senderId)) {
        await denyAdminCommand(msg, 'resume');
        return;
      }
      try {
        const project = await getProjectByChatId(msg.chatId);
        const cwd = project?.cwd ?? fallbackCwd;
        // Routed so a no-resume backend surfaces its clear "not supported" error
        // here. The resolved backend id rides the card state AND each pick
        // button's callback value (`b`), so the pick → readHistory → rebind path
        // stays on the same backend that listed the sessions.
        const be = backendFor(project?.backend);
        const threads = await be.listThreads(cwd);
        const state: ResumeCardState = {
          chatId: msg.chatId,
          originalMsgId: msg.messageId,
          requesterOpenId: msg.senderId,
          cwd,
          projectName: project?.name,
          backend: be.id,
          threads,
          createdAt: Date.now(),
        };
        const res = await sendManagedCard(channel, msg.chatId, buildResumeCard(state), msg.messageId);
        pruneResumePending();
        resumePending.set(res.messageId, state);
        log.info('card', 'resume', { project: project?.name ?? '(unregistered)', threads: threads.length });
      } catch (err) {
        // detached: surface the failure as a reply, never die silently
        log.fail('card', err, { cmd: 'resume' });
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
      }
    });
  }

  /** @bot /model: post the model/effort picker for the session keyed by
   * `sessionKey` (topic threadId for multi, chatId for single).
   * Detached — listModels can cold-spawn an app-server; see postResumeCard. */
  function postModelCard(msg: NormalizedMessage, sessionKey: string, inThread: boolean): void {
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      try {
        // 按会话/项目后端路由（已有会话以记录为准，未开张的用项目配置）：
        // claude 项目的 /model 卡绝不能列 codex 模型——选中即经 patchSession
        // 持久化，重启 resume 会把 codex model id 喂给 claude CLI，会话坏死。
        const [rec, project] = await Promise.all([getSession(sessionKey), getProjectByChatId(msg.chatId)]);
        const be = backendFor(rec?.backend ?? project?.backend);
        const models = await listModels(be);
        const def = pickDefault(models);
        // 记录里跨后端污染的 model id（旧版未路由的 /model 卡写入）不在本后端
        // 列表里——回落默认，别把坏值当 select 初值渲染。
        const recModel = rec?.model && models.some((m) => m.id === rec.model) ? rec.model : undefined;
        const state: ModelCardState = {
          chatId: msg.chatId,
          threadId: sessionKey,
          requesterOpenId: msg.senderId,
          models,
          model: recModel ?? def.model,
          effort: rec?.effort ?? def.effort,
          backend: be.id,
          createdAt: Date.now(),
        };
        const res = await sendManagedCard(channel, msg.chatId, buildModelCard(state), msg.messageId, inThread);
        pruneModelPending();
        modelPending.set(res.messageId, state);
        log.info('card', 'model', { threadId: sessionKey, model: state.model, effort: state.effort });
      } catch (err) {
        // detached: surface the failure as a reply, never die silently
        log.fail('card', err, { cmd: 'model' });
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
      }
    });
  }

  /** `/context`: show the session's current context-window usage (always — even
   * below the run card's threshold). Reads the last usage seen on this session;
   * empty until the session has run at least one turn. */
  async function postContextCard(msg: NormalizedMessage, sessionKey: string, inThread: boolean): Promise<void> {
    const u = lastUsage.get(sessionKey);
    await sendManagedCard(channel, msg.chatId, buildContextCard(u?.used ?? 0, u?.window ?? null), msg.messageId, inThread).catch(
      (err) => log.fail('card', err, { phase: 'context' }),
    );
  }

  /** Spinner cadence for the "压缩中" card. ~0.8s reads as live without spamming
   * card updates (each is a round-trip). */
  const COMPACT_ANIM_INTERVAL_MS = 800;

  /** `/compact`: summarize the session's history to free context. Idle-only (a
   * running turn owns the thread's single event stream); resumes the session
   * under its current tier if it isn't live. Compaction is a background turn (not
   * instant), so we post a managed "压缩中" card and flip it in place to
   * 压缩完成/失败 once {@link AgentThread.compact} actually settles.
   *
   * Detached (startReservedRun 同模式): the session is reserved SYNCHRONOUSLY so
   * a message racing in mid-compaction queues instead of launching a turn that
   * would steal the thread's single event stream — then everything slow
   * (resolveThread, the compaction turn, up to COMPACT_TIMEOUT_MS) runs off the
   * await chain. Holding onMessage here would pin the SDK's per-chat queue —
   * sibling topics and the ⏹ card-action would stall for the whole compaction. */
  function runCompact(
    msg: NormalizedMessage,
    sessionKey: string,
    inThread: boolean,
    perm: TurnPerm,
  ): void {
    const reply = (markdown: string): Promise<void> =>
      channel
        .send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: inThread })
        .then(() => undefined, () => undefined);
    if (active.get(sessionKey)) {
      void reply('⏳ 这一轮还在跑，结束后再 `/compact`。');
      return;
    }
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId };
    active.set(sessionKey, reserved);
    void withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      try {
        const { thread } = await resolveThread(sessionKey, msg.chatId, {
          mode: perm.mode,
          network: perm.network,
          autoCompact: perm.autoCompact,
        });
        if (!thread) {
          await reply('这个会话还没开始，先发条消息聊两句再 `/compact`。');
          return;
        }

        // "压缩中" card we flip in place to the result. Keep its messageId so the
        // settle step can update the same entity; fall back to a fresh card if the
        // initial send (or the in-place update) fails.
        let cardMsgId: string | undefined;
        try {
          const sent = await sendManagedCard(channel, msg.chatId, buildCompactingCard(0), msg.messageId, inThread);
          cardMsgId = sent.messageId;
        } catch (err) {
          log.fail('card', err, { phase: 'compact-start-card' });
        }

        // Spin the "压缩中" card so it visibly keeps working (compaction can take a
        // while). Self-rescheduling tick — never overlaps an in-flight update, and
        // checks `stop` right before each render so no frame can clobber the result;
        // the card has no buttons, so these updates can't hit an interaction lock.
        let stop = false;
        const wakers: Array<() => void> = [];
        const sleep = (ms: number): Promise<void> =>
          new Promise((res) => {
            const t = setTimeout(res, ms);
            wakers.push(() => {
              clearTimeout(t);
              res();
            });
          });
        const anim = (async () => {
          let tick = 0;
          while (!stop && cardMsgId) {
            await sleep(COMPACT_ANIM_INTERVAL_MS);
            if (stop || !cardMsgId) break;
            tick++;
            await updateManagedCard(channel, cardMsgId, buildCompactingCard(tick)).catch(() => undefined);
          }
        })();

        const settle = async (result: object): Promise<void> => {
          stop = true;
          wakers.forEach((w) => w()); // cut the current sleep so the result shows promptly
          await anim; // let the in-flight frame finish so it can't land after the result
          if (cardMsgId && (await updateManagedCard(channel, cardMsgId, result))) return;
          await sendManagedCard(channel, msg.chatId, result, msg.messageId, inThread).catch((err) =>
            log.fail('card', err, { phase: 'compact-settle' }),
          );
        };

        // Pre-compaction occupancy, so the result card can show 旧% → 新%.
        const before = lastUsage.get(sessionKey) ?? null;
        try {
          // Resolves only when codex's compaction turn truly finishes (compact()
          // drains the stream to turn/completed), so the card flips at the right
          // time AND no stale `done` leaks into the next turn.
          const { usage } = await thread.compact();
          if (usage) lastUsage.set(sessionKey, { used: usage.usedTokens, window: usage.contextWindow });
          else lastUsage.delete(sessionKey); // refreshes on the next turn's usage event
          log.info('intake', 'compact', { sessionKey, used: usage?.usedTokens ?? null, before: before?.used ?? null });
          await settle(buildCompactedCard(usage, before));
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          const unsupported = /method not found|-32601|unknown (method|request)/i.test(m);
          log.fail('intake', err, { phase: 'compact' });
          await settle(buildCompactFailedCard(unsupported ? '当前 codex 版本不支持 /compact，请升级后再试。' : m));
        }
      } catch (err) {
        // pre-card failures (resolveThread 等) have no card to land on — surface
        // them as a plain reply rather than dying silently in the detached task.
        log.fail('intake', err, { phase: 'compact-detached' });
        await reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (active.get(sessionKey) === reserved) active.delete(sessionKey);
        // Messages that queued onto the reservation during compaction never ran —
        // say so instead of dropping them silently (same contract as a killed run).
        if (reserved.queue.length > 0) {
          await reply(`⚠️ 压缩期间收到的 ${reserved.queue.length} 条消息未进入会话，请重发。`);
        }
      }
    });
  }

  /** `/help`: post the command cheat-sheet for the caller's current scope. */
  async function postHelpCard(
    msg: NormalizedMessage,
    scope: HelpScope,
    inThread = false,
    project?: Project,
  ): Promise<void> {
    const noMention = project ? (project.noMention ?? defaultNoMention(project)) : true;
    // 按本群项目的后端能力裁剪命令清单：不支持的后端不列 /goal、/compact、/resume
    // （能力守卫会拒），避免「列了点了才发现不支持」。codex(capabilities undefined)=全列。
    const caps = backendFor(project?.backend).capabilities;
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildHelpCard(scope, noMention, isAdmin(cfg, msg.senderId), caps), msg.messageId, inThread).catch((err) =>
        log.fail('card', err, { cmd: 'help', scope }),
      );
      log.info('card', 'help', { scope });
    });
  }

  // ── card actions ──────────────────────────────────────────────────
  const dispatcher = new CardDispatcher(channel, cfg);
  cliBridge?.register(dispatcher);
  const PENDING_TTL_MS = 30 * 60_000; // abandoned config cards expire after 30 min
  // Goal runs have NO total wall-clock cap (a healthy goal may legitimately run
  // for days — matching codex's native behavior). The only automatic backstop is
  // an IDLE watchdog: if codex emits NO raw notification at all for this long
  // (run.lastActivity — unmapped notifications like command output deltas count
  // as liveness), the run is presumed wedged and torn down to free its
  // concurrency slot. A live goal streams notifications continuously, so this
  // never fires on real work; manual control is the run card's ⏹ 终止 /
  // 🎯 结束目标 buttons.
  const GOAL_IDLE_MS = 30 * 60_000;

  // A card update issued from inside a cardAction handler must land AFTER Feishu
  // is done with the click's interaction window — Feishu locks the card during
  // that window and discards an update that arrives inside it (official "处理卡片
  //回调"). A hard collision throws cardkit err 200810 (caught + retried below);
  // but a near-miss returns HTTP 200 yet the *client* still snaps the card back
  // to its pre-click state — silent, so the 200810 retry never fires and the
  // update is simply lost (symptom: "点一下没反应 / 要点两下"). We learned 150ms is
  // inside that soft window; 500ms clears it reliably. These console cards aren't
  // high-frequency, so the latency is worth the determinism. Cards must be
  // CardKit entities (sendManagedCard) for the update to target them —
  // im.v1.message.patch only does "unconditional".
  const CARD_SETTLE_MS = 500;
  // `c` may be a card object or a (possibly async) builder. Passing a builder
  // lets a handler return *immediately* (so the SDK acks the click's callback
  // right away, closing the interaction window) while any slow work — API
  // calls, createProject — runs inside the settle, after the ack. Awaiting slow
  // work in the handler instead holds the callback open and the next click's
  // update collides with the still-open window (err 200810 → revert).
  //
  // `fallbackChatId`: byMessageId mappings are per-process (lost on restart), so
  // a card sent before a restart is an orphan — updateManagedCard finds no entity
  // and no-ops, leaving a dead card (the "返回菜单又没用了" after I restart). When a
  // chatId is given we self-heal by posting a fresh managed card instead (no
  // recall — the stale one just sits above).
  const settleUpdate = (
    msgId: string,
    c: object | (() => object | Promise<object>),
    fallbackChatId?: string,
  ): void => {
    const armedAt = Date.now();
    void (async () => {
      // Wrap the WHOLE flow: a throwing builder (`c()`), a rejected card update,
      // or a rejected fallback must never die silently — that surfaces to the user
      // as a dead button ("点击没反应") with nothing in the log to diagnose it.
      try {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        const card = typeof c === 'function' ? await c() : c;
        const ok = await updateManagedCard(channel, msgId, card);
        log.info('console', 'settle-update', { msgId, ok, waitedMs: Date.now() - armedAt, fallback: !ok && !!fallbackChatId });
        if (!ok && fallbackChatId) {
          await sendManagedCard(channel, fallbackChatId, card);
        }
      } catch (err) {
        log.fail('console', err, { phase: 'settle-update', msgId });
      }
    })();
  };
  function pruneResumePending(): void {
    const now = Date.now();
    for (const [k, s] of resumePending) if (now - s.createdAt > PENDING_TTL_MS) resumePending.delete(k);
  }
  function pruneModelPending(): void {
    const now = Date.now();
    for (const [k, s] of modelPending) if (now - s.createdAt > PENDING_TTL_MS) modelPending.delete(k);
  }

  /**
   * Resolve + authorize a command-card (/model, /resume) action. Only the
   * original requester may act on their card (design §5); chat/user must still
   * be allowed; expired cards are dropped.
   */
  function authPending<T extends { createdAt: number; requesterOpenId: string; chatId: string }>(
    map: Map<string, T>,
    evt: CardActionEvent,
  ): T | undefined {
    const state = map.get(evt.messageId);
    if (!state) return undefined;
    if (Date.now() - state.createdAt > PENDING_TTL_MS) {
      map.delete(evt.messageId);
      return undefined;
    }
    const op = evt.operator?.openId ?? '';
    if (op !== state.requesterOpenId || !isChatAllowed(cfg, state.chatId)) {
      log.info('card', 'action-denied', { reason: 'not-allowed' });
      return undefined;
    }
    return state;
  }

  dispatcher
    .on(MC.model, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        // 防跨后端写入：卡片建立后会话后端可能已变（/resume 换绑等）——这张卡
        // 列的是 state.backend 的模型，写进别的后端的会话记录会让 resume 把
        // 错后端的 model id 喂给 CLI（claude 吃到 'gpt-5.5' 即永久报错）。
        const rec = await getSession(state.threadId);
        if (state.backend && rec && rec.backend !== state.backend) {
          state.note = '⚠️ 会话后端已切换，这张卡已过期——请重新发 /model';
          return buildModelCard(state);
        }
        state.model = option;
        // re-pick a valid effort if the new model doesn't support the current one
        const m = state.models.find((x) => x.id === option);
        if (m && m.supportedEfforts.length && !m.supportedEfforts.includes(state.effort)) {
          state.effort = m.defaultEffort;
        }
        await patchSession(state.threadId, { model: state.model, effort: state.effort });
        state.note = `✅ 已切换模型「${m?.displayName ?? option}」，下一轮生效`;
        return buildModelCard(state);
      });
    })
    .on(MC.effort, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        state.effort = option as ReasoningEffort;
        await patchSession(state.threadId, { effort: state.effort });
        state.note = '✅ 已设置 effort，下一轮生效';
        return buildModelCard(state);
      });
    })
    .on(RES.pick, ({ evt, value }) => {
      const state = authPending(resumePending, evt);
      const sessionId = typeof value.t === 'string' ? value.t : undefined;
      // backend id from the button value (M-8: card callbacks carry it), with
      // the card state's copy as fallback for cards minted before the change.
      const backendId = typeof value.b === 'string' ? value.b : state?.backend;
      if (!state || !sessionId || state.launching) return;
      state.launching = true;
      settleUpdate(evt.messageId, buildResumeLaunchingCard(state));
      // detach: don't hold the cardAction callback for the whole resume + run
      void resumeFromCard(evt, state, sessionId, backendId);
    });

  /** Run-card actions: gated by chat/user allow lists (design §5). */
  const runAllowed = (evt: CardActionEvent): boolean => isChatAllowed(cfg, evt.chatId);
  /**
   * Owner-or-admin gate for run-card controls. Killing/altering someone else's
   * run is destructive (design §5: 杀别人的 run 限 admins), and `allowedUsers`
   * defaults to "everyone", so the allow-list alone is not enough. Only the run
   * starter (requester) or an admin may ⏹/⚙️ it.
   */
  const runOwnerOrAdmin = (evt: CardActionEvent, ownerOpenId?: string): boolean => {
    if (!runAllowed(evt)) return false;
    const op = evt.operator?.openId ?? '';
    return op === ownerOpenId || isAdmin(cfg, op);
  };

  // ⏹/🎯 被拒点击分类反馈（M-4 / audit-03 ②）：原来三类点击全部静默吞掉，
  // 「点了毫无反应」。SDK 的 normalized cardAction 链路丢弃 handler 返回值，
  // 没有 toast 通道——用「回贴一条小注」做等价反馈，按 卡片(+操作者) 去重防
  // 连点刷屏。终态间隙（interrupt 刚卸下、runsByCard 还没清）窗口极小，保持
  // 忽略（audit-03 结论）。
  const runControlNotes = new RecentIdCache(512, 60_000);
  /** 非发起人/非管理员点 ⏹/🎯：明确告知规则。 */
  const denyRunControl = (evt: CardActionEvent, key: string, actionId: string, verb: string): void => {
    if (!runControlNotes.seen(`deny:${key}:${evt.operator?.openId ?? ''}`)) {
      void channel
        .send(evt.chatId, { markdown: `⚠️ 仅发起人或管理员可${verb}。` }, { replyTo: evt.messageId })
        .catch(() => undefined);
    }
    log.info('card', 'action', { actionId, denied: true });
  };
  /** run 已结束 / daemon 重启后的 orphan 卡：告知点击者 + 自愈成无按钮版。
   * 同进程内（终局帧被 429 风暴吞掉等）rc+stream 还在 → 重推真正的无按钮终态卡
   * （updateCard 自带终局退避）；重启后实体映射全丢 → 从载体消息反查 card_id，
   * 只删 {@link CONTROLS_EID} 控件行（其余内容无从重建；实体 seq 也丢了，用
   * epoch 秒——必大于按帧自增的运行期计数）。改版前的旧卡没有该 element_id，
   * 删除失败仅记日志（告知已发出）。卡片改动等 CARD_SETTLE_MS，避开点击互动窗。 */
  const healDeadRunCard = (evt: CardActionEvent, key: string, actionId: string): void => {
    if (runControlNotes.seen(`dead:${key}`)) return; // 已答复过 / 自愈在路上
    void channel
      .send(evt.chatId, { markdown: 'ℹ️ 该任务已结束，按钮已失效。' }, { replyTo: evt.messageId })
      .catch(() => undefined);
    const rc = runCards.get(key);
    const stream = runStreams.get(key);
    log.info('card', 'action', { actionId, orphan: true, inProcess: Boolean(rc && stream) });
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        if (rc && stream) {
          await stream.updateCard(channel, buildRunCardPlain(rc));
          return;
        }
        const res = await channel.rawClient.im.v1.message.get({ path: { message_id: key } });
        const content = (res.data as { items?: Array<{ body?: { content?: string } }> } | undefined)?.items?.[0]
          ?.body?.content;
        const cardId = content ? cardIdFromMessageContent(content) : undefined;
        if (!cardId) return;
        const seq = Math.floor(Date.now() / 1000);
        await channel.rawClient.cardkit.v1.cardElement.delete({
          path: { card_id: cardId, element_id: CONTROLS_EID },
          data: { sequence: seq, uuid: `h_${cardId}_${seq}` },
        });
      } catch (err) {
        log.fail('card', err, { phase: 'run-card-heal', key });
      }
    })();
  };

  // run card buttons (design §3.3). ⏹ (st.interrupt) sends turn/interrupt and
  // waits for the stream's own terminal — codex 0.139+ ends it with
  // turn/completed(status:"interrupted")（08b 探针实测，旧版「no mappable
  // terminal」已证伪），线程与进程留用；5s 没收尾才强停 + 杀进程（launchRun）。
  dispatcher
    .on(RC.stop, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const st = runsByCard.get(key);
      if (!st) {
        healDeadRunCard(evt, key, RC.stop);
        return;
      }
      if (!runOwnerOrAdmin(evt, st.requesterOpenId)) {
        denyRunControl(evt, key, RC.stop, '终止');
        return;
      }
      st.interrupt?.();
      log.info('card', 'action', { actionId: 'run.stop', stopped: Boolean(st.interrupt) });
    })
    // 🎯 结束目标 (goal cards): clear the goal, let the current turn finish, then
    // stop — no auto-continue. Owner-or-admin gated like ⏹.
    .on(RC.endGoal, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const st = runsByCard.get(key);
      if (!st) {
        healDeadRunCard(evt, key, RC.endGoal);
        return;
      }
      if (!runOwnerOrAdmin(evt, st.requesterOpenId)) {
        denyRunControl(evt, key, RC.endGoal, '结束目标');
        return;
      }
      st.endGoal?.();
      log.info('card', 'action', { actionId: 'goal.end', ended: Boolean(st.endGoal) });
    });

  // DM management console buttons (design §3.1). Admin-gated; sub-views patch
  // the same card in place, each carrying a ⬅️ 菜单 back button.
  const dmAdmin = (openId?: string): boolean => isAdmin(cfg, openId ?? '');
  // DM cards are CardKit entities (sendManagedCard); update them via the
  // settle-then-cardkit path so the click's callback acks first. Passing the
  // whole evt lets settleUpdate self-heal an orphaned (post-restart) card by
  // re-posting to evt.chatId.
  const patch = (evt: CardActionEvent, c: object | (() => object | Promise<object>)): void =>
    settleUpdate(evt.messageId, c, evt.chatId);

  /** open_id→姓名 三级兜底（管理员/白名单卡展示用）：
   *  1) resolveNames：contact.batch（需 contact:user.base:readonly）；
   *  2) 项目群成员名：im:chat:readonly 已开就够，含外部成员，是 contact 没开时的主力；
   *  3) 卡片回调自带的操作者姓名（若 operator 带 name）。都拿不到才降级尾号。 */
  const namesWithOperator = async (
    evt: CardActionEvent,
    ids: (string | undefined)[],
  ): Promise<Map<string, string>> => {
    const m = await resolveNames(channel, ids);
    if (ids.some((id) => id && !m.has(id))) {
      for (const mem of await fetchAllProjectMembers(channel)) if (!m.has(mem.openId)) m.set(mem.openId, mem.name);
    }
    const op = evt.operator as { openId?: string; name?: string } | undefined;
    if (op?.openId && op.name && !m.has(op.openId)) m.set(op.openId, op.name);
    return m;
  };

  // Pass { render: false } when the caller does async start/stop/repair work
  // before refreshing the unified settings card itself.
  function applyPref(
    evt: CardActionEvent,
    mut: (p: AppPreferences) => void,
    opts?: { render?: boolean },
  ): void {
    if (!dmAdmin(evt.operator?.openId)) return;
    const prefs: AppPreferences = { ...(cfg.preferences ?? {}) };
    mut(prefs);
    cfg.preferences = prefs;
    // persist in the background; the card only needs the in-memory cfg
    void saveConfig(cfg).catch((err) => log.fail('console', err, { phase: 'save-config' }));
    if (opts?.render !== false) void patch(evt, renderSettings);
  }

  // 全局设置卡现在把「本地 agent」直接内联进来（不再是子页面）。hook 安装状态要读
  // ~/.claude、~/.codex 三个文件，按需缓存：只有「打开设置」「修复 hooks」才刷新，
  // 其余无关设置（并发、假死超时…）的 re-render 复用上次结果，免每次都 3 次 fs 读。
  let cliHookStatuses: Awaited<ReturnType<typeof inspectCliBridgeHooks>> | undefined;
  async function renderSettings(refreshHooks = false): Promise<object> {
    if (refreshHooks || !cliHookStatuses) cliHookStatuses = await inspectCliBridgeHooks();
    const localAgents = cliBridgeSettingsSection({
      enabled: getCliBridgePreferences(cfg).enabled,
      statuses: cliHookStatuses,
      canEnable: canEnableCliBridge(cfg),
    });
    return buildSettingsCard(cfg, localAgents);
  }

  // Back-to-menu: the settings card is button-only (never locks) and the
  // new-project form isn't locked until it's submitted, so 返回 always lands on
  // a card we can update in place — no recall, no fresh entity needed.
  const freshMenu = (evt: CardActionEvent): void => {
    patch(evt, buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() }));
  };

  // 📊 Codex 用量：loading 卡先落地（取数走网络 1~3s），结果再原地覆盖。错误按
  // UsageError.kind 渲染对应的提示卡（未登录 / API-key 模式 / 需重登 / 波动重试）。
  // 孤儿卡自愈（与 settleUpdate 的 fallbackChatId 同语义）：重启后 byMessageId 映射
  // 已丢，updateManagedCard 返回 false（不抛错、.catch 兜不住）——loading 阶段就改发
  // 一张新卡并把结果更新指向它，否则旧菜单卡上这颗按钮就是「点了毫无反应」的死按钮。
  const runUsage = (evt: CardActionEvent, force: boolean): void => {
    if (!dmAdmin(evt.operator?.openId)) return;
    void (async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      let msgId = evt.messageId;
      const okLoading = await updateManagedCard(channel, msgId, buildUsageCard({ phase: 'loading' })).catch(
        () => false,
      );
      if (!okLoading) {
        const sent = await sendManagedCard(channel, evt.chatId, buildUsageCard({ phase: 'loading' })).catch(
          (e) => {
            log.fail('console', e, { phase: 'usage-loading' });
            return undefined;
          },
        );
        if (!sent) return;
        msgId = sent.messageId;
      }
      let state: UsageCardState;
      try {
        state = { phase: 'ready', data: await fetchUsageBundle(force) };
      } catch (err) {
        log.fail('console', err, { phase: 'usage' });
        state = {
          phase: 'error',
          kind: err instanceof UsageError ? err.kind : 'transient',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const ok = await updateManagedCard(channel, msgId, buildUsageCard(state)).catch((e) => {
        log.fail('console', e, { phase: 'usage-render' });
        return false;
      });
      if (!ok) {
        // 结果卡必须落地：原地更新失败（极小概率 loading 后实体又失效）就发新卡兜底
        await sendManagedCard(channel, evt.chatId, buildUsageCard(state)).catch((e) =>
          log.fail('console', e, { phase: 'usage-fallback' }),
        );
      }
    })();
  };

  // Build the project list card with each project's topics (sessions) grouped
  // by chatId, most-recent first — shared by the list/cancel/delete handlers.
  const renderProjectList = async (): Promise<object> => {
    const [projects, sessions] = await Promise.all([listProjects(), listSessions()]);
    const byChat = new Map<string, SessionRecord[]>();
    for (const s of sessions) {
      const arr = byChat.get(s.chatId);
      if (arr) arr.push(s);
      else byChat.set(s.chatId, [s]);
    }
    return buildProjectListCard(projects, byChat);
  };

  // 体检数据收集（codex 探测 + 飞书 scope 自检）：DM.doctor 与私聊菜单 dm.doctor
  // 直达共用，两处不各写一遍探测。force 绕过探测缓存看「现在」的状态；探测全程
  // 异步——回调里绝不能 spawnSync（同步 codex --version 会冻住所有话题的流式 pump）。
  const buildDoctorInfo = async (): Promise<DoctorInfo> => {
    const codexProbe = await backend.doctor({ force: true });
    const app = cfg.accounts.app;
    // 读 keystore 里的 App Secret → 换 token → 查已开通 scope。任一步失败时
    // missingScopes 留 undefined，卡片显示「无法自动检查」而非误报缺失。
    const secret = await getSecret(secretKeyForApp(app.id)).catch(() => undefined);
    const scopeCheck = secret
      ? await validateAppCredentials(app.id, secret, app.tenant).catch(() => undefined)
      : undefined;
    const missingScopes = scopeCheck?.missingScopes;
    const missingJoinScopes = scopeCheck?.missingJoinScopes;
    return {
      codexOk: codexProbe.ok,
      codexVer: codexProbe.version,
      conn: channel.getConnectionStatus?.()?.state ?? 'unknown',
      bridgeVer: bridgeVersion(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      logStdout: serviceStdoutPath(),
      logStderr: serviceStderrPath(),
      configFile: paths.configFile,
      missingScopes,
      // 缺失时预选缺失项（精准开通）；查不到/全开通时预选全部必需 scope 供核对。
      scopeGrantUrl: buildScopeGrantUrl(
        app.id,
        app.tenant,
        missingScopes && missingScopes.length ? missingScopes : undefined,
      ),
      missingJoinScopes,
      // 「加入存量群」按钮恒预选这两项 opt-in scope（它们不在必需清单里）。
      joinScopeGrantUrl: buildScopeGrantUrl(app.id, app.tenant, JOIN_GROUP_SCOPES),
    };
  };

  dispatcher
    .on(DM.menu, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) freshMenu(evt);
    })
    .on(DM.newProject, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) patch(evt, buildNewProjectFormCard({ backends: backendOptionsFor('full') }));
    })
    .on(DM.newProjectSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const backend = safeBackendId(formValue);
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
      const backends = backendOptionsFor('full');
      // A submitted form locks its card_id (its buttons — retry/返回 on an error
      // re-render — stop firing, and an in-place update no-ops). So the result
      // goes to a *fresh* card; the submitted form stays above as a 留痕. Detach
      // so the submit callback acks immediately (createProject is slow).
      void (async () => {
        let result;
        if (!name) result = buildNewProjectFormCard({ cwd: cwdIn, error: '项目名不能为空', backends });
        else if (!op) result = buildNewProjectFormCard({ name, cwd: cwdIn, error: '无法识别操作者身份', backends });
        else {
          try {
            const p = await createProject(channel, { name, ownerOpenId: op, existingPath: cwdIn || undefined, kind, backend });
            log.info('console', 'new-project', { name: p.name, blank: p.blank, backend: p.backend });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildNewProjectFormCard({ name, cwd: cwdIn, error: err instanceof Error ? err.message : String(err), backends });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'new-project-result' }),
        );
      })();
    })
    .on(DM.joinGroupSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const chatId = typeof value.chatId === 'string' ? value.chatId : '';
      const backend = safeBackendId(formValue);
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
      // 列「全后端」（full 档过滤面 = 已下载的都列，含 claude 系）。默认仍是 codex（列表
      // 首项），绑定后按所选后端定档：codex→qa（外部群安全默认）、claude→full（见 bindModeFor）。
      const backends = backendOptionsFor('full');
      // Same fresh-card pattern as DM.newProjectSubmit: a submitted form locks
      // its card_id, so the result goes to a new card while the form stays above
      // as a 留痕. Detached so the click acks immediately (join is slow).
      void (async () => {
        let result;
        if (!chatId)
          result = buildJoinGroupFormCard({ chatId: '', name, cwd: cwdIn, error: '缺少群标识，请重新从进群通知里打开绑定卡', backends });
        else if (!name) result = buildJoinGroupFormCard({ chatId, cwd: cwdIn, error: '项目名不能为空', backends });
        else if (!op) result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, error: '无法识别操作者身份', backends });
        else {
          try {
            const p = await joinExistingGroup(channel, { name, chatId, addedBy: op, existingPath: cwdIn || undefined, kind, backend, mode: bindModeFor(backend) });
            log.info('console', 'join-group', { name: p.name, blank: p.blank, backend: p.backend, mode: p.mode });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, error: err instanceof Error ? err.message : String(err), backends });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'join-group-result' }),
        );
      })();
    })
    .on(DM.projects, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, renderProjectList);
    })
    .on(DM.settings, async ({ evt }) => {
      // Opening 设置 is the moment to re-read hook install status from disk.
      if (dmAdmin(evt.operator?.openId)) await patch(evt, () => renderSettings(true));
    })
    .on(CLI.toggleEnabled, async ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const enabled = value.v === 'on';
      if (enabled && !canEnableCliBridge(cfg).ok) return;
      try {
        if (enabled) {
          await cliBridge?.start?.();
          applyPref(evt, (p) => {
            p.cliBridge = { ...(p.cliBridge ?? {}), enabled: true };
          }, { render: false });
        } else {
          applyPref(evt, (p) => {
            p.cliBridge = { ...(p.cliBridge ?? {}), enabled: false };
          }, { render: false });
          await cliBridge?.shutdown?.();
        }
      } catch (err) {
        log.fail('cli-bridge', err, { phase: enabled ? 'enable' : 'disable' });
      }
      void patch(evt, renderSettings);
    })
    .on(CLI.repairHooks, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      // installCliBridgeHooks does raw fs writes (~/.claude, ~/.codex) that can
      // throw (EACCES/ENOSPC); keep it inside the awaited handler so the
      // dispatcher's try/catch covers it — there is no global rejection net
      // (see cli-bridge/ipc.ts). Still refresh the card on failure.
      try {
        await installCliBridgeHooks({
          agents: { claude: true, codex: true },
          command: resolveBridgeHookCommand(cfg.accounts.app.id),
        });
      } catch (err) {
        log.fail('cli-bridge', err, { phase: 'repair-hooks' });
      }
      // Just wrote the hook files — force a fresh inspect so the status reflects it.
      await patch(evt, () => renderSettings(true));
    })
    .on(DM.doctor, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      // A reply card (not a patch of the menu) so the diagnosis persists below
      // the console; re-open the menu by messaging the bot. 探测逻辑见 buildDoctorInfo。
      await sendManagedCard(channel, evt.chatId, buildDoctorCard(await buildDoctorInfo()), evt.messageId).catch((err) =>
        log.fail('console', err, { cmd: 'doctor' }),
      );
    })
    .on(DM.reconnect, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const conn = channel.getConnectionStatus?.()?.state ?? 'unknown';
      await sendManagedCard(channel, evt.chatId, buildReconnectCard(conn), evt.messageId).catch((err) =>
        log.fail('console', err, { cmd: 'reconnect' }),
      );
    })
    // 版本更新（检查）：查 npm 最新版，渲染结果。npm view 走异步 execFile —— 卡片
    // 回调里**绝不能** spawnSync，否则冻结整条 event loop。先 settle 再更新，避开
    // 点击回调窗口；checking→checked 是顺序 await，天然有序。
    .on(DM.update, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void (async () => {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        await updateManagedCard(channel, evt.messageId, buildUpdateCard({ phase: 'checking' })).catch(
          () => undefined,
        );
        const current = currentVersion();
        const latest = await latestVersion().catch(() => null);
        const hasUpdate = !!latest && isNewer(latest, current);
        log.info('console', 'update-check', { current, latest, hasUpdate });
        await updateManagedCard(
          channel,
          evt.messageId,
          buildUpdateCard({ phase: 'checked', current, latest, hasUpdate, dev: isDevSource() }),
        ).catch((e) => log.fail('console', e, { phase: 'update-check' }));
      })();
    })
    // 版本更新（执行）：npm i -g 最新版（async spawn），成功后**先发完成卡再**重启
    // daemon —— restart 会 kill 掉当前这个 daemon 进程（卡片回调就跑在它里面），所以
    // 必须等完成卡渲染落地后再触发 restart，否则用户看不到结果。
    .on(DM.updateDo, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void (async () => {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        const from = currentVersion();
        await updateManagedCard(channel, evt.messageId, buildUpdateCard({ phase: 'updating', from })).catch(
          () => undefined,
        );
        const res = await installLatest();
        if (!res.ok) {
          log.info('console', 'update-failed', { from });
          await updateManagedCard(
            channel,
            evt.messageId,
            buildUpdateCard({ phase: 'error', from, message: res.message }),
          ).catch((e) => log.fail('console', e, { phase: 'update-error' }));
          return;
        }
        const to = currentVersion();
        const willRestart = daemonRunning();
        log.info('console', 'update-done', { from, to, willRestart });
        await updateManagedCard(
          channel,
          evt.messageId,
          buildUpdateCard({ phase: 'done', from, to, willRestart }),
        ).catch((e) => log.fail('console', e, { phase: 'update-done' }));
        if (willRestart) {
          // 给完成卡一点渲染时间，再让 launchd 重启（kill 自己）。
          await new Promise((r) => setTimeout(r, 800));
          await restartDaemon().catch((e) => log.fail('console', e, { phase: 'update-restart' }));
        }
      })();
    })
    // 📊 Codex 用量：loading → 并行拉 wham/usage + wham/profiles/me → 原地更新结果卡。
    // 同 DM.update 的双阶段模式：handler 立即返回让 SDK ack，慢活全在 settle 之后。
    .on(DM.usage, ({ evt }) => runUsage(evt, false))
    .on(DM.usageRefresh, ({ evt }) => runUsage(evt, true))
    // 分享：先弹「选择分享内容」表单卡（多选区块，不选=全部），提交后按所选区块
    // 动态拼装一张**新的**纯展示卡（不动控制台卡）——它零按钮、不再更新，数据定格
    // 在生成时刻，用户长按/右键即可原生转发（流式卡/带回调的卡转发会出问题）。
    .on(DM.usageShare, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, buildShareConfigCard());
    })
    .on(DM.usageShareDo, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const sections = parseShareSections(formValue?.secs);
      void (async () => {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        try {
          const data = await fetchUsageBundle();
          await sendManagedCard(channel, evt.chatId, buildUsageShareCard(data, { sections }), evt.messageId);
          log.info('console', 'usage-share', { sections: [...sections].join(',') });
          // 配置卡原地换成「已生成」态（带新表单，可换组合再来一张）
          await updateManagedCard(channel, evt.messageId, buildShareConfigCard(true)).catch(() => undefined);
        } catch (err) {
          log.fail('console', err, { phase: 'usage-share' });
          const reason = err instanceof UsageError ? err.message : '拉取用量数据失败';
          await channel
            .send(evt.chatId, { markdown: `⚠️ 生成分享卡失败：${reason}` }, { replyTo: evt.messageId })
            .catch(() => undefined);
        }
      })();
    })
    .on(DM.rmConfirm, async ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      if (!dmAdmin(evt.operator?.openId) || !name) return;
      const proj = (await listProjects()).find((p) => p.name === name);
      await patch(evt, buildRmConfirmCard(name, proj?.origin));
    })
    .on(DM.rmCancel, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, renderProjectList);
    })
    .on(DM.rmDo, ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      const op = evt.operator?.openId;
      if (!dmAdmin(op) || !name) return;
      // all the slow work (remove + owner transfer/leave + reply) runs in the
      // settle builder so the click acks immediately. The announcement vanishes
      // with the group once the owner dissolves it, so nothing to clean up here.
      patch(evt, async () => {
        const removed = await removeProject(name);
        let tail: string;
        if (removed && (removed.origin ?? 'created') === 'joined') {
          // joined group: the bot is a plain member, not the owner — it just
          // leaves (never disbands; the group is the user's). Best-effort.
          const left = removed.chatId
            ? await leaveChat(channel, removed.chatId)
                .then(() => true)
                .catch((err) => {
                  log.fail('console', err, { phase: 'leave-chat' });
                  return false;
                })
            : false;
          log.info('console', 'rm', { name, origin: 'joined', left });
          tail = left
            ? '我已退出该群（群是你们的，不会解散）。'
            : '⚠️ 我退群失败（可能权限不足），可在群里手动把我移除。';
        } else {
          let transferred = false;
          if (removed?.chatId && op) {
            transferred = await transferOwnership(channel, removed.chatId, op)
              .then(() => true)
              .catch((err) => {
                log.fail('console', err, { phase: 'owner-transfer' });
                return false;
              });
          }
          log.info('console', 'rm', { name, origin: 'created', transferred });
          tail = transferred
            ? '群主已转给你 → 请在飞书里**自行解散该群**（机器人不主动解散）。'
            : '⚠️ 群主转让失败（可能 bot 非群主），请用「🚪 群管理」手动转让后解散。';
        }
        await channel
          .send(evt.chatId, { markdown: `✅ 已删除项目「${name}」（解绑，未删代码目录）。\n${tail}` }, { replyTo: evt.messageId })
          .catch(() => undefined);
        return renderProjectList();
      });
    })
    // Each setting is a row of option buttons; the click's `v` is the chosen value.
    .on(DM.setTools, ({ evt, value }) => {
      applyPref(evt, (p) => (p.showToolCalls = value.v === 'on'));
    })
    .on(DM.setShowModel, ({ evt, value }) => {
      applyPref(evt, (p) => {
        p.showModel = value.v === 'running' ? 'running' : value.v === 'always' ? 'always' : 'off';
      });
    })
    .on(DM.setWatchdog, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n)) applyPref(evt, (p) => (p.runIdleTimeoutSeconds = n));
    })
    // 「自定义…」→ 打开输入卡（设置卡本身保持纯按钮、不会锁死）
    .on(DM.watchdogCustom, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, buildWatchdogCustomCard(cfg));
    })
    // 保存自定义秒数：钳到 [MIN, MAX]（0=关闭）后写入，确保存的值即为生效值；
    // applyPref 落盘并 patch 回设置卡，currentIdleMs() 下一轮立即读到新值。
    .on(DM.watchdogCustomSubmit, ({ evt, formValue }) => {
      const raw = String(formValue?.sec ?? '').trim();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        void patch(evt, buildWatchdogCustomCard(cfg));
        return;
      }
      const sec =
        n === 0 ? 0 : Math.min(Math.max(Math.floor(n), RUN_IDLE_TIMEOUT_MIN_SEC), RUN_IDLE_TIMEOUT_MAX_SEC);
      applyPref(evt, (p) => (p.runIdleTimeoutSeconds = sec));
    })
    .on(DM.setPending, ({ evt, value }) => {
      if (value.v === 'steer' || value.v === 'queue') applyPref(evt, (p) => (p.pendingPolicy = value.v as PendingPolicy));
    })
    .on(DM.setConcurrency, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n)) applyPref(evt, (p) => (p.maxConcurrentRuns = n));
    })
    // In-group settings: toggle 免@ for the project bound to evt.chatId. Admin-gated.
    // 写路径走管理面共享层（admin/ops.ts）——与 DM 卡片 / Web 控制台同一套落盘逻辑。
    .on(GS.setNoMention, ({ evt, value }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      const on = value.v === 'on';
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (project) {
          const r = await performSetNoMention({ projectName: project.name, on });
          log.info('console', 'group-nomention', { project: project.name, on });
          return buildGroupSettingsCard(r.ok ? r.project : { ...project, noMention: on });
        }
        return buildGroupSettingsCard({ name: '本群', kind: 'multi', noMention: on });
      });
    })
    .on(GS.setAutoCompact, ({ evt, value }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      const on = value.v === 'on';
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (project) {
          // 共享层落盘 + 驱逐活跃会话（压缩上限在 thread/start 绑定，驱逐后下一条
          // 消息重绑生效——与 🔐 权限同语义）。
          const r = await performSetAutoCompact({ projectName: project.name, on, evictLiveSessionsForChat });
          log.info('console', 'group-autocompact', { project: project.name, on });
          return buildGroupSettingsCard(r.ok ? r.project : { ...project, autoCompact: on });
        }
        return buildGroupSettingsCard({ name: '本群', kind: 'multi', autoCompact: on });
      });
    })
    // ── 权限管理回调（admins 全局 / 项目响应白名单）。均 dmAdmin 门控（私聊管理台）。
    // 列表卡用 patch 原地重渲染（纯按钮不锁）；加人是 form 提交，结果发**新卡**（旧表单
    // 留痕），规避 select 锁卡。owner 恒在 admins 名单顶、不可删。
    .on(DM.admins, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, async () =>
        buildAdminsCard(cfg, await namesWithOperator(evt, [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])])),
      );
    })
    .on(DM.addAdminForm, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, async () => {
        const all = await fetchAllProjectMembers(channel);
        const members = all.filter((m) => !isAdmin(cfg, m.openId)); // 排除已是 admin/owner 的
        return buildAddAdminCard(members);
      });
    })
    .on(DM.addAdminSubmit, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const manual = String(formValue?.open_id ?? '').trim();
      const id = manual.startsWith('ou_') ? manual : pickOpenId(formValue);
      log.info('console', 'admin-add', { picked: id?.slice(-6) ?? null });
      void (async () => {
        if (id) {
          const access: AppAccess = { ...(cfg.preferences?.access ?? {}) };
          access.ownerOpenId ??= resolveOwner(cfg);
          access.admins = Array.from(new Set([...(access.admins ?? []), id]));
          cfg.preferences = { ...(cfg.preferences ?? {}), access };
          await saveConfig(cfg).catch((e) => log.fail('console', e, { phase: 'save-config' }));
        }
        const ids = [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])];
        const next = buildAdminsCard(cfg, await namesWithOperator(evt, ids));
        await sendManagedCard(channel, evt.chatId, next).catch((e) => log.fail('console', e, { phase: 'admin-add-result' }));
      })();
    })
    .on(DM.rmAdmin, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const id = typeof value.u === 'string' ? value.u : '';
      patch(evt, async () => {
        if (id && id !== resolveOwner(cfg)) {
          const access: AppAccess = { ...(cfg.preferences?.access ?? {}) };
          access.ownerOpenId ??= resolveOwner(cfg);
          access.admins = (access.admins ?? []).filter((x) => x !== id);
          cfg.preferences = { ...(cfg.preferences ?? {}), access };
          await saveConfig(cfg).catch((e) => log.fail('console', e, { phase: 'save-config' }));
        }
        const ids = [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])];
        return buildAdminsCard(cfg, await namesWithOperator(evt, ids));
      });
    })
    .on(DM.allowlist, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() });
        return buildAllowlistCard(p, await namesWithOperator(evt, p.allowedUsers ?? []));
      });
    })
    .on(DM.addAllowedForm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      if (!name) return;
      patch(evt, async () => {
        const p = await getProjectByName(name);
        const members = p?.chatId ? await fetchChatMembers(channel, p.chatId) : [];
        return buildAddAllowedCard(name, members);
      });
    })
    .on(DM.addAllowedSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const manual = String(formValue?.open_id ?? '').trim();
      const id = manual.startsWith('ou_') ? manual : pickOpenId(formValue);
      log.info('console', 'allow-add', { project: name, picked: id?.slice(-6) ?? null });
      void (async () => {
        // 函数式 updater：在 registry 临界区内基于最新盘值 append 去重，避免并发丢更新。
        if (id) await updateProject(name, (p) => ({ allowedUsers: Array.from(new Set([...(p.allowedUsers ?? []), id])) }));
        const fresh = await getProjectByName(name); // 写后回读，卡片显示与盘上一致
        if (!fresh) return;
        const card = buildAllowlistCard(fresh, await namesWithOperator(evt, fresh.allowedUsers ?? []));
        await sendManagedCard(channel, evt.chatId, card).catch((e) => log.fail('console', e, { phase: 'allow-add-result' }));
      })();
    })
    .on(DM.rmAllowed, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const id = typeof value.u === 'string' ? value.u : '';
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        await updateProject(name, (p) => ({ allowedUsers: (p.allowedUsers ?? []).filter((x) => x !== id) }));
        const fresh = await getProjectByName(name); // 写后回读，与盘上一致
        if (!fresh) return buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() });
        return buildAllowlistCard(fresh, await namesWithOperator(evt, fresh.allowedUsers ?? []));
      });
    })
    // 项目设置卡（可扩展容器）：打开 + DM 版免@开关（携带项目名 n，不能靠 evt.chatId）。
    .on(DM.projectSettings, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? buildProjectSettingsCard(p, backendDisplayName(p.backend)) : buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() });
      });
    })
    .on(DM.projectTopics, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() });
        const sessions = (await listSessions()).filter((s) => s.chatId === p.chatId);
        return buildProjectTopicsCard(p, sessions);
      });
    })
    // 写路径走管理面共享层（admin/ops.ts）——与 Web 控制台同一套校验/落盘/驱逐。
    .on(DM.setNoMentionDm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const on = value.v === 'on';
      patch(evt, async () => {
        const r = await performSetNoMention({ projectName: name, on });
        if (!r.ok) return buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() });
        return buildProjectSettingsCard(r.project, backendDisplayName(r.project.backend));
      });
    })
    .on(DM.setAutoCompactDm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const on = value.v === 'on';
      patch(evt, async () => {
        // 共享层落盘 + 驱逐活跃会话（压缩上限在 thread/start 绑定，驱逐后下一条
        // 消息重绑生效——mirrors 群设置）。
        const r = await performSetAutoCompact({ projectName: name, on, evictLiveSessionsForChat });
        if (!r.ok) return buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() });
        log.info('console', 'project-autocompact', { project: name, on });
        return buildProjectSettingsCard(r.project, backendDisplayName(r.project.backend));
      });
    })
    // 🔐 权限：打开下拉表单子卡（管理员档 + 普通用户档 + 联网，选完提交）。
    .on(DM.permission, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? buildPermissionCard(p) : buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() });
      });
    })
    // 提交权限表单：落盘 管理员档 mode / 普通用户档 guestMode / 联网，再驱逐本项目活跃会话
    // 让新档立即生效（沙箱在 thread/start 绑定后不可变）。表单卡 card_id 提交后会锁，故发
    // 一张全新的项目设置卡（旧表单卡留痕），不 patch 原卡。
    .on(DM.permissionSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const mode = asTier(selectValue(formValue, 'mode'));
      const guestMode = asTier(selectValue(formValue, 'guestMode'));
      const network = selectValue(formValue, 'network') === 'on';
      void (async () => {
        // 共享层（admin/ops.ts）：落盘 + 驱逐活跃会话让新档立即生效；写后回读，
        // 卡片与盘上一致——与 Web 控制台的 setPermissionMode 完全同一条路径。
        const r = await performSetPermissionMode({ projectName: name, mode, guestMode, network, evictLiveSessionsForChat });
        if (!r.ok) return;
        log.info('console', 'permission', { project: name, mode, guestMode, network });
        await sendManagedCard(channel, evt.chatId, buildProjectSettingsCard(r.project, backendDisplayName(r.project.backend))).catch((e) =>
          log.fail('console', e, { phase: 'permission-result' }),
        );
      })();
    });
  // 〔已移除〕DM.backend / DM.backendSubmit 处理器（项目后端「运行时切换」检测卡 +
  // 单点切换）。产品改为「创建时选定、运行时固定、不支持切换」后整条路径废弃：UI 入口
  // 已撤、卡构建器（buildBackendDetectingCard/PickerCard）已删；防御仍在 performBackendSwitch
  // （已设 backend 切异值即拒）。创建时选后端见 DM.newProjectSubmit。

  /**
   * From a /resume card: read the past thread's transcript, post a collapsible
   * history card as reply_in_thread (which creates the topic) and bind the codex
   * thread to that topic. No filler turn — the session resumes lazily on the
   * topic's first message via {@link resolveThread}, so the user just continues.
   * Detached — never holds the card-action callback for the whole flow. On
   * failure the picker card flips to a (non-retryable) error and pending clears.
   */
  async function resumeFromCard(
    evt: CardActionEvent,
    state: ResumeCardState,
    sessionId: string,
    backendId?: string,
  ): Promise<void> {
    // The backend that listed this session (from the button value / card state);
    // unset on legacy cards → default (codex), the historical behavior.
    const be = backendFor(backendId);
    try {
      // thread/read: fetch the transcript without starting a turn or holding the
      // session live (model/effort left to the thread's own remembered config).
      // Never throws — empty history just yields a minimal card.
      const history = await be.readHistory(state.cwd, sessionId);
      resumePending.delete(evt.messageId);

      let bound = false;
      await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
        const cardState: HistoryCardState = { cwd: state.cwd, projectName: state.projectName, history };
        // reply_in_thread on the /resume message turns it into the topic; the
        // history card is that topic's first message.
        const sent = await sendManagedCard(channel, state.chatId, buildHistoryCard(cardState), state.originalMsgId, true);
        // Binding the codex thread to the topic hinges entirely on resolving the
        // topic thread_id (no live thread to fall back on, unlike the run path) —
        // a miss would make the next message start a FRESH empty session. The
        // reply response omits thread_id and the raw lookup can lag right after
        // the reply, so retry a few times before giving up.
        const tid = await getThreadId(channel, sent.messageId, 4);
        if (tid) {
          const now = Date.now();
          await upsertSession({
            threadId: tid,
            chatId: state.chatId,
            cwd: state.cwd,
            sessionId,
            backend: be.id,
            summary: history.name || history.preview || '(恢复会话)',
            createdAt: now,
            updatedAt: now,
          });
          bound = true;
        } else {
          log.warn('card', 'resume-no-threadid', { messageId: sent.messageId });
        }
        log.info('card', 'resume-done', { sessionId, threadId: tid ?? null, bound, turns: history.totalTurns });
      });

      // Only promise continuity once the thread is actually bound — else the
      // next message silently starts a fresh session, so say so instead of
      // claiming success. settleUpdate keeps this ordered after the launching
      // card the RES.pick handler settle-pushed (normally the done push runs
      // last; a 200810 retry on the launching push could in theory reorder, but
      // the 500ms settle window avoids that in practice).
      settleUpdate(
        evt.messageId,
        bound
          ? buildResumeDoneCard(state)
          : buildResumeErrorCard(state, '已建话题但未能绑定会话，请重新 /resume'),
      );
    } catch (err) {
      state.launching = false;
      log.fail('card', err, { phase: 'resume-launch' });
      settleUpdate(evt.messageId, buildResumeErrorCard(state, err instanceof Error ? err.message : String(err)));
    }
  }

  // ── shared run loop ───────────────────────────────────────────────
  interface LaunchOpts {
    chatId: string;
    replyTo: string;
    /** true on first reply that creates the topic; subsequent replies use replyTo only */
    replyInThread?: boolean;
    thread: AgentThread;
    firstText: string;
    /** local image paths for the FIRST turn (codex reads them as localImage) */
    images?: string[];
    /** when the topic thread_id is already known (turn in an existing topic) */
    knownThreadId?: string;
    model?: string;
    effort?: ReasoningEffort;
    cwd?: string;
    summary?: string;
    /** who triggered this run (for ⏹/⚙️ ownership gating) */
    requesterOpenId?: string;
    /** single-session group: reply by quoting (no reply_in_thread / topic). */
    flat?: boolean;
    /** when admin/guest tiers are split: 'admin'|'guest' to namespace the
     * resolved topic key so the two roles never share a thread (see turnSession). */
    roleSuffix?: 'admin' | 'guest';
    /** the backend that created `thread` (persisted into the SessionRecord so a
     * restart resumes on the same runtime). Unset → default (codex). */
    backendId?: string;
    /** prefetched SessionRecord for the FIRST turn (M-1 极限提前)：免掉编织完成
     * 与 turn/start 之间的 getSession 读盘。`null` = 确知没有记录（全新会话）；
     * undefined = 没预取，照旧读。后续排队轮永远重读（⚙️ 可能改了 model）。 */
    firstRec?: SessionRecord | null;
    /** intake-phase durations (ms, FIRST turn only) for the stream.timing line:
     * tResolve = resolveThread/startThread settled, tWeave = 编织完成（含话题
     * 上文投机拉取），both measured from intake start (M-1 observability). */
    timing?: { tResolve: number; tWeave: number };
  }

  /** The queue placeholder card's CardKit entity, handed to the run for in-place
   * reuse (占位卡→run 卡同一实体翻面，防闪烁). */
  interface QueuedCardHandle {
    stream: RunCardStream;
    msgId: string;
  }

  /**
   * M-3 排队可见可取消：拿全局并发槽。池有空位 → 直接 acquire（与旧行为一致，
   * 无卡）。池满 → 先发「⏳ 排队中（第 N 位）+ ⏹ 取消」占位卡再进 FIFO 队列：
   * 位置变化原地刷新；等待期 ⏹（走既有 RC.stop 回调 → state.interrupt）解析为
   * 「移除 waiter + 释放预订」（active/sessions/进程全回收，占位卡翻「已取消」
   * 终态）。返回 null = 等待期被取消；否则带回 release 与占位卡实体 ——
   * launchRun 的首轮 run 卡复用同一张 CardKit 实体原地翻面（不闪烁），goal 则
   * 把它翻成「已开始执行」短报（goal 的 run 卡按 turn 懒建，不能钉死在一张上）。
   */
  async function acquireRunSlot(
    opts: LaunchOpts,
    state: ActiveState,
    activeKey: string,
    reaction?: RunReaction,
  ): Promise<{ release: () => void; queuedCard?: QueuedCardHandle } | null> {
    if (sema.hasFree()) return { release: await sema.acquire() };
    const stream = new RunCardStream();
    let msgId: string | undefined;
    const q = sema.enqueue((pos) => {
      // 前面有人拿到槽/取消 → 原地刷新位置。走合并泵（非阻塞、合并、限频）。
      if (msgId) stream.streamCoalesced(channel, buildQueuedCard({ position: pos, cardKey: msgId }), null);
    });
    try {
      msgId = await stream.create(channel, opts.chatId, buildQueuedCard({ position: q.position() }), {
        replyTo: opts.replyTo,
        replyInThread: opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId)),
      });
      // 自指按钮（m = 自己的 messageId）只能在拿到 messageId 后补上。建卡 RTT 里
      // 槽可能已到手（position()=0）——那就不补按钮，run 卡马上原地接管。
      const pos = q.position();
      if (pos > 0) await stream.updateCard(channel, buildQueuedCard({ position: pos, cardKey: msgId }));
      runsByCard.set(msgId, state);
      runStreams.set(msgId, stream);
    } catch (err) {
      // 占位卡失败不阻断排队：没有卡只是不可见/不可取消，run 照常等槽。
      log.fail('card', err, { phase: 'queued-card' });
    }
    log.info('intake', 'run-queued', { position: q.position(), key: activeKey });
    // 等待期 ⏹ = 移除 waiter + 释放预订。槽已到手的瞬间 cancel() 返回 false →
    // 让位给运行期 interrupt（launchRun 每轮重装）。
    state.interrupt = () => {
      if (!q.cancel()) return;
      active.delete(activeKey);
      if (opts.knownThreadId) sessions.delete(opts.knownThreadId);
      // 还没跑过任何 turn：直接回收进程。持久化记录保留，重发消息经 resume 兜底。
      void opts.thread.close().catch(() => undefined);
      if (msgId) {
        runsByCard.delete(msgId);
        runStreams.delete(msgId);
        void stream.updateCard(channel, buildQueuedCard({ cancelled: true, dropped: state.queue.length }));
      }
      reaction?.done();
      log.info('card', 'action', { actionId: 'run.stop', queuedCancel: true });
    };
    const release = await q.acquired;
    state.interrupt = undefined;
    if (!release) return null; // 已取消：占位卡已翻终态，预订已释放
    return { release, queuedCard: msgId ? { stream, msgId } : undefined };
  }

  async function launchRun(
    opts: LaunchOpts,
    reaction?: RunReaction,
    onTopicCreated?: () => void,
  ): Promise<void> {
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    // Reuse the reservation handleTurn made for this session (so messages
    // queued during startup aren't lost); fall back to a fresh state otherwise.
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId };
    state.thread = opts.thread;
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
    active.set(activeKey, state);
    if (opts.knownThreadId) trackSession(opts.knownThreadId, opts.thread);

    // M-3: 池满先排队（占位卡可见可取消）；null = 等待期被 ⏹ 取消，预订已释放。
    const slot = await acquireRunSlot(opts, state, activeKey, reaction);
    if (!slot) return;
    const { release } = slot;
    let queuedCard = slot.queuedCard;
    reaction?.started(); // slot acquired → flip OneSecond → Typing
    let firstCardSent = false;

    const persist = async (threadId: string): Promise<void> => {
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: opts.cwd ?? fallbackCwd,
        sessionId: opts.thread.sessionId,
        backend: opts.backendId ?? DEFAULT_BACKEND_ID,
        model: opts.model,
        effort: opts.effort,
        summary: opts.summary ?? opts.firstText.slice(0, 80),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch((err) => log.fail('console', err, { phase: 'persist-session', threadId }));
    };

    /** Demote the previous turn's card (drop its ⚙️) and promote this one. */
    const promoteCard = (cardMsgId: string, rc: RunCardState): void => {
      if (!topicThreadId) return;
      const prev = lastRunCard.get(topicThreadId);
      if (prev && prev !== cardMsgId) {
        const prevState = runCards.get(prev);
        const prevStream = runStreams.get(prev);
        if (prevState && prevStream) void prevStream.updateCard(channel, buildRunCardPlain(prevState));
        runCards.delete(prev);
        runStreams.delete(prev);
      }
      lastRunCard.set(topicThreadId, cardMsgId);
      runCards.set(cardMsgId, rc);
    };

    // tracks the latest run card key so the finally can clear runsByCard even
    // if the stream producer throws mid-turn (avoids leaking a stale stop target)
    let curCardKey: string | undefined;
    // intake durations ride the FIRST turn's stream.timing line only (M-1)
    let intake = opts.timing;
    let firstRec = opts.firstRec;
    try {
      let turnInput: AgentInput = { text: opts.firstText, images: opts.images };
      let replyTo = opts.replyTo;
      let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));
      for (;;) {
        // per-turn model/effort: prefer latest persisted (⚙️ may have changed it).
        // First turn uses the intake-prefetched record (null = known absent) so
        // runStreamed — i.e. turn/start — fires with zero awaits after weaving.
        const rec =
          firstRec !== undefined ? (firstRec ?? undefined) : topicThreadId ? await getSession(topicThreadId) : undefined;
        firstRec = undefined;
        const turnModel = rec?.model ?? opts.model;
        const turnEffort = rec?.effort ?? opts.effort;
        const modelDisp = getModelDisplay(cfg);
        const run = opts.thread.runStreamed(turnInput, { model: turnModel, effort: turnEffort });
        const turnStartAt = Date.now(); // turn/start 已在 runStreamed() 内发出（与下面的建卡并行）
        state.run = run;
        const render = new RunRender();
        render.showTools = getShowToolCalls(cfg);
        let cardMsgId: string | undefined;
        const rc: RunCardState = {
          rs: render.snapshot(),
          requesterOpenId: opts.requesterOpenId,
          showTools: render.showTools,
          // 模型显示档位：footnote 本轮 model·推理强度；always 档终态卡也保留。
          ...(modelDisp !== 'off' && turnModel
            ? { model: turnModel, effort: turnEffort, modelOnTerminal: modelDisp === 'always' }
            : {}),
        };

        const adoptThreadId = async (messageId: string): Promise<void> => {
          if (activeKey.startsWith('pending:')) {
            const tid = await getThreadId(channel, messageId, 3); // F8: 单次抖动别滞留 pending:
            if (tid) {
              // Logical session key = real Feishu topic id + role suffix (when
              // admin/guest tiers are split), so the two roles keep separate
              // threads in the same topic. Feishu reply targeting uses messageId,
              // not this key, so the suffix is purely bridge-internal.
              const key = opts.roleSuffix ? `${tid}#${opts.roleSuffix}` : tid;
              active.delete(activeKey);
              active.set(key, state);
              trackSession(key, opts.thread);
              activeKey = key;
              topicThreadId = key;
              rc.threadId = key;
              await persist(key);
            }
          } else {
            topicThreadId = activeKey;
            rc.threadId = activeKey;
          }
        };

        // CardKit streaming entity: body streams with the native typewriter,
        // ⏹/⚙️ ride whole-card updates — both on one card_id (see RunCardStream).
        const stream = queuedCard?.stream ?? new RunCardStream();
        const tCreate = Date.now();
        try {
          if (queuedCard) {
            // 占位卡→run 卡：同一 CardKit 实体 whole-card update 原地翻面（不闪
            // 烁、不留垃圾卡）。update 的 card JSON 带 streaming_mode=true；若该
            // 设置未随 update 生效，首次元素推送的 300309 自愈路径会重开
            // streaming 并重推（见 RunCardStream.streamElement）。
            cardMsgId = queuedCard.msgId;
            queuedCard = undefined; // 只复用一次；排队续轮照常新建卡
            await stream.updateCard(channel, buildRunCard(rc));
          } else {
            cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(rc), { replyTo, replyInThread });
          }
        } catch (err) {
          // turn/start 已提前发出：建卡失败时模型已在跑，必须中断并回收进程——
          // 无人消费的通知流会污染该 thread 的下一轮。turnId 此时多半还没到手
          // （事件尚未消费），abort 仅尽力而为；close() SIGKILL 子进程兜底终结
          // 这轮。下一条消息经 resolveThread 的 resume 兜底自愈。
          const tid = run.turnId();
          if (tid) void opts.thread.abort(tid).catch(() => undefined);
          void opts.thread.close().catch(() => undefined);
          if (topicThreadId) sessions.delete(topicThreadId);
          throw err; // 外层 catch 把错误回给用户
        }
        const tCardCreate = Date.now() - tCreate; // 建卡 RTT（与模型推理并行付出）
        curCardKey = cardMsgId;
        rc.cardKey = cardMsgId;
        runsByCard.set(cardMsgId, state);
        runStreams.set(cardMsgId, stream);
        await adoptThreadId(cardMsgId);
        // first card is live = topic created. The 群@bot 建话题 path flips its
        // reaction to DONE here (creating the topic is the acked action), unlike
        // an in-topic turn which holds Typing until the reply itself ends.
        if (!firstCardSent) {
          firstCardSent = true;
          try {
            onTopicCreated?.();
          } catch {
            /* reaction is best-effort */
          }
        }

        // ⏹ 终止（QW-15）：发 turn/interrupt 后等事件流**自然 done** —— codex
        // 0.139+ 实测 interrupt 4ms 返回、turn/completed(status:"interrupted")
        // 干净收尾（.plans/auto-optimize/research/08b-interrupt-probe.md；旧注释
        // 「no mappable terminal — the stream just hangs」是旧版行为，已证伪），
        // event-map 把 turn/completed 映射为 done，消费循环自然终止 → 线程与
        // 进程留用，下一条消息免 resume 冷启。turnId 未到手或 5s 内没收尾
        // （版本旧 / 挂死）才经 stopSignal 强停本地循环，按原样走杀进程恢复锤。
        // watchdog 超时（timedOut）不变，恒走杀进程。
        let timedOut = false;
        let resolveStop!: () => void;
        const stopSignal = new Promise<void>((res) => {
          resolveStop = res;
        });
        const stopper = createGracefulInterrupt({
          turnId: () => run.turnId(),
          abort: (tid) => void opts.thread.abort(tid).catch(() => undefined),
          forceStop: resolveStop,
        });
        state.interrupt = stopper.interrupt;
        const idleMs = currentIdleMs();
        const guarded = withIdleTimeout(
          run.events,
          idleMs,
          () => {
            timedOut = true;
          },
          stopSignal,
          run.lastActivity, // raw-notification liveness: a long shell command isn't "idle"
        );
        // Per-turn stream-latency observability (file log `stream.timing`): locates
        // where a reply lags — first byte, backlog (lastEv vs done), push split, RTT.
        const tStart = Date.now();
        let firstEvAt = 0;
        let firstTextAt = 0;
        let lastEvAt = tStart;
        let evCount = 0;
        let textChars = 0;
        for await (const ev of guarded) {
          const tEv = Date.now();
          if (!firstEvAt) firstEvAt = tEv;
          const et = (ev as { type?: string }).type;
          if (et === 'text_delta') {
            if (!firstTextAt) firstTextAt = tEv;
            const d = (ev as { delta?: string }).delta;
            if (typeof d === 'string') textChars += d.length;
          }
          lastEvAt = tEv;
          evCount++;
          // Track context usage for /context, and surface an auto-compact notice.
          if (et === 'context_usage' && topicThreadId) {
            const cu = ev as { usedTokens: number; contextWindow: number | null };
            lastUsage.set(topicThreadId, { used: cu.usedTokens, window: cu.contextWindow });
          } else if (et === 'context_compacted') {
            // Only genuine auto-compaction reaches the turn loop — a manual
            // /compact drains its own events in runCompact, so this is always an
            // auto-compaction → post the special notice (non-blocking).
            void sendManagedCard(channel, opts.chatId, buildAutoCompactCard(), cardMsgId, !opts.flat).catch((err) =>
              log.fail('card', err, { phase: 'auto-compact-notice' }),
            );
          }
          render.apply(ev);
          rc.rs = render.snapshot();
          // Non-blocking: never stall event consumption on a round-trip. The pump
          // coalesces and routes the latest snapshot — answer text → element
          // typewriter (cardElement.content), structure → whole-card update.
          stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
        }
        const doneAt = Date.now(); // codex stopped emitting / loop ended
        stopper.dispose(); // 事件流已收尾：撤掉 ⏹ 的 5s 强停兜底定时器
        await stream.drain(); // flush the last coalesced frame before terminal
        state.interrupt = undefined; // turn done; nothing left to interrupt
        const interrupted = stopper.interrupted();
        // 杀进程恢复锤只留给「真出事」：watchdog 超时，或 ⏹ 后没等到干净收尾
        // （forced）。优雅 ⏹（done 及时到达）不算 killed —— 线程与进程留用。
        const killed = timedOut || (interrupted && stopper.forced());
        if (interrupted) render.interrupt();
        else if (timedOut) render.timeout(Math.round(idleMs / 1000));
        else render.finalize();
        rc.rs = render.snapshot();
        if (interrupted) log.info('agent', 'interrupt', { graceful: !stopper.forced(), threadId: topicThreadId ?? null });

        // A killed turn (watchdog / forced ⏹) leaves codex mid-turn with a
        // notification stream that never terminates. Recycle the process:
        // closing it ends the stream cleanly (no orphaned reader stealing the
        // next turn's events) and frees the turn. The topic resumes from the
        // persisted thread on its next message (resolveThread), so the session
        // survives the kill.
        // 优雅 ⏹（killed=false）不回收：turn/completed(status:"interrupted") 已
        // 干净收尾，同进程同 thread 可继续复用（08b 探针已证）——sessions 保留、
        // 不 close，下一条消息走 LIVE 快路径。
        // 进程级死亡（app-server 中途崩溃 → error 卡 / 轮间死 → 空卡，killed=false）
        // 同走回收：立即清出缓存，下一条消息直接经 resolveThread 的 resume 兜底
        // 自愈（快路径的 isAlive 守卫是兜底的兜底）。
        const procDead = !killed && !opts.thread.isAlive();
        if (killed || procDead) {
          void opts.thread.close().catch(() => undefined);
          if (topicThreadId) sessions.delete(topicThreadId);
          // 自愈观测：这里是「kill 中途死」唯一的驱逐点且原先静默——进程死在轮中
          // 时 LIVE 缓存在本轮收尾就清掉，下一条消息的 resolveThread 不会再命中
          // dead-thread-evict（那条只兜「轮间死」）。没有这行，e2e 无法从日志还原
          // 驱逐发生在哪。
          log.info('agent', 'session-evict', {
            threadId: topicThreadId ?? null,
            reason: timedOut ? 'watchdog-timeout' : procDead ? 'proc-dead' : 'forced-interrupt',
          });
        }

        const finalMsgId = cardMsgId;
        await adoptThreadId(finalMsgId);
        rc.cardKey = finalMsgId;

        // Outbound images + 卡片围栏 — only at terminal (uploads are slow; while
        // streaming, ![](path) refs and ```feishu-card fences show as text). Scan
        // the final answer once: upload every image ref (cached; covers both the
        // run-card's inline images and any clean-card images), then post each
        // ```feishu-card fence as a standalone clean card. Best-effort: a failed
        // upload leaves the original markdown in place, a failed card is logged.
        const answerText = finalMessageText(rc.rs);
        const { fences } = extractCardFences(answerText);
        const imgSources = imageSources(answerText);
        if (imgSources.length > 0) {
          rc.images = await uploadOutboundImages(channel, imgSources, opts.cwd ?? fallbackCwd);
        }

        // terminal whole-card update: final render with streaming off (clears the
        // typewriter cursor) and no ⏹ button.
        await stream.updateCard(channel, buildRunCard(rc));
        // One-line per-turn timeline; all ms are relative to the turn's stream start.
        {
          const terminalAt = Date.now();
          const st = stream.stats();
          log.info('stream', 'timing', {
            tResolve: intake?.tResolve ?? -1, // 入站段耗时（仅首轮有值；M-1 并行化观测）
            tWeave: intake?.tWeave ?? -1,
            tCardCreate,
            tTurnStart: turnStartAt - tStart, // 负数 = turn/start 抢在流循环前多少 ms（QW-1 并行收益）
            firstEv: firstEvAt ? firstEvAt - tStart : -1,
            firstText: firstTextAt ? firstTextAt - tStart : -1,
            lastEv: lastEvAt - tStart,
            done: doneAt - tStart,
            terminal: terminalAt - tStart,
            doneToTerminal: terminalAt - doneAt,
            events: evCount,
            textChars,
            pushes: st.pushCount,
            cardPushes: st.cardPushes,
            elPushes: st.elPushes,
            rttAvg: st.pushCount ? Math.round(st.totalRttMs / st.pushCount) : 0,
            rttMax: st.maxRttMs,
          });
          intake = undefined; // 排队续轮没有入站段，别把首轮数值带下去
        }
        runsByCard.delete(cardMsgId);
        promoteCard(finalMsgId, rc);

        for (const fence of fences) {
          try {
            await sendManagedCard(channel, opts.chatId, buildCleanCard(fence, rc.images), finalMsgId, !opts.flat);
          } catch (err) {
            log.fail('card', err, { phase: 'clean-card' });
          }
        }
        if (topicThreadId) {
          touchSession(topicThreadId); // 轮次收尾打点（M-3 reaper 的空闲时钟）
          await patchSession(topicThreadId, { updatedAt: Date.now() });
        }
        replyTo = finalMsgId;
        replyInThread = !opts.flat; // stay in the topic for queued turns (single: stay flat)
        log.info('card', 'final', { terminal: render.terminal() });

        // A stop (⏹ graceful or forced / watchdog) or a dead process ends the
        // whole run — drop any queued follow-ups, but tell the user instead of
        // swallowing them. 优雅 ⏹ 虽然线程留用，但用户按了停就是要停：排队消息
        // 同样丢弃（语义与杀进程路径一致，只是进程不回收）。
        if (killed || procDead || interrupted) {
          if (state.queue.length > 0) {
            void channel
              .send(
                opts.chatId,
                { markdown: `⚠️ ${state.queue.length} 条排队消息已丢弃，请重发。` },
                { replyTo: finalMsgId, replyInThread: !opts.flat },
              )
              .catch(() => undefined);
            log.info('intake', 'queue-dropped', { depth: state.queue.length, killed, procDead, interrupted });
          }
          break;
        }
        if (state.queue.length === 0) break;
        turnInput = state.queue.shift()!;
      }
    } catch (err) {
      log.fail('intake', err);
      await channel
        .send(opts.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch(() => undefined);
    } finally {
      active.delete(activeKey);
      if (curCardKey) runsByCard.delete(curCardKey);
      // F8: adopt 始终没成功的线程对任何后续消息都不可达（pending: 键随本
      // finally 即灭，会话从未 persist，M-3 reaper 只扫 sessions 也看不见它）
      // ——保活只会把常驻 agent 进程（~172MB/个）泄漏到停机。与 goal 路径
      // 一致直接回收（close 幂等，已死/已关的也无害）。
      if (activeKey.startsWith('pending:')) {
        void opts.thread.close().catch(() => undefined);
        log.warn('intake', 'unadopted-thread-closed', { activeKey });
      }
      reaction?.done(); // run ended (complete / ⏹ / timeout / error) → ✅ DONE
      release();
    }
  }

  /**
   * Goal run: set a persistent codex goal (opts.firstText is the objective) and
   * render its autonomous, multi-turn execution as a sequence of streaming run
   * cards, then post a terminal 「目标已完成 / 已中止」 card with the run metadata.
   *
   * Differs from {@link launchRun}: turns are auto-started AND auto-continued by
   * codex (we never call turn/start — see {@link AgentThread.runGoal}); the
   * per-turn idle watchdog is OFF (goals run long) with only a hard wall-clock cap
   * as a backstop; the run cards carry no ⏹ button (goals have no manual stop, by
   * design). The codex process is recycled at the end — a terminated goal leaves
   * trailing notifications that would poison the next turn's stream — and any
   * non-complete goal is cleared first so it won't reactivate on the next resume.
   */
  async function launchGoalRun(opts: LaunchOpts): Promise<void> {
    const objective = opts.firstText;
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId };
    state.thread = opts.thread;
    state.isGoal = true; // messages during the goal get a prompt, never queue (handleTurn)
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
    active.set(activeKey, state);
    if (opts.knownThreadId) trackSession(opts.knownThreadId, opts.thread);

    // M-3: 池满先排队（占位卡可见可取消）；null = 等待期被 ⏹ 取消，预订已释放。
    const slot = await acquireRunSlot(opts, state, activeKey);
    if (!slot) return;
    const { release } = slot;
    if (slot.queuedCard) {
      // goal 的 run 卡按 turn 懒建（首个有内容的 turn 才出卡），不把占位实体钉成
      // 某一轮的卡 —— 否则规划-only 的 goal 会让它永远停在「排队中」。原地翻成
      // 「已开始执行」短报（同一实体 update，不闪烁），后续 run 卡照常另出。
      runsByCard.delete(slot.queuedCard.msgId);
      runStreams.delete(slot.queuedCard.msgId);
      void slot.queuedCard.stream.updateCard(channel, buildQueuedCard({ started: true }));
    }

    const persist = async (threadId: string): Promise<void> => {
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: opts.cwd ?? fallbackCwd,
        sessionId: opts.thread.sessionId,
        backend: opts.backendId ?? DEFAULT_BACKEND_ID,
        model: opts.model,
        effort: opts.effort,
        summary: opts.summary ?? objective.slice(0, 80),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch((err) => log.fail('console', err, { phase: 'persist-session', threadId }));
    };

    // One streaming run card per codex turn. `cur` is the in-flight turn's render
    // context (null between turns); assigned directly in the loop so TS narrows it.
    // `stream`/`cardMsgId` are null until the turn produces real output — a card is
    // sent LAZILY on first content, so a planning-only turn leaves no empty box.
    type GoalTurnCtx = { render: RunRender; rc: RunCardState; stream: RunCardStream | null; cardMsgId: string | null };
    let cur: GoalTurnCtx | null = null;
    let replyTo = opts.replyTo;
    let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));

    const adoptThreadId = async (messageId: string, card: RunCardState): Promise<void> => {
      if (activeKey.startsWith('pending:')) {
        const tid = await getThreadId(channel, messageId, 3); // F8: 单次抖动别滞留 pending:
        if (tid) {
          const key = opts.roleSuffix ? `${tid}#${opts.roleSuffix}` : tid;
          active.delete(activeKey);
          active.set(key, state);
          sessions.set(key, opts.thread);
          activeKey = key;
          topicThreadId = key;
          card.threadId = key;
          await persist(key);
        }
      } else {
        topicThreadId = activeKey;
        card.threadId = activeKey;
      }
    };

    const promoteCard = (msgId: string, card: RunCardState): void => {
      if (!topicThreadId) return;
      const prev = lastRunCard.get(topicThreadId);
      if (prev && prev !== msgId) {
        const prevState = runCards.get(prev);
        const prevStream = runStreams.get(prev);
        if (prevState && prevStream) void prevStream.updateCard(channel, buildRunCardPlain(prevState));
        runCards.delete(prev);
        runStreams.delete(prev);
      }
      lastRunCard.set(topicThreadId, msgId);
      runCards.set(msgId, card);
    };

    /** Finalize a turn's card (terminal render). No-op for a render-only turn that
     * never produced content (no card was sent) — that's how empty turns vanish. */
    const finalizeCard = async (ctx: GoalTurnCtx | null): Promise<void> => {
      if (!ctx || !ctx.stream || !ctx.cardMsgId) return;
      await ctx.stream.drain();
      ctx.render.finalize();
      ctx.rc.rs = ctx.render.snapshot();
      await ctx.stream.updateCard(channel, buildRunCard(ctx.rc));
      runsByCard.delete(ctx.cardMsgId);
      promoteCard(ctx.cardMsgId, ctx.rc);
    };

    /** Begin a turn's render context WITHOUT sending a card yet. */
    const startTurn = (): GoalTurnCtx => {
      const render = new RunRender();
      render.showTools = getShowToolCalls(cfg);
      const goalModelDisp = getModelDisplay(cfg);
      const rc: RunCardState = {
        rs: render.snapshot(),
        requesterOpenId: opts.requesterOpenId,
        showTools: render.showTools,
        goalControls: true,
        ...(goalModelDisp !== 'off' && opts.model
          ? { model: opts.model, effort: opts.effort, modelOnTerminal: goalModelDisp === 'always' }
          : {}),
      };
      return { render, rc, stream: null, cardMsgId: null };
    };

    /** Send this turn's streaming card on first real content (idempotent). */
    const ensureCard = async (ctx: GoalTurnCtx): Promise<void> => {
      if (ctx.stream) return;
      const stream = new RunCardStream();
      const cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(ctx.rc), { replyTo, replyInThread });
      ctx.rc.cardKey = cardMsgId;
      ctx.stream = stream;
      ctx.cardMsgId = cardMsgId;
      runsByCard.set(cardMsgId, state);
      runStreams.set(cardMsgId, stream);
      await adoptThreadId(cardMsgId, ctx.rc);
      // chain the next turn's card (and the terminal card) under this one
      replyTo = cardMsgId;
      replyInThread = !opts.flat;
    };

    let lastStatus = 'active';
    let goalTokens = 0;
    let goalSeconds = 0;
    let goalErrorMsg: string | undefined;
    let interrupted = false; // ⏹ 终止 was tapped
    let goalEnded = false; // 🎯 结束目标 was tapped
    let idledOut = false; // idle watchdog fired (presumed-wedged backstop)
    let resolveStop!: () => void; // 终止 → end the loop NOW (cuts current output)
    let resolveEnd!: () => void; // 结束目标 with no turn in flight → end the loop now
    const stopSignal = new Promise<void>((res) => {
      resolveStop = res;
    });
    const endSignal = new Promise<void>((res) => {
      resolveEnd = res;
    });

    try {
      const run = opts.thread.runGoal(objective);
      state.run = run;
      // ⏹ 终止: clear the goal first (so it won't reactivate on resume), then end
      // the loop immediately — cutting the in-flight turn's output.
      state.interrupt = () => {
        if (interrupted) return;
        interrupted = true;
        void opts.thread.clearGoal().catch(() => undefined);
        resolveStop();
      };
      // 🎯 结束目标: clear the goal so codex stops auto-continuing, but let the
      // in-flight turn finish. With no turn in flight, end now; otherwise the
      // `done` branch below breaks the loop after the current turn completes.
      state.endGoal = () => {
        if (goalEnded || interrupted) return;
        goalEnded = true;
        void opts.thread.clearGoal().catch(() => undefined);
        if (cur) {
          // Immediate feedback: drop the 结束目标 button + show "本轮完成后停止"
          // while the in-flight turn keeps streaming. The flag lives on rc, so
          // later frames keep it; this push refreshes the card right away (a
          // structure change forces a whole-card update).
          cur.rc.goalEnding = true;
          if (cur.stream) {
            cur.rc.rs = cur.render.snapshot();
            cur.stream.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
          }
        } else {
          resolveEnd(); // no turn in flight → end now
        }
      };
      // No total wall-clock cap (goals may run for days). GOAL_IDLE_MS is a
      // presumed-wedged backstop: a live goal streams events continuously, so it
      // only fires when codex goes fully silent. stopSignal/endSignal end the loop
      // WITHOUT killing the process, so we can clear the goal + recycle cleanly.
      const stop = Promise.race([stopSignal, endSignal]);
      const guarded = withIdleTimeout(run.events, GOAL_IDLE_MS, () => {
        idledOut = true;
      }, stop, run.lastActivity);
      for await (const ev of guarded) {
        if (ev.type === 'goal_update') {
          lastStatus = ev.status;
          goalTokens = ev.tokensUsed;
          goalSeconds = ev.timeUsedSeconds;
          continue;
        }
        if (ev.type === 'context_usage') {
          if (topicThreadId) lastUsage.set(topicThreadId, { used: ev.usedTokens, window: ev.contextWindow });
          if (cur) {
            cur.render.apply(ev);
            cur.rc.rs = cur.render.snapshot();
          }
          continue;
        }
        if (ev.type === 'context_compacted') {
          void sendManagedCard(channel, opts.chatId, buildAutoCompactCard(), cur?.cardMsgId ?? undefined, !opts.flat).catch((err) =>
            log.fail('card', err, { phase: 'auto-compact-notice' }),
          );
          continue;
        }
        if (ev.type === 'turn_started') {
          await finalizeCard(cur); // close the previous turn's card (if it produced one)
          cur = startTurn(); // render-only; the card is sent lazily on first content
          continue;
        }
        if (ev.type === 'done') {
          // turn/completed for an intermediate turn — finalize its card (if any).
          // codex auto-continues with the next turn (a terminal goal status, handled
          // after the loop, preempts the final turn's done).
          if (cur) {
            cur.render.apply(ev);
            await finalizeCard(cur);
            cur = null;
          }
          // 🎯 结束目标: the goal was cleared mid-turn; that turn is now done and
          // codex won't auto-continue, so stop here (codex emits no terminal we'd
          // otherwise wait on — goal/cleared is ignored by the event map).
          if (goalEnded) break;
          continue;
        }
        if (ev.type === 'error') {
          goalErrorMsg = ev.message;
          if (!cur) continue; // set-failure before any turn → terminal card only
        }
        if (!cur) cur = startTurn();
        cur.render.apply(ev);
        // Reasoning ALONE doesn't warrant a card (a planning-only turn must not leave
        // an empty box); only real output (text / tool calls) sends the card. Once a
        // card exists, keep streaming everything (incl. reasoning) into it.
        if (ev.type === 'thinking' || ev.type === 'thinking_delta') {
          if (cur.stream) {
            cur.rc.rs = cur.render.snapshot();
            cur.stream.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
          }
          continue;
        }
        await ensureCard(cur);
        cur.rc.rs = cur.render.snapshot();
        cur.stream!.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
      }
      // ⏹ 终止: mark the in-flight turn's card as interrupted before finalizing
      // (finalize() is a no-op once terminal, so this doesn't clash).
      if (interrupted && cur) cur.render.interrupt();
      await finalizeCard(cur);
      cur = null;

      // Always clear the goal when the run ends: a non-complete goal would
      // reactivate on the next resume, and a LEFTOVER goal (even complete) gets
      // re-broadcast as a stale snapshot when this thread is next resumed, which
      // would make the next /goal "complete" instantly (see runGoal's stale guard).
      // (Manual 终止/结束目标 already cleared it; this is idempotent + covers the
      // natural-terminal / idle-backstop paths.)
      await opts.thread.clearGoal().catch(() => undefined);

      // Summary card only for an autonomous end (natural terminal status, or the
      // idle backstop). Manual ⏹ 终止 / 🎯 结束目标 end silently — the run card(s)
      // already convey the outcome.
      if (!interrupted && !goalEnded) {
        const status = idledOut ? 'timeout' : goalErrorMsg && !isGoalTerminal(lastStatus) ? 'error' : lastStatus;
        await sendManagedCard(
          channel,
          opts.chatId,
          buildGoalDoneCard({ objective, status, tokensUsed: goalTokens, timeUsedSeconds: goalSeconds, errorMessage: goalErrorMsg }),
          replyTo,
          !opts.flat,
        ).catch((err) => log.fail('card', err, { phase: 'goal-done' }));
        log.info('card', 'goal-final', { status, tokens: goalTokens, seconds: goalSeconds });
      } else {
        log.info('card', 'goal-final', { status: interrupted ? 'interrupted' : 'ended', tokens: goalTokens, seconds: goalSeconds });
      }
      if (topicThreadId) await patchSession(topicThreadId, { updatedAt: Date.now() }).catch(() => undefined);
    } catch (err) {
      log.fail('intake', err);
      await channel
        .send(opts.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch(() => undefined);
    } finally {
      active.delete(activeKey);
      if (cur?.cardMsgId) runsByCard.delete(cur.cardMsgId);
      // Recycle the codex process (it may still be mid-goal, and a terminated goal
      // leaves trailing notifications); the persisted record stays so the next
      // message resumes a fresh process.
      void opts.thread.close().catch(() => undefined);
      if (topicThreadId) sessions.delete(topicThreadId);
      release();
    }
  }

  // ── cloud-doc comments ────────────────────────────────────────────
  /**
   * `comment` event: someone @-mentioned the bot in a Feishu doc comment
   * (drive.notice.comment_add_v1). There's no streaming card here — we mark the
   * triggering reply with a "Typing" reaction, run one codex turn, and post the
   * answer back into the same comment thread. One codex thread per document
   * (keyed `doc:<fileToken>`), so repeated @-mentions in a doc continue the same
   * conversation; it shares the session store + concurrency semaphore with the
   * group run loop. Comment runs aren't interruptible (no ⏹ card) — the idle
   * watchdog is the only kill switch.
   */
  const onComment = async (evt: CommentEvent): Promise<void> => {
    // 评论事件没有 messageId，按 commentId+replyId 去重（前缀防与消息 id 混淆）。
    if (seenInbound.seen(`comment:${evt.commentId}:${evt.replyId ?? ''}`)) {
      log.info('comment', 'skip', { reason: 'duplicate', commentId: evt.commentId });
      return;
    }
    await withTrace({ chatId: 'comment' }, async () => {
      log.info('comment', 'enter', {
        doc: evt.fileToken,
        fileType: evt.fileType,
        commentId: evt.commentId,
        replyId: evt.replyId ?? null,
        mentionedBot: evt.mentionedBot,
        sender: evt.operator.openId,
      });
      if (!evt.mentionedBot) return log.info('comment', 'skip', { reason: 'not-mentioned' });
      if (!SUPPORTED_FILE_TYPES.has(evt.fileType))
        return log.info('comment', 'skip', { reason: 'unsupported-fileType', fileType: evt.fileType });
      // 响应白名单已下沉到项目级；云文档评论无项目维度，保持现状（所有人可 @bot 评论）。

      const resolved = await resolveComment(channel, evt);
      if (!resolved) return log.info('comment', 'skip', { reason: 'no-target-or-empty' });
      const { target, ctx } = resolved;
      log.info('comment', 'parsed', { isWhole: ctx.isWhole, hasQuote: Boolean(ctx.quote) });

      const prompt = buildCommentPrompt(target, ctx, cfg.accounts.app.tenant);
      const sessionKey = `doc:${evt.fileToken}`;

      // Best-effort "received" feedback up-front (comments have no streaming
      // UI). Added before the per-doc lock so a queued mention still acks
      // immediately; cleared in the finally regardless of how the run ends.
      const reacted = ctx.targetReplyId
        ? await addCommentReaction(channel, target, ctx.targetReplyId)
        : false;

      try {
        // Serialize per document: one codex thread can't run two turns at once
        // (they'd both consume the thread's single app-server notification
        // stream and steal each other's events), so concurrent @-mentions in
        // the SAME doc must queue. Different docs run in parallel (distinct
        // threads); the global cap is still `sema`, acquired inside the lock.
        await withDocLock(sessionKey, async () => {
          const release = await sema.acquire();
          try {
            const thread = await resolveDocThread(sessionKey, ctx.question);
            const rec = await getSession(sessionKey);
            const run = thread.runStreamed({ text: prompt }, { model: rec?.model, effort: rec?.effort });

            let state: RunState = initialState;
            let timedOut = false;
            const guarded = withIdleTimeout(run.events, currentIdleMs(), () => {
              timedOut = true;
            }, undefined, run.lastActivity);
            for await (const ev of guarded) state = reduce(state, ev);

            if (timedOut) {
              const tid = run.turnId();
              // Recycle the thread so the hung turn's never-terminating stream
              // doesn't poison the next comment; the doc resumes from the
              // persisted thread on its next @-mention. Fire-and-forget the
              // interrupt — turn/interrupt is an unbounded JSON-RPC round-trip,
              // and close() SIGKILLs the child anyway, so awaiting it here would
              // pin both the per-doc lock and a global semaphore slot if it
              // hangs. sessions.delete stays synchronous + before release() so
              // the next queued same-doc comment always starts fresh.
              if (tid) void thread.abort(tid).catch(() => undefined);
              void thread.close().catch(() => undefined);
              sessions.delete(sessionKey);
            } else {
              touchSession(sessionKey); // 轮次收尾打点（M-3 reaper 的空闲时钟）
              await patchSession(sessionKey, { updatedAt: Date.now() });
            }

            let reply = stripMarkdown(finalMessageText(state)).trim();
            if (state.terminal === 'error' && state.errorMsg) reply = `⚠️ 出错了：${state.errorMsg}`;
            if (!reply) reply = timedOut ? '（处理超时，请重试或把问题问得更具体些）' : '（没有可回复的内容）';
            if (reply.length > REPLY_MAX_CHARS) reply = `${reply.slice(0, REPLY_MAX_CHARS - 1)}…`;

            await postCommentReply(channel, target, evt, reply).catch((err) =>
              log.fail('comment', err, { step: 'postCommentReply' }),
            );
            log.info('comment', 'done', { terminal: state.terminal, timedOut, len: reply.length });
          } finally {
            release();
          }
        });
      } catch (err) {
        log.fail('comment', err, { step: 'run' });
      } finally {
        if (reacted && ctx.targetReplyId)
          await removeCommentReaction(channel, target, ctx.targetReplyId).catch(() => undefined);
      }
    }).catch((err) => log.fail('comment', err));
  };

  /**
   * Run `fn` serially per `key`: each call chains after the previous one for the
   * same key (so same-doc comment turns never overlap), while different keys run
   * concurrently. The map entry is dropped once its chain fully drains.
   */
  function withDocLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = docLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the prior call's outcome
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    docLocks.set(key, tail);
    void tail.then(() => {
      if (docLocks.get(key) === tail) docLocks.delete(key);
    });
    return run;
  }

  /** Reuse the in-memory codex thread for a doc, else resume the persisted one,
   * else start a fresh thread bound to `doc:<fileToken>` (cwd = fallbackCwd —
   * doc replies rarely touch the filesystem, but we keep a sane default). */
  async function resolveDocThread(sessionKey: string, question: string): Promise<AgentThread> {
    const live = sessions.get(sessionKey);
    if (live) {
      if (live.isAlive()) return live;
      // 与 resolveThread 同款守卫：app-server 死后死线程留在缓存，每次 @ 评论
      // 都立即失败（且失败轮还 touchSession 给 reaper 续命）——驱逐让它落进
      // 下面既有的 resume-or-fresh 兜底，话题自愈而不是僵死到重启。
      sessions.delete(sessionKey);
      log.info('agent', 'dead-thread-evict', { sessionKey });
    }
    const rec = await getSession(sessionKey);
    if (rec) {
      try {
        // Same record-backend routing as resolveThread (doc sessions persist too).
        const resumed = await backendFor(rec.backend).resumeThread({
          cwd: rec.cwd,
          sessionId: rec.sessionId,
          model: rec.model,
          effort: rec.effort,
        });
        trackSession(sessionKey, resumed);
        return resumed;
      } catch (err) {
        log.fail('agent', err, { phase: 'comment-resume', sessionKey });
      }
    }
    const { model, effort } = pickDefault(await listModels());
    const fresh = await backend.startThread({ cwd: fallbackCwd, model, effort });
    trackSession(sessionKey, fresh);
    await upsertSession({
      threadId: sessionKey,
      chatId: sessionKey,
      cwd: fallbackCwd,
      sessionId: fresh.sessionId,
      backend: backend.id,
      model,
      effort,
      summary: question.slice(0, 80),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return fresh;
  }

  /**
   * `botAdded` event: a human added the bot to a group. If the adder is an admin
   * (binding ties the group to a cwd on the operator's machine — privileged) and
   * the group isn't already bound, DM them a bind card with the project name
   * pre-filled from the group name. Groups the bridge created itself are already
   * registered (or added by the bot, not an admin), so they fall through.
   */
  async function onBotAddedToChat(evt: BotAddedEvent): Promise<void> {
    // The SDK fires botAdded fire-and-forget (no await around the handler), so a
    // rejection here would surface as an unhandled rejection — guard the whole
    // body (getProjectByChatId can throw on a corrupt/locked projects.json).
    await withTrace({ chatId: evt.chatId }, async () => {
      const op = evt.operator?.openId;
      if (await getProjectByChatId(evt.chatId)) {
        log.info('intake', 'bot-added-bound', { chatId: evt.chatId.slice(-6) });
        return;
      }
      if (!op || !isAdmin(cfg, op)) {
        log.info('intake', 'bot-added-nonadmin', { chatId: evt.chatId.slice(-6), op: op?.slice(-6) });
        return;
      }
      // Best-effort group name (needs im:chat:readonly); the bind card's name is
      // editable, so an empty/failed lookup just means the admin types one.
      const info = await channel.getChatInfo(evt.chatId).catch((err) => {
        log.fail('intake', err, { phase: 'bot-added-chatinfo' });
        return undefined;
      });
      const name = (info?.name ?? '').trim();
      await sendManagedCard(
        channel,
        op,
        buildJoinGroupFormCard({ chatId: evt.chatId, name, backends: backendOptionsFor('full') }),
        undefined,
        false,
        'open_id',
      ).catch((err) => log.fail('intake', err, { phase: 'bot-added-bindcard' }));
      log.info('intake', 'bot-added', { chatId: evt.chatId.slice(-6), op: op.slice(-6), named: Boolean(name) });
    }).catch((err) => log.fail('intake', err, { phase: 'bot-added' }));
  }

  /**
   * Bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher in bridge.ts — the SDK has no named event for it). Auto-unbind the
   * bound project: the bot is already out, so no me_leave. Notify the binder.
   */
  async function onBotRemovedFromChat(chatId: string): Promise<void> {
    const project = await getProjectByChatId(chatId);
    if (!project) return;
    // Remove first, then notify only if THIS call removed it — Feishu delivers
    // events at-least-once and this raw-tap path bypasses the SDK's dedup, so a
    // redelivery would otherwise double-notify the binder. removeProject returns
    // undefined when the entry is already gone.
    const removed = await removeProject(project.name);
    if (!removed) return;
    log.info('intake', 'bot-removed-unbind', { name: removed.name, chatId: chatId.slice(-6) });
    if (removed.addedBy) {
      await channel.rawClient.im.v1.message
        .create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: removed.addedBy,
            msg_type: 'text',
            content: JSON.stringify({ text: `ℹ️ 我已被移出群「${removed.name}」，对应项目已自动解绑。` }),
          },
        })
        .catch(() => undefined);
    }
  }

  // ── M-6 reaction 入站：零打字驱动 ─────────────────────────────────
  /**
   * `reaction` event（SDK 已归一化 im.message.reaction.created_v1 并自带去重）。
   * 按 message_id 反查归属：运行中的 run/排队卡（runsByCard）→ OK/DONE 走与
   * RC.stop 同语义的终止；终态 run 卡（runCards，每话题只留最新一张）→ 👍 等价
   * 在话题里发「继续」。事件天然限机器人所在会话；缺 im:message.reactions:read
   * scope 时事件根本不会推送 —— 整条链路零报错地静默关闭。
   */
  const onReaction = async (evt: ReactionEvent): Promise<void> => {
    if (evt.action !== 'added') return;
    // 机器人（含自己的 ⏳/🫳/OKR 生命周期表情）不能触发自己：事件体 operator_type
    // 标 app 的一律忽略；normalizeReaction 已滤掉无 open_id 的事件，这里再按自身
    // open_id 双保险。
    const operatorType = (evt.raw as { operator_type?: string } | undefined)?.operator_type;
    if (operatorType && operatorType !== 'user') return;
    const op = evt.operator?.openId;
    if (!op || op === channel.botIdentity?.openId) return;

    const running = runsByCard.get(evt.messageId);
    const intent = classifyReaction(evt.emojiType, Boolean(running));
    if (!intent) return;
    await withTrace({ msgId: evt.messageId }, async () => {
      if (intent === 'stop' && running) {
        // 与 RC.stop 相同的 owner-or-admin 门（杀别人的 run 限发起人/管理员，
        // design §5）。事件体不带 chat_id，拒绝只记日志、不回贴。
        if (op !== running.requesterOpenId && !isAdmin(cfg, op)) {
          log.info('intake', 'reaction-denied', { emoji: evt.emojiType, op: op.slice(-6) });
          return;
        }
        running.interrupt?.();
        log.info('intake', 'reaction-stop', { emoji: evt.emojiType, stopped: Boolean(running.interrupt) });
        return;
      }
      if (intent !== 'continue') return;
      const rc = runCards.get(evt.messageId);
      const sessionKey = rc?.threadId;
      if (!rc || !sessionKey) return; // 不是（最新的）终态 run 卡 / adopt 失败无会话可续
      // 随手点赞的群友不该烧一轮 codex：续轮与 run 控件同门（发起人或管理员），
      // 且会话/用户仍须在白名单内（与真发一条消息的门禁一致）。
      if (op !== rc.requesterOpenId && !isAdmin(cfg, op)) {
        log.info('intake', 'reaction-denied', { emoji: evt.emojiType, op: op.slice(-6) });
        return;
      }
      const rec = await getSession(sessionKey);
      if (!rec) return;
      const project = await getProjectByChatId(rec.chatId);
      if (!isChatAllowed(cfg, rec.chatId) || !isUserAllowedInProject(cfg, project, op)) return;
      const flat = (project?.kind ?? 'multi') === 'single';
      // 合成一条等价的「继续」消息复用整条消息管线（steer/queue/goal 提示全部
      // 生效）：replyTo 指向被点的终态卡，⏳/🫳 生命周期表情也落在卡上作回执；
      // sessionKey 用卡片自己的会话键（含 #role 后缀），续的就是这张卡的会话。
      const synthetic: NormalizedMessage = {
        messageId: evt.messageId,
        chatId: rec.chatId,
        chatType: 'group',
        senderId: op,
        content: '继续',
        rawContentType: 'text',
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: true,
        threadId: flat ? undefined : sessionKey.replace(/#(admin|guest)$/, ''),
        createTime: Date.now(),
      };
      log.info('intake', 'reaction-continue', { key: sessionKey, op: op.slice(-6) });
      // 权限档随会话原发起人（LIVE 线程本就钉死在 thread/start 的沙箱档；
      // recreate 兜底时也不该因点赞者身份升降档）。
      await handleTurn(synthetic, '继续', sessionKey, flat, project, turnPerm(project, rc.requesterOpenId ?? op));
    });
  };

  // ── application.bot.menu_v6（bot 单聊菜单）────────────────────────
  /**
   * onboarding 一直引导订阅该事件（README / 启动文案）但 bridge 此前没有处理器
   * —— 点菜单毫无反应的半成品（research/04 §4）。bot 菜单仅单聊生效，而 DM 正是
   * 管理台的地盘：按 event_key 路由到对应卡——dm.newProject / dm.projects /
   * dm.settings / dm.usage / dm.doctor / dm.reconnect / dm.update 各自直达对应卡
   * （与首页卡内同名按钮的渲染同源，单一事实源）；其它 key 或空 key 回退首页菜单卡，
   * 兼容「只配一个入口」与「私聊发任意消息→首页卡」（handleDmConsole）的旧语义。
   * 非管理员回拒绝文案（同 handleDmConsole 语义）。事件不带 chat_id，发送走
   * receive_id_type=open_id。
   */
  const onBotMenu = async (evt: { openId?: string; eventKey?: string; eventId?: string }): Promise<void> => {
    const op = evt.openId;
    if (!op) return;
    // raw-tap 绕过 SDK 的内建去重（at-least-once 重推会双开菜单卡）——有 event_id
    // 就按它去重；没有则照常放行（同一菜单点两下本就该出两张卡）。
    if (evt.eventId && seenInbound.seen(`menu:${evt.eventId}`)) return;
    log.info('intake', 'bot-menu', { key: evt.eventKey, op: op.slice(-6) });
    if (!isAdmin(cfg, op)) {
      await channel.rawClient.im.v1.message
        .create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: op,
            msg_type: 'text',
            content: JSON.stringify({ text: '⛔ 仅管理员可在私聊里管理项目。' }),
          },
        })
        .catch(() => undefined);
      return;
    }
    // 私聊菜单事件没有可 patch 的源卡，统一「新发一张托管卡」（open_id 投递）。发出去
    // 的卡都经 sendManagedCard 注册了 byMessageId，卡上按钮的后续 patch/update 回调
    // 照常工作——从底部菜单进与从首页卡点进完全等价。命中的 key 直达对应卡，其余
    // （含空 key）回退首页菜单卡。用量/更新是两阶段（先落地 loading/checking 卡，再
    // 原地更新结果）；探测/取数/IO 可能抛错，统一 try/catch 兜住（bridge 侧 void 调用、
    // 无上层 catch，否则成 unhandled rejection）。
    const sendDm = (c: object) => sendManagedCard(channel, op, c, undefined, false, 'open_id');
    try {
      switch (evt.eventKey) {
        case DM.newProject:
          await sendDm(buildNewProjectFormCard({ backends: backendOptionsFor('full') }));
          break;
        case DM.projects:
          await sendDm(await renderProjectList());
          break;
        case DM.settings:
          await sendDm(buildSettingsCard(cfg));
          break;
        case DM.doctor:
          await sendDm(buildDoctorCard(await buildDoctorInfo()));
          break;
        case DM.reconnect:
          await sendDm(buildReconnectCard(channel.getConnectionStatus?.()?.state ?? 'unknown'));
          break;
        case DM.usage: {
          // 同 runUsage 语义，但锚在自己刚发的 loading 卡上：取数后原地更新；取数失败按
          // UsageError.kind 渲染错误卡；原地更新失败（极小概率实体失效）兜底再发一张。
          const { messageId } = await sendDm(buildUsageCard({ phase: 'loading' }));
          let state: UsageCardState;
          try {
            state = { phase: 'ready', data: await fetchUsageBundle(false) };
          } catch (e) {
            log.fail('console', e, { phase: 'usage', via: 'menu' });
            state = {
              phase: 'error',
              kind: e instanceof UsageError ? e.kind : 'transient',
              message: e instanceof Error ? e.message : String(e),
            };
          }
          const ok = await updateManagedCard(channel, messageId, buildUsageCard(state)).catch(() => false);
          if (!ok) await sendDm(buildUsageCard(state));
          break;
        }
        case DM.update: {
          // 只「检查」最新版、无副作用；真正安装仍需结果卡上的「立即更新」（DM.updateDo）
          // 二次确认。latestVersion 走异步 execFile（绝不能 spawnSync 冻住 event loop）。
          const { messageId } = await sendDm(buildUpdateCard({ phase: 'checking' }));
          const current = currentVersion();
          const latest = await latestVersion().catch(() => null);
          const hasUpdate = !!latest && isNewer(latest, current);
          log.info('console', 'update-check', { current, latest, hasUpdate, via: 'menu' });
          await updateManagedCard(
            channel,
            messageId,
            buildUpdateCard({ phase: 'checked', current, latest, hasUpdate, dev: isDevSource() }),
          ).catch((e) => log.fail('console', e, { phase: 'update-check', via: 'menu' }));
          break;
        }
        default:
          await sendDm(buildDmMenuCard({ webConsoleUrl: webConsoleUrl(), version: bridgeVersion() }));
      }
    } catch (err) {
      log.fail('console', err, { cmd: 'menu-card', key: evt.eventKey });
    }
  };

  // ── M-3 空闲进程 reaper ──────────────────────────────────────────
  // sessions 只增不减：数周 daemon 会积累几十上百个常驻 agent 进程（每个 ~172MB
  // 子树）。周期清扫超过 SESSION_REAP_IDLE_MS 无轮次的 LIVE 会话：close()
  // （SIGKILL 子进程）+ 驱逐缓存。持久化记录不动 —— 下一条消息经 resolveThread
  // 的 resume 兜底自愈，对话无感衔接。active（运行/排队中）与 docLocks（评论
  // 串行链）持有的会话跳过；goal 话题本就每轮收尾回收，不受影响。与 watchdog
  // 的假死超时语义不冲突：那是单轮内的事件静默，这里是轮与轮之间的空闲。
  const reaper = setInterval(() => {
    const now = Date.now();
    // 没打点的 key 先补记（理论不可达——所有入缓存都走 trackSession），下轮评估；
    // 已驱逐会话的残留打点顺手清掉，时钟表不随历史会话无限增长。
    for (const key of sessions.keys()) if (!sessionTouchedAt.has(key)) sessionTouchedAt.set(key, now);
    for (const key of [...sessionTouchedAt.keys()]) if (!sessions.has(key)) sessionTouchedAt.delete(key);
    const idle = pickIdleSessions(
      sessions.keys(),
      sessionTouchedAt,
      (k) => active.has(k) || docLocks.has(k),
      SESSION_REAP_IDLE_MS,
      now,
    );
    for (const key of idle) {
      const thread = sessions.get(key);
      sessions.delete(key);
      sessionTouchedAt.delete(key);
      if (thread) void thread.close().catch(() => undefined);
    }
    if (idle.length > 0) log.info('agent', 'idle-reap', { reaped: idle.length, live: sessions.size });
  }, SESSION_REAP_SWEEP_MS);
  reaper.unref(); // 不挡进程退出（CLI/测试里 orchestrator 可能不走 shutdown）

  async function shutdown(): Promise<void> {
    clearInterval(reaper);
    // adopt 失败的孤儿线程已在 launchRun/launchGoalRun 的 finally 就地 close，
    // 这里只需回收 LIVE 会话缓存。
    const live = [...new Set(sessions.values())];
    sessions.clear();
    // close() SIGKILLs each app-server child; settle all so one hang/throw
    // doesn't block reaping the rest.
    await Promise.allSettled(live.map((t) => t.close()));
    log.info('bridge', 'shutdown', { closed: live.length });
  }

  // 启动预热：daemon 首个新话题原本恒吃一次 model/list 冷 spawn（独立 app-server
  // ~150–300ms），启动是空闲期，提前付掉。成功时只填 backend 内部缓存，后续
  // listModels() 零成本；失败时 backend 返回 STATIC_MODELS 兜底但不写缓存——
  // 首次真实调用会自动重试，fallback 绝不被钉死（listModels 包装层也不缓存）。
  void backend.listModels().catch((err) => log.fail('agent', err, { phase: 'models-prewarm' }));

  // 管理面写执行器（Web 控制台 / supervisor IPC 入口）：与上面 DM 回调共用
  // admin/ops.ts 的 perform*，注入同一个 backendFor + evictLiveSessionsForChat
  // —— 双端写行为同源（同校验、同落盘、同驱逐）。
  const adminExecute = createAdminWriteExecutor({ backendFor, evictLiveSessionsForChat });

  return { onMessage, onComment, onBotAddedToChat, onBotRemovedFromChat, onReaction, onBotMenu, dispatcher, adminExecute, shutdown };
}

/** Resolve a message's thread_id via raw API (reply response omits it). The
 * lookup can lag right after the reply, and a single API blip used to leave the
 * run stranded on its `pending:` key（双开 + 孤儿进程，F8）——binding-critical
 * callers pass `attempts` > 1 to retry (500ms apart) before giving up.
 * Exported for tests. */
export async function getThreadId(
  channel: LarkChannel,
  messageId: string,
  attempts = 1,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
      const items = (res.data as { items?: { thread_id?: string }[] } | undefined)?.items;
      const tid = items?.[0]?.thread_id;
      if (tid) return tid;
      log.warn('intake', 'threadid-missing', { messageId, attempt });
    } catch (err) {
      log.warn('intake', 'threadid-lookup-failed', { messageId, attempt, err: String(err) });
    }
  }
  return undefined;
}
