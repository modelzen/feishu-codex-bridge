import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunCardStream } from '../src/card/run-card-stream';
import { card, mdStream } from '../src/card/cards';

/** A live frame whose only element is the streamed answer ({@link mdStream}). */
function frame(answer: string) {
  return card([mdStream(answer, 'answer')], { streaming: true });
}

/**
 * Minimal fake LarkChannel.rawClient for the streaming pump: records every
 * cardElement.content / card.update / card.settings call; `contentErrs` /
 * `updateErrs` are thrown (once each, in order) by the first pushes.
 */
function fakeChannel(contentErrs: unknown[] = [], updateErrs: unknown[] = []) {
  const contents: Array<{ content: string; sequence: number }> = [];
  const settings: Array<{ settings: string; sequence: number }> = [];
  const updates: Array<{ data: string; sequence: number; at: number }> = [];
  let errIdx = 0;
  let updErrIdx = 0;
  return {
    contents,
    settings,
    updates,
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: async () => ({ data: { card_id: 'c_1' } }),
            update: async (p: { data: { card: { data: string }; sequence: number } }) => {
              if (updErrIdx < updateErrs.length) throw updateErrs[updErrIdx++];
              updates.push({ data: p.data.card.data, sequence: p.data.sequence, at: Date.now() });
              return {};
            },
            settings: async (p: { data: { settings: string; sequence: number } }) => {
              settings.push(p.data);
              return {};
            },
          },
          cardElement: {
            content: async (p: { data: { content: string; sequence: number } }) => {
              if (errIdx < contentErrs.length) throw contentErrs[errIdx++];
              contents.push(p.data);
              return {};
            },
          },
        },
      },
      im: { v1: { message: { create: async () => ({ data: { message_id: 'om_1' } }) } } },
    },
  } as any;
}

/** Create the card, establish the pump's baseline, then grow the answer so the
 * pump routes the second frame to the element typewriter (streamElement). */
async function growAnswer(ch: any): Promise<RunCardStream> {
  const s = new RunCardStream();
  await s.create(ch, 'oc_1', frame('hello'), {});
  s.streamCoalesced(ch, frame('hello'), 'answer'); // baseline (deduped — no push)
  await s.drain();
  s.streamCoalesced(ch, frame('hello world'), 'answer'); // answer grew → element route
  await s.drain();
  return s;
}

describe('RunCardStream.streamElement — streaming_mode recovery', () => {
  it('on 300309 (streaming_mode auto-off) re-enables streaming via settings and resends the frame', async () => {
    const ch = fakeChannel([{ response: { data: { code: 300309, msg: 'streaming mode disabled' } } }]);
    await growAnswer(ch);

    expect(ch.settings).toHaveLength(1);
    expect(JSON.parse(ch.settings[0].settings)).toEqual({ config: { streaming_mode: true } });
    expect(ch.contents).toHaveLength(1);
    expect(ch.contents[0].content).toBe('hello world'); // the SAME frame, re-pushed
    // sequence stays strictly increasing across the failed push → settings → resend
    expect(ch.settings[0].sequence).toBeLessThan(ch.contents[0].sequence);
  });

  it('on 300317 (sequence out-of-order) retries the push once, without touching settings', async () => {
    const ch = fakeChannel([{ code: 300317 }]); // top-level code shape
    await growAnswer(ch);

    expect(ch.settings).toHaveLength(0);
    expect(ch.contents).toHaveLength(1);
    expect(ch.contents[0].content).toBe('hello world');
  });

  it('does not retry a genuine error — logged and dropped, no settings call', async () => {
    const ch = fakeChannel([{ response: { data: { code: 99991663, msg: 'rate limited' } } }]);
    await growAnswer(ch); // must not throw (pump swallows + logs)

    expect(ch.settings).toHaveLength(0);
    expect(ch.contents).toHaveLength(0);
  });
});

