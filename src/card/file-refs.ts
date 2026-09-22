import { codeSpans, linkRe, cleanSrc, type Span } from './md-scan';

export interface LocalFileRef {
  src: string;
  label: string;
  start: number;
  end: number;
  fallback: string;
}

const inside = (spans: Span[], at: number): boolean => spans.some(([a, b]) => at >= a && at < b);
const local = (src: string): boolean => !!src && !src.startsWith('#') &&
  (!/^[a-z][\w+.-]*:/i.test(src) || /^file:\/\//i.test(src) || /^[a-z]:[\\/]/i.test(src));

/** Discover explicit file references before table/link rendering can discard paths.
 * Fenced examples and image refs are not attachments. Inline-code paths ARE a
 * common agent output convention, but commands and arbitrary prose aren't. */
export function scanLocalFiles(text: string): LocalFileRef[] {
  // Standalone fence cards have a different callback origin; only references
  // rendered in the main answer can use its file delivery handler.
  const fences: Span[] = [...text.matchAll(/```feishu-card[^\n]*\n[\s\S]*?```/g)]
    .map((m) => [m.index, m.index + m[0].length]);
  const spans = [...codeSpans(text), ...fences];
  const occupied: Span[] = [...spans];
  const refs: LocalFileRef[] = [];
  const add = (src: string, label: string, start: number, end: number, fallback = text.slice(start, end)): void => {
    if (!local(src)) return;
    refs.push({ src, label: label || src, start, end, fallback });
  };
  const literal = (label: string): string => `\`${label.replace(/`/g, '')}\``;
  const citation = /:{1,2}codex-file-citation\{([^}\n]+)\}/g;
  for (const m of text.matchAll(citation)) {
    if (inside(spans, m.index!)) continue;
    const src = /\bpath="([^"]+)"/.exec(m[1]!)?.[1];
    if (!src || !local(src)) continue;
    add(src, src, m.index!, m.index! + m[0].length, literal(src));
    occupied.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(linkRe())) {
    if (inside(occupied, m.index!)) continue;
    occupied.push([m.index!, m.index! + m[0].length]);
    if (text[m.index! - 1] === '!') continue;
    const src = cleanSrc(m[2]!);
    if (!local(src)) continue;
    add(src, m[1]!, m.index!, m.index! + m[0].length, literal(m[1] || src));
  }
  for (const [a, b] of spans) {
    if (inside(fences, a)) continue;
    const code = text.slice(a, b);
    if (/^(```|~~~)/.test(code)) continue;
    const src = code.replace(/^`+|`+$/g, '').trim();
    // Backticks already delimit the whole reference; spaces are legal in a
    // relative filename just as they are in an absolute path. Exclude shell /
    // Markdown operators rather than treating every space as a delimiter.
    if (/^(?:\/|\.\.?\/|~\/|[a-z]:[\\/]|file:\/\/)/i.test(src) || /^[^<>`|?*\n\r]+\.[\w-]+$/.test(src)) {
      add(src, src, a, b);
    }
  }
  // Bare absolute paths: require a word boundary so URLs and embedded commands
  // do not accidentally turn into filesystem reads. Paths with spaces should
  // use Markdown links, inline code, or the structured citation form.
  const bare = /(?:^|[\s（(：:])((?:\/(?!\/)|~\/|[a-z]:[\\/])[^\s<>`"'，。；！？）)\]}]+)/gim;
  for (const m of text.matchAll(bare)) {
    const start = m.index! + m[0].length - m[1]!.length;
    if (inside(occupied, start)) continue;
    const src = m[1]!.replace(/[.,;!?]+$/, '');
    add(src, src, start, start + src.length);
  }
  return refs.sort((a, b) => a.start - b.start);
}
