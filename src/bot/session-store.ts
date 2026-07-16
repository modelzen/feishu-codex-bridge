import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { DEFAULT_BACKEND_ID, type ReasoningEffort } from '../agent/types';

/**
 * A persisted session = one Feishu topic (thread) bound to a codex thread.
 * Survives bridge restarts so @bot inside an existing topic resumes the right
 * codex thread (instead of silently starting a fresh one) and the ⚙️ per-session
 * model/effort overrides stick.
 */
export interface SessionRecord {
  /** Feishu topic thread_id (the key) */
  threadId: string;
  chatId: string;
  cwd: string;
  /** backend session id（codex 的 thread id / claude 的 session UUID）—— pass to
   * backend.resumeThread。v1 文件里的旧字段名在 read() 时迁移（见 migrate）。 */
  sessionId: string;
  /** 创建该会话的 agent 后端 id（见 src/agent/index.ts 注册表）。重启后
   * resolveThread 按它路由 resume —— 项目事后换后端不影响既有会话的归属。
   * v1 文件缺省 → 默认 codex 后端（read() 时回填）。 */
  backend: string;
  /** Present only when this binding points at a Bridge-owned native session
   * registered for one-time resume titling. Manual /resume records omit it. */
  titleJobKey?: string;
  model?: string;
  effort?: ReasoningEffort;
  /** first user message excerpt, for context */
  summary: string;
  /** createTime (epoch ms) of the most recent message woven into this session —
   * the high-water mark for topic-history catch-up: the next turn only pulls
   * thread messages newer than this (see context-weave.fetchThreadContext). */
  lastSeenAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type SessionTitlePhase =
  | 'waiting_source'
  | 'waiting_turn'
  | 'pending'
  | 'generating'
  | 'prepared'
  | 'applying'
  | 'done'
  | 'skipped';

export interface SessionTitlePolicySnapshot {
  strategy: 'model' | 'truncate';
  model?: string;
  effort?: ReasoningEffort;
}

export type SessionTitleOutcome = 'written' | 'preexisting' | 'unsupported' | 'excluded' | 'failed';

/**
 * Durable title work is keyed by the HOST session, not the Feishu topic. A
 * single-session group's `/clear` or in-place `/resume` replaces its
 * {@link SessionRecord}, while the parked host session still needs its title
 * job to finish. Keeping this ledger alongside (rather than inside) a binding
 * also deduplicates one host session resumed into multiple Feishu topics.
 */
export interface SessionTitleJob {
  /** Stable compound key produced by {@link sessionTitleJobKey}. */
  key: string;
  backend: string;
  sessionId: string;
  cwd: string;
  phase: SessionTitlePhase;
  /** Clean first user prompt; terminal jobs may erase it after completion. */
  source?: string;
  /** Final normalized value, persisted BEFORE the host title mutation. */
  candidate?: string;
  /** Observed/written terminal title, for diagnostics. */
  finalTitle?: string;
  /** Backend-specific title model choice captured when the job is claimed. */
  policy?: SessionTitlePolicySnapshot;
  /** Worker lease. claimId gates every later conditional transition. */
  claimId?: string;
  leaseUntil?: number;
  attempts: number;
  nextRetryAt?: number;
  outcome?: SessionTitleOutcome;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  version: number;
  sessions: SessionRecord[];
  titleJobs: SessionTitleJob[];
}

// v3：在 sessions 绑定外新增按 backend+sessionId 去重的持久 titleJobs。
// 旧 v1/v2 读入时 titleJobs=[]，不静默回填历史会话。
const FILE_VERSION = 3;

/** v1 文件的旧字段名（`codexThread` + `Id`）。拼接而非字面量，是为了让「全链改名
 * 后 grep 旧名 = 0」的判据可机械验证 —— 这里是全仓唯一还认得旧名的地方。 */
const LEGACY_V1_SESSION_FIELD = 'codexThread' + 'Id';

/** 旧记录读入迁移：v1 的旧会话 id 字段 → sessionId；缺 backend 回填默认 codex
 * 后端（v1 时代只有它）。原地落盘格式只在下次写盘时才换新（read 不回写），
 * 所以迁移必须幂等且每次 read 都跑。 */
function migrate(raw: Record<string, unknown>): SessionRecord {
  const rec = raw as unknown as SessionRecord;
  if (typeof rec.sessionId !== 'string') {
    const legacy = raw[LEGACY_V1_SESSION_FIELD];
    if (typeof legacy === 'string') (rec as { sessionId: string }).sessionId = legacy;
  }
  if (typeof rec.backend !== 'string') (rec as { backend: string }).backend = DEFAULT_BACKEND_ID;
  return rec;
}

function emptyStore(): StoreFile {
  return { version: FILE_VERSION, sessions: [], titleJobs: [] };
}

async function readStoreIn(file: string): Promise<StoreFile> {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    const sessions = Array.isArray(parsed.sessions)
      ? (parsed.sessions as unknown as Record<string, unknown>[]).map(migrate)
      : [];
    // v1/v2 deliberately migrate to an EMPTY ledger: the feature only owns
    // bridge-created sessions registered after the upgrade.
    const titleJobs =
      typeof parsed.version === 'number' && parsed.version >= 3 && Array.isArray(parsed.titleJobs)
        ? (parsed.titleJobs as SessionTitleJob[])
        : [];
    return { version: FILE_VERSION, sessions, titleJobs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
}

async function read(): Promise<StoreFile> {
  return readStoreIn(paths.sessionsFile);
}

/** 读取指定 sessions.json（绝对路径，含 v1 迁移）。Web 控制台 / supervisor 跨
 * bot 聚合视图专用——daemon 进程内绝不可用 useBotDir 全局切目录。 */
export async function listSessionsIn(file: string): Promise<SessionRecord[]> {
  return (await readStoreIn(file)).sessions;
}

// 同进程内并发的「读-改-写」串行化（upsertSession/patchSession）：话题天然并行
// （semaphore 默认 10），两个话题同时落盘会基于同一旧快照算结果、后写覆盖前写——
// 其中一个话题的 sessionId 绑定静默丢失，重启后上下文蒸发。与 registry.ts 的
// 同款锁一致：配合函数式 updater，把 read+算+write 收进一个临界区。
let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function write(store: StoreFile): Promise<void> {
  await mkdir(dirname(paths.sessionsFile), { recursive: true });
  const tmp = `${paths.sessionsFile}.tmp-${process.pid}-${randomUUID()}`;
  const body: StoreFile = { version: FILE_VERSION, sessions: store.sessions, titleJobs: store.titleJobs };
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.sessionsFile);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return (await read()).sessions;
}

export async function getSession(threadId: string): Promise<SessionRecord | undefined> {
  return (await read()).sessions.find((s) => s.threadId === threadId);
}

/** Insert or replace a session by threadId. */
export async function upsertSession(rec: SessionRecord): Promise<void> {
  return withLock(async () => {
    const store = await read();
    const idx = store.sessions.findIndex((s) => s.threadId === rec.threadId);
    if (idx === -1) store.sessions.push(rec);
    else store.sessions[idx] = rec;
    await write(store);
  });
}

/** Patch fields of an existing session; no-op if it doesn't exist. `patch` 可以是
 * 对象，或一个 `(s) => patch` 函数——后者在同一临界区内基于**最新盘值**计算补丁，
 * 避免并发读-改-写丢更新。 */
export async function patchSession(
  threadId: string,
  patch:
    | Partial<Omit<SessionRecord, 'threadId'>>
    | ((s: SessionRecord) => Partial<Omit<SessionRecord, 'threadId'>>),
): Promise<void> {
  return withLock(async () => {
    const store = await read();
    const rec = store.sessions.find((s) => s.threadId === threadId);
    if (!rec) return;
    const actual = typeof patch === 'function' ? patch(rec) : patch;
    const target = rec as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(actual)) {
      if (v !== undefined) target[k] = v;
    }
    rec.updatedAt = Date.now();
    await write(store);
  });
}

