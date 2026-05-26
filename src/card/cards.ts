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
  opts: { header?: { title: string; template?: HeaderTemplate; subtitle?: string } } = {},
): CardObject {
  const obj: CardObject = {
    schema: '2.0',
    // update_multi must be true for a CardKit entity to be updatable (shared
    // card); streaming_mode stays off — we do full-card updates, not deltas.
    config: { update_multi: true },
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

/** A grey note line (smaller, muted) — good for metadata. */
export function note(content: string): CardElement {
  return { tag: 'note', elements: [{ tag: 'markdown', content }] };
}

export function hr(): CardElement {
  return { tag: 'hr' };
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
