import type { VoiceHealth } from './types';

const STALE_CHECK_AFTER_MS = 180_000;

export function normalizeHealth(h: VoiceHealth | undefined): VoiceHealth {
  if (!h) return { state: 'unchecked', message: '尚未测试' };
  if (h.state === 'testing' && Date.now() - (h.checkedAt ?? 0) > STALE_CHECK_AFTER_MS) {
    return { state: 'unchecked', message: '上次检测未完成，请重试' };
  }
  if (!h.issue && h.message.includes('99991400')) return { ...h, issue: 'rate_limit', code: '99991400' };
  if (!h.issue && h.message.includes('99991403')) return { ...h, state: 'unavailable', issue: 'quota', code: '99991403' };
  return h;
}
