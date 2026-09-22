import { opusToPcm } from './audio';

// Built-in synthetic speech: 语音识别测试. Encoded as Ogg Opus once at development time.
// Runtime has no OS speech/ffmpeg dependency; no user recording is used for probes.
export function probeAudio(): Buffer {
  return Buffer.from(
    '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',
    'base64',
  );
}

export function probePcm(): Promise<Buffer> { return opusToPcm(probeAudio()); }
