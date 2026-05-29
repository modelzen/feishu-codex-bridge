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
    header?: { title: string; template?: HeaderTemplate; subtitle?: string };
    /** Enable native typewriter streaming. With a streaming card, whole-card
     * updates (cardkit.v1.card.update) animate markdown deltas between pushes. */
    streaming?: boolean;
    /** Mobile push-notification preview text (config.summary.content). */
    summary?: string;
  } = {},
): CardObject {
  const config: Record<string, unknown> = { update_multi: true };
  if (opts.streaming) {
    config.streaming_mode = true;
    config.streaming_config = {
      print_frequency_ms: { default: 70 },
      print_step: { default: 1 },
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

/** A grey note line (smaller, muted) — good for metadata. Schema 2.0 dropped
 * the `note` component; the equivalent is a plain-text block at `notation`
 * size in grey (lark_md so `code`/**bold** still render). */
export function note(content: string): CardElement {
  return { tag: 'div', text: { tag: 'lark_md', content, text_size: 'notation', text_color: 'grey' } };
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
  border: PanelBorder;
  elements: CardElement[];
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
    elements: opts.elements,
  };
}

/**
 * A row of interactive controls (buttons / selects). Schema 2.0 has no
 * `tag:'action'` container — multiple controls share a row via a flow
 * `column_set`, one control per auto-width column.
 */
export function actions(items: CardElement[]): CardElement {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: items.map((it) => ({ tag: 'column', width: 'auto', elements: [it] })),
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
 * platforms (use the `lark://`/`https://applink.feishu.cn/...` scheme as-is). */
export function linkButton(label: string, url: string, type: ButtonType = 'default'): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
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
}): CardElement {
  return {
    tag: 'input',
    name: opts.name,
    ...(opts.label ? { label: { tag: 'plain_text', content: opts.label } } : {}),
    ...(opts.placeholder ? { placeholder: { tag: 'plain_text', content: opts.placeholder } } : {}),
    ...(opts.value ? { default_value: opts.value } : {}),
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
