/**
 * Minimal builders for Feishu interactive cards (message card v1: config +
 * header + elements). Kept deliberately small and untyped-at-the-edges — the
 * Feishu schema is large; we only emit the handful of element kinds the bridge
 * uses (markdown div, note, hr, action row with buttons + static selects).
 *
 * Action routing convention: every interactive element carries a `value` whose
 * `a` field is the action id the {@link CardDispatcher} routes on. Buttons put
 * their payload alongside `a`; static selects deliver the chosen option in
 * `action.option` (the option's `value`), with `value.a` identifying the select.
 */

export type CardObject = Record<string, unknown>;
export type CardElement = Record<string, unknown>;

export type HeaderTemplate = 'blue' | 'wathet' | 'turquoise' | 'green' | 'grey' | 'red' | 'orange';

/** Routing payload embedded in an interactive element's `value`. */
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
    config: { wide_screen_mode: true, update_multi: true },
    elements,
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

/** A markdown text block (lark_md supports **bold**, `code`, links, emoji). */
export function md(content: string): CardElement {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

/** A grey note line (smaller, muted) — good for metadata. */
export function note(content: string): CardElement {
  return { tag: 'note', elements: [{ tag: 'lark_md', content }] };
}

export function hr(): CardElement {
  return { tag: 'hr' };
}

/** A row of interactive controls (buttons / selects). */
export function actions(items: CardElement[]): CardElement {
  return { tag: 'action', actions: items };
}

export type ButtonType = 'default' | 'primary' | 'danger';

export function button(label: string, value: ActionValue, type: ButtonType = 'default'): CardElement {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value,
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
    value: { a: opts.actionId } satisfies ActionValue,
  };
}
