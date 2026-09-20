import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import { buildRunCard, RC } from '../src/card/run-card';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reasoningContent,
  reduce,
  type Block,
  type RunState,
} from '../src/card/run-state';

function run(events: AgentEvent[]): RunState {
  let s = initialState;
  for (const ev of events) s = reduce(s, ev);
  return s;
}

/** Top-level body elements of a built run card. */
function bodyEls(card: unknown): Array<Record<string, unknown>> {
  return ((card as { body?: { elements?: Array<Record<string, unknown>> } }).body?.elements ?? []);
}

const texts = (s: RunState): string[] =>
  s.blocks.filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text').map((b) => b.content);
const tools = (s: RunState): Extract<Block, { kind: 'tool' }>[] =>
  s.blocks.filter((b): b is Extract<Block, { kind: 'tool' }> => b.kind === 'tool');

describe('reduce', () => {
  it('starts running with no blocks', () => {
    const s = run([]);
    expect(s.terminal).toBe('running');
    expect(s.blocks).toHaveLength(0);
  });

  it('accumulates text deltas per item, preserving first-seen order', () => {
    const s = run([
      { type: 'text_delta', itemId: 'a', delta: 'hello' },
      { type: 'text_delta', itemId: 'b', delta: 'second' },
      { type: 'text_delta', itemId: 'a', delta: ' world' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    expect(texts(s)).toEqual(['hello world', 'second']);
    expect(s.terminal).toBe('done');
  });

  it('reconciles a streamed item with its completed text', () => {
    const s = run([
      { type: 'text_delta', itemId: 'a', delta: 'partial' },
      { type: 'text', itemId: 'a', text: 'final text' },
    ]);
    expect(texts(s)).toEqual(['final text']);
  });

  it('derives tool status from exit code', () => {
    const s = run([
      { type: 'tool_use', itemId: 'ok', title: 'npm test' },
      { type: 'tool_use', itemId: 'fail', title: 'npm run build' },
      { type: 'tool_result', itemId: 'ok', exitCode: 0 },
      { type: 'tool_result', itemId: 'fail', exitCode: 2 },
    ]);
    const t = tools(s);
    expect(t.map((b) => b.tool.status)).toEqual(['done', 'error']);
  });

  it('treats a missing exit code as success', () => {
    const s = run([
      { type: 'tool_use', itemId: 't1', title: 'custom tool' },
      { type: 'tool_result', itemId: 't1' },
    ]);
    expect(tools(s)[0]!.tool.status).toBe('done');
  });

  it('accumulates reasoning deltas and reconciles the final text', () => {
    const streaming = run([
      { type: 'thinking_delta', itemId: 'r', delta: 'think' },
      { type: 'thinking_delta', itemId: 'r', delta: 'ing' },
    ]);
    expect(reasoningContent(streaming)).toBe('thinking');
    expect(streaming.reasoningActive).toBe(true);

    const final = run([
      { type: 'thinking_delta', itemId: 'r', delta: 'partial' },
      { type: 'thinking', itemId: 'r', text: 'full reasoning' },
    ]);
    expect(reasoningContent(final)).toBe('full reasoning');
  });

  it('captures error terminal state', () => {
    const s = run([
      { type: 'text', itemId: 'm', text: 'hello' },
      { type: 'error', message: 'boom', willRetry: false },
    ]);
    expect(s.terminal).toBe('error');
    expect(s.errorMsg).toBe('boom');
  });

  it('does NOT terminalize on error(willRetry=true) — retrying footer, later deltas keep streaming', () => {
    const s = run([
      { type: 'text_delta', itemId: 'a', delta: 'partial' },
      { type: 'error', message: 'stream disconnected', willRetry: true },
    ]);
    expect(s.terminal).toBe('running');
    expect(s.footer).toBe('retrying');
    // the running layout survives: ⏹ stays, the retrying notice shows
    const json = JSON.stringify(buildRunCard({ rs: s, cardKey: 'm1' }));
    expect(json).toContain('自动重试中');
    expect(json).toContain('⏹ 终止');
    expect(json).not.toContain('agent 失败');
    // the retry succeeded → deltas overwrite the retrying footer
    const resumed = reduce(s, { type: 'text_delta', itemId: 'a', delta: ' again' });
    expect(resumed.terminal).toBe('running');
    expect(resumed.footer).toBe('streaming');
  });
});

describe('buildRunCard — fatal error advice', () => {
  const fatal = (message: string): RunState => run([{ type: 'error', message, willRetry: false }]);

  it('suggests re-login on auth-shaped errors', () => {
    const json = JSON.stringify(buildRunCard({ rs: fatal('401 Unauthorized: token expired') }));
    expect(json).toContain('agent 失败');
    expect(json).toContain('codex login');
  });

  it('points at /usage on quota-shaped errors', () => {
    expect(JSON.stringify(buildRunCard({ rs: fatal('usage limit reached') }))).toContain('/usage');
  });

  it('suggests a resend on network-shaped errors', () => {
    expect(JSON.stringify(buildRunCard({ rs: fatal('fetch failed: ETIMEDOUT') }))).toContain('重发本条消息');
  });

  it('keeps the bare message when no pattern matches', () => {
    const json = JSON.stringify(buildRunCard({ rs: fatal('boom') }));
    expect(json).toContain('agent 失败：boom');
    expect(json).not.toContain('codex login');
    expect(json).not.toContain('/usage');
  });
});

describe('buildRunCard', () => {
  it('renders no header and streams while running', () => {
    const rs = run([{ type: 'text_delta', itemId: 'a', delta: 'hi' }]);
    const card = buildRunCard({ rs, cardKey: 'm1' }) as { header?: unknown; config: { streaming_mode?: boolean } };
    expect(card.header).toBeUndefined();
    expect(card.config.streaming_mode).toBe(true);
  });

  it('drops tool blocks when showTools is false', () => {
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: 'npm test' },
      { type: 'text', itemId: 'm1', text: 'text only' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    const json = JSON.stringify(buildRunCard({ rs, showTools: false }));
    expect(json).not.toContain('npm test');
    expect(json).toContain('text only');
  });
});

/** Collect every button's {label, action, msgId} from a built card. */
function buttons(node: unknown, acc: { label: string; a: unknown; m: unknown }[] = []): { label: string; a: unknown; m: unknown }[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o.tag === 'button') {
      const value = o.behaviors?.[0]?.value ?? {};
      acc.push({ label: o.text?.content, a: value.a, m: value.m });
    }
    for (const k of Object.keys(o)) buttons(o[k], acc);
  }
  return acc;
}

describe('buildRunCard — goal controls', () => {
  const running = (): RunState => run([{ type: 'text_delta', itemId: 'a', delta: 'working…' }]);

  it('renders BOTH 终止 and 结束目标 on a goal card, wired to the right actions', () => {
    const btns = buttons(buildRunCard({ rs: running(), cardKey: 'g1', goalControls: true }));
    expect(btns).toHaveLength(2);
    const stop = btns.find((b) => b.a === RC.stop);
    const end = btns.find((b) => b.a === RC.endGoal);
    expect(stop).toMatchObject({ label: '⏹ 终止', m: 'g1' });
    expect(end).toMatchObject({ label: '🎯 结束目标', m: 'g1' });
  });

  it('renders only ⏹ 终止 on a normal (non-goal) run card', () => {
    const btns = buttons(buildRunCard({ rs: running(), cardKey: 'm1' }));
    expect(btns).toHaveLength(1);
    expect(btns[0]).toMatchObject({ label: '⏹ 终止', a: RC.stop });
  });

  it('renders no controls without a cardKey (nothing to route to)', () => {
    expect(buttons(buildRunCard({ rs: running(), goalControls: true }))).toHaveLength(0);
  });

  it('after 结束目标 (goalEnding): drops 结束目标, keeps ⏹ 终止, shows the notice', () => {
    const card = buildRunCard({ rs: running(), cardKey: 'g1', goalControls: true, goalEnding: true });
    const btns = buttons(card);
    expect(btns).toHaveLength(1);
    expect(btns[0]).toMatchObject({ label: '⏹ 终止', a: RC.stop });
    expect(JSON.stringify(card)).toContain('目标已解除');
  });
});

describe('buildRunCard — terminal collapse', () => {
  const fullRun = (): RunState =>
    run([
      { type: 'thinking', itemId: 'r', text: 'pondering' },
      { type: 'text', itemId: 'p1', text: 'preamble msg' },
      { type: 'tool_use', itemId: 't1', title: 'echo hi' },
      { type: 'tool_result', itemId: 't1', exitCode: 0, output: 'out' },
      { type: 'text', itemId: 'a', text: 'FINAL ANSWER' },
      { type: 'done', turnId: 'turn-1' },
    ]);

  it('folds process into one collapsed panel and surfaces only the final answer', () => {
    const card = buildRunCard({ rs: fullRun() });
    const els = bodyEls(card);
    expect(els).toHaveLength(2);

    const [panel, answer] = els;
    // first element: a single collapsed process panel holding reasoning + tools + preamble
    expect(panel!.tag).toBe('collapsible_panel');
    expect(panel!.expanded).toBe(false);
    const panelJson = JSON.stringify(panel);
    expect(panelJson).toContain('pondering');
    expect(panelJson).toContain('preamble msg');
    expect(panelJson).toContain('echo hi');
    // the final answer must NOT be inside the folded panel
    expect(panelJson).not.toContain('FINAL ANSWER');

    // second element: the final answer, plain markdown, outside the panel
    expect(answer!.tag).toBe('markdown');
    expect(answer!.content).toBe('FINAL ANSWER');
  });

  it('turns off streaming on a terminal card', () => {
    const card = buildRunCard({ rs: fullRun() }) as { config: { streaming_mode?: boolean } };
    expect(card.config.streaming_mode).toBe(false);
  });

  it('keeps a partial answer above the note when interrupted', () => {
    let rs = run([
      { type: 'tool_use', itemId: 't1', title: 'long task' },
      { type: 'tool_result', itemId: 't1', exitCode: 0 },
      { type: 'text_delta', itemId: 'a', delta: 'partial ans' },
    ]);
    rs = markInterrupted(rs);
    const els = bodyEls(buildRunCard({ rs, cardKey: 'm1' }));
    // process panel, partial answer, interrupted note — and no ⏹ button
    expect(els.some((e) => e.tag === 'collapsible_panel')).toBe(true);
    expect(els.some((e) => e.tag === 'markdown' && e.content === 'partial ans')).toBe(true);
    expect(JSON.stringify(els)).toContain('已被中断');
    expect(JSON.stringify(els)).not.toContain('终止');
  });

  it('folds process and shows the error note when the agent fails', () => {
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: 'do thing' },
      { type: 'tool_result', itemId: 't1', exitCode: 0 },
      { type: 'error', message: 'boom', willRetry: false },
    ]);
    const json = JSON.stringify(bodyEls(buildRunCard({ rs })));
    expect(json).toContain('collapsible_panel');
    expect(json).toContain('agent 失败：boom');
  });

  it('shows the idle-timeout note in minutes for round values', () => {
    let rs = run([{ type: 'tool_use', itemId: 't1', title: 'hang' }]);
    rs = markIdleTimeout(rs, 420);
    expect(JSON.stringify(bodyEls(buildRunCard({ rs })))).toContain('7 分钟无响应');
  });

  it('shows the idle-timeout note in seconds for non-round values', () => {
    let rs = run([{ type: 'tool_use', itemId: 't1', title: 'hang' }]);
    rs = markIdleTimeout(rs, 90);
    expect(JSON.stringify(bodyEls(buildRunCard({ rs })))).toContain('90 秒无响应');
  });

  it('reports no content when a done run produced no text', () => {
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: 'only tool' },
      { type: 'tool_result', itemId: 't1', exitCode: 0 },
      { type: 'done', turnId: 'turn-1' },
    ]);
    const els = bodyEls(buildRunCard({ rs }));
    expect(els.some((e) => e.tag === 'collapsible_panel')).toBe(true);
    expect(JSON.stringify(els)).toContain('未返回内容');
  });
});

