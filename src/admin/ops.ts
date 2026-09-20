import { backendIds } from '../agent';
import { catalogById } from '../agent/catalog';
import type { AgentBackend, BackendProbe, PermissionMode, ReasoningEffort } from '../agent/types';
import { tierLabel, type BackendProbeRow } from '../card/dm-cards';
import {
  COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES,
  getCompletionReminderConfig,
  type AppConfig,
  type AppPreferences,
  type CompletionReminderMode,
  type ResolvedCompletionReminderConfig,
} from '../config/schema';
import { saveConfig } from '../config/store';
import {
  effectiveGuestMode,
  effectiveMode,
  getProjectByName,
  updateProject,
  type Project,
  type ParticipationPolicy,
} from '../project/registry';

/**
 * 管理面共享写操作层（第二棒：daemon 集成 + 写操作双端同源）。
 *
 * 【契约】DM 卡片回调（handle-message 的 dm.proj.* / gs.*）与 Web 控制台
 * （AdminService 写方法，经 Orchestrator.adminExecute / supervisor IPC）**都只
 * 走这里**写 projects.json——同一套校验、同一套落盘、同一套活跃会话驱逐，杜绝
 * 双写两套逻辑漂移。本模块只依赖 registry / agent 注册表 / dm-cards 的 tierLabel
 * （纯展示），不依赖 channel / orchestrator——驱逐动作由调用方以回调注入
 * （evictLiveSessionsForChat 是 orchestrator 进程内状态，必须在 bot 进程内执行；
 * 这也是 supervisor 写操作走 IPC 而非文件级直写的根本原因）。
 *
 * 写操作必须在「持有该 bot registry 的进程」内执行：registry 的 withLock 是
 * 进程内锁，跨进程直写会与 bot 进程的读-改-写交错丢更新。
 */

/** Web/IPC 写操作的序列化形态（supervisor → bot 子进程经 process.send 转发）。 */
export type AdminWriteOp =
  | { kind: 'switchBackend'; project: string; backend: string }
  | {
      kind: 'setPermissionMode';
      project: string;
      mode?: PermissionMode;
      guestMode?: PermissionMode;
      network?: boolean;
    }
  | { kind: 'setNoMention'; project: string; on: boolean }
  | { kind: 'setAutoCompact'; project: string; on: boolean }
  | { kind: 'setContextBriefing'; project: string; on?: boolean; model?: string; fast?: boolean }
  | { kind: 'setParticipation'; project: string; policy: ParticipationPolicy }
  | { kind: 'setDiscuss'; project: string; on: boolean }
  | {
      kind: 'setCompletionReminder';
      mode: CompletionReminderMode;
      longTaskMinutes: number;
    };

/** 写操作被校验拒绝（中文原因可直接上卡/上 HTTP body）。HTTP 层映射 409；
 * IPC 层凭 code 还原类型。 */
export class AdminWriteError extends Error {
  readonly code = 'ADMIN_WRITE_REJECTED';
  constructor(reason: string) {
    super(reason);
    this.name = 'AdminWriteError';
  }
}

/** perform* 的统一返回：ok 带写后回读的最新项目（卡片/响应直接渲染它，保证与
 * 盘上一致）；!ok 带中文拒因。不抛错——DM 与 Web 对拒因的呈现方式不同。 */
export type AdminWriteOutcome = { ok: true; project: Project } | { ok: false; reason: string };

/** bot 全局偏好写入的返回；与项目写共用 `{ok:false,reason}` 拒绝协议。 */
export type AdminPreferencesWriteOutcome =
  | { ok: true; completionReminder: ResolvedCompletionReminderConfig }
  | { ok: false; reason: string };

/**
 * Serialize every read-modify-persist-commit of one bot's preferences. The
 * mutator runs only after all earlier writes have settled, so it always reads
 * the latest LIVE preferences; LIVE cfg is replaced only after its matching
 * snapshot has reached disk. A failed write leaves LIVE untouched and does not
 * poison later writes in the queue.
 */
export type AppPreferencesWriter = (mutate: (preferences: AppPreferences) => void) => Promise<AppPreferences>;

