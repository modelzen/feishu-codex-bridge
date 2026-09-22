/**
 * Minimal builders for Feishu interactive cards. We emit **card JSON schema
 * 2.0** (`{schema:'2.0', config, header?, body:{elements}}`) — required because
 * button-driven cards are sent as CardKit entities (cardkit.v1.card.create),
 * and that API only accepts schema 2.0 (v1 → error 200610). Element kinds are
 * kept to the handful the bridge uses (markdown, note, hr, button row, static
 * select).
 *
 * Action routing convention (unchanged across schema versions): every
 * interactive element carries a callback `value` whose `a` field is the action
 * id the {@link CardDispatcher} routes on. In 2.0 the callback value lives in
 * `behaviors:[{type:'callback', value}]`; the SDK surfaces it back as
 * `CardActionEvent.action.value`. Buttons put their payload alongside `a`;
 * static selects deliver the chosen option's `value` in `action.option`.
 */

export type CardObject = Record<string, unknown>;
export type CardElement = Record<string, unknown>;

export type HeaderTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'grey' | 'red' | 'orange';

/** Routing payload embedded in an interactive element's callback `value`. */
export interface ActionValue {
  /** action id the dispatcher routes on */
  a: string;
  [k: string]: unknown;
}

export function card(
  elements: CardElement[],
  opts: {
    header?: {
      title: string;
      template?: HeaderTemplate;
      subtitle?: string;
      /** Status pills on the header's right side (schema 2.0 `text_tag_list`),
       * e.g. a version badge. `color` is a feishu tag color (blue/green/grey/…). */
      textTags?: { text: string; color: string }[];
    };
    /** Live (running) card. Enables streaming_mode so the answer element can be
     * driven by the element-level typewriter (cardkit.v1.cardElement.content). */
    streaming?: boolean;
    /** Mobile push-notification preview text (config.summary.content). */
    summary?: string;
    /** Set false to forbid users forwarding this card (config.enable_forward).
     * Feishu's default is true (forwardable); only opt out for cards whose
     * buttons would be dead/confusing in the forwarded copy. */
    forward?: boolean;
    /** Card width on PC/iPad (config.width_mode). 'default' ≤600px (the implicit
     * default), 'compact' ≤400px, 'fill' = fill the chat window. Set 'fill' for
     * cards with a wide editor (e.g. the multiline prompt box) so it isn't cramped. */
    widthMode?: 'default' | 'compact' | 'fill';
  } = {},
): CardObject {
  const config: Record<string, unknown> = { update_multi: true };
  if (opts.forward === false) config.enable_forward = false;
  if (opts.widthMode) config.width_mode = opts.widthMode;
  if (opts.streaming) {
    // streaming_mode is REQUIRED for element-level streaming (cardElement.content),
    // which the answer text uses for the native typewriter. Per Feishu's docs,
    // streaming_config only governs that element API — NOT whole-card card.update
    // (used here for structure: reasoning/tools). So these values tune just the
    // answer element's typewriter. 'fast' = on each push, instantly flush any
    // un-typed remainder, then continue — so it never trails the model; worst case
    // (a Feishu speed clamp) it degrades to the chunked whole-card cadence, never
    // slower. ~240 chars/sec (step/freq×1000) outpaces token arrival. Both fields
    // MUST be { default: N } objects — bare ints break Feishu's deserialization.
    config.streaming_mode = true;
    config.streaming_config = {
      print_frequency_ms: { default: 25 },
      print_step: { default: 6 },
      print_strategy: 'fast',
    };
  }
  if (opts.summary) config.summary = { content: opts.summary };
  const obj: CardObject = {
    schema: '2.0',
    config,
    body: { elements },
  };
  if (opts.header) {
    obj.header = {
      template: opts.header.template ?? 'blue',
      title: { tag: 'plain_text', content: opts.header.title },
      ...(opts.header.subtitle
        ? { subtitle: { tag: 'plain_text', content: opts.header.subtitle } }
        : {}),
      ...(opts.header.textTags?.length
        ? {
            text_tag_list: opts.header.textTags.map((t) => ({
              tag: 'text_tag',
              text: { tag: 'plain_text', content: t.text },
              color: t.color,
            })),
          }
        : {}),
    };
  }
  return obj;
}

