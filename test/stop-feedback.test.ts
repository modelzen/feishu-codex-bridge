import { describe, expect, it } from 'vitest';
import { ANSWER_EID, buildQueuedCard, buildRunCard, buildRunCardPlain, CONTROLS_EID } from '../src/card/run-card';
import { initialState, type RunState } from '../src/card/run-state';
import { cardIdFromMessageContent } from '../src/bot/handle-message';

/** All nodes carrying the given element_id (depth-first). */
function byEid(node: unknown, eid: string, acc: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(node)) node.forEach((n) => byEid(n, eid, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o.element_id === eid) acc.push(o);
    for (const k of Object.keys(o)) byEid(o[k], eid, acc);
  }
  return acc;
}

function buttons(node: unknown, acc: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o.tag === 'button') acc.push(o);
    for (const k of Object.keys(o)) buttons(o[k], acc);
  }
  return acc;
}

// M-4 ⏹ 静默失败反馈：orphan 卡点击自愈靠「按 element_id 删掉控件行」——
// 控件行必须带稳定的 CONTROLS_EID，且只出现在有按钮的版式上。
describe('run card controls row — CONTROLS_EID（M-4 orphan 自愈锚点）', () => {
  it('the running run card carries exactly one controls row with CONTROLS_EID', () => {
    const rows = byEid(buildRunCard({ rs: initialState, cardKey: 'om_1' }), CONTROLS_EID);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('⏹ 终止');
  });

  it('manual mode adds one-shot remind; requested state becomes a note; automatic modes expose neither', () => {
    const available = buildRunCard({ rs: initialState, cardKey: 'om_1', completionReminder: 'available' });
    expect(buttons(available).map((b) => b.behaviors[0].value.a)).toEqual(['run.stop', 'run.remind']);

    const requested = buildRunCard({ rs: initialState, cardKey: 'om_1', completionReminder: 'requested' });
    expect(buttons(requested).map((b) => b.behaviors[0].value.a)).toEqual(['run.stop']);
    expect(JSON.stringify(requested)).toContain('本轮结束后会提醒发起人');

    const automatic = buildRunCard({ rs: initialState, cardKey: 'om_1' });
    expect(buttons(automatic).map((b) => b.behaviors[0].value.a)).toEqual(['run.stop']);
  });

  it('goal cards never expose the ordinary completion-reminder button', () => {
    const goal = buildRunCard({
      rs: initialState,
      cardKey: 'om_1',
      goalControls: true,
      completionReminder: 'available',
    });
    expect(JSON.stringify(goal)).not.toContain('完成后提醒我');
  });

  it('goal cards (both layouts) anchor their controls with CONTROLS_EID', () => {
    const both = byEid(buildRunCard({ rs: initialState, cardKey: 'om_1', goalControls: true }), CONTROLS_EID);
    expect(both).toHaveLength(1);
    expect(JSON.stringify(both[0])).toContain('🎯 结束目标');
    const ending = byEid(
      buildRunCard({ rs: initialState, cardKey: 'om_1', goalControls: true, goalEnding: true }),
      CONTROLS_EID,
    );
    expect(ending).toHaveLength(1);
  });

  it('the queued placeholder card anchors its ⏹ 取消 row with CONTROLS_EID', () => {
    const rows = byEid(buildQueuedCard({ position: 2, cardKey: 'om_1' }), CONTROLS_EID);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).toContain('⏹ 取消');
  });

  it('button-less layouts have no controls row to delete', () => {
    expect(byEid(buildRunCardPlain({ rs: initialState, cardKey: 'om_1' }), CONTROLS_EID)).toHaveLength(0);
    expect(byEid(buildQueuedCard({ cancelled: true }), CONTROLS_EID)).toHaveLength(0);
  });
});

/** Top-level body elements of a built card. */
function bodyEls(card: unknown): Array<Record<string, any>> {
  return ((card as { body?: { elements?: Array<Record<string, any>> } }).body?.elements ?? []);
}

// 控制行钉在卡片底部：贴着最新输出、随用户视线下移（取舍：长流式时按钮可能被推到
// 折叠线下，需滚到底才点得到 —— 见 run-card 顶部 layout 注释里的权衡）。
describe('run card controls row — 底部固定（贴最新输出）', () => {
  const streamed: RunState = {
    ...initialState,
    blocks: [{ kind: 'text', id: 'a', content: '长输出 '.repeat(50), streaming: true }],
    footer: 'streaming',
  };

  it('running 卡的控制行是 body 最后一个元素，答案元素在其前', () => {
    const els = bodyEls(buildRunCard({ rs: streamed, cardKey: 'om_1' }));
    expect(els[els.length - 1]?.element_id).toBe(CONTROLS_EID);
    // 流式答案元素（ANSWER_EID）仍存在且在控制行之前 — 打字机元素 id 稳定不受布局影响
    const answerIdx = els.findIndex((e) => e.element_id === ANSWER_EID);
    const controlsIdx = els.findIndex((e) => e.element_id === CONTROLS_EID);
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    expect(answerIdx).toBeLessThan(controlsIdx);
  });

  it('goal 双按钮 / goalEnding 版式同样底置（goalEnding 的提示行紧在控制行之前）', () => {
    const both = bodyEls(buildRunCard({ rs: streamed, cardKey: 'om_1', goalControls: true }));
    expect(both[both.length - 1]?.element_id).toBe(CONTROLS_EID);
    const ending = bodyEls(buildRunCard({ rs: streamed, cardKey: 'om_1', goalControls: true, goalEnding: true }));
    expect(ending[ending.length - 1]?.element_id).toBe(CONTROLS_EID);
    expect(JSON.stringify(ending[ending.length - 2])).toContain('目标已解除');
  });

  it('terminal 版式不受影响：无控制行，过程折叠 + 答案布局不变', () => {
    const done: RunState = { ...streamed, terminal: 'done', footer: null };
    const els = bodyEls(buildRunCard({ rs: done, cardKey: 'om_1' }));
    expect(els.some((e) => e.element_id === CONTROLS_EID)).toBe(false);
  });
});

// 重启后 orphan 卡自愈的前半程：从载体消息 body.content 反查 CardKit 实体 card_id。
describe('cardIdFromMessageContent', () => {
  it('extracts the card_id from a CardKit-entity carrier message', () => {
    expect(cardIdFromMessageContent('{"type":"card","data":{"card_id":"7bd1…cardid"}}')).toBe('7bd1…cardid');
  });

  it('returns undefined for non-card content, malformed JSON, and missing card_id', () => {
    expect(cardIdFromMessageContent('{"text":"hi"}')).toBeUndefined();
    expect(cardIdFromMessageContent('not json')).toBeUndefined();
    expect(cardIdFromMessageContent('{"type":"card","data":{}}')).toBeUndefined();
  });
});