export function createAppPreferencesWriter(opts: {
  cfg: AppConfig;
  /** Test injection; production defaults to the atomic config writer. */
  persistConfig?: (cfg: AppConfig) => Promise<void>;
}): AppPreferencesWriter {
  let chain: Promise<unknown> = Promise.resolve();
  const persist = opts.persistConfig ?? saveConfig;

  return (mutate) => {
    const run = chain.then(async () => {
      const preferences: AppPreferences = { ...(opts.cfg.preferences ?? {}) };
      mutate(preferences);
      await persist({ ...opts.cfg, preferences });
      opts.cfg.preferences = preferences;
      return preferences;
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const TIERS: readonly PermissionMode[] = ['qa', 'write', 'full'];
const COMPLETION_REMINDER_MODES: readonly CompletionReminderMode[] = ['manual', 'long', 'failures', 'always'];

/**
 * 项目后端切换的纯校验（exported for tests）：① 目标 id 在注册表里；② 目标后端
 * doctor() 探测通过（未装 CLI / SDK 不可用要在这里拦住，而不是切过去后每条消息
 * 报错）；③ 项目两档权限（管理员档 + 普通用户档）都在目标后端声明的支持面内
 * （某后端若仅支持部分权限档——其 startThread 的 fail-closed 硬守卫不变，这里
 * 只是把拒绝提前到切换时并讲清原因）。返回首个不满足的原因（中文，直接上卡）；
 * 全过返回 null。切换本身不驱逐活跃会话：SessionRecord.backend 让已有话题会话
 * 仍走原后端，新话题才用新值（resolveThread 按记录路由的既有语义）。
 */
export function validateBackendSwitch(opts: {
  /** 目标后端 id（下拉提交值） */
  target: string;
  /** 注册表内全部后端 id（backendIds()） */
  registered: readonly string[];
  /** 项目当前权限档（两档都要被目标后端支持） */
  project: Pick<Project, 'mode' | 'guestMode'>;
  /** 目标后端声明的权限档支持面（AgentBackend.supportedModes；undefined ⇒ 全支持） */
  supportedModes?: readonly PermissionMode[];
  /** 目标后端 doctor() 探测结果；undefined = 探测没跑成，按不可用拒绝 */
  probe?: BackendProbe;
}): string | null {
  if (!opts.registered.includes(opts.target)) {
    return `未知后端「${opts.target}」（可用：${opts.registered.join('、')}）`;
  }
  if (!opts.probe?.ok) {
    return `后端「${opts.target}」当前不可用：${opts.probe?.hint ?? '环境探测失败（未安装或未登录）'}`;
  }
  if (opts.supportedModes) {
    const tiers = [...new Set([effectiveMode(opts.project), effectiveGuestMode(opts.project)])];
    const unsupported = tiers.filter((t) => !opts.supportedModes!.includes(t));
    if (unsupported.length > 0) {
      return (
        `该后端仅支持 ${opts.supportedModes.map(tierLabel).join(' / ')} 权限档，` +
        `本项目当前为 ${tiers.map(tierLabel).join(' / ')} —— 请先在「🔐 权限」把两档都调整到支持的档位再切换。`
      );
    }
  }
  return null;
}

/** 单个后端 doctor 探测的超时兜底（ms）：探测要 spawn CLI，未安装/卡死时不能
 * 拖住检测卡——超时按「探测没跑成」（probe undefined）渲染为不可用。 */
export const BACKEND_PROBE_TIMEOUT_MS = 3000;

/**
 * 🧠 后端检测的纯探测（exported for tests）：并行对全部后端 doctor({force})，
 * 单个超时（Promise.race 兜底）/抛错都归一成 probe undefined——检测结果卡按
 * 不可用渲染，绝不放行。输入是后端实例的最小切面，注册表里有什么测什么，
 * 新后端注册即自动出现在结果卡上。
 */
export async function probeBackends(
  backends: readonly Pick<AgentBackend, 'id' | 'displayName' | 'supportedModes' | 'doctor'>[],
  timeoutMs = BACKEND_PROBE_TIMEOUT_MS,
): Promise<BackendProbeRow[]> {
  return Promise.all(
    backends.map(async (be) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      });
      const probe = await Promise.race([be.doctor({ force: true }).catch(() => undefined), timeout]).finally(() =>
        clearTimeout(timer),
      );
      return { id: be.id, name: be.displayName, probe, supportedModes: be.supportedModes };
    }),
  );
}

/** 写后回读（卡片/响应与盘上一致）；理论上 update 后必在，缺了用合成值兜底。 */
async function freshOr(name: string, fallback: Project): Promise<Project> {
  return (await getProjectByName(name)) ?? fallback;
}

/**
 * 🧠 切换项目后端（DM dm.proj.backend.submit 与 Web switchBackend 同源）：
 * 写盘前再 doctor({force}) 探一次「现在」的状态（检测卡渲染后环境可能已变），
 * validateBackendSwitch 全过才写 Project.backend。**不驱逐活跃会话**——已有话题
 * 会话按 SessionRecord.backend 仍走原后端，新话题才用新值。
 */
export async function performBackendSwitch(opts: {
  projectName: string;
  target: string;
  /** 后端实例解析（orchestrator 的缓存版或裸 createBackend 均可） */
  backendFor: (id: string) => AgentBackend;
}): Promise<AdminWriteOutcome> {
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  // 后端在新建项目时选定、运行时固定，不支持切换（防御式：UI 已撤切换入口，这里挡住
  // 任何残留 IPC/HTTP 请求）。仅放行 legacy 项目（backend 未设）的一次性落地与同值 no-op。
  if (p.backend && p.backend !== opts.target) {
    return {
      ok: false,
      reason: '该项目的后端已在创建时选定，运行时固定、不支持切换。如需更改，请删除该项目后用新后端重新创建。',
    };
  }
  const registered = backendIds();
  const known = registered.includes(opts.target);
  const probe = known ? (await probeBackends([opts.backendFor(opts.target)]))[0]?.probe : undefined;
  const reason = validateBackendSwitch({
    target: opts.target,
    registered,
    project: p,
    supportedModes: known ? opts.backendFor(opts.target).supportedModes : undefined,
    probe,
  });
  if (reason) return { ok: false, reason };
  await updateProject(opts.projectName, { backend: opts.target });
  return { ok: true, project: await freshOr(opts.projectName, { ...p, backend: opts.target }) };
}

/**
 * 🔐 设置权限档（DM dm.proj.perm.submit 与 Web setPermissionMode 同源）：落盘
 * 管理员档 mode / 普通用户档 guestMode / 联网，再驱逐本项目活跃会话让新档立即
 * 生效（codex 沙箱在 thread/start 绑定后不可变）。mode/guestMode 缺省 = 不改。
 */
export async function performSetPermissionMode(opts: {
  projectName: string;
  mode?: PermissionMode;
  guestMode?: PermissionMode;
  network?: boolean;
  /** orchestrator 进程内驱逐（LIVE 线程只存在于 bot 进程内存里） */
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
}): Promise<AdminWriteOutcome> {
  // Web 来路的档位值未经 DM 端 asTier 收窄，这里再守一道（DM 来路恒合法）。
  for (const v of [opts.mode, opts.guestMode]) {
    if (v !== undefined && !TIERS.includes(v)) return { ok: false, reason: `未知权限档「${String(v)}」` };
  }
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  // 后端档位兼容守门：后端在创建时选定、运行时固定（不支持切换），但权限档可改。
  // 若把档改到该后端的 supportedModes 之外（某后端若只支持部分档，却改到档外），
  // 新话题会在 backend.startThread 的 fail-closed 守卫处直接抛错、整群卡死。提前在这里拦住，
  // 给清晰原因，而不是让用户改完才发现聊不了。codex（supportedModes undefined）全档放行。
  const entry = p.backend ? catalogById(p.backend) : undefined;
  if (entry?.supportedModes) {
    const resMode = opts.mode ?? effectiveMode(p);
    const resGuest = opts.guestMode ?? effectiveGuestMode(p);
    const bad = [...new Set([resMode, resGuest])].find((t) => !entry.supportedModes!.includes(t));
    if (bad !== undefined) {
      return {
        ok: false,
        reason:
          `项目的后端「${entry.displayName}」仅支持 ${entry.supportedModes.map(tierLabel).join(' / ')} 权限档，` +
          `无法改到「${tierLabel(bad)}」。该后端是创建时选定、运行时固定的；如需更低权限档，请删项目后改用 codex 后端重建。`,
      };
    }
  }
  // updateProject 跳过 undefined 值 —— 与 DM 旧写法 {...(mode?{mode}:{})} 等价。
  await updateProject(opts.projectName, { mode: opts.mode, guestMode: opts.guestMode, network: opts.network });
  await opts.evictLiveSessionsForChat(p.chatId);
  return { ok: true, project: await freshOr(opts.projectName, p) };
}

/** ✋ 免@ 开关（DM dm.proj.noMention / gs.noMention 与 Web setNoMention 同源）。
 * 即时生效（每条消息读盘判定），无需驱逐。 */
export async function performSetNoMention(opts: { projectName: string; on: boolean }): Promise<AdminWriteOutcome> {
  return performSetParticipation({ projectName: opts.projectName, policy: opts.on ? 'all' : 'mention' });
}

export async function performSetDiscuss(opts: { projectName: string; on: boolean }): Promise<AdminWriteOutcome> {
  if (typeof opts.on !== 'boolean') return { ok: false, reason: 'Discuss 开关必须是布尔值' };
  return performSetParticipation({ projectName: opts.projectName, policy: opts.on ? 'model' : 'mention' });
}

/** Per-project briefing policy, read at intake; never interrupts a live turn. */
export async function performSetContextBriefing(opts: { projectName: string; on?: boolean; model?: string; fast?: boolean }): Promise<AdminWriteOutcome> {
  if ((opts.on !== undefined && typeof opts.on !== 'boolean') || (opts.fast !== undefined && typeof opts.fast !== 'boolean')) return { ok: false, reason: '消息简史和 Fast 开关必须是布尔值' };
  if (opts.model !== undefined && (typeof opts.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(opts.model))) return { ok: false, reason: '无效的消息总结模型 ID' };
  if (opts.on === undefined && opts.model === undefined && opts.fast === undefined) return { ok: false, reason: '未提供消息简史设置' };
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  const patch = { contextBriefing: opts.on, contextBriefingModel: opts.model, contextBriefingFast: opts.fast };
  await updateProject(opts.projectName, patch);
  return { ok: true, project: await freshOr(opts.projectName, p) };
}

/** 🗜️ 自动压缩开关（DM dm.proj.autoCompact / gs.autoCompact 与 Web 同源）：
 * 压缩上限在 thread/start 绑定，落盘后驱逐活跃会话让下一条消息重绑生效。 */
export async function performSetAutoCompact(opts: {
  projectName: string;
  on: boolean;
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
}): Promise<AdminWriteOutcome> {
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  await updateProject(opts.projectName, { autoCompact: opts.on });
  await opts.evictLiveSessionsForChat(p.chatId);
  return { ok: true, project: await freshOr(opts.projectName, { ...p, autoCompact: opts.on }) };
}

/** 🤖 设置项目「新话题默认模型 / 推理强度」。**不驱逐活跃会话**——默认只管新会话，
 * 进行中 / 已 resume 的会话保留各自显式选择（语义上不该被默认改动打断，也免去给非
 * 管理员留 DoS 面）。model 的有效性（在该后端实时模型列表内、effort 受该模型支持）
 * 由调用方在写前对着 live listModels 校验 + 收窄；这里只确保项目存在并落盘。读取侧
 * 的最终防线在 {@link pickDefault}：盘上若仍存到坏值，apply 时会被忽略并回落后端默认。 */
export async function performSetModelDefault(opts: {
  projectName: string;
  model: string;
  effort?: ReasoningEffort;
}): Promise<AdminWriteOutcome> {
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: `项目「${opts.projectName}」不存在` };
  await updateProject(opts.projectName, { defaultModel: opts.model, defaultEffort: opts.effort });
  return { ok: true, project: await freshOr(opts.projectName, { ...p, defaultModel: opts.model, defaultEffort: opts.effort }) };
}