/** A markdown text block (**bold**, `code`, links, emoji). */
export function md(content: string): CardElement {
  return { tag: 'markdown', content };
}

/** A markdown element carrying an `element_id`, so it can be driven by the
 * native typewriter stream (cardkit.v1.cardElement.content) on a streaming card. */
export function mdStream(content: string, elementId: string): CardElement {
  return { tag: 'markdown', element_id: elementId, content };
}

/**
 * An image element (schema 2.0 `img`). Renders an already-uploaded Feishu image
 * by its `img_key` (from `im.v1.image.create`) — markdown `![](…)` syntax never
 * renders in a card, so outbound images must be uploaded first (see
 * {@link ../card/outbound-images}). `alt` is required by the schema (kept as the
 * markdown alt text); `preview:true` lets the user tap to enlarge;
 * `mode:'fit_horizontal'` shows the whole image at card width (no center-crop). */
export function image(imgKey: string, alt = ''): CardElement {
  return {
    tag: 'img',
    img_key: imgKey,
    alt: { tag: 'plain_text', content: alt },
    mode: 'fit_horizontal',
    preview: true,
  };
}

/** A grey note line (smaller, muted) — good for metadata. Schema 2.0 dropped
 * the `note` component; the equivalent is a plain-text block at `notation`
 * size in grey (lark_md so `code`/**bold** still render). */
export function note(content: string): CardElement {
  return { tag: 'div', text: { tag: 'lark_md', content, text_size: 'notation', text_color: 'grey' } };
}

/** One column of a {@link columns} row: an arbitrary element list. */
export interface ColumnSpec {
  elements: CardElement[];
  /** only honoured with `flexMode: 'none'`: `auto` (default) | `weighted` (+weight) */
  width?: string;
  weight?: number;
  verticalAlign?: 'top' | 'center' | 'bottom';
}

/**
 * A generic `column_set` row. Card 2.0 has no `action` container, so anything
 * that needs to sit side by side (a thumbnail strip, a control + caption)
 * builds on this. A column may hold any component except `form`/`table`;
 * `flexMode: 'flow'` wraps instead of squashing on narrow screens — the right
 * choice for a thumbnail strip on mobile.
 */
export function columns(
  items: ColumnSpec[],
  opts: {
    flexMode?: 'none' | 'stretch' | 'flow' | 'bisect' | 'trisect';
    spacing?: string;
    align?: 'left' | 'center' | 'right';
    elementId?: string;
  } = {},
): CardElement {
  return {
    tag: 'column_set',
    ...(opts.elementId ? { element_id: opts.elementId } : {}),
    flex_mode: opts.flexMode ?? 'none',
    horizontal_spacing: opts.spacing ?? 'small',
    ...(opts.align ? { horizontal_align: opts.align } : {}),
    columns: items.map((c) => ({
      tag: 'column',
      width: c.width ?? 'auto',
      ...(c.weight ? { weight: c.weight } : {}),
      ...(c.verticalAlign ? { vertical_align: c.verticalAlign } : {}),
      elements: c.elements,
    })),
  };
}

/**
 * A collapsed image "pill": the title is the markdown image's alt text (what the
 * model already wrote in `![alt](src)`), and tapping it expands the image IN
 * PLACE. `header.width: auto_when_fold` is what makes the collapsed state a small
 * label instead of a full-width bar; the image keeps `preview` so a second tap
 * opens it full-screen.
 *
 * This is the bridge's default presentation for a resolved outbound image: a
 * plain `img` element commits the card to a full-width picture (a 1480×3943
 * contact sheet dominates the reply), while a pill costs one line until the
 * reader asks for it — and unlike a link it needs no upload elsewhere, no
 * sharing scope and no callback.
 */
