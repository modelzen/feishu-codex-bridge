import { UnsentRequestError } from '../agent/types';
import type { AgentInput, AgentThread } from '../agent/types';
import { JsonRpcError } from '../agent/codex-appserver/app-server-client';

/** Only an explicit stale-target rejection is safe to retry on another turn. */
export function isRejectedSteer(error: unknown): boolean {
  return error instanceof UnsentRequestError || error instanceof JsonRpcError && /expected active turn id|expected turn id|no active turn|turn already completed|turn not found|turn.*not active|turn.*mismatch/i.test(error.message);
}

/** A missing acknowledgment must not hold the session's intake lane forever.
 * Timeout/abort is uncertain delivery, never permission to resubmit. */
export async function steerWithDeadline(
  thread: AgentThread, input: AgentInput, turnId: string, signal?: AbortSignal, timeoutMs = 30_000,
): Promise<void> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      thread.steer(input, turnId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Steer response timed out; delivery unknown')), timeoutMs);
        abort = () => reject(new Error('Steer cancelled; delivery unknown'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
