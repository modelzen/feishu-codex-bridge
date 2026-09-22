import { describe, expect, it } from 'vitest';
import { codeSpans, extractCardFences, imageSources, splitImageRefs, unresolvedRefText } from '../src/card/md-scan';

describe('imageSources', () => {
  it('extracts srcs in order, deduped, unwrapping <> and dropping titles', () => {
    const text = '![a](one.png) text ![b](<two with space.png>) ![c](three.png "t") ![dup](one.png)';
    expect(imageSources(text)).toEqual(['one.png', 'two with space.png', 'three.png']);
  });

  it('finds image refs inside a ```feishu-card fence too (one scan covers both)', () => {
    const text = '答复\n\n```feishu-card\n# T\n![x](inside.png)\n```';
    expect(imageSources(text)).toEqual(['inside.png']);
  });

  it('SKIPS refs inside an ordinary code fence / inline code — code is not an image', () => {
    // 否则一段「用法示例」就会触发真实的上传，还会占掉本轮的图片名额。
    expect(imageSources('写法：\n\n```md\n![x](/etc/hosts.png)\n```')).toEqual([]);
    expect(imageSources('行内 `![y](a.png)` 也是代码')).toEqual([]);
    expect(imageSources('```\n![z](b.png)\n```\n\n真的图 ![ok](c.png)')).toEqual(['c.png']);
  });

  it('returns [] when there are no images', () => {
    expect(imageSources('no images here, just `code`')).toEqual([]);
  });
});

describe('extractCardFences', () => {
  it('pulls the ```feishu-card fence and strips it from the text', () => {
    const text = '前言\n\n```feishu-card\n# 标题\n正文\n```\n\n后记';
    const { fences, stripped } = extractCardFences(text);
    expect(fences).toEqual(['# 标题\n正文']);
    expect(stripped).not.toContain('feishu-card');
    expect(stripped).toContain('前言');
    expect(stripped).toContain('后记');
  });

  it('handles multiple fences and leaves plain text untouched', () => {
    const plain = '没有卡片，只有 `code` 和 **bold**。';
    expect(extractCardFences(plain)).toEqual({ fences: [], stripped: plain });

    const two = '```feishu-card\nA\n```\nmid\n```feishu-card\nB\n```';
    const { fences } = extractCardFences(two);
    expect(fences).toEqual(['A', 'B']);
  });
});

describe('codeSpans / splitImageRefs', () => {
  it('代码区间认得围栏（``` 与 ~~~）和行内反引号', () => {
    const spans = codeSpans('a ```\ncode\n``` b `inline` c ~~~\ntilde\n~~~');
    expect(spans).toHaveLength(3);
    expect(spans.map(([a, b]) => 'a ```\ncode\n``` b `inline` c ~~~\ntilde\n~~~'.slice(a, b))).toEqual([
      '```\ncode\n```',
      '`inline`',
      '~~~\ntilde\n~~~',
    ]);
  });

  it('```feishu-card 围栏不算代码 —— 它的正文要渲染成卡片', () => {
    // 围栏内是 markdown，不是示例代码：里面的图必须照常被扫到、被上传。
    expect(imageSources('```feishu-card\n# T\n![x](inside.png)\n```')).toEqual(['inside.png']);
    expect(imageSources('```md\n![x](inside.png)\n```')).toEqual([]);
  });

  it('live 模式下没写完的引用被扣住，不当作 markdown 发给客户端', () => {
    const done = splitImageRefs('看图 ![a](done.png) 然后 ![b](half', true);
    expect(done.parts.map((p) => p.kind)).toEqual(['text', 'image', 'text']);
    expect(done.held).toBe('![b](half');
    // 同一段文本在终态渲染里就是普通文本（模型可能只是写了半个引用）
    expect(splitImageRefs('看图 ![a](done.png) 然后 ![b](half', false).held).toBe('');
  });
});

describe('unresolvedRefText', () => {
  it('给出可读的说明 + 代码化的路径，绝不保留裸 ![](…)', () => {
    const t = unresolvedRefText('拼图', 'video_frames/missing.jpg');
    expect(t).toBe('🖼️ 拼图（未能显示：`video_frames/missing.jpg`）');
    expect(unresolvedRefText('', 'a.png')).toContain('图片'); // alt 为空时也有名字
  });
});
