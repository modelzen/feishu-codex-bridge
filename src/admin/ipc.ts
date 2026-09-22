import { AdminWriteError, type AdminWriteOp } from './ops';

/**
 * supervisor ↔ bot 子进程的管理面 IPC（node 'ipc' stdio / process.send）。
 *
 * 为什么是 IPC 而不是 supervisor 文件级直写（设计取舍，第二棒调查结论）：
 *   1. registry 的 withLock 是**进程内**锁——bot 子进程自己也在读-改-写
 *      projects.json，supervisor 直写会与之交错丢更新（O_EXCL 文件锁只能保
 *      互斥，挡不住子进程模块内已排队的旧快照写回）。
 *   2. 写操作的既有语义包含「驱逐活跃会话」（🔐 权限 / 🗜️ 自动压缩），LIVE
 *      线程只存在于 bot 进程内存里——文件锁方案根本做不到，必须进程内执行。
 *   把写请求转发给对应子进程，在子进程内走既有 withLock + 校验 + 驱逐，与
 *   DM 卡片回调完全同一条代码路径（admin/ops.ts）。
 *
 * 消息用 `fcb` 标签隔离（node 内部消息/其他用途互不干扰）；请求按自增 id 关联
 * 响应；caller 端带超时与「子进程退场全拒」兜底，绝不悬挂 HTTP 请求。
 */

export const ADMIN_IPC_REQ = 'fcb.admin.req' as const;
export const ADMIN_IPC_RES = 'fcb.admin.res' as const;

/** 转发给子进程的结构化写 op + 实时连接状态查询（替代锁文件探测）。 */
export type AdminIpcOp = AdminWriteOp | { kind: 'status' };

export interface AdminIpcRequest {
  fcb: typeof ADMIN_IPC_REQ;
  id: number;
  op: AdminIpcOp;
}

export interface AdminIpcResponse {
  fcb: typeof ADMIN_IPC_RES;
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** AdminWriteError 的拒绝码——caller 端按它还原类型（HTTP 层好映射 409）。 */
  code?: string;
}

/** 写请求默认超时：后端切换要 doctor 探活（单后端 3s 兜底）+ 驱逐，留足余量。 */
export const ADMIN_IPC_TIMEOUT_MS = 15_000;

export interface AdminIpcCaller {
  /** 发请求并等响应；超时/子进程退场 reject。op 必须可结构化克隆（纯 JSON）。 */
  call(op: AdminIpcOp, timeoutMs?: number): Promise<unknown>;
  /** 子进程来的消息直喂这里（proc.on('message', caller.onMessage)）；非本协议忽略。 */
  onMessage(raw: unknown): void;
  /** 子进程退出/重启时调用：在途请求全部拒绝（绝不悬挂）。 */
  rejectAll(reason: string): void;
}

/** supervisor 侧：每个子进程一个 caller（子进程重启后换新的——旧在途请求由
 * rejectAll 收尾）。`send` 注入 proc.send（测试里可直连 responder）。 */
export function createAdminIpcCaller(send: (msg: AdminIpcRequest) => void): AdminIpcCaller {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  function settle(id: number): { resolve: (v: unknown) => void; reject: (e: Error) => void } | undefined {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  return {
    call(op, timeoutMs = ADMIN_IPC_TIMEOUT_MS): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`bot 进程 ${timeoutMs}ms 未响应（可能正忙或已假死）`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        try {
          send({ fcb: ADMIN_IPC_REQ, id, op });
        } catch (err) {
          settle(id)?.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    onMessage(raw): void {
      const msg = raw as Partial<AdminIpcResponse> | null;
      if (!msg || msg.fcb !== ADMIN_IPC_RES || typeof msg.id !== 'number') return;
      const entry = settle(msg.id);
      if (!entry) return; // 已超时/已拒绝的迟到响应
      if (msg.ok) {
        entry.resolve(msg.result);
        return;
      }
      const reason = msg.error ?? '子进程执行失败';
      // 校验拒绝跨进程还原成 AdminWriteError —— HTTP 层与进程内路径同样映射 409。
      entry.reject(msg.code === 'ADMIN_WRITE_REJECTED' ? new AdminWriteError(reason) : new Error(reason));
    },

    rejectAll(reason): void {
      for (const id of [...pending.keys()]) {
        settle(id)?.reject(new Error(reason));
      }
    },
  };
}

/**
 * bot 子进程侧：把 supervisor 的请求接到执行器上（run.ts 把它挂到
 * process.on('message')）。`execute` 抛错 → ok:false 响应（带 code 供还原）；
 * 响应发送失败（supervisor 正退场）静默忽略。
 */
export function createAdminIpcResponder(
  execute: (op: AdminIpcOp) => Promise<unknown>,
  send: (msg: AdminIpcResponse) => void,
): (raw: unknown) => void {
  return (raw) => {
    const msg = raw as Partial<AdminIpcRequest> | null;
    if (!msg || msg.fcb !== ADMIN_IPC_REQ || typeof msg.id !== 'number' || !msg.op) return;
    const id = msg.id;
    void execute(msg.op).then(
      (result) => {
        try {
          send({ fcb: ADMIN_IPC_RES, id, ok: true, result });
        } catch {
          /* supervisor 退场中 */
        }
      },
      (err: unknown) => {
        try {
          send({
            fcb: ADMIN_IPC_RES,
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: (err as { code?: string } | null)?.code,
          });
        } catch {
          /* supervisor 退场中 */
        }
      },
    );
  };
}
