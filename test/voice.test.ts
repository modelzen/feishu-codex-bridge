import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { decodeVoice, messageHasVoice, recognizeVoicePcm, transcribeVoice } from '../src/bot/voice';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';

const message = (extra: object = {}) => ({ messageId: 'voice-1', rawContentType: 'audio',
  resources: [{ type: 'audio', fileKey: 'file-1', durationMs: 100 }], ...extra }) as NormalizedMessage;
function wav() {
  const data = Buffer.alloc(3200);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function channel() {
  const recognize = vi.fn(async () => ({ code: 0, data: { recognition_text: '  请检查今天的报表  ' } }));
  const download = vi.fn(async () => ({ getReadableStream: () => Readable.from([wav()]) }));
  return { recognize, download, client: { rawClient: {
    speech_to_text: { v1: { speech: { fileRecognize: recognize } } },
    im: { v1: { messageResource: { get: download } } },
  } } as any };
}

describe('Feishu voice ASR', () => {
  it('recognizes only audio messages/resources', () => {
    expect(messageHasVoice(message())).toBe(true);
    expect(messageHasVoice(message({ rawContentType: 'text', resources: [] }))).toBe(false);
  });
  it('downloads as a message file, decodes and prefixes the transcript', async () => {
    const c = channel();
    expect(await transcribeVoice(c.client, message())).toBe('语音消息：请检查今天的报表');
    expect(c.download).toHaveBeenCalledWith({ path: { message_id: 'voice-1', file_key: 'file-1' }, params: { type: 'file' } });
    expect((c.recognize.mock.calls as any)[0][0].data.config.file_id).toMatch(/^[a-zA-Z0-9_]{16}$/);
    expect(c.recognize.mock.calls[0]).toMatchObject([{ data: { config: { format: 'pcm', engine_type: '16k_auto' }, speech: { speech: Buffer.alloc(3200).toString('base64') } } }]);
  });
  it('splits longer audio below the 60-second ASR limit, in order', async () => {
    const c = channel();
    c.recognize.mockResolvedValueOnce({ code: 0, data: { recognition_text: '第一段' } });
    c.recognize.mockResolvedValueOnce({ code: 0, data: { recognition_text: '第二段' } });
    expect(await recognizeVoicePcm(c.client, Buffer.alloc(60 * 32000), new AbortController().signal)).toBe('语音消息：第一段\n第二段');
    expect(c.recognize).toHaveBeenCalledTimes(2);
  });
  it('never submits partial text when a later ASR chunk fails', async () => {
    const c = channel();
    c.recognize.mockResolvedValueOnce({ code: 0, data: { recognition_text: '第一段' } });
    c.recognize.mockResolvedValueOnce({ code: 99991672, data: { recognition_text: '' } });
    await expect(recognizeVoicePcm(c.client, Buffer.alloc(60 * 32000), new AbortController().signal)).rejects.toThrow('99991672');
  });
  it('rejects silence instead of manufacturing a user instruction', async () => {
    const c = channel(); c.recognize.mockResolvedValue({ code: 0, data: { recognition_text: ' ' } });
    await expect(transcribeVoice(c.client, message())).rejects.toThrow('未识别到文字');
  });
  it('rejects missing resources and excessive duration before downloading', async () => {
    const c = channel();
    await expect(transcribeVoice(c.client, message({ resources: [] }))).rejects.toThrow('资源标识');
    await expect(transcribeVoice(c.client, message({ resources: [{ type: 'audio', fileKey: 'f', durationMs: 300001 }] }))).rejects.toThrow('5 分钟');
    expect(c.download).not.toHaveBeenCalled();
  });
  it('rejects invalid audio without calling ASR', async () => {
    await expect(decodeVoice(Buffer.from('not audio'), new AbortController().signal)).rejects.toThrow('无法解码');
  });
  it('cancels an in-flight request and never submits its late result', async () => {
    const c = channel(); const abort = new AbortController();
    c.recognize.mockImplementation(() => new Promise(() => {}));
    const result = recognizeVoicePcm(c.client, Buffer.alloc(320), abort.signal);
    abort.abort();
    await expect(result).rejects.toThrow('取消');
  });
  it('does not expose SDK request details in failures', async () => {
    const c = channel(); c.download.mockRejectedValue(new Error('Authorization: secret-test'));
    await expect(transcribeVoice(c.client, message())).rejects.toThrow('语音下载或飞书转写失败');
  });
});