// M-4: 终局帧保障 —— 429/99991400 指数退避重试，直到终态卡落地。
describe('RunCardStream.updateCard — 终局帧保障（M-4）', () => {
  afterEach(() => vi.useRealTimers());

  it('serializes file-row updates with demotion and overlays the latest file state onto stale frames', async () => {
    const ch = fakeChannel();
    const elementUpdates: any[] = [];
    ch.rawClient.cardkit.v1.cardElement.update = async (request: any) => { elementUpdates.push(request); return {}; };
    const s = new RunCardStream();
    const initial = card([{ tag: 'column_set', columns: [{ tag: 'column', elements: [
      { tag: 'markdown', element_id: 'local_file_0', content: '获取并查看' },
    ] }] }]);
    await s.create(ch, 'oc_file_rows', initial, {});
    expect(s.getCardId()).toBe('c_1');
    const row = { tag: 'markdown', element_id: 'local_file_0', content: '查看文件' };
    await Promise.all([
      s.updateCard(ch, initial), // stale demotion was already queued
      s.updateElement(ch, 'local_file_0', row),
      s.updateCard(ch, initial),
    ]);
    expect(ch.updates.every((u: any) => u.data.includes('查看文件') && !u.data.includes('获取并查看'))).toBe(true);
    expect(elementUpdates[0].data.sequence).toBeGreaterThan(ch.updates[0].sequence);
    expect(ch.updates[1].sequence).toBeGreaterThan(elementUpdates[0].data.sequence);
  });

  it('retries a rate-limited terminal update with exponential backoff until it lands', async () => {
    vi.useFakeTimers();
    // 两种限频形态都识别：HTTP 429（axios status）与业务码 99991400。
    const ch = fakeChannel([], [{ response: { status: 429 } }, { code: 99991400 }]);
    const s = new RunCardStream();
    await s.create(ch, 'oc_m4_rl', frame('hi'), {});
    const done = s.updateCard(ch, frame('terminal'));
    await vi.runAllTimersAsync();
    const delivered = await done;

    expect(ch.updates).toHaveLength(1);
    expect(ch.updates[0].data).toContain('terminal');
    expect(delivered).toBe(true);
  });

  it('keeps the single 200810-window retry for non-rate-limit errors, then gives up without throwing', async () => {
    vi.useFakeTimers();
    const ch = fakeChannel([], [{ code: 200810 }, { code: 200810 }, { code: 200810 }]);
    const s = new RunCardStream();
    await s.create(ch, 'oc_m4_810', frame('hi'), {});
    const done = s.updateCard(ch, frame('terminal'));
    await vi.runAllTimersAsync();
    const delivered = await done; // 初次 + 1 次重试均失败 → 放弃（吞错，不抛）

    expect(ch.updates).toHaveLength(0);
    expect(delivered).toBe(false);
  });

  it('serializes an accepted live repaint before terminal and freezes every late repaint', async () => {
    const ch = fakeChannel();
    const rawUpdate = ch.rawClient.cardkit.v1.card.update;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let calls = 0;
    ch.rawClient.cardkit.v1.card.update = async (p: Parameters<typeof rawUpdate>[0]) => {
      calls++;
      if (calls === 1) {
        markFirstStarted();
        await firstGate;
      }
      return rawUpdate(p);
    };

    const s = new RunCardStream();
    await s.create(ch, 'oc_terminal_freeze', frame('initial'), {});
    const repaint = s.updateLiveCard(ch, frame('live repaint'));
    await firstStarted;

    // finalizeCard freezes synchronously. The accepted repaint must finish
    // first; a callback that arrives after the freeze is ignored immediately.
    const terminal = s.finalizeCard(ch, frame('terminal'));
    await expect(s.updateLiveCard(ch, frame('late repaint'))).resolves.toBe(false);
    releaseFirst();
    await expect(repaint).resolves.toBe(true);
    await expect(terminal).resolves.toBe(true);

    expect(ch.updates).toHaveLength(2);
    expect(ch.updates[0].data).toContain('live repaint');
    expect(ch.updates[1].data).toContain('terminal');
    expect(ch.updates[1].data).not.toContain('late repaint');
    expect(ch.updates[1].sequence).toBeGreaterThan(ch.updates[0].sequence);
  });
});

