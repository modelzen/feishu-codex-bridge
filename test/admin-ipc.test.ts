import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_IPC_REQ,
  ADMIN_IPC_RES,
  createAdminIpcCaller,
  createAdminIpcResponder,
  type AdminIpcOp,
  type AdminIpcRequest,
  type AdminIpcResponse,
} from '../src/admin/ipc';
import { AdminWriteError } from '../src/admin/ops';

/** caller ↔ responder 内存直连（生产里两端各在 supervisor / bot 子进程，经
 * process.send 传输——协议层不感知传输方式，单测直接对接）。 */
function wirePair(execute: (op: AdminIpcOp) => Promise<unknown>) {
  let deliver: (raw: unknown) => void = () => undefined;
  const responder = createAdminIpcResponder(execute, (msg: AdminIpcResponse) => deliver(msg));
  const caller = createAdminIpcCaller((msg: AdminIpcRequest) => responder(msg));
  deliver = caller.onMessage;
  return caller;
}

describe('admin IPC · 请求/响应关联', () => {
  it('roundtrip：op 原样到达执行器，result 原样回到 caller', async () => {
    const seen: AdminIpcOp[] = [];
    const caller = wirePair(async (op) => {
      seen.push(op);
      return op.kind === 'status' ? { connection: 'connected' } : { done: true };
    });
    expect(await caller.call({ kind: 'setNoMention', project: 'demo', on: true })).toEqual({ done: true });
    expect(await caller.call({ kind: 'setCompletionReminder', mode: 'failures', longTaskMinutes: 3 })).toEqual({
      done: true,
    });
    expect(await caller.call({ kind: 'status' })).toEqual({ connection: 'connected' });
    expect(seen).toEqual([
      { kind: 'setNoMention', project: 'demo', on: true },
      { kind: 'setCompletionReminder', mode: 'failures', longTaskMinutes: 3 },
      { kind: 'status' },
    ]);
  });

  it('并发请求按 id 各回各家（乱序响应不串台）', async () => {
    const resolvers = new Map<string, () => void>();
    const caller = wirePair(
      (op) =>
        new Promise((resolve) => {
          const key = op.kind === 'setNoMention' ? op.project : 'status';
          resolvers.set(key, () => resolve({ echo: key }));
        }),
    );
    const p1 = caller.call({ kind: 'setNoMention', project: 'a', on: true });
    const p2 = caller.call({ kind: 'setNoMention', project: 'b', on: true });
    // 故意先回后发的请求
    resolvers.get('b')!();
    resolvers.get('a')!();
    expect(await p1).toEqual({ echo: 'a' });
    expect(await p2).toEqual({ echo: 'b' });
  });

  it('执行器抛 AdminWriteError → caller 端按 code 还原同类型（HTTP 层好映射 409）', async () => {
    const caller = wirePair(async () => {
      throw new AdminWriteError('后端「x」当前不可用');
    });
    const err = await caller.call({ kind: 'switchBackend', project: 'demo', backend: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminWriteError);
    expect((err as AdminWriteError).message).toContain('不可用');
  });

  it('执行器抛普通 Error → caller 端收到普通 Error（不误判成校验拒绝）', async () => {
    const caller = wirePair(async () => {
      throw new Error('boom');
    });
    const err = await caller.call({ kind: 'status' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AdminWriteError);
  });
});

describe('admin IPC · 兜底（超时 / 子进程退场 / 脏消息）', () => {
  it('超时 reject（绝不悬挂 Web 请求）；迟到响应被静默忽略', async () => {
    vi.useFakeTimers();
    try {
      let respond: (() => void) | undefined;
      const caller = wirePair(
        () =>
          new Promise((resolve) => {
            respond = () => resolve({ late: true });
          }),
      );
      const p = caller.call({ kind: 'status' }, 1000);
      const pErr = p.catch((e: unknown) => e);
      vi.advanceTimersByTime(1001);
      expect(String(await pErr)).toContain('未响应');
      respond!(); // 迟到响应：pending 已清，onMessage 静默丢弃（不抛、不串台）
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejectAll：子进程退出时在途请求全部拒绝', async () => {
    const caller = createAdminIpcCaller(() => undefined); // 只发不回
    const p1 = caller.call({ kind: 'status' }).catch((e: unknown) => String(e));
    const p2 = caller.call({ kind: 'setNoMention', project: 'demo', on: true }).catch((e: unknown) => String(e));
    caller.rejectAll('bot 进程已退出');
    expect(await p1).toContain('已退出');
    expect(await p2).toContain('已退出');
  });

  it('send 同步抛错（IPC 通道已关）→ 该请求立即 reject', async () => {
    const caller = createAdminIpcCaller(() => {
      throw new Error('IPC 通道已关闭');
    });
    await expect(caller.call({ kind: 'status' })).rejects.toThrow('通道已关闭');
  });

  it('caller/responder 都忽略非本协议消息（node 内部消息混进来不炸）', async () => {
    const sent: AdminIpcResponse[] = [];
    const responder = createAdminIpcResponder(async () => ({}), (m) => void sent.push(m));
    responder(null);
    responder('hello');
    responder({ cmd: 'NODE_HANDLE' });
    responder({ fcb: ADMIN_IPC_RES, id: 1 }); // 错方向的标签也不响应
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);

    const caller = createAdminIpcCaller(() => undefined);
    expect(() => {
      caller.onMessage(null);
      caller.onMessage({ fcb: ADMIN_IPC_REQ, id: 1, op: { kind: 'status' } }); // 错方向
      caller.onMessage({ fcb: ADMIN_IPC_RES, id: 999, ok: true }); // 无人认领
    }).not.toThrow();
  });
});
