import { describe, expect, it } from 'vitest';
import { buildCleanCard, renderRichText } from '../src/card/markdown-render';
import { extractCardFences } from '../src/card/md-scan';

/** Collect every element with a given tag from a card body / element list. */
function tags(node: unknown, tag: string, acc: any[] = []): any[] {
  if (Array.isArray(node)) node.forEach((n) => tags(n, tag, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.tag === tag) acc.push(o);
    for (const k of Object.keys(o)) tags(o[k], tag, acc);
  }
  return acc;
}

describe('renderRichText', () => {
  it('plain text → a single markdown element (fast path)', () => {
    const els = renderRichText('就是一段**普通**文字');
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ tag: 'markdown', content: '就是一段**普通**文字' });
  });

  it('a resolved ref becomes a pill titled by its alt, in place', () => {
    const map = new Map([['shot.png', 'img_key_123']]);
    const els = renderRichText('看这张图：\n\n![管理台](shot.png)\n\n然后呢', map);
    expect(els.map((e: any) => e.tag)).toEqual(['markdown', 'collapsible_panel', 'markdown']);
    const pill = tags(els, 'collapsible_panel')[0] as any;
    expect(pill.header.title.content).toBe("<font color='blue'>管理台</font>"); // 标题 = alt，染成链接蓝
    expect(pill.header.width).toBe('auto_when_fold'); // 收起态是个小标签
    expect(pill.elements[0]).toMatchObject({ tag: 'img', img_key: 'img_key_123', mode: 'fit_horizontal', preview: true });
    expect((els[0] as any).content).toContain('看这张图');
    expect((els[2] as any).content).toContain('然后呢');
  });

  it('a ref inside a code span/fence is code — no pill, and no raw ![](…) for feishu to reject', () => {
    const map = new Map([['shot.png', 'k']]);
    const els = renderRichText('写法是这样：\n\n```\n![alt](shot.png)\n```', map);
    expect(tags(els, 'collapsible_panel')).toHaveLength(0);
    const json = JSON.stringify(els);
    expect(json).not.toContain('!['); // 零宽空格隔开，飞书服务端校验看不到图片引用
    expect(json.replace(/\u200b/g, '')).toContain('![alt](shot.png)'); // 读者看到的还是原样

    const inlineCode = renderRichText('行内：`![alt](shot.png)`', map);
    expect(tags(inlineCode, 'collapsible_panel')).toHaveLength(0);
    expect(JSON.stringify(inlineCode)).not.toContain('![');
  });

  it('an empty alt falls back to the file name as the pill title', () => {
    const els = renderRichText('![](video_frames/key/12.jpg)', new Map([['video_frames/key/12.jpg', 'k']]));
    expect((els[0] as any).header.title.content).toBe("<font color='blue'>12.jpg</font>");
  });

  it('refs on the SAME line share one wrapping row; one per line stays a plain pill', () => {
    const map = new Map([['1.png', 'k1'], ['2.png', 'k2']]);
    const sameLine = renderRichText('前 ![a](1.png) 和 ![b](2.png) 后', map);
    expect(sameLine.map((e: any) => e.tag)).toEqual(['markdown', 'column_set', 'markdown']);
    expect((sameLine[1] as any).columns.map((c: any) => c.elements[0].tag)).toEqual(['collapsible_panel', 'markdown', 'collapsible_panel']);

    const ownLines = renderRichText('前\n\n![a](1.png)\n\n![b](2.png)\n\n后', map);
    expect(ownLines.map((e: any) => e.tag)).toEqual(['markdown', 'collapsible_panel', 'collapsible_panel', 'markdown']);
  });

  it('never emits a bare ![alt](src) for an unresolved image — the client would parse it as a broken image node', () => {
    const els = renderRichText('图：![x](missing.png) 完', new Map());
    expect(tags(els, 'img')).toHaveLength(0);
    // Path stays visible (as code), but the markdown form is gone (issue #14).
    expect((els[0] as any).content).toBe('图：🖼️ x（未能显示：`missing.png`） 完');
    expect((els[0] as any).content).not.toContain('![');
  });

  it('live mode: an in-flight ref becomes a placeholder, and an unfinished one is held back', () => {
    const mid = renderRichText('图：![x](shot.png) 完', new Map(), { live: true });
    expect((mid[0] as any).content).toBe('图：🖼️ x（图片处理中…） 完');

    // `![x](sho` is not an image yet — streaming it would show broken syntax.
    const partial = renderRichText('图：![x](sho', new Map(), { live: true });
    expect((partial[0] as any).content).toBe('图：');
  });

  it('live mode: a resolved ref becomes the same pill (only unresolved refs differ)', () => {
    const els = renderRichText('前 ![x](shot.png) 后', new Map([['shot.png', 'key_1']]), { live: true });
    expect(els.map((e: any) => e.tag)).toEqual(['markdown', 'collapsible_panel', 'markdown']);
  });

  it('streamTailId lands on the LAST markdown element only (the growing segment)', () => {
    const els = renderRichText('前 ![x](shot.png) 后', new Map([['shot.png', 'key_1']]), { streamTailId: 'answer' });
    expect((els[0] as any).element_id).toBeUndefined();
    expect((els[1] as any).tag).toBe('collapsible_panel');
    expect((els[2] as any).element_id).toBe('answer');

    const plain = renderRichText('纯文本', new Map(), { streamTailId: 'answer' });
    expect(plain[0]).toMatchObject({ tag: 'markdown', element_id: 'answer' });
  });

  it('live mode keeps ```feishu-card fences visible (they are hoisted at terminal)', () => {
    const text = '答复：\n\n```feishu-card\n# T\nbody\n```';
    expect(JSON.stringify(renderRichText(text, new Map(), { live: true }))).toContain('feishu-card');
    expect(JSON.stringify(renderRichText(text))).not.toContain('feishu-card');
  });

  it('resolves http(s) URLs the same way (keyed by the verbatim src)', () => {
    const url = 'https://example.com/a.png';
    const els = renderRichText(`![](${url})`, new Map([[url, 'img_remote']]));
    expect(tags(els, 'img')[0].img_key).toBe('img_remote');
  });

  it('drops a ```feishu-card fence from the answer (hoisted to a clean card)', () => {
    const els = renderRichText('答复：\n\n```feishu-card\n# T\nbody\n```');
    // only the lead-in text remains; the fence is gone
    expect(tags(els, 'markdown').every((m: any) => !m.content.includes('feishu-card'))).toBe(true);
    expect((els[0] as any).content).toContain('答复');
  });

  it('preserves a Feishu mention tag verbatim (so codex can @ a user)', () => {
    const els = renderRichText('已处理完，请验收 <at id=ou_abcd1234></at>');
    expect(els).toHaveLength(1);
    expect((els[0] as any).content).toBe('已处理完，请验收 <at id=ou_abcd1234></at>');
  });

  it('preserves a mention even when interleaved with an uploaded image', () => {
    const map = new Map([['shot.png', 'img_key_1']]);
    const els = renderRichText('看图 <at id=ou_x></at>\n\n![s](shot.png)', map);
    expect((els[0] as any).content).toContain('<at id=ou_x></at>');
    expect(tags(els, 'img')).toHaveLength(1);
  });

  it('preserves a bare mention with no surrounding text', () => {
    const els = renderRichText('<at id=ou_x></at>');
    expect(els).toHaveLength(1);
    expect((els[0] as any).content).toBe('<at id=ou_x></at>');
  });
});

