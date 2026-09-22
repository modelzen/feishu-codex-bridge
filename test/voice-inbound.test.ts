import { describe, expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ files: vi.fn(), read: vi.fn(), stat: vi.fn() }));
vi.mock('../src/bot/media', () => ({ collectInboundFiles: mocks.files }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.read, stat: mocks.stat }));
import { ingestVoice } from '../src/voice/inbound';
const msg = { rawContentType: 'audio', messageId: 'message', resources: [{ type: 'audio', fileKey: 'file', durationMs: 7000 }] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.files.mockResolvedValue([{ path: '/audio/voice.ogg', name: 'voice.ogg' }]);
  mocks.stat.mockResolvedValue({ size: 100 }); mocks.read.mockResolvedValue(Buffer.from('voice'));
});
describe('voice message delivery', () => {
  it('keeps agent input unchanged and carries transcript display separately', async () => {
    const transcribe = vi.fn(async () => ({ text: '第一行\n第二行', provider: 'feishu' }));
    const text = await ingestVoice({} as never, msg as never, { transcribe } as never);
    expect(text).toEqual({ text: '第一行\n第二行', voice: { messageId: 'message', text: '第一行\n第二行', transcribed: true } });
    expect(transcribe).toHaveBeenCalledWith(Buffer.from('voice'), 7000);
    expect(mocks.files.mock.calls[0]![1].resources[0]).toMatchObject({ fileKey: 'file', type: 'file' });
  });
  it('preserves the original attachment and explicit failure when recognition is unavailable', async () => {
    const text = await ingestVoice({} as never, msg as never, { transcribe: async () => ({ reason: '未配置服务' }) } as never);
    expect(text.text).toContain('未转写'); expect(text.text).toContain('/audio/voice.ogg'); expect(text.text).toContain('不要猜测');
  });
  it('reports failed downloads without calling ASR', async () => {
    mocks.files.mockResolvedValue([]); const transcribe = vi.fn();
    expect((await ingestVoice({} as never, msg as never, { transcribe } as never)).text).toContain('未能下载');
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('does not read oversized attachments into memory', async () => {
    mocks.stat.mockResolvedValue({ size: 21 * 1024 * 1024 }); const transcribe = vi.fn();
    expect((await ingestVoice({} as never, msg as never, { transcribe } as never)).text).toContain('20 MB');
    expect(mocks.read).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled();
  });
});
