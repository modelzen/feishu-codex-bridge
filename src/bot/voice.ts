import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';

const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const MAX_PCM_BYTES = 300 * PCM_BYTES_PER_SECOND;
const CHUNK_BYTES = 55 * PCM_BYTES_PER_SECOND;

export function messageHasVoice(msg: NormalizedMessage): boolean {
  return msg.rawContentType === 'audio' || (msg.resources ?? []).some(r => r.type === 'audio');
}

/** No raw SDK/network errors in user-facing messages: they may contain request headers. */
export class VoiceError extends Error {}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new VoiceError('语音转写已取消或超时'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new VoiceError('语音转写已取消或超时'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Decode Feishu's audio container to ASR's 16 kHz mono signed 16-bit PCM.
 * Pipes only: no user-controlled paths, shell, network protocols or persisted audio. */
export function decodeVoice(audio: Buffer, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe',
      '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: VoiceError | undefined;
    const abort = () => { failure = new VoiceError('语音转写已取消或超时'); child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PCM_BYTES) { failure = new VoiceError('语音超过 5 分钟，请分段发送'); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', () => { signal.removeEventListener('abort', abort); reject(new VoiceError('无法启动 ffmpeg，请管理员检查安装')); });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || size === 0) reject(new VoiceError('无法解码语音，请重发或改发文字'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(audio);
  });
}

/** The file ASR API supports <=60s per request. Longer voice messages are
 * submitted in ordered 55s PCM chunks; a failed chunk rejects the whole message. */
export async function recognizeVoicePcm(channel: LarkChannel, pcm: Buffer, signal: AbortSignal): Promise<string> {
  if (!pcm.length || pcm.length > MAX_PCM_BYTES) throw new VoiceError('语音为空或超过 5 分钟');
  const texts: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    signal.throwIfAborted();
    const result = await abortable(channel.rawClient.speech_to_text.v1.speech.fileRecognize({ data: {
      speech: { speech: pcm.subarray(offset, offset + CHUNK_BYTES).toString('base64') },
      // Feishu requires a 16-character alphanumeric/underscore file identifier.
      config: { file_id: randomBytes(8).toString('hex'), format: 'pcm', engine_type: '16k_auto' },
    } }), signal);
    if (result.code !== 0) throw new VoiceError(`飞书语音识别失败（错误码 ${Number(result.code) || '未知'}），请检查应用语音识别权限或稍后重试`);
    const text = result.data?.recognition_text?.trim();
    if (text) texts.push(text);
  }
  if (!texts.length) throw new VoiceError('未识别到文字，请重发或改发文字');
  return `语音消息：${texts.join('\n')}`;
}

export async function transcribeVoice(channel: LarkChannel, msg: NormalizedMessage, parent?: AbortSignal): Promise<string> {
  const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  const ref = msg.resources?.find(r => r.type === 'audio');
  if (!ref?.fileKey) throw new VoiceError('语音缺少资源标识，请重发');
  if (ref.durationMs && ref.durationMs > 300_000) throw new VoiceError('语音超过 5 分钟，请分段发送');
  try {
    const response = await abortable(channel.rawClient.im.v1.messageResource.get({
      path: { message_id: msg.messageId, file_key: ref.fileKey }, params: { type: 'file' },
    }).then(response => {
      if (signal.aborted) { response.getReadableStream().destroy(); throw new VoiceError('语音下载已取消或超时'); }
      return response;
    }), signal);
    const stream = response.getReadableStream();
    const abort = () => stream.destroy(new VoiceError('语音下载已取消或超时'));
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      signal.throwIfAborted();
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_DOWNLOAD_BYTES) throw new VoiceError('语音文件超过 16 MB，请分段发送');
        chunks.push(bytes);
      }
    } finally {
      signal.removeEventListener('abort', abort);
      stream.destroy();
    }
    const pcm = await decodeVoice(Buffer.concat(chunks), signal);
    return await recognizeVoicePcm(channel, pcm, signal);
  } catch (error) {
    if (error instanceof VoiceError) throw error;
    if (signal.aborted) throw new VoiceError('语音转写已取消或超时');
    throw new VoiceError('语音下载或飞书转写失败，请检查资源访问权限、语音识别权限或稍后重试');
  }
}
