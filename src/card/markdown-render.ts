import { card, hr, image, md, mdStream, note, type CardElement, type CardObject, type HeaderTemplate } from './cards';

/**
 * Markdown → card-element rendering for outbound replies. Two jobs:
 *
 *  1. {@link renderRichText} — turn a markdown answer into card elements,
 *     splitting out `![alt](src)` images (resolved to `img_key` via the upload
 *     map) into real `img` elements interleaved with the text. Unresolved
 *     sources keep their literal markdown (graceful degradation). It also
 *     strips ```feishu-card fences, which are hoisted into their own card.
 *
 *  2. {@link buildCleanCard} — parse one ```feishu-card fence's markdown into a
 *     standalone card: a leading heading becomes the card header, `---` → hr,
 *     `> …` → grey note, everything else → markdown (with inline images). The
 *     bridge owns this mapping so the emitted card is always valid schema 2.0 —
 *     codex only writes markdown, never hand-rolled (often wrong) card JSON.
 *
 * Both share the same image-aware text splitter and the `src → image_key` map
 * produced by {@link ./outbound-images}.
 */

type ImageMap = ReadonlyMap<string, string>;
const NO_IMAGES: ImageMap = new Map();

/** `![alt](src)` — group 1 = alt, group 2 = src (possibly `<…>`-wrapped). Mirrors
 * the source-scanning regex in outbound-images so the two stay in lockstep. */
const IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
/** A ```feishu-card fenced block; group 1 = the inner markdown. */
const FENCE_RE = /```feishu-card[^\n]*\n([\s\S]*?)```/g;

function cleanSrc(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  return s;
}

/**
 * Pull every ```feishu-card fence out of `text`. Returns the fences' inner
 * markdown (trimmed) and `text` with the fences removed (so the run card never
 * shows a card spec as a raw code block — it's rendered as a clean card
 * instead).
 */
export function extractCardFences(text: string): { fences: string[]; stripped: string } {
  const fences: string[] = [];
  const re = new RegExp(FENCE_RE.source, 'g');
  const stripped = text.replace(re, (_full, inner: string) => {
    fences.push(inner.trim());
    return '';
  });
  return { fences, stripped };
}

/**
 * Render a markdown string into card elements, replacing resolved `![](src)`
 * images with `img` elements and stripping any ```feishu-card fences. Plain
 * text (no images, no fences) short-circuits to a single markdown element.
 */
export function renderRichText(text: string, images: ImageMap = NO_IMAGES, streamTailId?: string): CardElement[] {
  const body = extractCardFences(text).stripped;
  if (!body.includes('![')) {
    const t = body.trim();
    return t ? [streamTailId ? mdStream(t, streamTailId) : md(t)] : [];
  }
  const els: CardElement[] = [];
  let buf = '';
  const flush = (): void => {
    const t = buf.trim();
    if (t) els.push(md(t));
    buf = '';
  };
  const re = new RegExp(IMG_RE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    buf += body.slice(last, m.index);
    const alt = m[1] ?? '';
    const src = cleanSrc(m[2] ?? '');
    const key = images.get(src);
    if (key) {
      flush();
      els.push(image(key, alt));
    } else {
      // Unresolved (path outside cwd / fetch failed / not yet uploaded): keep
      // the literal markdown so the reference isn't silently dropped.
      buf += m[0];
    }
    last = m.index + m[0].length;
  }
  buf += body.slice(last);
  flush();
  // Images force a structural update once. Keep the growing trailing markdown
  // addressable so later text deltas return to CardKit's element typewriter.
  const tail = els.at(-1);
  if (streamTailId && tail?.tag === 'markdown') {
    els[els.length - 1] = mdStream(String(tail.content), streamTailId);
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
  const body = elements.length > 0 ? elements : [md(title || '­')];

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
