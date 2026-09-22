import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRunCard } from '../src/card/run-card';
import { RunRender } from '../src/card/run-render';
import { buildProcessBody } from '../src/card/run-process';
import { initialState, reduce, type Block } from '../src/card/run-state';

afterEach(() => vi.useRealTimers());

describe('ordered run process', () => {
  it('keeps reasoning snapshots in their original position and groups only adjacent tools', () => {
    let state = reduce(initialState, { type: 'thinking_delta', itemId: 'r', delta: 'draft' });
    state = reduce(state, { type: 'tool_use', itemId: 't1', title: 'pwd', kind: 'command' });
    state = reduce(state, { type: 'text', itemId: 'p', text: 'PROGRESS' });
    state = reduce(state, { type: 'tool_use', itemId: 't2', title: 'npm test', kind: 'command' });
    state = reduce(state, { type: 'thinking', itemId: 'r', text: 'REASONING' });
    state = reduce(state, { type: 'text', itemId: 'a', text: 'ANSWER' });
    expect(state.blocks.map(b => b.kind)).toEqual(['reasoning', 'tool', 'text', 'tool', 'text']);
    const card = buildRunCard({ rs: state });
    const body = card.body as { elements: Record<string, unknown>[] };
    const process = JSON.stringify(body.elements[0]);
    expect(process.indexOf('REASONING')).toBeLessThan(process.indexOf('pwd'));
    expect(process.indexOf('pwd')).toBeLessThan(process.indexOf('PROGRESS'));
    expect(process.indexOf('PROGRESS')).toBeLessThan(process.indexOf('npm test'));
    expect(process).not.toContain('ANSWER');
    expect(process).not.toContain('🧠');
    expect(body.elements[1]).toMatchObject({ tag: 'markdown', element_id: 'answer', content: 'ANSWER', text_size: 'normal' });
  });

  it('uses a live elapsed clock and freezes the duration at completion', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const render = new RunRender();
    vi.setSystemTime(4100);
    expect(JSON.stringify(buildRunCard({ rs: render.snapshot() }))).toContain('已处理 3秒');
    render.apply({ type: 'done', turnId: 't' });
    vi.setSystemTime(91000);
    expect(JSON.stringify(buildRunCard({ rs: render.snapshot() }))).toContain('用时 3秒');
  });

  it('bounds UTF-8 bytes and nested components while preserving a chronological prefix', () => {
    const blocks: Block[] = Array.from({ length: 200 }, (_, i) => ({ kind: 'text', id: String(i), content: `STEP_${i}：${'中'.repeat(4000)}`, streaming: false }));
    const body = buildProcessBody(blocks);
    const json = JSON.stringify(body);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(22000);
    expect(json).toContain('STEP_0');
    expect(json).not.toContain('STEP_199');
    expect(json).toContain('过程已省略');
  });

  it('keeps command/output fences closed even when the output contains fences', () => {
    const body = buildProcessBody([{ kind: 'tool', tool: { id: 'x', kind: 'command', title: 'echo hi', status: 'error', output: '```\ninner\n```', exitCode: 1 } }]);
    const panel = body[0] as { elements: { content: string }[] };
    expect(panel.elements[0]!.content).toContain('````bash\n$ echo hi');
    expect(panel.elements[0]!.content).toContain('退出码：1\n````');
  });
});
