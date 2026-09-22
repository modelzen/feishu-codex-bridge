/**
 * The bridge's single markdown scanner for the syntax it cares about: `![](…)`
 * images, `[](…)` links, ```feishu-card fences and CODE regions.
 *
 * Every consumer used to carry its own copy of the regexes and of the tiny
 * `cleanSrc` helper, with comments asking the next reader to "keep in lockstep".
 * They didn't stay in lockstep — the uploader scanned a reply for refs without
 * knowing what a code fence is, so a `![示例](/etc/hosts.png)` inside a fenced
 * example was read from disk and uploaded (and burned one of the 30 upload
 * slots). One scanner, one answer to "is this an image reference?".
 *
 * Deliberately dependency-free: `cards.ts` and `outbound-images.ts` both import
 * this, so it must not import either.
 */

/** `![alt](src)` — group 1 = alt, group 2 = src (possibly `<…>`-wrapped). */
export const IMG_RE = /!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** `[text](target)` — a markdown link. */
export const LINK_RE = /\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)\s*\)/g;

/** A ```feishu-card fenced block; group 1 = the inner markdown. */
const FENCE_RE = /```feishu-card[^\n]*\n([\s\S]*?)```/g;

/** Strip optional `<…>` wrapping and surrounding space from a markdown src. */
export function cleanSrc(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  return s;
}

/** Fresh global regex (lastIndex is stateful), so callers can re-scan safely. */
export const imgRe = (): RegExp => new RegExp(IMG_RE.source, 'g');
export const linkRe = (): RegExp => new RegExp(LINK_RE.source, 'g');

/** A `[start, end)` range of `text`. */
export type Span = [number, number];

/**
 * Ranges of `text` that are CODE — fenced blocks and inline spans. An image ref
 * inside them is literal code, not an image.
 *
 * A ```feishu-card fence is deliberately NOT code: its body is markdown the
 * bridge renders into a real card, so a ref inside it must still be found (and
 * uploaded) for that card's image to show.
 */
export function codeSpans(text: string): Span[] {
  const spans: Span[] = [];
  //      ~~~~ or ``` (but NOT ```feishu-card)  |  ``span``  |  `span`
  const re = /~~~[\s\S]*?~~~|```(?!feishu-card)[\s\S]*?```|``[^`\n]*``|`[^`\n]*`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** Is offset `at` inside one of `spans`? */
function inSpans(spans: Span[], at: number): boolean {
  return spans.some(([a, b]) => at >= a && at < b);
}

/** Replace `![` with `!\u200b[`, so neither the feishu client nor its validator
 * mistakes a code sample for an image reference (see {@link neutraliseRefsInCode}). */
function neutraliseRef(text: string): string {
  return text.replace(/!\[/g, '!\u200b[');
}

/**
 * Keep every CODE region verbatim except for a zero-width space between `!` and
 * `[`. Feishu's card validator rejects the whole update with `200570 card
 * contains invalid image keys` when raw `![alt](path)` survives in the text (the
 * sequence looks like an image node whose key is the path), and the client would
 * render it as a broken image; the ZWSP is invisible to the reader and to both.
 */
export function neutraliseRefsInCode(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const [a, b] of spans) {
    out += text.slice(cursor, a) + neutraliseRef(text.slice(a, b));
    cursor = b;
  }
  return out + text.slice(cursor);
}

/** One piece of a rendered answer: literal text, or a complete image reference. */
export type MdPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; alt: string; src: string; raw: string };

/**
 * Split `text` into text runs and complete image refs, in code-aware order.
 * `live` holds back an UNTERMINATED ref at the very end (`![alt](video` — the
 * model is still writing the path) instead of emitting it as broken syntax:
 * feeding that to the client is what made a streaming card look frozen.
 */
export function splitImageRefs(text: string, live = false): { parts: MdPart[]; held: string } {
  const parts: MdPart[] = [];
  const spans = codeSpans(text);
  const re = imgRe();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (inSpans(spans, m.index)) continue; // code, not an image
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) });
    parts.push({ kind: 'image', alt: m[1] ?? '', src: cleanSrc(m[2] ?? ''), raw: m[0] });
    last = m.index + m[0].length;
  }
  let tail = text.slice(last);
  if (live) {
    const open = unterminatedRefStart(tail);
    if (open >= 0) {
      if (open > 0) parts.push({ kind: 'text', text: tail.slice(0, open) });
      return { parts, held: tail.slice(open) };
    }
  }
  if (tail) parts.push({ kind: 'text', text: tail });
  return { parts, held: '' };
}

/** Index of an incomplete `![…` in `tail` (its closing `)` hasn't arrived yet),
 * or -1. A ref that IS complete would already have been consumed by
 * {@link splitImageRefs}'s scan, so any leftover `![` with no `)` after it is
 * still being written. */
function unterminatedRefStart(tail: string): number {
  const at = tail.lastIndexOf('![');
  if (at < 0) return -1;
  return tail.slice(at).includes(')') ? -1 : at;
}

/** Does `text` carry an inline image ref at all? A substring probe for callers
 * that want to skip the scan entirely on the common (image-free) answer. */
export const hasImageRef = (text: string): boolean => text.includes('![');

/** Every `![](src)` source in `text`, in order, deduped. A ref inside code is
 * literal text — it is NOT a source, so it never triggers an upload. */
export function imageSources(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const spans = codeSpans(text);
  const re = imgRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (inSpans(spans, m.index)) continue;
    const src = cleanSrc(m[2] ?? '');
    if (src && !seen.has(src)) {
      seen.add(src);
      out.push(src);
    }
  }
  return out;
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

/** Inline-code span around `text`, fenced long enough to survive backticks
 * inside the path. */
function codeSpan(text: string): string {
  const fence = text.includes('`') ? '``' : '`';
  return `${fence}${text}${fence}`;
}

/** What a ref that never resolved (out of the project, missing/oversized file,
 * failed upload) looks like on a card: it says what it was and where it pointed
 * as plain text + code — NEVER as `![alt](src)`, which the client parses into a
 * broken image node. */
export function unresolvedRefText(alt: string, src: string): string {
  return `🖼️ ${alt.trim() || '图片'}（未能显示：${codeSpan(src)}）`;
}

/** The label an unresolved ref keeps in a place that cannot carry the full
 * explanation (a table cell): its alt, else the file name. */
export function unresolvedRefLabel(alt: string, src: string): string {
  return alt.trim() || fileName(src);
}

/** The file name of a src, for a label that would otherwise be empty. */
export function fileName(src: string): string {
  const clean = src.split(/[?#]/)[0] ?? src;
  return clean.split('/').filter(Boolean).pop() ?? clean;
}