export function imagePill(opts: {
  /** pre-uploaded image key */
  imgKey: string;
  /** pill title — the markdown alt (caller falls back to the file name) */
  title: string;
  /** hover text on the expanded image (defaults to the title) */
  alt?: string;
  /** start expanded */
  expanded?: boolean;
  elementId?: string;
  /** `link` (default): no border, no chevron, blue title — the header reads as a
   * hyperlink that reveals the image on tap. `pill`: the bordered, grey variant. */
  style?: 'pill' | 'link';
  /** blue tint for {@link style} `'link'` — a feishu colour name (`blue`,
   * `wathet`, `indigo`, …). */
  color?: string;
  /** link style only: keep a small chevron so the row still hints it expands. */
  chevron?: 'none' | 'right';
}): CardElement {
  const link = opts.style !== 'pill'; // link look is the default presentation
  return collapsiblePanelEl({
    title: link ? `<font color='${opts.color ?? 'blue'}'>${opts.title}</font>` : opts.title,
    expanded: opts.expanded ?? false,
    border: link ? 'none' : 'grey',
    headerWidth: 'auto_when_fold',
    padding: '0px',
    spacing: '6px',
    ...(link
      ? opts.chevron === 'right'
        ? { headerIcon: { token: 'down-small-ccm_outlined', color: opts.color ?? 'blue', size: '14px 14px' }, iconPosition: 'right' as const }
        : { headerIcon: false as const }
      : {}),
    ...(opts.elementId ? { elementId: opts.elementId } : {}),
    elements: [image(opts.imgKey, opts.alt ?? opts.title)],
  });
}

/** Cell renderers a `table` column supports (Card 2.0). */
export type TableColumnType = 'text' | 'lark_md' | 'number' | 'options' | 'persons' | 'date' | 'markdown';

export interface TableColumn {
  /** key this column reads from each row object */
  name: string;
  /** header label */
  displayName: string;
  /** how cell values render; default `text`. `lark_md` carries links. */
  type?: TableColumnType;
  /** `auto` | `[80,600]px` | `%` */
  width?: string;
  horizontalAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'center' | 'bottom';
}

/**
 * A `table` component (Card 2.0). Card markdown (the `markdown` element) does
 * NOT render GFM pipe tables, so a report that tables its data has to become
 * this component — see {@link ../card/report-render}.
 *
 * Feishu's rules, enforced here so a caller can't emit a card that 400s:
 * table is body-level only (it can't be nested in a panel), ≤50 columns, ≤5
 * tables per card, and `page_size` ∈ [1,10] (rows beyond it paginate).
 */
export function table(
  columns: TableColumn[],
  rows: Array<Record<string, unknown>>,
  opts: {
    /** Rows per page, [1,10]. Defaults to all rows (capped at 10) so short
     * tables don't get a pointless pager. */
    pageSize?: number;
    /** `low` (default) | `middle` | `high` | `auto` | `[32,124]px` */
    rowHeight?: string;
    /** Keep the first column visible while scrolling a wide table. */
    freezeFirstColumn?: boolean;
    /** Header background: `grey` (default) | `none`. */
    headerBackground?: 'grey' | 'none';
    margin?: string;
  } = {},
): CardElement {
  const cols = columns.slice(0, 50).map((c) => ({
    name: c.name,
    display_name: c.displayName,
    data_type: c.type ?? 'text',
    ...(c.width ? { width: c.width } : {}),
    ...(c.horizontalAlign ? { horizontal_align: c.horizontalAlign } : {}),
    ...(c.verticalAlign ? { vertical_align: c.verticalAlign } : {}),
  }));
  const pageSize = Math.min(Math.max(opts.pageSize ?? rows.length, 1), 10);
  return {
    tag: 'table',
    columns: cols,
    rows,
    page_size: pageSize,
    row_height: opts.rowHeight ?? 'low',
    ...(opts.freezeFirstColumn ? { freeze_first_column: true } : {}),
    header_style: { background_style: opts.headerBackground ?? 'grey', bold: true, lines: 1 },
    ...(opts.margin ? { margin: opts.margin } : {}),
  };
}

