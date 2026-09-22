import { readFile, stat } from 'node:fs/promises';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { collectInboundFiles } from '../bot/media';
import { MAX_VOICE_BYTES } from './constants';
import type { VoiceReply, VoiceService } from './types';

/** Presentation metadata is carried beside the agent input, never in its prompt. */
export interface IngestedContext {
  text: string;
  voice?: VoiceReply;
}

export async function ingestVoice(
  channel: LarkChannel,
  msg: NormalizedMessage,
  voice: Pick<VoiceService, 'transcribe'>,
): Promise<IngestedContext> {
  const unavailable = (text: string, notice: string): IngestedContext => ({
    text,
    voice: { messageId: msg.messageId, text: notice, transcribed: false },
  });
  const ref = msg.resources?.find((r) => r.type === 'audio');
  if (!ref) {
    return unavailable('语音消息未能读取：未获取到音频资源，请重新发送或改发文字。', '语音未能读取，请重新发送或改发文字。');
  }
  const files = await collectInboundFiles(channel, { ...msg, resources: [{ ...ref, type: 'file', fileName: 'voice.ogg' }] });
  const file = files[0];
  if (!file) return unavailable('语音消息未能下载，请告知用户重新发送或改发文字。', '语音未能下载，请重新发送或改发文字。');
  let reason: string;
  try {
    if ((await stat(file.path)).size > MAX_VOICE_BYTES) {
      reason = '语音超过 20 MB 识别上限';
    } else {
      const result = await voice.transcribe(await readFile(file.path), ref.durationMs);
      if ('text' in result) {
        if (!result.text.trim()) {
          return unavailable(
            '语音消息未识别出有效文字（可能是静音或声音不清楚）。请告诉用户重发或改发文字，不要猜测语音内容。',
            '语音未识别出有效文字，请重新发送或改发文字。',
          );
        }
        return { text: result.text, voice: { messageId: msg.messageId, text: result.text, transcribed: true } };
      }
      reason = result.reason;
    }
  } catch {
    reason = '音频处理失败';
  }
  return unavailable(
    `语音消息（未转写）：${reason}\n原音频附件：${JSON.stringify(file.path)}\n如果无法读取音频内容，请明确告诉用户改发文字，不要猜测。`,
    '语音未转写，已将原音频交给 agent。',
  );
}

/** Order asynchronous intake within a session without blocking sibling topics or card actions. */
export function createIntakeQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key);
    const job = previous ? previous.then(work) : work();
    const tail = job.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return job;
  };
}
