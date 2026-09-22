import type { CardElement } from './cards';

export function processPanel(
  title: string,
  elements: readonly CardElement[],
  expanded: boolean,
  options: { readonly icon?: string; readonly bodyIndent?: number; readonly spacing?: number; } = {},
): CardElement {
  return {
    tag: 'collapsible_panel',
    expanded,
    header: {
      title: {
        tag: 'markdown', content: `<font color='grey'>${title}</font>`, text_size: 'normal',
        ...(options.icon === undefined ? {} : { icon: { tag: 'standard_icon', token: options.icon, color: 'grey' } }),
      },
      vertical_align: 'center',
      padding: '0px',
      icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    vertical_spacing: `${String(options.spacing ?? 16)}px`,
    padding: '0px',
    elements: elements.map(element => ({ ...element, margin: `0px 0px 0px ${String(options.bodyIndent ?? 0)}px` })),
  };
}
