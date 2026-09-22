import { columns, hr, imagePill, md, table, type CardElement, type TableColumn } from './cards';
import { cleanSrc, extractCardFences, fileName, imgRe, linkRe, unresolvedRefLabel } from './md-scan';
import { renderRichText } from './markdown-render';

/**
 * Report rendering: markdown → card elements for STRUCTURED answers (headings,
 * tables, lists). Card markdown does not render GFM pipe tables, so a reply that
 * tables its data (a file inventory, a comparison, a parameter表) has to become
 * the native `table` component or it degrades into a wall of `| a | b |` text.
 *
 * Two jobs beyond plain markdown:
 *
 *  1. **Tables** become `table` elements. Feishu caps a card at 5 tables and a
 *     table cannot be nested in a container, so the 6th+ table degrades back to
 *     markdown text rather than 400-ing the whole card.
 *  2. **Images inside a table** are hoisted out. A table cell can hold only text,
 *     so an image written there is unrenderable in place; the cell keeps the
 *     author's words and the picture reappears as a pill at the end of the reply.
 *
 * Link handling is deliberately conservative: a `[text](target)` whose target
 * isn't `http(s)` keeps its TEXT and loses the link. A workspace-relative path
 * renders as a dead link in the feishu client, and the bridge has no way to mint
 * an openable URL for a local file (an earlier `links` option was never wired
 * up by any caller — a resolver is what that feature needs, not a parameter).
 */

export interface ReportOptions {
  /** Uploaded `src → image_key` (see {@link ./outbound-images}). Drives the image
   * pills — including the ones hoisted out of tables, see below. */
  images?: ReadonlyMap<string, string>;
  /** Max `table` elements to emit (Feishu allows 5 per card, default 5). */
  maxTables?: number;
}

/** A file extension we treat as "this link points at an image". Mirrors the
 * upload whitelist in {@link ./outbound-images}. */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|tiff?|bmp|ico)(?:[?#].*)?$/i;

/**
 * Pull the image references OUT of one table cell. Feishu's `table` cannot nest
 * any component (and a markdown cell cannot hold a pill or a clickable link to a
 * local file), so an image written inside a table is unrenderable in place. We
 * keep the cell's readable text and collect the reference, so the caller can
 * show the picture at the END of the reply instead — the author's content
 * survives, only its position is normalised.
 *
 * Both spellings count: an image ref `![alt](a.jpg)` and a plain link to an
 * image file `[a.jpg](a.jpg)` (how a model usually lists files in a table).
 */
function extractCellImages(cell: string, collect: (src: string, title: string) => void): string {
  let out = cell.replace(imgRe(), (_full, alt: string, raw: string) => {
    const src = cleanSrc(raw);
    if (src) collect(src, alt.trim());
    return alt.trim();
  });
  out = out.replace(linkRe(), (full, label: string, raw: string) => {
    const target = cleanSrc(raw);
    if (!IMAGE_EXT.test(target) || /^https?:\/\//i.test(target)) return full;
    collect(target, label.trim());
    return label.trim() || target;
  });
  return out.trim();
}

/** One parsed pipe table. */
interface ParsedTable {
  header: string[];
  rows: string[][];
}

/** `| a | b |` → `['a','b']` (outer pipes optional, `\|` escapes a literal). */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && body[i + 1] === '|') {
      buf += '|';
      i++;
    } else if (ch === '|') {
      out.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf.trim());
  return out;
}

/** A GFM delimiter row: `|---|:--:|`. */
export function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/** Does `text` carry a GFM pipe table (a header row plus a delimiter row)? That
 * is the trigger for the report renderer — the only way a table reaches feishu at
 * all. Shares {@link isDelimiterRow} with the parser, so the "is it a table?"
 * question has one answer. */
export function hasMarkdownTable(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if ((lines[i] ?? '').trim().startsWith('|') && isDelimiterRow(lines[i + 1] ?? '')) return true;
  }
  return false;
}