/**
 * 🔔 设置普通任务结束提醒。该偏好属于每个 bot 的 config.json，而非项目注册表：
 * 必须在持有 LIVE `cfg` 的 bot 进程内执行，先原子落盘，再替换同一个 cfg 对象的
 * preferences 引用，使正在运行的任务链路下一次读取就能看到新策略。Web/supervisor
 * 只能投递 {@link AdminWriteOp}，不得跨进程直写配置文件。
 */
export async function performSetCompletionReminder(opts: {
  cfg: AppConfig;
  mode: CompletionReminderMode;
  /** Omit for a mode-only update; the writer merges the latest queued threshold. */
  longTaskMinutes?: number;
  /** 测试注入；生产缺省走 config/store 的原子 saveConfig。 */
  persistConfig?: (cfg: AppConfig) => Promise<void>;
  /** 与其它 DM/Web preferences 写共享的串行 writer。 */
  writePreferences?: AppPreferencesWriter;
}): Promise<AdminPreferencesWriteOutcome> {
  if (!COMPLETION_REMINDER_MODES.includes(opts.mode)) {
    return { ok: false, reason: `未知完成提醒策略「${String(opts.mode)}」` };
  }
  if (
    opts.longTaskMinutes !== undefined &&
    (!Number.isInteger(opts.longTaskMinutes) ||
      opts.longTaskMinutes < COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES ||
      opts.longTaskMinutes > COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES)
  ) {
    return {
      ok: false,
      reason:
        `长任务阈值必须是 ${COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES}–` +
        `${COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES} 之间的整数分钟`,
    };
  }

  // 不直接先 mutate LIVE cfg：若落盘失败，运行态仍保留旧值，不会出现“本轮生效、重启丢失”。
  const writePreferences =
    opts.writePreferences ?? createAppPreferencesWriter({ cfg: opts.cfg, persistConfig: opts.persistConfig });
  await writePreferences((preferences) => {
    const current = getCompletionReminderConfig({ ...opts.cfg, preferences });
    preferences.completionReminder = {
      mode: opts.mode,
      longTaskMinutes: opts.longTaskMinutes ?? current.longTaskMinutes,
    };
  });
  return { ok: true, completionReminder: getCompletionReminderConfig(opts.cfg) };
}

