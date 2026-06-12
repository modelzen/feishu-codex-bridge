import { describe, expect, it, vi } from 'vitest';
import {
  createPendingCliInteraction,
  findPendingCliInteractionByMessageReply,
  getPendingCliInteraction,
  resolvePendingCliInteraction,
  setPendingCliMessageId,
  waitForPendingCliInteraction,
} from '../src/cli-bridge/store';

describe('cli bridge pending store', () => {
  it('resolves a pending permission decision', async () => {
    const pending = createPendingCliInteraction({
      kind: 'permission',
      source: 'codex',
      sessionId: 's',
      cwd: '/repo',
      toolName: 'Bash',
      question: 'Run command?',
    });
    // Register the waiter before resolving; the real service waits first and the
    // Feishu button click resolves later.
    const waiter = waitForPendingCliInteraction(pending.id, 100);
    expect(resolvePendingCliInteraction(pending.id, { decision: 'allow' })).toBe(true);
    await expect(waiter).resolves.toEqual({ decision: 'allow' });
  });

  it('does not drop a decision that resolves before the waiter registers', async () => {
    const pending = createPendingCliInteraction({
      kind: 'permission',
      source: 'codex',
      sessionId: 's-race',
      cwd: '/repo',
      toolName: 'Bash',
      question: 'Run command?',
    });
    // Resolve BEFORE waitFor — the fast-click race the real service can hit while
    // the approval card is still being POSTed. The decision must be buffered, not lost.
    expect(resolvePendingCliInteraction(pending.id, { decision: 'deny', interrupt: true })).toBe(true);
    await expect(waitForPendingCliInteraction(pending.id, 100)).resolves.toEqual({ decision: 'deny', interrupt: true });
  });

  it('times out pending interactions', async () => {
    vi.useFakeTimers();
    const pending = createPendingCliInteraction({
      kind: 'permission',
      source: 'claude',
      sessionId: 's',
      cwd: '/repo',
      toolName: 'Bash',
      question: 'Run command?',
    });
    const promise = waitForPendingCliInteraction(pending.id, 1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toEqual({ decision: 'fallback_local', reason: 'timeout' });
    vi.useRealTimers();
  });

  it('sweeps leaked pending interactions older than the stale cap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // A card whose send/wait never resolved it (e.g. sendManagedCard threw, or
    // reply continuation was off) — it has no waiter and would otherwise live forever.
    const leaked = createPendingCliInteraction({ kind: 'task_completion', source: 'codex', sessionId: 's-leak', cwd: '/repo' });
    setPendingCliMessageId(leaked.id, 'om_leak');
    expect(getPendingCliInteraction(leaked.id)).toBeDefined();
    // Past the 25h cap; the next create() triggers the lazy sweep.
    vi.setSystemTime(26 * 60 * 60_000);
    createPendingCliInteraction({ kind: 'permission', source: 'claude', sessionId: 's-fresh', cwd: '/repo', toolName: 'Bash' });
    expect(getPendingCliInteraction(leaked.id)).toBeUndefined();
    expect(findPendingCliInteractionByMessageReply({ parentId: 'om_leak' })).toBeUndefined();
    vi.useRealTimers();
  });

  it('finds pending task completion by reply parent or root id', () => {
    const pending = createPendingCliInteraction({
      kind: 'task_completion',
      source: 'codex',
      sessionId: 's',
      cwd: '/repo',
    });
    setPendingCliMessageId(pending.id, 'om_parent');
    expect(findPendingCliInteractionByMessageReply({ parentId: 'om_parent' })?.id).toBe(pending.id);
    expect(findPendingCliInteractionByMessageReply({ rootId: 'om_parent' })?.id).toBe(pending.id);
  });
});
