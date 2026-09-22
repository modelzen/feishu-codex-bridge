import { describe, expect, it } from 'vitest';
import type { CardElement } from '../src/card/cards';
import { renderReport } from '../src/card/report-render';

const els = (t: string, images?: Map<string, string>): CardElement[] => renderReport(t, { images });
const tags = (e: CardElement[]): unknown[] => e.map((x) => x.tag);

describe('renderReport — 表格', () => {
  it('pipe table → native table component（markdown 列，表头来自首行）', () => {
    const out = els(['| 文件 | 尺寸 |', '|---|---|', '| a.jpg | 360×779 |', '| b.jpg | 1480×3943 |'].join('\n'));
    expect(out).toHaveLength(1);
    const t = out[0] as Record<string, any>;
    expect(t.tag).toBe('table');
    expect(t.columns.map((c: any) => c.display_name)).toEqual(['文件', '尺寸']);
    expect(t.columns.every((c: any) => c.data_type === 'lark_md')).toBe(true);
    expect(t.rows).toEqual([
      { c0: 'a.jpg', c1: '360×779' },
      { c0: 'b.jpg', c1: '1480×3943' },
    ]);
    expect(t.page_size).toBe(2); // no pointless pager for short tables
  });

  it('keeps surrounding prose, headings and lists as markdown', () => {
    const doc = ['项目里共有 **32 个图片文件**。', '', '## 1. 根目录（1 个）', '', '| 文件 |', '|---|', '| a.png |', '', '- 一是', '- 二是'].join('\n');
    expect(tags(els(doc))).toEqual(['markdown', 'markdown', 'table', 'markdown']);
    expect((els(doc)[1] as any).text_size).toBe('heading-4');
  });

  it('a pipe block WITHOUT a delimiter row stays markdown text (nothing lost)', () => {
    const out = els('| 不是表格 |\n| 只是文本 |');
    expect(tags(out)).toEqual(['markdown']);
    expect((out[0] as any).content).toContain('不是表格');
  });

  it('caps tables at 5 per card — the 6th degrades to text instead of 400-ing', () => {
    const one = ['| h |', '|---|', '| v |'].join('\n');
    const out = els(Array.from({ length: 6 }, () => one).join('\n\n'));
    expect(out.filter((e) => e.tag === 'table')).toHaveLength(5);
    expect((out[5] as any).content).toContain('| v |');
  });

  it('normalises ragged rows and escaped pipes', () => {
    const out = els(['| a | b |', '|---|---|', '| only-a |', '| x \\| y | z |'].join('\n'));
    expect((out[0] as any).rows).toEqual([
      { c0: 'only-a', c1: '' },
      { c0: 'x | y', c1: 'z' },
    ]);
  });
});

describe('renderReport — 链接只保留能打开的', () => {
  // 本地路径链接在飞书客户端是死链（bridge 也没法给本地文件变出可打开的 URL），
  // 所以非 http(s) 的目标只保留文字。这里不再有 links 参数：那个「路径 → URL」
  // 的改写从来没接过调用方，是死代码。
  it('http(s) 链接原样保留', () => {
    const out = els('见 [文档](https://example.com/x)');
    expect((out[0] as any).content).toBe('见 [文档](https://example.com/x)');
  });

  it('非 http(s) 目标 → 纯文字，绝不留下死链', () => {
    const out = els('见 [nope.jpg](nope.jpg)');
    expect((out[0] as any).content).toBe('见 nope.jpg');
  });

  it('表格单元格里的非 http(s) 链接同样退化成文字', () => {
    const out = els(['| 文件 |', '|---|', '| [a.zip](files/a.zip) |'].join('\n'));
    expect((out[0] as any).rows[0].c0).toBe('a.zip');
  });

  it('未上传的 image ref → 「未能显示」文字，绝不产出裸 ![]()', () => {
    const out = els('图：![拼图](video_frames/missing.jpg)');
    const c = (out[0] as any).content as string;
    expect(c).not.toContain('![');
    expect(c).toContain('未能显示：`video_frames/missing.jpg`');
  });

  it('上传过的 image ref → 正文里就是图片小标签（不能因为答案带表格就整张图消失）', () => {
    const out = els('图：![拼图](shot.jpg)', new Map([['shot.jpg', 'key_1']]));
    expect(JSON.stringify(out)).not.toContain('![');
    const pill = out.find((e: any) => e.tag === 'collapsible_panel') as any;
    expect(pill.elements[0]).toMatchObject({ tag: 'img', img_key: 'key_1' });
  });

  it('drops a ```feishu-card fence from the report body', () => {
    const out = els('正文\n\n```feishu-card\n# T\n```');
    expect(JSON.stringify(out)).not.toContain('feishu-card');
  });

  it('只有围栏的正文不留空 markdown 元素', () => {
    const out = els('```feishu-card\n# T\n```');
    expect(out).toEqual([]);
  });
});

