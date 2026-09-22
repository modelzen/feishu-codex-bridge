import { card, columns, hr, imagePill, md, mdStream, note, type CardElement, type CardObject, type HeaderTemplate } from './cards';
import {
  codeSpans,
  extractCardFences,
  fileName,
  hasImageRef,
  neutraliseRefsInCode,
  splitImageRefs,
  unresolvedRefText,
} from './md-scan';

/**
 * Markdown → card-element rendering for outbound replies. Two jobs:
 *
 *  1. {@link renderRichText} — turn a markdown answer into card elements,
 *     splitting out `![alt](src)` images (resolved to `img_key` via the upload
 *     map) into real `img` elements interleaved with the text. A source that
 *     isn't in the map NEVER falls back to raw `![](src)` markdown: the feishu
 *     client parses that syntax into an image node and resolves the target as an
 *     `image_key`, so a filesystem path renders as a broken image and can stall
 *     the element's typewriter (issue #14 "一显示就卡"). An unresolved ref
 *     becomes an explicit 「未能显示」 plus its path as inline code — visible,
 *     copyable, and never an image node.
 *     It also strips ```feishu-card fences, which are hoisted into their own card.
 *
 *  2. {@link buildCleanCard} — parse one ```feishu-card fence's markdown into a
 *     standalone card: a leading heading becomes the card header, `---` → hr,
 *     `> …` → grey note, everything else → markdown (with inline images). The
 *     bridge owns this mapping so the emitted card is always valid schema 2.0 —
 *     codex only writes markdown, never hand-rolled (often wrong) card JSON.
 *
 * Both share the same scanner ({@link ./md-scan}) and the `src → image_key` map
 * produced by {@link ./outbound-images}.
 */

type ImageMap = ReadonlyMap<string, string>;
const NO_IMAGES: ImageMap = new Map();

export interface RenderOptions {
  /** element_id for the LAST markdown element. A running card's answer grows
   * through the element-level typewriter, which needs one stable, append-only
   * text element (see {@link ./run-card-stream}); the trailing segment is the
   * one that keeps growing, so the id rides there. */
  streamTailId?: string;
  /** Live (running-card) render, which differs from the terminal render in three
   * ways: a ref whose upload hasn't landed yet becomes a short placeholder, an
   * unterminated `![…](…)` tail (the model is still writing the path) is held
   * back instead of being streamed as broken syntax, and ```feishu-card fences
   * stay visible (they are only hoisted into standalone cards at terminal). */
  live?: boolean;
}

/** Live placeholder for a ref whose upload is still in flight. */
function pendingPlaceholder(alt: string): string {
  return `🖼️ ${alt.trim() || '图片'}（图片处理中…）`;
}

/**
 * Pill title for a resolved ref: the markdown alt the model wrote, falling back
 * to the file name when the alt is empty (`![](video_frames/key/12.jpg)` →
 * `12.jpg`) — a pill must never be title-less.
 */
function pillTitle(alt: string, src: string): string {
  return alt.trim() || fileName(src);
}

/**
 * Render a markdown string into card elements, replacing resolved `![](src)`
 * images with `img` elements and stripping any ```feishu-card fences. Plain
 * text (no images, no fences) short-circuits to a single markdown element.
 */