/** Named text colors the bridge uses on notation lines (feishu 2.0 palette). */
export type NoteColor = 'grey' | 'green' | 'yellow' | 'orange' | 'red' | 'blue';

/** A {@link note} in a tier color — for the context-usage gauge (green→red) and
 * the auto-compact notice. The colored emoji dot in the content is the reliable
 * signal; `text_color` tints the line on clients that honor it. */
export function colorNote(content: string, color: NoteColor): CardElement {
  return { tag: 'div', text: { tag: 'lark_md', content, text_size: 'notation', text_color: color } };
}

export function hr(): CardElement {
  return { tag: 'hr' };
}

/** A small/muted markdown line (notation size) — for status & terminal notes. */
export function noteMd(content: string): CardElement {
  return { tag: 'markdown', content, text_size: 'notation' };
}

export type PanelBorder = 'grey' | 'red' | 'blue';

/** A collapsible panel (schema 2.0 `collapsible_panel`): a markdown title with
 * a rotating chevron, a bordered body that expands/collapses on tap. Used for
 * reasoning ("思考") and tool-call detail so the card stays compact on mobile. */
export function collapsiblePanel(opts: {
  /** markdown title (e.g. `**思考完成，点击查看**`) */
  title: string;
  expanded: boolean;
  border: PanelBorder;
  /** markdown body shown when expanded */
  body: string;
}): CardElement {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: {
      title: { tag: 'markdown', content: opts.title },
      vertical_align: 'center',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

/**
 * Like {@link collapsiblePanel} but the body is an arbitrary element list
 * instead of one markdown string — so a panel can hold nested panels
 * (`collapsible_panel.elements` is itself a CardElement[]). Used by the resume
 * history card to drill "一层层": a per-turn panel whose body folds again into
 * the turn's reasoning / tool detail.
 */
export function collapsiblePanelEl(opts: {
  title: string;
  expanded: boolean;
  /** Border colour, or `'none'` for a chrome-less panel (a header that reads as
   * a plain/blue text line until it is tapped). */
  border: PanelBorder | 'none';
  elements: CardElement[];
  /** Header width. `fill` (default) spans the card; `auto_when_fold` shrinks the
   * COLLAPSED header to its text — a small pill (「🖼️ 4 张图片 ⌄」) instead of a
   * full-width bar, which is what makes a collapsed image group cheap. */
  headerWidth?: 'fill' | 'auto' | 'auto_when_fold';
  /** Panel padding [0,99]px. */
  padding?: string;
  /** Gap between the panel's children [0,99]px (default 8px). */
  spacing?: string;
  /** Header icon. Defaults to the collapse chevron; pass `false` to drop it
   * (nothing then signals "expandable" except the tap itself — used when the
   * title should read as a link). */
  headerIcon?: { token: string; color?: string; size?: string } | false;
  /** Where the chevron sits; ignored when {@link headerIcon} is false. */
  iconPosition?: 'left' | 'right' | 'follow_text';
  elementId?: string;
}): CardElement {
  const icon = opts.headerIcon === false ? null : (opts.headerIcon ?? { token: 'down-small-ccm_outlined' });
  return {
    tag: 'collapsible_panel',
    ...(opts.elementId ? { element_id: opts.elementId } : {}),
    expanded: opts.expanded,
    header: {
      title: { tag: 'markdown', content: opts.title },
      ...(opts.headerWidth ? { width: opts.headerWidth } : {}),
      vertical_align: 'center',
      ...(icon
        ? {
            icon: {
              tag: 'standard_icon',
              token: icon.token,
              ...(icon.color ? { color: icon.color } : {}),
              size: icon.size ?? '16px 16px',
            },
            icon_position: opts.iconPosition ?? 'follow_text',
            icon_expanded_angle: -180,
          }
        : {}),
    },
    ...(opts.border === 'none' ? {} : { border: { color: opts.border, corner_radius: '5px' } }),
    vertical_spacing: opts.spacing ?? '8px',
    padding: opts.padding ?? '8px 8px 8px 8px',
    elements: opts.elements,
  };
}

/**
 * A row of interactive controls (buttons / selects). Schema 2.0 has no
 * `tag:'action'` container — multiple controls share a row via a flow
 * `column_set`, one control per auto-width column. An optional stable
 * `elementId` makes the row addressable by element-level cardkit APIs
 * (e.g. deleting just the controls off an orphaned run card).
 */
export function actions(items: CardElement[], elementId?: string): CardElement {
  return {
    tag: 'column_set',
    ...(elementId ? { element_id: elementId } : {}),
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: items.map((it) => ({ tag: 'column', width: 'auto', elements: [it] })),
  };
}

/**
 * Like {@link actions} but every control is pinned to the SAME fixed `width`,
 * rendered at the taller `size:'large'`, and the row is left-packed with an 8px
 * gap (`flex_mode:'flow'`) — so buttons form tidy, comfortably tall aligned
 * columns and leave the right side empty instead of stretching to fill the row.
 * Callers pick per-row widths so rows with different button counts still span the
 * same total and share left+right edges (see the menu's MENU_BTN_W_* constants). */
export function actionsFixed(items: CardElement[], width: string, elementId?: string): CardElement {
  return {
    tag: 'column_set',
    ...(elementId ? { element_id: elementId } : {}),
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: items.map((it) => ({ tag: 'column', width: 'auto', elements: [{ ...it, width, size: 'large' }] })),
  };
}

/**
 * A two-column row: a left control at its natural width, and right-hand content
 * filling the rest — both vertically centred. Use for a low-key action with an
 * inline caption beside it (e.g. a small 🌐 网页控制台 button + a grey note
 * explaining it). `flex_mode:'none'` keeps button and caption on one line. */
export function splitRow(left: CardElement, right: CardElement, elementId?: string): CardElement {
  return {
    tag: 'column_set',
    ...(elementId ? { element_id: elementId } : {}),
    flex_mode: 'none',
    horizontal_spacing: 'medium',
    columns: [
      { tag: 'column', width: 'auto', vertical_align: 'center', elements: [left] },
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [right] },
    ],
  };
}

export type ButtonType = 'default' | 'primary' | 'danger';

export function button(label: string, value: ActionValue, type: ButtonType = 'default'): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

/** A button that opens a URL (e.g. an applink) instead of firing a callback.
 * Schema 2.0 buttons take an `open_url` behavior; `default_url` covers all
 * platforms (use the `lark://`/`https://applink.feishu.cn/...` scheme as-is).
 * `size` ('tiny'|'small'|'medium'|'large') tunes the button height. */
export function linkButton(
  label: string,
  url: string,
  type: ButtonType = 'default',
  size?: 'tiny' | 'small' | 'medium' | 'large',
): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    ...(size ? { size } : {}),
    behaviors: [{ type: 'open_url', default_url: url }],
  };
}