describe('renderReport — 表格里的图统一挪到末尾', () => {
  const images = new Map([
    ['video_frames/contact_sheet.jpg', 'key_sheet'],
    ['video_frames/frame_01.jpg', 'key_frame'],
  ]);

  it('表格单元格里的 `[文件名](图片路径)` 链接：单元格留文字，图在末尾出小标签', () => {
    const doc = ['| 文件 | 尺寸 |', '|---|---|', '| [contact_sheet.jpg](video_frames/contact_sheet.jpg) | 1480×3943 |'].join('\n');
    const out = renderReport(doc, { images });
    const t = out[0] as Record<string, any>;
    expect(t.tag).toBe('table');
    expect(t.rows[0].c0).toBe('contact_sheet.jpg'); // 单元格只剩文字，没有死链
    expect(out.map((e) => e.tag)).toEqual(['table', 'hr', 'markdown', 'collapsible_panel']);
    expect((out[2] as any).content).toBe('**展开查看 1 张图片**'); // 末尾文案（带实际张数）
    const pill = out[3] as Record<string, any>;
    expect(pill.header.title.content).toContain('contact_sheet.jpg');
    expect(pill.elements[0]).toMatchObject({ tag: 'img', img_key: 'key_sheet' });
  });

  it('表格里的 markdown 图片语法 `![alt](path)` 同样被抽出来', () => {
    const doc = ['| 预览 |', '|---|', '| ![拼图总览](video_frames/contact_sheet.jpg) |'].join('\n');
    const out = renderReport(doc, { images });
    expect((out[0] as any).rows[0].c0).toBe('拼图总览'); // alt 文本留在单元格
    expect((out[3] as any).header.title.content).toContain('拼图总览');
  });

  it('正文里的图不受影响，仍在原位（只有表格里的被挪）', () => {
    const doc = ['正文里：![第 1 帧](video_frames/frame_01.jpg)', '', '| 文件 |', '|---|', '| [contact_sheet.jpg](video_frames/contact_sheet.jpg) |'].join('\n');
    const out = renderReport(doc, { images });
    expect(out[0]).toMatchObject({ tag: 'markdown' });
    // 正文里的图走普通内联路径，原位上标签（不能因为答案带表格就整张消失）
    expect(out[1]).toMatchObject({ tag: 'collapsible_panel' });
    expect((out[1] as any).elements[0]).toMatchObject({ tag: 'img', img_key: 'key_frame' });
    expect(out.filter((e) => e.tag === 'collapsible_panel')).toHaveLength(2); // 正文 1 + 末尾表格 1
  });

  it('多张图 → 末尾排成一行（自动换行），而不是一行一个', () => {
    const doc = ['| 文件 |', '|---|', '| [a](video_frames/frame_01.jpg) |', '| [b](video_frames/contact_sheet.jpg) |'].join('\n');
    const out = renderReport(doc, { images });
    const row = out[out.length - 1] as Record<string, any>;
    expect(row.tag).toBe('column_set');
    expect(row.flex_mode).toBe('flow'); // 窄屏自动折行
    expect(row.columns).toHaveLength(2);
    expect(row.columns.every((c: any) => c.elements[0].tag === 'collapsible_panel')).toBe(true);
    // 两张图不再各占一行
    expect(out.filter((e) => e.tag === 'collapsible_panel')).toHaveLength(0);
  });

  it('同一张图在表格里出现多次 → 末尾只出一个标签', () => {
    const doc = ['| a | b |', '|---|---|', '| [x](video_frames/frame_01.jpg) | [y](video_frames/frame_01.jpg) |'].join('\n');
    const out = renderReport(doc, { images });
    expect(out.filter((e) => e.tag === 'collapsible_panel')).toHaveLength(1);
  });

  it('没上传成功的图不会凭空变成标签（单元格留文字，不出现死链）', () => {
    const doc = ['| 文件 |', '|---|', '| [gone.jpg](video_frames/gone.jpg) |'].join('\n');
    const out = renderReport(doc, { images });
    expect((out[0] as any).rows[0].c0).toBe('gone.jpg');
    expect(out.some((e) => e.tag === 'collapsible_panel')).toBe(false);
  });

  it('http(s) 链接不算本地图片，原样保留', () => {
    const doc = ['| 文件 |', '|---|', '| [远端](https://example.com/a.jpg) |'].join('\n');
    const out = renderReport(doc, { images });
    expect((out[0] as any).rows[0].c0).toBe('[远端](https://example.com/a.jpg)');
    expect(out).toHaveLength(1);
  });
});
