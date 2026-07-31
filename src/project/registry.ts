import { paths } from '../config/paths';
import type { PermissionMode, ReasoningEffort } from '../agent/types';
import {
  readBridgeProjectsFile,
  writeBridgeProjectsFile,
} from '../runtime/data-store';

/** A project = a Feishu group bound to a fixed working directory. */
export interface Project {
  /** Vonvon runtime switch. Explicit false keeps the project manageable but
   * prevents message/reaction execution. Omitted preserves upstream behavior. */
  enabled?: boolean;
  /** unique project name (also the group name) */
  name: string;
  /** the bound Feishu group chat_id (oc_xxx) */
  chatId: string;
  /** absolute working directory codex runs in for this project */
  cwd: string;
  /** true when bridge created the cwd as a blank project (under projectsRootDir) */
  blank: boolean;
  createdAt: number;
  /** last branch shown in the announcement (for lazy change detection) */
  branch?: string;
  /** group session model: 'multi' (default) = a topic per session (现状);
   * 'single' = the whole group is one session keyed by chatId. */
  kind?: 'multi' | 'single';
  /** respond to non-@ messages too. Read as `noMention ?? defaultNoMention(p)`.
   * multi: only inside a topic; single: whole group. Needs im:message.group_msg. */
  noMention?: boolean;
  /** how the bot got into this group. 'created' (default, omitted on old data) =
   * bridge built the group via chat.create and is its owner; 'joined' = a human
   * added the bot to a pre-existing group and the bot is just a plain member. */
  origin?: 'created' | 'joined';
  /** for 'joined' projects: open_id of the person who added the bot + did the
   * bind (the bot DMs them the bind card / a removal notice). */
  addedBy?: string;
  /** 项目级响应白名单：谁能让 bot 在本群响应/跑 codex。空/缺省 = 所有人；
   * admin/owner 恒豁免（见 isUserAllowedInProject）。 */
  allowedUsers?: string[];
  /** permission tier for codex's sandbox — the tier ADMINS/owner get. Omitted on
   * old data → treated as 'full' (danger-full-access), preserving prior behavior.
   * Read via {@link effectiveMode}. 'qa'/'write' confine reads+writes to `cwd`. */
  mode?: PermissionMode;
  /** permission tier for NON-admin senders. Unset → same as `mode` (no split,
   * the historical single-tier behavior). When set to a distinct tier, admin and
   * guest turns run on SEPARATE codex threads (see {@link turnTier}). Read via
   * {@link effectiveGuestMode}. */
  guestMode?: PermissionMode;
  /** allow the sandboxed agent's shell to reach the network (only meaningful for
   * 'qa'/'write'; 'full' is always networked). Default false. */
  network?: boolean;
  /** let codex auto-compact this project's threads when context fills (codex's
   * own built-in, on by default). Read as `autoCompact ?? true`; when false the
   * bridge pushes codex's auto-compact token limit past any real usage to disable
   * it (see backend sandboxParams / AUTO_COMPACT_OFF_LIMIT). */
  autoCompact?: boolean;
  /** agent backend id for this project (see src/agent/index.ts registry).
   * Omitted on old/normal data → the codex default (DEFAULT_BACKEND_ID — historical path,
   * zero behavior change). Routed per project in createOrchestrator's
   * backendFor(). Set via the DM 项目设置卡的「🧠 后端」picker（校验见
   * validateBackendSwitch）；只影响新话题——已有话题会话按 SessionRecord.backend
   * 仍走原后端. */
  backend?: string;
  /** 本项目**新话题**的默认模型 id。优先级在 per-session `/model` 覆盖之下、后端自带
   * 默认之上。跟项目 backend 走（创建时固定）；读取时经 {@link pickDefault} 对后端的
   * **实时**模型列表校验——不在列表里（改了后端 / 模型下架）即忽略、回落后端 isDefault，
   * 所以默认值自愈、永不把坏 id 喂给 CLI。只影响新会话，不动进行中 / 已 resume 的会话。
   * 在 DM 项目设置卡（或群 /settings 镜像）里设；仅管理员可改。 */
  defaultModel?: string;
  /** 本项目新话题的默认推理强度。仅当所选 {@link defaultModel} 支持该 effort 时生效，
   * 否则回落该模型的 defaultEffort（claude 等不调 effort 的后端忽略）。 */
  defaultEffort?: ReasoningEffort;
}

/** Only an explicit false disables execution; old upstream records stay live. */
export function isProjectEnabled(project: Pick<Project, 'enabled'>): boolean {
  return project.enabled !== false;
}

/**
 * Default for 免@ (respond without @) when a project hasn't set `noMention`
 * explicitly. On for everything **except** a *joined* single-session group:
 * making the whole of a pre-existing (possibly busy / multi-person) group run
 * codex on every message without an @ is too aggressive, so that one combo
 * defaults off. Created groups (incl. single) keep the historical default (on),
 * so existing data is unaffected. Single source of truth — every
 * `noMention ?? …` read goes through here.
 */