// M-4: 失败帧不推进基线 —— 丢掉的整卡帧由下一帧整卡重发自愈。
describe('pump — 失败帧不推进基线（M-4）', () => {
  it('re-routes the next frame as a whole-card update after a failed push', async () => {
    const ch = fakeChannel([], [{ code: 500 }]); // 第一笔真实整卡推送失败（非限频）
    const s = new RunCardStream();
    await s.create(ch, 'oc_m4_base', frame('hello'), {});
    s.streamCoalesced(ch, frame('hello'), 'answer'); // 与建卡内容相同 → 去重视为已上卡，基线建立
    await s.drain();

    // 非前缀变化 → 整卡路由；推送失败 → 基线不前进
    s.streamCoalesced(ch, frame('rewritten'), 'answer');
    await s.drain();
    expect(ch.updates).toHaveLength(0);

    // 下一帧仍走整卡重发（基线未前进），成功后基线推进
    s.streamCoalesced(ch, frame('rewritten!'), 'answer');
    await s.drain();
    expect(ch.updates).toHaveLength(1);
    expect(ch.updates[0].data).toContain('rewritten!');

    // 此后纯增长 → 元素打字机路由
    s.streamCoalesced(ch, frame('rewritten!!'), 'answer');
    await s.drain();
    expect(ch.contents).toHaveLength(1);
    expect(ch.contents[0].content).toBe('rewritten!!');
  });
});

// M-4: per-chat 令牌桶 —— 同 chat 的多个流式卡共享推送间隔（飞书同群 ~5 QPS）。
describe('per-chat 推送共享限速（M-4）', () => {
  afterEach(() => vi.useRealTimers());

  it('two streams in one chat space their pushes at least CHAT_MIN_GAP_MS apart', async () => {
    vi.useFakeTimers();
    const ch = fakeChannel();
    const s1 = new RunCardStream();
    const s2 = new RunCardStream();
    await s1.create(ch, 'oc_m4_shared', frame('a'), {});
    await s2.create(ch, 'oc_m4_shared', frame('b'), {});
    s1.streamCoalesced(ch, frame('a grew'), 'answer');
    s2.streamCoalesced(ch, frame('b grew'), 'answer');
    const d1 = s1.drain();
    const d2 = s2.drain();
    await vi.runAllTimersAsync();
    await Promise.all([d1, d2]);

    expect(ch.updates).toHaveLength(2);
    expect(ch.updates[1].at - ch.updates[0].at).toBeGreaterThanOrEqual(250);
  });

  it('streams in different chats do not block each other', async () => {
    vi.useFakeTimers();
    const ch = fakeChannel();
    const s1 = new RunCardStream();
    const s2 = new RunCardStream();
    await s1.create(ch, 'oc_m4_iso_a', frame('a'), {});
    await s2.create(ch, 'oc_m4_iso_b', frame('b'), {});
    s1.streamCoalesced(ch, frame('a grew'), 'answer');
    s2.streamCoalesced(ch, frame('b grew'), 'answer');
    const d1 = s1.drain();
    const d2 = s2.drain();
    await vi.runAllTimersAsync();
    await Promise.all([d1, d2]);

    expect(ch.updates).toHaveLength(2);
    expect(ch.updates[1].at - ch.updates[0].at).toBe(0); // 各自的桶，互不排队
  });
});

it('streams only answer growth while preserving the native voice panel', async () => {
  const { voiceReplyElements } = await import('../src/card/voice-reply');
  const voice = { messageId: 'voice', text: '较长语音原文。'.repeat(100), transcribed: true };
  const voiceFrame = (answer: string) => card([...voiceReplyElements([voice]), mdStream(answer, 'answer')], { streaming: true });
  const ch = fakeChannel();
  const stream = new RunCardStream();
  await stream.create(ch, 'voice-stream-chat', voiceFrame('开始'), {});
  stream.streamCoalesced(ch, voiceFrame('开始'), 'answer');
  await stream.drain();
  const before = ch.updates.length;
  stream.streamCoalesced(ch, voiceFrame('开始，下面是很长的回答。'.repeat(100)), 'answer');
  await stream.drain();
  expect(ch.updates).toHaveLength(before);
  expect(ch.contents).toHaveLength(1);
  expect(ch.contents[0].content).not.toContain('语音');
});
