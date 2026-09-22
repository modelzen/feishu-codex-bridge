import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_TERMINAL_ICON, serializeRuntimeCard } from '../src/card/runtime-card-icons';

function terminalCard() {
  return { body: { elements: [
    { tag: 'standard_icon', token: RUNTIME_TERMINAL_ICON },
    { tag: 'standard_icon', token: 'search_outlined' },
    { tag: 'markdown', content: RUNTIME_TERMINAL_ICON },
  ] } };
}
function client(create = vi.fn().mockResolvedValue({ code: 0, data: { image_key: 'img_terminal' } })) {
  return { im: { v1: { image: { create } } } };
}

describe('runtime terminal icon serialization', () => {
  afterEach(() => vi.useRealTimers());

  it('uploads the embedded PNG once per client and replaces only terminal icon nodes', async () => {
    const bot = client();
    const input = terminalCard();
    const [first, second] = await Promise.all([
      serializeRuntimeCard(input, bot), serializeRuntimeCard(input, bot),
    ]);
    expect(first).toBe(second);
    expect(JSON.parse(first).body.elements).toEqual([
      { tag: 'custom_icon', img_key: 'img_terminal' },
      { tag: 'standard_icon', token: 'search_outlined' },
      { tag: 'markdown', content: RUNTIME_TERMINAL_ICON },
    ]);
    expect(bot.im.v1.image.create).toHaveBeenCalledTimes(1);
    const upload = bot.im.v1.image.create.mock.calls[0]![0];
    expect(upload.data.image_type).toBe('message');
    expect(upload.data.image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(input).toEqual(terminalCard());
    const other = client(vi.fn().mockResolvedValue({ data: { image_key: 'img_other_bot' } }));
    expect(await serializeRuntimeCard(input, other)).toContain('img_other_bot');
    expect(other.im.v1.image.create).toHaveBeenCalledTimes(1);
  });

  it('captures the original frame before awaiting the upload', async () => {
    let finish!: (response: unknown) => void;
    const bot = client(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const input = terminalCard();
    const result = serializeRuntimeCard(input, bot);
    input.body.elements.push({ tag: 'markdown', content: 'later mutation' });
    finish({ data: { image_key: 'img_terminal' } });
    expect(await result).not.toContain('later mutation');
  });

  it('does not upload when the frame needs no terminal icon or the client has no image API', async () => {
    const bot = client();
    expect(await serializeRuntimeCard({ body: { elements: [] } }, bot)).toBe('{"body":{"elements":[]}}');
    expect(bot.im.v1.image.create).not.toHaveBeenCalled();
    for (const partial of [{}, { im: {} }, { im: { v1: {} } }]) {
      expect(await serializeRuntimeCard(terminalCard(), partial)).toBe(JSON.stringify(terminalCard()));
    }
  });

  it.each([
    { code: 999, data: { image_key: 'rejected_key' } },
    { code: 0, data: { image_key: '' } },
    { data: { image_key: 123 } },
    null,
  ])('retains the native fallback on invalid upload response %j', async (response) => {
    const bot = client(vi.fn().mockResolvedValue(response));
    expect(await serializeRuntimeCard(terminalCard(), bot)).toBe(JSON.stringify(terminalCard()));
  });

  it('retains the native fallback after a rejected upload without retrying every frame', async () => {
    const bot = client(vi.fn().mockRejectedValue(new Error('offline')));
    for (let i = 0; i < 2; i++) {
      expect(await serializeRuntimeCard(terminalCard(), bot)).toBe(JSON.stringify(terminalCard()));
    }
    expect(bot.im.v1.image.create).toHaveBeenCalledTimes(1);
  });

  it('retries a failed upload after a cooldown and shares the retry across cards', async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ data: { image_key: 'recovered_key' } });
    const bot = client(create);
    expect(await serializeRuntimeCard(terminalCard(), bot)).not.toContain('recovered_key');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await serializeRuntimeCard(terminalCard(), bot)).not.toContain('recovered_key');
    expect(create).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const cards = await Promise.all([serializeRuntimeCard(terminalCard(), bot), serializeRuntimeCard(terminalCard(), bot)]);
    expect(cards.every(card => card.includes('recovered_key'))).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('bounds a stalled upload to three seconds and keeps the same fallback after late completion', async () => {
    vi.useFakeTimers();
    let finish!: (response: unknown) => void;
    const bot = client(vi.fn(() => new Promise(resolve => { finish = resolve; })));
    const pending = serializeRuntimeCard(terminalCard(), bot);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBe(JSON.stringify(terminalCard()));
    finish({ data: { image_key: 'late_key' } });
    expect(await serializeRuntimeCard(terminalCard(), bot)).toBe(JSON.stringify(terminalCard()));
    expect(bot.im.v1.image.create).toHaveBeenCalledTimes(1);
  });
});