describe('buildRunCard — full command visibility', () => {
  const panelCount = (card: unknown): number =>
    (JSON.stringify(card).match(/"tag":"collapsible_panel"/g) ?? []).length;

  it('surfaces the FULL shell command in the terminal process panel (not header-clipped)', () => {
    const cmd = `echo start && ${'x'.repeat(130)} && echo DISTINCTIVE_TAIL`;
    const rs = run([
      { type: 'tool_use', itemId: 't1', title: cmd, detail: '/repo', kind: 'command' },
      { type: 'tool_result', itemId: 't1', exitCode: 0, output: 'ran' },
      { type: 'text', itemId: 'a', text: 'FINAL' },
      { type: 'done', turnId: 'x' },
    ]);
    const json = JSON.stringify(buildRunCard({ rs }));
    // the tail lives past the 120-char header cap → its presence proves the body carries the whole command
    expect(json).toContain('DISTINCTIVE_TAIL');
    expect(json).toContain('```bash');
  });

  it('renders a moderate run as one panel PER tool, each with its full command', () => {
    const events: AgentEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push({ type: 'tool_use', itemId: `t${i}`, title: `git show HEAD~${i} --stat FULLCMD_TAIL_${i}`, kind: 'command' });
      events.push({ type: 'tool_result', itemId: `t${i}`, exitCode: 0, output: `out${i}` });
    }
    events.push({ type: 'text', itemId: 'a', text: 'FINAL' });
    events.push({ type: 'done', turnId: 'x' });
    const card = buildRunCard({ rs: run(events) });
    const json = JSON.stringify(card);
    // not degraded to a batched summary (the summary title says「N 个工具调用」;
    // the process-fold header only says「N 个工具」) — and 1 fold + 5 tool panels.
    expect(json).not.toContain('个工具调用');
    expect(panelCount(card)).toBe(6);
    for (let i = 0; i < 5; i++) expect(json).toContain(`FULLCMD_TAIL_${i}`);
  });

  it('degrades a huge run to a batched summary that STILL lists full commands (and never explodes the card)', () => {
    const events: AgentEvent[] = [];
    const cmd0 = `run ${'a'.repeat(90)} BATCHED_TAIL`;
    for (let i = 0; i < 130; i++) {
      events.push({ type: 'tool_use', itemId: `t${i}`, title: i === 0 ? cmd0 : `cmd ${i}`, kind: 'command' });
      events.push({ type: 'tool_result', itemId: `t${i}`, exitCode: 0, output: 'ok' });
    }
    events.push({ type: 'text', itemId: 'a', text: 'FINAL' });
    events.push({ type: 'done', turnId: 'x' });
    const card = buildRunCard({ rs: run(events) });
    const json = JSON.stringify(card);
    expect(json).toContain('130 个工具调用'); // degraded to the summary (component budget)
    expect(json).toContain('BATCHED_TAIL'); // ...but a batched command is still shown in full
    // component-budget guard held: the card is a handful of panels, not 130
    expect(panelCount(card)).toBeLessThan(10);
  });
});

