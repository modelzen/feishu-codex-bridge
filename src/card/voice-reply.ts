import { createHash } from 'node:crypto';
import type { VoiceReply } from '../voice/types';
import type { CardElement } from './cards';

/** Native, initially expanded panels; plain text keeps transcript markup inert. */
export function voiceReplyElements(messages: readonly VoiceReply[] = []): CardElement[] {
  const seen = new Set<string>();
  return messages.flatMap((message) => {
    if (seen.has(message.messageId)) return [];
    seen.add(message.messageId);
    const id = createHash('sha256').update(message.messageId).digest('hex').slice(0, 10);
    if (!message.transcribed) return [{
      tag: 'div', element_id: `voice_${id}`,
      text: { tag: 'plain_text', content: message.text, text_size: 'notation', text_color: 'grey' },
    }];
    const chars = Array.from(message.text);
    const panels: CardElement[] = [];
    // Bound each panel below the element byte limit without discarding text.
    for (let offset = 0; offset < chars.length; offset += 6000) {
      const part = offset / 6000;
      panels.push({
        tag: 'collapsible_panel', element_id: `voice_${id}_${part}`, expanded: true,
        header: {
          title: { tag: 'plain_text', content: `语音消息 · ${chars.length} 字${part ? ` · 续 ${part}` : ''}` },
          vertical_align: 'center',
          icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
          icon_position: 'right', icon_expanded_angle: -180,
        },
        border: { color: 'grey-200', corner_radius: '8px' },
        background_color: 'grey-50', padding: '12px', vertical_spacing: '8px',
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: chars.slice(offset, offset + 6000).join('') } }],
      });
    }
    return panels;
  });
}
