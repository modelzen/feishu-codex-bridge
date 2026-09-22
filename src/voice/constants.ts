/** Shared Feishu ASR limits for download, decoding and request validation. */
export const ASR_SCOPE = 'speech_to_text:speech';
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 60;
export const MAX_VOICE_DURATION_MS = MAX_VOICE_SECONDS * 1000;
export const PCM_SAMPLE_RATE = 16_000;
export const PCM_BYTES_PER_SAMPLE = 2;
export const MAX_PCM_SAMPLES = MAX_VOICE_SECONDS * PCM_SAMPLE_RATE;
export const MAX_PCM_BYTES = MAX_PCM_SAMPLES * PCM_BYTES_PER_SAMPLE;
export const DEFAULT_RETRY_DELAY_MS = 60_000;