describe('context usage gauge', () => {
  it('stores the latest usage from context_usage events', () => {
    const rs = run([
      { type: 'context_usage', usedTokens: 100, contextWindow: 8192 },
      { type: 'context_usage', usedTokens: 4096, contextWindow: 8192 },
    ]);
    expect(rs.usage).toEqual({ used: 4096, window: 8192 });
  });

  it('keeps the run card clean below the threshold', () => {
    const rs = run([{ type: 'context_usage', usedTokens: 100, contextWindow: 8192 }]);
    expect(JSON.stringify(buildRunCard({ rs }))).not.toContain('上下文');
  });

  it('surfaces the gauge + /compact nudge above the threshold', () => {
    const rs = run([{ type: 'context_usage', usedTokens: 8000, contextWindow: 8192 }]);
    const json = JSON.stringify(buildRunCard({ rs }));
    expect(json).toContain('上下文');
    expect(json).toContain('/compact');
  });

  it('does not surface the gauge when the window is unknown', () => {
    const rs = run([{ type: 'context_usage', usedTokens: 999999, contextWindow: null }]);
    expect(JSON.stringify(buildRunCard({ rs }))).not.toContain('上下文');
  });

  it('renders the gauge as the closing footnote, below the answer', () => {
    const rs = run([
      { type: 'context_usage', usedTokens: 8000, contextWindow: 8192 },
      { type: 'text', itemId: 'a', text: 'FINAL ANSWER' },
      { type: 'done', turnId: 'turn-1' },
    ]);
    const els = bodyEls(buildRunCard({ rs }));
    const last = els[els.length - 1]!;
    expect(JSON.stringify(last)).toContain('上下文');
    // the answer must come before the gauge footnote
    const answerIdx = els.findIndex((e) => JSON.stringify(e).includes('FINAL ANSWER'));
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    expect(answerIdx).toBeLessThan(els.length - 1);
  });
});

