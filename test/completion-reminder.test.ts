import { describe, expect, it, vi } from 'vitest';
import {
  buildCompletionReminderContent,
  formatCompletionElapsed,
} from '../src/card/completion-reminder';
import { RunRender } from '../src/card/run-render';
import {
  isCompletionReminderRequester,
  settleOrdinaryTurnRender,
} from '../src/bot/handle-message';
import { sendCompletionReminderReply } from '../src/bot/completion-reminder';
import type { AppConfig } from '../src/config/schema';

function dedupe() {
  const ids = new Set<string>();
  return {
    seen(id: string) {
      if (ids.has(id)) return true;
      ids.add(id);
      return false;
    },
  };
}

function replyChannel(reply = vi.fn(async (_request: any) => ({}))) {
  return {
    reply,
    channel: { rawClient: { im: { v1: { message: { reply } } } } } as never,
  };
}

function config(mode?: 'manual' | 'long' | 'failures' | 'always'): AppConfig {
  return {
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    ...(mode ? { preferences: { completionReminder: { mode, longTaskMinutes: 3 } } } : {}),
  };
}

describe('completion reminder post', () => {
  it('uses a native structured at node and a clean success summary', () => {
    const content = JSON.parse(
      buildCompletionReminderContent({
        requesterOpenId: 'ou_requester',
        outcome: 'done',
        elapsedMs: 4 * 60_000 + 12_000,
        summary: '  检查\n登录失败原因  ',
        cardUpdated: true,
      }),
    );
    const [headline, detail] = content.zh_cn.content;
    expect(headline[0]).toEqual({ tag: 'at', user_id: 'ou_requester' });
    expect(headline[1].text).toContain('「检查 登录失败原因」已完成 · 用时 4 分 12 秒');
    expect(detail[0].text).toBe('结果在上方卡片。');
    expect(JSON.stringify(content)).not.toContain('@ou_requester');
  });

  it('distinguishes agent error, idle timeout, and terminal-card fallback copy', () => {
    const failed = JSON.parse(
      buildCompletionReminderContent({
        requesterOpenId: 'ou_1',
        outcome: 'error',
        elapsedMs: 9_000,
        summary: '修复构建',
        cardUpdated: true,
      }),
    );
    expect(failed.zh_cn.content[0][1].text).toContain('执行失败');
    expect(failed.zh_cn.content[1][0].text).toBe('详情在上方卡片。');

    const timedOut = JSON.parse(
      buildCompletionReminderContent({
        requesterOpenId: 'ou_1',
        outcome: 'idle_timeout',
        elapsedMs: 181_000,
        summary: '长命令',
        cardUpdated: false,
      }),
    );
    expect(timedOut.zh_cn.content[0][1].text).toContain('响应超时');
    expect(timedOut.zh_cn.content[1][0].text).toContain('最终卡片更新失败');
  });

  it('formats long elapsed durations and truncates a noisy title', () => {
    expect(formatCompletionElapsed(3_661_999)).toBe('1 小时 1 分 1 秒');
    expect(formatCompletionElapsed(-1)).toBe('0 秒');
    const content = JSON.parse(
      buildCompletionReminderContent({
        requesterOpenId: 'ou_1',
        outcome: 'done',
        elapsedMs: 0,
        summary: 'x'.repeat(100),
        cardUpdated: true,
      }),
    );
    expect(content.zh_cn.content[0][1].text).toContain(`${'x'.repeat(31)}…`);
    expect(content.zh_cn.content[0][1].text).not.toContain('x'.repeat(32));
  });
});

