import { describe, expect, it, vi } from 'vitest';
import { resolveRuntimeInboundMessageText } from '../src/runtime/feishu-inbound';

describe('public Runtime inbound-message text recovery', () => {
  it('recovers an interactive card body through raw_card_content', async () => {
    const get = vi.fn(async () => ({
      data: {
        items: [{
          body: {
            content: JSON.stringify({
              json_card: JSON.stringify({
                body: { property: { elements: [{ property: { content: '真实卡片正文' } }] } },
              }),
            }),
          },
        }],
      },
    }));
    const channel = { rawClient: { im: { v1: { message: { get } } } } };

    await expect(resolveRuntimeInboundMessageText(channel as never, {
      messageId: 'om_card', content: '[interactive card]', rawContentType: 'interactive',
    })).resolves.toBe('真实卡片正文');
    expect(get).toHaveBeenCalledWith({
      path: { message_id: 'om_card' },
      params: { card_msg_content_type: 'raw_card_content' },
    });
  });

  it('does not fetch ordinary text messages', async () => {
    const get = vi.fn();
    const channel = { rawClient: { im: { v1: { message: { get } } } } };
    await expect(resolveRuntimeInboundMessageText(channel as never, {
      messageId: 'om_text', content: '普通正文', rawContentType: 'text',
    })).resolves.toBe('普通正文');
    expect(get).not.toHaveBeenCalled();
  });
});