export interface AdminWriteExecutorDeps {
  backendFor: (id?: string) => AgentBackend;
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
  /** LIVE bot config；setCompletionReminder 需要它来热更新运行态。 */
  cfg?: AppConfig;
  /** 测试注入；生产缺省由 performSetCompletionReminder 调 saveConfig。 */
  persistConfig?: (cfg: AppConfig) => Promise<void>;
  /** 与 DM 设置共用，避免 Web/DM 并发读改写丢字段。 */
  writePreferences?: AppPreferencesWriter;
}

/** Orchestrator.adminExecute 的实现体：AdminWriteOp → 对应 perform*；拒绝抛
 * {@link AdminWriteError}（HTTP 409 / IPC code 还原）。Web/IPC 专用入口——DM
 * 回调直接调 perform* 拿 outcome 渲染卡片，不走这里。 */
export function createAdminWriteExecutor(deps: AdminWriteExecutorDeps): (op: AdminWriteOp) => Promise<void> {
  const writePreferences =
    deps.writePreferences ??
    (deps.cfg ? createAppPreferencesWriter({ cfg: deps.cfg, persistConfig: deps.persistConfig }) : undefined);
  return async (op) => {
    const outcome = await runAdminWriteOp(op, { ...deps, writePreferences });
    if (!outcome.ok) throw new AdminWriteError(outcome.reason);
  };
}

