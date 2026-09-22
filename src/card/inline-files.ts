import { columns, md, type CardElement } from './cards';
import { renderRichText } from './markdown-render';
import { hasMarkdownTable, renderReport } from './report-render';

/** Tokens exist only between preparation and rendering; no local path is put
 * into callback data. Each occurrence has its own CardKit element, while all
 * aliases of a file share the same delivery record. */
export interface InlineFiles {
  text: string;
  links: Array<{ token: string; element: CardElement }>;
}

export function renderFileAnswer(files: InlineFiles, images?: ReadonlyMap<string, string>): CardElement[] {
  const rendered = hasMarkdownTable(files.text) ? renderReport(files.text, { images }) : renderRichText(files.text, images);
  return placeInlineFiles(rendered, files);
}

/** Count nested containers too: a table converted to a grid can be much larger
 * than its native paginated equivalent. Leave room for process and controls. */
export function fileComponentCount(elements: CardElement[]): number {
  return elements.reduce((total, element) => total + (element.tag === 'collapsible_panel' ? 3 : 1)
    + (Array.isArray(element.elements) ? fileComponentCount(element.elements as CardElement[]) : 0)
    + (Array.isArray(element.columns) && element.tag !== 'table' ? fileComponentCount(element.columns as CardElement[]) : 0), 0);
}

/** Markdown has no inline callbacks. Replace only lines containing file
 * tokens with wrapping rows of text and borderless interactive text. All other
 * elements retain the existing renderer, including images and ordinary tables. */
export function placeInlineFiles(elements: CardElement[], files: InlineFiles): CardElement[] {
  if (!files.links.length) return elements;
  const links = new Map(files.links.map(({ token, element }) => [token, element]));
  const tokens = [...links.keys()];
  const tokenPattern = new RegExp(`(${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  const hasToken = (text: string): boolean => tokens.some((token) => text.includes(token));
  const renderText = (element: CardElement): CardElement[] => {
    const text = String(element.content ?? '');
    if (!hasToken(text)) return [element];
    const result: CardElement[] = [];
    let buffered: string[] = [];
    const flush = (): void => {
      if (buffered.some((line) => line.trim())) result.push({ ...element, content: buffered.join('\n') });
      buffered = [];
    };
    for (const line of text.split('\n')) {
      if (!hasToken(line)) { buffered.push(line); continue; }
      flush();
      const pieces: CardElement[] = [];
      let rest = line;
      // Preserve list numbering when a markdown list is split into components.
      rest = rest.replace(/^(\s*)[-+*]\s+/, '$1• ')
        .replace(/^(\s*\d+)[.)]\s+/, '$1\\. ');
      const heading = /^(#{1,6})\s+/.exec(rest);
      if (heading) rest = rest.slice(heading[0].length);
      const textSize = heading ? (heading[1]!.length === 1 ? 'heading-3' : 'heading-4') : element.text_size;
      let bold = false;
      const pushText = (content: string): void => {
        // A file may sit inside **bold prose**. Close/reopen emphasis around
        // component boundaries so standalone ** markers never become visible.
        const prefix = bold ? '**' : '';
        if ((content.match(/(?<!\\)\*\*/g)?.length ?? 0) % 2) bold = !bold;
        const balanced = (prefix + content + (bold ? '**' : ''))
          .replace(/^(\*\*)(\s+)/, '$2$1').replace(/(\s+)(\*\*)$/, '$2$1');
        if (balanced.replace(/\*\*/g, '').trim() || (content.length > 0 && /^\s+$/.test(content))) {
          const spaced = balanced.replace(/^ +| +$/g, (spaces) => '&nbsp;'.repeat(spaces.length));
          pieces.push({ ...element, content: spaced, ...(textSize ? { text_size: textSize } : {}) });
        }
      };
      for (const part of rest.split(tokenPattern)) {
        const link = links.get(part);
        if (link) pieces.push(link);
        else pushText(part);
      }
      result.push(pieces.length === 1 ? pieces[0]! : columns(
        pieces.map((el) => ({ elements: [el], verticalAlign: 'center' })),
        { flexMode: 'flow', spacing: '0px' },
      ));
    }
    flush();
    return result;
  };
  const visit = (element: CardElement): CardElement[] => {
    if (element.tag === 'markdown') return renderText(element);
    if (element.tag === 'table' && hasToken(JSON.stringify(element))) {
      // Native table cells cannot contain callbacks. Keep the same row/column
      // order in a column grid at the original position instead of hoisting files.
      const cols = element.columns as Array<{ name: string; display_name: string }>;
      const rows = element.rows as Array<Record<string, unknown>>;
      return [cols.map((c) => c.display_name), ...rows.map((r) => cols.map((c) => String(r[c.name] ?? '')))]
        .map((cells, row) => columns(cells.map((cell) => ({
          width: 'weighted', weight: 1, verticalAlign: 'top',
          elements: renderText(md(row === 0 && !hasToken(cell) ? `**${cell}**` : cell)),
        })), { spacing: 'small' }));
    }
    const out = { ...element };
    if (Array.isArray(out.elements)) out.elements = (out.elements as CardElement[]).flatMap(visit);
    if (Array.isArray(out.columns)) out.columns = (out.columns as CardElement[]).flatMap(visit);
    return [out];
  };
  return elements.flatMap(visit);
}