/** Parse a `| … |` block, or null when it isn't a table (no delimiter row). */
function parseTable(lines: string[]): ParsedTable | null {
  if (lines.length < 2) return null;
  const header = splitRow(lines[0] ?? '');
  if (!isDelimiterRow(lines[1] ?? '')) return null;
  const rows = lines
    .slice(2)
    .map(splitRow)
    .filter((r) => r.some((c) => c !== ''));
  if (rows.length === 0) return null;
  // Normalise ragged rows so a missing trailing cell can't shift columns.
  const width = header.length;
  return { header, rows: rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')) };
}

/**
 * Sanitize a body/heading line: an `http(s)` link and a bare `[text]` survive,
 * any other link target keeps its TEXT and loses the link — a workspace-relative
 * path renders as a dead link in the feishu client and the bridge has no openable
 * URL for a local file.
 *
 * Image refs are deliberately left for {@link renderRichText}: it turns a
 * resolved ref into a real pill and an unresolved one into 「未能显示」 text,
 * whereas replacing them here with bare alt text would drop every picture of a
 * table-bearing answer (the branch this line used to take).
 */
function sanitizeLinks(text: string): string {
  return text.replace(/(?<!!)\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)\s*\)/g, (full, label: string, raw: string) => {
    const target = cleanSrc(raw);
    return /^https?:\/\//i.test(target) ? full : label || target;
  });
}

/**
 * Render a markdown document into card elements: `table` components for pipe
 * tables, sized markdown for headings, markdown for everything else.
 */
export function renderReport(text: string, opts: ReportOptions = {}): CardElement[] {
  const body = extractCardFences(text).stripped;
  const images = opts.images ?? new Map<string, string>();
  const maxTables = Math.min(opts.maxTables ?? 5, 5);
  const out: CardElement[] = [];
  let tables = 0;
  // Images that could not be rendered where the author put them (i.e. inside a
  // table). Rendered as pills at the end, in first-seen order, deduped.
  const hoisted = new Map<string, string>();
  const collect = (src: string, title: string): void => {
    if (!hoisted.has(src)) hoisted.set(src, title);
  };

  // Blocks are runs of non-blank lines; a pipe table is one block.
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') {
      if (cur.length > 0) blocks.push(cur);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) blocks.push(cur);

  for (const block of blocks) {
    const first = block[0] ?? '';
    const isPipe = first.trim().startsWith('|');
    if (isPipe) {
      const parsed = parseTable(block);
      if (parsed && tables < maxTables) {
        tables += 1;
        const columns: TableColumn[] = parsed.header.map((h, i) => ({
          name: `c${i}`,
          displayName: h || ' ',
          type: 'lark_md',
          verticalAlign: 'top',
        }));
        const rows = parsed.rows.map((r) => {
          const row: Record<string, unknown> = {};
          r.forEach((cell, i) => {
            // Cells can't hold pictures: keep the text, hoist the image.
            row[`c${i}`] = sanitizeLinks(extractCellImages(cell, collect));
          });
          return row;
        });
        out.push(table(columns, rows));
        continue;
      }
      // Not a table (or over the 5-table cap): fall through as markdown text so
      // nothing is lost — the reader still sees the pipe rows.
    }
    const heading = first.match(/^(#{1,6})\s+(.*)$/);
    if (heading && block.length === 1) {
      const level = heading[1]!.length;
      const size = level <= 1 ? 'heading-3' : 'heading-4';
      const content = sanitizeLinks(heading[2] ?? '');
      if (content) out.push({ tag: 'markdown', content, text_size: size });
      continue;
    }
    // Body lines keep the normal inline treatment — real image pills in place,
    // 「未能显示」 text for a ref that didn't resolve. Sanitizing them away here
    // would silently drop every picture of a table-bearing answer.
    out.push(...renderRichText(sanitizeLinks(block.join('\n')), images));
  }

  const trimmed = body.trim();
  if (out.length === 0 && trimmed) out.push(...renderRichText(trimmed, images));

  // The hoisted pictures, as the same link-style pills used inline. Only refs we
  // actually uploaded become pills; the rest stay as the text already in place.
  const resolvable = [...hoisted].filter(([src]) => images.has(src));
  if (resolvable.length > 0) {
    out.push(hr());
    out.push(md(`**展开查看 ${resolvable.length} 张图片**`));
    // One pill per line reads as a wall of text; a wrapping flow row puts several
    // per line and folds on a narrow screen. A lone pill stays on its own line.
    const pills = resolvable.map(([src, title]) =>
      imagePill({ imgKey: images.get(src)!, title: title || fileName(src) }),
    );
    out.push(pills.length === 1 ? pills[0]! : columns(pills.map((el) => ({ elements: [el] })), { flexMode: 'flow', spacing: 'medium' }));
  }
  return out;
}