// 「模型显示」三档：off 都不显示；running 仅运行卡；always 终态卡也保留。
// 脚注为「模型 · 推理强度」，推理强度按档位着色（low黄/medium绿/high浅紫violet/xhigh深紫purple）。
describe('模型 · 推理强度 footnote（模型显示三档）', () => {
  const running = (): RunState => run([{ type: 'text_delta', itemId: 'a', delta: 'hi' }]);
  const done = (): RunState => run([{ type: 'text', itemId: 'a', text: 'ok' }, { type: 'done', turnId: 't1' }]);

  it('off 档（不传 model）：running / terminal 都无脚注', () => {
    expect(JSON.stringify(buildRunCard({ rs: running(), cardKey: 'm1' }))).not.toContain('gpt-5.5');
    expect(JSON.stringify(buildRunCard({ rs: done() }))).not.toContain('gpt-5.5');
  });

  it('running 卡显示「模型 · 推理强度」，推理强度按档位着色（high→浅紫）', () => {
    const json = JSON.stringify(
      buildRunCard({ rs: running(), cardKey: 'm1', model: 'gpt-5.5', effort: 'high', modelOnTerminal: false }),
    );
    expect(json).toContain('gpt-5.5');
    expect(json).toContain('高'); // high → 中文档位
    expect(json).toContain('violet'); // 浅紫
  });

  it('仅输出时档（modelOnTerminal=false）：终态卡丢掉脚注', () => {
    const json = JSON.stringify(buildRunCard({ rs: done(), model: 'gpt-5.5', effort: 'high', modelOnTerminal: false }));
    expect(json).not.toContain('gpt-5.5');
  });

  it('始终档（modelOnTerminal=true）：终态卡也保留脚注（xhigh→深紫）', () => {
    const json = JSON.stringify(buildRunCard({ rs: done(), model: 'gpt-5.5', effort: 'xhigh', modelOnTerminal: true }));
    expect(json).toContain('gpt-5.5');
    expect(json).toContain('极高');
    expect(json).toContain('purple'); // 深紫
  });

  it('GPT-5.6 ultra 档显示中文强度，不泄漏 undefined', () => {
    const json = JSON.stringify(
      buildRunCard({ rs: running(), cardKey: 'm1', model: 'gpt-5.6-sol', effort: 'ultra', modelOnTerminal: false }),
    );
    expect(json).toContain('超强');
    expect(json).toContain('purple');
    expect(json).not.toContain('undefined');
  });
});

