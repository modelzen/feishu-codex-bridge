import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import { ANSWER_EID, buildRunCard, RC } from '../src/card/run-card';
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
    const card = buildRunCard({ rs: s, cardKey: 'm1' });
    const json = JSON.stringify(card);
    expect(json).toContain('自动重试中');
    expect(buttons(card)[0]).toMatchObject({ a: RC.stop, icon: 'stop-record_filled' });
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

interface RenderedButton {
  label?: string;
  a: unknown;
  m: unknown;
  type: unknown;
  size: unknown;
  width: unknown;
  icon: unknown;
  iconColor: unknown;
  tooltip: unknown;
}

function buttons(node: unknown, acc: RenderedButton[] = []): RenderedButton[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o.tag === 'button') {
      const value = o.behaviors?.[0]?.value ?? {};
      acc.push({
        label: o.text?.content,
        a: value.a,
        m: value.m,
        type: o.type,
        size: o.size,
        width: o.width,
        icon: o.icon?.token,
        iconColor: o.icon?.color,
        tooltip: o.hover_tips?.content,
      });
    }
    for (const k of Object.keys(o)) buttons(o[k], acc);
  }
  return acc;
}

describe('buildRunCard — goal controls', () => {
  const running = (): RunState => run([{ type: 'text_delta', itemId: 'a', delta: 'working…' }]);

  it('renders a labelled blue stop control beside 结束目标 with distinct actions', () => {
    const btns = buttons(buildRunCard({ rs: running(), cardKey: 'g1', goalControls: true }));
    expect(btns).toHaveLength(2);
    const stop = btns.find((b) => b.a === RC.stop);
    const end = btns.find((b) => b.a === RC.endGoal);
    expect(stop).toMatchObject({
      label: '停止',
      m: 'g1',
      type: 'primary_filled',
      size: 'medium',
      width: 'default',
      icon: 'stop-record_filled',
      iconColor: 'white',
      tooltip: '立即停止并结束目标',
    });
    expect(end).toMatchObject({ label: '🎯 结束目标', m: 'g1' });
  });

  it('renders an icon-only blue stop control on an ordinary run card', () => {
    const btns = buttons(buildRunCard({ rs: running(), cardKey: 'm1' }));
    expect(btns).toHaveLength(1);
    expect(btns[0]).toEqual({
      label: undefined,
      a: RC.stop,
      m: 'm1',
      type: 'primary_filled',
      size: 'medium',
      width: 'default',
      icon: 'stop-record_filled',
      iconColor: 'white',
      tooltip: '停止生成',
    });
  });

  it('renders no controls without a cardKey (nothing to route to)', () => {
    expect(buttons(buildRunCard({ rs: running(), goalControls: true }))).toHaveLength(0);
  });

  it('after 结束目标, keeps the icon-only stop control and shows the notice', () => {
    const card = buildRunCard({ rs: running(), cardKey: 'g1', goalControls: true, goalEnding: true });
    const btns = buttons(card);
    expect(btns).toHaveLength(1);
    expect(btns[0]).toMatchObject({
      label: undefined,
      a: RC.stop,
      type: 'primary_filled',
      icon: 'stop-record_filled',
      tooltip: '停止生成',
    });
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
    expect(card.config.streaming_mode).toBeUndefined();
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
    expect(buttons(els).some((button) => button.a === RC.stop)).toBe(false);
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
    // Every operation retains an independently expandable detail inside its group.
    expect(json).not.toContain('个工具调用');
    expect(panelCount(card)).toBe(7); // process + consecutive-tool group + 5 details
    for (let i = 0; i < 5; i++) expect(json).toContain(`FULLCMD_TAIL_${i}`);
  });

  it('keeps a large process inside the native panel without a separate viewer action', () => {
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
    expect(json).not.toContain('run.process.');
    expect(json).not.toContain('查看全部操作');
    expect(json).toContain('BATCHED_TAIL');
    for (let i = 1; i < 130; i++) expect(json).toContain(`cmd ${i}\\n`);
    expect(json).not.toContain('项过程已省略（卡片容量限制）');
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28000);
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

// issue #14：`![](src)` 在飞书卡片里是「图片节点」，src 不是 image_key 就渲染成坏图，
// 而且流式卡片会看着卡在引用处。所以运行卡：已上传的换成 img 元素、未上传的给占位、
// 引用还没写完的按住不发；终态未解析的降级成「文字 + 反引号路径」，绝不发裸 `![]()`。
describe('buildRunCard — 图片（issue #14）', () => {
  const withImage = (): RunState =>
    run([{ type: 'text_delta', itemId: 'a', delta: '预览：\n\n![拼图](video_frames/contact_sheet.jpg)' }]);
  const withImageDone = (): RunState =>
    run([
      { type: 'text_delta', itemId: 'a', delta: '预览：\n\n![拼图](video_frames/contact_sheet.jpg)' },
      { type: 'done', turnId: 't1' },
    ]);
  const KEYS = new Map([['video_frames/contact_sheet.jpg', 'img_v2_key']]);

  it('running：已上传的引用渲染成小标签（标题 = alt），展开体是真图', () => {
    const els = bodyEls(buildRunCard({ rs: withImage(), cardKey: 'm1', images: KEYS }));
    const pill = els.find((e) => e.tag === 'collapsible_panel') as Record<string, any>;
    expect(pill.header.title.content).toBe("<font color='blue'>拼图</font>"); // 链接样式：蓝字
    expect(pill.header.width).toBe('auto_when_fold');
    expect(pill.expanded).toBe(false);
    expect(pill.elements[0]).toMatchObject({ tag: 'img', img_key: 'img_v2_key', mode: 'fit_horizontal', preview: true });
    expect(JSON.stringify(els)).not.toContain('![');
  });

  it('running：还在上传的引用只给占位，不发裸 markdown', () => {
    const json = JSON.stringify(bodyEls(buildRunCard({ rs: withImage(), cardKey: 'm1' })));
    expect(json).not.toContain('![');
    expect(json).toContain('图片处理中');
  });

  it('running：图后的文字仍是打字机元素（ANSWER_EID 落在最后一段 markdown）', () => {
    const rs = run([
      { type: 'text_delta', itemId: 'a', delta: '前 ![拼图](shot.jpg) 后' },
    ]);
    const els = bodyEls(buildRunCard({ rs, cardKey: 'm1', images: new Map([['shot.jpg', 'k']]) }));
    // answer run first (footer + ⏹ 控件跟在后面)
    expect(els.slice(0, 3).map((e) => e.tag)).toEqual(['markdown', 'collapsible_panel', 'markdown']);
    expect(els[0]!.element_id).toBeUndefined();
    expect(els[2]!.element_id).toBe(ANSWER_EID);
  });

  it('terminal：已上传的引用同样是小标签（展开体里是真图）', () => {
    const els = bodyEls(buildRunCard({ rs: withImageDone(), images: KEYS }));
    expect(JSON.stringify(els)).toContain('"img_key":"img_v2_key"');
    expect(els.some((e) => e.tag === 'collapsible_panel')).toBe(true);
  });

  it('terminal：未解析的引用降级成文字 + 反引号路径（不出现裸 ![]()）', () => {
    const json = JSON.stringify(bodyEls(buildRunCard({ rs: withImageDone() })));
    expect(json).not.toContain('![');
    expect(json).toContain('未能显示：`video_frames/contact_sheet.jpg`');
  });
});

// 表格类回答走 report 渲染器；表格里放不下的图统一挪到回答末尾（渲染层改写，不靠提示词）
describe('buildRunCard — 表格与图片（渲染层改写）', () => {
  const TABLE_ANSWER = [
    '项目里共有 **32 个图片文件**。',
    '',
    '## 1. 根目录（1 个）',
    '',
    '| 文件 | 尺寸 | 说明 |',
    '|---|---|---|',
    '| [contact_sheet.jpg](video_frames/contact_sheet.jpg) | 1480×3943 | 拼图总览 |',
  ].join('\n');
  const KEYS = new Map([['video_frames/contact_sheet.jpg', 'img_v2_sheet']]);

  const doneWith = (text: string): RunState => run([{ type: 'text', itemId: 'a', text }, { type: 'done', turnId: 't1' }]);

  it('有 GFM 表格 → 渲染成原生 table，而不是一坨竖线', () => {
    const els = bodyEls(buildRunCard({ rs: doneWith(TABLE_ANSWER), images: KEYS }));
    expect(els.some((e) => e.tag === 'table')).toBe(true);
    expect(JSON.stringify(els)).not.toContain('|------|');
  });

  it('表格里放不下的图 → 单元格只剩文字，图在小标签里出现在回答末尾', () => {
    const els = bodyEls(buildRunCard({ rs: doneWith(TABLE_ANSWER), images: KEYS }));
    const tableEl = els.find((e) => e.tag === 'table') as Record<string, any>;
    expect(tableEl.rows[0].c0).toBe('contact_sheet.jpg');
    const pill = els.find((e) => e.tag === 'collapsible_panel') as Record<string, any>;
    expect(pill.header.title.content).toContain('contact_sheet.jpg'); // 链接样式：蓝字标题
    expect(pill.elements[0]).toMatchObject({ tag: 'img', img_key: 'img_v2_sheet' });
    expect(els.indexOf(pill)).toBeGreaterThan(els.indexOf(tableEl)); // 在表格之后
  });

  it('没有表格的回答仍走普通 markdown 路径（图留在原位）', () => {
    const els = bodyEls(buildRunCard({ rs: doneWith('看这个：\n\n![拼图](video_frames/contact_sheet.jpg)'), images: KEYS }));
    expect(els.some((e) => e.tag === 'table')).toBe(false);
    expect(els.some((e) => e.tag === 'collapsible_panel')).toBe(true);
  });
});