/** AdminWriteOp 分发（exported for tests）。 */
export async function runAdminWriteOp(
  op: AdminWriteOp,
  deps: AdminWriteExecutorDeps,
): Promise<AdminWriteOutcome | AdminPreferencesWriteOutcome> {
  switch (op.kind) {
    case 'switchBackend':
      return performBackendSwitch({ projectName: op.project, target: op.backend, backendFor: deps.backendFor });
    case 'setPermissionMode':
      return performSetPermissionMode({
        projectName: op.project,
        mode: op.mode,
        guestMode: op.guestMode,
        network: op.network,
        evictLiveSessionsForChat: deps.evictLiveSessionsForChat,
      });
    case 'setNoMention':
      return performSetNoMention({ projectName: op.project, on: op.on });
    case 'setParticipation':
      return performSetParticipation({ projectName: op.project, policy: op.policy });
    case 'setDiscuss':
      return performSetDiscuss({ projectName: op.project, on: op.on });
    case 'setContextBriefing':
      return performSetContextBriefing({ projectName: op.project, on: op.on, model: op.model, fast: op.fast });
    case 'setAutoCompact':
      return performSetAutoCompact({
        projectName: op.project,
        on: op.on,
        evictLiveSessionsForChat: deps.evictLiveSessionsForChat,
      });
    case 'setCompletionReminder':
      if (!deps.cfg) return { ok: false, reason: 'bot 运行配置不可用，无法即时更新完成提醒' };
      return performSetCompletionReminder({
        cfg: deps.cfg,
        mode: op.mode,
        longTaskMinutes: op.longTaskMinutes,
        persistConfig: deps.persistConfig,
        writePreferences: deps.writePreferences,
      });
  }
}

export async function performSetParticipation(opts: { projectName: string; policy: ParticipationPolicy }): Promise<AdminWriteOutcome> {
  if (!['all', 'model', 'mention'].includes(opts.policy)) return { ok: false, reason: '无效的 AI 参与策略' };
  const p = await getProjectByName(opts.projectName);
  if (!p) return { ok: false, reason: '项目不存在' };
  if (opts.policy === 'model' && (p.kind !== 'single' || (p.backend && p.backend !== 'codex-appserver'))) return { ok: false, reason: '模型自行决定回复目前仅支持 Codex 单会话群' };
  const patch = { participation: opts.policy, discuss: opts.policy === 'model', noMention: opts.policy === 'all' };
  await updateProject(opts.projectName, patch);
  return { ok: true, project: await freshOr(opts.projectName, { ...p, ...patch }) };
}
