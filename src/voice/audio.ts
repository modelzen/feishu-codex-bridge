import { OggOpusDecoder } from 'ogg-opus-decoder';
import { MAX_PCM_SAMPLES, MAX_VOICE_BYTES, PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from './constants';
import { VoiceFailure } from './types';

export { MAX_VOICE_BYTES } from './constants';

const DECODE_CHUNK_BYTES = 4096;

/** Decode incrementally: stop at Feishu's 60 second limit, even with false metadata.
 * WASM libopus emits 16k samples directly; no executable, PATH or platform binary. */
export async function opusToPcm(audio: Uint8Array): Promise<Buffer> {
  if (audio.length > MAX_VOICE_BYTES || Buffer.from(audio.subarray(0, 4)).toString() !== 'OggS') {
    throw new VoiceFailure('飞书识别需要 Ogg Opus 语音，当前音频无法转换', 'audio');
  }
  // Upstream runtime supports sampleRate; its declaration omits that option.
  const options = { sampleRate: PCM_SAMPLE_RATE, forceStereo: false };
  const decoder = new OggOpusDecoder(options);
  const parts: Buffer[] = [];
  let samples = 0;
  try {
    await decoder.ready;
    const append = (out: Awaited<ReturnType<typeof decoder.decode>>) => {
      if (out.errors.length) throw new VoiceFailure('语音文件损坏，无法完整解码', 'audio');
      samples += out.samplesDecoded;
      if (samples > MAX_PCM_SAMPLES) throw new VoiceFailure('语音超过飞书接口的 60 秒限制', 'audio');
      const pcm = Buffer.alloc(out.samplesDecoded * PCM_BYTES_PER_SAMPLE);
      for (let i = 0; i < out.samplesDecoded; i++) {
        let value = 0;
        for (const ch of out.channelData) value += ch[i] ?? 0;
        value = Math.max(-1, Math.min(1, value / out.channelData.length));
        pcm.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), i * PCM_BYTES_PER_SAMPLE);
      }
      parts.push(pcm);
    };
    for (let i = 0; i < audio.length; i += DECODE_CHUNK_BYTES) {
      append(await decoder.decode(audio.subarray(i, i + DECODE_CHUNK_BYTES)));
    }
    append(await decoder.flush());
    if (!samples) throw new VoiceFailure('语音中没有可解码的音频', 'audio');
    return Buffer.concat(parts);
  } catch (err) {
    if (err instanceof VoiceFailure) throw err;
    throw new VoiceFailure('语音格式无法解码', 'audio');
  } finally {
    decoder.free();
  }
}