/** Remove a consumed title marker only if it still points at `key`. The
 * conditional protects a concurrent /clear or /resume replacement. */
export async function clearSessionTitleJobKey(threadId: string, key: string): Promise<void> {
  return withLock(async () => {
    const store = await read();
    const rec = store.sessions.find((session) => session.threadId === threadId);
    if (!rec || rec.titleJobKey !== key) return;
    delete rec.titleJobKey;
    rec.updatedAt = Date.now();
    await write(store);
  });
}

/** Stable identity for title exactly-once coordination across Feishu bindings. */
export function sessionTitleJobKey(backend: string, sessionId: string): string {
  return `${backend}:${sessionId}`;
}

export async function listSessionTitleJobs(): Promise<SessionTitleJob[]> {
  return (await read()).titleJobs;
}

export async function getSessionTitleJob(key: string): Promise<SessionTitleJob | undefined> {
  return (await read()).titleJobs.find((job) => job.key === key);
}

/**
 * Insert a title job iff this backend session has never been registered. The
 * existing value wins on duplicates, which makes fresh/adopt/resume races
 * idempotent. `key` is validated so callers cannot accidentally split one host
 * session across two ledger entries.
 */
export async function createSessionTitleJob(job: SessionTitleJob): Promise<boolean> {
  const expected = sessionTitleJobKey(job.backend, job.sessionId);
  if (job.key !== expected) throw new Error(`invalid session title job key: expected ${expected}`);
  return withLock(async () => {
    const store = await read();
    const existing = store.titleJobs.find((item) => item.key === job.key);
    if (existing) return false;
    store.titleJobs.push(job);
    await write(store);
    return true;
  });
}

/**
 * Atomic compare-and-replace for worker claims and every later phase transition.
 * Predicate + updater run under the SAME lock and against the latest disk value;
 * only one concurrent `pending -> generating` claimant can win. Unlike
 * patchSession, the updater returns a COMPLETE replacement: omitting source,
 * candidate, policy, claimId, etc. really removes it, which terminal/recovery
 * transitions need. Stable identity and createdAt cannot be changed.
 */
export async function updateSessionTitleJob(
  key: string,
  predicate: (job: Readonly<SessionTitleJob>) => boolean,
  updater: (job: Readonly<SessionTitleJob>) => SessionTitleJob,
): Promise<boolean> {
  return withLock(async () => {
    const store = await read();
    const idx = store.titleJobs.findIndex((item) => item.key === key);
    if (idx === -1) return false;
    const job = store.titleJobs[idx]!;
    if (!predicate(job)) return false;
    const snapshot: SessionTitleJob = { ...job, ...(job.policy ? { policy: { ...job.policy } } : {}) };
    const replacement = updater(snapshot);
    if (
      replacement.key !== job.key ||
      replacement.backend !== job.backend ||
      replacement.sessionId !== job.sessionId ||
      replacement.createdAt !== job.createdAt
    ) {
      throw new Error('session title job updater cannot change stable identity or createdAt');
    }
    store.titleJobs[idx] = { ...replacement, updatedAt: Date.now() };
    await write(store);
    return true;
  });
}