/** A text input (schema 2.0 `input` component). `name` keys its value in the
 * form's `form_value` on submit. */
export function input(opts: {
  name: string;
  label?: string;
  placeholder?: string;
  value?: string;
  required?: boolean;
  /** Feishu max input length. Valid range 1–1000 (default 1000); values outside it
   * make Feishu reject the whole card, so callers must stay within [1,1000]. */
  maxLength?: number;
  /** 'text' (single-line, default) | 'multiline_text' (textarea, newlines kept). */
  inputType?: 'text' | 'multiline_text';
  /** multiline_text only: initial visible rows (the box auto-grows as needed). */
  rows?: number;
  /** Box width. 'default' is a fixed narrow width; 'fill' spans the card's max
   * width (pair with the card's widthMode:'fill' for a roomy editor); a number
   * is a custom pixel width (≥100). Omit for Feishu's narrow default. */
  width?: 'default' | 'fill' | number;
}): CardElement {
  return {
    tag: 'input',
    name: opts.name,
    ...(opts.inputType ? { input_type: opts.inputType } : {}),
    ...(opts.rows ? { rows: opts.rows, auto_resize: true } : {}),
    ...(opts.width !== undefined ? { width: opts.width } : {}),
    ...(opts.label ? { label: { tag: 'plain_text', content: opts.label } } : {}),
    ...(opts.placeholder ? { placeholder: { tag: 'plain_text', content: opts.placeholder } } : {}),
    ...(opts.value ? { default_value: opts.value } : {}),
    ...(opts.maxLength ? { max_length: opts.maxLength } : {}),
    required: Boolean(opts.required),
  };
}