export function renderRichText(text: string, images: ImageMap = NO_IMAGES, opts: RenderOptions = {}): CardElement[] {
  // A running card keeps the fence visible; only the terminal render hoists it.
  const raw = opts.live ? text : extractCardFences(text).stripped;
  const body = neutraliseRefsInCode(raw, codeSpans(raw));
  if (!hasImageRef(body)) {
    const t = body.trim();
    return t ? [opts.streamTailId ? mdStream(t, opts.streamTailId) : md(t)] : [];
  }
  const { parts } = splitImageRefs(body, opts.live === true);
  const els: CardElement[] = [];
  let buf = '';
  const flush = (): void => {
    const t = buf.trim();
    if (t) els.push(md(t));
    buf = '';
  };
  /** Is there another image ref further along the SAME source line as index `i`?
   * Only then is a row worth opening — an image that ends its line stays a plain
   * block element, so its expanded picture keeps the full card width, and any
   * text after it stays a normal markdown element (which the running card's
   * element typewriter needs: see {@link RenderOptions.streamTailId}). */
  const imageFollowsOnLine = (i: number): boolean => {
    for (let j = i + 1; j < parts.length; j++) {
      const q = parts[j]!;
      if (q.kind === 'image') return true;
      if (q.text.includes('\n')) return false;
    }
    return false;
  };
  let row: CardElement[] | null = null;
  const closeRow = (): void => {
    if (!row) return;
    // Images on ONE line are laid out as one wrapping row; a lone pill is just
    // itself (a column_set around a single element only adds spacing).
    els.push(row.length === 1 ? row[0]! : columns(row.map((el) => ({ elements: [el] })), { flexMode: 'flow', spacing: 'small' }));
    row = null;
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.kind === 'text') {
      const nl = p.text.indexOf('\n');
      // While a row is open, only text that leads to another image on this line
      // joins the row; otherwise the line is over and the rest is normal text.
      if (row && nl < 0 && imageFollowsOnLine(i)) {
        if (p.text.trim()) row.push(md(p.text.trim()));
        continue;
      }
      if (row) {
        if (nl > 0) {
          const head = p.text.slice(0, nl);
          if (head.trim()) row.push(md(head.trim()));
        }
        closeRow();
        buf += nl < 0 ? p.text : p.text.slice(nl);
        continue;
      }
      buf += p.text;
      continue;
    }
    const key = images.get(p.src);
    if (key) {
      if (row) {
        if (buf.trim()) row.push(md(buf.trim()));
        buf = '';
      } else {
        flush();
        row = [];
      }
      row.push(imagePill({ imgKey: key, title: pillTitle(p.alt, p.src), alt: p.alt }));
      if (!imageFollowsOnLine(i)) closeRow();
    } else if (opts.live) {
      // Still uploading (or rejected): show what it is without teaching the
      // client to parse a broken image node.
      buf += pendingPlaceholder(p.alt);
    } else {
      buf += unresolvedRefText(p.alt, p.src);
    }
  }
  closeRow();
  flush();
  // Keep the growing trailing markdown addressable so later text deltas return to
  // CardKit's element typewriter instead of a whole-card update.
  if (opts.streamTailId) {
    const tail = els[els.length - 1];
    if (tail?.tag === 'markdown') els[els.length - 1] = mdStream(String(tail.content), opts.streamTailId);
  }
  return els;
}

/**
 * Build a standalone clean card from one ```feishu-card fence's markdown. A
 * leading heading (`# …`) becomes the card header (blue); the rest is split
 * into blocks on blank lines and mapped element-by-element.
 */
export function buildCleanCard(
  fenceMarkdown: string,
  images: ImageMap = NO_IMAGES,
  template: HeaderTemplate = 'blue',
): CardObject {
  const lines = fenceMarkdown.split('\n');
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === '') start++;
  const headingMatch = lines[start]?.match(/^#{1,6}\s+(.+?)\s*$/);
  const title = headingMatch ? headingMatch[1] : '';
  if (headingMatch) start++;

  const bodyMarkdown = lines.slice(start).join('\n').trim();
  const elements = renderCleanBody(bodyMarkdown, images);
  // A card needs at least one body element — fall back to the title (or a
  // spacer) so a title-only fence still produces a valid card.
  const body = elements.length > 0 ? elements : [md(title || ' ')];

  return card(body, {
    ...(title ? { header: { title, template } } : {}),
    summary: title || '卡片',
  });
}

/** Split clean-card body markdown into blocks (on blank lines) and map each to
 * an element: a markdown rule → hr, a `> …` quote block → note, anything else →
 * image-aware markdown. */
function renderCleanBody(bodyMarkdown: string, images: ImageMap): CardElement[] {
  const out: CardElement[] = [];
  for (const raw of bodyMarkdown.split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(block)) {
      out.push(hr());
      continue;
    }
    const blockLines = block.split('\n');
    if (blockLines.every((l) => l.trim() === '' || /^\s*>\s?/.test(l))) {
      const noteText = blockLines
        .map((l) => l.replace(/^\s*>\s?/, ''))
        .join('\n')
        .trim();
      if (noteText) out.push(note(noteText));
      continue;
    }
    out.push(...renderRichText(block, images));
  }
  return out;
}