export function defaultNoMention(p: Pick<Project, 'kind' | 'origin'>): boolean {
  return !((p.origin ?? 'created') === 'joined' && (p.kind ?? 'multi') === 'single');
}

/**
 * A project's effective permission tier. Old data (no `mode`) → 'full', so
 * existing projects keep danger-full-access and are unaffected; only an
 * explicitly-set tier confines the sandbox. Single source of truth — every
 * `mode ?? …` read goes through here.
 */
export function effectiveMode(p: Pick<Project, 'mode'>): PermissionMode {
  return p.mode ?? 'full';
}

/**
 * The effective tier for NON-admin senders. Unset `guestMode` → same as the
 * admin tier ({@link effectiveMode}), i.e. no split (everyone shares one tier,
 * the historical behavior). Single source of truth for the guest-side read.
 */
export function effectiveGuestMode(p: Pick<Project, 'mode' | 'guestMode'>): PermissionMode {
  return p.guestMode ?? effectiveMode(p);
}

/**
 * Resolve a turn's permission tier + role from the sender's admin status.
 * `split` is true only when a distinct `guestMode` is configured — then the
 * sandbox AND the codex conversation history (both bound per thread) differ by
 * role, so admin and guest turns MUST run on separate threads. The caller
 * namespaces the session key by `role` when `split` to keep a guest from ever
 * inheriting the admin thread (its sandbox or its history). No split → one
 * shared thread per topic, unchanged from before.
 */
export function turnTier(
  p: Pick<Project, 'mode' | 'guestMode'>,
  isAdminSender: boolean,
): { mode: PermissionMode; role: 'admin' | 'guest'; split: boolean } {
  const adminTier = effectiveMode(p);
  const guestTier = effectiveGuestMode(p);
  return {
    mode: isAdminSender ? adminTier : guestTier,
    role: isAdminSender ? 'admin' : 'guest',
    split: guestTier !== adminTier,
  };
}

async function read(): Promise<Project[]> {
  return listProjectsIn(paths.projectsFile);
}

/** 读取指定 projects.json（绝对路径）。Web 控制台 / supervisor 跨 bot 聚合视图
 * 专用——daemon 进程内绝不可用 useBotDir 全局切目录，显式路径才安全。文件缺失
 * 视为空注册表（与当前 bot 路径同语义）。 */
export async function listProjectsIn(file: string): Promise<Project[]> {
  return readBridgeProjectsFile(file);
}

// 同进程内并发的「读-改-写」串行化（addProject/updateProject/removeProject）：既防
// 共用 tmp 文件交错损坏，也防两个回调基于同一旧快照算 next、后写覆盖前写的丢更新
// （白名单数组增删最易踩中）。配合函数式 updater，把 read+算+write 收进一个临界区。
let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function write(projects: Project[]): Promise<void> {
  await writeBridgeProjectsFile(paths.projectsFile, projects);
}

export async function listProjects(): Promise<Project[]> {
  return read();
}

export async function getProjectByChatId(chatId: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.chatId === chatId);
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.name === name);
}

/** Add a project. Throws if the name — or the bound chat — is already taken.
 * The chatId check is the registry-level hard guard against binding one group
 * twice (createProject's chatId is freshly minted so it never trips). */
export async function addProject(p: Project): Promise<void> {
  return withLock(async () => {
    const projects = await read();
    if (projects.some((x) => x.name === p.name)) {
      throw new Error(`项目名「${p.name}」已存在`);
    }
    if (p.chatId) {
      const bound = projects.find((x) => x.chatId === p.chatId);
      if (bound) throw new Error(`该群已绑定为项目「${bound.name}」`);
    }
    projects.push(p);
    await write(projects);
  });
}

/** Patch fields of a project by name; no-op if it doesn't exist. `patch` 可以是
 * 对象，或一个 `(p) => patch` 函数——后者在同一临界区内基于**最新盘值**计算补丁，
 * 用于数组增量改写（如 allowedUsers append/filter）避免丢更新。 */
export async function updateProject(
  name: string,
  patch: Partial<Omit<Project, 'name'>> | ((p: Project) => Partial<Omit<Project, 'name'>>),
): Promise<void> {
  return withLock(async () => {
    const projects = await read();
    const p = projects.find((x) => x.name === name);
    if (!p) return;
    const actual = typeof patch === 'function' ? patch(p) : patch;
    const target = p as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(actual)) {
      if (v !== undefined) target[k] = v;
    }
    await write(projects);
  });
}

/** Remove (unbind) a project by name. Returns the removed entry, if any. */
export async function removeProject(name: string): Promise<Project | undefined> {
  return withLock(async () => {
    const projects = await read();
    const idx = projects.findIndex((p) => p.name === name);
    if (idx === -1) return undefined;
    const [removed] = projects.splice(idx, 1);
    await write(projects);
    return removed;
  });
}