/** A form container (schema 2.0). Inputs inside it surface their values in
 * `action.form_value` when a `form_action_type:'submit'` button is clicked. */
export function form(name: string, elements: CardElement[]): CardElement {
  return { tag: 'form', name, elements };
}

/** A button that submits its enclosing form — its click callback carries the
 * collected `form_value`. */
export function submitButton(
  label: string,
  value: ActionValue,
  type: ButtonType = 'primary',
  name = 'submit',
): CardElement {
  return {
    tag: 'button',
    name,
    text: { tag: 'plain_text', content: label },
    type,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value }],
  };
}

export interface SelectOption {
  label: string;
  /** option value returned in CardActionEvent.action.option */
  value: string;
}

export function selectStatic(opts: {
  actionId: string;
  placeholder: string;
  options: SelectOption[];
  /** option value to pre-select */
  initial?: string;
}): CardElement {
  return {
    tag: 'select_static',
    placeholder: { tag: 'plain_text', content: opts.placeholder },
    ...(opts.initial ? { initial_option: opts.initial } : {}),
    options: opts.options.map((o) => ({
      text: { tag: 'plain_text', content: o.label },
      value: o.value,
    })),
    behaviors: [{ type: 'callback', value: { a: opts.actionId } satisfies ActionValue }],
  };
}

/** A person picker (schema 2.0 `select_person`). Used **inside a form**: its
 * selected open_id surfaces in `form_value[name]` when the form's submit button
 * fires (与 input 同款收值方式) — so it never independently triggers a callback
 * and won't lock the card. 单选；值格式（字符串 vs 数组）于回调内运行时确认。 */
export function selectPerson(opts: { name: string; placeholder?: string; required?: boolean }): CardElement {
  return {
    tag: 'select_person',
    name: opts.name,
    ...(opts.placeholder ? { placeholder: { tag: 'plain_text', content: opts.placeholder } } : {}),
    required: Boolean(opts.required),
  };
}

/** A static select for use **inside a form** (value collected via form_value[name]
 * on submit). Unlike {@link selectStatic} it carries no callback behavior — it
 * doesn't fire on its own, so it won't lock the card; the picked option's value
 * comes back only on form submit. Used to pick a group member by open_id. */
export function selectMenu(opts: {
  name: string;
  placeholder: string;
  options: SelectOption[];
  /** option value to pre-select (shows the current value; still read on submit) */
  initial?: string;
}): CardElement {
  return {
    tag: 'select_static',
    name: opts.name,
    placeholder: { tag: 'plain_text', content: opts.placeholder },
    ...(opts.initial ? { initial_option: opts.initial } : {}),
    options: opts.options.map((o) => ({ text: { tag: 'plain_text', content: o.label }, value: o.value })),
  };
}

/** A multi-select dropdown (schema 2.0 `multi_select_static`) for use **inside a
 *  form** — like {@link selectMenu} it carries no callback (won't lock the card);
 *  on submit `form_value[name]` is the **array** of picked option values. Requires
 *  Feishu client ≥ 7.4. Used for AskUserQuestion's `multiSelect: true` questions. */
export function multiSelectMenu(opts: {
  name: string;
  placeholder: string;
  options: SelectOption[];
}): CardElement {
  return {
    tag: 'multi_select_static',
    name: opts.name,
    placeholder: { tag: 'plain_text', content: opts.placeholder },
    options: opts.options.map((o) => ({ text: { tag: 'plain_text', content: o.label }, value: o.value })),
  };
}
