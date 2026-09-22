import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { log } from '../../core/logger';
import { AppServerClient, JsonRpcError } from './app-server-client';
import { resolveCodexBin } from './locate';

/**
 * 常驻 app-server 进程（M-2，依据 research/08 实测）：
 *
 *  - **utility client**：thread/list、thread/read、model/list、account/read 强刷
 *    这类元数据 RPC 原本每次各付一整套 spawn+initialize（~500ms）。现在共享一个
 *    懒创建、**出错即重建**的常驻进程；这些 RPC 的 cwd 都是请求参数（thread/list
 *    的 cwd 是过滤条件），与进程 cwd 无关，所以进程 cwd 给中性目录即可。
 *
 *  - **预热池（容量 1）**：冷路径 spawn→initialize≈495ms + 首个 thread/start≈1640ms
 *    （MCP server 启动），同进程第二个 thread/start 仅 ≈64ms。池里预先放一个
 *    spawn+initialize+ephemeral thread/start（触发 MCP 预热、不落盘）完毕的进程，
 *    新会话直接取走（真正的 thread/start|resume 的 cwd/sandbox/权限都是 thread 级
 *    参数，与进程无关——README 与 research/08 已核）；取走后异步补位。
 *
 * 生命周期：会话客户端取走后归 sessions/orchestrator 管（shutdown 会 close）；
 * 池中待命进程与 utility client 归本模块管——bot 的 shutdown 不知道这里，所以挂
 * 一个 process 'exit' 钩子按 pid 兜底 SIGKILL（run.ts 优雅退出最终 process.exit(0)，
 * 必经此钩子），另导出 {@link shutdownResidentClients} 供测试/未来显式接线。
 */

/** 中性目录：池进程与 utility 进程的 spawn cwd。真实会话的 cwd 是 thread/start
 * 的参数，与进程 cwd 无关；预热的 ephemeral thread 也用它，绝不沾项目目录。 */
const NEUTRAL_CWD = tmpdir();

/** initialize 握手死线：utility/预热进程连不上必须可恢复（卡死的 create 单飞
 * Promise 会饿死后续所有 acquire），超时即 close（SIGKILL）重来。 */
const CONNECT_TIMEOUT_MS = 15_000;

/** 预热 thread/start 死线：实测 ~1.6s（MCP 启动），放宽兜异常环境。 */
const PREWARM_TIMEOUT_MS = 60_000;

/** utility RPC 默认死线。原 listThreads/listModels 连 close 都到不了的「挂死到天荒
 * 地老」从此有界；超时即杀进程重建（等价旧短命进程的 finally close 语义）。 */
const DEFAULT_UTILITY_TIMEOUT_MS = 30_000;

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// ── 常驻进程登记 + 退出兜底 ───────────────────────────────────────────

const residents = new Set<AppServerClient>();
let exitHookInstalled = false;