describe('completion reminder runtime outcome', () => {
  it('maps an unexplained dead backend to error instead of a false success', () => {
    const render = new RunRender();
    render.apply({ type: 'text', itemId: 'm1', text: 'partial output' });

    settleOrdinaryTurnRender(render, {
      interrupted: false,
      timedOut: false,
      idleTimeoutSeconds: 0,
      procDead: true,
    });

    expect(render.snapshot()).toMatchObject({
      terminal: 'error',
      errorMsg: 'agent 进程异常退出，请重发本条消息',
    });
  });

  it('preserves an explicit backend error when the process is also dead', () => {
    const render = new RunRender();
    render.apply({ type: 'error', message: 'precise app-server failure', willRetry: false });

    settleOrdinaryTurnRender(render, {
      interrupted: false,
      timedOut: false,
      idleTimeoutSeconds: 0,
      procDead: true,
    });

    expect(render.snapshot()).toMatchObject({ terminal: 'error', errorMsg: 'precise app-server failure' });
  });

  it('preserves an explicit done terminal even if the process exits afterwards', () => {
    const render = new RunRender();
    render.apply({ type: 'done', turnId: 'turn_1' });

    settleOrdinaryTurnRender(render, {
      interrupted: false,
      timedOut: false,
      idleTimeoutSeconds: 0,
      procDead: true,
    });

    expect(render.terminal()).toBe('done');
  });
});

describe('completion reminder native reply orchestration', () => {
  it('default failures skips success, sends error/timeout once, and preserves native @ + topic reply', async () => {
    const { channel, reply } = replyChannel();
    const seen = dedupe();
    const base = {
      requesterOpenId: 'ou_requester',
      requestedAt: 1_000,
      manuallyRequested: false,
      summary: '修复构建',
      cardUpdated: true,
      replyInThread: true,
    };
    const deps = { channel, cfg: config(), dedupe: seen, now: () => 11_000 };

    await expect(
      sendCompletionReminderReply(deps, { ...base, cardMsgId: 'om_done', outcome: 'done' }),
    ).resolves.toBe('skipped');
    await expect(
      sendCompletionReminderReply(deps, { ...base, cardMsgId: 'om_error', outcome: 'error' }),
    ).resolves.toBe('sent');
    await expect(
      sendCompletionReminderReply(deps, { ...base, cardMsgId: 'om_error', outcome: 'error' }),
    ).resolves.toBe('skipped');
    await expect(
      sendCompletionReminderReply(deps, {
        ...base,
        cardMsgId: 'om_timeout',
        outcome: 'idle_timeout',
        replyInThread: false,
      }),
    ).resolves.toBe('sent');

    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({
      path: { message_id: 'om_error' },
      data: { msg_type: 'post', reply_in_thread: true },
    });
    const content = JSON.parse(reply.mock.calls[0]![0].data.content);
    expect(content.zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_requester' });
    expect(reply.mock.calls[1]?.[0].data.reply_in_thread).toBe(false);
  });

  it('uses a reply as terminal-card fallback even when the selected policy would skip success', async () => {
    const { channel, reply } = replyChannel();
    const result = await sendCompletionReminderReply(
      { channel, cfg: config(), dedupe: dedupe(), now: () => 10_000 },
      {
        cardMsgId: 'om_fallback',
        requesterOpenId: 'ou_requester',
        outcome: 'done',
        requestedAt: 0,
        manuallyRequested: false,
        cardUpdated: false,
        replyInThread: true,
      },
    );

    expect(result).toBe('sent');
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0].data.content).toContain('最终卡片更新失败');
  });

  it('absorbs delivery failure and still records at-most-once without mutating the terminal input', async () => {
    const { channel, reply } = replyChannel(
      vi.fn(async (_request: any) => Promise.reject(new Error('network down'))),
    );
    const seen = dedupe();
    const input = {
      cardMsgId: 'om_failed_send',
      requesterOpenId: 'ou_requester',
      outcome: 'done' as const,
      requestedAt: 0,
      manuallyRequested: false,
      cardUpdated: true,
      replyInThread: true,
    };

    await expect(
      sendCompletionReminderReply({ channel, cfg: config('always'), dedupe: seen, now: () => 1_000 }, input),
    ).resolves.toBe('failed');
    await expect(
      sendCompletionReminderReply({ channel, cfg: config('always'), dedupe: seen, now: () => 1_000 }, input),
    ).resolves.toBe('skipped');
    expect(reply).toHaveBeenCalledOnce();
    expect(input.outcome).toBe('done');
  });

  it('only the exact turn initiator qualifies for the manual reminder button action', () => {
    expect(isCompletionReminderRequester('ou_owner', 'ou_owner')).toBe(true);
    expect(isCompletionReminderRequester('ou_admin', 'ou_owner')).toBe(false);
    expect(isCompletionReminderRequester(undefined, 'ou_owner')).toBe(false);
  });
});
