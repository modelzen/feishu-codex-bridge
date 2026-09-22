import { describe, expect, it, vi } from 'vitest';
import { buildProcessBody } from '../src/card/run-process';
import { buildRunCard } from '../src/card/run-card';
import { initialState, reduce, type Block, type FooterStatus } from '../src/card/run-state';
import type { CardElement } from '../src/card/cards';

function children(elements: readonly CardElement[]): CardElement[] {
  return elements.flatMap(element => [
    element,
    ...(Array.isArray(element.elements) ? children(element.elements) : []),
    ...(Array.isArray(element.columns) ? children(element.columns) : []),
  ]);
}

function markdown(elements: readonly CardElement[]): string {
  return children(elements)
    .filter(element => element.tag === 'markdown' && typeof element.content === 'string')
    .map(element => String(element.content))
    .join('\n');
}

function componentCount(elements: readonly CardElement[]): number {
  return elements.reduce((total, element) => total + (element.tag === 'collapsible_panel' ? 3 : 1)
    + (Array.isArray(element.elements) ? componentCount(element.elements) : 0)
    + (Array.isArray(element.columns) ? componentCount(element.columns) : 0), 0);
}

describe('bounded inline process details', () => {
  it('keeps four complete command invocations inline when their outputs are huge', () => {
    const commands = Array.from({ length: 4 }, (_, index) => `printf 'COMMAND_${index}_${'x'.repeat(900)}_END_${index}'`);
    const blocks: Block[] = commands.map((title, index) => ({ kind: 'tool', tool: {
      id: String(index), kind: 'command', title, status: 'done', output: `${String(index)}${'output'.repeat(200_000)}`,
    } }));
    const card = buildRunCard({ rs: { ...initialState, startedAt: 1, blocks } });
    const json = JSON.stringify(card);
    for (const command of commands) expect(json.split(command)).toHaveLength(2);
    expect(json).not.toContain('run.process.');
    expect(json).not.toContain('查看全部操作');
    expect(json).not.toContain('项过程已省略');
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(28_000);
  });

  it('drops output before compacting commands and never scans a huge output tail', () => {
    const output = 'x'.repeat(10_000_000);
    const blocks: Block[] = Array.from({ length: 20 }, (_, index) => ({ kind: 'tool', tool: {
      id: String(index), kind: 'command', title: `echo COMMAND_${index}_END`, status: 'done', output,
    } }));
    const iterator = String.prototype[Symbol.iterator];
    let visited = 0;
    const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function* (this: string): Generator<string, undefined> {
      for (const character of iterator.call(this)) {
        if (this.valueOf() === output) visited += 1;
        yield character;
      }
    });
    try {
      const body = buildProcessBody(blocks);
      const text = markdown(body);
      for (let index = 0; index < blocks.length; index += 1) {
        expect(text.split(`echo COMMAND_${index}_END`)).toHaveLength(2);
      }
      expect(text).not.toContain('output');
      expect(text).not.toContain('内容过长，已截断');
      expect(visited).toBeLessThan(50_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('omits whole operations with a truthful notice only at the extreme card limit', () => {
    const blocks: Block[] = Array.from({ length: 240 }, (_, index) => ({ kind: 'tool', tool: {
      id: String(index), kind: 'command', title: `printf 'OP_${index}_${'x'.repeat(700)}_END_${index}'`, status: 'done',
    } }));
    const body = buildProcessBody(blocks);
    const text = markdown(body);
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(22_000);
    expect(componentCount(body)).toBeLessThanOrEqual(120);
    expect(text).toMatch(/后续 \d+ 项过程已省略（卡片容量限制）/u);
    const included = Array.from(text.matchAll(/OP_(\d+)_x+_END_(\d+)/gu));
    expect(included.length).toBeGreaterThan(0);
    for (const match of included) expect(match[1]).toBe(match[2]);
    expect(text).toContain(`后续 ${blocks.length - included.length} 项过程已省略`);
  });

  it('updates one operation in place while retaining separate executions of the same command', () => {
    let state = reduce(initialState, { type: 'tool_use', itemId: 'one', title: 'echo same', kind: 'command' });
    state = reduce(state, { type: 'tool_use', itemId: 'one', title: 'echo same', kind: 'command' });
    state = reduce(state, { type: 'tool_result', itemId: 'one', output: 'ok' });
    state = reduce(state, { type: 'tool_use', itemId: 'two', title: 'echo same', kind: 'command' });
    const text = markdown(buildProcessBody(state.blocks));
    expect(text.split('echo same')).toHaveLength(3);
    expect(text).toContain('ok');
  });

  it.each<[Exclude<FooterStatus, null>, string]>([
    ['thinking', 'time_outlined'],
    ['tool_running', 'setting-inter_outlined'],
    ['retrying', 'warning_outlined'],
    ['streaming', 'edit_outlined'],
  ])('renders %s with the matching standard icon', (footer, token) => {
    const card = buildRunCard({ rs: { ...initialState, startedAt: 1, footer } });
    const body = (card.body as { elements: CardElement[] }).elements;
    const status = children(body).find(element => {
      const icon = element.icon as { tag?: unknown; token?: unknown } | undefined;
      return icon?.tag === 'standard_icon' && icon.token === token;
    });
    expect(status).toMatchObject({ text_size: 'notation', content: expect.stringContaining("<font color='grey'>") });
    expect(JSON.stringify(status)).not.toMatch(/[🧠🧰✍️⚠️]/u);
  });
});