describe('tool default collapse preference', () => {
  const live = () => run([1, 2, 3].map((n) => ({ type: 'tool_use' as const, itemId: `t${n}`, title: `command-${n}` })));
  it('keeps the latest live call collapsed while retaining its details', () => {
    const card = buildRunCard({ rs: live(), collapseTools: true });
    const panels = bodyEls(card).filter((el) => el.tag === 'collapsible_panel');
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every((el) => el.expanded === false)).toBe(true);
    expect(JSON.stringify(card)).toContain('command-3');
  });
  it('preserves automatic expansion when the preference is absent or off', () => {
    for (const collapseTools of [undefined, false]) {
      const panels = bodyEls(buildRunCard({ rs: live(), collapseTools })).filter((el) => el.tag === 'collapsible_panel');
      expect(panels.some((el) => el.expanded === true)).toBe(true);
    }
  });
  it('continues to hide tools when display is disabled', () => {
    expect(JSON.stringify(buildRunCard({ rs: live(), collapseTools: true, showTools: false }))).not.toContain('command-3');
  });
});

describe('terminal progress images', () => {
  it('keeps uploaded progress images inside the process panel beside final-answer images', () => {
    const s = run([
      { type: 'text_delta', itemId: 'progress', delta: 'Preview ![draft](draft.png)' },
      { type: 'text_delta', itemId: 'answer', delta: 'Final ![result](result.png)' },
      { type: 'done', turnId: 'turn' },
    ]);
    const card = buildRunCard({ rs: s, cardKey: 'test', images: new Map([
      ['draft.png', 'img_draft'], ['result.png', 'img_result'],
    ]) });
    const els = bodyEls(card);
    const process = els.find(el => el.tag === 'collapsible_panel');
    expect(JSON.stringify(process)).toContain('img_draft');
    expect(JSON.stringify(process)).not.toContain('![draft]');
    expect(els.some(el => el.tag === 'img' && el.img_key === 'img_result')).toBe(true);
  });
});
