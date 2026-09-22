import { describe, expect, it } from 'vitest';
import { renderFileAnswer, type InlineFiles } from '../src/card/inline-files';

const files = (text: string): InlineFiles => ({ text, links: [{ token: 'FILETOKEN', element: {
  tag: 'interactive_container', element_id: 'local_file_0',
  elements: [{ tag: 'markdown', content: "<font color='blue'>报告.txt</font>" }],
} }] });

function contents(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(contents);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [...(node.tag === 'markdown' ? [String(node.content)] : []), ...Object.values(node).flatMap(contents)];
}

describe('inline file layout', () => {
  it('preserves paragraph order and ordered list numbers without visible emphasis markers', () => {
    const result = renderFileAnswer(files('开头。\n\n3. **下载 FILETOKEN 查看**\n\n结束。'));
    expect(contents(result).map((text) => text.trim())).toEqual(['开头。', '3\\. **下载**&nbsp;', "<font color='blue'>报告.txt</font>", '&nbsp;**查看**', '结束。']);
    expect(JSON.stringify(result)).not.toContain('FILETOKEN');
  });

  it('handles a file that is the entire bold link without emitting empty text or extra buttons', () => {
    expect(renderFileAnswer(files('**FILETOKEN**'))).toEqual([files('').links[0]!.element]);
  });

  it('keeps ordinary web links and image pills while replacing the local reference', () => {
    const result = renderFileAnswer(files('[官网](https://example.com)\n\nFILETOKEN\n\n![图片](photo.png)'), new Map([['photo.png', 'img_key']]));
    const json = JSON.stringify(result);
    expect(json).toContain('[官网](https://example.com)');
    expect(json).toContain('img_key');
    expect(json).toContain('local_file_0');
    expect(json).not.toContain('FILETOKEN');
  });

  it('keeps file-bearing table cells in row/column order and leaves ordinary tables native', () => {
    const result = renderFileAnswer(files('| 文件 | 说明 |\n|---|---|\n| FILETOKEN | 描述 |\n\n| A | B |\n|---|---|\n| 1 | 2 |'));
    expect(result[0]).toMatchObject({ tag: 'column_set' });
    expect(contents(result).slice(0, 4)).toEqual(['**文件**', '**说明**', "<font color='blue'>报告.txt</font>", '描述']);
    expect(result.at(-1)).toMatchObject({ tag: 'table', rows: [{ c0: '1', c1: '2' }] });
    expect(JSON.stringify(result)).not.toContain('FILETOKEN');
  });
});