describe('buildCleanCard', () => {
  it('hoists the leading heading into a blue header and maps blocks', () => {
    const md = [
      '# 更新说明',
      '',
      '本次更新重点提升了体验。',
      '',
      '![管理台](admin.png)',
      '',
      '---',
      '',
      '**新增功能**',
      '- A',
      '- B',
      '',
      '> 一句话总结：更顺手了。',
    ].join('\n');
    const card: any = buildCleanCard(md, new Map([['admin.png', 'img_admin']]));

    expect(card.schema).toBe('2.0');
    expect(card.header.title.content).toBe('更新说明');
    expect(card.header.template).toBe('blue');
    expect(card.config.summary.content).toBe('更新说明');

    const els = card.body.elements as any[];
    expect(tags(els, 'img')[0].img_key).toBe('img_admin');
    expect(tags(els, 'hr')).toHaveLength(1);
    // the quote block becomes a grey note (div with grey lark_md), not markdown
    const note = els.find((e) => e.tag === 'div' && e.text?.text_color === 'grey');
    expect(note.text.content).toContain('一句话总结');
  });

  it('a title-only fence still yields a valid non-empty body', () => {
    const card: any = buildCleanCard('# 只有标题');
    expect(card.header.title.content).toBe('只有标题');
    expect((card.body.elements as any[]).length).toBeGreaterThan(0);
  });

  it('no leading heading → no header bar', () => {
    const card: any = buildCleanCard('直接正文，没有标题。');
    expect(card.header).toBeUndefined();
    expect((card.body.elements as any[])[0].content).toContain('直接正文');
  });
});