function track(client: AppServerClient): void {
  residents.add(client);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' 里没有事件循环，close() 的优雅等待跑不完——直接按 pid SIGKILL。
  // 会话客户端不在 residents 里（orchestrator.shutdown 已优雅 close 它们）。
  process.once('exit', () => {
    for (const c of residents) {
      const pid = c.pid;
      if (pid === undefined) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
    residents.clear();
  });
}

function untrack(client: AppServerClient): void {
  residents.delete(client);
}

// ── utility client（懒创建、出错即重建） ──────────────────────────────

let utility: { client: AppServerClient; bin: string } | null = null;
let utilityCreating: Promise<unknown> | null = null;

async function acquireUtility(bin: string): Promise<AppServerClient> {
  // 单飞：先等在途的创建落定，再看槽位（绝不并发 spawn 两个 utility）。
  while (utilityCreating) await utilityCreating.catch(() => undefined);
  const cur = utility;
  if (cur && !cur.client.exited && cur.bin === bin) return cur.client;
  if (cur) {
    // 进程死了 / codex 二进制换了位置——重建
    utility = null;
    untrack(cur.client);
    void cur.client.close().catch(() => undefined);
  }
  const create = (async () => {
    const client = new AppServerClient({ bin, cwd: NEUTRAL_CWD, clientName: 'feishu-codex-bridge-utility' });
    // 先登记再连接：在途的 connect 撞上进程退出时，exit 钩子也能按 pid 兜底。
    track(client);
    try {
      await withDeadline(client.connect(), CONNECT_TIMEOUT_MS, 'utility connect');
    } catch (err) {
      untrack(client);
      void client.close().catch(() => undefined);
      throw err;
    }
    // 没人消费常驻客户端的通知流（它不跑 thread）——永远排空，防 AsyncQueue
    // 无界增长；进程退出时流自然结束。
    void (async () => {
      for await (const n of client.stream()) void n;
    })();
    utility = { client, bin };
    log.info('agent', 'utility-up', { pid: client.pid ?? null });
    return client;
  })();
  utilityCreating = create.catch(() => undefined);
  try {
    return await create;
  } finally {
    utilityCreating = null;
  }
}

function discardUtility(client: AppServerClient): void {
  if (utility?.client === client) utility = null;
  untrack(client);
  void client.close().catch(() => undefined);
}

/**
 * 在共享 utility client 上发一个 JSON-RPC 请求（懒连接）。连接失败 / 进程死亡 /
 * 超时都**丢弃当前进程**，下一次调用拿全新进程——「出错即重建」。超时丢弃即
 * close（SIGKILL），保住旧短命进程对 wedged codex 的「杀进程」恢复语义
 * （readHistory 的 20s 死线靠这个不留孤儿）。
 *
 * 例外：应用层 JSON-RPC error 应答（如 thread/read 指向已被 codex 删除的会话）
 * 说明进程健康，原样上抛、进程保留——否则一个调用方的业务错误会 SIGKILL 共享
 * 进程，failAllPending 把并发在飞的其他请求（account/read 强刷、thread/list）
 * 全部打挂，正是本仓库最忌讳的「时灵时不灵」。
 */
export async function utilityRequest<T = unknown>(
  method: string,
  params?: unknown,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const bin = resolveCodexBin();
  if (!bin) throw new Error('codex CLI not found (set CODEX_BIN or install @openai/codex)');
  const client = await acquireUtility(bin);
  try {
    return await withDeadline(
      client.request<T>(method, params),
      opts?.timeoutMs ?? DEFAULT_UTILITY_TIMEOUT_MS,
      `utility ${method}`,
    );
  } catch (err) {
    if (!(err instanceof JsonRpcError)) discardUtility(client);
    throw err;
  }
}

// ── 预热池（容量 1） ──────────────────────────────────────────────────

interface WarmEntry {
  client: AppServerClient;
  bin: string;
  /** bin 文件指纹（mtime+size）——取用时复验，防池中进程跨 codex 升级版本错位 */
  fingerprint: string | null;
}

let warm: WarmEntry | null = null;
let warming: Promise<void> | null = null;

/**
 * Codex 0.153.4 on macOS can leave an app-server unable to re-exec its sandbox
 * helper after an ephemeral read-only thread has been started in that process.
 * Reusing that process for a real thread then fails while loading AGENTS.md with
 * sandbox-exec status 71 / EPERM. Keep prewarming opt-in until the upstream
 * process-level sandbox interaction is fixed; cold app-servers are reliable.
 */
function prewarmEnabled(): boolean {
  return process.env.FEISHU_CODEX_PREWARM === '1';
}

/** bin 文件指纹 = 「codex 版本」的取用时探活代理。statSync 是微秒级且跟随符号
 * 链接，能在取用热进程的瞬间发现「codex 已原地升级/被替换」；版本字符串探测
 * （codex --version ~320ms）放在取用路径会吃掉预热的全部收益，而 locate 的版本
 * 缓存恰恰看不见原地升级——指纹比版本号更严也更便宜。 */
function binFingerprint(bin: string): string | null {
  try {
    const s = statSync(bin);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

/**
 * 取走预热进程（探活：进程活着 + 还是同一个 codex 二进制）。同步执行，并发
 * spawn 不可能双取。失活/版本错位即弃置（refill 会按新二进制补位），返回 null
 * 走冷路径。
 */
export function takeWarmClient(bin: string): AppServerClient | null {
  if (!prewarmEnabled()) return null;
  const entry = warm;
  if (!entry) return null;
  warm = null;
  untrack(entry.client);
  if (entry.client.exited) return null; // 池中阵亡——冷路径接管
  if (entry.bin !== bin || entry.fingerprint !== binFingerprint(bin)) {
    // codex 升级/换位：版本错位的待命进程不能再接新会话
    log.info('agent', 'prewarm-stale', { bin });
    void entry.client.close().catch(() => undefined);
    return null;
  }
  // 预热期间缓冲的通知（MCP 启动进度、ephemeral thread/started…）属于预热
  // 线程，清空——绝不能漏进真实会话的事件流。
  entry.client.clearNotifications();
  log.info('agent', 'prewarm-hit', { pid: entry.client.pid ?? null });
  return entry.client;
}

/**
 * 异步补位（取走即补 / 扑空也补，容量恒 1）。预热 = spawn + initialize +
 * ephemeral thread/start（触发 MCP 启动这 ~1.6s 的大头；ephemeral 不落盘、
 * 弃置无痕）。失败只记日志——预热是纯优化，绝不影响请求路径。
 * 返回在途的补位 Promise（永不 reject），调用方通常 fire-and-forget。
 */
export function refillWarmPool(): Promise<void> {
  if (!prewarmEnabled()) return Promise.resolve();
  if (warm || warming) return warming ?? Promise.resolve();
  warming = (async () => {
    const bin = resolveCodexBin();
    if (!bin) return;
    // 指纹在 spawn 之前取——若 spawn 与升级赛跑，取用时的复验自会兜住。
    const fingerprint = binFingerprint(bin);
    // clientName 用默认值：这个进程取走后就是真实会话的进程（compliance log 同名）。
    const client = new AppServerClient({ bin, cwd: NEUTRAL_CWD });
    // 先登记再预热：补位进行中 daemon 退出时，exit 钩子也能按 pid 兜底。
    track(client);
    try {
      await withDeadline(client.connect(), CONNECT_TIMEOUT_MS, 'prewarm connect');
      await withDeadline(
        client.request('thread/start', {
          cwd: NEUTRAL_CWD,
          ephemeral: true,
          approvalPolicy: 'never',
          sandbox: 'read-only',
        }),
        PREWARM_TIMEOUT_MS,
        'prewarm thread/start',
      );
      warm = { client, bin, fingerprint };
      log.info('agent', 'prewarm-ready', { pid: client.pid ?? null });
    } catch (err) {
      log.fail('agent', err, { phase: 'prewarm' });
      untrack(client);
      void client.close().catch(() => undefined);
    }
  })().finally(() => {
    warming = null;
  });
  return warming;
}

// ── 清理 ──────────────────────────────────────────────────────────────

/** 优雅关掉全部常驻进程（utility + 预热槽，含在途补位）。daemon 路径由 process
 * 'exit' 钩子兜底；这个出口给测试与未来的显式接线用。 */
export async function shutdownResidentClients(): Promise<void> {
  // 等在途的创建/补位落定，否则它们会在我们清完之后才把进程放进槽位
  while (utilityCreating) await utilityCreating.catch(() => undefined);
  if (warming) await warming.catch(() => undefined);
  const targets: AppServerClient[] = [];
  if (utility) {
    targets.push(utility.client);
    utility = null;
  }
  if (warm) {
    targets.push(warm.client);
    warm = null;
  }
  for (const c of targets) untrack(c);
  await Promise.allSettled(targets.map((c) => c.close()));
}
