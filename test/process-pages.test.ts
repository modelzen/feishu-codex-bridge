import { describe, expect, it, vi } from 'vitest';
import { buildProcessPages, buildProcessPreview } from '../src/card/run-process';
import { buildRunCard } from '../src/card/run-card';
import { initialState, reduce, type Block } from '../src/card/run-state';
import type { CardElement } from '../src/card/cards';

function contents(elements: CardElement[]): string[] {
  return elements.flatMap(element => [
    ...(element.tag === 'markdown' && typeof element.content === 'string' ? [element.content] : []),
    ...(Array.isArray(element.elements) ? contents(element.elements) : []),
  ]);
}
function payload(elements: CardElement[], label: string): string {
  return contents(elements).filter(content => content.startsWith(`**${label}`)).map(content => {
    const start = content.indexOf('\n');
    const fenceEnd = content.indexOf('\n', start + 1);
    const close = content.lastIndexOf('\n');
    return content.slice(fenceEnd + 1, close);
  }).join('');
}
function count(elements: CardElement[]): number {
  return elements.reduce((n, el) => n + (el.tag === 'collapsible_panel' ? 3 : 1)
    + (Array.isArray(el.elements) ? count(el.elements) : 0)
    + (Array.isArray(el.columns) ? count(el.columns) : 0), 0);
}

describe('lossless process pages', () => {
  it('preserves every operation beyond the single card limit', () => {
    const blocks: Block[] = Array.from({ length: 240 }, (_, i) => ({ kind: 'tool', tool: {
      id: String(i), kind: 'command', title: `echo OP_${i}_END`, status: 'done',
    } }));
    const pages = buildProcessPages(blocks);
    expect(pages.length).toBeGreaterThan(1);
    for (let i = 0; i < blocks.length; i++) expect(payload(pages.flat(), '命令').split(`echo OP_${i}_END`)).toHaveLength(2);
    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(22000);
      expect(count(page)).toBeLessThanOrEqual(120);
    }
    const card = JSON.stringify(buildRunCard({ rs: { ...initialState, blocks }, processHistoryId: 'history' }));
    expect(card).toContain('run.process.open');
    expect(card).not.toMatch(/未显示|已省略|已截断/);
  });

  it('splits an oversized inline image row without losing an image or exceeding nested component limits', () => {
    const images = new Map(Array.from({ length: 100 }, (_, i) => [`image${i}`, `key${i}`]));
    const blocks: Block[] = [{ kind: 'text', id: 'images', streaming: false,
      content: [...images.keys()].map(src => `![](${src})`).join(' ') }];
    for (const budget of [120, 10]) {
      const pages = buildProcessPages(blocks, images, budget);
      expect(pages.length).toBeGreaterThan(1);
      const imageKeys = (elements: CardElement[]): string[] => elements.flatMap(el => [
        ...(el.tag === 'img' && typeof el.img_key === 'string' ? [el.img_key] : []),
        ...(Array.isArray(el.elements) ? imageKeys(el.elements) : []),
        ...(Array.isArray(el.columns) ? imageKeys(el.columns) : []),
      ]);
      expect(imageKeys(pages.flat())).toEqual([...images.values()]);
      for (const page of pages) {
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(22000);
        expect(count(page)).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('stops the live preview before scanning a large output or touching later blocks', () => {
    const output = 'x'.repeat(10_000_000);
    const tool: Block = { kind: 'tool', tool: { id: 'big', kind: 'command', title: 'echo ok', status: 'done', output } };
    const later: Block = { kind: 'tool', get tool(): never { throw new Error('preview read a later operation'); } };
    const iterator = String.prototype[Symbol.iterator];
    let visited = 0;
    const spy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function* (this: string): Generator<string, undefined> {
      for (const character of iterator.call(this)) {
        if (this.valueOf() === output) visited += 1;
        yield character;
      }
    });
    try {
      const preview = buildProcessPreview([tool, later]);
      expect(preview.hasMore).toBe(true);
      expect(visited).toBeLessThan(50_000);
      visited = 0;
      expect(JSON.stringify(buildRunCard({ rs: { ...initialState, blocks: [tool] }, processHistoryId: 'history' }))).toContain('run.process.open');
      expect(visited).toBeLessThan(50_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('shows the exact invocation once, with a semantic collapsed header', () => {
    const command = 'printf "UNIQUE_COMMAND_BODY"';
    const pages = buildProcessPages([{ kind: 'tool', tool: {
      id: 'only', kind: 'command', title: command, status: 'done',
    } }]);
    const json = JSON.stringify(pages);
    expect(json.split('UNIQUE_COMMAND_BODY')).toHaveLength(2);
    expect(payload(pages.flat(), '命令')).toBe(command);
    expect(pages[0]?.[0]?.header).toMatchObject({ title: { content: "<font color='grey'>已运行命令</font>" } });
  });

  it('recovers Unicode, whitespace and fences exactly across command/output/argument chunks', () => {
    const command = `  echo ${'中😀\\\n`'.repeat(9000)}  \n`;
    const output = '`'.repeat(18000) + '尾😀';
    const detail = JSON.stringify({ cmd: command, cwd: '目录'.repeat(9000) });
    const pages = buildProcessPages([{ kind: 'tool', tool: {
      id: 'big', kind: 'tool', title: 'exec_command', status: 'done', detail, output,
    } }], undefined, 10);
    expect(payload(pages.flat(), '命令')).toBe(command);
    expect(payload(pages.flat(), '输出')).toBe(output);
    expect(JSON.parse(payload(pages.flat(), '调用参数'))).toEqual({ cwd: '目录'.repeat(9000) });
    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(22000);
      expect(count(page)).toBeLessThanOrEqual(10);
    }
  });

  it('updates an operation in place while retaining distinct executions of the same command', () => {
    let state = reduce(initialState, { type: 'tool_use', itemId: 'one', title: 'echo same', kind: 'command' });
    state = reduce(state, { type: 'tool_use', itemId: 'one', title: 'echo same', kind: 'command' });
    state = reduce(state, { type: 'tool_result', itemId: 'one', output: 'ok' });
    state = reduce(state, { type: 'tool_use', itemId: 'two', title: 'echo same', kind: 'command' });
    const pages = buildProcessPages(state.blocks);
    expect(payload(pages.flat(), '命令')).toBe('echo sameecho same');
    expect(payload(pages.flat(), '输出')).toBe('ok');
  });
});
