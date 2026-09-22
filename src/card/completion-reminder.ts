import type { CompletionReminderOutcome } from '../config/schema';

/** Payload inputs for the extra Feishu reply emitted after a run card settles. */
export interface CompletionReminderPost {
  requesterOpenId: string;
  outcome: Extract<CompletionReminderOutcome, 'done' | 'error' | 'idle_timeout'>;
  elapsedMs: number;
  /** Short, user-authored task summary. Empty/whitespace falls back to “本轮任务”. */
  summary?: string;
  /** False when the terminal CardKit update exhausted its retries. */
  cardUpdated: boolean;
}

/** Human-readable wall-clock duration, rounded down to whole seconds. */
export function formatCompletionElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

/**
 * Build a native Feishu `post` body. The requester is a structured `at` node,
 * not markdown text, so this extra reply enters Feishu's real mention/message
 * notification path. The returned value is ready for `im.v1.message.reply`'s
 * `content` field.
 */
export function buildCompletionReminderContent(input: CompletionReminderPost): string {
  const task = compactSummary(input.summary);
  const elapsed = formatCompletionElapsed(input.elapsedMs);
  const headline =
    input.outcome === 'done'
      ? ` ✅「${task}」已完成 · 用时 ${elapsed}`
      : input.outcome === 'idle_timeout'
        ? ` ⏱「${task}」响应超时 · 等待 ${elapsed}`
        : ` ⚠️「${task}」执行失败 · 用时 ${elapsed}`;
  const detail = input.cardUpdated
    ? input.outcome === 'done'
      ? '结果在上方卡片。'
      : '详情在上方卡片。'
    : '最终卡片更新失败，请查看上方流式内容或重新发起任务。';

  return JSON.stringify({
    zh_cn: {
      title: '',
      content: [
        [
          { tag: 'at', user_id: input.requesterOpenId },
          { tag: 'text', text: headline },
        ],
        [{ tag: 'text', text: detail }],
      ],
    },
  });
}

function compactSummary(summary?: string): string {
  const clean = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '本轮任务';
  return clean.length > 32 ? `${clean.slice(0, 31)}…` : clean;
}
