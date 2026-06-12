import { randomUUID } from 'node:crypto';
import type { CliBridgeAgent, CliHookResponse } from './types';

export type PendingCliKind = 'permission' | 'question' | 'task_completion';

export interface PendingCliInteraction {
  id: string;
  kind: PendingCliKind;
  source: CliBridgeAgent;
  sessionId: string;
  cwd: string;
  toolName?: string;
  question?: string;
  command?: string;
  hookEventName?: string;
  options?: { label: string; description?: string; preview?: string }[];
  header?: string;
  taskStatus?: 'completed' | 'failed';
  summary?: string;
  replyExpiresAt?: number;
  toolInput?: Record<string, unknown>;
  messageId?: string;
  createdAt: number;
}

const pending = new Map<string, PendingCliInteraction>();
const waiters = new Map<string, (response: CliHookResponse) => void>();
// A decision that arrives before the waiter registers (a fast Feishu click during
// the card POST, before handleMessage reaches waitFor) is buffered here so it is
// not dropped — otherwise waitFor would see the pending already gone and return
// missing_pending, silently losing the user's allow/deny.
const settled = new Map<string, CliHookResponse>();

// Beyond the 24h max IPC/approval wait, anything still in the map leaked: an entry
// created before a sendManagedCard that then threw, or a task-completion card with
// reply continuation off. waitFor's own timeout (≤24h) cleans the happy paths; this
// sweep is the safety net so the map (and findByReply's O(n) scan) can't grow
// unbounded. Lazy on create — no interval lifecycle to manage.
const STALE_PENDING_MS = 25 * 60 * 60_000;

function prunePending(now: number): void {
  for (const [id, item] of pending) {
    if (now - item.createdAt <= STALE_PENDING_MS) continue;
    pending.delete(id);
    waiters.delete(id);
    settled.delete(id);
  }
}

export function createPendingCliInteraction(input: Omit<PendingCliInteraction, 'id' | 'createdAt'>): PendingCliInteraction {
  const now = Date.now();
  prunePending(now);
  const item = { ...input, id: randomUUID(), createdAt: now };
  pending.set(item.id, item);
  return item;
}

export function setPendingCliMessageId(id: string, messageId: string): void {
  const item = pending.get(id);
  if (item) pending.set(id, { ...item, messageId });
}

export function getPendingCliInteraction(id: string): PendingCliInteraction | undefined {
  return pending.get(id);
}

export function findPendingCliInteractionByMessageReply(input: {
  parentId?: string;
  rootId?: string;
}): PendingCliInteraction | undefined {
  const targets = [input.parentId, input.rootId].filter((x): x is string => Boolean(x));
  for (const item of pending.values()) {
    if (item.messageId && targets.includes(item.messageId)) return item;
  }
  return undefined;
}

export function resolvePendingCliInteraction(id: string, response: CliHookResponse): boolean {
  const item = pending.get(id);
  if (!item) return false;
  pending.delete(id);
  const waiter = waiters.get(id);
  if (waiter) {
    waiters.delete(id);
    waiter(response);
  } else {
    // No waiter yet (resolve raced ahead of waitFor) — buffer for it to pick up.
    settled.set(id, response);
  }
  return true;
}

export function waitForPendingCliInteraction(id: string, timeoutMs: number): Promise<CliHookResponse> {
  return new Promise((resolve) => {
    // A decision may have already arrived before we got here (see `settled`).
    const buffered = settled.get(id);
    if (buffered) {
      settled.delete(id);
      resolve(buffered);
      return;
    }
    if (!pending.has(id)) {
      resolve({ decision: 'fallback_local', reason: 'missing_pending' });
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      waiters.delete(id);
      settled.delete(id);
      resolve({ decision: 'fallback_local', reason: 'timeout' });
    }, Math.max(timeoutMs, 0));
    waiters.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}
